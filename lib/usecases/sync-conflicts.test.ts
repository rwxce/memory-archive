import { describe, expect, test } from 'vitest';
import { createProfile, importMessages, renameConversation, setNote, undoImportBatch, updateProfile } from '../db/queries';
import { getPeer } from '../db/sync';
import { importChangesPack } from './changes-pack-import';
import { describeNoteConflicts, listSyncConflicts, resolveSyncConflict } from './sync-conflicts';
import { createTestLibrary } from './test-client';
import { ANA, BEN, B1, B3, C1, NOW, canon, count, idOf, msg, populated, putMedia, send } from './test-sync';

const edit = (lib: Awaited<ReturnType<typeof populated>>, description: string) =>
  updateProfile(lib.opened.db, { id: ANA, description, now: NOW });
const description = (lib: Awaited<ReturnType<typeof populated>>) =>
  lib.opened.db.all<{ description: string }>('SELECT description FROM profiles WHERE id = ?', [ANA])[0].description;

/** Two libraries in step, then the same person edited on both: the pack from `a` reaches `b` with a conflict. */
async function crossed() {
  const a = await populated();
  const b = await createTestLibrary();
  await send(a, b);
  edit(a, 'from a');
  edit(b, 'from b');
  const { pack, result } = await send(a, b);
  return { a, b, pack, result };
}

