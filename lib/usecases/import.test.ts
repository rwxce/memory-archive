import { strToU8, zipSync } from 'fflate';
import { ArchiveError } from '../exporters/archive/format';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DbError } from '../db/errors';
import type { OpenedDb } from '../db/open';
import { createTestLibrary } from './test-client';
import type { BlobStore } from '../storage/blob-store';
import { exportArchive, restoreArchiveIntoEmptyLibrary, type ArchiveLock } from './archive';
import { webpBlob } from '../storage/test-thumbnail';
import {
  importWhatsAppExport,
  sweepLeftovers,
  sweepOrphanBlobs,
  undoImportBatch,
  type ImportResult,
  type ImportWhatsAppInput,
  type ImportSummary,
} from './import';
import { createProfile } from './profiles';

const bytes = (seed: number, size = 300) => new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const PHOTO2 = '00000002-PHOTO-2026-03-18-09-05-00.jpg';
const VIDEO = '00000003-VIDEO-2026-03-18-09-10-00.mp4';

const BASE = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok',
  '[17/03/2026, 13:17:40] Bo: ok',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:00:00] Bo: Hola',
];
const NEWER = [...BASE, '[19/03/2026, 10:00:00] Ana: Nou'];

function exportZip(lines: string[], media: Record<string, Uint8Array> = {}): Blob {
  return new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...media }) as BlobPart]);
}

const NAME = 'WhatsApp Chat - Ana i Bo.zip';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

async function setup() {
  const lib = await createTestLibrary();
  const profile = await createProfile(lib.deps, { displayName: 'Ana' });
  return { ...lib, profile };
}

function run(lib: Lib & { profile: { id: string } }, zip: Blob, extra: Partial<ImportWhatsAppInput> = {}): Promise<ImportResult> {
  return importWhatsAppExport(lib.deps, { zip, fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana', ...extra });
}

async function imported(result: Promise<ImportResult>) {
  const r = await result;
  if (r.status !== 'imported') throw new Error(`expected an import, got ${r.status}`);
  return r;
}

const tableState = (opened: OpenedDb) =>
  JSON.stringify(
    opened.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((t) => [t.name, opened.db.all(`SELECT * FROM "${t.name}" ORDER BY rowid`)]),
  );

const messagesOf = (lib: Lib, conversationId: string) => lib.client.call('listMessages', { conversationId, limit: 1000 });
const count = (opened: OpenedDb, table: string) => opened.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

/** A store whose `put` can be made to fail; everything else is the real store. */
function wrapStore(real: BlobStore, put: (n: number, source: Parameters<BlobStore['put']>[0]) => Promise<unknown> | void): BlobStore {
  let n = 0;
  return {
    put: async (source) => {
      await put(++n, source);
      return real.put(source);
    },
    has: (s) => real.has(s),
    open: (s) => real.open(s),
    size: (s) => real.size(s),
    delete: (s) => real.delete(s),
    list: () => real.list(),
    verify: (s) => real.verify(s),
  };
}

describe('importWhatsAppExport: idempotent, incremental', () => {
  test('the first import stores everything; the same ZIP again adds nothing', async () => {
    const lib = await setup();
    const zip = exportZip(BASE, { [PHOTO]: bytes(1) });
    const first = await imported(run(lib, zip));
    expect(first.createdConversation).toBe(true);
    expect(first.summary).toEqual<ImportSummary>({ added: 5, alreadyThere: 0, mediaAdded: 1, mediaSkipped: 0, mediaMissing: 0, videosSkipped: 0, rawLines: 0 });

    const rows = (t: string) => JSON.stringify(lib.opened.db.all(`SELECT * FROM ${t} ORDER BY rowid`));
    const [messagesBefore, blobsBefore, participantsBefore] = [rows('messages'), rows('blobs'), rows('participants')];
    const second = await imported(run(lib, zip));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.createdConversation).toBe(false);
    expect([rows('messages'), rows('blobs'), rows('participants')]).toEqual([messagesBefore, blobsBefore, participantsBefore]);
    expect(second.summary).toEqual<ImportSummary>({ added: 0, alreadyThere: 5, mediaAdded: 0, mediaSkipped: 1, mediaMissing: 0, videosSkipped: 0, rawLines: 0 });
    expect(count(lib.opened, 'messages')).toBe(5);
    expect(count(lib.opened, 'conversations')).toBe(1);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    // Only the history row of the second attempt is new.
    expect(count(lib.opened, 'import_batches')).toBe(2);
  });

  test('a newer export adds only the new messages, and its media', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const newer = [...NEWER, `[19/03/2026, 10:05:00] Bo: <attached: ${PHOTO2}>`];
    const second = await imported(run(lib, exportZip(newer, { [PHOTO]: bytes(1), [PHOTO2]: bytes(2) })));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.summary).toMatchObject({ added: 2, alreadyThere: 5, mediaAdded: 1, mediaSkipped: 1 });
    const stored = await messagesOf(lib, first.conversationId);
    expect(stored.map((m) => m.body)).toEqual(['Bon dia', 'ok', 'ok', '', 'Hola', 'Nou', '']);
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
  });

  test('identical messages in one minute stay distinct, and re-importing is still idempotent', async () => {
    const lib = await setup();
    const lines = ['[17/03/2026, 13:17:05] Bo: ok', '[17/03/2026, 13:17:06] Bo: ok', '[17/03/2026, 13:17:07] Bo: ok', '[17/03/2026, 13:18:00] Bo: ok'];
    const first = await imported(run(lib, exportZip(lines), { meAuthor: 'Bo' }));
    expect(first.summary.added).toBe(4);
    const again = await imported(run(lib, exportZip(lines), { meAuthor: 'Bo' }));
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 4 });
    const grown = await imported(run(lib, exportZip([...lines, '[17/03/2026, 13:18:30] Bo: ok']), { meAuthor: 'Bo' }));
    expect(grown.summary).toMatchObject({ added: 1, alreadyThere: 4 });
    expect(await messagesOf(lib, first.conversationId)).toHaveLength(5);
  });

  test('another language prefix and an Android (minute resolution) export of the same chat match', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const android = [
      '17/03/2026, 13:17 - Ana: Bon dia',
      '17/03/2026, 13:17 - Bo: ok',
      '17/03/2026, 13:17 - Bo: ok',
      `17/03/2026, 13:20 - Ana: ${PHOTO} (file attached)`,
      '18/03/2026, 09:00 - Bo: Hola',
    ];
    const second = await imported(run(lib, exportZip(android, { [PHOTO]: bytes(1) }), { fileName: 'Xat de WhatsApp amb Ana i Bo.zip' }));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.summary).toMatchObject({ added: 0, alreadyThere: 5 });
  });

  test('stores authors normalized, the caption as body, "me" marked, a group guess and the system message without author', async () => {
    const lib = await setup();
    const lines = [
      '[17/03/2026, 13:17:05] ~ Ana: Bon dia',
      '[17/03/2026, 13:17:30] ‎Bo: hi',
      '[17/03/2026, 13:17:31] Cy: hi',
      '[17/03/2026, 13:17:32] Ana: ‎Messages are end-to-end encrypted.',
    ];
    const result = await imported(run(lib, exportZip(lines), { meAuthor: '~ Ana' }));
    const stored = await messagesOf(lib, result.conversationId);
    expect(stored.map((m) => [m.participantName, m.type])).toEqual([['Ana', 'text'], ['Bo', 'text'], ['Cy', 'text'], [null, 'system']]);
    expect(await lib.client.call('listParticipants', { conversationId: result.conversationId })).toEqual([
      { displayName: 'Ana', profileId: null, isMe: true },
      { displayName: 'Bo', profileId: null, isMe: false },
      { displayName: 'Cy', profileId: null, isMe: false },
    ]);
    const [conversation] = await lib.client.call('listConversations');
    expect(conversation).toMatchObject({ title: 'Ana i Bo', source: 'whatsapp', isGroup: true, profileIds: [lib.profile.id] });
  });
});

