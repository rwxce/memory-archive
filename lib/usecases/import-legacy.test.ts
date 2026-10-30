import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { serializeCsv } from '../exporters/legacy/csv';
import { renderHtml } from '../exporters/legacy/html';
import { renderJson } from '../exporters/legacy/json';
import { parseWhatsAppZip } from '../importers/whatsapp/import';
import { createTestLibrary } from './test-client';
import { importWhatsAppExport, undoImportBatch, type ImportResult, type ImportWhatsAppInput } from './import';
import { previewWhatsAppExport } from './import-preview';
import { createProfile } from './profiles';

/**
 * An old wa-backup output (`messages.json` / `.html` / `.csv`, written here by the legacy
 * renderers from a synthetic chat) is imported through the same use case as a ZIP. Its messages
 * get the fingerprints a ZIP of the same chat gives them; its media do not exist (the outputs
 * reference files by path), so attachments arrive as messages whose file is missing.
 */

const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const CHAT = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok',
  '[17/03/2026, 13:17:40] Bo: ok',
  '[17/03/2026, 13:18:00] Ana: línia 1',
  'línia 2',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  'una foto',
  '[17/03/2026, 13:21:00] Bo: This message was deleted',
  '[17/03/2026, 13:22:00] Ana i Bo: ‎Messages are end-to-end encrypted.',
  '[18/03/2026, 09:00:00] Bo: Hola',
];
const ZIP_NAME = 'WhatsApp Chat - Ana i Bo.zip';

const zipFile = (lines: string[]) =>
  new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), [PHOTO]: new Uint8Array(300).fill(7) }) as BlobPart]);

async function legacyFiles(lines: string[] = CHAT) {
  const { messages } = await parseWhatsAppZip(zipFile(lines), ZIP_NAME);
  return {
    json: new Blob([renderJson(messages, 'Ana i Bo')]),
    html: new Blob([await renderHtml(messages, 'Ana i Bo')]),
    csv: new Blob([serializeCsv(messages)]),
    count: messages.length,
  };
}

async function setup() {
  const lib = await createTestLibrary();
  const profile = await createProfile(lib.deps, { displayName: 'Ana' });
  const run = (zip: Blob, fileName: string, extra: Partial<ImportWhatsAppInput> = {}): Promise<ImportResult> =>
    importWhatsAppExport(lib.deps, { zip, fileName, profileIds: [profile.id], meAuthor: 'Ana', ...extra });
  return { lib, run };
}

async function imported(result: Promise<ImportResult>) {
  const r = await result;
  if (r.status !== 'imported') throw new Error(`expected an import, got ${r.status}`);
  return r;
}

