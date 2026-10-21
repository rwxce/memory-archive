import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../domain/sha256';
import { BlobStoreError, type BlobStore } from './blob-store';
import { BLOBS_DIRECTORY, openBlobStore, openSink, type OpfsDirectoryHandle } from './opfs-blob-store';
import { createMemoryDirectory, type MemoryDirectoryCapabilities } from './test-opfs-directory';

const enc = (s: string) => new TextEncoder().encode(s);
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function streamOf(chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && i === failAfter) controller.error(new Error('stream broke'));
      else if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!stream) throw new Error('missing blob');
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function names(dir: OpfsDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of dir.entries()) out.push(name);
  return out.sort();
}

async function tmpEntries(root: OpfsDirectoryHandle): Promise<string[]> {
  const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
  return names(await base.getDirectoryHandle('tmp'));
}

async function overwrite(root: OpfsDirectoryHandle, sha: string, bytes: Uint8Array): Promise<void> {
  const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
  const shard = await base.getDirectoryHandle(sha.slice(0, 2));
  const file = await shard.getFileHandle(sha);
  if (file.createWritable) {
    const writable = await file.createWritable();
    await writable.write(bytes);
    await writable.close();
  } else {
    const handle = await file.createSyncAccessHandle!();
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.close();
  }
}

const VARIANTS: [string, MemoryDirectoryCapabilities][] = [
  ['createWritable + move', {}],
  ['sync access handle + move', { writable: false }],
  ['createWritable, no move (copy fallback)', { move: false }],
  ['sync access handle, no move', { writable: false, move: false }],
];

