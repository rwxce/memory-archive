import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import type { OpenedDb } from '../db/open';
import { importWhatsAppExport, type ImportResult, type ImportWhatsAppInput } from './import';
import {
  looksLikePhoneNumber,
  MAX_PREVIEW_AUTHORS,
  previewWhatsAppExport,
  suggestMe,
  type PreviewAuthor,
  type PreviewProgress,
  type PreviewWhatsAppInput,
} from './import-preview';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';

const bytes = (seed: number, size = 300) => new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const PHOTO2 = '00000002-PHOTO-2026-03-18-09-05-00.jpg';
const VIDEO = '00000003-VIDEO-2026-03-18-09-10-00.mp4';
const VOICE = '00000004-AUDIO-2026-03-18-09-11-00.opus';

const BASE = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok',
  '[17/03/2026, 13:17:40] Bo: ok',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:00:00] Bo: Hola',
];
const NEWER = [...BASE, '[19/03/2026, 10:00:00] Ana: Nou'];
const NAME = 'WhatsApp Chat - Ana i Bo.zip';

const exportZip = (lines: string[], media: Record<string, Uint8Array> = {}) =>
  new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...media }) as BlobPart]);

type Lib = Awaited<ReturnType<typeof createTestLibrary>> & { profile: { id: string } };

async function setup(): Promise<Lib> {
  const lib = await createTestLibrary();
  return { ...lib, profile: await createProfile(lib.deps, { displayName: 'Ana' }) };
}

const preview = (lib: Lib, zip: Blob, extra: Partial<PreviewWhatsAppInput> = {}, control: Parameters<typeof previewWhatsAppExport>[2] = {}) =>
  previewWhatsAppExport(lib.deps, { zip, fileName: NAME, profileIds: [lib.profile.id], ...extra }, control);

const importIt = async (lib: Lib, zip: Blob, extra: Partial<ImportWhatsAppInput> = {}): Promise<Extract<ImportResult, { status: 'imported' }>> => {
  const r = await importWhatsAppExport(lib.deps, { zip, fileName: NAME, profileIds: [lib.profile.id], meAuthor: null, ...extra });
  if (r.status !== 'imported') throw new Error(`expected an import, got ${r.status}`);
  return r;
};

const tableState = (opened: OpenedDb) =>
  JSON.stringify(
    opened.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((t) => [t.name, opened.db.all(`SELECT * FROM "${t.name}" ORDER BY rowid`)]),
  );

