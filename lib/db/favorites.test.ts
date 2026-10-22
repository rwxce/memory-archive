import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  countFavorites,
  createConversation,
  createProfile,
  getMessageWindow,
  getPersonTimelineWindow,
  importMessages,
  listFavorites,
  setFavorite,
  undoImportBatch,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const NOW = '2026-02-01T12:00:00Z';
const [ANA, BO] = [uuid(1), uuid(2)];
const [C1, C2, C3] = [uuid(10), uuid(11), uuid(12)];

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
let batch = 100;
function load(conversationId: string, messages: NewMessage[]) {
  const id = uuid(batch++);
  importMessages(db, { batchId: id, conversationId, source: 'whatsapp', sourceLabel: 'x.zip', now: NOW, blobs: [], messages, meAuthor: 'Ana' });
  return id;
}
const idOf = (conversationId: string, n: number) => db.all<{ id: number }>('SELECT id FROM messages WHERE conversation_id = ? AND fingerprint = ?', [conversationId, fp(n)])[0].id;
const star = (conversationId: string, n: number, favorite = true) => setFavorite(db, { conversationId, messageId: idOf(conversationId, n), favorite, now: NOW });
const bodies = (scope?: Parameters<typeof listFavorites>[1], offset = 0, limit = 100) => listFavorites(db, scope, offset, limit).map((m) => m.body);
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
  load(C1, [msg(1, '2026-01-03T10:00:00'), msg(2, '2026-01-01T10:00:00')]);
  load(C2, [msg(3, '2026-01-02T10:00:00'), msg(4, '2026-01-04T10:00:00')]);
  load(C3, [msg(5, '2026-01-05T10:00:00'), msg(1, '2026-01-06T10:00:00', { body: 'same fingerprint, other conversation' })]);
});

describe('setFavorite', () => {
  test('stores the fingerprint of the conversation, not the local id', () => {
    expect(star(C1, 1)).toEqual({ messageId: idOf(C1, 1), isFavorite: true });
    expect(db.all('SELECT conversation_id, fingerprint, created_at FROM favorites')).toEqual([{ conversation_id: C1, fingerprint: fp(1), created_at: NOW }]);
  });

  test('the same fingerprint in another conversation is a different message', () => {
    star(C1, 1);
    expect(countFavorites(db, { conversationId: C3 })).toBe(0);
    expect(getMessageWindow(db, C3, 0, 10).map((m) => m.isFavorite)).toEqual([false, false]);
  });

  test('is idempotent: favoriting twice is one row and keeps the first date, unfavoriting a non-favorite is a no-op', () => {
    star(C1, 1);
    setFavorite(db, { conversationId: C1, messageId: idOf(C1, 1), favorite: true, now: '2027-01-01T00:00:00Z' });
    expect(db.all('SELECT created_at FROM favorites')).toEqual([{ created_at: NOW }]);
    expect(star(C1, 2, false)).toMatchObject({ isFavorite: false });
    expect(db.all('SELECT * FROM favorites')).toHaveLength(1);
    expect(star(C1, 1, false)).toMatchObject({ isFavorite: false });
    expect(db.all('SELECT * FROM favorites')).toHaveLength(0);
  });

  test('checks the pair: a message of another conversation, or an unknown one, is not-found', () => {
    expect(codeOf(() => setFavorite(db, { conversationId: C2, messageId: idOf(C1, 1), favorite: true, now: NOW }))).toBe('not-found');
    expect(codeOf(() => setFavorite(db, { conversationId: C1, messageId: 99_999, favorite: true, now: NOW }))).toBe('not-found');
    expect(codeOf(() => setFavorite(db, { conversationId: uuid(77), messageId: idOf(C1, 1), favorite: false, now: NOW }))).toBe('not-found');
    expect(db.all('SELECT * FROM favorites')).toHaveLength(0);
  });

  test('refuses malformed input', () => {
    const ok = { conversationId: C1, messageId: idOf(C1, 1), favorite: true, now: NOW };
    expect(codeOf(() => setFavorite(db, { ...ok, conversationId: 'nope' }))).toBe('invalid');
    expect(codeOf(() => setFavorite(db, { ...ok, messageId: 0 }))).toBe('invalid');
    expect(codeOf(() => setFavorite(db, { ...ok, messageId: 1.5 }))).toBe('invalid');
    expect(codeOf(() => setFavorite(db, { ...ok, favorite: 'yes' as unknown as boolean }))).toBe('invalid');
    expect(codeOf(() => setFavorite(db, { ...ok, now: 5 as unknown as string }))).toBe('invalid');
    expect(codeOf(() => setFavorite(db, null as never))).toBe('invalid');
  });
});

describe('isFavorite in the windows', () => {
  test('the conversation window and the person timeline flag exactly the favorites', () => {
    star(C1, 2);
    star(C2, 4);
    expect(getMessageWindow(db, C1, 0, 10).map((m) => [m.body, m.isFavorite])).toEqual([
      ['synthetic 2', true],
      ['synthetic 1', false],
    ]);
    expect(getPersonTimelineWindow(db, ANA, 0, 10).map((m) => [m.body, m.isFavorite])).toEqual([
      ['synthetic 2', true],
      ['synthetic 3', false],
      ['synthetic 1', false],
      ['synthetic 4', true],
    ]);
  });

  test('a window never gains or loses rows because of favorites', () => {
    const before = getPersonTimelineWindow(db, ANA, 0, 100).map((m) => m.id);
    star(C1, 1);
    expect(getPersonTimelineWindow(db, ANA, 0, 100).map((m) => m.id)).toEqual(before);
  });
});

