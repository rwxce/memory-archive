import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { createTestLibrary } from './test-client';
import { importWhatsAppExport, undoImportBatch, type ImportResult, type ImportWhatsAppInput } from './import';
import { previewWhatsAppExport } from './import-preview';
import { createProfile } from './profiles';

/**
 * A bare `.txt` export ("Export chat > Without media") goes through the same import as a ZIP:
 * same fingerprints, same dedupe, same undo. Synthetic chat only.
 */

const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const TEXT_ONLY = ['[17/03/2026, 13:17:05] Ana: Bon dia', '[17/03/2026, 13:17:30] Bo: ok', '[18/03/2026, 09:00:00] Bo: Hola'];
/** What a no-media export writes where the full export has an attachment. */
const OMITTED = '[17/03/2026, 13:20:00] Ana: <Media omitted>';
const ATTACHED = `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`;
const TXT_NAME = 'WhatsApp Chat with Ana i Bo.txt';
const ZIP_NAME = 'WhatsApp Chat - Ana i Bo.zip';

const txtFile = (lines: string[]) => new Blob([lines.join('\n')], { type: 'text/plain' });
const zipFile = (lines: string[]) =>
  new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), [PHOTO]: new Uint8Array(300).fill(7) }) as BlobPart]);

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

describe('plain-text export', () => {
  test('imports as one chat named from the file name, with no media', async () => {
    const { lib, run } = await setup();
    const r = await imported(run(txtFile([...TEXT_ONLY, OMITTED]), TXT_NAME));
    expect(r.createdConversation).toBe(true);
    expect(r.summary).toMatchObject({ added: 4, alreadyThere: 0, mediaAdded: 0, mediaMissing: 0, rawLines: 0 });
    const [conversation] = await lib.client.call('listConversations');
    expect(conversation.title).toBe('Ana i Bo');
    const messages = await lib.client.call('listMessages', { conversationId: r.conversationId, limit: 100 });
    expect(messages.map((m) => m.type)).toEqual(['text', 'text', 'omitted', 'text']);
  });

  test('importing the same file again adds nothing, and an overlapping newer one only the difference', async () => {
    const { run } = await setup();
    const first = await imported(run(txtFile(TEXT_ONLY), TXT_NAME));
    const again = await imported(run(txtFile(TEXT_ONLY), TXT_NAME));
    expect(again.conversationId).toBe(first.conversationId);
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 3 });
    const newer = await imported(run(txtFile([...TEXT_ONLY, '[19/03/2026, 10:00:00] Ana: Nou']), TXT_NAME));
    expect(newer.summary).toMatchObject({ added: 1, alreadyThere: 3 });
  });

  test('a later ZIP of the same chat dedupes the text and adds the photo next to its placeholder', async () => {
    const { lib, run } = await setup();
    const first = await imported(run(txtFile([...TEXT_ONLY, OMITTED]), TXT_NAME));
    const zip = await imported(run(zipFile([...TEXT_ONLY, ATTACHED]), ZIP_NAME));
    expect(zip.conversationId).toBe(first.conversationId);
    expect(zip.createdConversation).toBe(false);
    // The three text messages are the same messages. The photo line is a different message by
    // content (an attachment, not "omitted"), so it is added next to the placeholder: a text
    // export is not upgraded in place (known limitation, nothing is duplicated twice).
    expect(zip.summary).toMatchObject({ added: 1, alreadyThere: 3, mediaAdded: 1 });
    const messages = await lib.client.call('listMessages', { conversationId: first.conversationId, limit: 100 });
    expect(messages.filter((m) => m.type === 'omitted')).toHaveLength(1);
    expect(messages.filter((m) => m.type === 'photo')).toHaveLength(1);
  });

  test('a text export after a ZIP of the same chat dedupes the text messages', async () => {
    const { run } = await setup();
    await imported(run(zipFile([...TEXT_ONLY, ATTACHED]), ZIP_NAME));
    const txt = await imported(run(txtFile([...TEXT_ONLY, OMITTED]), TXT_NAME));
    expect(txt.summary).toMatchObject({ added: 1, alreadyThere: 3, mediaAdded: 0 });
  });

  test('the import can be undone like any other', async () => {
    const { lib, run } = await setup();
    const r = await imported(run(txtFile(TEXT_ONLY), TXT_NAME));
    const undone = await undoImportBatch(lib.deps, r.batchId);
    expect(undone).toMatchObject({ found: true, removedMessages: 3, removedConversation: true });
    expect(await lib.client.call('listConversations')).toEqual([]);
  });

  test('a generic or hostile file name gives a safe title, never a path', async () => {
    const { lib, run } = await setup();
    await imported(run(txtFile(TEXT_ONLY), '_chat.txt'));
    await imported(run(txtFile(TEXT_ONLY), '<img src=x onerror=alert(1)>.txt', { conversation: { mode: 'new' } }));
    const titles = (await lib.client.call('listConversations')).map((c) => c.title).sort();
    expect(titles).toEqual(['<img src=x onerror=alert(1)>', 'chat']);
  });

  test('a file over the transcript cap is refused as too big, and nothing is written', async () => {
    const { lib, run } = await setup();
    await expect(run(txtFile(TEXT_ONLY), TXT_NAME, { limits: { maxChatBytes: 20 } })).rejects.toMatchObject({
      name: 'ImportError',
      code: 'limit-exceeded',
    });
    expect(await lib.client.call('listConversations')).toEqual([]);
  });

  test('text that is not a chat, binary junk and an empty file are invalid exports', async () => {
    const { lib, run } = await setup();
    const notes = txtFile(['just some notes', 'no timestamps']);
    for (const blob of [notes, new Blob([new Uint8Array([1, 2, 0, 3, 255])]), new Blob([])]) {
      await expect(run(blob, 'notes.txt')).rejects.toMatchObject({ name: 'ImportError', code: 'invalid-export' });
    }
    expect(await lib.client.call('listConversations')).toEqual([]);
  });

  test('the preview reads it as a chat without media and finds the duplicates of an earlier import', async () => {
    const { lib, run } = await setup();
    const preview = (blob: Blob) => previewWhatsAppExport(lib.deps, { zip: blob, fileName: TXT_NAME, profileIds: [] });
    const fresh = await preview(txtFile([...TEXT_ONLY, OMITTED]));
    expect(fresh).toMatchObject({ messageCount: 4, chatTitle: 'Ana i Bo', duplicates: { status: 'new' } });
    expect(fresh.media).toMatchObject({ totalCount: 0, missing: 0 });
    await imported(run(txtFile(TEXT_ONLY), TXT_NAME, { profileIds: [] }));
    const again = await preview(txtFile(TEXT_ONLY));
    expect(again.duplicates).toMatchObject({ status: 'existing', wouldAdd: 0 });
  });
});
