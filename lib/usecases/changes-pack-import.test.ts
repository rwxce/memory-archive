import { describe, expect, test } from 'vitest';
import { SCHEMA_VERSION } from '../db/migrations';
import { importMessages, setFavorite, setNote, undoImportBatch, updateProfile } from '../db/queries';
import { readChangeSet } from '../db/changes';
import { currentChangeSeq, getPeer, renewDevice, stampRows } from '../db/sync';
import { MIN_ITERATIONS, encryptBackup } from '../exporters/archive/encrypt';
import { ArchiveError } from '../exporters/archive/format';
import { writeChangesPack } from '../exporters/changes-pack/write';
import { IDS, MEDIA_SHA, syntheticChangeSet, syntheticSource } from '../exporters/changes-pack/test-pack';
import { exportArchive } from './archive';
import { confirmChangesPackDelivered, exportChangesPack } from './changes-pack-export';
import { detectArchiveFile, importChangesPack } from './changes-pack-import';
import { createTestLibrary } from './test-client';
import { listSyncConflicts } from './sync-conflicts';
import {
  ANA, AT, B3, B4, BEN, C1, NOW, canon, count, dump, fp, idOf, messageId, msg, populated, populatedOther, putMedia, send, uuid,
} from './test-sync';

describe('importChangesPack: a merge that converges', () => {
  test('a pack from A makes B hold the same archive, media bytes included', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const { pack, result } = await send(a, b);
    expect(pack.kind).toBe('changes');
    expect(result).toMatchObject({
      kind: 'changes', sourceDeviceId: await idOf(a), encrypted: false, conflicts: 0, batchOffers: 0,
      counts: {
        blobs: 2, profiles: { added: 2 }, conversations: { added: 2 }, batches: 2, messages: { added: 3, skipped: 0 },
        favorites: { added: 1 }, notes: { added: 1 },
      },
      peer: { peerId: await idOf(a), lastReceivedSeq: pack.upTo },
    });
    expect(await canon(b)).toEqual(await canon(a));
    expect(Object.values((await canon(b)).bytes).every((size) => size === 500)).toBe(true);
    // A merged version is not a local edit: it carries the peer as its author.
    expect(b.opened.db.all("SELECT 1 FROM profiles WHERE changed_by IS NULL")).toEqual([]);
    expect(b.opened.db.all('SELECT DISTINCT changed_by FROM conversations')).toEqual([{ changed_by: await idOf(a) }]);
  });

  test('importing the same pack twice changes nothing at all (no row, no change number, no watermark)', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const { pack } = await send(a, b);
    const before = dump(b.opened.db);
    const again = await importChangesPack(b.deps, pack.blob);
    expect(again).toMatchObject({ conflicts: 0, counts: { blobs: 0, messages: { added: 0 }, profiles: { added: 0, updated: 0 } } });
    expect(dump(b.opened.db)).toEqual(before);
  });

  test('a full pack after a changes pack, and the reverse, add nothing that is already there', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    const before = await canon(b);
    const full = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT });
    expect(full.kind).toBe('full');
    expect(await importChangesPack(b.deps, full.blob)).toMatchObject({ kind: 'full', conflicts: 0, counts: { messages: { added: 0 }, favorites: { added: 0 } } });
    expect(await canon(b)).toEqual(before);
  });

  test('an incremental pack carries only what changed and merges onto the first', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    const m3 = await putMedia(a, 11);
    importMessages(a.opened.db, {
      batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'three.zip', now: NOW, blobs: [m3],
      messages: [msg(4, 'Ana', 'later photo', m3.sha256)],
    });
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'a conversation note', now: NOW });
    const { pack, result } = await send(a, b);
    expect(pack.since).toBeGreaterThan(0);
    expect(result.counts).toMatchObject({ blobs: 1, batches: 1, messages: { added: 1, skipped: 0 }, notes: { added: 1 } });
    expect(await canon(b)).toEqual(await canon(a));
  });

  test('a batch whose messages are all there already leaves no history entry, no media row and no media file', async () => {
    const a = await populated();
    const b = await populated(); // the same chats, each device imported them on its own
    const m = await putMedia(a, 99);
    // The same new message came to each device in an import of its own (here with other media on A).
    importMessages(a.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'a.zip', now: NOW, blobs: [m], messages: [msg(9, 'Ana', 'both have it', m.sha256)] });
    importMessages(b.opened.db, { batchId: B4, conversationId: C1, source: 'whatsapp', sourceLabel: 'b.zip', now: NOW, blobs: [], messages: [msg(9, 'Ana', 'both have it')] });
    const batches = count(b, 'import_batches');
    const blobs = count(b, 'blobs');
    const { result } = await send(a, b);
    expect(result.counts).toMatchObject({ batches: 0, blobs: 1, messages: { added: 0, skipped: 1 } });
    expect(count(b, 'import_batches')).toBe(batches);
    expect(count(b, 'blobs')).toBe(blobs);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(false);
    expect(b.opened.db.all('SELECT 1 FROM messages WHERE fingerprint = ? AND batch_id = ?', [fp(9), B4])).toHaveLength(1);
  });

  test('order does not matter, and a third device that gets it relayed holds the same archive', async () => {
    const a = await populated();
    const other = await populatedOther();
    const c = await createTestLibrary();
    const d = await createTestLibrary();
    await send(a, c);
    await send(other, c);
    await send(other, d);
    await send(a, d);
    expect(await canon(c)).toEqual(await canon(d));
    expect((await canon(c)).profiles.map((p) => p.displayName).sort()).toEqual(['Ana', 'Ben', 'Cal']);

    // Relay: b hears from a, then passes it on without a ever meeting e.
    const b = await createTestLibrary();
    const e = await createTestLibrary();
    await send(a, b);
    await send(b, e);
    expect(await canon(e)).toEqual(await canon(a));
  });

  test('records merged from a peer travel on, and a participant link set by a merge reaches a third device', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    // On A the participant "Ana" gets linked to the person: it is part of the conversation record.
    a.opened.db.run('UPDATE participants SET profile_id = ? WHERE conversation_id = ? AND display_name = ?', [ANA, C1, 'Ana']);
    stampRows(a.opened.db, 'conversations', 'id = ?', [C1]);
    await send(a, b);
    const linked = { displayName: 'Ana', profileId: ANA, isMe: false };
    expect((await canon(b)).conversations.find((c) => c.id === C1)!.participants).toContainEqual(linked);
    const c = await createTestLibrary();
    await send(b, c);
    expect((await canon(c)).conversations.find((x) => x.id === C1)!.participants).toContainEqual(linked);
  });
});

