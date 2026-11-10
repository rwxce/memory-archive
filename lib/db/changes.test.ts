import { describe, expect, test } from 'vitest';
import { MAX_BATCH_PAGE, readBatchMessages, readChangeSet, readPhotoBatchItems } from './changes';
import { assignPhotos } from './photo-assign';
import { importPhotoItems } from './photos';
import { openMemoryDb } from './open';
import { createProfile, importMessages, linkConversationProfile, setProfilePhoto, updateProfile } from './queries';
import { currentChangeSeq, getDeviceId, recordReceived, recordSent } from './sync';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const [ANA, BEN, CAL, C1, B1, B2, PEER, B3] = [1, 2, 3, 10, 100, 101, 900, 102].map(uuid);
const NOW = '2026-02-01T12:00:00Z';
const PHOTO = 'ab'.repeat(32);
const MEDIA = 'cd'.repeat(32);

const message = (n: number, mediaSha256: string | null = null) => ({
  fingerprint: fp(n), sentAt: '2026-01-01T10:00:00', ordinal: n, type: 'text' as const, participantName: 'Ana', body: `m${n}`, mediaSha256, mediaName: '',
});

async function library() {
  const { db } = await openMemoryDb();
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BEN, displayName: 'Ben', now: NOW });
  createProfile(db, { id: CAL, displayName: 'Cal', now: NOW });
  db.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 3, ?)', [PHOTO, 'image/png']);
  setProfilePhoto(db, { id: BEN, photo: { sha256: PHOTO, size: 3, mime: 'image/png' }, now: NOW });
  importMessages(db, {
    batchId: B1, conversationId: C1, source: 'whatsapp', sourceLabel: 'a', now: NOW, blobs: [], messages: [message(1), message(2), message(3)],
    newConversation: { title: 'One', sourceKey: 'one', isGroup: false, profileIds: [ANA, BEN] },
  });
  return db;
}

