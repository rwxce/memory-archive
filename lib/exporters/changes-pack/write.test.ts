import { unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../../domain/sha256';
import { ArchiveError, DEFAULT_LIMITS, blobPath } from '../archive/format';
import { MAX_RECORD_LINE_BYTES, batchPath, recordPath } from './format';
import { IDS, MEDIA, MEDIA_SHA, MESSAGES, syntheticChangeSet, syntheticSource, unpack } from './test-pack';
import { writeChangesPack } from './write';

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ArchiveError);
  return (error as ArchiveError).code;
};

describe('writeChangesPack', () => {
  test('layout: manifest first, six record files, batches, then blobs; the manifest lists size and hash of each', async () => {
    const { blob, manifest } = await writeChangesPack(syntheticSource());
    const files = unzipSync(await bytesOf(blob));
    expect(Object.keys(files)).toEqual([
      'manifest.json',
      ...['profiles', 'conversations', 'blobs', 'favorites', 'notes', 'tombstones'].map((n) => `records/${n}.jsonl`),
      batchPath(IDS.batch),
      blobPath(MEDIA_SHA),
    ]);
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json']))).toEqual(manifest);
    for (const item of manifest.entries) {
      expect(files[item.path].length).toBe(item.size);
      expect(sha256Hex(files[item.path])).toBe(item.sha256);
    }
    expect(manifest).toMatchObject({
      kind: 'changes', since: 4, upTo: 9, ack: 3, source: { deviceId: IDS.source }, target: { deviceId: IDS.target },
      counts: { profiles: 1, conversations: 1, batches: 1, messages: 2, favorites: 1, notes: 1, tombstones: 1, blobs: 1 },
    });
  });

  test('records are one JSON object per line, and messages follow the batch header', async () => {
    const { blob } = await writeChangesPack(syntheticSource());
    const { records, batches } = await unpack(blob);
    expect(records.blobs).toEqual([{ sha256: MEDIA_SHA, size: MEDIA.length, mime: 'image/jpeg' }]);
    expect(batches.get(IDS.batch)).toEqual([expect.objectContaining({ id: IDS.batch, conversationId: IDS.conversation }), ...MESSAGES]);
    const files = unzipSync(await bytesOf(blob));
    expect(new TextDecoder().decode(files[recordPath('tombstones')]).endsWith('}\n')).toBe(true);
  });

  test('an empty change set still writes every record file', async () => {
    const empty = syntheticChangeSet({ profiles: [], conversations: [], blobs: [], favorites: [], notes: [], tombstones: [], batches: [] });
    const { blob, manifest } = await writeChangesPack(syntheticSource(empty));
    expect(manifest.entries).toHaveLength(6);
    expect(manifest.entries.every((e) => e.size === 0)).toBe(true);
    expect(Object.keys(unzipSync(await bytesOf(blob)))).toHaveLength(7);
  });

  test('determinism: the same input gives the same bytes, whatever order the lists come in', async () => {
    const a = await writeChangesPack(syntheticSource());
    const shuffled = syntheticChangeSet();
    const second = { ...shuffled.batches[0], id: IDS.target, seq: 7 };
    const two = syntheticChangeSet({ batches: [second, shuffled.batches[0]] });
    const b = await writeChangesPack(syntheticSource());
    expect(sha256Hex(await bytesOf(a.blob))).toBe(sha256Hex(await bytesOf(b.blob)));
    const c = await writeChangesPack(syntheticSource(two));
    expect(c.manifest.entries.filter((e) => e.path.startsWith('batches/')).map((e) => e.path)).toEqual([batchPath(IDS.batch), batchPath(IDS.target)]);
  });

  test('refuses a pack that points at media it does not carry', async () => {
    const none = syntheticChangeSet({ blobs: [] });
    expect(await codeOf(writeChangesPack(syntheticSource(none)))).toBe('blob-missing');
    const photo = syntheticChangeSet();
    photo.profiles[0].photoSha256 = 'f'.repeat(64);
    expect(await codeOf(writeChangesPack(syntheticSource(photo)))).toBe('blob-missing');
    expect(await codeOf(writeChangesPack(syntheticSource(syntheticChangeSet({ blobs: [{ sha256: 'nope', size: 1, mime: null }] }))))).toBe('blob-missing');
  });

  test('a media file that is missing, truncated or altered aborts the export', async () => {
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { openBlob: async () => undefined })))).toBe('blob-missing');
    const stream = (bytes: Uint8Array) => async () => new Blob([bytes as BlobPart]).stream();
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { openBlob: stream(MEDIA.slice(1)) })))).toBe('integrity');
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { openBlob: stream(new Uint8Array([...MEDIA, 1])) })))).toBe('integrity');
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { openBlob: stream(MEDIA.map((b) => b ^ 1)) })))).toBe('integrity');
  });

  test('a record line over the byte limit fails with limit-exceeded; the limit counts bytes, not characters', async () => {
    const huge = syntheticChangeSet();
    huge.notes[0].body = 'x'.repeat(MAX_RECORD_LINE_BYTES + 1);
    expect(await codeOf(writeChangesPack(syntheticSource(huge)))).toBe('limit-exceeded');
    // 1.5M characters of 3 bytes each: short in UTF-16 units, 4.5 MB encoded
    const wide = syntheticChangeSet();
    wide.notes[0].body = '\u20ac'.repeat(1_500_000);
    expect(wide.notes[0].body.length).toBeLessThan(MAX_RECORD_LINE_BYTES);
    expect(await codeOf(writeChangesPack(syntheticSource(wide)))).toBe('limit-exceeded');
    // multi-byte text under the limit is fine, and the reader accepts it
    const fine = syntheticChangeSet();
    // varied (poorly compressible) 3-byte text, so the reader's zip-bomb guard stays out of the way
    fine.notes[0].body = Array.from({ length: 200_000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919 + (i >> 3) * 31) % 20_000))).join('');
    const { blob } = await writeChangesPack(syntheticSource(fine));
    expect((await unpack(blob)).records.notes).toHaveLength(1);
  }, 30_000);

  test('a message line over the limit fails the export too', async () => {
    const big = { ...MESSAGES[0], body: 'x'.repeat(MAX_RECORD_LINE_BYTES + 1) };
    const source = syntheticSource(undefined, { batchMessages: async function* () { yield [big]; } });
    expect(await codeOf(writeChangesPack(source))).toBe('limit-exceeded');
  });

  test('entries, total size, directory size and one file over the limits are refused before anything is handed over', async () => {
    const limits = { ...DEFAULT_LIMITS };
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { limits: { ...limits, maxEntryBytes: 100 } })))).toBe('limit-exceeded'); // a record file
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { limits: { ...limits, maxTotalBytes: 100 } })))).toBe('limit-exceeded');
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { limits: { ...limits, maxEntries: 5 } })))).toBe('limit-exceeded');
    expect(await codeOf(writeChangesPack(syntheticSource(undefined, { limits: { ...limits, maxCentralDirectoryBytes: 200 } })))).toBe('limit-exceeded');
    // a batch file larger than the entry bound, with the record files small enough
    const many = Array.from({ length: 50 }, (_, i) => ({ ...MESSAGES[0], body: `message number ${i} `.repeat(10) }));
    const source = syntheticSource(undefined, { batchMessages: async function* () { yield many; }, limits: { ...limits, maxEntryBytes: 1000 } });
    expect(await codeOf(writeChangesPack(source))).toBe('limit-exceeded');
  });

  test('reports media progress', async () => {
    const seen: number[] = [];
    await writeChangesPack(syntheticSource(undefined, { onProgress: (done, total) => seen.push(done * 10 + total) }));
    expect(seen).toEqual([11]);
  });
});
