import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  createConversation,
  createProfile,
  importMessages,
  listConversations,
  listMessages,
  listParticipants,
  listProfiles,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const NOW = '2026-02-01T12:00:00Z';
const PHOTO = 'cd'.repeat(32);

function msg(n: number, over: Partial<NewMessage> = {}): NewMessage {
  return {
    fingerprint: fp(n),
    sentAt: `2026-01-01T10:${String(n % 60).padStart(2, '0')}:00`,
    ordinal: 0,
    type: 'text',
    participantName: 'Ana',
    body: `synthetic message ${n}`,
    mediaSha256: null,
    mediaName: '',
    ...over,
  };
}

let db: SqlDb;
beforeEach(async () => {
  db = (await openMemoryDb()).db;
  createProfile(db, { id: uuid(1), displayName: 'Ana', now: NOW });
  createConversation(db, {
    id: uuid(10),
    title: 'Chat with Ana',
    source: 'whatsapp',
    isGroup: false,
    profileIds: [uuid(1)],
    participants: [],
    now: NOW,
  });
});

const importInput = (messages: NewMessage[], batch = 100, blobs: { sha256: string; size: number; mime: string | null }[] = []) => ({
  batchId: uuid(batch),
  conversationId: uuid(10),
  source: 'whatsapp',
  sourceLabel: 'WhatsApp Chat - Ana.zip',
  now: NOW,
  blobs,
  messages,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return toDbError(e).code;
  }
  return undefined;
};

describe('profiles', () => {
  test('are created with a UUID and listed in creation order', () => {
    createProfile(db, { id: uuid(2), displayName: 'Bo', now: '2026-03-01T00:00:00Z' });
    expect(listProfiles(db).map((p) => [p.id, p.displayName, p.archivedAt])).toEqual([
      [uuid(1), 'Ana', null],
      [uuid(2), 'Bo', null],
    ]);
  });

  test('reject malformed ids, blank names and duplicates', () => {
    expect(codeOf(() => createProfile(db, { id: 'not-a-uuid', displayName: 'X', now: NOW }))).toBe('invalid');
    expect(codeOf(() => createProfile(db, { id: uuid(3), displayName: '  ', now: NOW }))).toBe('invalid');
    expect(codeOf(() => createProfile(db, { id: uuid(1), displayName: 'Dup', now: NOW }))).toBe('constraint');
  });

  test('the database CHECK still rejects a blank name written around the validation', () => {
    const insert = (name: string) =>
      db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [uuid(7), name, NOW, NOW]);
    expect(() => insert('')).toThrow(/CHECK/);
    expect(() => insert('   ')).toThrow(/CHECK/);
    expect(() => db.run('UPDATE profiles SET display_name = ? WHERE id = ?', ['  ', uuid(1)])).toThrow(/CHECK/);
    expect(listProfiles(db).map((p) => p.displayName)).toEqual(['Ana']);
  });

  test('two profiles may share a display name (identity is the UUID)', () => {
    createProfile(db, { id: uuid(2), displayName: 'Ana', now: NOW });
    expect(listProfiles(db)).toHaveLength(2);
  });
});

