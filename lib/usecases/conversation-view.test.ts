import { describe, expect, test, vi } from 'vitest';
import { DbError } from '../db/errors';
import type { NewMessage } from '../domain/library';
import {
  countMessages,
  findMessageOffsetByDate,
  findMessageOffsetById,
  getMessageWindow,
  listConversationDays,
  MAX_IN_MEMORY_MEDIA_BYTES,
  mediaTypeOf,
  openConversationView,
  readBlob,
} from './conversation-view';
import { createTestLibrary } from './test-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CONV = uuid(10);
const NOW = '2026-02-01T12:00:00Z';

const message = (n: number, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-0${n}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

async function setup() {
  const lib = await createTestLibrary();
  await lib.client.call('importMessages', {
    batchId: uuid(100),
    conversationId: CONV,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs: [],
    messages: [message(1), message(2), message(3)],
    newConversation: { title: 'Chat with Ana', sourceKey: 'ana', isGroup: false, profileIds: [] },
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

describe('conversation view use cases', () => {
  test('open, count, window, date jump and days go through the worker boundary', async () => {
    const { deps } = await setup();
    const view = await openConversationView(deps, CONV);
    expect(view.conversation).toMatchObject({ id: CONV, title: 'Chat with Ana', messageCount: 3 });
    expect(view.bounds).toEqual({ count: 3, firstSentAt: '2026-01-01T10:00:00', lastSentAt: '2026-01-03T10:00:00' });
    expect(view.participants).toEqual([{ displayName: 'Ana', profileId: null, isMe: true }]);
    expect(await countMessages(deps, CONV)).toBe(3);
    expect((await getMessageWindow(deps, CONV, 1, 5)).map((m) => m.body)).toEqual(['synthetic 2', 'synthetic 3']);
    expect(await getMessageWindow(deps, CONV, 10)).toEqual([]);
    expect(await findMessageOffsetByDate(deps, CONV, '2026-01-02')).toBe(1);
    expect(await findMessageOffsetByDate(deps, CONV, '2026-02-01')).toBeNull();
    const second = (await getMessageWindow(deps, CONV, 1, 1))[0];
    expect(await findMessageOffsetById(deps, CONV, second.id)).toBe(1);
    expect(await findMessageOffsetById(deps, CONV, 99_999)).toBeNull();
    expect((await listConversationDays(deps, CONV)).map((d) => d.firstOffset)).toEqual([0, 1, 2]);
  });

  test('an unknown conversation is not-found, a malformed request invalid', async () => {
    const { deps } = await setup();
    for (const call of [
      () => openConversationView(deps, uuid(99)),
      () => countMessages(deps, uuid(99)),
      () => getMessageWindow(deps, uuid(99), 0, 10),
      () => listConversationDays(deps, uuid(99)),
    ]) {
      expect(await rejection(call())).toMatchObject({ code: 'not-found' });
    }
    expect(await rejection(getMessageWindow(deps, CONV, -1, 10))).toMatchObject({ code: 'invalid' });
    expect(await rejection(findMessageOffsetByDate(deps, CONV, '2026-02-30'))).toMatchObject({ code: 'invalid' });
  });

  test('readBlob returns the stored bytes typed from the stored mime, else the name, else bytes', async () => {
    const { deps } = await setup();
    const { sha256 } = await deps.blobStore.put(new Uint8Array([1, 2, 3]));
    const blob = await readBlob(deps, sha256, { mime: 'image/png', name: 'x.jpg' });
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await readBlob(deps, sha256, { mime: null, name: 'IMG-1.JPG' })).type).toBe('image/jpeg');
    expect((await readBlob(deps, sha256, { mime: 'not a type', name: 'weird' })).type).toBe('application/octet-stream');
    expect((await readBlob(deps, sha256)).type).toBe('application/octet-stream');
  });

  test('readBlob: a missing blob is not-found and a malformed hash invalid', async () => {
    const { deps } = await setup();
    const missing = await rejection(readBlob(deps, 'ab'.repeat(32)));
    expect(missing).toBeInstanceOf(DbError);
    expect(missing).toMatchObject({ code: 'not-found' });
    expect(await rejection(readBlob(deps, '../../etc/passwd'))).toMatchObject({ code: 'invalid' });
    expect(await rejection(readBlob(deps, 'AB'.repeat(32)))).toMatchObject({ code: 'invalid' });
  });

  test('readBlob hands out a lazy file when the store has one, whatever its size', async () => {
    const { deps } = await setup();
    const { sha256 } = await deps.blobStore.put(new Uint8Array([4, 5, 6]));
    const huge = new File([new Uint8Array([4, 5, 6])], 'x');
    Object.defineProperty(huge, 'size', { value: MAX_IN_MEMORY_MEDIA_BYTES * 4 });
    const open = vi.fn();
    const store = { ...deps.blobStore, file: async () => huge, open };
    const blob = await readBlob({ blobStore: store }, sha256, { name: 'v.mp4' });
    expect(blob.type).toBe('video/mp4');
    expect(open).not.toHaveBeenCalled();
  });

  test('readBlob refuses to copy an over-limit file into memory before reading it', async () => {
    const { deps } = await setup();
    const { sha256 } = await deps.blobStore.put(new Uint8Array([7]));
    const open = vi.fn();
    const store = { ...deps.blobStore, file: undefined, open, size: async () => MAX_IN_MEMORY_MEDIA_BYTES + 1 };
    const error = await rejection(readBlob({ blobStore: store }, sha256));
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: 'too-large' });
    expect(open).not.toHaveBeenCalled();
    const small = { ...store, size: async () => 1, open: async () => new Blob([new Uint8Array([7])]).stream() };
    expect((await readBlob({ blobStore: small }, sha256)).size).toBe(1);
  });

  test('mediaTypeOf never trusts the extension beyond a fixed table', () => {
    expect(mediaTypeOf({ name: 'a.constructor' })).toBe('application/octet-stream');
    expect(mediaTypeOf({ name: 'noext' })).toBe('application/octet-stream');
    expect(mediaTypeOf({ name: 'a.mp4' })).toBe('video/mp4');
  });
});
