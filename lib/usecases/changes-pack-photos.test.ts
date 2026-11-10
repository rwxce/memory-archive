import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, test } from 'vitest';
import { undoPhotoBatch } from '../db/photos';
import { unassignPhotos } from '../db/photo-assign';
import { currentChangeSeq } from '../db/sync';
import { getPeer } from '../db/sync';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import { sha256Hex } from '../domain/sha256';
import { IDS, MEDIA_SHA, PHOTO_ITEMS, syntheticChangeSet, syntheticSource, unpack } from '../exporters/changes-pack/test-pack';
import { writeChangesPack } from '../exporters/changes-pack/write';
import { exportChangesPack } from './changes-pack-export';
import { importChangesPack } from './changes-pack-import';
import { listPhotoBatches } from './photo-library';
import { createTestLibrary } from './test-client';
import { listSyncConflicts, resolveSyncConflict } from './sync-conflicts';
import { ANA, AT, BEN, PB1, PB2, PB3, addPhotos, assign, canon, count, dump, idOf, populated, send, type Lib } from './test-sync';

/** A library with two people and photos: PB1 (3 pictures, two assigned) and PB2 (1 picture from another source). */
async function withPhotos() {
  const lib = await populated();
  const trip = await addPhotos(lib, [21, 22, 23]);
  const loose = await addPhotos(lib, [24], { batchId: PB2, source: 'loose', album: '' });
  assign(lib, [trip[0], trip[1]], [ANA]);
  assign(lib, [trip[1]], [BEN]);
  return { lib, trip, loose };
}

const links = (lib: Lib) =>
  lib.opened.db.all<{ sha256: string; profile_id: string; changed_by: string | null }>('SELECT sha256, profile_id, changed_by FROM photo_profiles ORDER BY profile_id, sha256');

