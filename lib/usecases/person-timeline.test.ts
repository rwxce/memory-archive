import { describe, expect, test } from 'vitest';
import { DbError } from '../db/errors';
import type { NewMessage } from '../domain/library';
import {
  findPersonTimelineOffsetByDate,
  getPersonTimelineBounds,
  getPersonTimelineWindow,
  listPersonTimelineDays,
} from './person-timeline';
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
  return lib;
}

describe('person timeline use cases', () => {
  test('bounds, windows, date jump and days go through the client', async () => {
    const lib = await setup();
    expect(await getPersonTimelineBounds(lib, ANA)).toMatchObject({ count: 4, firstSentAt: '2026-01-01T10:00:00' });
    const window = await getPersonTimelineWindow(lib, ANA, 0);
    expect(window.map((m) => m.conversationTitle)).toEqual(['Chat 1', 'Chat 2', 'Chat 1', 'Chat 2']);
    expect(await getPersonTimelineWindow(lib, ANA, 1, 2)).toHaveLength(2);
    expect(await findPersonTimelineOffsetByDate(lib, ANA, '2026-01-03')).toBe(2);
    expect(await findPersonTimelineOffsetByDate(lib, ANA, '2026-02-01')).toBeNull();
    expect((await listPersonTimelineDays(lib, ANA)).map((d) => d.count)).toEqual([1, 1, 2]);
  });

  test('failures are DbErrors with the db layer codes', async () => {
    const lib = await setup();
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
    expect(await failure(getPersonTimelineBounds(lib, uuid(99)))).toBeInstanceOf(DbError);
    expect(await failure(getPersonTimelineBounds(lib, uuid(99)))).toMatchObject({ code: 'not-found' });
    expect(await failure(getPersonTimelineWindow(lib, ANA, -1))).toMatchObject({ code: 'invalid' });
    expect(await failure(findPersonTimelineOffsetByDate(lib, ANA, 'nope'))).toMatchObject({ code: 'invalid' });
  });
});