describe('conversations', () => {
  test('link to several profiles and filter by profile', () => {
    createProfile(db, { id: uuid(2), displayName: 'Bo', now: NOW });
    createConversation(db, {
      id: uuid(11),
      title: 'Family group',
      source: 'whatsapp',
      isGroup: true,
      profileIds: [uuid(1), uuid(2)],
      participants: [
        { displayName: 'Ana', profileId: uuid(1) },
        { displayName: 'Bo', profileId: uuid(2) },
        { displayName: 'Unknown cousin', profileId: null },
      ],
      now: NOW,
    });
    expect(listConversations(db, { profileId: uuid(2) }).map((c) => c.id)).toEqual([uuid(11)]);
    const all = listConversations(db);
    expect(all.map((c) => [c.id, c.profileIds, c.isGroup])).toEqual([
      [uuid(10), [uuid(1)], false],
      [uuid(11), [uuid(1), uuid(2)], true],
    ]);
    expect(listParticipants(db, uuid(11))).toEqual([
      { displayName: 'Ana', profileId: uuid(1) },
      { displayName: 'Bo', profileId: uuid(2) },
      { displayName: 'Unknown cousin', profileId: null },
    ]);
  });

  test('may exist with no profile yet', () => {
    createConversation(db, { id: uuid(12), title: 'Unassigned', source: 'whatsapp', isGroup: true, profileIds: [], participants: [], now: NOW });
    expect(listConversations(db).find((c) => c.id === uuid(12))?.profileIds).toEqual([]);
  });

  test('creation is atomic: an unknown profile leaves nothing behind', () => {
    expect(
      codeOf(() =>
        createConversation(db, {
          id: uuid(13),
          title: 'Broken',
          source: 'whatsapp',
          isGroup: false,
          profileIds: [uuid(1), uuid(99)],
          participants: [{ displayName: 'Ana', profileId: null }],
          now: NOW,
        }),
      ),
    ).toBe('constraint');
    expect(listConversations(db).map((c) => c.id)).toEqual([uuid(10)]);
    expect(db.all('SELECT * FROM participants')).toHaveLength(0);
  });

  test('summaries report message counts and date range', () => {
    importMessages(db, importInput([msg(5), msg(7), msg(6)]));
    const [c] = listConversations(db);
    expect([c.messageCount, c.firstMessageAt, c.lastMessageAt]).toEqual([3, '2026-01-01T10:05:00', '2026-01-01T10:07:00']);
  });
});

describe('importMessages', () => {
  test('stores messages in chronological order with their authors', () => {
    const result = importMessages(db, importInput([msg(2), msg(1, { participantName: 'Me' }), msg(3, { participantName: null, type: 'system' })]));
    expect(result).toEqual({ batchId: uuid(100), added: 3, skipped: 0 });
    expect(listMessages(db, uuid(10)).map((m) => [m.body, m.participantName, m.type])).toEqual([
      ['synthetic message 1', 'Me', 'text'],
      ['synthetic message 2', 'Ana', 'text'],
      ['synthetic message 3', null, 'system'],
    ]);
    expect(listParticipants(db, uuid(10)).map((p) => p.displayName).sort()).toEqual(['Ana', 'Me']);
  });

  test('re-importing the same export adds nothing', () => {
    const export1 = [msg(1), msg(2), msg(3)];
    importMessages(db, importInput(export1, 100));
    const again = importMessages(db, importInput(export1, 101));
    expect(again).toEqual({ batchId: uuid(101), added: 0, skipped: 3 });
    expect(listMessages(db, uuid(10))).toHaveLength(3);
    expect(db.all<{ added_count: number; skipped_count: number }>('SELECT added_count, skipped_count FROM import_batches ORDER BY created_at, id')).toEqual([
      { added_count: 3, skipped_count: 0 },
      { added_count: 0, skipped_count: 3 },
    ]);
  });

  test('an overlapping newer export adds only the new tail', () => {
    importMessages(db, importInput([msg(1), msg(2), msg(3)], 100));
    const next = importMessages(db, importInput([msg(2), msg(3), msg(4), msg(5)], 101));
    expect([next.added, next.skipped]).toEqual([2, 2]);
    expect(listMessages(db, uuid(10)).map((m) => m.body.slice(-1))).toEqual(['1', '2', '3', '4', '5']);
  });

  test('equal fingerprints inside one export are stored once (the importer must make genuine repeats distinct)', () => {
    expect(importMessages(db, importInput([msg(1), msg(1)])).added).toBe(1);
  });

  test('the same fingerprint may exist in two conversations', () => {
    createConversation(db, { id: uuid(11), title: 'Other', source: 'whatsapp', isGroup: false, profileIds: [], participants: [], now: NOW });
    importMessages(db, importInput([msg(1)], 100));
    const other = importMessages(db, { ...importInput([msg(1)], 101), conversationId: uuid(11) });
    expect(other.added).toBe(1);
  });

  test('media is stored once by hash and shared by messages', () => {
    const blob = { sha256: PHOTO, size: 3, mime: 'image/jpeg' };
    importMessages(db, importInput([msg(1, { type: 'photo', mediaSha256: PHOTO, mediaName: 'IMG-1.jpg' })], 100, [blob]));
    importMessages(db, importInput([msg(2, { type: 'photo', mediaSha256: PHOTO, mediaName: 'IMG-2.jpg' })], 101, [blob]));
    expect(db.all('SELECT * FROM blobs')).toHaveLength(1);
    expect(listMessages(db, uuid(10)).map((m) => m.mediaSha256)).toEqual([PHOTO, PHOTO]);
  });

  test('is atomic: a failure stores nothing, not even the batch', () => {
    const bad = msg(3, { type: 'photo', mediaSha256: PHOTO });
    expect(codeOf(() => importMessages(db, importInput([msg(1), msg(2), bad], 100)))).toBe('constraint');
    expect(db.all('SELECT * FROM messages')).toHaveLength(0);
    expect(db.all('SELECT * FROM import_batches')).toHaveLength(0);
    expect(db.all('SELECT * FROM participants')).toHaveLength(0);
    expect(db.all('SELECT * FROM blobs')).toHaveLength(0);
    // The archive is usable afterwards and the same batch id can be retried.
    expect(importMessages(db, importInput([msg(1), msg(2)], 100)).added).toBe(2);
  });

  test('an unknown conversation is rejected', () => {
    expect(codeOf(() => importMessages(db, { ...importInput([msg(1)]), conversationId: uuid(99) }))).toBe('constraint');
    expect(db.all('SELECT * FROM import_batches')).toHaveLength(0);
  });

  test('malformed messages are rejected before anything is written', () => {
    const cases: NewMessage[] = [
      msg(1, { fingerprint: 'abc' }),
      msg(1, { sentAt: '01/02/2026 10:00' }),
      msg(1, { type: 'gif' as NewMessage['type'] }),
      msg(1, { ordinal: -1 }),
      msg(1, { mediaSha256: 'zz' }),
    ];
    for (const bad of cases) expect(codeOf(() => importMessages(db, importInput([msg(2), bad])))).toBe('invalid');
    expect(codeOf(() => importMessages(db, { ...importInput([]), batchId: 'x' }))).toBe('invalid');
    expect(codeOf(() => importMessages(db, importInput([], 100, [{ sha256: 'x', size: 1, mime: null }])))).toBe('invalid');
    expect(db.all('SELECT * FROM import_batches')).toHaveLength(0);
  });

  test('hostile text is stored verbatim and never interpreted as SQL', () => {
    const body = "'); DROP TABLE messages; --";
    importMessages(db, importInput([msg(1, { body, participantName: "Robert'); DROP TABLE profiles;--" })]));
    expect(listMessages(db, uuid(10))[0].body).toBe(body);
    expect(listProfiles(db)).toHaveLength(1);
  });
});