describe('photos travel in a changes pack', () => {
  test('A to B: items, media bytes and assignments arrive identical, as changes made by A', async () => {
    const { lib: a, trip, loose } = await withPhotos();
    const b = await createTestLibrary();
    const { pack, result } = await send(a, b);
    expect(pack.counts).toMatchObject({ photoBatches: 2, photoItems: 4, photoLinks: 3 });
    expect(result.counts).toMatchObject({ photoBatches: 2, photoItems: { added: 4, skipped: 0 }, photoLinks: { added: 3, removed: 0, dropped: 0 } });
    expect(await canon(b)).toEqual(await canon(a));
    // the pictures' bytes are really there, under their hashes
    for (const sha of [...trip, ...loose]) expect(await b.deps.blobStore.size(sha)).toBe(500);
    // a merged version is not a local edit
    const author = await idOf(a);
    expect(b.opened.db.all('SELECT DISTINCT changed_by FROM photo_batches')).toEqual([{ changed_by: author }]);
    expect(b.opened.db.all('SELECT DISTINCT changed_by FROM photo_profiles')).toEqual([{ changed_by: author }]);
    // history on B lists the imports under the same ids
    expect((await listPhotoBatches(b.deps)).map((x) => x.id).sort()).toEqual([PB1, PB2]);
  });

  test('importing the same pack twice changes nothing at all', async () => {
    const { lib: a } = await withPhotos();
    const b = await createTestLibrary();
    const { pack } = await send(a, b);
    const before = dump(b.opened.db);
    const again = await importChangesPack(b.deps, pack.blob);
    expect(again.counts).toMatchObject({ photoBatches: 0, photoItems: { added: 0 }, photoLinks: { added: 0, removed: 0, dropped: 0 } });
    expect(dump(b.opened.db)).toEqual(before);
  });

  test('a full pack after the changes pack adds nothing; a batch whose pictures are all there leaves no history entry', async () => {
    const { lib: a } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    const before = await canon(b);
    const full = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT });
    expect(full.kind).toBe('full');
    expect(await importChangesPack(b.deps, full.blob)).toMatchObject({ counts: { photoBatches: 0, photoItems: { added: 0 }, photoLinks: { added: 0 } } });
    expect(await canon(b)).toEqual(before);

    // The same album imported separately on C (another batch id, same pictures): A's batch brings nothing new.
    const c = await createTestLibrary();
    await addPhotos(c, [21, 22, 23], { batchId: PB3 });
    const { result } = await send(a, c);
    expect(result.counts).toMatchObject({ photoBatches: 1, photoItems: { added: 1, skipped: 3 } }); // only the loose picture is new
    expect(count(c, 'photo_batches')).toBe(2);
  });

  test('relay A to B to C reaches the same archive, and B does not hand A its own batches and links back', async () => {
    const { lib: a } = await withPhotos();
    const b = await createTestLibrary();
    const c = await createTestLibrary();
    await send(a, b);
    // echo rule: everything B holds came from A
    const back = await exportChangesPack(b.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(a) });
    expect((await unpack(back.blob)).manifest.counts).toMatchObject({ photoBatches: 0, photoItems: 0, photoLinks: 0, blobs: 0 });
    const withoutPeers = () => ({ ...dump(a.opened.db), sync_peers: [] });
    const aBefore = withoutPeers();
    await importChangesPack(a.deps, back.blob); // only the received watermark moves
    expect(withoutPeers()).toEqual(aBefore);

    await send(b, c);
    expect(await canon(c)).toEqual(await canon(a));
    expect(c.opened.db.all('SELECT DISTINCT changed_by FROM photo_profiles')).toEqual([{ changed_by: await idOf(b) }]);
  });

  test('later changes travel on their own: a new import, a new assignment, and the closure of a link to an old picture', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    const more = await addPhotos(a, [25], { batchId: PB3 });
    assign(a, [more[0], trip[2]], [BEN]); // trip[2] is an old picture B already holds
    const { pack, result } = await send(a, b);
    expect(pack.since).toBeGreaterThan(0);
    const unpacked = await unpack(pack.blob);
    expect([...unpacked.photoBatches.keys()]).toEqual([PB3]);
    expect(unpacked.blobHashes).toEqual(more); // the bytes of the new batch only, not of the old picture
    expect(unpacked.records['photo-links']).toHaveLength(2);
    expect(unpacked.records.profiles.map((p) => p.id)).toContain(BEN); // a link comes with its profile
    expect(result.counts).toMatchObject({ photoBatches: 1, photoItems: { added: 1 }, photoLinks: { added: 2, dropped: 0 } });
    expect(await canon(b)).toEqual(await canon(a));
  });

  test('a link travels with its profile even when only the link changed', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    assign(a, [trip[2]], [BEN]);
    const { pack } = await send(a, b);
    const { records } = await unpack(pack.blob);
    expect(records['photo-links']).toHaveLength(1);
    expect(records.profiles.map((p) => p.id)).toEqual([BEN]);
  });
});

describe('assignments: removal travels, crossed edits lose nothing', () => {
  test('unassigning on A removes the link on B, and the tombstone goes on to C', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    const c = await createTestLibrary();
    await send(a, b);
    await send(b, c);
    unassignPhotos(a.opened.db, { sha256s: [trip[1]], profileId: BEN });
    const { pack, result } = await send(a, b);
    expect((await unpack(pack.blob)).records.tombstones.map((t) => [t.kind, t.scope, t.key])).toEqual([['photo-link', BEN, trip[1]]]);
    expect(result.counts.photoLinks).toMatchObject({ removed: 1, added: 0 });
    expect(links(b).map((l) => [l.profile_id, l.sha256])).not.toContainEqual([BEN, trip[1]]);
    expect(await canon(b)).toEqual(await canon(a));
    await send(b, c);
    expect(await canon(c)).toEqual(await canon(a));
    expect(c.opened.db.all("SELECT changed_by FROM tombstones WHERE kind = 'photo-link'")).toEqual([{ changed_by: await idOf(b) }]);
  });

  test('crossed: A removes a link while B removes and re-adds it. The link stays on both, nothing is lost', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    unassignPhotos(a.opened.db, { sha256s: [trip[0]], profileId: ANA });
    unassignPhotos(b.opened.db, { sha256s: [trip[0]], profileId: ANA });
    assign(b, [trip[0]], [ANA], '2026-03-01T00:00:00Z');
    const toB = await send(a, b);
    expect(toB.result.counts.photoLinks.removed).toBe(0); // B changed it since A last saw it: add wins
    expect(links(b).map((l) => [l.profile_id, l.sha256])).toContainEqual([ANA, trip[0]]);
    await send(b, a);
    expect(links(a).map((l) => [l.profile_id, l.sha256])).toContainEqual([ANA, trip[0]]);
    expect(a.opened.db.all("SELECT * FROM tombstones WHERE kind = 'photo-link'")).toEqual([]);
    expect(await canon(a)).toEqual(await canon(b));
  });

  test('crossed the other way: B removed a link, A removed and added it again. The link comes back on B', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    unassignPhotos(b.opened.db, { sha256s: [trip[0]], profileId: ANA });
    unassignPhotos(a.opened.db, { sha256s: [trip[0]], profileId: ANA });
    assign(a, [trip[0]], [ANA], '2026-03-01T00:00:00Z');
    const { result } = await send(a, b);
    expect(result.counts.photoLinks.added).toBe(1);
    expect(b.opened.db.all("SELECT * FROM tombstones WHERE kind = 'photo-link'")).toEqual([]);
    expect(await canon(b)).toEqual(await canon(a));
  });

  test('a link whose picture this device does not hold is dropped, never stored', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    // C never saw A's batches: a later link to one of A's pictures reaches it alone (a changes pack, not a full one).
    const c = await createTestLibrary();
    await send(a, c);
    undoPhotoBatch(c.opened.db, PB1); // C undid that import on its own (and keeps its tombstone)
    assign(a, [trip[2]], [BEN]);
    const { result } = await send(a, c);
    expect(result.counts.photoLinks).toMatchObject({ added: 0, dropped: 1 });
    expect(count(c, 'photo_profiles')).toBe(0);
  });
});