describe('a crossed edit is kept beside the active record', () => {
  test('the merge records it with both versions, changes neither, and a replay adds nothing', async () => {
    const { b, pack, result } = await crossed();
    expect(result.conflicts).toBe(1);
    expect(description(b)).toBe('from b');
    const [conflict] = await listSyncConflicts(b.deps);
    expect(conflict).toMatchObject({
      kind: 'profile', key: ANA, incomingDeleted: false, peerId: pack.sourceDeviceId,
      incoming: { description: 'from a' }, local: { description: 'from b' },
    });
    await importChangesPack(b.deps, pack.blob);
    expect(await listSyncConflicts(b.deps)).toEqual([conflict]);
  });

  test('mine: the active record stays and travels, and the other device takes it without a conflict of its own', async () => {
    const { a, b } = await crossed();
    const [conflict] = await listSyncConflicts(b.deps);
    await expect(resolveSyncConflict(b.deps, conflict.id, 'mine', conflict)).resolves.toMatchObject({ recordGone: false });
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    const { result } = await send(b, a);
    expect(result).toMatchObject({ conflicts: 0, counts: { profiles: { updated: 1 } } });
    expect(description(a)).toBe('from b');
    expect(await canon(a)).toEqual(await canon(b));
  });

  test('theirs: the other version becomes this device\'s edit, and the other device already agrees', async () => {
    const { a, b } = await crossed();
    const [conflict] = await listSyncConflicts(b.deps);
    await resolveSyncConflict(b.deps, conflict.id, 'theirs', conflict);
    expect(description(b)).toBe('from a');
    expect(b.opened.db.all('SELECT changed_by FROM profiles WHERE id = ?', [ANA])).toEqual([{ changed_by: null }]);
    expect((await send(b, a)).result.conflicts).toBe(0);
    expect(await canon(a)).toEqual(await canon(b));
  });

  test('the conflict closes by itself when the peer\'s next version agrees with ours', async () => {
    const { a, b } = await crossed();
    edit(a, 'from b'); // a gives in
    await send(a, b);
    expect(await listSyncConflicts(b.deps)).toEqual([]);
  });

  test('a renamed conversation edited on both sides is a conflict too, and theirs takes the whole record', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    renameConversation(a.opened.db, { conversationId: C1, title: 'named on a' });
    renameConversation(b.opened.db, { conversationId: C1, title: 'named on b' });
    expect((await send(a, b)).result.conflicts).toBe(1);
    const [conflict] = await listSyncConflicts(b.deps);
    expect(conflict).toMatchObject({ kind: 'conversation', incoming: { title: 'named on a' }, local: { title: 'named on b' } });
    await resolveSyncConflict(b.deps, conflict.id, 'theirs', conflict);
    expect((await send(b, a)).result.conflicts).toBe(0);
    expect(await canon(a)).toEqual(await canon(b));
  });

  test('notes: both keeps the two texts, and a combination too long for a note is refused without losing the conflict', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'text from a', now: NOW });
    setNote(b.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'text from b', now: NOW });
    await send(a, b);
    const [conflict] = await listSyncConflicts(b.deps);
    expect(conflict).toMatchObject({ kind: 'note', incoming: { body: 'text from a' }, local: { body: 'text from b' } });
    await resolveSyncConflict(b.deps, conflict.id, 'both', conflict);
    expect(b.opened.db.all('SELECT body FROM notes')).toEqual([{ body: 'text from b\n\ntext from a' }]);
    expect((await send(b, a)).result.conflicts).toBe(0);
    expect(a.opened.db.all('SELECT body FROM notes')).toEqual([{ body: 'text from b\n\ntext from a' }]);

    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'a'.repeat(9000), now: NOW });
    setNote(b.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'b'.repeat(9000), now: NOW });
    await send(a, b);
    const [long] = await listSyncConflicts(b.deps);
    await expect(resolveSyncConflict(b.deps, long.id, 'both', long)).rejects.toMatchObject({ code: 'invalid' });
    expect(await listSyncConflicts(b.deps)).toHaveLength(1);
  });

  test('a deletion against an edit: theirs deletes, mine keeps and the deletion is dropped', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: '', now: NOW });
    setNote(b.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'kept here', now: NOW });
    await send(a, b);
    const [conflict] = await listSyncConflicts(b.deps);
    await resolveSyncConflict(b.deps, conflict.id, 'theirs', conflict);
    expect(count(b, 'notes')).toBe(0);
    expect(b.opened.db.all("SELECT changed_by FROM tombstones WHERE kind = 'note'")).toEqual([{ changed_by: null }]);

    // A note deleted here and rewritten there: mine keeps it deleted, theirs brings the text back.
    setNote(a.opened.db, { target: { kind: 'profile', profileId: ANA }, body: 'rewritten', now: NOW });
    await send(a, b);
    const [again] = await listSyncConflicts(b.deps);
    await resolveSyncConflict(b.deps, again.id, 'theirs', again);
    expect(b.opened.db.all('SELECT body FROM notes')).toEqual([{ body: 'rewritten' }]);
    expect(count(b, 'tombstones')).toBe(0);
  });

  test('a conflict that is gone is not found, and a choice that does not fit is refused', async () => {
    const { b } = await crossed();
    const [conflict] = await listSyncConflicts(b.deps);
    await expect(resolveSyncConflict(b.deps, conflict.id, 'both', conflict)).rejects.toMatchObject({ code: 'invalid' });
    await resolveSyncConflict(b.deps, conflict.id, 'mine', conflict);
    await expect(resolveSyncConflict(b.deps, conflict.id, 'mine', conflict)).rejects.toMatchObject({ code: 'not-found' });
    await expect(b.client.call('resolveSyncConflict', { id: 1, choice: 'nope', now: NOW } as never)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('an import the other device undid', () => {
  async function offered() {
    const a = await populated();
    const b = await createTestLibrary();
    const m = await putMedia(a, 21);
    importMessages(a.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'extra.zip', now: NOW, blobs: [m], messages: [msg(5, 'Ana', 'extra', m.sha256)] });
    await send(a, b);
    undoImportBatch(a.opened.db, B3);
    await send(a, b);
    return { a, b, m };
  }

  test('accepting runs the normal undo here: the messages and their media go, and the offer closes', async () => {
    const { b, m } = await offered();
    const [offer] = await listSyncConflicts(b.deps);
    await resolveSyncConflict(b.deps, offer.id, 'theirs', offer);
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    expect(b.opened.db.all('SELECT 1 FROM messages WHERE batch_id = ?', [B3])).toEqual([]);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(false);
    expect(b.opened.db.all("SELECT 1 FROM tombstones WHERE kind = 'batch' AND key = ?", [B3])).toHaveLength(1);
  });

  test('dismissing keeps everything; an offer for an import that is not here is listed as unmatched', async () => {
    const { a, b } = await offered();
    const [offer] = await listSyncConflicts(b.deps);
    await resolveSyncConflict(b.deps, offer.id, 'mine', offer);
    expect(b.opened.db.all('SELECT 1 FROM messages WHERE batch_id = ?', [B3])).toHaveLength(1);

    // Another device never had the batch (it came in through a different one): the offer says so.
    const c = await createTestLibrary();
    await send(a, c);
    expect((await listSyncConflicts(c.deps))[0]).toMatchObject({ kind: 'batch', key: B3, matched: false });
    expect(getPeer(c.opened.db, await idOf(a))).not.toBeNull();
  });
});

describe('a conflict that cannot go stale', () => {
  const PIA = '00000000-0000-4000-8000-0000000000aa';

  async function piaConflict() {
    const a = await populated();
    const b = await createTestLibrary();
    createProfile(a.opened.db, { id: PIA, displayName: 'Pia', now: NOW });
    await send(a, b);
    updateProfile(a.opened.db, { id: PIA, description: 'from a', now: NOW });
    updateProfile(b.opened.db, { id: PIA, description: 'from b', now: NOW });
    expect((await send(a, b)).result.conflicts).toBe(1);
    b.opened.db.run('DELETE FROM profiles WHERE id = ?', [PIA]);
    const [conflict] = await listSyncConflicts(b.deps);
    return { b, id: conflict.id };
  }

  test('the record is gone: mine closes the conflict, theirs brings the record back', async () => {
    const mine = await piaConflict();
    await expect(mine.b.client.call('resolveSyncConflict', { id: mine.id, choice: 'mine', now: NOW })).resolves.toMatchObject({ recordGone: false });
    expect(await listSyncConflicts(mine.b.deps)).toEqual([]);

    const theirs = await piaConflict();
    await expect(theirs.b.client.call('resolveSyncConflict', { id: theirs.id, choice: 'theirs', now: NOW })).resolves.toMatchObject({ recordGone: false });
    expect(await listSyncConflicts(theirs.b.deps)).toEqual([]);
    expect(theirs.b.opened.db.all('SELECT description, changed_by FROM profiles WHERE id = ?', [PIA])).toEqual([{ description: 'from a', changed_by: null }]);
  });

  test('undoing the import that created a conversation closes the conflicts on it, and an undo closes its own offer', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    renameConversation(a.opened.db, { conversationId: C1, title: 'named on a' });
    renameConversation(b.opened.db, { conversationId: C1, title: 'named on b' });
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'a note', now: NOW });
    setNote(b.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'b note', now: NOW });
    expect((await send(a, b)).result.conflicts).toBe(2);
    undoImportBatch(b.opened.db, B1);
    expect(await listSyncConflicts(b.deps)).toEqual([]);

    const x = await populated();
    const y = await createTestLibrary();
    const m = await putMedia(x, 21);
    importMessages(x.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'extra.zip', now: NOW, blobs: [m], messages: [msg(5, 'Ana', 'extra', m.sha256)] });
    await send(x, y);
    undoImportBatch(x.opened.db, B3);
    await send(x, y);
    expect(await listSyncConflicts(y.deps)).toHaveLength(1);
    undoImportBatch(y.opened.db, B3);
    expect(await listSyncConflicts(y.deps)).toEqual([]);
  });

  test('accepting an offered undo still works when the undo closes the offer itself', async () => {
    const x = await populated();
    const y = await createTestLibrary();
    const m = await putMedia(x, 21);
    importMessages(x.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'extra.zip', now: NOW, blobs: [m], messages: [msg(5, 'Ana', 'extra', m.sha256)] });
    await send(x, y);
    undoImportBatch(x.opened.db, B3);
    await send(x, y);
    const [offer] = await listSyncConflicts(y.deps);
    await expect(resolveSyncConflict(y.deps, offer.id, 'theirs', offer)).resolves.toMatchObject({ recordGone: false });
    expect(await listSyncConflicts(y.deps)).toEqual([]);
  });
});

