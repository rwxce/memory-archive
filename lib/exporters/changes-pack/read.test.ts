import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../../domain/sha256';
import { verifyArchive } from '../archive/verify';
import { blobPath } from '../archive/format';
import { batchPath, recordPath } from './format';
import { openChangesPack, readPackLines, verifyChangesPack } from './read';
import { IDS, MEDIA_SHA, syntheticSource } from './test-pack';
import { writeChangesPack } from './write';

const SUPPORTED = 1_000;
const verify = (zip: Blob, limits = {}) => verifyChangesPack(zip, { supportedSchemaVersion: SUPPORTED, limits });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const good = async () => (await writeChangesPack(syntheticSource())).blob;

/** Rebuilds a pack from edited files; the manifest's sizes and hashes are recomputed unless told otherwise. */
async function repack(edit: (files: Record<string, Uint8Array>) => void, manifestPatch: Record<string, unknown> = {}, rehash = true, deflate = false): Promise<Blob> {
  const files = unzipSync(await bytesOf(await good()));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  edit(files);
  if (rehash) {
    manifest.entries = Object.entries(files)
      .filter(([name]) => name !== 'manifest.json')
      .map(([path, data]) => ({ path, size: data.length, sha256: sha256Hex(data) }));
  }
  Object.assign(manifest, manifestPatch);
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const out: Zippable = {};
  for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name === 'manifest.json' || deflate ? 6 : 0 }];
  return new Blob([zipSync(out) as BlobPart]);
}