describe('an undone photo import is offered, never applied', () => {
  async function undoneOnA() {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    const undone = undoPhotoBatch(a.opened.db, PB1);
    const { result, pack } = await send(a, b);
    return { a, b, trip, undone, result, pack };
  }

  test('B keeps everything and gets an offer that names the import and what B still holds', async () => {
    const { b, result, pack, trip } = await undoneOnA();
    expect((await unpack(pack.blob)).records.tombstones.map((t) => [t.kind, t.scope, t.key])).toEqual([['photo-batch', '', PB1]]);
    expect(result).toMatchObject({ batchOffers: 1, conflicts: 0 });
    expect(count(b, 'photo_batches')).toBe(2);
    expect(count(b, 'photo_profiles')).toBe(3);
    expect(await b.deps.blobStore.has(trip[0])).toBe(true);
    const offers = await listSyncConflicts(b.deps);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ kind: 'photo-batch', scope: '', key: PB1, incomingDeleted: true, matched: true, photoBatch: { sourceLabel: 'album.zip', items: 3 } });
    // nothing was recorded as deleted on B: the tombstone is only an offer
    expect(b.opened.db.all("SELECT * FROM tombstones WHERE kind = 'photo-batch'")).toEqual([]);
  });

  test('accepting removes the batch, its pictures, their assignments and bytes, and leaves B tombstone; the offer closes', async () => {
    const { b, trip } = await undoneOnA();
    const [offer] = await listSyncConflicts(b.deps);
    const done = await resolveSyncConflict(b.deps, offer.id, 'theirs', { key: offer.key, detectedAt: offer.detectedAt });
    expect(done).toMatchObject({ undone: true, recordGone: false });
    expect((await listPhotoBatches(b.deps)).map((x) => x.id)).toEqual([PB2]);
    expect(count(b, 'photo_profiles')).toBe(0);
    for (const sha of trip) expect(await b.deps.blobStore.has(sha)).toBe(false);
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    expect(b.opened.db.all("SELECT scope, key, changed_by FROM tombstones WHERE kind = 'photo-batch'")).toEqual([{ scope: '', key: PB1, changed_by: null }]);
  });

  test('declining keeps everything, closes the offer, and the same pack again does not bring it back', async () => {
    const { a, b, trip, pack } = await undoneOnA();
    const [offer] = await listSyncConflicts(b.deps);
    expect(await resolveSyncConflict(b.deps, offer.id, 'mine', { key: offer.key, detectedAt: offer.detectedAt })).toMatchObject({ undone: false });
    expect(count(b, 'photo_batches')).toBe(2);
    expect(count(b, 'photo_profiles')).toBe(3);
    expect(await b.deps.blobStore.has(trip[0])).toBe(true);
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    await importChangesPack(b.deps, pack.blob); // replay: the deletion was already merged
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    expect(a.opened.db.all('SELECT id FROM photo_batches')).toEqual([{ id: PB2 }]);
  });

  test('an offer for an import this device does not have is unmatched and just closes', async () => {
    const { lib: a } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    undoPhotoBatch(b.opened.db, PB1); // B already undid it itself: nothing to offer
    undoPhotoBatch(a.opened.db, PB1);
    expect((await send(a, b)).result.batchOffers).toBe(0);

    const c = await createTestLibrary(); // C never had it
    const { result } = await send(a, c, { peerId: await idOf(c) });
    expect(result.batchOffers).toBe(1);
    const [offer] = await listSyncConflicts(c.deps);
    expect(offer).toMatchObject({ kind: 'photo-batch', matched: false });
    expect(offer.photoBatch).toBeUndefined();
    expect(await resolveSyncConflict(c.deps, offer.id, 'theirs', { key: offer.key, detectedAt: offer.detectedAt })).toMatchObject({ undone: false });
    expect(await listSyncConflicts(c.deps)).toEqual([]);
  });

  test('a batch that arrives after we undid it ourselves stays undone, and its media is not kept', async () => {
    const { lib: a, trip } = await withPhotos();
    const b = await createTestLibrary();
    await send(a, b);
    undoPhotoBatch(b.opened.db, PB1);
    const more = await addPhotos(a, [26], { batchId: PB3 });
    assign(a, more, [ANA]);
    const full = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT });
    const { counts } = await importChangesPack(b.deps, full.blob);
    expect(counts.photoBatches).toBe(1); // PB3 only; PB1 stays undone
    expect((await listPhotoBatches(b.deps)).map((x) => x.id).sort()).toEqual([PB2, PB3]);
    for (const sha of trip) expect(await b.deps.blobStore.has(sha)).toBe(false);
    expect(b.opened.db.all('SELECT 1 FROM blobs WHERE sha256 = ?', [trip[0]])).toEqual([]);
    expect(b.opened.db.all("SELECT 1 FROM photo_items WHERE batch_id = ?", [PB1])).toEqual([]);
  });
});

