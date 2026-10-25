import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  createConversation,
  createProfile,
  findMessageOffsetById,
  findPersonTimelineOffsetById,
  getMessageWindow,
  getPersonTimelineWindow,
  importMessages,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const NOW = '2026-02-01T12:00:00Z';
const [ANA, BO] = [uuid(1), uuid(2)];
const [C1, C2, C3] = [uuid(10), uuid(11), uuid(12)];

const msg = (n: number, sentAt: string, ordinal = 0): NewMessage => ({
  fingerprint: fp(n),
  sentAt,
  ordinal,
  type: 'text',
  participantName: 'Ana',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
});

let db: SqlDb;
let batch = 100;
const load = (conversationId: string, messages: NewMessage[]) =>
  importMessages(db, { batchId: uuid(batch++), conversationId, source: 'whatsapp', sourceLabel: 'x.zip', now: NOW, blobs: [], messages, meAuthor: 'Ana' });
const idOf = (conversationId: string, n: number) => db.all<{ id: number }>('SELECT id FROM messages WHERE conversation_id = ? AND fingerprint = ?', [conversationId, fp(n)])[0].id;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return toDbError(error).code;
  }
  return 'none';
};

beforeEach(async () => {
  batch = 100;
  db = (await openMemoryDb()).db;
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BO, displayName: 'Bo', now: NOW });
  const base = { source: 'whatsapp', isGroup: false, participants: [], now: NOW };
  createConversation(db, { ...base, id: C1, title: 'Ana 1', profileIds: [ANA] });
  createConversation(db, { ...base, id: C2, title: 'Ana 2', profileIds: [ANA] });
  createConversation(db, { ...base, id: C3, title: 'Bo only', profileIds: [BO] });
});

describe('findMessageOffsetById', () => {
  test('is the index of the message in the window order, ties on time and ordinal included', () => {
    // 2 and 3 share sent_at (ordinals 1, 0); 4 and 5 share both (ordered by id, i.e. insertion order).
    load(C1, [msg(1, '2026-01-01T10:00:00'), msg(2, '2026-01-01T11:00:00', 1), msg(3, '2026-01-01T11:00:00', 0), msg(4, '2026-01-02T09:00:00'), msg(5, '2026-01-02T09:00:00')]);
    const window = getMessageWindow(db, C1, 0, 10);
    expect(window.map((m) => m.body)).toEqual(['synthetic 1', 'synthetic 3', 'synthetic 2', 'synthetic 4', 'synthetic 5']);
    window.forEach((m, i) => expect(findMessageOffsetById(db, C1, m.id)).toBe(i));
  });

  test('a message of another conversation or a missing id is null', () => {
    load(C1, [msg(1, '2026-01-01T10:00:00')]);
    load(C2, [msg(2, '2026-01-01T10:00:00')]);
    expect(findMessageOffsetById(db, C1, idOf(C2, 2))).toBeNull();
    expect(findMessageOffsetById(db, C1, 99_999)).toBeNull();
  });

  test('malformed requests are invalid, an unknown conversation not-found', () => {
    load(C1, [msg(1, '2026-01-01T10:00:00')]);
    for (const id of [0, -1, 1.5, Number.NaN, '1' as unknown as number, undefined as unknown as number]) {
      expect(codeOf(() => findMessageOffsetById(db, C1, id))).toBe('invalid');
    }
    expect(codeOf(() => findMessageOffsetById(db, 'nope', 1))).toBe('invalid');
    expect(codeOf(() => findMessageOffsetById(db, uuid(999), 1))).toBe('not-found');
  });

  test('the count is a range scan on messages_timeline', () => {
    load(C1, [msg(1, '2026-01-01T10:00:00')]);
    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT count(*) AS before FROM messages WHERE conversation_id = ?
           AND (sent_at < ? OR (sent_at = ? AND (ordinal < ? OR (ordinal = ? AND id < ?))))`,
        [C1, 'a', 'a', 0, 0, 1],
      )
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toContain('messages_timeline');
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});

describe('findPersonTimelineOffsetById', () => {
  test('is the index in the merged timeline, ties broken by conversation then id', () => {
    load(C1, [msg(1, '2026-01-03T10:00:00'), msg(2, '2026-01-01T10:00:00')]);
    load(C2, [msg(3, '2026-01-03T10:00:00'), msg(4, '2026-01-02T10:00:00'), msg(5, '2026-01-03T10:00:00', 1)]);
    const window = getPersonTimelineWindow(db, ANA, 0, 10);
    expect(window).toHaveLength(5);
    window.forEach((m, i) => expect(findPersonTimelineOffsetById(db, ANA, m.id)).toBe(i));
  });

  test('a message outside the person, a missing id or bad input', () => {
    load(C1, [msg(1, '2026-01-01T10:00:00')]);
    load(C3, [msg(2, '2026-01-01T10:00:00')]);
    expect(findPersonTimelineOffsetById(db, ANA, idOf(C3, 2))).toBeNull();
    expect(findPersonTimelineOffsetById(db, BO, idOf(C1, 1))).toBeNull();
    expect(findPersonTimelineOffsetById(db, ANA, 99_999)).toBeNull();
    expect(codeOf(() => findPersonTimelineOffsetById(db, ANA, 0))).toBe('invalid');
    expect(codeOf(() => findPersonTimelineOffsetById(db, 'nope', 1))).toBe('invalid');
    expect(codeOf(() => findPersonTimelineOffsetById(db, uuid(999), 1))).toBe('not-found');
  });
});
