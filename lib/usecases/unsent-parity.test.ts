import { describe, expect, test } from 'vitest';
import { readChangeSet } from '../db/changes';
import { setFavorite, setNote, undoImportBatch } from '../db/queries';
import { countUnsentChanges, currentChangeSeq, getDeviceId, recordReceived, recordSent } from '../db/sync';
import { createTestLibrary } from './test-client';
import { ANA, B1, C1, messageId, NOW, populated, send, uuid, type Lib } from './test-sync';

const THIRD = uuid(950);

/**
 * The records a pack for `peerId` carries in its own right (messages and blobs excluded, like the
 * count): above the watermark. Unchanged profiles and conversations the pack only pulls in because
 * a carried record references them (the closure) are not counted, on either side.
 */
function packRecords(lib: Lib, peerId: string): number {
  const s = readChangeSet(lib.opened.db, { peerId });
  const own = (rows: { seq: number }[]) => rows.filter((r) => r.seq > s.since).length;
  return own(s.profiles) + own(s.conversations) + own(s.favorites) + own(s.notes) + own(s.tombstones) + own(s.batches);
}
const unsent = (lib: Lib, peerId: string) => countUnsentChanges(lib.opened.db).find((p) => p.peerId === peerId)?.count;

describe('countUnsentChanges equals the records readChangeSet would carry for the same peer', () => {
  test('fresh edits and tombstones', async () => {
    const a = await populated();
    const { db } = a.opened;
    recordSent(db, { peerId: THIRD, upToSeq: currentChangeSeq(db), now: NOW });
    expect(unsent(a, THIRD)).toBe(0);
    expect(packRecords(a, THIRD)).toBe(0);
    setNote(db, { target: { kind: 'profile', profileId: ANA }, body: 'edited', now: NOW });
    setFavorite(db, { conversationId: C1, messageId: messageId(a, 1), favorite: false, now: NOW }); // a favorite tombstone
    expect(unsent(a, THIRD)).toBe(packRecords(a, THIRD));
    expect(unsent(a, THIRD)).toBe(2);
    undoImportBatch(db, B1); // a batch tombstone, plus the conversation's other rows going away
    expect(unsent(a, THIRD)).toBe(packRecords(a, THIRD));
  });

  test('a peer that never received anything: the whole library, batches included', async () => {
    const a = await populated();
    recordReceived(a.opened.db, { peerId: THIRD, upToSeq: 1, ackedSeq: null, now: NOW });
    expect(unsent(a, THIRD)).toBe(packRecords(a, THIRD));
    expect(unsent(a, THIRD)).toBeGreaterThanOrEqual(6);
  });

  test('records merged from a peer are not echoed back (batches included) but still relay to a third device', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    const aId = getDeviceId(a.opened.db);
    // b holds a's profiles, conversations, batches, favorite and note, all stamped changed_by = a.
    expect(unsent(b, aId)).toBe(0);
    expect(packRecords(b, aId)).toBe(0);
    recordReceived(b.opened.db, { peerId: THIRD, upToSeq: 1, ackedSeq: null, now: NOW });
    expect(unsent(b, THIRD)).toBe(packRecords(b, THIRD));
    expect(readChangeSet(b.opened.db, { peerId: THIRD }).batches.length).toBe(2);
    // A local edit on b goes to a, and only that.
    recordSent(b.opened.db, { peerId: aId, upToSeq: currentChangeSeq(b.opened.db), now: NOW });
    setNote(b.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'from b', now: NOW });
    expect(unsent(b, aId)).toBe(1);
    expect(packRecords(b, aId)).toBe(1);
  });

  test('records the pack pulls in only as references are not counted', async () => {
    const a = await populated();
    recordSent(a.opened.db, { peerId: THIRD, upToSeq: currentChangeSeq(a.opened.db), now: NOW });
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'n', now: NOW });
    // The pack also pulls in the conversation and its profile for the note (closure): not counted.
    const set = readChangeSet(a.opened.db, { peerId: THIRD });
    expect(set.conversations.length + set.profiles.length).toBeGreaterThan(0);
    expect(unsent(a, THIRD)).toBe(1);
    expect(packRecords(a, THIRD)).toBe(1);
  });
});