describe('a photo held by a conflict', () => {
  async function photoConflicts() {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    const m = await putMedia(a, 31);
    for (const id of [ANA, BEN]) {
      updateProfile(a.opened.db, { id, photo: m, now: NOW });
      updateProfile(b.opened.db, { id, description: `from b ${id}`, now: NOW });
    }
    expect((await send(a, b)).result.conflicts).toBe(2);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(true);
    const [first, second] = await listSyncConflicts(b.deps);
    return { b, m, first, second };
  }

  test('mine releases the incoming photo once no other conflict holds it', async () => {
    const { b, m, first, second } = await photoConflicts();
    await resolveSyncConflict(b.deps, first.id, 'mine', first);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(true);
    await resolveSyncConflict(b.deps, second.id, 'mine', second);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(false);
    expect(b.opened.db.all('SELECT 1 FROM blobs WHERE sha256 = ?', [m.sha256])).toEqual([]);
  });

  test('theirs keeps the photo the profile now uses, and a later mine does not drop it', async () => {
    const { b, m, first, second } = await photoConflicts();
    await resolveSyncConflict(b.deps, first.id, 'theirs', first);
    await resolveSyncConflict(b.deps, second.id, 'mine', second);
    expect(await b.deps.blobStore.has(m.sha256)).toBe(true);
    expect(b.opened.db.all('SELECT photo_sha256 FROM profiles WHERE id = ?', [first.key])).toEqual([{ photo_sha256: m.sha256 }]);
  });
});

