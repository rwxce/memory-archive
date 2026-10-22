import { describe, expect, test } from 'vitest';
import { blobSize } from './conversation-media';
import { readBlob } from './conversation-view';
import { countPersonMedia, listPersonMedia } from './person-media';
import { createTestLibrary } from './test-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-02-01T12:00:00Z';
const [ANA, CONV] = [uuid(1), uuid(10)];
const VOICE = 'ab'.repeat(32);

async function setup() {
  const lib = await createTestLibrary();
  await lib.client.call('createProfile', { id: ANA, displayName: 'Ana', now: NOW });
  await lib.client.call('importMessages', {
    batchId: uuid(100),
    conversationId: CONV,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs: [{ sha256: VOICE, size: 3, mime: 'audio/ogg' }],
    messages: [2, 1].map((d) => ({
      fingerprint: d.toString(16).padStart(64, '0'),
      sentAt: `2026-01-0${d}T10:00:00`,
      ordinal: 0,
      type: 'audio' as const,
      participantName: 'Ana',
      body: '',
      mediaSha256: VOICE,
      mediaName: `PTT-${d}.opus`,
    })),
    newConversation: { title: 'Chat', sourceKey: 'ana', isGroup: false, profileIds: [ANA] },
    meAuthor: 'Ana',
  });
  return lib;
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('person media use cases', () => {
  test('count and list go through the worker boundary; the bytes come from the existing blob use cases', async () => {
    const { deps } = await setup();
    expect(await countPersonMedia(deps, ANA, ['audio'])).toBe(2);
    const items = await listPersonMedia(deps, ANA, ['audio'], 0);
    expect(items.map((i) => i.mediaName)).toEqual(['PTT-1.opus', 'PTT-2.opus']);
    expect(items[0]).toMatchObject({ conversationId: CONV, conversationTitle: 'Chat', isMe: true, mediaMime: 'audio/ogg' });
    expect(await listPersonMedia(deps, ANA, ['audio'], 1, 5)).toHaveLength(1);
    expect(await listPersonMedia(deps, ANA, ['audio'], 10)).toEqual([]);
    expect(await countPersonMedia(deps, ANA, ['photo'])).toBe(0);
    // not stored in the (empty) blob store: the shared helpers report it the usual way
    expect(await blobSize(deps, items[0].mediaSha256)).toBeUndefined();
    expect(await rejection(readBlob(deps, items[0].mediaSha256))).toMatchObject({ code: 'not-found' });
  });

  test('unknown profile is not-found, empty or non-media kinds invalid', async () => {
    const { deps } = await setup();
    expect(await rejection(countPersonMedia(deps, uuid(99), ['audio']))).toMatchObject({ code: 'not-found' });
    expect(await rejection(listPersonMedia(deps, uuid(99), ['audio'], 0, 10))).toMatchObject({ code: 'not-found' });
    expect(await rejection(countPersonMedia(deps, ANA, []))).toMatchObject({ code: 'invalid' });
    expect(await rejection(listPersonMedia(deps, ANA, ['text'] as never, 0, 10))).toMatchObject({ code: 'invalid' });
    expect(await rejection(listPersonMedia(deps, ANA, ['audio'], -1, 10))).toMatchObject({ code: 'invalid' });
  });
});