describe('readChangeSet', () => {
  test('reads the counter in the same step as the records, and writes nothing', async () => {
    const db = await library();
    const before = db.serialize!();
    const set = readChangeSet(db, { peerId: null });
    expect(set.upTo).toBe(currentChangeSeq(db));
    expect(set).toMatchObject({ kind: 'full', since: 0, ack: null, targetDeviceId: null, sourceDeviceId: getDeviceId(db) });
    expect(db.serialize!()).toEqual(before);
  });

  test('closure: only the profiles a carried conversation names, and only the blobs their photos and messages need', async () => {
    const db = await library();
    recordSent(db, { peerId: PEER, upToSeq: currentChangeSeq(db), now: NOW });
    // A later batch into a conversation made before; the conversation itself did not change.
    db.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 3, NULL)', [MEDIA]);
    importMessages(db, { batchId: B2, conversationId: C1, source: 'whatsapp', sourceLabel: 'b', now: NOW, blobs: [{ sha256: MEDIA, size: 3, mime: null }], messages: [message(4, MEDIA)] });
    const set = readChangeSet(db, { peerId: PEER });
    expect(set).toMatchObject({ kind: 'changes', targetDeviceId: PEER });
    expect(set.batches.map((b) => b.id)).toEqual([B2]);
    expect(set.conversations.map((c) => c.id)).toEqual([C1]);
    expect(set.profiles.map((p) => p.id)).toEqual([ANA, BEN]); // Cal is unrelated and unchanged
    expect(set.blobs.map((b) => b.sha256).sort()).toEqual([MEDIA, PHOTO].sort()); // Ben's photo comes with Ben
  });

  test('an unchanged library since the watermark yields nothing', async () => {
    const db = await library();
    recordSent(db, { peerId: PEER, upToSeq: currentChangeSeq(db), now: NOW });
    const set = readChangeSet(db, { peerId: PEER });
    expect([set.profiles, set.conversations, set.blobs, set.favorites, set.notes, set.tombstones, set.batches].map((r) => r.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(set.since).toBe(set.upTo);
  });

  test('a changed profile carries its photo; a link change carries the conversation and its profiles', async () => {
    const db = await library();
    recordSent(db, { peerId: PEER, upToSeq: currentChangeSeq(db), now: NOW });
    updateProfile(db, { id: BEN, description: 'edited', now: NOW });
    linkConversationProfile(db, { conversationId: C1, profileId: CAL });
    const set = readChangeSet(db, { peerId: PEER });
    expect(set.profiles.map((p) => p.id)).toEqual([ANA, BEN, CAL]);
    expect(set.conversations[0].profileIds).toEqual([ANA, BEN, CAL]);
    expect(set.blobs.map((b) => b.sha256)).toEqual([PHOTO]);
    expect(set.batches).toEqual([]);
  });

  test('ack is the peer\'s received watermark, only for a changes pack; full never carries one', async () => {
    const db = await library();
    recordReceived(db, { peerId: PEER, upToSeq: 7, ackedSeq: null, now: NOW });
    expect(readChangeSet(db, { peerId: PEER }).ack).toBe(7);
    expect(readChangeSet(db, { peerId: PEER, full: true })).toMatchObject({ kind: 'full', ack: null, targetDeviceId: null, since: 0 });
  });

  test('refuses a malformed peer id, a non-boolean full, and this device as the peer', async () => {
    const db = await library();
    expect(() => readChangeSet(db, { peerId: 'nope' })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => readChangeSet(db, { peerId: null, full: 'yes' as never })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => readChangeSet(db, { peerId: getDeviceId(db) })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});

describe('readChangeSet and the photo collection', () => {
  const PB = uuid(300);
  const shaOf = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
  const item = (n: number, album = 'Trip') => ({
    sha256: shaOf(n), kind: 'photo' as const, mime: 'image/jpeg', takenAt: '2019-07-01T10:00:00Z', takenOffsetMinutes: null, dateSource: 'sidecar' as const,
    latitude: null, longitude: null, description: `d${n}`, album, fileName: `${n}.jpg`,
  });
  const addPhotos = (db: Awaited<ReturnType<typeof library>>, ns: number[], batchId = PB) =>
    importPhotoItems(db, { batchId, source: 'takeout', sourceLabel: 'f.zip', now: NOW, blobs: ns.map((n) => ({ sha256: shaOf(n), size: 1, mime: null })), items: ns.map((n) => item(n)) });

  test('a photo batch travels with the bytes of its items; its header carries the source numbers', async () => {
    const db = await library();
    recordSent(db, { peerId: PEER, upToSeq: currentChangeSeq(db), now: NOW });
    addPhotos(db, [1, 2]);
    const set = readChangeSet(db, { peerId: PEER });
    expect(set.photoBatches).toEqual([{ id: PB, source: 'takeout', sourceLabel: 'f.zip', createdAt: NOW, addedCount: 2, skippedCount: 0, seq: currentChangeSeq(db) }]);
    expect(set.blobs.map((b) => b.sha256)).toEqual([shaOf(1), shaOf(2)]);
    expect(set.photoLinks).toEqual([]);
    expect(set.conversations).toEqual([]);
  });

  test('a link travels with its profile (changed or not) but not with the bytes or items of an older batch', async () => {
    const db = await library();
    addPhotos(db, [1]);
    recordSent(db, { peerId: PEER, upToSeq: currentChangeSeq(db), now: NOW });
    assignPhotos(db, { sha256s: [shaOf(1)], profileIds: [CAL], now: NOW });
    const set = readChangeSet(db, { peerId: PEER });
    expect(set.photoLinks).toMatchObject([{ sha256: shaOf(1), profileId: CAL, createdAt: NOW }]);
    expect(set.profiles.map((p) => p.id)).toEqual([CAL]);
    expect(set.photoBatches).toEqual([]);
    expect(set.blobs).toEqual([]);
  });

  test('a full pack carries every batch, link and item blob, whatever the peer already has; what came from the peer is not echoed', async () => {
    const db = await library();
    addPhotos(db, [1, 2]);
    assignPhotos(db, { sha256s: [shaOf(1)], profileIds: [ANA], now: NOW });
    expect(readChangeSet(db, { peerId: null })).toMatchObject({ kind: 'full', photoBatches: [{ id: PB }], photoLinks: [{ profileId: ANA }] });
    db.run('UPDATE photo_batches SET changed_by = ?', [PEER]);
    db.run('UPDATE photo_profiles SET changed_by = ?', [PEER]);
    const toPeer = readChangeSet(db, { peerId: PEER });
    expect([toPeer.photoBatches, toPeer.photoLinks, toPeer.blobs.filter((b) => b.sha256 === shaOf(1))].map((r) => r.length)).toEqual([0, 0, 0]);
    expect(readChangeSet(db, { peerId: null, full: true }).photoBatches).toHaveLength(1);
  });

  test('readPhotoBatchItems pages in insertion order and stops with an empty page; bad input is refused', async () => {
    const db = await library();
    addPhotos(db, [1, 2, 3]);
    const first = readPhotoBatchItems(db, { batchId: PB, after: 0, limit: 2 });
    expect(first.items.map((i) => i.fileName)).toEqual(['1.jpg', '2.jpg']);
    expect(first.items[0]).toEqual(item(1));
    const second = readPhotoBatchItems(db, { batchId: PB, after: first.last, limit: 2 });
    expect(second.items.map((i) => i.fileName)).toEqual(['3.jpg']);
    expect(readPhotoBatchItems(db, { batchId: PB, after: second.last, limit: 2 })).toEqual({ items: [], last: second.last });
    for (const input of [{ batchId: 'x', after: 0, limit: 1 }, { batchId: PB, after: -1, limit: 1 }, { batchId: PB, after: 0, limit: MAX_BATCH_PAGE + 1 }]) {
      expect(() => readPhotoBatchItems(db, input)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
  });
});

describe('readBatchMessages', () => {
  test('pages in insertion order and stops with an empty page', async () => {
    const db = await library();
    const first = readBatchMessages(db, { batchId: B1, after: 0, limit: 2 });
    expect(first.messages.map((m) => m.body)).toEqual(['m1', 'm2']);
    const second = readBatchMessages(db, { batchId: B1, after: first.last, limit: 2 });
    expect(second.messages.map((m) => m.body)).toEqual(['m3']);
    expect(readBatchMessages(db, { batchId: B1, after: second.last, limit: 2 })).toEqual({ messages: [], last: second.last });
    expect(readBatchMessages(db, { batchId: B2, after: 0, limit: 2 }).messages).toEqual([]);
  });

  test('refuses bad input', async () => {
    const db = await library();
    for (const input of [
      { batchId: 'x', after: 0, limit: 1 },
      { batchId: B1, after: -1, limit: 1 },
      { batchId: B1, after: 0, limit: 0 },
      { batchId: B1, after: 0, limit: MAX_BATCH_PAGE + 1 },
    ]) {
      expect(() => readBatchMessages(db, input)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
  });
});

describe('participant changes travel with their conversation', () => {
  test('a changed "me" participant puts the conversation (with its participants) in the next pack', async () => {
    const db = await library();
    importMessages(db, { batchId: B2, conversationId: C1, source: 'whatsapp', sourceLabel: 'b', now: NOW, blobs: [], messages: [message(1)], meAuthor: 'Ana' });
    recordSent(db, { peerId: PEER, upToSeq: currentChangeSeq(db), now: NOW });
    expect(readChangeSet(db, { peerId: PEER }).conversations).toEqual([]);
    importMessages(db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'c', now: NOW, blobs: [], messages: [message(1)], meAuthor: 'Ben' });
    const set = readChangeSet(db, { peerId: PEER });
    expect(set.conversations.map((c) => c.id)).toEqual([C1]);
    expect(set.conversations[0].participants).toContainEqual({ displayName: 'Ben', profileId: null, isMe: true });
  });
});
