import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, test } from 'vitest';
import { DB_PATH, MANIFEST_PATH, blobPath } from '../exporters/archive/format';
import { sha256Hex } from '../domain/sha256';
import { BLOBS_DIRECTORY } from '../storage/opfs-blob-store';
import type { OpfsDirectoryHandle } from '../storage/opfs-blob-store';
import { exportArchiveFromLibrary } from './archive-backup';
import { getArchiveUsage, verifyBackupFile, verifyLibraryIntegrity } from './archive-health';
import { createTestLibrary } from './test-client';

const PHOTO = new Uint8Array(3000).map((_, i) => (i * 7) % 251);
const CLIP = new Uint8Array(1500).map((_, i) => (i * 11) % 241);
const PROFILE = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const CONVERSATION = '4f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const BATCH = '5f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';

/** A library with two stored files used by messages and a profile photo that reuses the first. */
async function seeded() {
  const lib = await createTestLibrary();
  const db = lib.opened.db;
  const photo = await lib.deps.blobStore.put(PHOTO);
  const clip = await lib.deps.blobStore.put(CLIP);
  for (const b of [photo, clip]) db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [b.sha256, b.size]);
  db.run("INSERT INTO profiles (id, display_name, created_at, updated_at, photo_sha256) VALUES (?, 'Ana', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)", [PROFILE, photo.sha256]);
  db.run("INSERT INTO conversations (id, title, source, created_at) VALUES (?, 'Chat', 'whatsapp', '2026-01-01T00:00:00Z')", [CONVERSATION]);
  db.run("INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, 'whatsapp', '2026-01-01T00:00:00Z')", [BATCH, CONVERSATION]);
  const message = (n: number, type: string, sha: string | null) =>
    db.run(
      `INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, ordinal, type, media_sha256) VALUES (?, ?, ?, '2026-01-01T10:00:00', ?, ?, ?)`,
      [CONVERSATION, BATCH, n.toString(16).padStart(64, '0'), n, type, sha],
    );
  message(1, 'photo', photo.sha256);
  message(2, 'video', clip.sha256);
  message(3, 'text', null);
  return { ...lib, photo, clip };
}