describe('importWhatsAppExport: media', () => {
  test('identical bytes in two conversations are stored once', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { fileName: 'WhatsApp Chat - Uno.zip' }));
    const b = await imported(run(lib, exportZip(['[21/04/2026, 10:00:00] Cy: <attached: IMG-OTHER-PHOTO.jpg>', '[21/04/2026, 10:00:01] Cy: yo'], { 'IMG-OTHER-PHOTO.jpg': bytes(1) }), { fileName: 'WhatsApp Chat - Dos.zip', meAuthor: null }));
    expect(b.conversationId).not.toBe(a.conversationId);
    expect(b.summary).toMatchObject({ mediaAdded: 0, mediaSkipped: 1 });
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(count(lib.opened, 'blobs')).toBe(1);
    const [mine] = (await messagesOf(lib, a.conversationId)).filter((m) => m.type === 'photo');
    const [theirs] = (await messagesOf(lib, b.conversationId)).filter((m) => m.type === 'photo');
    expect(mine.mediaSha256).toBe(theirs.mediaSha256);
    expect(mine.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await lib.deps.blobStore.verify(mine.mediaSha256!)).toBe('ok');
    expect(lib.opened.db.all('SELECT mime FROM blobs')).toEqual([{ mime: 'image/jpeg' }]);
  });

  test('a message whose file is not in the ZIP is kept, without a file', async () => {
    const lib = await setup();
    const result = await imported(run(lib, exportZip(BASE)));
    expect(result.summary).toMatchObject({ added: 5, mediaAdded: 0, mediaMissing: 1 });
    const photo = (await messagesOf(lib, result.conversationId)).find((m) => m.type === 'photo');
    expect(photo).toMatchObject({ mediaSha256: null, mediaName: PHOTO });
    expect(count(lib.opened, 'blobs')).toBe(0);
  });

  test('skipVideos keeps the video messages but stores no video bytes', async () => {
    const lib = await setup();
    const lines = [...BASE, `[18/03/2026, 09:10:00] Bo: <attached: ${VIDEO}>`];
    const result = await imported(run(lib, exportZip(lines, { [PHOTO]: bytes(1), [VIDEO]: bytes(9, 5000) }), { options: { skipVideos: true } }));
    expect(result.summary).toMatchObject({ added: 6, mediaAdded: 1, videosSkipped: 1 });
    const video = (await messagesOf(lib, result.conversationId)).find((m) => m.type === 'video');
    expect(video).toMatchObject({ mediaSha256: null, mediaName: VIDEO });
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
  });

  test('file names from the ZIP are never storage paths: bytes land under their hash, hostile references stay unmatched', async () => {
    const lib = await setup();
    const lines = [
      '[17/03/2026, 13:20:00] Ana: <attached: IMG-9-PHOTO.jpg>',
      '[17/03/2026, 13:20:01] Ana: <attached: ../../evil-PHOTO.jpg>',
    ];
    const result = await imported(run(lib, exportZip(lines, { '../../IMG-9-PHOTO.jpg': bytes(3), '../../evil-PHOTO.jpg': bytes(4) })));
    expect(result.summary).toMatchObject({ added: 2, mediaAdded: 1, mediaMissing: 1 });
    const [stored] = await lib.deps.blobStore.list();
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
  });

  test('unparseable dates are kept as text of the previous message and counted', async () => {
    const lib = await setup();
    const lines = ['[17/03/2026, 13:17:05] Ana: first', '[31/02/2026, 13:17:05] Bo: not a date'];
    const result = await imported(run(lib, exportZip(lines)));
    expect(result.summary).toMatchObject({ added: 1, rawLines: 1 });
    expect((await messagesOf(lib, result.conversationId))[0].body).toContain('not a date');
  });
});

describe('importWhatsAppExport: which conversation', () => {
  test('two conversations with the same chat name are never merged silently', async () => {
    const lib = await setup();
    const zip = exportZip(BASE, { [PHOTO]: bytes(1) });
    await imported(run(lib, zip));
    await imported(run(lib, zip, { conversation: { mode: 'new' } }));
    const before = tableState(lib.opened);
    const result = await run(lib, zip);
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'same-title' });
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2);
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
  });

  test('a chat renamed on the phone but holding the same messages is ambiguous, then resolved by the caller', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const renamed = exportZip(NEWER, { [PHOTO]: bytes(1) });
    const result = await run(lib, renamed, { fileName: 'WhatsApp Chat - Bo.zip' });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'overlap', candidates: [{ id: first.conversationId, messageCount: 5 }] });
    const merged = await imported(run(lib, renamed, { fileName: 'WhatsApp Chat - Bo.zip', conversation: { mode: 'existing', conversationId: first.conversationId } }));
    expect(merged.summary).toMatchObject({ added: 1, alreadyThere: 5 });
    const separate = await imported(run(lib, renamed, { fileName: 'WhatsApp Chat - Bo.zip', conversation: { mode: 'new' } }));
    expect(separate.conversationId).not.toBe(first.conversationId);
    expect(separate.summary.added).toBe(6);
  });

  test('the same chat under another profile is a different conversation', async () => {
    const lib = await setup();
    const other = await createProfile(lib.deps, { displayName: 'Bo' });
    const zip = exportZip(BASE);
    const a = await imported(run(lib, zip));
    const b = await imported(run(lib, zip, { profileIds: [other.id] }));
    expect(b.conversationId).not.toBe(a.conversationId);
    expect(b.summary.added).toBe(5);
  });

  test('renaming the conversation does not break the match (the key is stored apart from the title)', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE)));
    await lib.client.call('renameConversation', { conversationId: first.conversationId, title: 'Els meus avis' });
    const second = await imported(run(lib, exportZip(NEWER)));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.summary.added).toBe(1);
  });

  test('an explicit conversation that does not exist is not-found and nothing is written', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    await expect(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { conversation: { mode: 'existing', conversationId: '11111111-1111-4111-8111-111111111111' } })).rejects.toMatchObject({ code: 'not-found' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toHaveLength(0);
  });
});

