import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, useCallback, useState } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { ConversationMessage, NewMessage } from '@/lib/domain/library';
import { countFavorites } from '@/lib/usecases/favorites';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useFavoriteToggle } from './use-favorite-toggle';
import { useLibrary } from './use-library';
import { useMessagePages } from './use-message-pages';
import { getMessageWindow } from '@/lib/usecases/conversation-view';

const CONV = '00000000-0000-4000-8000-000000000020';
const msg = (n: number): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-01T10:0${n}:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `m${n}`,
  mediaSha256: null,
  mediaName: '',
});

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
let api: { toggle(m: ConversationMessage): void; first(): ConversationMessage | undefined; failed: number; version: number; request(a: number, b: number): void } | undefined;

function Probe({ lib }: { lib: Lib }) {
  useLibrary();
  const [failed, setFailed] = useState(0);
  const read = useCallback((offset: number, limit: number) => getMessageWindow(lib.deps, CONV, offset, limit), [lib]);
  const pages = useMessagePages(CONV, 3, read);
  const toggle = useFavoriteToggle(CONV, pages.setFavorite, useCallback(() => setFailed((n) => n + 1), []));
  api = { toggle, first: () => pages.at(0)?.message, failed, version: pages.version, request: pages.request };
  return null;
}

async function setup() {
  const lib = await createTestLibrary();
  await lib.client.call('importMessages', {
    batchId: '00000000-0000-4000-8000-000000000100',
    conversationId: CONV,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: '2026-02-01T12:00:00Z',
    blobs: [],
    messages: [msg(1), msg(2), msg(3)],
    newConversation: { title: 'Chat', sourceKey: 'a', isGroup: false, profileIds: [] },
  });
  return lib;
}

describe('useFavoriteToggle', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  async function mount(lib: Lib) {
    view = await renderWithLibrary(<Probe lib={lib} />, { lib });
    await settle();
    await act(async () => api!.request(0, 3));
    await settle();
  }

  test('marks the cached message at once and stores it; a second toggle clears it', async () => {
    const lib = await setup();
    await mount(lib);
    expect(api!.first()!.isFavorite).toBe(false);
    await act(async () => api!.toggle(api!.first()!));
    await settle();
    expect(api!.first()!.isFavorite).toBe(true);
    expect(await countFavorites(lib.deps, { conversationId: CONV })).toBe(1);
    await act(async () => api!.toggle(api!.first()!));
    await settle();
    expect(api!.first()!.isFavorite).toBe(false);
    expect(await countFavorites(lib.deps, { conversationId: CONV })).toBe(0);
  });

  test('a failed write puts the old mark back and says so; taps while a write runs are ignored', async () => {
    const lib = await setup();
    await mount(lib);
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    let release!: (fail: boolean) => void;
    const writes = vi.fn();
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => {
      if (method !== 'setFavorite') return call(method, params);
      writes();
      return new Promise((_, reject) => (release = () => reject(Object.assign(new Error('x'), { code: 'internal' }))));
    };
    const message = api!.first()!;
    await act(async () => {
      api!.toggle(message);
      api!.toggle(message);
    });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(api!.first()!.isFavorite).toBe(true); // optimistic
    await act(async () => release(true));
    await settle();
    expect(api!.first()!.isFavorite).toBe(false); // rolled back
    expect(api!.failed).toBe(1);
    expect(await countFavorites(lib.deps, { conversationId: CONV })).toBe(0);
  });

  test('a page read again shows the mark even if the read started before it was set', async () => {
    const lib = await setup();
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    // The window read returns the old (unmarked) rows: as if it began before the write.
    let stale: Promise<unknown> | undefined;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => {
      if (method === 'getMessageWindow') {
        stale = (async () => {
          const rows = (await call(method, params)) as ConversationMessage[];
          await new Promise((r) => setTimeout(r, 30));
          return rows;
        })();
        return stale;
      }
      return call(method, params);
    };
    view = await renderWithLibrary(<Probe lib={lib} />, { lib });
    await settle();
    await act(async () => api!.request(0, 3));
    await act(async () => {
      // the first page is still in flight when the star is pressed on a message we know
      api!.toggle({ id: 1 } as ConversationMessage);
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
    await settle();
    expect(api!.first()!.isFavorite).toBe(true);
  });
});
