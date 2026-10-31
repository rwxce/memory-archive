import { describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import {
  createConversation,
  createProfile,
  importMessages,
  linkConversationProfile,
  moveConversation,
  renameConversation,
  setFavorite,
  setNote,
  setProfileArchived,
  setProfilePhoto,
  undoImportBatch,
  unlinkConversationProfile,
  updateProfile,
} from './queries';
import { BASELINE_SEQ, currentChangeSeq, getDeviceId, getPeer, listPeers, nextChangeSeq, recordReceived, recordSent, stampRows } from './sync';
import type { SqlDb } from './sql';

const NOW = '2026-02-01T12:00:00Z';
const LATER = '2026-03-01T12:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [ANA, BEN, CONV, BATCH, PEER, PEER2] = [uuid(1), uuid(2), uuid(10), uuid(100), uuid(900), uuid(901)];
const FP = 'ab'.repeat(32);

const seqs = (db: SqlDb, table: string) => db.all<{ seq: number }>(`SELECT seq FROM ${table} ORDER BY rowid`).map((r) => r.seq);

async function library() {
  const { db } = await openMemoryDb();
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BEN, displayName: 'Ben', now: NOW });
  importMessages(db, {
    batchId: BATCH, conversationId: CONV, source: 'whatsapp', sourceLabel: 'a.zip', now: NOW, blobs: [],
    messages: [{ fingerprint: FP, sentAt: '2026-01-01T10:00:00', ordinal: 0, type: 'text', participantName: 'Ana', body: 'synthetic', mediaSha256: null, mediaName: '' }],
    newConversation: { title: 'Chat', sourceKey: 'chat', isGroup: false, profileIds: [ANA] },
  });
  const [{ id }] = db.all<{ id: number }>('SELECT id FROM messages');
  return { db, messageId: id };
}

describe('device identity and the change counter', () => {
  test('the device row exists after the migration; the id is well formed and stable', async () => {
    const { db } = await openMemoryDb();
    expect(db.all('SELECT * FROM device')).toHaveLength(1);
    const id = getDeviceId(db);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getDeviceId(db)).toBe(id);
    expect(db.all('SELECT * FROM device')).toHaveLength(1);
  });

  test('two libraries get different ids', async () => {
    expect(getDeviceId((await openMemoryDb()).db)).not.toBe(getDeviceId((await openMemoryDb()).db));
  });

  test('the counter starts at the baseline and every stamp is strictly higher', async () => {
    const { db } = await openMemoryDb();
    expect(currentChangeSeq(db)).toBe(BASELINE_SEQ);
    const a = nextChangeSeq(db);
    const b = nextChangeSeq(db);
    expect(a).toBe(BASELINE_SEQ + 1);
    expect(b).toBe(a + 1);
    expect(currentChangeSeq(db)).toBe(b);
  });
});