describe('listMessages', () => {
  test('orders messages of the same minute by ordinal', () => {
    importMessages(db, importInput([msg(1, { sentAt: '2026-01-01T10:00:00', ordinal: 1 }), msg(2, { sentAt: '2026-01-01T10:00:00', ordinal: 0 })]));
    expect(listMessages(db, uuid(10)).map((m) => m.ordinal)).toEqual([0, 1]);
  });

  test('keyset pagination walks the whole conversation without repeats', () => {
    importMessages(db, importInput(Array.from({ length: 25 }, (_, i) => msg(i + 1))));
    const seen: number[] = [];
    let after: { sentAt: string; ordinal: number; id: number } | undefined;
    for (;;) {
      const page = listMessages(db, uuid(10), { after, limit: 10 });
      if (page.length === 0) break;
      seen.push(...page.map((m) => m.id));
      const last = page[page.length - 1];
      after = { sentAt: last.sentAt, ordinal: last.ordinal, id: last.id };
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  test('clamps the page size', () => {
    importMessages(db, importInput([msg(1), msg(2)]));
    expect(listMessages(db, uuid(10), { limit: 0 })).toHaveLength(1);
    expect(listMessages(db, uuid(10), { limit: 1_000_000 })).toHaveLength(2);
  });

  test('returns nothing for a conversation without messages', () => {
    expect(listMessages(db, uuid(10))).toEqual([]);
    expect(codeOf(() => listMessages(db, 'nope'))).toBe('invalid');
  });
});
