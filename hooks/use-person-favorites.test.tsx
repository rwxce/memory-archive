import { afterEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { NewMessage } from '@/lib/domain/library';
import { setFavorite } from '@/lib/usecases/favorites';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from './use-library';
import { PERSON_FAVORITES_PAGE, usePersonFavorites, type RemoveResult } from './use-person-favorites';

const CONV = '00000000-0000-4000-8000-000000000020';
let seen: ReturnType<typeof usePersonFavorites> | undefined;

function Probe({ id }: { id: string | null }) {
  useLibrary();
  seen = usePersonFavorites(id);
  return null;
}

const message = (n: number): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-01T${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `m${n}`,
  mediaSha256: null,
  mediaName: '',
});

describe('usePersonFavorites', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  async function setup(count: number, starred: number[]) {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    await lib.client.call('importMessages', {
      batchId: '00000000-0000-4000-8000-000000000100',
      conversationId: CONV,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: '2026-02-01T12:00:00Z',
      blobs: [],
      messages: Array.from({ length: count }, (_, i) => message(i + 1)),
      newConversation: { title: 'Chat', sourceKey: 'a', isGroup: false, profileIds: [ana.id] },
    });
    const rows = await lib.client.call('getMessageWindow', { conversationId: CONV, offset: 0, limit: count });
    for (const n of starred) await setFavorite(lib.deps, CONV, rows[n - 1].id, true);
    return { lib, ana };
  }
  const ready = () => {
    const state = seen!.state;
    if (state.status !== 'ready') throw new Error(state.status);
    return state;
  };

  test('reads the first page and total; loadMore appends the rest once; remove drops one and never skips on the next page', async () => {
    const all = Array.from({ length: PERSON_FAVORITES_PAGE + 5 }, (_, i) => i + 1);
    const { lib, ana } = await setup(PERSON_FAVORITES_PAGE + 8, all);
    view = await renderWithLibrary(<Probe id={ana.id} />, { lib });
    await settle();
    expect(ready().total).toBe(PERSON_FAVORITES_PAGE + 5);
    expect(ready().items).toHaveLength(PERSON_FAVORITES_PAGE);

    let result: RemoveResult | undefined;
    await act(async () => void (result = await seen!.remove(ready().items[0])));
    expect(result).toBe('removed');
    expect(ready().total).toBe(PERSON_FAVORITES_PAGE + 4);
    expect(ready().items).toHaveLength(PERSON_FAVORITES_PAGE - 1);

    await act(async () => {
      seen!.loadMore();
      seen!.loadMore();
    });
    await settle();
    const bodies = ready().items.map((i) => i.body);
    expect(bodies).toHaveLength(PERSON_FAVORITES_PAGE + 4);
    expect(new Set(bodies).size).toBe(bodies.length);
    expect(bodies).not.toContain('m1');
  });

  test('a second remove of the same message while it runs is busy; a failed write keeps the item', async () => {
    const { lib, ana } = await setup(3, [1, 2]);
    view = await renderWithLibrary(<Probe id={ana.id} />, { lib });
    await settle();
    const item = ready().items[0];
    const results: RemoveResult[] = [];
    await act(async () => {
      const a = seen!.remove(item);
      const b = seen!.remove(item);
      results.push(await a, await b);
    });
    expect(results).toEqual(['removed', 'busy']);

    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'setFavorite' ? Promise.reject(Object.assign(new Error('x'), { code: 'internal' })) : call(method, params));
    let failed: RemoveResult | undefined;
    await act(async () => void (failed = await seen!.remove(ready().items[0])));
    expect(failed).toBe('failed');
    expect(ready().items).toHaveLength(1);
    expect(ready().total).toBe(1);
  });

  test('a malformed or unknown person is not-found', async () => {
    const { lib } = await setup(1, []);
    view = await renderWithLibrary(<Probe id="nope" />, { lib });
    await settle();
    expect(seen!.state.status).toBe('not-found');
    view.unmount();
    view = await renderWithLibrary(<Probe id="00000000-0000-4000-8000-0000000000ff" />, { lib });
    await settle();
    expect(seen!.state.status).toBe('not-found');
  });
});
