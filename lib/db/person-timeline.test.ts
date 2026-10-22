import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  MAX_WINDOW,
  createConversation,
  createProfile,
  findPersonTimelineOffsetByDate,
  getPersonTimelineBounds,
  getPersonTimelineWindow,
  importMessages,
  linkConversationProfile,
  listPersonTimelineDays,
  moveConversation,
  setProfileArchived,
  unlinkConversationProfile,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const NOW = '2026-02-01T12:00:00Z';
const [ANA, BO] = [uuid(1), uuid(2)];
const [C1, C2, C3, SHARED] = [uuid(10), uuid(11), uuid(12), uuid(13)];

let n = 0;
const msg = (sentAt: string, body: string, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: fp(++n),
  sentAt,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

let db: SqlDb;
let batch = 100;
function load(conversationId: string, messages: NewMessage[]) {
  importMessages(db, { batchId: uuid(batch++), conversationId, source: 'whatsapp', sourceLabel: 'x.zip', now: NOW, blobs: [], messages, meAuthor: 'Ana' });
}
const bodies = (profile: string, offset = 0, limit = 100) => getPersonTimelineWindow(db, profile, offset, limit).map((m) => m.body);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return toDbError(error).code;
  }
  return 'none';
};

beforeEach(async () => {
  n = 0;
  batch = 100;
  db = (await openMemoryDb()).db;
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BO, displayName: 'Bo', now: NOW });
  const base = { source: 'whatsapp', isGroup: false, participants: [], now: NOW };
  createConversation(db, { ...base, id: C1, title: 'Ana 1', profileIds: [ANA] });
  createConversation(db, { ...base, id: C2, title: 'Ana 2', profileIds: [ANA] });
  createConversation(db, { ...base, id: C3, title: 'Bo only', profileIds: [BO] });
  createConversation(db, { ...base, id: SHARED, title: 'Family', isGroup: true, profileIds: [ANA, BO] });
});