describe('previewWhatsAppExport: what is in the file', () => {
  test('a single chat: title, key, counts, dates, authors, media from the central directory, nothing written', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const lines = [
      ...BASE,
      `[18/03/2026, 09:05:00] Bo: <attached: ${PHOTO2}>`,
      `[18/03/2026, 09:10:00] Bo: <attached: ${VIDEO}>`,
      '[18/03/2026, 09:12:00] Bo: <attached: 00000009-PHOTO-2026-03-18-09-12-00.jpg>',
      '[18/03/2026, 09:13:00] Messages and calls are end-to-end encrypted.',
    ];
    const zip = exportZip(lines, { [PHOTO]: bytes(1, 100), [PHOTO2]: bytes(2, 200), [VIDEO]: bytes(3, 5000), [VOICE]: bytes(4, 40) });
    const p = await preview(lib, zip, { storage: { usage: 0, quota: 10 * 1024 ** 3 } });
    expect(p).toMatchObject({
      chatTitle: 'Ana i Bo',
      sourceKey: 'ana i bo',
      isGroup: false,
      messageCount: 9,
      firstAt: '2026-03-17T13:17:05',
      lastAt: '2026-03-18T09:13:00',
      authorsTruncated: false,
      rawLines: 0,
      dateFormat: { dayFirst: true, ambiguous: false },
      duplicates: { status: 'new' },
    });
    expect(p.authors).toEqual([
      { name: 'Bo', messageCount: 6, looksLikePhoneNumber: false },
      { name: 'Ana', messageCount: 2, looksLikePhoneNumber: false },
    ]);
    expect(p.media.byKind).toEqual({ photo: { count: 2, bytes: 300 }, video: { count: 1, bytes: 5000 }, audio: { count: 1, bytes: 40 } });
    expect(p.media).toMatchObject({ totalCount: 4, totalBytes: 5340, missing: 1 });
    expect(p.space).toMatchObject({ videoBytes: 5000, fits: true });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('space is unknown (never a guess) when the caller gives no storage numbers', async () => {
    const lib = await setup();
    const p = await preview(lib, exportZip(BASE));
    expect(p.space).toMatchObject({ availableBytes: null, fits: null, suggestSkipVideos: false });
  });

  test('a group (more than two authors) is guessed as a group', async () => {
    const lib = await setup();
    const lines = [...BASE, '[18/03/2026, 09:30:00] Cy: hi all'];
    const p = await preview(lib, exportZip(lines));
    expect(p.isGroup).toBe(true);
    expect(p.suggestedMe).toBeNull();
  });

  test('the group guess is the import’s: a chat the preview calls a group is created as one', async () => {
    const lib = await setup();
    const lines = [...BASE, '[18/03/2026, 09:30:00] Cy: hi all'];
    const p = await preview(lib, exportZip(lines));
    const r = await importIt(lib, exportZip(lines));
    const [conversation] = await lib.client.call('listConversations');
    expect(conversation.id).toBe(r.conversationId);
    expect(conversation.isGroup).toBe(p.isGroup);
  });

  test('phone-number authors are flagged, and "me" is suggested only when unambiguous', async () => {
    const lib = await setup();
    const phones = [
      '[17/03/2026, 13:17:05] Ana: Bon dia',
      '[17/03/2026, 13:17:30] ‪+34 612 34 56 78‬: ok',
    ];
    const p = await preview(lib, exportZip(phones));
    expect(p.authors).toEqual(
      expect.arrayContaining([
        { name: '+34 612 34 56 78', messageCount: 1, looksLikePhoneNumber: true },
        { name: 'Ana', messageCount: 1, looksLikePhoneNumber: false },
      ]),
    );
    expect(p.suggestedMe).toBe('Ana');
    // Two named people: nothing to go on.
    expect((await preview(lib, exportZip(BASE))).suggestedMe).toBeNull();
  });

  test('looksLikePhoneNumber and suggestMe rules', () => {
    for (const phone of ['+34 612 34 56 78', '(555) 010-9999', '0034612345678']) expect(looksLikePhoneNumber(phone)).toBe(true);
    for (const name of ['Ana', 'Ana 2', '123', 'Room 101 Ground', '']) expect(looksLikePhoneNumber(name)).toBe(false);
    const author = (name: string, phone = false): PreviewAuthor => ({ name, messageCount: 1, looksLikePhoneNumber: phone });
    expect(suggestMe([author('Ana'), author('+34 600 000 000', true)], false)).toBe('Ana');
    expect(suggestMe([author('Ana'), author('Bo')], false)).toBeNull();
    expect(suggestMe([author('+34 600 000 000', true), author('+34 600 000 001', true)], false)).toBeNull();
    expect(suggestMe([author('Ana')], false)).toBeNull();
    expect(suggestMe([author('Ana'), author('+34 600 000 000', true), author('Cy')], false)).toBeNull();
    expect(suggestMe([author('Ana'), author('+34 600 000 000', true)], true)).toBeNull();
  });

  test('unparseable lines are counted like the import counts them', async () => {
    const lib = await setup();
    const lines = ['[17/03/2026, 13:17:05] Ana: first', '[31/02/2026, 13:17:05] Bo: not a date'];
    const p = await preview(lib, exportZip(lines));
    expect(p.rawLines).toBe(1);
    expect(p.messageCount).toBe(1);
    expect((await importIt(lib, exportZip(lines))).summary.rawLines).toBe(1);
  });

  test('dates that read both ways: reported as a guess with both readings, and no library lookup', async () => {
    const lib = await setup();
    const lines = ['[03/04/2026, 10:00:00] Ana: hello', '[05/06/2026, 11:00:00] Bo: hi'];
    const p = await preview(lib, exportZip(lines));
    expect(p.dateFormat).toEqual({ dayFirst: true, ambiguous: true, preview: { dayFirst: '2026-04-03', monthFirst: '2026-03-04' } });
    expect(p.duplicates).toEqual({ status: 'date-format' });
    // Choosing an order settles it: not a guess any more, and the library is consulted.
    const chosen = await preview(lib, exportZip(lines), { monthFirst: true });
    expect(chosen.dateFormat).toEqual({ dayFirst: false, ambiguous: false });
    expect(chosen.firstAt).toBe('2026-03-04T10:00:00');
    expect(chosen.duplicates).toEqual({ status: 'new' });
  });

  test('a date over 12 anywhere settles the order, as in the import', async () => {
    const lib = await setup();
    const p = await preview(lib, exportZip(['[03/04/2026, 10:00:00] Ana: hello', '[25/03/2026, 11:00:00] Bo: hi']));
    expect(p.dateFormat).toEqual({ dayFirst: true, ambiguous: false });
  });

  test('a huge author list is capped, flagged, still a group and never suggests "me"', async () => {
    const lib = await setup();
    const total = MAX_PREVIEW_AUTHORS + 50;
    const lines = Array.from({ length: total }, (_, i) => `[17/03/2026, 13:${String(i % 60).padStart(2, '0')}:00] Person ${i}: hello`);
    const p = await preview(lib, exportZip(lines));
    expect(p.authors).toHaveLength(MAX_PREVIEW_AUTHORS);
    expect(p).toMatchObject({ authorsTruncated: true, isGroup: true, suggestedMe: null, messageCount: total });
  });

  test('progress: reading, then matching in chunks, in order', async () => {
    const lib = await setup();
    await importIt(lib, exportZip(BASE));
    const events: PreviewProgress[] = [];
    await preview(lib, exportZip(BASE), {}, { onProgress: (e) => events.push(e) });
    expect(events[0]).toEqual({ phase: 'reading', done: 0 });
    expect(events.at(-1)).toEqual({ phase: 'matching', done: 5, total: 5 });
    const phases = events.map((e) => e.phase);
    expect(phases.indexOf('matching')).toBeGreaterThan(phases.lastIndexOf('reading'));
  });
});

describe('previewWhatsAppExport: duplicates equal what the import then does', () => {
  test('the same ZIP twice: everything is already there, and the import agrees', async () => {
    const lib = await setup();
    const zip = exportZip(BASE, { [PHOTO]: bytes(1) });
    const first = await importIt(lib, zip);
    const p = await preview(lib, zip);
    expect(p.duplicates).toEqual({
      status: 'existing',
      conversationId: first.conversationId,
      title: 'Ana i Bo',
      storedCount: 5,
      alreadyThere: 5,
      wouldAdd: 0,
    });
    const before = tableState(lib.opened);
    expect(await preview(lib, zip)).toEqual(p);
    expect(tableState(lib.opened)).toBe(before);
    const again = await importIt(lib, zip);
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 5 });
  });

  test('a newer export: only the difference would be added, and the import adds exactly that', async () => {
    const lib = await setup();
    await importIt(lib, exportZip(BASE));
    const p = await preview(lib, exportZip(NEWER));
    expect(p.duplicates).toMatchObject({ status: 'existing', storedCount: 5, alreadyThere: 5, wouldAdd: 1 });
    const r = await importIt(lib, exportZip(NEWER));
    expect(r.summary).toMatchObject({ added: 1, alreadyThere: 5 });
  });

  test('identical messages in one minute and system messages count the same way', async () => {
    const lib = await setup();
    const lines = [
      '[17/03/2026, 13:17:30] Bo: ok',
      '[17/03/2026, 13:17:30] Bo: ok',
      '[17/03/2026, 13:17:31] Messages and calls are end-to-end encrypted.',
    ];
    await importIt(lib, exportZip(lines.slice(0, 2)));
    const p = await preview(lib, exportZip(lines));
    expect(p.duplicates).toMatchObject({ status: 'existing', alreadyThere: 2, wouldAdd: 1 });
    expect((await importIt(lib, exportZip(lines))).summary).toMatchObject({ added: 1, alreadyThere: 2 });
  });

  test('a sample that misses the overlap still finds the chat (the import’s full lookup), with the right counts', async () => {
    const lib = await setup();
    const line = (i: number) =>
      `[${17 + Math.floor(i / 1440)}/03/2026, ${String(Math.floor((i % 1440) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00] Ana: message ${i}`;
    await importIt(lib, exportZip([line(1), line(2), line(3)]));
    const zip = exportZip(Array.from({ length: 2000 }, (_, i) => line(i)));
    const p = await preview(lib, zip);
    expect(p.duplicates).toMatchObject({ status: 'existing', alreadyThere: 3, wouldAdd: 1997 });
    expect((await importIt(lib, zip)).summary).toMatchObject({ added: 1997, alreadyThere: 3 });
  });

  test('more messages than one request carries are matched in chunks, with the same total', async () => {
    const lib = await setup();
    const line = (i: number) =>
      `[${17 + Math.floor(i / 1440)}/03/2026, ${String(Math.floor((i % 1440) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00] Ana: message ${i}`;
    const all = Array.from({ length: 5200 }, (_, i) => line(i));
    await importIt(lib, exportZip(all.slice(0, 5100)));
    const p = await preview(lib, exportZip(all));
    expect(p.duplicates).toMatchObject({ status: 'existing', storedCount: 5100, alreadyThere: 5100, wouldAdd: 100 });
    expect((await importIt(lib, exportZip(all))).summary).toMatchObject({ added: 100, alreadyThere: 5100 });
  });

  test('an explicit target: `new` ignores the library, `existing` counts against that conversation, an unknown one is not-found', async () => {
    const lib = await setup();
    const first = await importIt(lib, exportZip(BASE));
    expect((await preview(lib, exportZip(NEWER), { conversation: { mode: 'new' } })).duplicates).toEqual({ status: 'new' });
    const named = await preview(lib, exportZip(NEWER), { fileName: 'WhatsApp Chat - Bo.zip', conversation: { mode: 'existing', conversationId: first.conversationId } });
    expect(named.duplicates).toMatchObject({ status: 'existing', conversationId: first.conversationId, alreadyThere: 5, wouldAdd: 1 });
    await expect(
      preview(lib, exportZip(NEWER), { conversation: { mode: 'existing', conversationId: '00000000-0000-4000-8000-0000000000ff' } }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  test('two chats with the same name: ambiguous with the candidates, nothing written', async () => {
    const lib = await setup();
    const zip = exportZip(BASE);
    await importIt(lib, zip);
    await importIt(lib, zip, { conversation: { mode: 'new' } });
    const before = tableState(lib.opened);
    const p = await preview(lib, zip);
    expect(p.duplicates).toMatchObject({ status: 'ambiguous', reason: 'same-title' });
    if (p.duplicates.status === 'ambiguous') expect(p.duplicates.candidates).toHaveLength(2);
    expect(tableState(lib.opened)).toBe(before);
  });

  test('a renamed chat that holds the same messages is ambiguous (overlap); same name, different messages is same-title-no-overlap', async () => {
    const lib = await setup();
    const first = await importIt(lib, exportZip(BASE));
    const renamed = await preview(lib, exportZip(NEWER), { fileName: 'WhatsApp Chat - Bo.zip' });
    expect(renamed.duplicates).toMatchObject({ status: 'ambiguous', reason: 'overlap', candidates: [{ id: first.conversationId }] });
    const other = await preview(lib, exportZip(['[25/05/2026, 10:00:00] Ana: something else', '[25/05/2026, 10:01:00] Bo: yes']));
    expect(other.duplicates).toMatchObject({ status: 'ambiguous', reason: 'same-title-no-overlap' });
  });

  test('the same chat under another profile is new', async () => {
    const lib = await setup();
    await importIt(lib, exportZip(BASE));
    const bo = await createProfile(lib.deps, { displayName: 'Bo' });
    expect((await preview(lib, exportZip(BASE), { profileIds: [bo.id] })).duplicates).toEqual({ status: 'new' });
  });
});

describe('previewWhatsAppExport: bad input and limits', () => {
  test('files that are not an export are typed errors, nothing written', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    await expect(preview(lib, new Blob(['not a zip']))).rejects.toMatchObject({ name: 'ImportError', code: 'invalid-export' });
    await expect(preview(lib, new Blob([zipSync({ 'readme.txt': strToU8('x') }) as BlobPart]))).rejects.toMatchObject({ code: 'invalid-export' });
    await expect(preview(lib, exportZip(['just some text']))).rejects.toMatchObject({ code: 'invalid-export' });
    await expect(preview(lib, exportZip([]))).rejects.toMatchObject({ code: 'invalid-export' });
    expect(tableState(lib.opened)).toBe(before);
  });

  test('bad requests are `invalid`', async () => {
    const lib = await setup();
    await expect(preview(lib, exportZip(BASE), { dayFirst: true, monthFirst: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(preview(lib, exportZip(BASE), { profileIds: ['nope'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(preview(lib, exportZip(BASE), { conversation: { mode: 'existing', conversationId: 'nope' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  test('the import’s bounds apply: entries, transcript size and a lying central directory', async () => {
    const lib = await setup();
    await expect(preview(lib, exportZip(BASE, { [PHOTO]: bytes(1) }), { limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(preview(lib, exportZip(BASE), { limits: { maxChatBytes: 10 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(preview(lib, exportZip(BASE), { limits: { maxCentralDirectoryBytes: 10 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  test('aborting stops the read and writes nothing; an aborted signal never starts', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const controller = new AbortController();
    const lines = Array.from({ length: 6000 }, (_, i) => `[17/03/2026, 13:${String(i % 60).padStart(2, '0')}:00] Ana: m ${i}`);
    await expect(
      preview(lib, exportZip(lines), {}, { signal: controller.signal, onProgress: (e) => e.phase === 'reading' && e.done >= 2000 && controller.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const late = new AbortController();
    late.abort(new Error('nope'));
    await expect(preview(lib, exportZip(BASE), {}, { signal: late.signal })).rejects.toThrow('nope');
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('aborting during the library lookup stops it', async () => {
    const lib = await setup();
    await importIt(lib, exportZip(BASE));
    const controller = new AbortController();
    await expect(
      preview(lib, exportZip(BASE), {}, { signal: controller.signal, onProgress: (e) => e.phase === 'matching' && controller.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('it only reads: it needs no blob store and calls no write operation', async () => {
    const lib = await setup();
    await importIt(lib, exportZip(BASE));
    const calls: string[] = [];
    const client = {
      call: ((op: string, ...args: unknown[]) => {
        calls.push(op);
        return (lib.client.call as (...a: unknown[]) => unknown)(op, ...args);
      }) as typeof lib.client.call,
    };
    await previewWhatsAppExport({ client }, { zip: exportZip(NEWER), fileName: NAME, profileIds: [lib.profile.id] });
    expect(new Set(calls)).toEqual(new Set(['findImportCandidates', 'findExistingFingerprints']));
  });
});

describe('Android exports: the transcript is named after the chat, never _chat.txt', () => {
  test('preview counts the .txt as the transcript, not as media', async () => {
    const lib = await setup();
    const lines = ['17/03/2026, 13:17 - Ana: Bon dia', `18/03/2026, 09:00 - Bo: ${PHOTO} (file attached)`];
    const zip = new Blob([zipSync({ 'Xat de WhatsApp amb Ana i Bo.txt': strToU8(lines.join('\n')), [PHOTO]: bytes(1, 100) }) as BlobPart]);
    const p = await preview(lib, zip, { fileName: 'Xat de WhatsApp amb Ana i Bo.zip' });
    expect(p).toMatchObject({ messageCount: 2, media: { totalCount: 1, totalBytes: 100, missing: 0 } });
  });
});
