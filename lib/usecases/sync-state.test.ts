import { describe, expect, test } from 'vitest';
import { countUnsentChanges, getDeviceId, getPeerState, listPeers, recordReceived, recordSent } from './sync-state';
import { currentChangeSeq, renewDevice } from '../db/sync';
import { setNote } from '../db/queries';
import { createTestLibrary } from './test-client';
import { ANA, idOf, NOW, populated, send } from './test-sync';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [PEER, PEER2] = [uuid(900), uuid(901)];

async function setup() {
  const lib = await createTestLibrary();
  return { ...lib, deps: { ...lib.deps, now: () => new Date('2026-05-06T07:08:09Z') } };
}

describe('sync state use cases', () => {
  test('the device id is stable and created on first use', async () => {
    const { deps } = await setup();
    const id = await getDeviceId(deps);
    expect(id).toHaveLength(36);
    expect(await getDeviceId(deps)).toBe(id);
  });

  test('no peers at first; a pack sent and a pack received are recorded with the clock from the deps', async () => {
    const { deps, opened } = await setup();
    expect(await listPeers(deps)).toEqual([]);
    expect(await getPeerState(deps, PEER)).toBeNull();
    const top = opened.db.all<{ n: number }>('SELECT 1 AS n')[0].n; // the counter starts at 1
    expect(await recordSent(deps, PEER, top)).toEqual({
      recorded: true, peer: { peerId: PEER, lastSentSeq: 1, lastSentAt: '2026-05-06T07:08:09.000Z', lastReceivedSeq: 0, lastReceivedAt: null },
    });
    expect(await recordReceived(deps, PEER, 12, 1)).toMatchObject({ lastReceivedSeq: 12, lastSentSeq: 1, lastReceivedAt: '2026-05-06T07:08:09.000Z' });
    await recordReceived(deps, PEER2, 3, null);
    expect((await listPeers(deps)).map((p) => p.peerId).sort()).toEqual([PEER, PEER2]);
    expect(await getPeerState(deps, PEER)).toMatchObject({ lastReceivedSeq: 12 });
  });

  test('failures are DbErrors: bad ids, bad watermarks, self as peer, a watermark beyond the counter', async () => {
    const { deps } = await setup();
    await expect(getPeerState(deps, 'nope')).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordSent(deps, PEER, -1)).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordSent(deps, PEER, 999)).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordReceived(deps, await getDeviceId(deps), 1, null)).rejects.toMatchObject({ code: 'invalid' });
    expect(await listPeers(deps)).toEqual([]);
  });

  describe('countUnsentChanges', () => {
    const counts = async (lib: Awaited<ReturnType<typeof populated>>) => (await countUnsentChanges(lib.deps)).map(({ peerId, count }) => ({ peerId, count }));
    const edit = (lib: Awaited<ReturnType<typeof populated>>, body: string) =>
      setNote(lib.opened.db, { target: { kind: 'profile', profileId: ANA }, body, now: NOW });

    test('no peers gives []; a peer that has everything gives 0; an edit counts for that peer only', async () => {
      const a = await populated();
      expect(await countUnsentChanges(a.deps)).toEqual([]);
      await recordSent(a.deps, PEER, currentChangeSeq(a.opened.db));
      await recordSent(a.deps, PEER2, currentChangeSeq(a.opened.db));
      expect(await counts(a)).toEqual([{ peerId: PEER, count: 0 }, { peerId: PEER2, count: 0 }]);
      edit(a, 'changed');
      await recordSent(a.deps, PEER2, currentChangeSeq(a.opened.db));
      expect(await counts(a)).toEqual([{ peerId: PEER, count: 1 }, { peerId: PEER2, count: 0 }]);
      await recordSent(a.deps, PEER, currentChangeSeq(a.opened.db));
      expect((await countUnsentChanges(a.deps)).map((c) => c.count)).toEqual([0, 0]);
    });

    test('a peer that never received anything counts every record, batches included', async () => {
      const a = await populated();
      await recordReceived(a.deps, PEER, 1, null);
      const [{ count }] = await countUnsentChanges(a.deps);
      expect(count).toBeGreaterThanOrEqual(6); // 2 profiles, 2 conversations, 2 batches, a favorite, a note
    });

    test('records merged from a peer are not counted for it, but are for another peer', async () => {
      const a = await populated();
      const b = await createTestLibrary();
      await send(a, b);
      edit(b, 'from b');
      const bId = await idOf(b);
      const aId = await idOf(a);
      await send(b, a);
      // a now holds b's note version (changed_by = b): b needs nothing, a third device does.
      await recordReceived(a.deps, aId === PEER ? PEER2 : PEER, 1, null);
      const counts = Object.fromEntries((await countUnsentChanges(a.deps)).map((c) => [c.peerId, c.count]));
      expect(counts[bId]).toBe(0);
      expect(counts[PEER] ?? counts[PEER2]).toBeGreaterThan(0);
    });

    test('reports when the peer was last sent to and last exchanged with', async () => {
      const a = await populated();
      await recordReceived({ ...a.deps, now: () => new Date('2026-01-01T00:00:00Z') }, PEER, 1, null);
      await recordSent({ ...a.deps, now: () => new Date('2026-02-01T00:00:00Z') }, PEER2, currentChangeSeq(a.opened.db));
      const byPeer = Object.fromEntries((await countUnsentChanges(a.deps)).map((c) => [c.peerId, c]));
      expect(byPeer[PEER]).toMatchObject({ lastSentAt: null, lastExchangeAt: '2026-01-01T00:00:00.000Z' });
      expect(byPeer[PEER2]).toMatchObject({ lastSentAt: '2026-02-01T00:00:00.000Z', lastExchangeAt: '2026-02-01T00:00:00.000Z' });
    });

    test('a restored library is a new device with no peers', async () => {
      const a = await populated();
      await recordSent(a.deps, PEER, currentChangeSeq(a.opened.db));
      renewDevice(a.opened.db, currentChangeSeq(a.opened.db));
      expect(await countUnsentChanges(a.deps)).toEqual([]);
    });
  });
});