describe('countFavorites / listFavorites', () => {
  beforeEach(() => {
    star(C1, 1); // 01-03
    star(C2, 3); // 01-02
    star(C2, 4); // 01-04
    star(C3, 5); // 01-05, Bo's
  });

  test('the whole archive, one person, or one conversation, oldest first across conversations', () => {
    expect(countFavorites(db)).toBe(4);
    expect(bodies()).toEqual(['synthetic 3', 'synthetic 1', 'synthetic 4', 'synthetic 5']);
    expect(countFavorites(db, { profileId: ANA })).toBe(3);
    expect(bodies({ profileId: ANA })).toEqual(['synthetic 3', 'synthetic 1', 'synthetic 4']);
    expect(listFavorites(db, { profileId: ANA }, 0, 10).map((m) => m.conversationTitle)).toEqual(['Ana 2', 'Ana 1', 'Ana 2']);
    expect(bodies({ conversationId: C2 })).toEqual(['synthetic 3', 'synthetic 4']);
    expect(listFavorites(db, { conversationId: C2 }, 0, 10).every((m) => m.isFavorite && m.conversationId === C2)).toBe(true);
  });

  test('the items are timeline messages: author, "me", media and conversation', () => {
    db.run("INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, 'image/png')", ['ab'.repeat(32)]);
    load(C1, [msg(9, '2026-01-09T10:00:00', { type: 'photo', mediaSha256: 'ab'.repeat(32), mediaName: 'IMG-1.jpg', participantName: 'Bo' })]);
    star(C1, 9);
    expect(listFavorites(db, { conversationId: C1 }, 1, 1)[0]).toMatchObject({
      conversationId: C1,
      conversationTitle: 'Ana 1',
      type: 'photo',
      participantName: 'Bo',
      isMe: false,
      isSystem: false,
      isFavorite: true,
      mediaSha256: 'ab'.repeat(32),
      mediaName: 'IMG-1.jpg',
      mediaMime: 'image/png',
    });
  });

  test('pages tile, the limit is clamped and past the end is empty', () => {
    expect([...bodies(undefined, 0, 2), ...bodies(undefined, 2, 2)]).toEqual(bodies());
    expect(bodies(undefined, 4, 10)).toEqual([]);
    expect(listFavorites(db, undefined, 0, 0)).toHaveLength(1);
    expect(listFavorites(db, undefined, 0, 1_000_000)).toHaveLength(4);
  });

  test('unfavoriting removes it from the list and the count', () => {
    star(C2, 3, false);
    expect(countFavorites(db)).toBe(3);
    expect(bodies({ conversationId: C2 })).toEqual(['synthetic 4']);
  });

  test('a favorite of an archived person is still listed', () => {
    db.run('UPDATE profiles SET archived_at = ? WHERE id = ?', [NOW, ANA]);
    expect(countFavorites(db, { profileId: ANA })).toBe(3);
  });

  test('unknown or malformed scope and paging', () => {
    expect(codeOf(() => countFavorites(db, { profileId: uuid(90) }))).toBe('not-found');
    expect(codeOf(() => listFavorites(db, { conversationId: uuid(90) }, 0, 1))).toBe('not-found');
    expect(codeOf(() => countFavorites(db, { profileId: ANA, conversationId: C1 }))).toBe('invalid');
    expect(codeOf(() => countFavorites(db, { profileId: 'x' }))).toBe('invalid');
    expect(codeOf(() => listFavorites(db, undefined, -1, 1))).toBe('invalid');
    expect(codeOf(() => listFavorites(db, undefined, 0, Number.NaN))).toBe('invalid');
    expect(codeOf(() => listFavorites(db, 'x' as never, 0, 1))).toBe('invalid');
  });
});

describe('favorites and imports', () => {
  test('a newer export of the same chat keeps the favorite on the same message', () => {
    star(C1, 1);
    load(C1, [msg(1, '2026-01-03T10:00:00'), msg(8, '2025-12-01T10:00:00')]);
    expect(getMessageWindow(db, C1, 0, 10).map((m) => [m.body, m.isFavorite])).toEqual([
      ['synthetic 8', false],
      ['synthetic 2', false],
      ['synthetic 1', true],
    ]);
    expect(countFavorites(db)).toBe(1);
  });

  test('undoing the batch that added the message leaves the favorite dormant; importing again revives it', () => {
    const extra = load(C1, [msg(8, '2025-12-01T10:00:00')]);
    star(C1, 8);
    expect(countFavorites(db, { conversationId: C1 })).toBe(1);
    undoImportBatch(db, extra);
    expect(countFavorites(db)).toBe(0);
    expect(bodies()).toEqual([]);
    expect(db.all('SELECT fingerprint FROM favorites')).toEqual([{ fingerprint: fp(8) }]);
    load(C1, [msg(8, '2025-12-01T10:00:00')]);
    expect(bodies()).toEqual(['synthetic 8']);
    expect(getMessageWindow(db, C1, 0, 1)[0].isFavorite).toBe(true);
  });

  test('undoing the import that created the conversation removes it, and its favorites with it', () => {
    const only = uuid(50);
    const batchId = importMessages(db, {
      batchId: uuid(150),
      conversationId: only,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: NOW,
      blobs: [],
      messages: [msg(20, '2026-03-01T10:00:00')],
      newConversation: { title: 'New', sourceKey: 'new', isGroup: false, profileIds: [] },
    }).batchId;
    star(only, 20);
    expect(undoImportBatch(db, batchId)).toMatchObject({ removedConversation: true });
    expect(db.all('SELECT * FROM favorites WHERE conversation_id = ?', [only])).toEqual([]);
  });
});