describe('every write to a synced record is stamped above what was already exported', () => {
  test('profiles: create, update, photo, archive; a no-op archive does not stamp', async () => {
    const { db } = await openMemoryDb();
    createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
    const created = seqs(db, 'profiles')[0];
    expect(created).toBeGreaterThan(BASELINE_SEQ);
    updateProfile(db, { id: ANA, displayName: 'Anna', now: LATER });
    const updated = seqs(db, 'profiles')[0];
    expect(updated).toBeGreaterThan(created);
    setProfilePhoto(db, { id: ANA, photo: { sha256: FP, size: 3, mime: 'image/png' }, now: LATER });
    const photo = seqs(db, 'profiles')[0];
    expect(photo).toBeGreaterThan(updated);
    setProfileArchived(db, { id: ANA, archived: true, now: LATER });
    const archived = seqs(db, 'profiles')[0];
    expect(archived).toBeGreaterThan(photo);
    setProfileArchived(db, { id: ANA, archived: true, now: LATER });
    expect(seqs(db, 'profiles')[0]).toBe(archived);
    updateProfile(db, { id: ANA, now: LATER });
    expect(seqs(db, 'profiles')[0]).toBe(archived);
  });

  test('a local edit clears changed_by (the version is ours again)', async () => {
    const { db } = await library();
    db.run('UPDATE profiles SET changed_by = ? WHERE id = ?', [PEER, ANA]);
    db.run('UPDATE conversations SET changed_by = ?', [PEER]);
    updateProfile(db, { id: ANA, description: 'edited', now: LATER });
    renameConversation(db, { conversationId: CONV, title: 'Renamed' });
    expect(db.all('SELECT changed_by FROM profiles WHERE id = ?', [ANA])).toEqual([{ changed_by: null }]);
    expect(db.all('SELECT changed_by FROM conversations')).toEqual([{ changed_by: null }]);
  });

  test('conversations: create with an import, rename, link, unlink, move; no-ops do not stamp', async () => {
    const { db } = await library();
    const read = () => seqs(db, 'conversations')[0];
    const created = read();
    expect(created).toBeGreaterThan(BASELINE_SEQ);
    expect(seqs(db, 'import_batches')[0]).toBeGreaterThan(BASELINE_SEQ);
    renameConversation(db, { conversationId: CONV, title: 'Chat' });
    expect(read()).toBe(created);
    renameConversation(db, { conversationId: CONV, title: 'Other' });
    const renamed = read();
    expect(renamed).toBeGreaterThan(created);
    linkConversationProfile(db, { conversationId: CONV, profileId: ANA });
    expect(read()).toBe(renamed);
    linkConversationProfile(db, { conversationId: CONV, profileId: BEN });
    const linked = read();
    expect(linked).toBeGreaterThan(renamed);
    unlinkConversationProfile(db, { conversationId: CONV, profileId: BEN });
    const unlinked = read();
    expect(unlinked).toBeGreaterThan(linked);
    unlinkConversationProfile(db, { conversationId: CONV, profileId: BEN });
    expect(read()).toBe(unlinked);
    moveConversation(db, { conversationId: CONV, fromProfileId: ANA, toProfileId: BEN });
    expect(read()).toBeGreaterThan(unlinked);
  });

  test('createConversation stamps the conversation; "me" stamps it only when it changes', async () => {
    const { db } = await openMemoryDb();
    createConversation(db, { id: CONV, title: 'Chat', source: 'whatsapp', isGroup: false, profileIds: [], participants: [], now: NOW });
    expect(seqs(db, 'conversations')[0]).toBeGreaterThan(BASELINE_SEQ);
    const batch = (n: number, meAuthor: string) =>
      importMessages(db, { batchId: uuid(200 + n), conversationId: CONV, source: 'whatsapp', sourceLabel: 'x', now: NOW, blobs: [], messages: [], meAuthor });
    batch(1, 'Ana');
    const first = seqs(db, 'conversations')[0];
    batch(2, 'Ana');
    expect(seqs(db, 'conversations')[0]).toBe(first);
    batch(3, 'Ben');
    expect(seqs(db, 'conversations')[0]).toBeGreaterThan(first);
  });

  test('favorites: add stamps, repeating does not, remove leaves a tombstone, adding again clears it', async () => {
    const { db, messageId } = await library();
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: NOW });
    const added = seqs(db, 'favorites')[0];
    expect(added).toBeGreaterThan(BASELINE_SEQ);
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: LATER });
    expect(seqs(db, 'favorites')).toEqual([added]);
    setFavorite(db, { conversationId: CONV, messageId, favorite: false, now: LATER });
    const [tomb] = db.all<{ kind: string; scope: string; key: string; deleted_at: string; seq: number }>('SELECT * FROM tombstones');
    expect(tomb).toMatchObject({ kind: 'favorite', scope: CONV, key: FP, deleted_at: LATER });
    expect(tomb.seq).toBeGreaterThan(added);
    setFavorite(db, { conversationId: CONV, messageId, favorite: false, now: LATER });
    expect(db.all('SELECT * FROM tombstones')).toHaveLength(1);
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: LATER });
    expect(db.all('SELECT * FROM tombstones')).toEqual([]);
    expect(seqs(db, 'favorites')[0]).toBeGreaterThan(tomb.seq);
  });

  test('notes: create and edit stamp, the same text does not, an empty text leaves a tombstone, saving again clears it', async () => {
    const { db, messageId } = await library();
    const targets = [
      { target: { kind: 'profile', profileId: ANA } as const, scope: '', key: `profile:${ANA}` },
      { target: { kind: 'conversation', conversationId: CONV } as const, scope: CONV, key: 'conversation' },
      { target: { kind: 'message', conversationId: CONV, messageId } as const, scope: CONV, key: `message:${FP}` },
    ];
    for (const { target, scope, key } of targets) {
      db.run('DELETE FROM notes');
      db.run('DELETE FROM tombstones');
      setNote(db, { target, body: 'one', now: NOW });
      const created = seqs(db, 'notes')[0];
      expect(created).toBeGreaterThan(BASELINE_SEQ);
      setNote(db, { target, body: 'one', now: LATER });
      expect(seqs(db, 'notes')).toEqual([created]);
      setNote(db, { target, body: 'two', now: LATER });
      const edited = seqs(db, 'notes')[0];
      expect(edited).toBeGreaterThan(created);
      setNote(db, { target, body: '  ', now: LATER });
      expect(db.all('SELECT kind, scope, key, deleted_at FROM tombstones')).toEqual([{ kind: 'note', scope, key, deleted_at: LATER }]);
      setNote(db, { target, body: '', now: LATER });
      expect(db.all('SELECT * FROM tombstones')).toHaveLength(1);
      setNote(db, { target, body: 'three', now: LATER });
      expect(db.all('SELECT * FROM tombstones')).toEqual([]);
      expect(seqs(db, 'notes')[0]).toBeGreaterThan(edited);
    }
  });

  test('undoing an import leaves a tombstone of the batch; a second undo adds nothing', async () => {
    const { db } = await library();
    const before = currentChangeSeq(db);
    expect(undoImportBatch(db, BATCH).found).toBe(true);
    const tombs = db.all<{ kind: string; scope: string; key: string; seq: number }>('SELECT kind, scope, key, seq FROM tombstones');
    expect(tombs).toEqual([{ kind: 'batch', scope: CONV, key: BATCH, seq: before + 1 }]);
    expect(undoImportBatch(db, BATCH).found).toBe(false);
    expect(db.all('SELECT kind, scope, key, seq FROM tombstones')).toEqual(tombs);
  });

  test('undoing the last batch of a conversation leaves tombstones for its favorites, notes and other batches', async () => {
    const { db, messageId } = await library();
    const OTHER = uuid(101);
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at, added_count) VALUES (?, ?, ?, ?, 0)', [OTHER, CONV, 'whatsapp', NOW]);
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: NOW });
    setNote(db, { target: { kind: 'conversation', conversationId: CONV }, body: 'about the chat', now: NOW });
    setNote(db, { target: { kind: 'message', conversationId: CONV, messageId }, body: 'about a message', now: NOW });
    setNote(db, { target: { kind: 'profile', profileId: ANA }, body: 'about Ana', now: NOW });
    const before = currentChangeSeq(db);
    expect(undoImportBatch(db, BATCH)).toMatchObject({ found: true, removedConversation: true });
    expect(db.all('SELECT * FROM conversations')).toEqual([]);
    const tombs = db.all<{ kind: string; scope: string; key: string; seq: number; changed_by: string | null }>(
      'SELECT kind, scope, key, seq, changed_by FROM tombstones ORDER BY kind, key',
    );
    expect(tombs.map(({ kind, scope, key }) => ({ kind, scope, key }))).toEqual([
      { kind: 'batch', scope: CONV, key: BATCH },
      { kind: 'batch', scope: CONV, key: OTHER },
      { kind: 'favorite', scope: CONV, key: FP },
      { kind: 'note', scope: CONV, key: 'conversation' },
      { kind: 'note', scope: CONV, key: `message:${FP}` },
    ]);
    // all made here, all above anything already sent; the profile note (not part of the conversation) stays
    expect(tombs.every((t) => t.changed_by === null && t.seq > before)).toBe(true);
    expect(db.all('SELECT kind FROM notes')).toEqual([{ kind: 'profile' }]);
  });

  test('undoing a batch that leaves the conversation alive writes only the batch tombstone', async () => {
    const { db, messageId } = await library();
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: NOW });
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at, added_count) VALUES (?, ?, ?, ?, 0)', [uuid(101), CONV, 'whatsapp', NOW]);
    undoImportBatch(db, uuid(101));
    expect(db.all('SELECT kind, key FROM tombstones')).toEqual([{ kind: 'batch', key: uuid(101) }]);
    expect(db.all('SELECT * FROM favorites')).toHaveLength(1);
  });

  test('changed_by on favorites and tombstones: a local write resets it to NULL, an unchanged favorite keeps the peer', async () => {
    const { db, messageId } = await library();
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: NOW });
    expect(db.all('SELECT changed_by FROM favorites')).toEqual([{ changed_by: null }]);
    db.run('UPDATE favorites SET changed_by = ?', [PEER]);
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: LATER }); // no change here
    expect(db.all('SELECT changed_by FROM favorites')).toEqual([{ changed_by: PEER }]);
    stampRows(db, 'favorites', 'conversation_id = ?', [CONV]);
    expect(db.all('SELECT changed_by FROM favorites')).toEqual([{ changed_by: null }]);
    db.run('UPDATE favorites SET changed_by = ?', [PEER]);
    setFavorite(db, { conversationId: CONV, messageId, favorite: false, now: LATER });
    expect(db.all('SELECT changed_by FROM tombstones')).toEqual([{ changed_by: null }]);
    // a tombstone that came from a peer is replaced by the local deletion, which is ours
    db.run('UPDATE tombstones SET changed_by = ?', [PEER]);
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: LATER });
    setFavorite(db, { conversationId: CONV, messageId, favorite: false, now: LATER });
    expect(db.all('SELECT changed_by FROM tombstones')).toEqual([{ changed_by: null }]);
    setFavorite(db, { conversationId: CONV, messageId, favorite: true, now: LATER });
    expect(db.all('SELECT changed_by FROM favorites')).toEqual([{ changed_by: null }]);
  });

  test('a failed write stamps nothing (the counter is part of the transaction)', async () => {
    const { db } = await library();
    const before = currentChangeSeq(db);
    expect(() => createProfile(db, { id: ANA, displayName: 'Duplicate', now: NOW })).toThrow();
    expect(currentChangeSeq(db)).toBe(before);
  });
});

