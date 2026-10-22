import { beforeEach, describe, expect, test } from 'vitest';
import { NOTE_MAX } from '../domain/profile';
import type { NewMessage, NoteTarget } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  countNotes,
  createConversation,
  createProfile,
  countFavorites,
  getMessageWindow,
  getNote,
  getPersonTimelineWindow,
  importMessages,
  listFavorites,
  listNotes,
  setFavorite,
  setNote,
  undoImportBatch,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const [ANA, BO] = [uuid(1), uuid(2)];
const [C1, C2, C3] = [uuid(10), uuid(11), uuid(12)];
const T = (n: number) => `2026-02-0${n}T12:00:00Z`;

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
  importMessages(db, { batchId: id, conversationId, source: 'whatsapp', sourceLabel: 'x.zip', now: T(1), blobs: [], messages, meAuthor: 'Ana' });
  return id;
}
const idOf = (conversationId: string, n: number) => db.all<{ id: number }>('SELECT id FROM messages WHERE conversation_id = ? AND fingerprint = ?', [conversationId, fp(n)])[0].id;
const onMessage = (conversationId: string, n: number): NoteTarget => ({ kind: 'message', conversationId, messageId: idOf(conversationId, n) });
const onProfile = (profileId: string): NoteTarget => ({ kind: 'profile', profileId });
const onConversation = (conversationId: string): NoteTarget => ({ kind: 'conversation', conversationId });
const write = (target: NoteTarget, body: string, day = 2) => setNote(db, { target, body, now: T(day) });
const bodies = (scope?: Parameters<typeof listNotes>[1], offset = 0, limit = 100) => listNotes(db, scope, offset, limit).map((n) => n.body);
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
  createProfile(db, { id: ANA, displayName: 'Ana', now: T(1) });
  createProfile(db, { id: BO, displayName: 'Bo', now: T(1) });
  const base = { source: 'whatsapp', isGroup: false, participants: [], now: T(1) };
  createConversation(db, { ...base, id: C1, title: 'Ana 1', profileIds: [ANA] });
  createConversation(db, { ...base, id: C2, title: 'Ana 2', profileIds: [ANA] });
  createConversation(db, { ...base, id: C3, title: 'Bo only', profileIds: [BO] });
  load(C1, [msg(1, '2026-01-03T10:00:00'), msg(2, '2026-01-01T10:00:00')]);
  load(C2, [msg(3, '2026-01-02T10:00:00'), msg(4, '2026-01-04T10:00:00')]);
  load(C3, [msg(5, '2026-01-05T10:00:00'), msg(1, '2026-01-06T10:00:00', { body: 'same fingerprint, other conversation' })]);
});