describe('verifyChangesPack', () => {
  test('a pack the writer made verifies, with the counts it found', async () => {
    const result = await verify(await good());
    expect(result).toMatchObject({ ok: true, problems: [], found: { profiles: 1, conversations: 1, batches: 1, messages: 2, favorites: 1, notes: 1, tombstones: 1, blobs: 1 } });
    expect(result.manifest?.kind).toBe('changes');
  });

  test('not a pack at all: random bytes, a truncated pack, a backup-shaped manifest', async () => {
    expect(await verify(new Blob(['not a zip']))).toMatchObject({ ok: false, refusal: 'not-an-archive' });
    const bytes = await bytesOf(await good());
    expect(await verify(new Blob([bytes.slice(0, bytes.length - 30) as BlobPart]))).toMatchObject({ ok: false, refusal: 'not-an-archive' });
  });

  test('a pack and a backup refuse each other with a clear error', async () => {
    const asBackup = await verifyArchive(await good(), { supportedSchemaVersion: SUPPORTED });
    expect(asBackup).toMatchObject({ ok: false, refusal: 'invalid-manifest' });
    const zip = await repack(() => undefined, { format: 'memory-archive' });
    expect(await verify(zip)).toMatchObject({ ok: false, refusal: 'invalid-manifest' });
  });

  test('newer format and newer schema are refused', async () => {
    expect(await verify(await repack(() => undefined, { formatVersion: 2 }))).toMatchObject({ refusal: 'newer-format' });
    expect(await verify(await repack(() => undefined, { schemaVersion: SUPPORTED + 1 }))).toMatchObject({ refusal: 'newer-schema' });
  });

  test('hostile entry names are refused before anything is read', async () => {
    expect(await verify(await repack((f) => { f['../evil.jsonl'] = strToU8('{}\n'); }))).toMatchObject({ ok: false, refusal: 'unsafe-path' });
    expect(await verify(await repack((f) => { f['/abs.jsonl'] = strToU8('{}\n'); }))).toMatchObject({ ok: false, refusal: 'unsafe-path' });
    expect(await verify(await repack((f) => { f['C:/x'] = strToU8('x'); }))).toMatchObject({ ok: false, refusal: 'unsafe-path' });
  });

  test('an entry the manifest does not list, or lists but is missing, is refused', async () => {
    const extra = await repack((f) => { f['records/extra.jsonl'] = strToU8(''); }, {}, false);
    expect(await verify(extra)).toMatchObject({ refusal: 'entry-mismatch' });
    const missing = await repack((f) => { delete f[recordPath('notes')]; }, {}, false);
    expect(await verify(missing)).toMatchObject({ refusal: 'entry-mismatch' });
  });

  test('altered bytes (same size) are an integrity problem on that entry only', async () => {
    const files = unzipSync(await bytesOf(await good()));
    const manifestEntries = JSON.parse(new TextDecoder().decode(files['manifest.json'])).entries;
    const tampered = await repack((f) => { f[recordPath('profiles')] = f[recordPath('profiles')].map((b, i) => (i === 20 ? b ^ 1 : b)); f[blobPath(MEDIA_SHA)] = f[blobPath(MEDIA_SHA)].map((b, i) => (i === 0 ? b ^ 1 : b)); }, { entries: manifestEntries }, false);
    const result = await verify(tampered);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.entry, p.code]).sort()).toEqual([[blobPath(MEDIA_SHA), 'integrity'], [recordPath('profiles'), 'integrity']].sort());
  });

  test('an entry whose size differs from the manifest is refused', async () => {
    const files = unzipSync(await bytesOf(await good()));
    const entries = JSON.parse(new TextDecoder().decode(files['manifest.json'])).entries;
    entries[1].size += 1;
    expect(await verify(await repack(() => undefined, { entries }, false))).toMatchObject({ refusal: 'integrity' });
  });

  test('counts that disagree with the lines found are reported', async () => {
    const lying = await repack(() => undefined, { counts: { profiles: 0, conversations: 1, batches: 1, messages: 2, favorites: 1, notes: 1, tombstones: 1, blobs: 1 } });
    const result = await verify(lying);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ entry: 'manifest', code: 'count-mismatch' }]);
  });

  test('malformed records: bad JSON, a non-object, a blank line, no final newline, bad UTF-8, a giant line', async () => {
    for (const bad of ['{nope}\n', '[1]\n', '"x"\n', '{}\n\n', '{"a":1}', 'x'.repeat(5 * 1024 * 1024) + '\n', `{"a":"${'\u20ac'.repeat(1_500_000)}"}\n`]) {
      const result = await verify(await repack((f) => { f[recordPath('favorites')] = strToU8(bad); }));
      expect(result.problems).toContainEqual({ entry: recordPath('favorites'), code: 'integrity' });
    }
    const utf8 = await repack((f) => { f[recordPath('favorites')] = new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]); });
    expect((await verify(utf8)).problems).toContainEqual({ entry: recordPath('favorites'), code: 'integrity' });
  });

  test('a batch must start with a header carrying its own id', async () => {
    const wrong = await repack((f) => { f[batchPath(IDS.batch)] = strToU8(`${JSON.stringify({ id: IDS.target })}\n`); });
    expect((await verify(wrong)).problems).toContainEqual({ entry: batchPath(IDS.batch), code: 'integrity' });
    const empty = await repack((f) => { f[batchPath(IDS.batch)] = new Uint8Array(0); });
    expect((await verify(empty)).problems).toContainEqual({ entry: batchPath(IDS.batch), code: 'integrity' });
  });

  test('the blob records and the files under blobs/ must describe the same set', async () => {
    const result = await verify(await repack((f) => { f[recordPath('blobs')] = new Uint8Array(0); }));
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({ entry: 'records/blobs.jsonl', code: 'count-mismatch' });
  });

  test('limits apply: a zip bomb ratio, too many entries, an oversized entry', async () => {
    const bomb = await repack((f) => { f[recordPath('notes')] = new Uint8Array(3 * 1024 * 1024); }, {}, true, true);
    expect(await verify(bomb)).toMatchObject({ ok: false, refusal: 'limit-exceeded' });
    expect(await verify(await good(), { maxEntries: 3 })).toMatchObject({ ok: false, refusal: 'limit-exceeded' });
    expect(await verify(await good(), { maxEntryBytes: 10 })).toMatchObject({ ok: false, refusal: 'limit-exceeded' });
  });

  test('aborting stops the scan with the signal\'s reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(verifyChangesPack(await good(), { supportedSchemaVersion: SUPPORTED, signal: controller.signal })).rejects.toThrow('stop');
  });
});

describe('readPackLines', () => {
  test('refuses a path that is not a record file of the pack', async () => {
    const zip = await good();
    const opened = await openChangesPack(zip, { supportedSchemaVersion: SUPPORTED });
    await expect(readPackLines(zip, opened, blobPath(MEDIA_SHA)).next()).rejects.toMatchObject({ code: 'entry-mismatch' });
    await expect(readPackLines(zip, opened, 'records/profiles.jsonl/x').next()).rejects.toMatchObject({ code: 'entry-mismatch' });
  });

  test('yields one object per line and throws at the end when the hash is wrong', async () => {
    const files = unzipSync(await bytesOf(await good()));
    const entries = JSON.parse(new TextDecoder().decode(files['manifest.json'])).entries;
    const zip = await repack((f) => { f[recordPath('tombstones')] = f[recordPath('tombstones')].map((b, i) => (i === 12 ? b ^ 1 : b)); }, { entries }, false);
    const opened = await openChangesPack(zip, { supportedSchemaVersion: SUPPORTED });
    const seen: unknown[] = [];
    await expect((async () => { for await (const line of readPackLines(zip, opened, recordPath('tombstones'))) seen.push(line); })()).rejects.toMatchObject({ code: 'integrity' });
    const profiles: unknown[] = [];
    for await (const line of readPackLines(zip, opened, recordPath('profiles'))) profiles.push(line);
    expect(profiles).toHaveLength(1);
  });
});
