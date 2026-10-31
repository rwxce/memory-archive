import { describe, expect, test } from 'vitest';
import { createProfile, importMessages, setFavorite, setNote, undoImportBatch } from '../db/queries';
import { getDeviceId as dbDeviceId, getPeer, recordReceived } from '../db/sync';
import type { NewMessage } from '../domain/library';
import { sha256Hex } from '../domain/sha256';
import { MIN_ITERATIONS, decryptBackup, encryptBackup, isEncryptedBackup } from '../exporters/archive/encrypt';
import { ArchiveError } from '../exporters/archive/format';
import { unpack } from '../exporters/changes-pack/test-pack';
import { verifyChangesPack } from '../exporters/changes-pack/read';
import { SCHEMA_VERSION } from '../db/migrations';
import { confirmChangesPackDelivered, exportChangesPack } from './changes-pack-export';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const [ANA, BEN, C1, C2, B1, B2, B3, PEER, OTHER] = [1, 2, 10, 11, 100, 101, 102, 900, 901].map(uuid);
const NOW = '2026-02-01T12:00:00Z';
const AT = new Date('2026-05-06T00:00:00Z');
const bytesOf = (seed: number) => new Uint8Array(500).map((_, i) => (i * seed + 3) % 251);

async function putMedia(lib: Lib, seed: number) {
  const bytes = bytesOf(seed);
  const { sha256, size } = await lib.deps.blobStore.put(bytes);
  return { sha256, size, mime: 'image/jpeg' };
}
const msg = (n: number, author: string | null, body: string, mediaSha256: string | null = null): NewMessage => ({
  fingerprint: fp(n), sentAt: `2026-01-0${n}T10:00:00`, ordinal: 0, type: mediaSha256 ? 'photo' : 'text', participantName: author, body, mediaSha256, mediaName: mediaSha256 ? 'IMG.jpg' : '',
});

/** Two conversations with media, a favorite and a note: everything is "new" at first. */
async function populated() {
  const lib = await createTestLibrary();
  const { db } = lib.opened;
  const m1 = await putMedia(lib, 5);
  const m2 = await putMedia(lib, 7);
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BEN, displayName: 'Ben', now: NOW });
  importMessages(db, {
    batchId: B1, conversationId: C1, source: 'whatsapp', sourceLabel: 'one.zip', now: NOW, blobs: [m1],
    messages: [msg(1, 'Ana', 'hello'), msg(2, 'Ben', 'photo', m1.sha256)],
    newConversation: { title: 'Ana & me', sourceKey: 'ana', isGroup: false, profileIds: [ANA] },
    meAuthor: 'Ben',
  });
  importMessages(db, {
    batchId: B2, conversationId: C2, source: 'whatsapp', sourceLabel: 'two.zip', now: NOW, blobs: [m2],
    messages: [msg(3, 'Ben', 'other chat', m2.sha256)],
    newConversation: { title: 'Ben', sourceKey: 'ben', isGroup: false, profileIds: [BEN] },
  });
  const idOf = (n: number) => db.all<{ id: number }>('SELECT id FROM messages WHERE fingerprint = ?', [fp(n)])[0].id;
  setFavorite(db, { conversationId: C1, messageId: idOf(1), favorite: true, now: NOW });
  setNote(db, { target: { kind: 'profile', profileId: ANA }, body: 'synthetic note', now: NOW });
  return { ...lib, m1, m2, idOf };
}

const options = { appVersion: '1.0.0', now: AT };