describe('setNote / getNote', () => {
  test('creates, reads and edits one note per target, keeping created_at', () => {
    for (const target of [onProfile(ANA), onConversation(C1), onMessage(C1, 1)]) {
      expect(getNote(db, target)).toBeNull();
      expect(write(target, '  first  ', 2)).toEqual({ kind: target.kind, body: 'first', createdAt: T(2), updatedAt: T(2) });
      expect(write(target, 'second\nline', 4)).toEqual({ kind: target.kind, body: 'second\nline', createdAt: T(2), updatedAt: T(4) });
      expect(getNote(db, target)).toEqual({ kind: target.kind, body: 'second\nline', createdAt: T(2), updatedAt: T(4) });
    }
    expect(db.all('SELECT * FROM notes')).toHaveLength(3);
  });

  test('stores a message note by conversation and fingerprint, never the local id', () => {
    write(onMessage(C1, 1), 'x');
    expect(db.all('SELECT kind, profile_id, conversation_id, fingerprint FROM notes')).toEqual([
      { kind: 'message', profile_id: null, conversation_id: C1, fingerprint: fp(1) },
    ]);
    // the same fingerprint in another conversation is another message, another note
    expect(getNote(db, onMessage(C3, 1))).toBeNull();
  });

  test('saving the same text changes nothing, not even updated_at', () => {
    write(onProfile(ANA), 'same', 2);
    expect(write(onProfile(ANA), ' same ', 5)).toMatchObject({ updatedAt: T(2) });
  });

  test('an empty (or blank) text deletes the note and an absent note stays absent', () => {
    write(onConversation(C1), 'x');
    expect(write(onConversation(C1), '  \n ')).toBeNull();
    expect(getNote(db, onConversation(C1))).toBeNull();
    expect(db.all('SELECT * FROM notes')).toEqual([]);
    expect(write(onConversation(C1), '')).toBeNull();
    expect(write(onConversation(C1), 'back', 6)).toMatchObject({ createdAt: T(6) });
  });

  test('the text bound is enforced by the application, in code units, and nothing is truncated', () => {
    expect(write(onProfile(ANA), 'a'.repeat(NOTE_MAX))?.body).toHaveLength(NOTE_MAX);
    expect(codeOf(() => write(onProfile(ANA), 'a'.repeat(NOTE_MAX + 1)))).toBe('invalid');
    expect(getNote(db, onProfile(ANA))?.body).toHaveLength(NOTE_MAX);
    expect(codeOf(() => write(onProfile(ANA), 'bad \u0000 text'))).toBe('invalid');
    expect(codeOf(() => write(onProfile(ANA), 'lone \ud800'))).toBe('invalid');
    expect(codeOf(() => write(onProfile(ANA), 5 as never))).toBe('invalid');
    // hostile text is data: bound as a parameter, kept as is
    expect(write(onProfile(BO), "Robert'); DROP TABLE notes;--\n<script>x</script>")?.body).toContain('DROP TABLE');
    expect(db.all('SELECT count(*) AS n FROM notes')).toEqual([{ n: 2 }]);
  });

  test('unknown targets are not-found, malformed ones invalid, and a message must belong to the conversation', () => {
    expect(codeOf(() => write(onProfile(uuid(90)), 'x'))).toBe('not-found');
    expect(codeOf(() => write(onConversation(uuid(90)), 'x'))).toBe('not-found');
    expect(codeOf(() => write({ kind: 'message', conversationId: C2, messageId: idOf(C1, 1) }, 'x'))).toBe('not-found');
    expect(codeOf(() => write({ kind: 'message', conversationId: C1, messageId: 999_999 }, 'x'))).toBe('not-found');
    expect(codeOf(() => getNote(db, { kind: 'message', conversationId: C2, messageId: idOf(C1, 1) }))).toBe('not-found');
    expect(codeOf(() => write({ kind: 'message', conversationId: C1, messageId: 0 }, 'x'))).toBe('invalid');
    expect(codeOf(() => write({ kind: 'message', conversationId: C1, messageId: '1' as never }, 'x'))).toBe('invalid');
    expect(codeOf(() => write({ kind: 'profile', profileId: 'x' }, 'x'))).toBe('invalid');
    expect(codeOf(() => write({ kind: 'other' } as never, 'x'))).toBe('invalid');
    expect(codeOf(() => write({ kind: 'profile', profileId: ANA, conversationId: C1 } as never, 'x'))).toBe('invalid');
    expect(codeOf(() => write('x' as never, 'x'))).toBe('invalid');
    expect(codeOf(() => setNote(db, { target: onProfile(ANA), body: 'x', now: 5 as never }))).toBe('invalid');
    expect(db.all('SELECT * FROM notes')).toEqual([]);
  });

  test('a note on an archived profile still works', () => {
    db.run('UPDATE profiles SET archived_at = ? WHERE id = ?', [T(3), ANA]);
    expect(write(onProfile(ANA), 'still here')).not.toBeNull();
  });
});