describe('peer watermarks', () => {
  test('a peer is unknown until something is exchanged', async () => {
    const { db } = await openMemoryDb();
    expect(listPeers(db)).toEqual([]);
    expect(getPeer(db, PEER)).toBeNull();
  });

  test('recordSent moves the sent watermark forward only, and never beyond the counter', async () => {
    const { db } = await library();
    const top = currentChangeSeq(db);
    expect(recordSent(db, { peerId: PEER, upToSeq: top, now: NOW })).toEqual({
      peerId: PEER, lastSentSeq: top, lastSentAt: NOW, lastReceivedSeq: 0, lastReceivedAt: null,
    });
    expect(recordSent(db, { peerId: PEER, upToSeq: 2, now: LATER })).toMatchObject({ lastSentSeq: top, lastSentAt: LATER });
    expect(() => recordSent(db, { peerId: PEER, upToSeq: top + 1, now: NOW })).toThrow(/beyond/);
    expect(() => recordSent(db, { peerId: 'nope', upToSeq: 1, now: NOW })).toThrow(/UUID/);
    expect(() => recordSent(db, { peerId: PEER, upToSeq: -1, now: NOW })).toThrow(/non-negative/);
    expect(() => recordSent(db, { peerId: PEER, upToSeq: 1.5, now: NOW })).toThrow(/non-negative/);
  });

  test('recordReceived moves the received watermark forward only; the peer ack replaces the sent watermark', async () => {
    const { db } = await library();
    nextChangeSeq(db);
    const top = currentChangeSeq(db);
    recordSent(db, { peerId: PEER, upToSeq: top, now: NOW });
    expect(recordReceived(db, { peerId: PEER, upToSeq: 40, ackedSeq: null, now: NOW })).toMatchObject({ lastReceivedSeq: 40, lastSentSeq: top });
    expect(recordReceived(db, { peerId: PEER, upToSeq: 10, ackedSeq: null, now: LATER })).toMatchObject({ lastReceivedSeq: 40, lastReceivedAt: LATER });
    // the peer never got our last pack: its ack moves our watermark back, so it is sent again
    expect(recordReceived(db, { peerId: PEER, upToSeq: 50, ackedSeq: 2, now: LATER })).toMatchObject({ lastReceivedSeq: 50, lastSentSeq: 2 });
    // an ack above our counter cannot happen from a real peer; it is clamped, not trusted
    expect(recordReceived(db, { peerId: PEER, upToSeq: 50, ackedSeq: 10_000, now: LATER }).lastSentSeq).toBe(top);
    expect(() => recordReceived(db, { peerId: PEER, upToSeq: -1, ackedSeq: null, now: NOW })).toThrow(/non-negative/);
    expect(() => recordReceived(db, { peerId: PEER, upToSeq: 1, ackedSeq: -1, now: NOW })).toThrow(/non-negative/);
  });

  test('a device is not its own peer; peers are independent and listed most recent first', async () => {
    const { db } = await openMemoryDb();
    expect(() => recordSent(db, { peerId: getDeviceId(db), upToSeq: 1, now: NOW })).toThrow(/own sync peer/);
    recordReceived(db, { peerId: PEER, upToSeq: 5, ackedSeq: null, now: NOW });
    recordReceived(db, { peerId: PEER2, upToSeq: 7, ackedSeq: null, now: LATER });
    expect(listPeers(db).map((p) => [p.peerId, p.lastReceivedSeq])).toEqual([[PEER2, 7], [PEER, 5]]);
    expect(getPeer(db, PEER)).toMatchObject({ lastReceivedSeq: 5, lastSentSeq: 0 });
  });
});