describe('old wa-backup outputs as import sources', () => {
  test('each format imports as one named chat; attachments keep their message, with the file missing', async () => {
    const files = await legacyFiles();
    for (const [name, blob] of [['messages.json', files.json], ['messages.html', files.html], ['messages.csv', files.csv]] as const) {
      const { lib, run } = await setup();
      const r = await imported(run(blob, name));
      expect(r.summary).toMatchObject({ added: files.count, alreadyThere: 0, mediaAdded: 0, mediaMissing: 1, rawLines: 0 });
      const [conversation] = await lib.client.call('listConversations');
      // JSON and HTML record the chat name; a CSV records none, so the file name stands in.
      expect(conversation.title).toBe(name === 'messages.csv' ? 'messages' : 'Ana i Bo');
      const messages = await lib.client.call('listMessages', { conversationId: r.conversationId, limit: 100 });
      expect(messages.map((x) => x.type)).toEqual(['text', 'text', 'text', 'text', 'photo', 'deleted', 'system', 'text']);
    }
  });

  test('a ZIP of the same chat afterwards adds nothing (not even the photo file); the other way round too', async () => {
    const files = await legacyFiles();
    for (const blob of [files.json, files.html, files.csv]) {
      const a = await setup();
      const first = await imported(a.run(blob, 'messages.json', { conversation: { mode: 'new' } }));
      const zip = await imported(a.run(zipFile(CHAT), ZIP_NAME, { conversation: { mode: 'existing', conversationId: first.conversationId } }));
      expect(zip.summary).toMatchObject({ added: 0, alreadyThere: files.count, mediaAdded: 0 });
      // The photo's message was already there, so its file is not read again: the ZIP cannot fill it in.

      const b = await setup();
      const zipFirst = await imported(b.run(zipFile(CHAT), ZIP_NAME));
      const legacy = await imported(b.run(blob, 'messages.json', { conversation: { mode: 'existing', conversationId: zipFirst.conversationId } }));
      expect(legacy.summary).toMatchObject({ added: 0, alreadyThere: files.count });
    }
  });

  test('importing the same output twice adds nothing, and a newer output only the difference', async () => {
    const { run } = await setup();
    const old = await legacyFiles();
    const first = await imported(run(old.json, 'messages.json'));
    const again = await imported(run(old.json, 'messages.json'));
    expect(again.conversationId).toBe(first.conversationId);
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: old.count });
    const newer = await legacyFiles([...CHAT, '[19/03/2026, 10:00:00] Ana: Nou']);
    const r = await imported(run(newer.html, 'messages.html'));
    expect(r.summary).toMatchObject({ added: 1, alreadyThere: old.count });
  });

  test('dates that read both ways are not guessed: the output wrote them day-first, whatever the person chose', async () => {
    const { lib, run } = await setup();
    const files = await legacyFiles(['[03/04/2026, 10:00:00] Ana: a', '[05/06/2026, 10:00:00] Bo: b']);
    const preview = await previewWhatsAppExport(lib.deps, { zip: files.json, fileName: 'messages.json', profileIds: [], monthFirst: true });
    expect(preview).toMatchObject({ messageCount: 2 });
    const r = await imported(run(files.json, 'messages.json', { monthFirst: true }));
    const messages = await lib.client.call('listMessages', { conversationId: r.conversationId, limit: 10 });
    expect(messages.map((x) => x.sentAt.slice(0, 10))).toEqual(['2026-04-03', '2026-06-05']);
  });

  test('the preview counts messages and the missing files, and finds the duplicates of an earlier import', async () => {
    const { lib, run } = await setup();
    const files = await legacyFiles();
    const preview = (blob: Blob) => previewWhatsAppExport(lib.deps, { zip: blob, fileName: 'messages.json', profileIds: [] });
    const fresh = await preview(files.json);
    expect(fresh).toMatchObject({ messageCount: files.count, chatTitle: 'Ana i Bo', duplicates: { status: 'new' } });
    expect(fresh.media).toMatchObject({ missing: 1 });
    await imported(run(zipFile(CHAT), ZIP_NAME, { profileIds: [] }));
    expect((await preview(files.json)).duplicates).toMatchObject({ status: 'existing', wouldAdd: 0 });
    // A CSV records no chat name, so it is not matched to the conversation by name: the person chooses.
    expect((await preview(files.csv)).duplicates.status).toBe('ambiguous');
  });

  test('the import can be undone like any other', async () => {
    const { lib, run } = await setup();
    const files = await legacyFiles();
    const r = await imported(run(files.json, 'messages.json'));
    expect(await undoImportBatch(lib.deps, r.batchId)).toMatchObject({ found: true, removedMessages: files.count, removedConversation: true });
    expect(await lib.client.call('listConversations')).toEqual([]);
  });

  test('invalid files are invalid exports, an oversize one is too big, hostile content stays plain data', async () => {
    const { lib, run } = await setup();
    const files = await legacyFiles();
    const hostile = renderJson([{ timestamp_iso: '2026-03-17T13:17:05', type: 'document', author: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>', media: '../../etc/passwd' }], '../../evil/<b>');
    const bad = ['{"messages": "no"}', '{"schemaVersion":9,"messages":[]}', '<html>no island</html>', 'timestamp_iso,x\n', '{"messages":[{"timestampIso":"yesterday","type":"text"}]}'];
    for (const text of bad) {
      await expect(run(new Blob([text]), 'messages.json')).rejects.toMatchObject({ name: 'ImportError', code: 'invalid-export' });
    }
    await expect(run(files.json, 'messages.json', { limits: { maxChatBytes: 50 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(await lib.client.call('listConversations')).toEqual([]);

    const r = await imported(run(new Blob([hostile]), 'messages.json', { meAuthor: null }));
    const [conversation] = await lib.client.call('listConversations');
    expect(conversation.title).toBe('.. .. evil <b>');
    const [message] = await lib.client.call('listMessages', { conversationId: r.conversationId, limit: 10 });
    expect(message.body).toBe('<script>alert(1)</script>');
  });
});