describe('listNotes / countNotes', () => {
  beforeEach(() => {
    write(onProfile(ANA), 'about Ana', 2);
    write(onProfile(BO), 'about Bo', 3);
    write(onConversation(C1), 'chat 1', 4);
    write(onMessage(C1, 1), 'msg c1', 5);
    write(onMessage(C2, 4), 'msg c2', 6);
    write(onMessage(C3, 5), 'msg c3', 7);
  });

  test('the most recently edited first, with the context to show and open each note', () => {
    expect(bodies()).toEqual(['msg c3', 'msg c2', 'msg c1', 'chat 1', 'about Bo', 'about Ana']);
    const items = listNotes(db, undefined, 0, 100);
    expect(items[1]).toEqual({
      kind: 'message',
      body: 'msg c2',
      createdAt: T(6),
      updatedAt: T(6),
      profileId: null,
      profileName: null,
      conversationId: C2,
      conversationTitle: 'Ana 2',
      message: { id: idOf(C2, 4), sentAt: '2026-01-04T10:00:00', type: 'text', participantName: 'Ana', isMe: true, body: 'synthetic 4', mediaName: '' },
    });
    expect(items[3]).toMatchObject({ kind: 'conversation', conversationId: C1, conversationTitle: 'Ana 1', profileId: null, message: null });
    expect(items[5]).toMatchObject({ kind: 'profile', profileId: ANA, profileName: 'Ana', conversationId: null, conversationTitle: null, message: null });
    write(onProfile(ANA), 'about Ana, edited', 8);
    expect(bodies(undefined, 0, 1)).toEqual(['about Ana, edited']);
  });

  test('scopes: a person gets their own note and those of their conversations; a conversation its own and its messages', () => {
    expect(bodies({ profileId: ANA })).toEqual(['msg c2', 'msg c1', 'chat 1', 'about Ana']);
    expect(bodies({ profileId: BO })).toEqual(['msg c3', 'about Bo']);
    expect(bodies({ conversationId: C1 })).toEqual(['msg c1', 'chat 1']);
    expect(bodies({ conversationId: C2 })).toEqual(['msg c2']);
    expect([countNotes(db), countNotes(db, { profileId: ANA }), countNotes(db, { conversationId: C1 }), countNotes(db, { conversationId: C3 })]).toEqual([6, 4, 2, 1]);
    // a conversation linked to two people is in both scopes
    db.run('INSERT INTO conversation_profiles (conversation_id, profile_id) VALUES (?, ?)', [C2, BO]);
    expect(bodies({ profileId: BO })).toEqual(['msg c3', 'msg c2', 'about Bo']);
  });

  test('pages tile without overlap, even when updated_at ties', () => {
    write(onProfile(ANA), 'tie a', 9);
    write(onProfile(BO), 'tie b', 9);
    const all = bodies();
    expect([...bodies(undefined, 0, 3), ...bodies(undefined, 3, 3), ...bodies(undefined, 6, 3)]).toEqual(all);
    expect(bodies(undefined, 99, 10)).toEqual([]);
    expect(listNotes(db, undefined, 0, 0)).toHaveLength(1); // limit clamped to at least 1
  });

  test('unknown or malformed scope and paging', () => {
    expect(codeOf(() => countNotes(db, { profileId: uuid(90) }))).toBe('not-found');
    expect(codeOf(() => listNotes(db, { conversationId: uuid(90) }, 0, 1))).toBe('not-found');
    expect(codeOf(() => countNotes(db, { profileId: ANA, conversationId: C1 }))).toBe('invalid');
    expect(codeOf(() => countNotes(db, { profileId: 'x' }))).toBe('invalid');
    expect(codeOf(() => listNotes(db, undefined, -1, 1))).toBe('invalid');
    expect(codeOf(() => listNotes(db, undefined, 0, Number.NaN))).toBe('invalid');
    expect(codeOf(() => listNotes(db, 'x' as never, 0, 1))).toBe('invalid');
  });
});

