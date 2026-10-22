import { describe, expect, test } from 'vitest';
import { DbError } from '../db/errors';
import type { NewMessage } from '../domain/library';
import { countFavorites, listFavorites, setFavorite } from './favorites';
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

describe('favorites use cases', () => {
  test('set, count and list go through the client; the clock comes from the deps', async () => {
    const { lib, window } = await setup();
    const deps = { ...lib, now: () => new Date('2026-05-06T07:08:09Z') };
    expect(await setFavorite(deps, C1, window[0].id, true)).toBe(true);
    expect(await setFavorite(deps, C1, window[0].id, true)).toBe(true);
    expect(lib.opened.db.all('SELECT created_at FROM favorites')).toEqual([{ created_at: '2026-05-06T07:08:09.000Z' }]);
    expect(await countFavorites(lib)).toBe(1);
    expect(await countFavorites(lib, { profileId: ANA })).toBe(1);
    expect(await countFavorites(lib, { conversationId: C2 })).toBe(0);
    const list = await listFavorites(lib, { profileId: ANA }, 0);
    expect(list).toMatchObject([{ id: window[0].id, conversationTitle: 'Chat 1', isFavorite: true }]);
    expect(await setFavorite(lib, C1, window[0].id, false)).toBe(false);
    expect(await listFavorites(lib, undefined, 0)).toEqual([]);
  });

  test('failures are DbErrors with the db layer codes', async () => {
    const { lib, window } = await setup();
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
    expect(await failure(setFavorite(lib, C2, window[0].id, true))).toBeInstanceOf(DbError);
    expect(await failure(setFavorite(lib, C2, window[0].id, true))).toMatchObject({ code: 'not-found' });
    expect(await failure(countFavorites(lib, { profileId: uuid(99) }))).toMatchObject({ code: 'not-found' });
    expect(await failure(listFavorites(lib, undefined, -1))).toMatchObject({ code: 'invalid' });
    expect(await failure(listFavorites(lib, { profileId: ANA, conversationId: C1 } as never, 0))).toMatchObject({ code: 'invalid' });
  });
});