describe('a choice made on a version that has since changed', () => {
  test('a reload that replaced the conflict refuses the old choice and changes nothing', async () => {
    const { b } = await crossed();
    const [conflict] = await listSyncConflicts(b.deps);
    const stale = { key: conflict.key, detectedAt: '2000-01-01T00:00:00.000Z' };
    await expect(resolveSyncConflict(b.deps, conflict.id, 'theirs', stale)).rejects.toMatchObject({ code: 'not-found' });
    await expect(b.client.call('resolveSyncConflict', { id: conflict.id, choice: 'theirs', now: NOW, expected: stale })).rejects.toMatchObject({ code: 'not-found' });
    expect(description(b)).toBe('from b');
    expect(await listSyncConflicts(b.deps)).toEqual([conflict]);
  });

  test('an id taken by another offered import: the undo meant for the old one is refused', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    const m = await putMedia(a, 21);
    importMessages(a.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'extra.zip', now: NOW, blobs: [m], messages: [msg(5, 'Ana', 'extra', m.sha256)] });
    await send(a, b);
    undoImportBatch(a.opened.db, B3);
    await send(a, b);
    const [offer] = await listSyncConflicts(b.deps);
    // What the person was looking at: another import's offer that held the same id before it was settled.
    const looked = { key: B1, detectedAt: offer.detectedAt };
    await expect(resolveSyncConflict(b.deps, offer.id, 'theirs', looked)).rejects.toMatchObject({ code: 'not-found' });
    expect(b.opened.db.all('SELECT 1 FROM messages WHERE batch_id = ?', [B3])).toHaveLength(1);
    expect(await listSyncConflicts(b.deps)).toHaveLength(1);
  });

  test('an offer closed by undoing the import here is refused as already settled', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    undoImportBatch(a.opened.db, B1);
    await send(a, b);
    const [offer] = await listSyncConflicts(b.deps);
    undoImportBatch(b.opened.db, B1);
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    await expect(resolveSyncConflict(b.deps, offer.id, 'theirs', offer)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('a note deleted here meanwhile: the result says the local note was missing', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'first', now: NOW });
    await send(a, b);
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'from a', now: NOW });
    setNote(b.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'from b', now: NOW });
    expect((await send(a, b)).result.conflicts).toBe(1);
    const [conflict] = await listSyncConflicts(b.deps);
    expect((await describeNoteConflicts(b.deps, [conflict])).get(conflict.id)).toBeTruthy();
    b.opened.db.run('DELETE FROM notes WHERE conversation_id = ?', [C1]);
    await expect(resolveSyncConflict(b.deps, conflict.id, 'both', conflict)).resolves.toMatchObject({ localMissing: true });
  });
});