describe.each(VARIANTS)('blob store on %s', (_label, capabilities) => {
  const setup = async () => {
    const root = createMemoryDirectory(capabilities);
    return { root, store: await openBlobStore(root) };
  };

  test('put hashes while streaming and returns the known digest; open and size read it back', async () => {
    const { store } = await setup();
    expect(await store.put(streamOf([enc('a'), enc('b'), enc('c')]))).toEqual({ sha256: ABC, size: 3 });
    expect(await store.has(ABC)).toBe(true);
    expect(await store.size(ABC)).toBe(3);
    expect(new TextDecoder().decode(await readAll(await store.open(ABC)))).toBe('abc');
    expect(await store.verify(ABC)).toBe('ok');
  });

  test('put of a Uint8Array and of a stream with the same bytes is the same blob, stored once', async () => {
    const { root, store } = await setup();
    const a = await store.put(enc('abc'));
    const b = await store.put(streamOf([enc('ab'), enc('c')]));
    const c = await store.put(enc('abc'));
    expect([a, b, c]).toEqual([
      { sha256: ABC, size: 3 },
      { sha256: ABC, size: 3 },
      { sha256: ABC, size: 3 },
    ]);
    expect(await store.list()).toEqual([ABC]);
    expect(await tmpEntries(root)).toEqual([]);
    const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
    const shard = await base.getDirectoryHandle('ba');
    expect(await names(shard)).toEqual([ABC]);
  });

  test('empty content is a valid blob', async () => {
    const { store } = await setup();
    const empty = await store.put(new Uint8Array(0));
    expect(empty).toEqual({ sha256: sha256Hex(new Uint8Array(0)), size: 0 });
    expect(await store.verify(empty.sha256)).toBe('ok');
    expect((await readAll(await store.open(empty.sha256))).length).toBe(0);
  });

  test('a stream that errors midway leaves nothing visible and no temp file, and the next put works', async () => {
    const { root, store } = await setup();
    await expect(store.put(streamOf([enc('abc'), enc('def')], 1))).rejects.toThrow('stream broke');
    expect(await store.list()).toEqual([]);
    expect(await tmpEntries(root)).toEqual([]);
    expect(await store.put(enc('abc'))).toEqual({ sha256: ABC, size: 3 });
  });

  test('a stream with non-bytes chunks is refused cleanly', async () => {
    const { root, store } = await setup();
    const bad = new ReadableStream({
      start(controller) {
        controller.enqueue('text');
        controller.close();
      },
    });
    await expect(store.put(bad as unknown as ReadableStream<Uint8Array>)).rejects.toMatchObject({
      code: 'invalid-source',
    });
    await expect(store.put('abc' as unknown as Uint8Array)).rejects.toMatchObject({ code: 'invalid-source' });
    expect(await store.list()).toEqual([]);
    expect(await tmpEntries(root)).toEqual([]);
  });

  test('put leaves a same-size corrupt blob alone; verify is what reports it', async () => {
    const { root, store } = await setup();
    await store.put(enc('abc'));
    await overwrite(root, ABC, enc('abX'));
    expect(await store.verify(ABC)).toBe('corrupt');
    await store.put(enc('abc'));
    expect(await store.verify(ABC)).toBe('corrupt');
    expect(new TextDecoder().decode(await readAll(await store.open(ABC)))).toBe('abX');
  });

  test('verify detects a corrupted blob; re-putting the same content replaces a size-mismatched copy', async () => {
    const { root, store } = await setup();
    await store.put(enc('abc'));
    await overwrite(root, ABC, enc('abX'));
    expect(await store.verify(ABC)).toBe('corrupt');
    // Truncated copy: the size no longer matches, so putting the content again replaces it.
    await overwrite(root, ABC, enc('ab'));
    expect(await store.verify(ABC)).toBe('corrupt');
    await store.put(enc('abc'));
    expect(await store.verify(ABC)).toBe('ok');
    expect(await store.size(ABC)).toBe(3);
  });

  test('verify reports a missing blob', async () => {
    const { store } = await setup();
    expect(await store.verify(ABC)).toBe('missing');
  });

  test('delete and list', async () => {
    const { store } = await setup();
    const one = await store.put(enc('one'));
    const two = await store.put(enc('two'));
    expect(await store.list()).toEqual([one.sha256, two.sha256].sort());
    expect(await store.delete(one.sha256)).toBe(true);
    expect(await store.delete(one.sha256)).toBe(false);
    expect(await store.has(one.sha256)).toBe(false);
    expect(await store.open(one.sha256)).toBeUndefined();
    expect(await store.size(one.sha256)).toBeUndefined();
    expect(await store.list()).toEqual([two.sha256]);
  });

  test('a large multi-chunk stream is hashed and stored correctly, chunk by chunk', async () => {
    const { store } = await setup();
    const chunk = Uint8Array.from({ length: 64 * 1024 + 5 }, (_, i) => (i * 7) & 0xff);
    const count = 40; // ~2.6 MB without ever holding it as one buffer in the source
    const whole = new Uint8Array(chunk.length * count);
    for (let i = 0; i < count; i++) whole.set(chunk, i * chunk.length);
    const info = await store.put(streamOf(Array.from({ length: count }, () => chunk)));
    expect(info).toEqual({ sha256: sha256Hex(whole), size: whole.length });
    expect(await store.verify(info.sha256)).toBe('ok');
    expect(sha256Hex(await readAll(await store.open(info.sha256)))).toBe(info.sha256);
  });

  test('concurrent puts of the same content end with one blob', async () => {
    const { root, store } = await setup();
    const results = await Promise.all([1, 2, 3, 4].map(() => store.put(streamOf([enc('ab'), enc('c')]))));
    expect(results.every((r) => r.sha256 === ABC)).toBe(true);
    expect(await store.list()).toEqual([ABC]);
    expect(await store.verify(ABC)).toBe('ok');
    expect(await tmpEntries(root)).toEqual([]);
  });

  test('reopening sweeps abandoned temp files and keeps stored blobs', async () => {
    const { root, store } = await setup();
    await store.put(enc('abc'));
    const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
    const tmp = await base.getDirectoryHandle('tmp');
    await tmp.getFileHandle('crashed-write.tmp', { create: true });
    await tmp.getFileHandle('whatever', { create: true });
    expect(await tmpEntries(root)).toEqual(['crashed-write.tmp', 'whatever']);

    const reopened = await openBlobStore(root);
    expect(await tmpEntries(root)).toEqual([]);
    expect(await reopened.list()).toEqual([ABC]);
    expect(await reopened.verify(ABC)).toBe('ok');
  });

  test('a second opener with sweep:false leaves another thread\'s in-flight temp files alone', async () => {
    const { root, store } = await setup();
    await store.put(enc('abc'));
    const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
    const tmp = await base.getDirectoryHandle('tmp');
    await tmp.getFileHandle('in-flight.tmp', { create: true });

    const second = await openBlobStore(root, { sweep: false });
    expect(await tmpEntries(root)).toEqual(['in-flight.tmp']);
    // It still reads and writes the same content-addressed store, and cleans only its own temp files.
    expect(await second.list()).toEqual([ABC]);
    const info = await second.put(enc('hello'));
    expect(await store.has(info.sha256)).toBe(true);
    expect(await tmpEntries(root)).toEqual(['in-flight.tmp']);

    // The owner's next open (default) recovers whatever a crashed writer left.
    await openBlobStore(root);
    expect(await tmpEntries(root)).toEqual([]);
  });
});