describe('importWhatsAppExport: refusals', () => {
  test('bad requests and bad files are typed errors that write nothing', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    await expect(run(lib, exportZip(BASE), { meAuthor: 'Nobody' })).rejects.toMatchObject({ name: 'ImportError', code: 'unknown-author' });
    await expect(run(lib, exportZip(BASE), { profileIds: ['nope'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(run(lib, new Blob(['not a zip']))).rejects.toMatchObject({ code: 'invalid-export' });
    await expect(run(lib, new Blob([zipSync({ 'readme.txt': strToU8('x') }) as BlobPart]))).rejects.toMatchObject({ code: 'invalid-export' });
    await expect(run(lib, exportZip(['just some text']))).rejects.toMatchObject({ code: 'invalid-export' });
    expect(tableState(lib.opened)).toBe(before);
  });

  test('a ZIP over a size bound is refused: entries, transcript, and a media file (whose earlier files are cleaned up)', async () => {
    const lib = await setup();
    await expect(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(run(lib, exportZip(BASE), { limits: { maxChatBytes: 10 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    const lines = [...BASE, `[18/03/2026, 09:10:00] Bo: <attached: ${VIDEO}>`];
    await expect(run(lib, exportZip(lines, { [PHOTO]: bytes(1, 50), [VIDEO]: bytes(2, 5000) }), { limits: { maxMediaBytes: 1000 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(count(lib.opened, 'messages')).toBe(0);
    expect(await lib.deps.blobStore.list()).toHaveLength(0);
  });
});

describe('importWhatsAppExport: interrupted', () => {
  const lines = [...BASE, `[18/03/2026, 09:10:00] Bo: <attached: ${PHOTO2}>`];
  const media = () => ({ [PHOTO]: bytes(1), [PHOTO2]: bytes(2) });

  test('abort between two media files leaves the archive and the store as they were', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const controller = new AbortController();
    const phases: string[] = [];
    const attempt = run(lib, exportZip(lines, media()), {
      signal: controller.signal,
      onProgress: (p) => {
        if (!phases.includes(p.phase)) phases.push(p.phase);
        if (p.phase === 'media' && p.done === 1) controller.abort();
      },
    });
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(phases).toEqual(['reading', 'media']);
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('abort before anything starts', async () => {
    const lib = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(run(lib, exportZip(lines, media()), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('the store failing in the blob phase leaves the database untouched and removes the blobs written so far', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const deps = { ...lib.deps, blobStore: wrapStore(lib.deps.blobStore, (n) => { if (n === 2) throw new Error('disk full'); }) };
    await expect(importWhatsAppExport(deps, { zip: exportZip(lines, media()), fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' })).rejects.toThrow('disk full');
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('blobs that were already stored are never removed by a failed import', async () => {
    const lib = await setup();
    await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { fileName: 'WhatsApp Chat - Uno.zip' }));
    const stored = await lib.deps.blobStore.list();
    const deps = { ...lib.deps, blobStore: wrapStore(lib.deps.blobStore, (n) => { if (n === 2) throw new Error('disk full'); }) };
    const other = ['[20/03/2026, 08:00:00] Ana: other chat', `[20/03/2026, 08:01:00] Ana: <attached: ${PHOTO}>`, `[20/03/2026, 08:02:00] Ana: <attached: ${PHOTO2}>`];
    await expect(importWhatsAppExport(deps, { zip: exportZip(other, media()), fileName: 'WhatsApp Chat - Dos.zip', profileIds: [lib.profile.id], meAuthor: 'Ana' })).rejects.toThrow('disk full');
    expect(await lib.deps.blobStore.list()).toEqual(stored);
  });

  test('the database refusing the save rolls everything back (conversation, batch, messages) and cleans the blobs', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    // A profile that does not exist fails on a foreign key inside the transaction, after the
    // conversation and batch rows were written.
    await expect(run(lib, exportZip(lines, media()), { profileIds: ['22222222-2222-4222-8222-222222222222'] })).rejects.toMatchObject({ code: 'constraint' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a lost connection at the save step is ambiguous: the blobs stay, the database is unchanged, and the sweep removes them', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const client = { call: ((op: string, ...args: unknown[]) => (op === 'importMessages' ? Promise.reject(new DbError('unavailable', 'worker died')) : (lib.client.call as (...a: unknown[]) => unknown)(op, ...args))) as typeof lib.client.call };
    await expect(importWhatsAppExport({ ...lib.deps, client }, { zip: exportZip(lines, media()), fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
    expect(await sweepOrphanBlobs(lib.deps)).toEqual({ removed: 2 });
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('the sweep and the open-time cleanup also drop thumbnails whose photo is not stored', async () => {
    const lib = await setup();
    const lock: ArchiveLock = async (_name, work) => ({ held: true, value: await work() });
    const kept = await lib.deps.blobStore.put(bytes(5));
    await createProfile(lib.deps, { displayName: 'Cy', photo: { ...kept, mime: 'image/png' } });
    const stray = 'd'.repeat(64); // no blob at all (the blob went first)
    await lib.deps.thumbStore!.put(stray, 320, webpBlob(40));
    await lib.deps.thumbStore!.put(kept.sha256, 320, webpBlob(40));
    expect(await sweepLeftovers({ ...lib.deps, lock })).toMatchObject({ ran: true });
    expect(await lib.deps.thumbStore!.list()).toEqual([kept.sha256]);
    await lib.deps.thumbStore!.put(stray, 320, webpBlob(40));
    await sweepOrphanBlobs(lib.deps);
    expect(await lib.deps.thumbStore!.list()).toEqual([kept.sha256]);
  });

  test('the sweep keeps every referenced blob (messages and profile photos)', async () => {
    const lib = await setup();
    await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const photo = await lib.deps.blobStore.put(bytes(5));
    await createProfile(lib.deps, { displayName: 'Cy', photo: { ...photo, mime: 'image/png' } });
    const orphan = await lib.deps.blobStore.put(bytes(6));
    await lib.deps.thumbStore!.put(orphan.sha256, 320, webpBlob(40));
    await lib.deps.thumbStore!.put(photo.sha256, 320, webpBlob(40));
    expect(await lib.deps.blobStore.list()).toHaveLength(3);
    expect(await sweepOrphanBlobs(lib.deps)).toEqual({ removed: 1 });
    expect(await lib.deps.thumbStore!.get(orphan.sha256, 320)).toBeUndefined();
    expect(await lib.deps.thumbStore!.get(photo.sha256, 320)).toBeDefined();
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
    expect(await sweepOrphanBlobs(lib.deps)).toEqual({ removed: 0 });
  });
});

describe('the archive busy guard covers import, undo and sweep', () => {
  test('an import and a restore started together: one runs, the other is busy', async () => {
    const lib = await setup();
    const empty = await createTestLibrary();
    const { blob } = await exportArchive({ db: empty.opened.db, blobStore: empty.deps.blobStore }, { appVersion: '1' });
    const importing = run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }));
    await expect(restoreArchiveIntoEmptyLibrary({ db: lib.opened.db, blobStore: lib.deps.blobStore }, blob)).rejects.toMatchObject({ code: 'busy' });
    await expect(sweepOrphanBlobs(lib.deps)).rejects.toMatchObject({ code: 'busy' });
    await expect(run(lib, exportZip(BASE))).rejects.toMatchObject({ code: 'busy' });
    await expect(importing).resolves.toMatchObject({ status: 'imported' });
    // The restore never ran its "clear leftovers" sweep, so the import's blob is intact; guard released.
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    await expect(sweepOrphanBlobs(lib.deps)).resolves.toEqual({ removed: 0 });
  });

  test('an export and an undo during an import are busy too', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE)));
    const importing = run(lib, exportZip(NEWER));
    await expect(exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1' })).rejects.toMatchObject({ code: 'busy' });
    await expect(undoImportBatch(lib.deps, first.batchId)).rejects.toMatchObject({ code: 'busy' });
    await importing;
  });
});

describe('undoImportBatch', () => {
  test('removes what only this batch brought and keeps a blob another conversation uses', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { fileName: 'WhatsApp Chat - Uno.zip' }));
    const bLines = ['[21/04/2026, 10:00:00] Cy: <attached: IMG-X-PHOTO.jpg>', '[21/04/2026, 10:00:01] Cy: <attached: IMG-Y-PHOTO.jpg>'];
    const b = await imported(run(lib, exportZip(bLines, { 'IMG-X-PHOTO.jpg': bytes(1), 'IMG-Y-PHOTO.jpg': bytes(2) }), { fileName: 'WhatsApp Chat - Dos.zip', meAuthor: null }));
    expect(await lib.deps.blobStore.list()).toHaveLength(2);

    const undoA = await undoImportBatch(lib.deps, a.batchId);
    expect(undoA).toEqual({ found: true, removedMessages: 5, removedConversation: true, removedMedia: 0 });
    expect(await lib.deps.blobStore.list()).toHaveLength(2); // the shared photo stays
    expect(await lib.client.call('listConversations').then((l) => l.map((c) => c.id))).toEqual([b.conversationId]);

    const undoB = await undoImportBatch(lib.deps, b.batchId);
    expect(undoB).toEqual({ found: true, removedMessages: 2, removedConversation: true, removedMedia: 2 });
    expect(await lib.deps.blobStore.list()).toEqual([]);
    for (const table of ['messages', 'blobs', 'participants', 'import_batches', 'conversations', 'conversation_profiles']) {
      expect(count(lib.opened, table)).toBe(0);
    }
    expect(count(lib.opened, 'profiles')).toBe(1);
  });

  test('drops the thumbnails of the media it removes and keeps those of media that stays', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { fileName: 'WhatsApp Chat - Uno.zip' }));
    const bLines = ['[21/04/2026, 10:00:00] Cy: <attached: IMG-X-PHOTO.jpg>', '[21/04/2026, 10:00:01] Cy: <attached: IMG-Y-PHOTO.jpg>'];
    const b = await imported(run(lib, exportZip(bLines, { 'IMG-X-PHOTO.jpg': bytes(1), 'IMG-Y-PHOTO.jpg': bytes(2) }), { fileName: 'WhatsApp Chat - Dos.zip', meAuthor: null }));
    const [shared, only] = await lib.deps.blobStore.list();
    for (const sha256 of [shared!, only!]) await lib.deps.thumbStore!.put(sha256, 320, webpBlob(40));
    await undoImportBatch(lib.deps, a.batchId);
    expect(await lib.deps.thumbStore!.usage()).toEqual({ count: 2, bytes: 80 });
    await undoImportBatch(lib.deps, b.batchId);
    expect(await lib.deps.thumbStore!.usage()).toEqual({ count: 0, bytes: 0 });
  });

  test('is idempotent', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    await undoImportBatch(lib.deps, a.batchId);
    const before = tableState(lib.opened);
    expect(await undoImportBatch(lib.deps, a.batchId)).toEqual({ found: false, removedMessages: 0, removedConversation: false, removedMedia: 0 });
    expect(tableState(lib.opened)).toBe(before);
    await expect(undoImportBatch(lib.deps, 'nope')).rejects.toMatchObject({ code: 'invalid' });
  });

  test('undoing a later merge keeps the conversation, the earlier messages and their media', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const newer = [...NEWER, '[19/03/2026, 10:01:00] Cy: hi', `[19/03/2026, 10:05:00] Bo: <attached: ${PHOTO2}>`];
    const second = await imported(run(lib, exportZip(newer, { [PHOTO]: bytes(1), [PHOTO2]: bytes(2) })));
    expect(second.summary).toMatchObject({ added: 3, mediaAdded: 1 });
    expect((await lib.client.call('listParticipants', { conversationId: first.conversationId })).map((p) => p.displayName)).toEqual(['Ana', 'Bo', 'Cy']);

    const undo = await undoImportBatch(lib.deps, second.batchId);
    expect(undo).toEqual({ found: true, removedMessages: 3, removedConversation: false, removedMedia: 1 });
    expect(await messagesOf(lib, first.conversationId)).toHaveLength(5);
    expect((await lib.client.call('listParticipants', { conversationId: first.conversationId })).map((p) => p.displayName)).toEqual(['Ana', 'Bo']);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(count(lib.opened, 'import_batches')).toBe(1);
    // The messages come back with the next import of the newer export.
    const again = await imported(run(lib, exportZip(newer, { [PHOTO]: bytes(1), [PHOTO2]: bytes(2) })));
    expect(again.summary).toMatchObject({ added: 3, alreadyThere: 5 });
  });

  test('a blob that is also a profile photo stays', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const [photo] = (await messagesOf(lib, a.conversationId)).filter((m) => m.mediaSha256);
    await lib.client.call('updateProfile', { id: lib.profile.id, photo: { sha256: photo.mediaSha256!, size: 300, mime: 'image/jpeg' }, now: 'x' });
    expect(await undoImportBatch(lib.deps, a.batchId)).toMatchObject({ removedMedia: 0 });
    expect(await lib.deps.blobStore.list()).toEqual([photo.mediaSha256]);
    expect(count(lib.opened, 'blobs')).toBe(1);
  });

  test('keeps a participant the user linked to a profile and the one marked as me', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE)));
    const second = await imported(run(lib, exportZip([...BASE, '[19/03/2026, 10:01:00] Cy: hi']), { meAuthor: 'Cy' }));
    lib.opened.db.run('UPDATE participants SET profile_id = ? WHERE display_name = ?', [lib.profile.id, 'Bo']);
    await undoImportBatch(lib.deps, second.batchId);
    const names = (await lib.client.call('listParticipants', { conversationId: first.conversationId })).map((p) => [p.displayName, p.isMe]);
    expect(names).toEqual([['Ana', false], ['Bo', false], ['Cy', true]]);
  });

  test('a crash between the transaction and the byte deletion leaves orphans for the sweep', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const stuck: BlobStore = { ...wrapStore(lib.deps.blobStore, () => undefined), delete: () => Promise.reject(new Error('io')) };
    expect(await undoImportBatch({ ...lib.deps, blobStore: stuck }, a.batchId)).toMatchObject({ found: true, removedMedia: 0 });
    expect(count(lib.opened, 'blobs')).toBe(0);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(await sweepOrphanBlobs(lib.deps)).toEqual({ removed: 1 });
  });
});

describe('backup and restore with imported data', () => {
  test('imported messages and media survive a backup round trip, and re-importing into the restored library adds nothing', async () => {
    const lib = await setup();
    const zip = exportZip(BASE, { [PHOTO]: bytes(1) });
    const first = await imported(run(lib, zip));
    const { blob } = await exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1' });

    const restored = await createTestLibrary();
    await restoreArchiveIntoEmptyLibrary({ db: restored.opened.db, blobStore: restored.deps.blobStore }, blob);
    expect(await messagesOf(restored, first.conversationId)).toEqual(await messagesOf(lib, first.conversationId));
    expect(await restored.deps.blobStore.list()).toEqual(await lib.deps.blobStore.list());
    expect(await restored.client.call('listParticipants', { conversationId: first.conversationId })).toEqual(
      await lib.client.call('listParticipants', { conversationId: first.conversationId }),
    );

    const again = await imported(importWhatsAppExport(restored.deps, { zip, fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' }));
    expect(again.conversationId).toBe(first.conversationId);
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 5 });
    // The restored library can undo the batch it brought along.
    expect(await undoImportBatch(restored.deps, first.batchId)).toMatchObject({ found: true, removedMessages: 5, removedMedia: 1 });
  });
});

/** Walks the central directory and lets a test rewrite one entry's declared sizes. */
function patchDirectory(zip: Uint8Array, name: string, patch: { uncompressed?: number; compressed?: number }): Blob {
  const bytes = new Uint8Array(zip);
  const view = new DataView(bytes.buffer);
  let eocd = bytes.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = view.getUint32(eocd + 16, true);
  for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
    const nameLength = view.getUint16(at + 28, true);
    const entryName = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (entryName === name) {
      if (patch.uncompressed !== undefined) view.setUint32(at + 24, patch.uncompressed, true);
      if (patch.compressed !== undefined) view.setUint32(at + 20, patch.compressed, true);
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return new Blob([bytes as BlobPart]);
}

const zipBytes = (lines: string[], media: Record<string, Uint8Array>) =>
  zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...Object.fromEntries(Object.entries(media).map(([k, v]) => [k, [v, { level: 9 }] as [Uint8Array, { level: 9 }]])) });

describe('importWhatsAppExport: never merges a different chat by name alone', () => {
  const OTHER = ['[20/03/2026, 08:00:00] Ana: something else entirely', '[20/03/2026, 08:01:00] Bo: and more'];

  test('two different chats with the same title: the second is ambiguous and nothing is written', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const before = tableState(lib.opened);
    const result = await run(lib, exportZip(OTHER, { [PHOTO2]: bytes(2) }));
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'same-title-no-overlap', candidates: [{ id: first.conversationId, overlap: 0 }] });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
  });

  test('two ZIPs both called chat.zip are different chats unless their messages overlap', async () => {
    const lib = await setup();
    const a = await imported(run(lib, exportZip(BASE), { fileName: 'chat.zip' }));
    expect(await run(lib, exportZip(OTHER), { fileName: 'chat.zip' })).toMatchObject({ status: 'ambiguous', reason: 'same-title-no-overlap' });
    // The real continuation of the first chat still merges.
    const again = await imported(run(lib, exportZip(NEWER), { fileName: 'chat.zip' }));
    expect(again.conversationId).toBe(a.conversationId);
    expect(again.summary).toMatchObject({ added: 1, alreadyThere: 5 });
    // The caller can still decide that it is the same chat.
    const forced = await imported(run(lib, exportZip(OTHER), { fileName: 'chat.zip', conversation: { mode: 'existing', conversationId: a.conversationId } }));
    expect(forced.summary.added).toBe(2);
  });
});

describe('cross-tab lock (injected)', () => {
  const lockOf = (held: boolean, seen: string[] = []): ArchiveLock => async (name, work) => {
    seen.push(name);
    return held ? { held: true, value: await work() } : { held: false };
  };

  test('import, undo and sweep run inside the lock', async () => {
    const lib = await setup();
    const seen: string[] = [];
    const deps = { ...lib.deps, lock: lockOf(true, seen) };
    const result = await imported(importWhatsAppExport(deps, { zip: exportZip(BASE), fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' }));
    await undoImportBatch(deps, result.batchId);
    await sweepOrphanBlobs(deps);
    expect(seen).toEqual(['memory-archive', 'memory-archive', 'memory-archive']);
  });

  test('another tab holding the lock is a typed busy, nothing is touched, and this tab is usable afterwards', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const denied = { ...lib.deps, lock: lockOf(false) };
    await expect(importWhatsAppExport(denied, { zip: exportZip(BASE, { [PHOTO]: bytes(1) }), fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' })).rejects.toBeInstanceOf(ArchiveError);
    await expect(sweepOrphanBlobs(denied)).rejects.toMatchObject({ code: 'busy' });
    await expect(undoImportBatch(denied, '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'busy' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    await expect(run(lib, exportZip(BASE))).resolves.toMatchObject({ status: 'imported' });
  });

  test('a profile write with a photo takes the guard and the lock; one without does not', async () => {
    const lib = await setup();
    const photo = { ...(await lib.deps.blobStore.put(bytes(5))), mime: 'image/png' };
    const seen: string[] = [];
    const deps = { ...lib.deps, lock: lockOf(true, seen) };
    await createProfile(deps, { displayName: 'Bo' });
    expect(seen).toEqual([]);
    const withPhoto = await createProfile(deps, { displayName: 'Cy', photo });
    await lib.client.call('updateProfile', { id: withPhoto.id, relationship: 'x', now: 'n' });
    expect(seen).toEqual(['memory-archive']);
    await expect(createProfile({ ...lib.deps, lock: lockOf(false) }, { displayName: 'Di', photo })).rejects.toMatchObject({ code: 'busy' });
    expect(count(lib.opened, 'profiles')).toBe(3);
  });

  test('a profile photo write during an import is busy (same guard)', async () => {
    const lib = await setup();
    const photo = { ...(await lib.deps.blobStore.put(bytes(5))), mime: 'image/png' };
    const importing = run(lib, exportZip(BASE));
    await expect(createProfile(lib.deps, { displayName: 'Cy', photo })).rejects.toMatchObject({ code: 'busy' });
    await importing;
  });
});

describe('importWhatsAppExport: hostile ZIPs give typed errors and leave nothing behind', () => {
  const mediaLines = [...BASE, `[18/03/2026, 09:10:00] Bo: <attached: ${PHOTO2}>`];

  test('a media entry that lies about its size (bomb) is limit-exceeded', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const zip = patchDirectory(zipBytes(BASE, { [PHOTO]: new Uint8Array(3_000_000) }), PHOTO, { uncompressed: 200 });
    await expect(run(lib, zip)).rejects.toMatchObject({ name: 'ImportError', code: 'limit-exceeded' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a bomb after a good blob: the good blob is cleaned up too', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const zip = patchDirectory(zipBytes(mediaLines, { [PHOTO]: bytes(1), [PHOTO2]: new Uint8Array(3_000_000) }), PHOTO2, { uncompressed: 200 });
    const written: string[] = [];
    const deps = { ...lib.deps, blobStore: wrapStore(lib.deps.blobStore, (n) => { written.push(String(n)); }) };
    await expect(importWhatsAppExport(deps, { zip, fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' })).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(written).toEqual(['1', '2']); // the first blob really was written before the failure
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a ZIP cut inside an entry with an intact directory is invalid-export', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const zip = patchDirectory(zipBytes(mediaLines, { [PHOTO]: bytes(1), [PHOTO2]: bytes(2, 4000) }), PHOTO2, { compressed: 2_000_000 });
    await expect(run(lib, zip)).rejects.toMatchObject({ name: 'ImportError', code: 'invalid-export' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a transcript that lies about its size is limit-exceeded', async () => {
    const lib = await setup();
    const zip = patchDirectory(zipBytes(Array.from({ length: 5000 }, (_, i) => `[17/03/2026, 13:${String(i % 60).padStart(2, '0')}:00] Ana: line ${i}`), {}), '_chat.txt', { uncompressed: 500 });
    await expect(run(lib, zip)).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(count(lib.opened, 'messages')).toBe(0);
  });
});

describe('importWhatsAppExport: more interruption cases', () => {
  const lines = [...BASE, `[18/03/2026, 09:10:00] Bo: <attached: ${PHOTO2}>`];
  const media = () => ({ [PHOTO]: bytes(1), [PHOTO2]: bytes(2) });

  test('an abort right after the last blob was written cleans every written blob', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const controller = new AbortController();
    const attempt = run(lib, exportZip(lines, media()), {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'media' && p.total > 0 && p.done === p.total) controller.abort();
      },
    });
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('an abort while a media stream is being copied stops the copy and leaves nothing', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const controller = new AbortController();
    const deps = { ...lib.deps, blobStore: wrapStore(lib.deps.blobStore, (n) => { if (n === 1) controller.abort(); }) };
    // Pseudo-random, like a real photo: a periodic pattern would deflate past the ratio limit.
    let seed = 1;
    const big = { [PHOTO]: new Uint8Array(400_000).map(() => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff), [PHOTO2]: bytes(2) };
    await expect(importWhatsAppExport(deps, { zip: exportZip(lines, big), fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('an abort during reading', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const controller = new AbortController();
    await expect(run(lib, exportZip(lines, media()), { signal: controller.signal, onProgress: (p) => { if (p.phase === 'reading' && p.done === 0) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('the real lost connection: the database committed but the answer was lost; blobs stay, the sweep removes nothing, a retry adds nothing', async () => {
    const lib = await setup();
    const real = lib.client.call as (...a: unknown[]) => Promise<unknown>;
    const client = {
      call: (async (op: string, ...args: unknown[]) => {
        const result = await real(op, ...args);
        if (op === 'importMessages') throw new DbError('unavailable', 'worker died after the commit');
        return result;
      }) as typeof lib.client.call,
    };
    const zip = exportZip(lines, media());
    await expect(importWhatsAppExport({ ...lib.deps, client }, { zip, fileName: NAME, profileIds: [lib.profile.id], meAuthor: 'Ana' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(count(lib.opened, 'messages')).toBe(6);
    const stored = await lib.deps.blobStore.list();
    expect(stored).toHaveLength(2);
    expect(await sweepOrphanBlobs(lib.deps)).toEqual({ removed: 0 });
    const retry = await imported(run(lib, zip));
    expect(retry.summary).toMatchObject({ added: 0, alreadyThere: 6 });
    expect(await lib.deps.blobStore.list()).toEqual(stored);
    for (const sha of stored) expect(await lib.deps.blobStore.verify(sha)).toBe('ok');
    expect(lib.opened.db.all('SELECT COUNT(*) AS n FROM messages WHERE media_sha256 IS NOT NULL')).toEqual([{ n: 2 }]);
  });
});

describe('importWhatsAppExport: date format', () => {
  const E1 = ['[03/04/2026, 10:00:00] Ana: hello', '[05/06/2026, 11:00:00] Bo: hi'];
  const E2 = [...E1, '[03/25/2026, 12:00:00] Ana: later'];

  test('a chat whose dates all read both ways is not guessed: nothing is written and both readings are offered', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const result = await run(lib, exportZip(E1, {}));
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'date-format', candidates: [], dateFormat: { ambiguous: true }, datePreview: { dayFirst: '2026-04-03', monthFirst: '2026-03-04' } });
    expect(tableState(lib.opened)).toBe(before);
  });

  test('an explicit order imports it, and is reported as not a guess', async () => {
    const lib = await setup();
    const day = await imported(run(lib, exportZip(E1), { dayFirst: true }));
    expect(day.dateFormat).toEqual({ dayFirst: true, ambiguous: false });
    expect((await messagesOf(lib, day.conversationId))[0].sentAt).toBe('2026-04-03T10:00:00');
    const month = await imported(run(lib, exportZip(E1), { monthFirst: true, fileName: 'WhatsApp Chat - Other.zip' }));
    expect(month.dateFormat).toEqual({ dayFirst: false, ambiguous: false });
    expect((await messagesOf(lib, month.conversationId))[0].sentAt).toBe('2026-03-04T10:00:00');
  });

  test('both orders at once is invalid', async () => {
    const lib = await setup();
    await expect(run(lib, exportZip(BASE), { dayFirst: true, monthFirst: true })).rejects.toMatchObject({ name: 'ImportError', code: 'invalid' });
  });

  test('a date with a component over 12 deep in the file (past the first 50 lines) settles the order', async () => {
    const lib = await setup();
    const lines = Array.from({ length: 120 }, (_, i) => `[03/04/2026, 10:${String(i % 60).padStart(2, '0')}:00] Ana: message ${i}`);
    const result = await imported(run(lib, exportZip([...lines, '[03/25/2026, 12:00:00] Bo: late proof'])));
    expect(result.dateFormat).toEqual({ dayFirst: false, ambiguous: false });
    expect(result.summary.added).toBe(121);
    expect((await messagesOf(lib, result.conversationId))[0].sentAt).toBe('2026-03-04T10:00:00');
  });

  test('an explicit conversation target does not refuse a tie, it reports the guess', async () => {
    const lib = await setup();
    const result = await imported(run(lib, exportZip(E1), { conversation: { mode: 'new' } }));
    expect(result.dateFormat).toEqual({ dayFirst: true, ambiguous: true });
  });

  test('exports of one chat agree once the order is explicit, so nothing duplicates', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(E1), { monthFirst: true }));
    const second = await imported(run(lib, exportZip(E2)));
    expect(second.dateFormat).toEqual({ dayFirst: false, ambiguous: false });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.summary).toMatchObject({ added: 1, alreadyThere: 2 });
  });

  test('lines whose date fails under the chosen order are kept as text and counted, never dropped silently', async () => {
    const lib = await setup();
    const lines = ['[03/04/2026, 09:00:00] Ana: first', '[25/03/2026, 10:00:00] Bo: day 25 is not a month'];
    const result = await imported(run(lib, exportZip(lines), { monthFirst: true }));
    expect(result.summary).toMatchObject({ added: 1, rawLines: 1 });
    expect((await messagesOf(lib, result.conversationId))[0].body).toContain('day 25 is not a month');
  });
});

describe('importWhatsAppExport: a newer export that shares few messages', () => {
  const line = (i: number) => {
    const day = 17 + Math.floor(i / 1440);
    const minute = i % 1440;
    return `[${day}/03/2026, ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00] Ana: message ${i}`;
  };

  test('the sample misses the overlap, the full lookup finds it, and the chat merges instead of asking', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip([line(1), line(2), line(3)])));
    // 2000 messages: the 200-message sample takes every 10th, so messages 1-3 are not in it.
    const newer = Array.from({ length: 2000 }, (_, i) => line(i));
    const second = await imported(run(lib, exportZip(newer)));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.summary).toMatchObject({ added: 1997, alreadyThere: 3 });
  });

  test('truly different chats with the same title are still ambiguous after the full lookup', async () => {
    const lib = await setup();
    await imported(run(lib, exportZip([line(1), line(2), line(3)])));
    const different = Array.from({ length: 300 }, (_, i) => line(i + 5000).replace('Ana: message', 'Ana: other'));
    expect(await run(lib, exportZip(different))).toMatchObject({ status: 'ambiguous', reason: 'same-title-no-overlap' });
  });
});

describe('importWhatsAppExport: documented limits', () => {
  test('an export made without media after one with media adds "omitted" rows (a different message by design)', async () => {
    const lib = await setup();
    const first = await imported(run(lib, exportZip(BASE, { [PHOTO]: bytes(1) })));
    const without = BASE.map((l) => (l.includes('<attached:') ? '[17/03/2026, 13:20:00] Ana: <Media omitted>' : l));
    const second = await imported(run(lib, exportZip(without)));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.summary).toMatchObject({ added: 1, alreadyThere: 4 });
    expect((await messagesOf(lib, first.conversationId)).map((m) => m.type)).toEqual(expect.arrayContaining(['photo', 'omitted']));
  });

  test('skipVideos then a full import does not fill the videos in (undo and re-import does)', async () => {
    const lib = await setup();
    const lines = [...BASE, `[18/03/2026, 09:10:00] Bo: <attached: ${VIDEO}>`];
    const zip = exportZip(lines, { [PHOTO]: bytes(1), [VIDEO]: bytes(9, 2000) });
    const first = await imported(run(lib, zip, { options: { skipVideos: true } }));
    const full = await imported(run(lib, zip));
    expect(full.summary).toMatchObject({ added: 0, alreadyThere: 6 });
    expect((await messagesOf(lib, first.conversationId)).find((m) => m.type === 'video')?.mediaSha256).toBeNull();
    await undoImportBatch(lib.deps, first.batchId);
    const again = await imported(run(lib, zip));
    expect((await messagesOf(lib, again.conversationId)).find((m) => m.type === 'video')?.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('importWhatsAppExport: media progress by bytes (throttled)', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * The ZIP as a Blob whose entry streams come in 16 KiB chunks, `stepMs` of fake time apart:
   * what a slow disk or a big video looks like to the import.
   */
  function slowBlob(blob: Blob, stepMs: number, counter: { chunks: number }): Blob {
    const chunked = (slice: Blob) => ({
      size: slice.size,
      arrayBuffer: () => slice.arrayBuffer(),
      stream: () => {
        const reader = slice.stream().getReader();
        let rest = new Uint8Array(0);
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (rest.length === 0) {
              const next = await reader.read();
              if (next.done) return controller.close();
              rest = next.value;
            }
            const piece = rest.subarray(0, 16 * 1024);
            rest = rest.subarray(piece.length);
            counter.chunks++;
            if (stepMs) vi.advanceTimersByTime(stepMs);
            controller.enqueue(piece);
          },
        });
      },
    });
    return { size: blob.size, slice: (a: number, b: number) => chunked(blob.slice(a, b)), arrayBuffer: () => blob.arrayBuffer() } as unknown as Blob;
  }

  const SIZES = [1024 * 1024, 600 * 1024];
  const TOTAL = SIZES[0] + SIZES[1];
  const bigZip = () =>
    new Blob([
      zipSync({
        '_chat.txt': strToU8(['[17/03/2026, 13:17:05] Ana: hi', `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`, `[17/03/2026, 13:21:00] Ana: <attached: ${PHOTO2}>`].join('\n')),
        [PHOTO]: [bytes(1, SIZES[0]), { level: 0 }],
        [PHOTO2]: [bytes(2, SIZES[1]), { level: 0 }],
      } as never) as BlobPart,
    ]);

  async function runWith(stepMs: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lib = await setup();
    const events: { done: number; bytes: number; totalBytes: number; t: number }[] = [];
    const counter = { chunks: 0 };
    await imported(
      importWhatsAppExport(lib.deps, {
        zip: slowBlob(bigZip(), stepMs, counter),
        fileName: NAME,
        profileIds: [lib.profile.id],
        meAuthor: 'Ana',
        onProgress: (p) => p.phase === 'media' && events.push({ done: p.done, bytes: p.bytes!, totalBytes: p.totalBytes!, t: Date.now() }),
      }),
    );
    return { events, counter };
  }

  test('reports within 200 ms of the last one are dropped, boundaries always report, the last has bytes === totalBytes', async () => {
    const { events, counter } = await runWith(50);
    expect(counter.chunks).toBeGreaterThanOrEqual(100); // 16 KiB chunks, 50 ms apart
    const last = events.at(-1)!;
    expect(last).toMatchObject({ done: 2, bytes: TOTAL, totalBytes: TOTAL });
    expect(events.length).toBeLessThan(counter.chunks / 3); // throttled: about one report per 4 chunks
    expect(events.length).toBeGreaterThan(3); // but progress inside the files is reported
    events.forEach((e, i) => {
      const boundary = i === 0 || e.done !== events[i - 1].done || e === last;
      if (!boundary) expect(e.t - events[i - 1].t).toBeGreaterThanOrEqual(200);
    });
    // File boundaries always report: done 0 (before file 1), 1 (before file 2), 2 (after the last).
    expect(new Set(events.map((e) => e.done))).toEqual(new Set([0, 1, 2]));
    expect(events.map((e) => e.done)).toEqual([...events.map((e) => e.done)].sort());
    expect(events.every((e) => e.bytes <= e.totalBytes)).toBe(true);
  });

  test('chunks arriving within 200 ms report only at the file boundaries', async () => {
    const { events, counter } = await runWith(0);
    expect(counter.chunks).toBeGreaterThanOrEqual(100);
    expect(events.map((e) => e.done)).toEqual([0, 1, 2]);
    expect(events.at(-1)!.bytes).toBe(TOTAL);
  });
});

describe('importWhatsAppExport: compression-ratio guard', () => {
  test('a media entry that deflates absurdly well is refused from the directory, nothing is written', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const zip = new Blob([zipBytes([...BASE], { [PHOTO]: new Uint8Array(5_000_000) }) as BlobPart]);
    await expect(run(lib, zip)).rejects.toMatchObject({ name: 'ImportError', code: 'limit-exceeded' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('the ratio is a limit like the others: raising it admits the same file', async () => {
    const lib = await setup();
    const zip = new Blob([zipBytes([...BASE], { [PHOTO]: new Uint8Array(5_000_000) }) as BlobPart]);
    expect((await run(lib, zip, { limits: { maxCompressionRatio: 1_000_000 } })).status).toBe('imported');
  });

  test('ordinary exports (text transcript, varied media) are unaffected', async () => {
    const lib = await setup();
    const zip = new Blob([zipBytes([...BASE], { [PHOTO]: bytes(1, 4000) }) as BlobPart]);
    expect((await run(lib, zip)).status).toBe('imported');
  });
});

describe('importWhatsAppExport: Android transcript name', () => {
  test('imports a ZIP whose transcript is "<localized> <name>.txt", stores the media once, re-import adds nothing', async () => {
    const lib = await setup();
    const lines = ['17/03/2026, 13:17 - Ana: Bon dia', `17/03/2026, 13:20 - Bo: ${PHOTO} (file attached)`];
    const zip = () => new Blob([zipSync({ 'Xat de WhatsApp amb Ana i Bo.txt': strToU8(lines.join('\n')), [PHOTO]: bytes(1, 100) }) as BlobPart]);
    const first = await run(lib, zip(), { fileName: 'Xat de WhatsApp amb Ana i Bo.zip' });
    expect(first.status).toBe('imported');
    if (first.status === 'imported') expect(first.summary).toMatchObject({ added: 2, mediaAdded: 1 });
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    const again = await run(lib, zip(), { fileName: 'Xat de WhatsApp amb Ana i Bo.zip' });
    if (again.status === 'imported') expect(again.summary).toMatchObject({ added: 0, alreadyThere: 2 });
  });

  test('a ZIP with no identifiable transcript is invalid-export', async () => {
    const lib = await setup();
    const zip = new Blob([zipSync({ 'a.txt': strToU8('x'), 'b.txt': strToU8('y') }) as BlobPart]);
    await expect(run(lib, zip)).rejects.toMatchObject({ code: 'invalid-export' });
  });
});