describe('a full backup with photos still restores', () => {
  test('rows, bytes and change numbers survive; the restored library syncs onward like the original', async () => {
    const { lib: a, trip } = await withPhotos();
    unassignPhotos(a.opened.db, { sha256s: [trip[0]], profileId: ANA }); // leaves a photo-link tombstone
    const backup = await exportArchive({ db: a.opened.db, blobStore: a.deps.blobStore }, { appVersion: '1.0.0', now: AT });
    const b = await createTestLibrary();
    await restoreArchiveIntoEmptyLibrary({ db: b.opened.db, blobStore: b.deps.blobStore }, backup.blob);
    const photoTables = (lib: typeof a) => ({
      batches: lib.opened.db.all('SELECT * FROM photo_batches ORDER BY id'),
      items: lib.opened.db.all('SELECT batch_id, sha256, album, file_name FROM photo_items ORDER BY id'),
      links: lib.opened.db.all('SELECT * FROM photo_profiles ORDER BY profile_id, sha256'),
      tombstones: lib.opened.db.all("SELECT * FROM tombstones WHERE kind = 'photo-link'"),
    });
    expect(photoTables(b)).toEqual(photoTables(a));
    expect(await b.deps.blobStore.size(trip[1])).toBe(500);
    const highest = b.opened.db.all<{ n: number }>('SELECT max(seq) AS n FROM photo_profiles')[0].n;
    expect(currentChangeSeq(b.opened.db)).toBeGreaterThanOrEqual(highest);
    // a restore is a new device with no watermarks: its first pack to a third device starts at 0 and carries the photos
    const c = await createTestLibrary();
    const { pack } = await send(b, c);
    expect(pack.since).toBe(0);
    expect(await canon(c)).toEqual(await canon(b));
  });
});