describe('exportChangesPack', () => {
  test('a pack for a device not known yet is full: every record, every blob, no target, no ack', async () => {
    const lib = await populated();
    const pack = await exportChangesPack(lib.deps, options);
    const deviceId = dbDeviceId(lib.opened.db);
    expect(pack).toMatchObject({ kind: 'full', encrypted: false, peerId: null, sourceDeviceId: deviceId, fileName: `memory-archive-changes-2026-05-06-${deviceId.slice(0, 8)}.zip` });
    const { manifest, records, batches, blobHashes } = await unpack(pack.blob);
    expect(manifest).toMatchObject({ format: 'memory-archive-changes', formatVersion: 1, kind: 'full', since: 0, ack: null, schemaVersion: SCHEMA_VERSION, source: { deviceId }, target: { deviceId: null } });
    expect(manifest.upTo).toBe(pack.upTo);
    expect(manifest.counts).toEqual({ profiles: 2, conversations: 2, batches: 2, messages: 3, favorites: 1, notes: 1, tombstones: 0, blobs: 2 });
    expect(records.profiles.map((p) => p.id)).toEqual([ANA, BEN]);
    expect(records.conversations[0]).toMatchObject({ id: C1, profileIds: [ANA], participants: [{ displayName: 'Ben', profileId: null, isMe: true }] });
    expect(records.notes[0]).toMatchObject({ target: { kind: 'profile', profileId: ANA }, body: 'synthetic note' });
    expect([...batches.keys()]).toEqual([B1, B2]);
    expect(batches.get(B1)![0]).toMatchObject({ id: B1, conversationId: C1, createdConversation: true });
    expect(batches.get(B1)![2]).toMatchObject({ author: 'Ben', mediaSha256: lib.m1.sha256, mediaName: 'IMG.jpg' });
    expect(blobHashes.sort()).toEqual([lib.m1.sha256, lib.m2.sha256].sort());
    expect(await verifyChangesPack(pack.blob, { supportedSchemaVersion: SCHEMA_VERSION })).toMatchObject({ ok: true, problems: [] });
  });

  test('an empty library gives an empty, valid pack', async () => {
    const lib = await createTestLibrary();
    const pack = await exportChangesPack(lib.deps, options);
    const { manifest, records, batches } = await unpack(pack.blob);
    expect(Object.values(manifest.counts).every((n) => n === 0)).toBe(true);
    expect(Object.values(records).every((r) => r.length === 0)).toBe(true);
    expect(batches.size).toBe(0);
    expect(manifest.entries).toHaveLength(6);
    expect(await verifyChangesPack(pack.blob, { supportedSchemaVersion: SCHEMA_VERSION })).toMatchObject({ ok: true });
  });

  test('export alone never advances the watermark; confirming it does, and only then the next pack is smaller', async () => {
    const lib = await populated();
    const first = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    expect(first).toMatchObject({ kind: 'changes', peerId: PEER });
    expect((await unpack(first.blob)).manifest).toMatchObject({ kind: 'changes', since: 0, target: { deviceId: PEER } });
    expect(getPeer(lib.opened.db, PEER)).toBeNull(); // not recorded
    const again = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    expect((await unpack(again.blob)).manifest.counts.messages).toBe(3); // same changes again

    expect(await confirmChangesPackDelivered(lib.deps, first)).toMatchObject({ recorded: true, peer: { peerId: PEER, lastSentSeq: first.upTo } });
    const empty = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    const { manifest } = await unpack(empty.blob);
    expect(manifest).toMatchObject({ since: first.upTo, upTo: first.upTo });
    expect(Object.values(manifest.counts).every((n) => n === 0)).toBe(true);
    // Another peer is independent.
    expect((await unpack((await exportChangesPack(lib.deps, { ...options, peerId: OTHER })).blob)).manifest.since).toBe(0);
  });

  test('a pack without a peer cannot be confirmed (nothing to record against)', async () => {
    const lib = await populated();
    expect(await confirmChangesPackDelivered(lib.deps, await exportChangesPack(lib.deps, options))).toEqual({ recorded: false, peer: null });
  });

  test('since the watermark: changed records, tombstones, the closure, and media only for what changed', async () => {
    const lib = await populated();
    const first = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    await confirmChangesPackDelivered(lib.deps, first);
    const { db } = lib.opened;
    const m3 = await putMedia(lib, 11);
    // Later: a new batch into C1 (with new media), a favorite removed, a note deleted, an import undone.
    importMessages(db, {
      batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'three.zip', now: NOW, blobs: [m3],
      messages: [msg(4, 'Ana', 'later photo', m3.sha256)],
    });
    setFavorite(db, { conversationId: C1, messageId: lib.idOf(1), favorite: false, now: '2026-03-01T00:00:00Z' });
    setNote(db, { target: { kind: 'profile', profileId: ANA }, body: '', now: '2026-03-02T00:00:00Z' });
    undoImportBatch(db, B2);

    const pack = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    const { manifest, records, batches, blobHashes } = await unpack(pack.blob);
    expect(manifest).toMatchObject({ kind: 'changes', since: first.upTo, upTo: pack.upTo });
    expect(pack.upTo).toBeGreaterThan(first.upTo);
    expect([...batches.keys()]).toEqual([B3]);
    expect(batches.get(B3)).toHaveLength(2);
    expect(blobHashes).toEqual([m3.sha256]); // not the media of B1 or the undone B2
    expect(records.tombstones.map((t) => [t.kind, t.scope, t.key]).sort()).toEqual(
      [
        ['batch', C2, B2],
        ['favorite', C1, fp(1)],
        ['note', '', `profile:${ANA}`],
      ].sort(),
    );
    expect(records.tombstones.every((t) => (t.seq as number) > first.upTo)).toBe(true);
    // The undo removed conversation C2 (it was created by B2); only C1 remains and is carried as the batch's conversation.
    expect(records.conversations.map((c) => c.id)).toEqual([C1]);
    expect(records.conversations[0].profileIds).toEqual([ANA]);
    expect(records.profiles.map((p) => p.id)).toEqual([ANA]); // closure of C1
    expect(records.favorites).toEqual([]);
    expect(records.notes).toEqual([]);
    expect(manifest.counts).toMatchObject({ batches: 1, messages: 1, blobs: 1, tombstones: 3 });
    expect(await verifyChangesPack(pack.blob, { supportedSchemaVersion: SCHEMA_VERSION })).toMatchObject({ ok: true });
  });

  test('a re-created favorite or edited note is carried as a record and not as a tombstone', async () => {
    const lib = await populated();
    const first = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    await confirmChangesPackDelivered(lib.deps, first);
    const { db } = lib.opened;
    setFavorite(db, { conversationId: C1, messageId: lib.idOf(1), favorite: false, now: NOW });
    setFavorite(db, { conversationId: C1, messageId: lib.idOf(1), favorite: true, now: '2026-03-01T00:00:00Z' });
    setNote(db, { target: { kind: 'message', conversationId: C1, messageId: lib.idOf(2) }, body: 'edited', now: '2026-03-01T00:00:00Z' });
    const { records, batches, blobHashes } = await unpack((await exportChangesPack(lib.deps, { ...options, peerId: PEER })).blob);
    expect(records.tombstones).toEqual([]);
    expect(records.favorites).toMatchObject([{ conversationId: C1, fingerprint: fp(1), createdAt: '2026-03-01T00:00:00Z' }]);
    expect(records.notes).toMatchObject([{ target: { kind: 'message', conversationId: C1, fingerprint: fp(2) }, body: 'edited' }]);
    expect(records.conversations.map((c) => c.id)).toEqual([C1]); // closure of the favorite and the note
    expect(batches.size).toBe(0);
    expect(blobHashes).toEqual([]);
  });

  test('full: true re-sends everything to a known peer, and confirming still records the watermark', async () => {
    const lib = await populated();
    const first = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    await confirmChangesPackDelivered(lib.deps, first);
    const pack = await exportChangesPack(lib.deps, { ...options, peerId: PEER, full: true });
    expect(pack.kind).toBe('full');
    const { manifest } = await unpack(pack.blob);
    expect(manifest).toMatchObject({ kind: 'full', since: 0, ack: null, target: { deviceId: null } });
    expect(manifest.counts.messages).toBe(3);
    expect(await confirmChangesPackDelivered(lib.deps, pack)).toMatchObject({ recorded: true, peer: { peerId: PEER } });
  });

  test('ack is the peer\'s last pack merged here; it is absent until one was', async () => {
    const lib = await populated();
    expect((await unpack((await exportChangesPack(lib.deps, { ...options, peerId: PEER })).blob)).manifest.ack).toBeNull();
    recordReceived(lib.opened.db, { peerId: PEER, upToSeq: 33, ackedSeq: null, now: NOW });
    expect((await unpack((await exportChangesPack(lib.deps, { ...options, peerId: PEER })).blob)).manifest.ack).toBe(33);
  });

  test('the same library and clock give the same bytes', async () => {
    const lib = await populated();
    const a = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    const b = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    expect(sha256Hex(new Uint8Array(await a.blob.arrayBuffer()))).toBe(sha256Hex(new Uint8Array(await b.blob.arrayBuffer())));
  });

  test('an encrypted pack opens with the password and is a valid pack inside', async () => {
    const lib = await populated();
    const pack = await exportChangesPack(lib.deps, { ...options, peerId: PEER, password: 'synthetic password' });
    expect(pack.encrypted).toBe(true);
    expect(pack.fileName).toMatch(/\.mabackup$/);
    expect(await isEncryptedBackup(pack.blob)).toBe(true);
    const plain = await decryptBackup(pack.blob, 'synthetic password');
    expect((await unpack(plain)).manifest.counts.messages).toBe(3);
    await expect(decryptBackup(pack.blob, 'wrong')).rejects.toMatchObject({ code: 'wrong-password' });
    // The envelope is the backup's, unchanged: sealing the plain pack by hand gives a file the same reader opens.
    const sealed = await encryptBackup(plain, 'x', { iterations: MIN_ITERATIONS });
    expect((await unpack(await decryptBackup(sealed, 'x'))).manifest.kind).toBe('changes');
    await expect(exportChangesPack(lib.deps, { ...options, password: '' })).rejects.toMatchObject({ code: 'password-required' });
  }, 30_000);

  test('a damaged or missing media file fails the export and leaves the library as it was', async () => {
    const lib = await populated();
    await lib.deps.blobStore.delete(lib.m1.sha256);
    const before = lib.opened.db.all('SELECT * FROM device');
    await expect(exportChangesPack(lib.deps, { ...options, peerId: PEER })).rejects.toBeInstanceOf(ArchiveError);
    expect(lib.opened.db.all('SELECT * FROM device')).toEqual(before);
    expect(getPeer(lib.opened.db, PEER)).toBeNull();
  });

  test('limits: a pack the reader would refuse is not produced', async () => {
    const lib = await populated();
    await expect(exportChangesPack(lib.deps, { ...options, limits: { maxTotalBytes: 100 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(exportChangesPack(lib.deps, { ...options, limits: { maxEntryBytes: 100 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(exportChangesPack(lib.deps, { ...options, limits: { maxEntries: 8 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  test('busy while another archive operation runs; a bad peer id is a DbError', async () => {
    const lib = await populated();
    const results = await Promise.allSettled([exportChangesPack(lib.deps, options), exportChangesPack(lib.deps, options)]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'busy' });
    await expect(exportChangesPack(lib.deps, { ...options, peerId: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(exportChangesPack(lib.deps, { ...options, peerId: dbDeviceId(lib.opened.db) })).rejects.toMatchObject({ code: 'invalid' });
  });

  test('confirming an old pack after an ack lowered the watermark records nothing (no lost update)', async () => {
    const lib = await populated();
    const { db } = lib.opened;
    const first = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    expect(await confirmChangesPackDelivered(lib.deps, first)).toMatchObject({ recorded: true });
    const second = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    // The peer answers before the person confirmed the second pack, saying it merged nothing of ours: the watermark goes back to 0.
    recordReceived(db, { peerId: PEER, upToSeq: 5, ackedSeq: 0, now: NOW });
    expect(getPeer(db, PEER)?.lastSentSeq).toBe(0);
    const late = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    expect(late.since).toBe(0);
    expect(second.since).toBe(first.upTo);
    // `second` started where `first` ended; the ack moved the watermark, so it must not be recorded.
    expect(await confirmChangesPackDelivered(lib.deps, second)).toMatchObject({ recorded: false, peer: { lastSentSeq: 0 } });
    expect(getPeer(db, PEER)?.lastSentSeq).toBe(0);
    // The pack cut after the ack is still confirmable.
    expect(await confirmChangesPackDelivered(lib.deps, late)).toMatchObject({ recorded: true, peer: { lastSentSeq: late.upTo } });
  });

  test('two packs confirmed out of order: the later pack cannot be confirmed from a stale start', async () => {
    const lib = await populated();
    const { db } = lib.opened;
    const a = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    setNote(db, { target: { kind: 'profile', profileId: BEN }, body: 'more', now: NOW });
    const b = await exportChangesPack(lib.deps, { ...options, peerId: PEER }); // same since as `a`, covers more
    expect(b.since).toBe(a.since);
    expect(b.upTo).toBeGreaterThan(a.upTo);
    expect(await confirmChangesPackDelivered(lib.deps, b)).toMatchObject({ recorded: true, peer: { lastSentSeq: b.upTo } });
    // `a` is older and its start is gone: recording it must not move the watermark back.
    expect(await confirmChangesPackDelivered(lib.deps, a)).toMatchObject({ recorded: false, peer: { lastSentSeq: b.upTo } });
    expect(getPeer(db, PEER)?.lastSentSeq).toBe(b.upTo);
  });

  test('confirming after the library was replaced is refused', async () => {
    const lib = await populated();
    const pack = await exportChangesPack(lib.deps, { ...options, peerId: PEER });
    await expect(confirmChangesPackDelivered(lib.deps, { ...pack, sourceDeviceId: uuid(777) })).rejects.toMatchObject({ code: 'invalid' });
    expect(getPeer(lib.opened.db, PEER)).toBeNull();
  });
});