describe('copy fallback recovery', () => {
  test('a crash during the copy leaves a marker; the next open removes the bad blob, keeps a good one', async () => {
    const root = createMemoryDirectory({ move: false });
    const store = await openBlobStore(root);
    const good = await store.put(enc('abc'));
    const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
    const tmp = await base.getDirectoryHandle('tmp');

    // Simulated crash: marker present and a half-written blob under the final name.
    const half = sha256Hex(enc('hello world'));
    const shard = await base.getDirectoryHandle(half.slice(0, 2), { create: true });
    const file = await shard.getFileHandle(half, { create: true });
    const writable = await file.createWritable!();
    await writable.write(enc('hello'));
    await writable.close();
    await tmp.getFileHandle(`pending-${half}`, { create: true });
    // A marker for a blob that did complete is cleaned without deleting it.
    await tmp.getFileHandle(`pending-${good.sha256}`, { create: true });

    const reopened = await openBlobStore(root);
    expect(await reopened.list()).toEqual([good.sha256]);
    expect(await tmpEntries(root)).toEqual([]);
  });

  test('a stream error during the copy fallback never leaves a blob or a marker', async () => {
    const root = createMemoryDirectory({ move: false });
    const store = await openBlobStore(root);
    await expect(store.put(streamOf([enc('abc')], 1))).rejects.toThrow('stream broke');
    expect(await store.list()).toEqual([]);
    expect(await tmpEntries(root)).toEqual([]);
  });
});

describe('copy fallback failure paths', () => {
  const COPY_VARIANTS: [string, MemoryDirectoryCapabilities][] = [
    ['createWritable', { move: false }],
    ['sync access handle', { writable: false, move: false }],
  ];

  describe.each(COPY_VARIANTS)('with %s', (_label, capabilities) => {
    const setup = async () => {
      const faults: NonNullable<MemoryDirectoryCapabilities['faults']> = {};
      const root = createMemoryDirectory({ ...capabilities, faults });
      return { root, faults, store: await openBlobStore(root) };
    };

    test('a write failure during the copy leaves no blob and no marker', async () => {
      const { root, faults, store } = await setup();
      faults.failWrite = true;
      await expect(store.put(enc('abc'))).rejects.toThrow('disk full');
      expect(await store.list()).toEqual([]);
      expect(await tmpEntries(root)).toEqual([]);
    });

    test('a copy that does not verify is removed, with its marker', async () => {
      const { root, faults, store } = await setup();
      faults.corruptWrite = true;
      await expect(store.put(enc('abc'))).rejects.toThrow('copied blob did not verify');
      expect(await store.list()).toEqual([]);
      expect(await tmpEntries(root)).toEqual([]);
      faults.corruptWrite = false;
      expect(await store.put(enc('abc'))).toEqual({ sha256: ABC, size: 3 });
    });
  });

  test('a short write on a sync access handle fails with an io error and leaves nothing', async () => {
    const faults = { shortWrite: true };
    const root = createMemoryDirectory({ writable: false, move: false, faults });
    const store = await openBlobStore(root);
    await expect(store.put(enc('abc'))).rejects.toMatchObject({ code: 'io' });
    expect(await store.list()).toEqual([]);
    expect(await tmpEntries(root)).toEqual([]);
  });

  test('a sync access sink starts from an empty file: no stale trailing bytes', async () => {
    const root = createMemoryDirectory({ writable: false });
    const file = await root.getFileHandle('f', { create: true });
    const first = await openSink(file);
    await first.write(enc('0123456789'));
    await first.close();
    const second = await openSink(file);
    await second.write(enc('ab'));
    await second.close();
    expect(new TextDecoder().decode(new Uint8Array(await (await file.getFile()).arrayBuffer()))).toBe('ab');
  });

  test('a throwing verify or remove on a pending blob does not make open reject', async () => {
    const root = createMemoryDirectory({ move: false });
    const store = await openBlobStore(root);
    const good = await store.put(enc('abc'));
    const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
    const tmp = await base.getDirectoryHandle('tmp');
    await tmp.getFileHandle(`pending-${good.sha256}`, { create: true });

    // Wrap the root so every blob file's getFile throws (verify fails), and removal of blobs throws.
    const broken = (dir: OpfsDirectoryHandle): OpfsDirectoryHandle => ({
      kind: 'directory',
      name: dir.name,
      getDirectoryHandle: async (n, o) => broken(await dir.getDirectoryHandle(n, o)),
      getFileHandle: async (n, o) => {
        const handle = await dir.getFileHandle(n, o);
        return /^[0-9a-f]{64}$/.test(n)
          ? {
              ...handle,
              kind: 'file',
              name: handle.name,
              getFile: async () => {
                throw new Error('read failed');
              },
            }
          : handle;
      },
      removeEntry: async (n, o) => {
        if (/^[0-9a-f]{64}$/.test(n)) throw new Error('remove failed');
        return dir.removeEntry(n, o);
      },
      entries: () => dir.entries(),
    });
    const reopened = await openBlobStore(broken(root));
    expect(await reopened.list()).toEqual([good.sha256]);
    expect(await tmpEntries(root)).toEqual([]);
  });
});