describe('watermarks, targets and gaps', () => {
  test('wrong device, own pack and a gap are refused before anything is stored', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const c = await createTestLibrary();
    const forC = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(c) });
    const before = dump(b.opened.db);
    await expect(importChangesPack(b.deps, forC.blob)).rejects.toMatchObject({ name: 'ChangesPackMergeError', code: 'wrong-device' });
    const full = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT });
    await expect(importChangesPack(a.deps, full.blob)).rejects.toMatchObject({ name: 'ChangesPackMergeError', code: 'own-pack' });

    const p1 = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(b) });
    await confirmChangesPackDelivered(a.deps, p1);
    setNote(a.opened.db, { target: { kind: 'profile', profileId: BEN }, body: 'later', now: NOW });
    const p2 = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(b) });
    await expect(importChangesPack(b.deps, p2.blob)).rejects.toMatchObject({ code: 'gap' });
    expect(dump(b.opened.db)).toEqual(before);
    expect(await b.deps.blobStore.list()).toEqual([]);
    // In order it works; a full pack is the remedy for a lost one.
    await importChangesPack(b.deps, p1.blob);
    await importChangesPack(b.deps, p2.blob);
    expect(await canon(b)).toEqual(await canon(a));
    const c2 = await createTestLibrary();
    await expect(importChangesPack(c2.deps, (await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(c2), full: true })).blob)).resolves.toMatchObject({ kind: 'full' });
  });

  test('the ack of the peer\'s pack heals a pack that never arrived', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const { pack: p0 } = await send(a, b);
    setNote(a.opened.db, { target: { kind: 'profile', profileId: BEN }, body: 'lost note', now: NOW });
    const lost = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(b) });
    await confirmChangesPackDelivered(a.deps, lost); // handed over, never imported
    expect(getPeer(a.opened.db, await idOf(b))!.lastSentSeq).toBe(lost.upTo);

    updateProfile(b.opened.db, { id: ANA, description: 'from b', now: NOW });
    const { pack: reply } = await send(b, a);
    expect(reply.kind).toBe('changes');
    expect(getPeer(a.opened.db, await idOf(b))).toMatchObject({ lastSentSeq: p0.upTo, lastReceivedSeq: reply.upTo });
    // The next pack covers the lost change again, and b takes it.
    await send(a, b);
    expect(await canon(b)).toEqual(await canon(a));
  });

  test('an older pack than what was merged does not move the watermark back', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const { pack: first } = await send(a, b);
    setNote(a.opened.db, { target: { kind: 'profile', profileId: BEN }, body: 'second', now: NOW });
    const { pack: second } = await send(a, b);
    await importChangesPack(b.deps, first.blob);
    expect(getPeer(b.opened.db, await idOf(a))!.lastReceivedSeq).toBe(second.upTo);
  });

  test('a library restored from a backup is a new device: its pack merges without duplicates or false conflicts', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    const messages = count(b, 'messages');
    const oldId = await idOf(a);
    renewDevice(a.opened.db, currentChangeSeq(a.opened.db));
    expect(await idOf(a)).not.toBe(oldId);
    const { result } = await send(a, b);
    expect(result).toMatchObject({ conflicts: 0, counts: { messages: { added: 0 }, profiles: { added: 0, updated: 0 } } });
    expect(count(b, 'messages')).toBe(messages);
    expect(await canon(b)).toEqual(await canon(a));

    // Edited on both sides since the backup: without watermarks the ancestor is unknown, so it is a conflict.
    renewDevice(a.opened.db, currentChangeSeq(a.opened.db));
    updateProfile(a.opened.db, { id: ANA, description: 'restored side', now: NOW });
    updateProfile(b.opened.db, { id: ANA, description: 'other side', now: NOW });
    expect((await send(a, b)).result.conflicts).toBe(1);
    expect(b.opened.db.all("SELECT description FROM profiles WHERE id = ?", [ANA])).toEqual([{ description: 'other side' }]);
  });
});

