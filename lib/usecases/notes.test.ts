import { describe, expect, test } from 'vitest';
import { DbError } from '../db/errors';
import type { NewMessage } from '../domain/library';
import { countNotes, getNote, listNotes, setNote } from './notes';
import { createTestLibrary } from './test-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [ANA, C1, C2] = [uuid(1), uuid(10), uuid(11)];
const NOW = '2026-02-01T12:00:00Z';
const message = (n: number, day: number): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-0${day}T10:00:00`,
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
      messages: [message(i * 2 + 1, i + 1), message(i * 2 + 2, 3)],
      newConversation: { title: `Chat ${i + 1}`, sourceKey: `chat${i}`, isGroup: false, profileIds: [ANA] },
      meAuthor: 'Ana',
    });
  }
  const window = await lib.client.call('getMessageWindow', { conversationId: C1, offset: 0, limit: 10 });
  return { lib, window };
}

describe('notes use cases', () => {
  test('set, get, count and list go through the client; the clock comes from the deps', async () => {
    const { lib, window } = await setup();
    const deps = { ...lib, now: () => new Date('2026-05-06T07:08:09Z') };
    const onMessage = { kind: 'message', conversationId: C1, messageId: window[0].id } as const;
    expect(await getNote(deps, onMessage)).toBeNull();
    const saved = await setNote(deps, onMessage, ' remember this ');
    expect(saved).toEqual({ kind: 'message', body: 'remember this', createdAt: '2026-05-06T07:08:09.000Z', updatedAt: '2026-05-06T07:08:09.000Z' });
    expect(await getNote(deps, onMessage)).toEqual(saved);
    await setNote(deps, { kind: 'profile', profileId: ANA }, 'about Ana');
    expect(await countNotes(lib)).toBe(2);
    expect(await countNotes(lib, { conversationId: C2 })).toBe(0);
    const list = await listNotes(lib, { conversationId: C1 }, 0);
    expect(list).toMatchObject([{ kind: 'message', body: 'remember this', conversationTitle: 'Chat 1', message: { id: window[0].id, body: 'synthetic 1' } }]);
    expect(await setNote(deps, onMessage, '')).toBeNull();
    expect(await countNotes(lib)).toBe(1);
    expect((await lib.client.call('getMessageWindow', { conversationId: C1, offset: 0, limit: 10 })).some((m) => m.hasNote)).toBe(false);
  });

  test('failures are DbErrors with the db layer codes', async () => {
    const { lib, window } = await setup();
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
    const wrongPair = { kind: 'message', conversationId: C2, messageId: window[0].id } as const;
    expect(await failure(setNote(lib, wrongPair, 'x'))).toBeInstanceOf(DbError);
    expect(await failure(setNote(lib, wrongPair, 'x'))).toMatchObject({ code: 'not-found' });
    expect(await failure(setNote(lib, { kind: 'conversation', conversationId: uuid(99) }, 'x'))).toMatchObject({ code: 'not-found' });
    expect(await failure(setNote(lib, { kind: 'profile', profileId: ANA }, 'x'.repeat(10_001)))).toMatchObject({ code: 'invalid' });
    expect(await failure(countNotes(lib, { profileId: uuid(99) }))).toMatchObject({ code: 'not-found' });
    expect(await failure(listNotes(lib, undefined, -1))).toMatchObject({ code: 'invalid' });
    expect(await failure(listNotes(lib, { profileId: ANA, conversationId: C1 } as never, 0))).toMatchObject({ code: 'invalid' });
  });
});