describe('names and capabilities', () => {
  test('only valid lowercase 64-hex names ever reach the file system', async () => {
    const root = createMemoryDirectory();
    const store = await openBlobStore(root);
    await store.put(enc('abc'));
    const invalid = [
      '',
      '../etc/passwd',
      `../${ABC}`,
      `${ABC}/..`,
      `${ABC}.tmp`,
      ABC.toUpperCase(),
      ABC.slice(1),
      `${ABC}0`,
      'ba/' + ABC.slice(3),
      'C:\\' + ABC,
      '/' + ABC,
      'tmp',
    ];
    const calls: ((s: string) => Promise<unknown>)[] = [
      (s) => store.has(s),
      (s) => store.open(s),
      (s) => store.size(s),
      (s) => store.delete(s),
      (s) => store.verify(s),
    ];
    for (const name of invalid) {
      for (const call of calls) {
        await expect(call(name), JSON.stringify(name)).rejects.toBeInstanceOf(BlobStoreError);
        await expect(call(name)).rejects.toMatchObject({ code: 'invalid-hash' });
      }
    }
    expect(await store.list()).toEqual([ABC]);
  });

  test('list ignores strays that are not blobs', async () => {
    const root = createMemoryDirectory();
    const store = await openBlobStore(root);
    await store.put(enc('abc'));
    const base = await root.getDirectoryHandle(BLOBS_DIRECTORY);
    const shard = await base.getDirectoryHandle('ba');
    await shard.getFileHandle('notes.txt', { create: true });
    await shard.getFileHandle(`ff${ABC.slice(2)}`, { create: true }); // right shape, wrong shard
    await base.getFileHandle('loose-file', { create: true });
    await base.getDirectoryHandle('zz', { create: true });
    expect(await store.list()).toEqual([ABC]);
  });

  test('a browser that can neither createWritable nor createSyncAccessHandle fails with a clear error', async () => {
    const root = createMemoryDirectory({ writable: false, syncAccess: false });
    const store: BlobStore = await openBlobStore(root);
    await expect(store.put(enc('abc'))).rejects.toMatchObject({ code: 'unsupported' });
    expect(await tmpEntries(root)).toEqual([]);
  });

  test('two stores over the same directory see the same blobs (persistence across opens)', async () => {
    const root = createMemoryDirectory();
    await (await openBlobStore(root)).put(enc('abc'));
    expect(await (await openBlobStore(root)).has(ABC)).toBe(true);
  });
});
