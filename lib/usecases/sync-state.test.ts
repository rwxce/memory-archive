import { describe, expect, test } from 'vitest';
import { getDeviceId, getPeerState, listPeers, recordReceived, recordSent } from './sync-state';
import { createTestLibrary } from './test-client';

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
});