describe('deletions', () => {
  test('a favorite or note deleted elsewhere is deleted here unless it was changed here since', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    setFavorite(a.opened.db, { conversationId: C1, messageId: messageId(a, 1), favorite: false, now: NOW });
    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: '', now: NOW });
    const { result } = await send(a, b);
    expect(result.counts).toMatchObject({ favorites: { removed: 1 }, notes: { removed: 1 }, } );
    expect(count(b, 'favorites')).toBe(0);
    expect(count(b, 'notes')).toBe(0);
    // The deletions are kept, so they travel on to a third device.
    expect(b.opened.db.all('SELECT kind, changed_by FROM tombstones ORDER BY kind')).toEqual([
      { kind: 'favorite', changed_by: await idOf(a) },
      { kind: 'note', changed_by: await idOf(a) },
    ]);
    const c = await createTestLibrary();
    await send(a, c);
    await send(b, c);
    expect(await canon(c)).toEqual(await canon(a));
  });

  test('add wins: a favorite put back here is not removed by the other device\'s deletion', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    setFavorite(a.opened.db, { conversationId: C1, messageId: messageId(a, 1), favorite: false, now: NOW });
    setFavorite(b.opened.db, { conversationId: C1, messageId: messageId(b, 1), favorite: false, now: NOW });
    setFavorite(b.opened.db, { conversationId: C1, messageId: messageId(b, 1), favorite: true, now: NOW });
    const { result } = await send(a, b);
    expect(result.counts.favorites.removed).toBe(0);
    expect(count(b, 'favorites')).toBe(1);
  });

  test('a note deleted there and edited here is a conflict: the note stays and the deletion waits', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: '', now: NOW });
    setNote(b.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'edited here', now: NOW });
    const { result } = await send(a, b);
    expect(result).toMatchObject({ conflicts: 1, counts: { notes: { removed: 0 } } });
    expect(b.opened.db.all('SELECT body FROM notes')).toEqual([{ body: 'edited here' }]);
    const [conflict] = await listSyncConflicts(b.deps);
    expect(conflict).toMatchObject({ kind: 'note', incomingDeleted: true, incoming: { kind: 'note' }, local: { body: 'edited here' } });
  });

  test('a note deleted here and rewritten there is a conflict unless the other device had seen our deletion', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    setNote(b.opened.db, { target: { kind: 'profile', profileId: ANA }, body: '', now: NOW });
    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'rewritten there', now: NOW });
    expect((await send(a, b)).result.conflicts).toBe(1);
    expect(count(b, 'notes')).toBe(0);
    expect(await listSyncConflicts(b.deps)).toMatchObject([{ kind: 'note', incomingDeleted: false, local: null, incoming: { body: 'rewritten there' } }]);

    // The other way round: a had seen b's deletion (b's pack reached a) and wrote the note afterwards.
    const c = await populated();
    const d = await createTestLibrary();
    await send(c, d);
    setNote(d.opened.db, { target: { kind: 'profile', profileId: ANA }, body: '', now: NOW });
    await send(d, c);
    setNote(c.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'after seeing it', now: NOW });
    expect((await send(c, d)).result).toMatchObject({ conflicts: 0, counts: { notes: { added: 1 } } });
    expect(d.opened.db.all('SELECT body FROM notes')).toEqual([{ body: 'after seeing it' }]);
  });

  test('an undone import is only offered: nothing is removed until the person accepts', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const m = await putMedia(a, 21);
    importMessages(a.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'extra.zip', now: NOW, blobs: [m], messages: [msg(5, 'Ana', 'extra', m.sha256)] });
    await send(a, b);
    undoImportBatch(a.opened.db, B3);
    const messages = count(b, 'messages');
    const { result } = await send(a, b);
    expect(result).toMatchObject({ batchOffers: 1, conflicts: 0 });
    expect(count(b, 'messages')).toBe(messages);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(true);
    expect(await listSyncConflicts(b.deps)).toMatchObject([{ kind: 'batch', key: B3, matched: true, incomingDeleted: true }]);
    // The pack also did not leave a tombstone of ours behind that would block the import elsewhere.
    expect(b.opened.db.all("SELECT 1 FROM tombstones WHERE kind = 'batch'")).toEqual([]);
  });
});