describe('person timeline reads', () => {
  test('merges every conversation of the person in time order, saying where each message came from', () => {
    load(C1, [msg('2026-01-03T10:00:00', 'c1-late'), msg('2026-01-01T10:00:00', 'c1-early', { participantName: 'Bo' })]);
    load(C2, [msg('2026-01-02T10:00:00', 'c2-mid', { type: 'system', participantName: null })]);
    const items = getPersonTimelineWindow(db, ANA, 0, 10);
    expect(items.map((i) => i.body)).toEqual(['c1-early', 'c2-mid', 'c1-late']);
    expect(items.map((i) => i.conversationTitle)).toEqual(['Ana 1', 'Ana 2', 'Ana 1']);
    expect(items[0]).toMatchObject({ conversationId: C1, participantName: 'Bo', isMe: false, isSystem: false, mediaSha256: null });
    expect(items[1]).toMatchObject({ conversationId: C2, isSystem: true, participantName: null });
    expect(items[2]).toMatchObject({ isMe: true });
    expect(getPersonTimelineBounds(db, ANA)).toEqual({ count: 3, firstSentAt: '2026-01-01T10:00:00', lastSentAt: '2026-01-03T10:00:00' });
  });

  test('ties are the total order (sent_at, ordinal, conversation, id) and windows tile exactly', () => {
    const same = '2026-01-01T10:00:00';
    load(C2, [msg(same, 'c2-o1', { ordinal: 1 }), msg(same, 'c2-o0a'), msg(same, 'c2-o0b', { ordinal: 0 })]);
    load(C1, [msg(same, 'c1-o1', { ordinal: 1 }), msg(same, 'c1-o0')]);
    const all = bodies(ANA);
    expect(all).toEqual(['c1-o0', 'c2-o0a', 'c2-o0b', 'c1-o1', 'c2-o1']);
    expect([0, 2, 4].flatMap((o) => bodies(ANA, o, 2))).toEqual(all);
    expect(bodies(ANA)).toEqual(all);
  });

  test("other people's conversations are excluded; a shared conversation is in both timelines", () => {
    load(C1, [msg('2026-01-01T10:00:00', 'ana')]);
    load(C3, [msg('2026-01-02T10:00:00', 'bo')]);
    load(SHARED, [msg('2026-01-03T10:00:00', 'family')]);
    expect(bodies(ANA)).toEqual(['ana', 'family']);
    expect(bodies(BO)).toEqual(['bo', 'family']);
    expect(getPersonTimelineBounds(db, BO).count).toBe(2);
  });

  test('moving, linking and unlinking a conversation change the result; messages are untouched', () => {
    load(C1, [msg('2026-01-01T10:00:00', 'one')]);
    load(C3, [msg('2026-01-02T10:00:00', 'three')]);
    linkConversationProfile(db, { conversationId: C3, profileId: ANA });
    expect(bodies(ANA)).toEqual(['one', 'three']);
    unlinkConversationProfile(db, { conversationId: C3, profileId: ANA });
    expect(bodies(ANA)).toEqual(['one']);
    moveConversation(db, { conversationId: C1, fromProfileId: ANA, toProfileId: BO });
    expect(bodies(ANA)).toEqual([]);
    expect(bodies(BO)).toEqual(['one', 'three']);
    expect(getPersonTimelineBounds(db, ANA)).toEqual({ count: 0, firstSentAt: null, lastSentAt: null });
  });

  test('an archived person keeps their timeline; an overlapping re-import does not duplicate it', () => {
    const batchMsgs = [msg('2026-01-01T10:00:00', 'a')];
    load(C1, batchMsgs);
    load(C1, batchMsgs);
    setProfileArchived(db, { id: ANA, archived: true, now: NOW });
    expect(bodies(ANA)).toEqual(['a']);
    expect(getPersonTimelineBounds(db, ANA).count).toBe(1);
  });

  test('a date jump finds the first message on or after the day, null when all are earlier', () => {
    load(C1, [msg('2026-01-01T23:59:59', 'a'), msg('2026-01-03T00:00:00', 'c')]);
    load(C2, [msg('2026-01-03T08:00:00', 'd'), msg('2026-01-02T08:00:00', 'b')]);
    expect(findPersonTimelineOffsetByDate(db, ANA, '2025-12-01')).toBe(0);
    expect(findPersonTimelineOffsetByDate(db, ANA, '2026-01-01')).toBe(0);
    expect(findPersonTimelineOffsetByDate(db, ANA, '2026-01-02')).toBe(1);
    expect(findPersonTimelineOffsetByDate(db, ANA, '2026-01-03')).toBe(2);
    expect(bodies(ANA, 2, 1)).toEqual(['c']);
    expect(findPersonTimelineOffsetByDate(db, ANA, '2026-01-04')).toBeNull();
    expect(findPersonTimelineOffsetByDate(db, BO, '2026-01-01')).toBeNull();
  });

  test('days carry counts and the offset of their first message, across conversations', () => {
    load(C1, [msg('2026-01-01T10:00:00', 'a'), msg('2026-01-01T11:00:00', 'b'), msg('2026-01-03T10:00:00', 'e')]);
    load(C2, [msg('2026-01-01T12:00:00', 'c'), msg('2026-01-02T10:00:00', 'd')]);
    load(C3, [msg('2026-01-02T10:00:00', 'not ana')]);
    const days = listPersonTimelineDays(db, ANA);
    expect(days).toEqual([
      { date: '2026-01-01', count: 3, firstOffset: 0 },
      { date: '2026-01-02', count: 1, firstOffset: 3 },
      { date: '2026-01-03', count: 1, firstOffset: 4 },
    ]);
    for (const d of days) expect(getPersonTimelineWindow(db, ANA, d.firstOffset, 1)[0].sentAt.startsWith(d.date)).toBe(true);
    expect(listPersonTimelineDays(db, BO)).toEqual([{ date: '2026-01-02', count: 1, firstOffset: 0 }]);
  });

  test('edges: empty person, offset past the end, limit clamped', () => {
    expect(getPersonTimelineWindow(db, ANA, 0, 10)).toEqual([]);
    expect(listPersonTimelineDays(db, ANA)).toEqual([]);
    expect(findPersonTimelineOffsetByDate(db, ANA, '2026-01-01')).toBeNull();
    load(C1, Array.from({ length: MAX_WINDOW + 20 }, (_, i) => msg('2026-01-01T10:00:00', `m${i}`, { ordinal: i })));
    expect(getPersonTimelineWindow(db, ANA, 1_000_000, 10)).toEqual([]);
    expect(getPersonTimelineWindow(db, ANA, 0, 100_000)).toHaveLength(MAX_WINDOW);
    expect(getPersonTimelineWindow(db, ANA, MAX_WINDOW, 100_000)).toHaveLength(20);
    expect(getPersonTimelineWindow(db, ANA, 0, 0)).toHaveLength(1);
    expect(getPersonTimelineWindow(db, ANA, 0, 2.9)).toHaveLength(2);
  });

  test('malformed input is invalid, an unknown profile not-found', () => {
    for (const read of [
      (p: string) => getPersonTimelineBounds(db, p),
      (p: string) => getPersonTimelineWindow(db, p, 0, 10),
      (p: string) => findPersonTimelineOffsetByDate(db, p, '2026-01-01'),
      (p: string) => listPersonTimelineDays(db, p),
    ]) {
      expect(codeOf(() => read(uuid(99)))).toBe('not-found');
      expect(codeOf(() => read('nope'))).toBe('invalid');
      expect(codeOf(() => read(undefined as unknown as string))).toBe('invalid');
      expect(codeOf(() => read(C1))).toBe('not-found');
    }
    for (const offset of [-1, 1.5, Number.NaN, Infinity, '1' as unknown as number]) {
      expect(codeOf(() => getPersonTimelineWindow(db, ANA, offset, 10))).toBe('invalid');
    }
    for (const limit of [Number.NaN, Infinity, undefined as unknown as number]) {
      expect(codeOf(() => getPersonTimelineWindow(db, ANA, 0, limit))).toBe('invalid');
    }
    for (const date of ['2026-02-30', '2026-1-1', '', "2026-01-01' OR 1=1", 20260101 as unknown as string]) {
      expect(codeOf(() => findPersonTimelineOffsetByDate(db, ANA, date))).toBe('invalid');
    }
  });
});