describe('a version-1 pack is still read, and a newer one is refused', () => {
  /** Rewrites a pack the way a version-1 app wrote it: no photo-links, no photo counts, formatVersion 1. */
  async function asVersion1(zip: Blob): Promise<Blob> {
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    delete files['records/photo-links.jsonl'];
    manifest.formatVersion = 1;
    manifest.entries = manifest.entries.filter((e: { path: string }) => e.path !== 'records/photo-links.jsonl');
    delete manifest.counts.photoBatches;
    delete manifest.counts.photoItems;
    delete manifest.counts.photoLinks;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const out: Zippable = {};
    for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name === 'manifest.json' ? 6 : 0 }];
    return new Blob([zipSync(out) as BlobPart]);
  }

  test('a pack written by a version-1 app merges as before', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(b) });
    const v1 = await asVersion1(pack.blob);
    const result = await importChangesPack(b.deps, v1);
    expect(result.counts).toMatchObject({ profiles: { added: 2 }, messages: { added: 3 }, photoBatches: 0, photoItems: { added: 0 }, photoLinks: { added: 0 } });
    expect(await canon(b)).toEqual(await canon(a));
  });

  test('a version-2 pack carrying photos is refused by a reader that only knows version 1', async () => {
    const { lib: a } = await withPhotos();
    const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT });
    const { openChangesPack } = await import('../exporters/changes-pack/read');
    await expect(openChangesPack(pack.blob, { supportedSchemaVersion: 1_000, maxFormatVersion: 1 })).rejects.toMatchObject({ code: 'newer-format' });
  });
});

