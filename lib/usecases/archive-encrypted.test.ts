import { describe, expect, test } from 'vitest';
import { createProfile } from '../db/queries';
import { ArchiveError } from '../exporters/archive/format';
import { replaceLibraryFromBackup, restoreArchiveFromZip, exportArchiveFromLibrary } from './archive-backup';
import { verifyBackupFile } from './archive-health';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
const NOW = '2026-01-01T00:00:00Z';
const ANA = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const BEN = '4a2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5c';
const PASSWORD = 'pässword 日本';
const AT = new Date('2026-05-06T00:00:00Z');

async function populated(id: string, name: string): Promise<Lib> {
  const lib = await createTestLibrary();
  createProfile(lib.opened.db, { id, displayName: name, now: NOW });
  const { sha256, size } = await lib.deps.blobStore.put(new Uint8Array(3000).map((_, i) => (i * 7) % 251));
  lib.opened.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
  return lib;
}
const names = (lib: Lib) => lib.opened.db.all<{ display_name: string }>('SELECT display_name FROM profiles').map((r) => r.display_name);
const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ArchiveError);
  return (error as ArchiveError).code;
};

describe('encrypted backups through the use cases', () => {
  test('export marks plain vs encrypted, names the file, and restore round-trips', async () => {
    const source = await populated(ANA, 'Ana');
    const plain = await exportArchiveFromLibrary(source.deps, { appVersion: '1', now: AT });
    expect(plain).toMatchObject({ encrypted: false, fileName: 'memory-archive-2026-05-06.zip' });
    const progress: number[] = [];
    const sealed = await exportArchiveFromLibrary(source.deps, { appVersion: '1', now: AT, password: PASSWORD, onCryptoProgress: (p) => progress.push(p.done) });
    expect(sealed).toMatchObject({ encrypted: true, fileName: 'memory-archive-2026-05-06.mabackup', blobCount: 1 });
    expect(progress.at(-1)).toBe(plain.blob.size);
    expect(await codeOf(exportArchiveFromLibrary(source.deps, { appVersion: '1', password: '' }))).toBe('password-required');

    const target = await createTestLibrary();
    expect(await codeOf(restoreArchiveFromZip(target.deps, sealed.blob))).toBe('password-required');
    expect(await codeOf(restoreArchiveFromZip(target.deps, sealed.blob, { password: 'nope' }))).toBe('wrong-password');
    expect(names(target)).toEqual([]);
    expect(await target.deps.blobStore.list()).toEqual([]);
    // NFD of the same password also opens it.
    await restoreArchiveFromZip(target.deps, sealed.blob, { password: PASSWORD.normalize('NFD') });
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toHaveLength(1);
  }, 30_000);

  test('an empty library encrypts and restores', async () => {
    const empty = await createTestLibrary();
    const sealed = await exportArchiveFromLibrary(empty.deps, { appVersion: '1', password: PASSWORD });
    const target = await createTestLibrary();
    await restoreArchiveFromZip(target.deps, sealed.blob, { password: PASSWORD });
    expect(names(target)).toEqual([]);
  });

  test('a damaged encrypted backup is integrity and changes nothing; a password for a plain file is ignored', async () => {
    const source = await populated(ANA, 'Ana');
    const sealed = (await exportArchiveFromLibrary(source.deps, { appVersion: '1', password: PASSWORD })).blob;
    const bytes = new Uint8Array(await sealed.arrayBuffer());
    const target = await createTestLibrary();
    expect(await codeOf(restoreArchiveFromZip(target.deps, new Blob([bytes.slice(0, bytes.length - 40)])), )).toBe('password-required');
    expect(await codeOf(restoreArchiveFromZip(target.deps, new Blob([bytes.slice(0, bytes.length - 40)]), { password: PASSWORD }))).toBe('integrity');
    expect(names(target)).toEqual([]);
    const plain = (await exportArchiveFromLibrary(source.deps, { appVersion: '1' })).blob;
    await restoreArchiveFromZip(target.deps, plain, { password: 'unused' });
    expect(names(target)).toEqual(['Ana']);
  }, 30_000);

  test('verifyBackupFile: password-required, wrong-password, ok with the password, integrity when cut', async () => {
    const source = await populated(ANA, 'Ana');
    const sealed = (await exportArchiveFromLibrary(source.deps, { appVersion: '1', password: PASSWORD })).blob;
    expect(await verifyBackupFile(sealed)).toMatchObject({ ok: false, refusal: 'password-required' });
    expect(await verifyBackupFile(sealed, { password: 'nope' })).toMatchObject({ ok: false, refusal: 'wrong-password' });
    expect(await verifyBackupFile(sealed.slice(0, sealed.size - 20), { password: PASSWORD })).toMatchObject({ ok: false, refusal: 'integrity' });
    const good = await verifyBackupFile(sealed, { password: PASSWORD });
    expect(good).toMatchObject({ ok: true, encrypted: true, totalEntries: 2, checkedEntries: 2 });
    const plain = await verifyBackupFile((await exportArchiveFromLibrary(source.deps, { appVersion: '1' })).blob);
    expect(plain.ok).toBe(true);
    expect(plain.encrypted).toBeUndefined();
  }, 30_000);

  test('replaceLibraryFromBackup opens an encrypted backup; the safety backup is plain', async () => {
    const source = await populated(BEN, 'Ben');
    const sealed = (await exportArchiveFromLibrary(source.deps, { appVersion: '1', password: PASSWORD })).blob;
    const target = await populated(ANA, 'Ana');
    const base = { appVersion: '1', now: AT, deliverSafetyBackup: async () => {} };
    expect(await codeOf(replaceLibraryFromBackup(target.deps, sealed, base))).toBe('password-required');
    expect(await codeOf(replaceLibraryFromBackup(target.deps, sealed, { ...base, password: 'nope' }))).toBe('wrong-password');
    expect(names(target)).toEqual(['Ana']);
    let safety: { name: string } | undefined;
    await replaceLibraryFromBackup(target.deps, sealed, { ...base, password: PASSWORD, deliverSafetyBackup: async (_b, name) => void (safety = { name }) });
    expect(names(target)).toEqual(['Ben']);
    expect(safety?.name).toBe('memory-archive-2026-05-06.zip');
  }, 30_000);
});