async function overwrite(root: OpfsDirectoryHandle, sha: string, bytes: Uint8Array): Promise<void> {
  const shard = await (await root.getDirectoryHandle(BLOBS_DIRECTORY)).getDirectoryHandle(sha.slice(0, 2));
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

describe('verifyLibraryIntegrity', () => {
  test('an intact library reports ok with progress, and changes nothing', async () => {
    const lib = await seeded();
    const before = await lib.deps.blobStore.list();
    const steps: number[] = [];
    const result = await verifyLibraryIntegrity(lib.deps, { onProgress: (p) => steps.push(p.done) });
    expect(result).toEqual({ ok: true, checkedFiles: 2, checkedBytes: PHOTO.length + CLIP.length, problemCount: 0, countsByKind: {}, problems: [] });
    expect(steps).toEqual([0, 1, 2]);
    expect(await lib.deps.blobStore.list()).toEqual(before);
  });

  test('an empty library is ok', async () => {
    const lib = await createTestLibrary();
    await expect(verifyLibraryIntegrity(lib.deps)).resolves.toMatchObject({ ok: true, checkedFiles: 0 });
  });

  test('a corrupted file (same size) is a hash mismatch, a truncated one a wrong size, a deleted one missing', async () => {
    const lib = await seeded();
    const flipped = PHOTO.slice();
    flipped[0] ^= 0xff;
    await overwrite(lib.root, lib.photo.sha256, flipped);
    await overwrite(lib.root, lib.clip.sha256, CLIP.slice(0, 10));
    const a = await verifyLibraryIntegrity(lib.deps);
    expect(a.ok).toBe(false);
    expect(a.problems).toEqual(
      expect.arrayContaining([
        { kind: 'hash-mismatch', sha256: lib.photo.sha256 },
        { kind: 'wrong-size', sha256: lib.clip.sha256, expected: CLIP.length, actual: 10 },
      ]),
    );
    await lib.deps.blobStore.delete(lib.photo.sha256);
    const b = await verifyLibraryIntegrity(lib.deps);
    expect(b.problems).toContainEqual({ kind: 'missing-file', sha256: lib.photo.sha256 });
    expect(b.problemCount).toBe(2);
    expect(b.countsByKind).toEqual({ 'missing-file': 1, 'wrong-size': 1 });
    // Read-only: the damaged file is still as it was.
    expect(await lib.deps.blobStore.size(lib.clip.sha256)).toBe(10);
  });

  test('references to a hash without a blobs row are reported (and counted past the cap)', async () => {
    const lib = await seeded();
    const db = lib.opened.db;
    db.exec('PRAGMA foreign_keys = OFF');
    const ghost = 'ab'.repeat(32);
    db.run('UPDATE messages SET media_sha256 = ? WHERE ordinal = 3', [ghost]);
    db.run('UPDATE profiles SET photo_sha256 = ?', [ghost]);
    const result = await verifyLibraryIntegrity(lib.deps);
    expect(result.ok).toBe(false);
    expect(result.problemCount).toBe(2);
    expect(result.countsByKind).toEqual({ 'dangling-reference': 2 });
    expect(result.problems).toEqual([
      { kind: 'dangling-reference', source: 'message', id: expect.any(Number), sha256: ghost },
      { kind: 'dangling-reference', source: 'profile-photo', id: PROFILE, sha256: ghost },
    ]);
  });

  test('the list of problems is capped, the count is not', async () => {
    const lib = await createTestLibrary();
    for (let i = 0; i < 130; i++) {
      const sha = i.toString(16).padStart(64, '0');
      lib.opened.db.run('INSERT INTO blobs (sha256, size) VALUES (?, 5)', [sha]);
    }
    const result = await verifyLibraryIntegrity(lib.deps);
    expect(result.problemCount).toBe(130);
    expect(result.countsByKind).toEqual({ 'missing-file': 130 });
    expect(result.problems).toHaveLength(100);
  });

  test('an abort stops between files and rejects with the reason; the guard is released', async () => {
    const lib = await seeded();
    const controller = new AbortController();
    const reason = new Error('stop');
    await expect(
      verifyLibraryIntegrity(lib.deps, { signal: controller.signal, onProgress: (p) => p.done === 1 && controller.abort(reason) }),
    ).rejects.toBe(reason);
    await expect(verifyLibraryIntegrity(lib.deps)).resolves.toMatchObject({ ok: true });
  });

  test('refuses while another archive operation runs', async () => {
    const lib = await seeded();
    const first = verifyLibraryIntegrity(lib.deps);
    await expect(verifyLibraryIntegrity(lib.deps)).rejects.toMatchObject({ code: 'busy' });
    await first;
  });
});

describe('verifyBackupFile', () => {
  async function backup() {
    const lib = await seeded();
    const { blob } = await exportArchiveFromLibrary(lib.deps, { appVersion: '1.2.3', now: new Date('2026-05-06T00:00:00Z') });
    return { lib, blob, parts: unzipSync(new Uint8Array(await blob.arrayBuffer())) as Record<string, Uint8Array> };
  }
  const zipped = (parts: Record<string, Uint8Array>, edit?: (m: Record<string, unknown>) => void): Blob => {
    const files: Zippable = {};
    for (const [name, data] of Object.entries(parts)) {
      if (name === MANIFEST_PATH && edit) {
        const manifest = JSON.parse(new TextDecoder().decode(data));
        edit(manifest);
        files[name] = [strToU8(JSON.stringify(manifest)), { level: 6 }];
      } else files[name] = [data, { level: 0 }];
    }
    return new Blob([zipSync(files) as BlobPart]);
  };

  test('a good backup is ok and reports the manifest', async () => {
    const { blob } = await backup();
    const progress: number[] = [];
    const result = await verifyBackupFile(blob, { onProgress: (p) => progress.push(p.done) });
    expect(result).toMatchObject({ ok: true, formatVersion: 1, appVersion: '1.2.3', totalEntries: 3, checkedEntries: 3, problemCount: 0, problems: [] });
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  test('a tampered blob (same size) is a hash mismatch and the scan goes on', async () => {
    const { parts } = await backup();
    const photoPath = blobPath(sha256Hex(PHOTO));
    const bad = parts[photoPath].slice();
    bad[0] ^= 0xff;
    parts[photoPath] = bad;
    const dbBad = parts[DB_PATH].slice();
    dbBad[dbBad.length - 1] ^= 1;
    parts[DB_PATH] = dbBad;
    const result = await verifyBackupFile(zipped(parts));
    expect(result.ok).toBe(false);
    expect(result.checkedEntries).toBe(3);
    expect(result.problems).toEqual([
      { kind: 'hash-mismatch', entry: 'database', sha256: expect.any(String) },
      { kind: 'hash-mismatch', entry: 'blob', sha256: sha256Hex(PHOTO) },
    ]);
  });

  test('a tampered manifest hash is a hash mismatch', async () => {
    const { parts } = await backup();
    const result = await verifyBackupFile(
      zipped(parts, (m) => {
        const entry = (m.entries as { path: string; sha256: string }[]).find((e) => e.path === DB_PATH)!;
        entry.sha256 = '0'.repeat(64);
      }),
    );
    expect(result).toMatchObject({ ok: false, problems: [{ kind: 'hash-mismatch', entry: 'database' }] });
  });

  test('a blob whose size differs from the manifest is refused as entry data, not restored', async () => {
    const { parts } = await backup();
    const path = blobPath(sha256Hex(PHOTO));
    parts[path] = parts[path].slice(0, 10);
    expect(await verifyBackupFile(zipped(parts))).toMatchObject({ ok: false, refusal: 'integrity' });
  });

  test('a truncated ZIP, a non-ZIP and an empty file are refused as not-an-archive', async () => {
    const { blob } = await backup();
    expect(await verifyBackupFile(blob.slice(0, blob.size - 40))).toMatchObject({ ok: false, refusal: 'not-an-archive', problems: [] });
    expect(await verifyBackupFile(new Blob(['nope']))).toMatchObject({ ok: false, refusal: 'not-an-archive' });
    expect(await verifyBackupFile(new Blob([]))).toMatchObject({ ok: false, refusal: 'not-an-archive' });
  });

  test('manifest problems: missing, newer format, newer schema, unsafe path, unlisted and absent entries', async () => {
    const { parts } = await backup();
    const noManifest = { ...parts };
    delete noManifest[MANIFEST_PATH];
    expect(await verifyBackupFile(zipped(noManifest))).toMatchObject({ refusal: 'invalid-manifest' });
    expect(await verifyBackupFile(zipped(parts, (m) => (m.formatVersion = 99)))).toMatchObject({ refusal: 'newer-format' });
    expect(await verifyBackupFile(zipped(parts, (m) => (m.schemaVersion = 9999)))).toMatchObject({ refusal: 'newer-schema' });
    expect(await verifyBackupFile(zipped({ ...parts, '../evil': strToU8('x') }))).toMatchObject({ refusal: 'unsafe-path' });
    expect(await verifyBackupFile(zipped({ ...parts, 'extra.txt': strToU8('x') }))).toMatchObject({ refusal: 'entry-mismatch' });
    const missing = { ...parts };
    delete missing[blobPath(sha256Hex(CLIP))];
    expect(await verifyBackupFile(zipped(missing))).toMatchObject({ refusal: 'entry-mismatch' });
  });

  test('limits bound the work: too many entries is refused before any entry is read', async () => {
    const { blob } = await backup();
    expect(await verifyBackupFile(blob, { limits: { maxEntries: 2 } })).toMatchObject({ ok: false, refusal: 'limit-exceeded' });
  });

  test('an abort rejects with the reason', async () => {
    const { blob } = await backup();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(verifyBackupFile(blob, { signal: controller.signal })).rejects.toThrow('stop');
  });

  test('verifying never touches the library', async () => {
    const { lib, blob } = await backup();
    const before = await lib.deps.blobStore.list();
    await verifyBackupFile(blob);
    expect(await lib.deps.blobStore.list()).toEqual(before);
    expect(lib.opened.db.all('SELECT count(*) AS n FROM messages')).toEqual([{ n: 3 }]);
  });
});

describe('getArchiveUsage', () => {
  const storage = {
    estimate: async () => ({ usage: 5000, quota: 100000 }),
    persisted: async () => true,
  } as unknown as StorageManager;

  test('counts, bytes per kind and the browser status', async () => {
    const lib = await seeded();
    const usage = await getArchiveUsage(lib.deps, storage);
    expect(usage.counts).toEqual({ profiles: 1, conversations: 1, messages: 3, mediaFiles: 2 });
    expect(usage.bytes.media).toBe(PHOTO.length + CLIP.length);
    expect(usage.bytes.database).toBeGreaterThan(0);
    expect(usage.bytes.thumbnails).toBe(0);
    expect(usage.bytes.searchIndex).toBe(0);
    expect(usage.libraryEmpty).toBe(false);
    expect(usage.device).toEqual({ usage: 5000, quota: 100000, persisted: true });
  });

  test('the search index and thumbnails count once they exist; an unsupported browser gives nulls', async () => {
    const lib = await seeded();
    await lib.deps.client.call('stepSearchIndex', {});
    const usage = await getArchiveUsage(lib.deps, undefined);
    expect(usage.bytes.searchIndex).toBeGreaterThan(0);
    expect(usage.device).toEqual({ usage: null, quota: null, persisted: null });
  });

  test('an empty library is all zeros', async () => {
    const lib = await createTestLibrary();
    const usage = await getArchiveUsage(lib.deps, storage);
    expect(usage.counts).toEqual({ profiles: 0, conversations: 0, messages: 0, mediaFiles: 0 });
    expect(usage.bytes.media).toBe(0);
    expect(usage.libraryEmpty).toBe(true);
  });
});