describe('a hostile or damaged pack with photos leaves the library as it was', () => {
  const target = async () => {
    const lib = await createTestLibrary();
    return { lib, id: await idOf(lib) };
  };
  const base = (id: string, patch = {}) => syntheticChangeSet({ sourceDeviceId: IDS.source, targetDeviceId: id, since: 0, ack: null, ...patch });
  const craft = async (changes: ReturnType<typeof base>, extra = {}) => (await writeChangesPack(syntheticSource(changes, extra))).blob;

  /** Replaces one text entry of a pack, recomputing its size and hash in the manifest. */
  async function tamper(zip: Blob, path: string, text: string): Promise<Blob> {
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    files[path] = strToU8(text);
    const entry = manifest.entries.find((e: { path: string }) => e.path === path);
    entry.size = files[path].length;
    entry.sha256 = sha256Hex(files[path]);
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const out: Zippable = {};
    for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name === 'manifest.json' ? 6 : 0 }];
    return new Blob([zipSync(out) as BlobPart]);
  }

  test('the control: the synthetic pack with a photo batch and a link merges', async () => {
    const { lib, id } = await target();
    const result = await importChangesPack(lib.deps, await craft(base(id)));
    expect(result.counts).toMatchObject({ photoBatches: 1, photoItems: { added: 1 }, photoLinks: { added: 1 } });
    expect(lib.opened.db.all('SELECT sha256, profile_id FROM photo_profiles')).toEqual([{ sha256: MEDIA_SHA, profile_id: IDS.profile }]);
  });

  test('a link to a profile that is neither here nor in the pack is refused as a whole', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    const changes = base(id, { profiles: [], conversations: [], batches: [], favorites: [], notes: [], tombstones: [] });
    await expect(importChangesPack(lib.deps, await craft(changes))).rejects.toMatchObject({ code: 'invalid' });
    expect(dump(lib.opened.db)).toEqual(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(getPeer(lib.opened.db, IDS.source)).toBeNull();
  });

  test('a link to a picture nobody holds is dropped: it never exists without an item', async () => {
    const { lib, id } = await target();
    const changes = base(id, { photoBatches: [], blobs: [] , batches: [], conversations: [], favorites: [], notes: [], tombstones: [] });
    const result = await importChangesPack(lib.deps, await craft(changes));
    expect(result.counts.photoLinks).toMatchObject({ added: 0, dropped: 1 });
    expect(count(lib, 'photo_profiles')).toBe(0);
  });

  test('an item that breaks its rules is refused before any media is stored', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    const item = PHOTO_ITEMS[0];
    const bad = [
      { kind: 'audio' }, { mime: 'text/html; x=y' }, { takenAt: 'yesterday' }, { dateSource: 'guess' },
      { dateSource: 'none' }, // none exactly when takenAt is null
      { takenOffsetMinutes: 7 }, { takenOffsetMinutes: 60 }, // an offset goes with an exif date
      { latitude: 95, longitude: 0 }, { latitude: 10, longitude: null }, { fileName: '' }, { album: 'x'.repeat(500) }, { description: 5 },
    ];
    for (const patch of bad) {
      // The writer is the test's own: it trusts the item, the reader does not.
      const pack = await craft(base(id), { photoBatchItems: async function* () { yield [{ ...item, ...patch } as never]; } });
      await expect(importChangesPack(lib.deps, pack)).rejects.toMatchObject({ code: 'integrity' });
    }
    expect(dump(lib.opened.db)).toEqual(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('an item with a bad hash written straight into the file is refused as integrity', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    const pack = await craft(base(id));
    const files = unzipSync(new Uint8Array(await pack.arrayBuffer()));
    const path = `photos/${IDS.photoBatch}.jsonl`;
    const lines = new TextDecoder().decode(files[path]).trimEnd().split('\n');
    const tampered = await tamper(pack, path, `${lines[0]}\n${JSON.stringify({ ...PHOTO_ITEMS[0], sha256: 'not-a-hash' })}\n`);
    await expect(importChangesPack(lib.deps, tampered)).rejects.toMatchObject({ code: 'integrity' });
    expect(dump(lib.opened.db)).toEqual(before);
  });

  test('a photo header that names another batch, or a tombstone of an unknown kind or a bad shape, is refused', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    const pack = await craft(base(id));
    const files = unzipSync(new Uint8Array(await pack.arrayBuffer()));
    const path = `photos/${IDS.photoBatch}.jsonl`;
    const [header, item] = new TextDecoder().decode(files[path]).trimEnd().split('\n');
    const other = await tamper(pack, path, `${JSON.stringify({ ...JSON.parse(header), id: IDS.batch })}\n${item}\n`);
    await expect(importChangesPack(lib.deps, other)).rejects.toMatchObject({ code: 'integrity' });

    const tomb = (t: Record<string, unknown>) => tamper(pack, 'records/tombstones.jsonl', `${JSON.stringify({ deletedAt: '2026-01-03T00:00:00Z', seq: 9, ...t })}\n`);
    const hostile: Record<string, unknown>[] = [
      { kind: 'album', scope: '', key: IDS.photoBatch },
      { kind: 'photo-batch', scope: IDS.profile, key: IDS.photoBatch }, // a photo import has no conversation
      { kind: 'photo-batch', scope: '', key: 'not-a-uuid' },
      { kind: 'photo-link', scope: '', key: MEDIA_SHA },
      { kind: 'photo-link', scope: IDS.profile, key: 'nope' },
    ];
    for (const t of hostile) await expect(importChangesPack(lib.deps, await tomb(t))).rejects.toMatchObject({ code: 'integrity' });
    expect(dump(lib.opened.db)).toEqual(before);
  });

  test('a photo-batch tombstone in a pack is an offer, never a deletion, even for a batch the pack itself carries', async () => {
    const { lib, id } = await target();
    const changes = base(id, { tombstones: [{ kind: 'photo-batch', scope: '', key: IDS.photoBatch, deletedAt: '2026-01-03T00:00:00Z', seq: 9 }] });
    const result = await importChangesPack(lib.deps, await craft(changes));
    expect(result.batchOffers).toBe(1);
    expect(count(lib, 'photo_items')).toBe(1);
  });

  test('a pack that lies about its photo counts is refused', async () => {
    const { lib, id } = await target();
    const pack = await craft(base(id));
    const files = unzipSync(new Uint8Array(await pack.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    manifest.counts.photoItems = 5;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const out: Zippable = {};
    for (const [name, data] of Object.entries(files)) out[name] = [data, { level: name === 'manifest.json' ? 6 : 0 }];
    await expect(importChangesPack(lib.deps, new Blob([zipSync(out) as BlobPart]))).rejects.toMatchObject({ code: 'integrity' });
  });

  test('a merge that fails half way undoes the photos too: rows, media and watermark', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    // The photo batch and link are fine; the favorite belongs to a conversation the pack does not carry.
    const changes = base(id, { conversations: [], batches: [], notes: [], tombstones: [] });
    await expect(importChangesPack(lib.deps, await craft(changes))).rejects.toMatchObject({ code: 'invalid' });
    expect(dump(lib.opened.db)).toEqual(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });
});
