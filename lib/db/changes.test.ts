import { describe, expect, test } from 'vitest';
import { MAX_BATCH_PAGE, readBatchMessages, readChangeSet } from './changes';
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
