import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { importMessages, listImportBatches } from '../db/queries';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import { importWhatsAppExport, type ImportResult } from './import';
import { historyCursorOf, listImportHistory, undoImport } from './import-history';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';
import { openMemoryDb } from '../db/open';
import { openBlobStore } from '../storage/opfs-blob-store';
import { createMemoryDirectory } from '../storage/test-opfs-directory';

const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const BASE = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:00:00] Bo: Hola',
];
const NEWER = [...BASE, '[19/03/2026, 10:00:00] Ana: Nou'];
const zipOf = (lines: string[], media: Record<string, Uint8Array> = {}) =>
  new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...media }) as BlobPart]);
const NAME = 'WhatsApp Chat - Ana i Bo.zip';
const photo = new Uint8Array(200).map((_, i) => (i * 3) % 251);

async function setup() {
  const lib = await createTestLibrary();
  const profile = await createProfile(lib.deps, { displayName: 'Ana' });
  let tick = 0;
  // Every import gets its own, increasing instant.
  const deps = { ...lib.deps, now: () => new Date(Date.UTC(2026, 2, 1, 10, 0, ++tick)) };
  const run = async (fileName: string, lines: string[], extra: Record<string, unknown> = {}): Promise<Extract<ImportResult, { status: 'imported' }>> => {
    const r = await importWhatsAppExport(deps, { zip: zipOf(lines, { [PHOTO]: photo }), fileName, profileIds: [profile.id], meAuthor: 'Ana', ...extra });
    if (r.status !== 'imported') throw new Error(r.status);
    return r;
  };
  return { ...lib, deps, profile, run };
}