describe('a hostile or damaged pack leaves the library as it was', () => {
  const target = async () => {
    const lib = await createTestLibrary();
    return { lib, id: await idOf(lib) };
  };
  const craft = async (id: string, changes = syntheticChangeSet({ sourceDeviceId: IDS.source, targetDeviceId: id, since: 0, ack: null }), extra = {}) =>
    (await writeChangesPack(syntheticSource(changes, extra))).blob;

  test('a well-formed synthetic pack merges (the control for the cases below)', async () => {
    const { lib, id } = await target();
    const result = await importChangesPack(lib.deps, await craft(id));
    expect(result.counts).toMatchObject({ blobs: 1, profiles: { added: 1 }, messages: { added: 2 }, favorites: { added: 1 }, notes: { added: 1 }, batches: 1 });
    expect(await lib.deps.blobStore.has(MEDIA_SHA)).toBe(true);
  });

  test('a record that breaks its rules is refused before any media is stored', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    const base = syntheticChangeSet({ sourceDeviceId: IDS.source, targetDeviceId: id, since: 0, ack: null });
    const bad = [
      { ...base, profiles: [{ ...base.profiles[0], displayName: '   ' }] },
      { ...base, profiles: [{ ...base.profiles[0], id: 'not-a-uuid' }] },
      { ...base, conversations: [{ ...base.conversations[0], participants: [{ displayName: 'x', profileId: null, isMe: true }, { displayName: 'y', profileId: null, isMe: true }] }] },
      { ...base, favorites: [{ ...base.favorites[0], fingerprint: 'abc' }] },
      { ...base, notes: [{ ...base.notes[0], body: '' }] },
      { ...base, tombstones: [{ ...base.tombstones[0], scope: '../x' }] },
      { ...base, blobs: [{ ...base.blobs[0], mime: 'text/html; charset=x' }] },
      // A record cut after the pack's own `upTo` makes that watermark a lie.
      { ...base, profiles: [{ ...base.profiles[0], seq: base.upTo + 1 }] },
      { ...base, tombstones: [{ ...base.tombstones[0], seq: base.upTo + 1 }] },
    ];
    for (const changes of bad) {
      await expect(importChangesPack(lib.deps, await craft(id, changes))).rejects.toMatchObject({ code: 'integrity' });
    }
    expect(dump(lib.opened.db)).toEqual(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a message that is not valid is refused', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    const messages = (m: Record<string, unknown>) => async function* () {
      yield [{ fingerprint: fp(1), sentAt: '2026-01-01T10:00:00', ordinal: 0, type: 'text', author: 'Ana', body: 'x', mediaSha256: null, mediaName: '', ...m } as never];
    };
    for (const m of [{ type: 'script' }, { sentAt: 'yesterday' }, { ordinal: -1 }, { fingerprint: 'zz' }]) {
      await expect(importChangesPack(lib.deps, await craft(id, undefined, { batchMessages: messages(m) }))).rejects.toMatchObject({ code: 'integrity' });
    }
    expect(dump(lib.opened.db)).toEqual(before);
  });

  test('a merge that fails half way undoes everything, the stored media and the watermark too', async () => {
    const { lib, id } = await target();
    const before = dump(lib.opened.db);
    // The profile and the media are fine; the favorite belongs to a conversation the pack does not carry.
    const changes = syntheticChangeSet({ sourceDeviceId: IDS.source, targetDeviceId: id, since: 0, ack: null, conversations: [], batches: [], notes: [], tombstones: [] });
    await expect(importChangesPack(lib.deps, await craft(id, changes))).rejects.toMatchObject({ code: 'invalid' });
    expect(dump(lib.opened.db)).toEqual(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(getPeer(lib.opened.db, IDS.source)).toBeNull();
  });

  test('a pack too large to hold is refused, and so are files that are not packs', async () => {
    const { lib, id } = await target();
    await expect(importChangesPack(lib.deps, await craft(id), { maxRecordBytes: 100 })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(importChangesPack(lib.deps, new Blob(['not a zip at all']))).rejects.toMatchObject({ code: 'not-an-archive' });
    const backup = await exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1.0.0', now: AT });
    await expect(importChangesPack(lib.deps, backup.blob)).rejects.toMatchObject({ code: 'invalid-manifest', message: expect.stringContaining('full backup') });
  });

  test('a pack made with a newer database schema is refused', async () => {
    const { lib, id } = await target();
    const changes = syntheticChangeSet({ sourceDeviceId: IDS.source, targetDeviceId: id, since: 0, ack: null, schemaVersion: SCHEMA_VERSION + 1 });
    await expect(importChangesPack(lib.deps, await craft(id, changes))).rejects.toMatchObject({ code: 'newer-schema' });
  });

  test('the archive guard is held: a second operation at the same time is refused', async () => {
    const { lib, id } = await target();
    const pack = await craft(id);
    const [first, second] = await Promise.allSettled([importChangesPack(lib.deps, pack), importChangesPack(lib.deps, pack)]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'busy' }) });
  });

  test('the merge itself refuses what the use case would have: bad request shapes never half apply', async () => {
    const { lib } = await target();
    const call = (params: unknown) => lib.client.call('mergeChangesPack', params as never);
    await expect(call({})).rejects.toMatchObject({ code: 'invalid' });
    await expect(call(null)).rejects.toMatchObject({ code: 'invalid' });
    const ok = { kind: 'full', sourceDeviceId: IDS.source, targetDeviceId: null, since: 0, upTo: 3, ack: null, now: NOW, blobs: [], profiles: [], conversations: [], batches: [], favorites: [], notes: [], tombstones: [] };
    await expect(call({ ...ok, upTo: -1 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(call({ ...ok, profiles: [{ id: uuid(1) }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(call({ ...ok, batches: [{ header: {}, messages: [] }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(call({ ...ok, sourceDeviceId: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await call(ok)).toMatchObject({ refused: null });
  });
});

describe('encrypted packs', () => {
  test('an encrypted pack merges with the password and says it was sealed; a wrong or missing password changes nothing', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const plain = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(b) });
    const sealed = await encryptBackup(plain.blob, 'correct horse', { iterations: MIN_ITERATIONS });
    const before = dump(b.opened.db);
    await expect(importChangesPack(b.deps, sealed)).rejects.toMatchObject({ code: 'password-required' });
    await expect(importChangesPack(b.deps, sealed, { password: 'wrong' })).rejects.toMatchObject({ code: 'wrong-password' });
    expect(dump(b.opened.db)).toEqual(before);
    expect(await b.deps.blobStore.list()).toEqual([]);
    expect(await importChangesPack(b.deps, sealed, { password: 'correct horse' })).toMatchObject({ encrypted: true, kind: 'changes' });
    expect(await canon(b)).toEqual(await canon(a));
  });

  test('a file is recognised as a pack, a backup or neither after decrypting it', async () => {
    const a = await populated();
    const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT });
    const backup = await exportArchive({ db: a.opened.db, blobStore: a.deps.blobStore }, { appVersion: '1.0.0', now: AT });
    expect(await detectArchiveFile(pack.blob)).toEqual({ kind: 'changes-pack', encrypted: false });
    expect(await detectArchiveFile(backup.blob)).toEqual({ kind: 'backup', encrypted: false });
    const sealed = await encryptBackup(pack.blob, 'pw', { iterations: MIN_ITERATIONS });
    await expect(detectArchiveFile(sealed)).rejects.toMatchObject({ code: 'password-required' });
    expect(await detectArchiveFile(sealed, { password: 'pw' })).toEqual({ kind: 'changes-pack', encrypted: true });
    const sealedBackup = await encryptBackup(backup.blob, 'pw', { iterations: MIN_ITERATIONS });
    expect(await detectArchiveFile(sealedBackup, { password: 'pw' })).toEqual({ kind: 'backup', encrypted: true });
    // A sealed backup handed to the pack importer is named for what it is, not misread.
    const b = await createTestLibrary();
    await expect(importChangesPack(b.deps, sealedBackup, { password: 'pw' })).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe('what each side knows decides a conflict, not what was exported', () => {
  const description = (lib: Awaited<ReturnType<typeof populated>>) =>
    lib.opened.db.all<{ description: string }>('SELECT description FROM profiles WHERE id = ?', [ANA])[0].description;
  const edit = (lib: Awaited<ReturnType<typeof populated>>, text: string) => updateProfile(lib.opened.db, { id: ANA, description: text, now: NOW });

  test('a pack handed over but never imported does not count as seen: the pack\'s own ack decides', async () => {
    const a = await populated();
    const s = await createTestLibrary();
    await send(a, s);
    edit(a, 'edit on a');
    // pack1 is exported and confirmed on a, but s never imports it.
    const pack1 = await exportChangesPack(a.deps, { appVersion: '1.0.0', now: AT, peerId: await idOf(s) });
    await confirmChangesPackDelivered(a.deps, pack1);
    edit(s, 'edit on s');
    const { result } = await send(s, a);
    expect(result.conflicts).toBe(1);
    expect(description(a)).toBe('edit on a');
  });

  test('a version is not sent back to the device it came from, but still reaches a third device', async () => {
    const a = await populated();
    const s = await createTestLibrary();
    await send(a, s);
    edit(s, 'v1');
    await send(s, a);
    edit(s, 'v2');
    expect(readChangeSet(a.opened.db, { peerId: await idOf(s) }).profiles.map((p) => p.id)).not.toContain(ANA);
    const back = await send(a, s);
    expect(back.result.conflicts).toBe(0);
    expect(description(s)).toBe('v2');

    const c = await createTestLibrary();
    expect(readChangeSet(a.opened.db, { peerId: await idOf(c) }).profiles.find((p) => p.id === ANA)?.description).toBe('v1');
    await send(a, c);
    expect(description(c)).toBe('v1');
  });
});
