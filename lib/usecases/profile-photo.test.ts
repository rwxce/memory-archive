import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { webpBlob } from '../storage/test-thumbnail';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import { sweepOrphanBlobs } from './import';
import { createProfile } from './profiles';
import { getProfilePhoto, PROFILE_PHOTO_MAX_INPUT_BYTES, PROFILE_PHOTO_MAX_SIDE, removeProfilePhoto, setProfilePhoto, type DownscaleImage } from './profile-photo';
import { createTestLibrary } from './test-client';

const source = new Blob([new Uint8Array(100).fill(9)], { type: 'image/png' });
/** A stand-in for the browser downscaler: a distinct synthetic webp per input byte. */
const fakeDownscale: DownscaleImage = async (image) => webpBlob(60, new Uint8Array(await image.arrayBuffer())[0] ?? 1);
const picture = (fill: number) => new Blob([new Uint8Array(100).fill(fill)], { type: 'image/png' });

async function setup() {
  const lib = await createTestLibrary();
  const profile = await createProfile(lib.deps, { displayName: 'Ana' });
  return { ...lib, profile };
}

describe('profile photo', () => {
  test('stores a downscaled content-addressed copy, never the original, and reads it back typed', async () => {
    const { deps, opened, profile } = await setup();
    let seen = 0;
    const updated = await setProfilePhoto(deps, profile.id, source, async (image, maxSide) => {
      seen = maxSide;
      return fakeDownscale(image, maxSide);
    });
    expect(seen).toBe(PROFILE_PHOTO_MAX_SIDE);
    expect(updated.photoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.db.all('SELECT sha256, size, mime FROM blobs')).toEqual([{ sha256: updated.photoSha256, size: 60, mime: 'image/webp' }]);
    expect(await deps.blobStore.list()).toEqual([updated.photoSha256]);
    const photo = await getProfilePhoto(deps, profile.id);
    expect(photo?.type).toBe('image/webp');
    expect(photo?.size).toBe(60);
  });

  test('the same picture twice is one file; replacing releases the old file and its row', async () => {
    const { deps, opened, profile } = await setup();
    const a = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    const again = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    expect(again.photoSha256).toBe(a.photoSha256);
    expect(await deps.blobStore.list()).toEqual([a.photoSha256]);
    await deps.thumbStore?.put(a.photoSha256!, 320, webpBlob(40));
    const b = await setProfilePhoto(deps, profile.id, picture(2), fakeDownscale);
    expect(b.photoSha256).not.toBe(a.photoSha256);
    expect(await deps.blobStore.list()).toEqual([b.photoSha256]);
    expect(opened.db.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: b.photoSha256 }]);
    expect(await deps.thumbStore?.list()).toEqual([]);
  });

  test('a photo another profile still uses is kept when one profile replaces or removes it', async () => {
    const { deps, profile } = await setup();
    const other = await createProfile(deps, { displayName: 'Bo' });
    const shared = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    await setProfilePhoto(deps, other.id, picture(1), fakeDownscale);
    await removeProfilePhoto(deps, profile.id);
    expect(await deps.blobStore.has(shared.photoSha256!)).toBe(true);
    await removeProfilePhoto(deps, other.id);
    expect(await deps.blobStore.list()).toEqual([]);
  });

  test('a photo that a chat message also uses is kept when the profile photo goes', async () => {
    const { deps, opened, profile } = await setup();
    const p = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    const sha256 = p.photoSha256!;
    const c = '00000000-0000-4000-8000-0000000000c1';
    opened.db.run("INSERT INTO conversations (id, title, source, created_at) VALUES (?, 'T', 'whatsapp', 't')", [c]);
    opened.db.run("INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, 'whatsapp', 't')", [c, c]);
    opened.db.run("INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type, media_sha256) VALUES (?, ?, ?, '2026-01-01T00:00:00', 'photo', ?)", [c, c, 'a'.repeat(64), sha256]);
    await removeProfilePhoto(deps, profile.id);
    expect(await deps.blobStore.has(sha256)).toBe(true);
    expect(opened.db.all('SELECT sha256 FROM blobs')).toEqual([{ sha256 }]);
  });

  test('removing is idempotent and a profile without a photo reads null', async () => {
    const { deps, profile } = await setup();
    expect(await getProfilePhoto(deps, profile.id)).toBeNull();
    expect(await removeProfilePhoto(deps, profile.id)).toMatchObject({ photoSha256: null });
    await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    expect((await removeProfilePhoto(deps, profile.id)).photoSha256).toBeNull();
    expect((await removeProfilePhoto(deps, profile.id)).photoSha256).toBeNull();
    expect(await getProfilePhoto(deps, profile.id)).toBeNull();
  });

  test('refuses what is not a usable picture and leaves nothing behind', async () => {
    const { deps, profile } = await setup();
    await expect(setProfilePhoto(deps, profile.id, new Blob([]), fakeDownscale)).rejects.toMatchObject({ code: 'invalid' });
    await expect(setProfilePhoto(deps, profile.id, source, async () => undefined)).rejects.toMatchObject({ code: 'invalid' });
    const huge = { size: PROFILE_PHOTO_MAX_INPUT_BYTES + 1 } as Blob;
    await expect(setProfilePhoto(deps, profile.id, huge, fakeDownscale)).rejects.toMatchObject({ code: 'invalid' });
    // no browser APIs here (node): the default downscaler gives undefined
    await expect(setProfilePhoto(deps, profile.id, source)).rejects.toMatchObject({ code: 'invalid' });
    expect(await deps.blobStore.list()).toEqual([]);
  });

  test('an unknown profile is not-found and the new bytes are not kept; a guard is released after failure', async () => {
    const { deps, profile } = await setup();
    const missing = '99999999-9999-4999-8999-999999999999';
    await expect(setProfilePhoto(deps, missing, picture(1), fakeDownscale)).rejects.toMatchObject({ code: 'not-found' });
    expect(await deps.blobStore.list()).toEqual([]);
    await expect(removeProfilePhoto(deps, missing)).rejects.toMatchObject({ code: 'not-found' });
    await expect(setProfilePhoto(deps, profile.id, picture(1), fakeDownscale)).resolves.toBeTruthy();
  });

  test('a failed change keeps the previous photo, and does not delete a file that was already stored', async () => {
    const { deps, profile } = await setup();
    const a = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    const failing = { ...deps, client: { call: async () => { throw new (await import('../db/errors')).DbError('constraint', 'no'); } } } as typeof deps;
    await expect(setProfilePhoto(failing, profile.id, picture(1), fakeDownscale)).rejects.toMatchObject({ code: 'constraint' });
    expect(await deps.blobStore.has(a.photoSha256!)).toBe(true);
    expect((await getProfilePhoto(deps, profile.id))?.size).toBe(60);
    await expect(setProfilePhoto(failing, profile.id, picture(2), fakeDownscale)).rejects.toMatchObject({ code: 'constraint' });
    expect(await deps.blobStore.list()).toEqual([a.photoSha256]);
  });

  test('a lost file reads as no photo; the orphan sweep keeps the photo and removes a stray file', async () => {
    const { deps, profile } = await setup();
    const a = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    const stray = await deps.blobStore.put(new Uint8Array(5).fill(7));
    expect(await sweepOrphanBlobs(deps)).toEqual({ removed: 1 });
    expect(await deps.blobStore.list()).toEqual([a.photoSha256]);
    await deps.blobStore.delete(a.photoSha256!);
    expect(await getProfilePhoto(deps, profile.id)).toBeNull();
    expect(stray.sha256).toBeTruthy();
  });

  test('the photo travels in the backup ZIP and comes back after a restore; a replaced one does not', async () => {
    const { deps, opened, profile } = await setup();
    const old = await setProfilePhoto(deps, profile.id, picture(1), fakeDownscale);
    const current = await setProfilePhoto(deps, profile.id, picture(2), fakeDownscale);
    const { blob, blobCount } = await exportArchive({ db: opened.db, blobStore: deps.blobStore }, { appVersion: '1' });
    expect(blobCount).toBe(1);
    const entries = Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())));
    expect(entries.filter((n) => n.startsWith('blobs/')).map((n) => n.split('/').pop())).toEqual([current.photoSha256]);
    const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['manifest.json']!)) as unknown;
    expect(JSON.stringify(manifest)).toContain(current.photoSha256!);
    expect(JSON.stringify(manifest)).not.toContain(old.photoSha256!);

    const target = await createTestLibrary();
    const restored = { db: target.opened.db, blobStore: target.deps.blobStore };
    await restoreArchiveIntoEmptyLibrary(restored, blob);
    const photo = await getProfilePhoto(target.deps, profile.id);
    expect(photo?.type).toBe('image/webp');
    expect(photo?.size).toBe(60);
    expect(await target.deps.blobStore.verify(current.photoSha256!)).toBe('ok');
  });
});