describe('listImportHistory', () => {
  test('an empty archive has an empty history', async () => {
    const { deps } = await setup();
    expect(await listImportHistory(deps)).toEqual([]);
  });

  test('two imports into one conversation: newest first, counts and names right', async () => {
    const { deps, run, profile } = await setup();
    const a = await run(NAME, BASE);
    const b = await run(NAME, NEWER);
    const history = await listImportHistory(deps);
    expect(history.map((h) => h.id)).toEqual([b.batchId, a.batchId]);
    expect(history[0]).toMatchObject({
      sourceLabel: NAME,
      messagesAdded: 1,
      messagesSkipped: 4,
      messagesPresent: 1,
      mediaPresent: 0,
      createdConversation: false,
      conversationId: a.conversationId,
      profileIds: [profile.id],
      profileNames: ['Ana'],
      canUndo: true,
    });
    expect(history[1]).toMatchObject({ messagesAdded: 4, messagesSkipped: 0, messagesPresent: 4, mediaPresent: 1, createdConversation: true });
    expect(history[1].conversationTitle).toBeTruthy();
  });

  test('re-importing the same ZIP changes nothing and is not listed', async () => {
    const { deps, run } = await setup();
    const a = await run(NAME, BASE);
    const again = await run(NAME, BASE);
    expect(again.summary.added).toBe(0);
    expect((await listImportHistory(deps)).map((h) => h.id)).toEqual([a.batchId]);
  });

  test('undoing the older batch keeps the newer one counted and the conversation', async () => {
    const { deps, run } = await setup();
    const a = await run(NAME, BASE);
    const b = await run(NAME, NEWER);
    expect(await undoImport(deps, a.batchId)).toMatchObject({ found: true, removedMessages: 4, removedConversation: false });
    const history = await listImportHistory(deps);
    expect(history.map((h) => [h.id, h.messagesPresent])).toEqual([[b.batchId, 1]]);
    expect(await undoImport(deps, a.batchId)).toMatchObject({ found: false });
  });

  test('messages removed after the import are reflected; no message left = nothing to undo', async () => {
    const { deps, run, opened } = await setup();
    const a = await run(NAME, BASE);
    opened.db.run('DELETE FROM messages WHERE batch_id = ? AND type = ?', [a.batchId, 'photo']);
    expect((await listImportHistory(deps))[0]).toMatchObject({ messagesAdded: 4, messagesPresent: 3, mediaPresent: 0, canUndo: true });
    opened.db.run('DELETE FROM messages WHERE batch_id = ?', [a.batchId]);
    expect((await listImportHistory(deps))[0]).toMatchObject({ messagesPresent: 0, canUndo: false });
  });

  test('a conversation that is gone has no title or id', async () => {
    const { deps, run, opened } = await setup();
    await run(NAME, BASE);
    opened.db.exec('PRAGMA foreign_keys = OFF');
    opened.db.exec('DELETE FROM conversations');
    opened.db.exec('PRAGMA foreign_keys = ON');
    expect(await listImportHistory(deps)).toMatchObject([{ conversationId: null, conversationTitle: null, profileIds: [], profileNames: [] }]);
  });

  test('pages with a cursor, newest first, without gaps or repeats', async () => {
    const { deps, run } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.unshift((await run(NAME, [...BASE, `[2${i}/03/2026, 10:00:00] Ana: m${i}`])).batchId);
    const seen: string[] = [];
    let page = await listImportHistory(deps, { limit: 2 });
    while (page.length > 0) {
      seen.push(...page.map((h) => h.id));
      page = await listImportHistory(deps, { limit: 2, before: historyCursorOf(page[page.length - 1]) });
    }
    expect(seen).toEqual(ids);
  });

  test('batches with the same instant page by id, newest id first, with no gaps or repeats', async () => {
    const lib = await createTestLibrary();
    const conversationId = '00000000-0000-4000-8000-0000000000c1';
    const ids = [0, 1, 2, 3, 4].map((b) => `00000000-0000-4000-8000-00000000010${b}`);
    ids.forEach((batchId, b) =>
      importMessages(lib.opened.db, {
        batchId,
        conversationId,
        source: 'whatsapp',
        sourceLabel: `f${b}.zip`,
        // The same instant for every batch.
        now: '2026-03-01T10:00:00Z',
        blobs: [],
        meAuthor: null,
        ...(b === 0 ? { newConversation: { title: 'T', sourceKey: 'k', isGroup: false, profileIds: [] } } : {}),
        messages: [{ fingerprint: (b + 1).toString(16).padStart(64, '0'), sentAt: '2026-03-01T10:00:00', ordinal: b, type: 'text' as const, participantName: 'Ana', body: 'x', mediaSha256: null, mediaName: '' }],
      }),
    );
    const expected = [...ids].sort().reverse();
    for (const limit of [1, 2]) {
      const seen: string[] = [];
      let page = await listImportHistory(lib.deps, { limit });
      while (page.length > 0) {
        seen.push(...page.map((h) => h.id));
        page = await listImportHistory(lib.deps, { limit, before: historyCursorOf(page[page.length - 1]) });
      }
      expect(seen).toEqual(expected);
    }
  });

  test('filters by profile and by conversation', async () => {
    const { deps, run, profile } = await setup();
    const other = await createProfile(deps, { displayName: 'Bo' });
    const a = await run('WhatsApp Chat - Uno.zip', BASE);
    const b = await run('WhatsApp Chat - Dos.zip', ['[17/03/2026, 13:17:05] Cy: hi', '[17/03/2026, 13:18:05] Di: yo'], { profileIds: [other.id], meAuthor: null });
    expect((await listImportHistory(deps, { profileId: profile.id })).map((h) => h.id)).toEqual([a.batchId]);
    expect((await listImportHistory(deps, { profileId: other.id })).map((h) => [h.id, h.profileNames])).toEqual([[b.batchId, ['Bo']]]);
    expect((await listImportHistory(deps, { conversationId: b.conversationId })).map((h) => h.id)).toEqual([b.batchId]);
  });

  test('bad params are refused', async () => {
    const { client } = await setup();
    for (const params of [
      { profileId: 'x' },
      { conversationId: 5 },
      { limit: 'many' },
      { before: { createdAt: 1, id: 'x' } },
      { before: 'x' },
      [],
    ]) {
      await expect(client.call('listImportBatches', params as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(client.call('listImportBatches', null as never)).rejects.toMatchObject({ code: 'invalid' });
    await expect(client.call('listImportBatches')).resolves.toEqual([]);
  });

  test('a limit is bounded to a page', async () => {
    const { client, run } = await setup();
    await run('WhatsApp Chat - Uno.zip', BASE);
    expect(await client.call('listImportBatches', { limit: 0 })).toHaveLength(1);
    expect(await client.call('listImportBatches', { limit: 1e9 })).toHaveLength(1);
  });

  test('stays on the batch index with thousands of messages', async () => {
    const lib = await createTestLibrary();
    const conversationId = '00000000-0000-4000-8000-0000000000c1';
    for (let b = 0; b < 4; b++) {
      importMessages(lib.opened.db, {
        batchId: `00000000-0000-4000-8000-00000000000${b}`,
        conversationId,
        source: 'whatsapp',
        sourceLabel: `f${b}.zip`,
        now: `2026-03-0${b + 1}T10:00:00Z`,
        blobs: [],
        meAuthor: null,
        ...(b === 0 ? { newConversation: { title: 'T', sourceKey: 'k', isGroup: false, profileIds: [] } } : {}),
        messages: Array.from({ length: 1500 }, (_, i) => ({
          fingerprint: (b * 1500 + i).toString(16).padStart(64, '0'),
          sentAt: '2026-03-01T10:00:00',
          ordinal: i,
          type: 'text' as const,
          participantName: 'Ana',
          body: 'x',
          mediaSha256: null,
          mediaName: '',
        })),
      });
    }
    const rows = listImportBatches(lib.opened.db, { limit: 10 });
    expect(rows.map((r) => r.messagesPresent)).toEqual([1500, 1500, 1500, 1500]);
    const plan = lib.opened.db
      .all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages m WHERE m.batch_id = ?', ['x'])
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toContain('messages_by_batch');
  });

  test('history survives a backup and restore', async () => {
    const { deps, run, opened } = await setup();
    await run(NAME, BASE);
    await run(NAME, NEWER);
    const before = await listImportHistory(deps);
    const { blob } = await exportArchive({ db: opened.db, blobStore: deps.blobStore }, { appVersion: '1' });
    const target = { db: (await openMemoryDb()).db, blobStore: await openBlobStore(createMemoryDirectory()) };
    await restoreArchiveIntoEmptyLibrary(target, blob);
    expect(listImportBatches(target.db)).toEqual(before.map(({ profileNames: _names, ...row }) => row));
  });
});
