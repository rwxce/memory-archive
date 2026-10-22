import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  MAX_WINDOW,
  countMessages,
  createConversation,
  findMessageOffsetByDate,
  getConversationBounds,
  getMessageWindow,
  importMessages,
  listConversationDays,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const [CONV, EMPTY, OTHER] = [uuid(10), uuid(11), uuid(12)];
const PHOTO = 'ab'.repeat(32);

const msg = (n: number, sentAt: string, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: fp(n),
  sentAt,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

let db: SqlDb;
beforeEach(async () => {
  db = (await openMemoryDb()).db;
  for (const id of [CONV, EMPTY, OTHER]) {
    createConversation(db, { id, title: 'Chat', source: 'whatsapp', isGroup: false, profileIds: [], participants: [], now: '2026-02-01T12:00:00Z' });
  }
});

function load(messages: NewMessage[], conversationId = CONV, extra: { meAuthor?: string } = {}) {
  return importMessages(db, {
    batchId: uuid(conversationId === CONV ? 100 : 101),
    conversationId,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: '2026-02-01T12:00:00Z',
    blobs: messages.some((m) => m.mediaSha256) ? [{ sha256: PHOTO, size: 3, mime: 'image/jpeg' }] : [],
    messages,
    ...extra,
  });
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return toDbError(error).code;
  }
  return 'none';
};