describe('hasNote in the windows', () => {
  test('marks exactly the annotated messages in the conversation window and the person timeline', () => {
    write(onMessage(C1, 1), 'x');
    write(onMessage(C2, 4), 'y');
    write(onConversation(C1), 'not a message note');
    write(onProfile(ANA), 'neither');
    expect(getMessageWindow(db, C1, 0, 10).map((m) => [m.body, m.hasNote])).toEqual([
      ['synthetic 2', false],
      ['synthetic 1', true],
    ]);
    expect(getPersonTimelineWindow(db, ANA, 0, 10).map((m) => [m.body, m.hasNote])).toEqual([
      ['synthetic 2', false],
      ['synthetic 3', false],
      ['synthetic 1', true],
      ['synthetic 4', true],
    ]);
    // the same fingerprint in another conversation is not annotated
    expect(getMessageWindow(db, C3, 0, 10).map((m) => m.hasNote)).toEqual([false, false]);
    write(onMessage(C1, 1), '');
    expect(getMessageWindow(db, C1, 0, 10).some((m) => m.hasNote)).toBe(false);
  });

  test('the favorite list reports the note too, and favorites and notes do not affect each other', () => {
    setFavorite(db, { conversationId: C1, messageId: idOf(C1, 1), favorite: true, now: T(2) });
    write(onMessage(C1, 1), 'x');
    expect(listFavorites(db, undefined, 0, 10)).toMatchObject([{ body: 'synthetic 1', isFavorite: true, hasNote: true }]);
    setFavorite(db, { conversationId: C1, messageId: idOf(C1, 1), favorite: false, now: T(2) });
    expect(getNote(db, onMessage(C1, 1))).not.toBeNull();
    expect(countFavorites(db)).toBe(0);
    expect(countNotes(db)).toBe(1);
  });
});

describe('notes and imports', () => {
  test('a newer export of the same chat keeps the note on the same message', () => {
    write(onMessage(C1, 1), 'keep');
    load(C1, [msg(1, '2026-01-03T10:00:00'), msg(8, '2025-12-01T10:00:00')]);
    expect(getMessageWindow(db, C1, 0, 10).map((m) => [m.body, m.hasNote])).toEqual([
      ['synthetic 8', false],
      ['synthetic 2', false],
      ['synthetic 1', true],
    ]);
    expect(countNotes(db)).toBe(1);
  });

  test('undoing the batch that added the message leaves the note dormant; importing again revives it', () => {
    const extra = load(C1, [msg(8, '2025-12-01T10:00:00')]);
    write(onMessage(C1, 8), 'dormant soon');
    write(onConversation(C1), 'stays');
    undoImportBatch(db, extra);
    expect(bodies()).toEqual(['stays']);
    expect(countNotes(db)).toBe(1);
    expect(countNotes(db, { conversationId: C1 })).toBe(1);
    expect(db.all('SELECT body FROM notes WHERE kind = ?', ['message'])).toEqual([{ body: 'dormant soon' }]);
    load(C1, [msg(8, '2025-12-01T10:00:00')]);
    expect(bodies()).toEqual(["stays", "dormant soon"]);
    expect(getMessageWindow(db, C1, 0, 1)[0].hasNote).toBe(true);
  });

  test('undoing the import that created the conversation removes it, and its notes with it; a profile note stays', () => {
    const only = uuid(50);
    const batchId = importMessages(db, {
      batchId: uuid(150),
      conversationId: only,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: T(1),
      blobs: [],
      messages: [msg(20, '2026-03-01T10:00:00')],
      newConversation: { title: 'New', sourceKey: 'new', isGroup: false, profileIds: [ANA] },
    }).batchId;
    write(onMessage(only, 20), 'm');
    write(onConversation(only), 'c');
    write(onProfile(ANA), 'p');
    expect(undoImportBatch(db, batchId)).toMatchObject({ removedConversation: true });
    expect(db.all('SELECT kind FROM notes')).toEqual([{ kind: 'profile' }]);
  });
});
