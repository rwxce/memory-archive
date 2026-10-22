import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { PersonMediaItem } from '@/lib/domain/library';
import { webpBlob } from '@/lib/storage/test-thumbnail';
import { THUMB_MIN_SOURCE_BYTES } from '@/lib/usecases/tile-image';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from './use-library';
import type { MediaState } from './use-media-url';
import { useTileImage } from './use-tile-image';

const FULL = THUMB_MIN_SOURCE_BYTES + 100;
let seen: MediaState | undefined;
let created: Blob[];

function Probe({ item, near }: { item: PersonMediaItem; near: boolean }) {
  useLibrary();
  seen = useTileImage(item, near);
  return null;
}

const itemOf = (sha256: string): PersonMediaItem => ({
  id: 1,
  conversationId: 'c',
  conversationTitle: 'Chat',
  sentAt: '2026-01-01T10:00:00',
  type: 'photo',
  participantName: 'Ana',
  isMe: false,
  body: '',
  mediaSha256: sha256,
  mediaName: 'a.jpg',
  mediaMime: 'image/jpeg',
});

/** The browser APIs a real thumbnail needs, as fakes that produce a small complete webp. */
function stubImageApis() {
  const decode = vi.fn(async (_blob: Blob, resize: { resizeWidth?: number }) => ({ width: resize.resizeWidth ?? 10, height: 10, close: vi.fn() }));
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { drawImage() {}, fillRect() {}, fillStyle: '', globalCompositeOperation: '' };
      }
      async convertToBlob() {
        return webpBlob(40);
      }
    },
  );
  return decode;
}

let view: (Rendered & { lib: Awaited<ReturnType<typeof createTestLibrary>> }) | undefined;

async function show(lib: Awaited<ReturnType<typeof createTestLibrary>>, item: PersonMediaItem, near = true) {
  view = await renderWithLibrary(<Probe item={item} near={near} />, { lib });
  await settle();
}

beforeEach(() => {
  seen = undefined;
  created = [];
  let n = 0;
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    created.push(blob as Blob);
    return `blob:mock-${++n}`;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('useTileImage', () => {
  test('a miss reads the photo once, caches the thumbnail and shows it; revokes it on unmount', async () => {
    stubImageApis();
    const lib = await createTestLibrary();
    const { sha256 } = await lib.deps.blobStore.put(new Uint8Array(FULL).fill(5));
    await show(lib, itemOf(sha256));
    expect(seen).toEqual({ status: 'ready', url: 'blob:mock-1', size: 40 });
    expect(created[0]!.type).toBe('image/webp');
    expect(await lib.deps.thumbStore!.usage()).toEqual({ count: 1, bytes: 40 });
    view!.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    view = undefined;
  });

  test('a hit is served from the cache without reading or decoding the photo', async () => {
    const decode = stubImageApis();
    const lib = await createTestLibrary();
    const { sha256 } = await lib.deps.blobStore.put(new Uint8Array(FULL).fill(5));
    await lib.deps.thumbStore!.put(sha256, 320, webpBlob(30));
    const open = vi.spyOn(lib.deps.blobStore, 'open');
    await show(lib, itemOf(sha256));
    expect(seen).toEqual({ status: 'ready', url: 'blob:mock-1', size: 30 });
    expect(open).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  test('when no thumbnail can be made (no browser support) the full-size file is shown, as before', async () => {
    const lib = await createTestLibrary();
    const { sha256 } = await lib.deps.blobStore.put(new Uint8Array(FULL).fill(5));
    await show(lib, itemOf(sha256));
    expect(seen).toEqual({ status: 'ready', url: 'blob:mock-1', size: FULL });
    expect(created[0]!.type).toBe('image/jpeg');
    expect(await lib.deps.thumbStore!.usage()).toEqual({ count: 0, bytes: 0 });
  });

  test('a photo the archive does not have is missing; a far tile reads nothing', async () => {
    stubImageApis();
    const lib = await createTestLibrary();
    await show(lib, itemOf('e'.repeat(64)));
    expect(seen).toEqual({ status: 'missing' });
    view!.unmount();

    const { sha256 } = await lib.deps.blobStore.put(new Uint8Array(FULL).fill(5));
    const open = vi.spyOn(lib.deps.blobStore, 'open');
    await show(lib, itemOf(sha256), false);
    expect(seen).toEqual({ status: 'idle' });
    expect(open).not.toHaveBeenCalled();
  });

  test('a tile that goes far away revokes its URL and is idle again', async () => {
    stubImageApis();
    const lib = await createTestLibrary();
    const { sha256 } = await lib.deps.blobStore.put(new Uint8Array(FULL).fill(5));
    let setNear: (near: boolean) => void = () => {};
    function Toggle() {
      const [near, set] = useState(true);
      setNear = set;
      return <Probe item={itemOf(sha256)} near={near} />;
    }
    view = await renderWithLibrary(<Toggle />, { lib });
    await settle();
    expect(seen).toMatchObject({ status: 'ready' });
    await act(async () => setNear(false));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    expect(seen).toEqual({ status: 'idle' });
  });
});