describe('conversation view reads', () => {
  test('a window carries author, isMe, system flag and media with its stored type', () => {
    load(
      [
        msg(1, '2026-01-01T10:00:00', { participantName: 'Ana' }),
        msg(2, '2026-01-01T10:01:00', { participantName: 'Bo', type: 'photo', mediaSha256: PHOTO, mediaName: 'IMG-1.jpg' }),
        msg(3, '2026-01-01T10:02:00', { participantName: null, type: 'system', body: 'Messages are encrypted' }),
      ],
      CONV,
      { meAuthor: 'Ana' },
    );
    const [a, b, c] = getMessageWindow(db, CONV, 0, 10);
    expect(a).toMatchObject({ participantName: 'Ana', isMe: true, isSystem: false, mediaSha256: null, mediaMime: null });
    expect(b).toMatchObject({ participantName: 'Bo', isMe: false, mediaSha256: PHOTO, mediaName: 'IMG-1.jpg', mediaMime: 'image/jpeg' });
    expect(c).toMatchObject({ participantName: null, isMe: false, isSystem: true, type: 'system' });
  });

  test('windows follow chronological order, whatever the import order', () => {
    load([msg(1, '2026-01-03T10:00:00'), msg(2, '2026-01-01T10:00:00'), msg(3, '2026-01-02T10:00:00')]);
    expect(getMessageWindow(db, CONV, 0, 10).map((m) => m.body)).toEqual(['synthetic 2', 'synthetic 3', 'synthetic 1']);
    expect(getMessageWindow(db, CONV, 1, 1).map((m) => m.body)).toEqual(['synthetic 3']);
  });

  test('messages in the same second keep a stable order (ordinal, then id) and windows tile exactly', () => {
    const same = '2026-01-01T10:00:00';
    load([msg(1, same, { ordinal: 2 }), msg(2, same, { ordinal: 0 }), msg(3, same, { ordinal: 1 }), msg(4, same, { ordinal: 1 })]);
    const all = getMessageWindow(db, CONV, 0, 10).map((m) => m.body);
    expect(all).toEqual(['synthetic 2', 'synthetic 3', 'synthetic 4', 'synthetic 1']);
    const tiled = [0, 2].flatMap((offset) => getMessageWindow(db, CONV, offset, 2).map((m) => m.body));
    expect(tiled).toEqual(all);
    expect(getMessageWindow(db, CONV, 0, 10).map((m) => m.body)).toEqual(all);
  });

  test('edges: offset past the end is empty, a window straddling the end is short, limit is clamped', () => {
    load(Array.from({ length: 5 }, (_, i) => msg(i + 1, `2026-01-01T10:0${i}:00`)));
    expect(getMessageWindow(db, CONV, 5, 10)).toEqual([]);
    expect(getMessageWindow(db, CONV, 1_000_000, 10)).toEqual([]);
    expect(getMessageWindow(db, CONV, 3, 10)).toHaveLength(2);
    expect(getMessageWindow(db, CONV, 0, 0)).toHaveLength(1);
    expect(getMessageWindow(db, CONV, 0, -5)).toHaveLength(1);
    expect(getMessageWindow(db, CONV, 0, 2.9)).toHaveLength(2);
    expect(getMessageWindow(db, EMPTY, 0, 10)).toEqual([]);
  });

  test('limit is capped at MAX_WINDOW', () => {
    load(Array.from({ length: MAX_WINDOW + 20 }, (_, i) => msg(i + 1, '2026-01-01T10:00:00', { ordinal: i })));
    expect(getMessageWindow(db, CONV, 0, 100_000)).toHaveLength(MAX_WINDOW);
    expect(getMessageWindow(db, CONV, MAX_WINDOW, 100_000)).toHaveLength(20);
  });

  test('reads are scoped to their conversation', () => {
    load([msg(1, '2026-01-01T10:00:00'), msg(2, '2026-01-01T10:01:00')]);
    load([msg(1, '2026-05-05T10:00:00')], OTHER);
    expect(countMessages(db, CONV)).toBe(2);
    expect(countMessages(db, OTHER)).toBe(1);
    expect(getMessageWindow(db, OTHER, 0, 10).map((m) => m.sentAt)).toEqual(['2026-05-05T10:00:00']);
    expect(listConversationDays(db, OTHER)).toEqual([{ date: '2026-05-05', count: 1, firstOffset: 0 }]);
  });

  test('bounds: an empty conversation has null bounds', () => {
    expect(getConversationBounds(db, EMPTY)).toEqual({ count: 0, firstSentAt: null, lastSentAt: null });
    load([msg(1, '2026-01-02T10:00:00'), msg(2, '2026-01-01T09:00:00')]);
    expect(getConversationBounds(db, CONV)).toEqual({ count: 2, firstSentAt: '2026-01-01T09:00:00', lastSentAt: '2026-01-02T10:00:00' });
  });

  test('date jump: before the first, on a day, on an empty day, midnight, after the last', () => {
    load([
      msg(1, '2026-01-10T00:00:00'),
      msg(2, '2026-01-10T23:59:59'),
      msg(3, '2026-01-12T08:00:00'),
      msg(4, '2026-01-12T09:00:00'),
      msg(5, '2026-01-12T10:00:00'),
    ]);
    expect(findMessageOffsetByDate(db, CONV, '2025-12-31')).toBe(0);
    expect(findMessageOffsetByDate(db, CONV, '2026-01-10')).toBe(0);
    expect(findMessageOffsetByDate(db, CONV, '2026-01-11')).toBe(2); // empty day: the next message after it
    expect(findMessageOffsetByDate(db, CONV, '2026-01-12')).toBe(2);
    expect(findMessageOffsetByDate(db, CONV, '2026-01-13')).toBeNull();
    expect(findMessageOffsetByDate(db, EMPTY, '2026-01-01')).toBeNull();
    expect(getMessageWindow(db, CONV, 2, 1)[0].body).toBe('synthetic 3');
  });

  test('days listing: counts and first offsets, equal to the message count in total', () => {
    load([
      msg(1, '2026-01-10T00:00:00'),
      msg(2, '2026-01-10T23:59:59'),
      msg(3, '2026-01-12T08:00:00'),
      msg(4, '2026-02-01T09:00:00'),
      msg(5, '2026-02-01T09:00:00', { ordinal: 1 }),
      msg(6, '2026-02-01T10:00:00'),
    ]);
    const days = listConversationDays(db, CONV);
    expect(days).toEqual([
      { date: '2026-01-10', count: 2, firstOffset: 0 },
      { date: '2026-01-12', count: 1, firstOffset: 2 },
      { date: '2026-02-01', count: 3, firstOffset: 3 },
    ]);
    expect(days.reduce((n, d) => n + d.count, 0)).toBe(countMessages(db, CONV));
    for (const d of days) expect(getMessageWindow(db, CONV, d.firstOffset, 1)[0].sentAt.startsWith(d.date)).toBe(true);
    for (const d of days) expect(findMessageOffsetByDate(db, CONV, d.date)).toBe(d.firstOffset);
    expect(listConversationDays(db, EMPTY)).toEqual([]);
  });

  test('an overlapping re-import does not duplicate: counts and windows are unchanged', () => {
    const batch = [msg(1, '2026-01-01T10:00:00'), msg(2, '2026-01-01T10:01:00')];
    load(batch);
    const before = getMessageWindow(db, CONV, 0, 10);
    importMessages(db, { batchId: uuid(102), conversationId: CONV, source: 'whatsapp', sourceLabel: 'again.zip', now: '2026-02-02T12:00:00Z', blobs: [], messages: batch });
    expect(getMessageWindow(db, CONV, 0, 10)).toEqual(before);
    expect(countMessages(db, CONV)).toBe(2);
  });

  test('malformed requests are `invalid`, unknown conversations `not-found`', () => {
    expect(codeOf(() => getMessageWindow(db, 'nope', 0, 10))).toBe('invalid');
    expect(codeOf(() => countMessages(db, uuid(999)))).toBe('not-found');
    expect(codeOf(() => getConversationBounds(db, uuid(999)))).toBe('not-found');
    expect(codeOf(() => getMessageWindow(db, uuid(999), 0, 10))).toBe('not-found');
    expect(codeOf(() => findMessageOffsetByDate(db, uuid(999), '2026-01-01'))).toBe('not-found');
    expect(codeOf(() => listConversationDays(db, uuid(999)))).toBe('not-found');
    for (const offset of [-1, 1.5, Number.NaN, Infinity, '1' as unknown as number]) {
      expect(codeOf(() => getMessageWindow(db, CONV, offset, 10))).toBe('invalid');
    }
    for (const limit of [Number.NaN, Infinity, undefined as unknown as number]) {
      expect(codeOf(() => getMessageWindow(db, CONV, 0, limit))).toBe('invalid');
    }
    for (const date of ['2026-1-1', '2026-02-30', '2026-13-01', '2026-01-01T00:00:00', "2026-01-01' OR 1=1", '', 20260101 as unknown as string]) {
      expect(codeOf(() => findMessageOffsetByDate(db, CONV, date))).toBe('invalid');
    }
  });
});
