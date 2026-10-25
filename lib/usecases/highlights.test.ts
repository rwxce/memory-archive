import { describe, expect, test } from 'vitest';
import { DbError } from '../db/errors';
import type { Findings } from '../domain/highlights';
import type { NewMessage } from '../domain/library';
import { exportArchiveFromLibrary, restoreArchiveFromZip } from './archive';
import {
  checkFindingsText,
  countHighlights,
  countHighlightsByCategory,
  deleteHighlight,
  deleteHighlights,
  importFindings,
  listHighlightMessages,
  listHighlights,
} from './highlights';
import { createTestLibrary } from './test-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [ANA, C1, C2] = [uuid(1), uuid(10), uuid(11)];
const NOW = '2026-02-01T12:00:00Z';
const fp = (n: number) => n.toString(16).padStart(64, '0');
const message = (n: number): NewMessage => ({
  fingerprint: fp(n),
  sentAt: `2026-01-0${n}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
});

async function setup() {
  const lib = await createTestLibrary();
  await lib.client.call('createProfile', { id: ANA, displayName: 'Ana', now: NOW });
  for (const [i, id] of [C1, C2].entries()) {
    await lib.client.call('importMessages', {
      batchId: uuid(100 + i),
      conversationId: id,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: NOW,
      blobs: [],
      // C1 has messages 1..4, C2 has 5..6
      messages: i === 0 ? [1, 2, 3, 4].map(message) : [5, 6].map(message),
      newConversation: { title: `Chat ${i + 1}`, sourceKey: `chat${i}`, isGroup: false, profileIds: [ANA] },
      meAuthor: 'Ana',
    });
  }
  return { ...lib, now: () => new Date('2026-03-01T10:00:00Z') };
}

const findings = (highlights: Findings['highlights'], conversation: Partial<Findings['conversation']> = {}): Findings => ({
  version: 1,
  conversation: { name: 'Chat 1', messageCount: 4, firstFingerprint: fp(1), ...conversation },
  highlights,
});
const hl = (id: string, category: 'moment' | 'pattern' | 'interest', messages: string[], extra: Record<string, string> = {}) => ({
  id,
  category,
  title: `Title ${id}`,
  summary: `Summary ${id}`,
  messages,
  createdBy: 'tester',
  createdAt: '2026-01-31T10:00:00Z',
  ...extra,
});

describe('highlights use cases', () => {
  test('import, list in message order, filter by category and scope, open messages in the author order', async () => {
    const lib = await setup();
    const file = findings([hl('b-pattern', 'pattern', [fp(3), fp(2)]), hl('a-moment', 'moment', [fp(1)]), hl('c-interest', 'interest', [fp(4)])]);
    const result = await importFindings(lib, C1, file);
    expect(result).toEqual({ imported: 3, updated: 0, unchanged: 0, skippedHighlights: [], skippedFingerprints: 0, warnings: [] });

    const all = await listHighlights(lib, undefined, 0);
    expect(all.map((h) => h.id)).toEqual(['a-moment', 'b-pattern', 'c-interest']); // earliest message first
    expect(all[1]).toMatchObject({ conversationId: C1, conversationTitle: 'Chat 1', category: 'pattern', messageCount: 2, firstSentAt: '2026-01-02T10:00:00', createdBy: 'tester', createdAt: '2026-01-31T10:00:00Z', importedAt: '2026-03-01T10:00:00.000Z' });
    expect(await countHighlights(lib)).toBe(3);
    expect(await countHighlightsByCategory(lib)).toEqual({ moment: 1, pattern: 1, interest: 1 });
    expect((await listHighlights(lib, { category: 'pattern' }, 0)).map((h) => h.id)).toEqual(['b-pattern']);
    expect(await countHighlights(lib, { scope: { profileId: ANA }, category: 'moment' })).toBe(1);
    expect(await countHighlights(lib, { scope: { conversationId: C2 } })).toBe(0);
    expect((await listHighlights(lib, undefined, 1, 1)).map((h) => h.id)).toEqual(['b-pattern']);
    expect(await listHighlights(lib, undefined, 5)).toEqual([]);

    const messages = await listHighlightMessages(lib, C1, 'b-pattern');
    expect(messages.map((m) => m.body)).toEqual(['synthetic 3', 'synthetic 2']);
    expect(messages[0]).toMatchObject({ participantName: 'Ana', isMe: true, type: 'text', mediaName: '' });
    expect(typeof messages[0].id).toBe('number');
  });

  test('importing the same file twice changes nothing; an edited highlight is updated in place', async () => {
    const lib = await setup();
    const file = findings([hl('h1', 'moment', [fp(1), fp(2)]), hl('h2', 'pattern', [fp(3)])]);
    await importFindings(lib, C1, file);
    const before = lib.opened.db.all('SELECT * FROM highlights ORDER BY id');
    const beforeMessages = lib.opened.db.all('SELECT * FROM highlight_messages ORDER BY highlight_id, position');
    const later = { ...lib, now: () => new Date('2027-01-01T00:00:00Z') };
    expect(await importFindings(later, C1, JSON.stringify(file))).toMatchObject({ imported: 0, updated: 0, unchanged: 2 });
    expect(lib.opened.db.all('SELECT * FROM highlights ORDER BY id')).toEqual(before);
    expect(lib.opened.db.all('SELECT * FROM highlight_messages ORDER BY highlight_id, position')).toEqual(beforeMessages);

    const edited = findings([hl('h1', 'interest', [fp(2), fp(4)], { title: 'Renamed' }), hl('h2', 'pattern', [fp(3)])]);
    expect(await importFindings(later, C1, edited)).toMatchObject({ imported: 0, updated: 1, unchanged: 1 });
    expect(await countHighlights(lib)).toBe(2);
    const [h1] = (await listHighlights(lib, { category: 'interest' }, 0));
    expect(h1).toMatchObject({ id: 'h1', title: 'Renamed', importedAt: '2027-01-01T00:00:00.000Z', messageCount: 2 });
    expect((await listHighlightMessages(lib, C1, 'h1')).map((m) => m.body)).toEqual(['synthetic 2', 'synthetic 4']);
  });

  test('unknown fingerprints are skipped and counted; a highlight with no known message is skipped and reported', async () => {
    const lib = await setup();
    const file = findings([hl('partial', 'moment', [fp(1), fp(99)]), hl('none', 'pattern', [fp(98), fp(97)]), hl('other-chat', 'interest', [fp(5)])]);
    const result = await importFindings(lib, C1, file);
    expect(result).toMatchObject({ imported: 1, skippedHighlights: ['none', 'other-chat'], skippedFingerprints: 4 });
    expect(await countHighlights(lib)).toBe(1);
    expect((await listHighlightMessages(lib, C1, 'partial')).map((m) => m.body)).toEqual(['synthetic 1']);
    // fingerprints of another conversation are not stored either
    expect(lib.opened.db.all('SELECT fingerprint FROM highlight_messages')).toEqual([{ fingerprint: fp(1) }]);
    // a later import of the same file once the message exists adds it
    await lib.client.call('importMessages', {
      batchId: uuid(200), conversationId: C1, source: 'whatsapp', sourceLabel: 'y.zip', now: NOW, blobs: [], messages: [{ ...message(5), fingerprint: fp(99) }],
    });
    expect(await importFindings(lib, C1, file)).toMatchObject({ updated: 1, skippedFingerprints: 3 });
    expect((await listHighlightMessages(lib, C1, 'partial')).map((m) => m.body)).toEqual(['synthetic 1', 'synthetic 5']);
  });

  test('a skipped highlight leaves an existing one with that id untouched', async () => {
    const lib = await setup();
    await importFindings(lib, C1, findings([hl('h', 'moment', [fp(1)])]));
    const result = await importFindings(lib, C1, findings([hl('h', 'pattern', [fp(98)], { title: 'Other' })]));
    expect(result).toMatchObject({ imported: 0, updated: 0, skippedHighlights: ['h'] });
    expect(await listHighlights(lib, undefined, 0)).toMatchObject([{ id: 'h', category: 'moment', title: 'Title h' }]);
  });

  test('a mismatching conversation is only a warning', async () => {
    const lib = await setup();
    const result = await importFindings(lib, C1, findings([hl('h', 'moment', [fp(1)])], { messageCount: 4000, firstFingerprint: fp(77) }));
    expect(result.imported).toBe(1);
    expect(result.warnings).toEqual(['message-count-differs', 'first-message-not-found']);
    expect((await importFindings(lib, C1, findings([hl('h', 'moment', [fp(1)])], { firstFingerprint: undefined }))).warnings).toEqual([]);
  });

  test('dormant: a highlight whose messages are gone is hidden, and returns with them', async () => {
    const lib = await setup();
    await importFindings(lib, C1, findings([hl('h', 'moment', [fp(1), fp(2)])]));
    lib.opened.db.run('DELETE FROM messages WHERE fingerprint = ?', [fp(1)]);
    expect(await listHighlights(lib, undefined, 0)).toMatchObject([{ id: 'h', messageCount: 1 }]);
    lib.opened.db.run('DELETE FROM messages WHERE fingerprint = ?', [fp(2)]);
    expect(await countHighlights(lib)).toBe(0);
    expect(await listHighlights(lib, undefined, 0)).toEqual([]);
    expect(await listHighlightMessages(lib, C1, 'h')).toEqual([]);
    expect(lib.opened.db.all('SELECT * FROM highlights')).toHaveLength(1);
  });

  test('delete removes one highlight and its links; undoing the conversation cascades', async () => {
    const lib = await setup();
    await importFindings(lib, C1, findings([hl('a', 'moment', [fp(1)]), hl('b', 'moment', [fp(2)])]));
    expect(await deleteHighlight(lib, C1, 'a')).toBe(true);
    expect(await deleteHighlight(lib, C1, 'a')).toBe(false);
    expect(await countHighlights(lib)).toBe(1);
    expect(lib.opened.db.all('SELECT highlight_id FROM highlight_messages')).toEqual([{ highlight_id: 'b' }]);
    await lib.client.call('undoImportBatch', { batchId: uuid(100) });
    expect(lib.opened.db.all('SELECT * FROM highlights')).toEqual([]);
    expect(lib.opened.db.all('SELECT * FROM highlight_messages')).toEqual([]);
  });

  test('delete all removes only the scope, with links, and a re-import brings them back', async () => {
    const lib = await setup();
    const BOB = uuid(2);
    const C3 = uuid(12);
    await lib.client.call('createProfile', { id: BOB, displayName: 'Bob', now: NOW });
    await lib.client.call('importMessages', {
      batchId: uuid(102),
      conversationId: C3,
      source: 'whatsapp',
      sourceLabel: 'y.zip',
      now: NOW,
      blobs: [],
      messages: [message(7)],
      newConversation: { title: 'Chat 3', sourceKey: 'chat3', isGroup: false, profileIds: [BOB] },
      meAuthor: 'Ana',
    });
    const file1 = findings([hl('a', 'moment', [fp(1)]), hl('b', 'pattern', [fp(2), fp(3)])]);
    await importFindings(lib, C1, file1);
    await importFindings(lib, C2, findings([hl('c', 'interest', [fp(5)])], { name: 'Chat 2' }));
    await importFindings(lib, C3, findings([hl('d', 'moment', [fp(7)])], { name: 'Chat 3' }));

    expect(await deleteHighlights(lib, { conversationId: C2 })).toBe(1);
    expect(await countHighlights(lib)).toBe(3);
    expect(await deleteHighlights(lib, { profileId: ANA })).toBe(2); // C1 only: C2 is already empty
    expect(await listHighlights(lib, undefined, 0)).toMatchObject([{ id: 'd', conversationId: C3 }]);
    expect(lib.opened.db.all('SELECT highlight_id FROM highlight_messages')).toEqual([{ highlight_id: 'd' }]);
    expect(await deleteHighlights(lib, { profileId: ANA })).toBe(0);

    expect(await importFindings(lib, C1, file1)).toMatchObject({ imported: 2, unchanged: 0 });
    expect(await countHighlights(lib, { scope: { profileId: ANA } })).toBe(2);
    expect((await listHighlightMessages(lib, C1, 'b')).map((m) => m.body)).toEqual(['synthetic 2', 'synthetic 3']);

    const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as DbError | null)?.code;
    expect(await code(deleteHighlights(lib, {} as never))).toBe('invalid');
    expect(await code(deleteHighlights(lib, { profileId: ANA, conversationId: C1 } as never))).toBe('invalid');
    expect(await code(deleteHighlights(lib, { profileId: uuid(999) }))).toBe('not-found');
    expect(await code(deleteHighlights(lib, { conversationId: uuid(999) }))).toBe('not-found');
    expect(await countHighlights(lib)).toBe(3);
  });

  test('failures are DbErrors; an invalid file imports nothing', async () => {
    const lib = await setup();
    const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as DbError | null)?.code;
    expect(await code(importFindings(lib, C1, 'not json'))).toBe('invalid');
    expect(await code(importFindings(lib, C1, JSON.stringify({ version: 2 })))).toBe('invalid');
    expect(await code(importFindings(lib, C1, findings([hl('bad id!', 'moment', [fp(1)])])))).toBe('invalid');
    expect(await code(importFindings(lib, uuid(999), findings([hl('h', 'moment', [fp(1)])])))).toBe('not-found');
    expect(await code(importFindings(lib, 'nope', findings([])))).toBe('invalid');
    expect(await code(listHighlights(lib, { scope: { profileId: ANA, conversationId: C1 } }, 0))).toBe('invalid');
    expect(await code(listHighlights(lib, { category: 'bogus' as 'moment' }, 0))).toBe('invalid');
    expect(await code(listHighlights(lib, undefined, -1))).toBe('invalid');
    expect(await code(listHighlightMessages(lib, C1, 'missing'))).toBe('not-found');
    expect(await code(deleteHighlight(lib, uuid(999), 'x'))).toBe('not-found');
    expect(await countHighlights(lib)).toBe(0);
    // bypassing the use case: the db layer validates too
    expect(await code(lib.client.call('importHighlights', { conversationId: C1, now: NOW, highlights: [{ id: 'x' }] as never }))).toBe('invalid');
  });

  test('checkFindingsText reports reasons without content', () => {
    expect(checkFindingsText('{')).toMatchObject({ ok: false });
    const r = checkFindingsText(JSON.stringify(findings([hl('h', 'moment', ['SECRET'])])));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(checkFindingsText(JSON.stringify(findings([hl('h', 'moment', [fp(1)])])))).toMatchObject({ ok: true });
  });

  test('backup then restore keeps highlights, in order, and the same file is still a no-op', async () => {
    const a = await setup();
    const file = findings([hl('h1', 'moment', [fp(2), fp(1)]), hl('h2', 'pattern', [fp(4)])]);
    await importFindings(a, C1, file);
    const { blob } = await exportArchiveFromLibrary(a.deps, { appVersion: '1' });

    const b = await createTestLibrary();
    await restoreArchiveFromZip(b.deps, blob);
    expect((await listHighlights(b, undefined, 0)).map((h) => [h.id, h.title, h.importedAt])).toEqual(
      (await listHighlights(a, undefined, 0)).map((h) => [h.id, h.title, h.importedAt]),
    );
    expect((await listHighlightMessages(b, C1, 'h1')).map((m) => m.body)).toEqual(['synthetic 2', 'synthetic 1']);
    expect(await importFindings(b, C1, file)).toMatchObject({ imported: 0, updated: 0, unchanged: 2 });
  });
});
