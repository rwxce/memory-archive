import { afterEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { MediaMessageType, NewMessage } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from './use-library';
import { PERSON_MEDIA_PAGE, usePersonMedia, type PersonMediaState } from './use-person-media';

const SHA = 'ab'.repeat(32);
let seen: { state: PersonMediaState; loadMore(): void; retry(): void } | undefined;

function Probe({ id, kinds }: { id: string | null; kinds: readonly MediaMessageType[] }) {
  useLibrary();
  seen = usePersonMedia(id, kinds);
  return null;
}

const message = (n: number, type: NewMessage['type']): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-01T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`,
  ordinal: 0,
  type,
  participantName: 'Ana',
  body: '',
  mediaSha256: SHA,
  mediaName: 'f',
});

describe('usePersonMedia', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  async function setup(audio: number, photos: number) {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    await lib.client.call('importMessages', {
      batchId: '00000000-0000-4000-8000-000000000100',
      conversationId: '00000000-0000-4000-8000-000000000020',
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: '2026-02-01T12:00:00Z',
      blobs: [{ sha256: SHA, size: 1, mime: null }],
      messages: [
        ...Array.from({ length: audio }, (_, i) => message(i + 1, 'audio')),
        ...Array.from({ length: photos }, (_, i) => message(1000 + i, 'photo')),
      ],
      newConversation: { title: 'Chat', sourceKey: 'a', isGroup: false, profileIds: [ana.id] },
    });
    return { lib, ana };
  }

  test('reads the first page and the total of the asked kinds only; loadMore appends and stops at the end', async () => {
    const { lib, ana } = await setup(PERSON_MEDIA_PAGE + 5, 3);
    view = await renderWithLibrary(<Probe id={ana.id} kinds={['audio']} />, { lib });
    await settle();
    const first = seen!.state;
    if (first.status !== 'ready') throw new Error(first.status);
    expect(first.total).toBe(PERSON_MEDIA_PAGE + 5);
    expect(first.items).toHaveLength(PERSON_MEDIA_PAGE);
    expect(first.items.every((item) => item.type === 'audio')).toBe(true);

    await act(async () => {
      seen!.loadMore();
      seen!.loadMore(); // a second call while one is running does nothing
    });
    await settle();
    const all = seen!.state;
    if (all.status !== 'ready') throw new Error(all.status);
    expect(all.items.map((item) => item.id)).toEqual([...new Set(all.items.map((item) => item.id))]);
    expect(all.items).toHaveLength(PERSON_MEDIA_PAGE + 5);

    await act(async () => seen!.loadMore());
    await settle();
    expect(seen!.state.status === 'ready' && seen!.state.items).toHaveLength(PERSON_MEDIA_PAGE + 5);
  });

  test('is generic over the kinds: photos and videos come the same way', async () => {
    const { lib, ana } = await setup(2, 3);
    view = await renderWithLibrary(<Probe id={ana.id} kinds={['photo', 'video']} />, { lib });
    await settle();
    expect(seen!.state.status === 'ready' && seen!.state.total).toBe(3);
  });

  test('a later page that fails keeps what is shown and can be asked again', async () => {
    const { lib, ana } = await setup(PERSON_MEDIA_PAGE + 1, 0);
    view = await renderWithLibrary(<Probe id={ana.id} kinds={['audio']} />, { lib });
    await settle();
    const call = lib.deps.client.call.bind(lib.deps.client) as (...a: unknown[]) => Promise<unknown>;
    let fail = true;
    (lib.deps.client as { call: unknown }).call = (op: string, ...args: unknown[]) => (fail && op === 'listPersonMedia' ? Promise.reject(new Error('boom')) : call(op, ...args));
    await act(async () => seen!.loadMore());
    await settle();
    expect(seen!.state).toMatchObject({ status: 'ready', moreFailed: true, loadingMore: false });
    expect(seen!.state.status === 'ready' && seen!.state.items).toHaveLength(PERSON_MEDIA_PAGE);
    fail = false;
    await act(async () => seen!.loadMore());
    await settle();
    expect(seen!.state).toMatchObject({ status: 'ready', moreFailed: false });
    expect(seen!.state.status === 'ready' && seen!.state.items).toHaveLength(PERSON_MEDIA_PAGE + 1);
  });

  test('a missing, malformed or unknown id is not-found, never an error', async () => {
    const { lib } = await setup(1, 0);
    for (const id of [null, 'nope', '00000000-0000-4000-8000-000000000099']) {
      view = await renderWithLibrary(<Probe id={id} kinds={['audio']} />, { lib });
      await settle();
      expect(seen!.state.status).toBe('not-found');
      view.unmount();
    }
    view = undefined;
  });
});
