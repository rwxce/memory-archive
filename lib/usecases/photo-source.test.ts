import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { googlePhotosDownloadZip, jpeg, mp4, png, htmlDisguisedAsJpeg } from '../../scripts/photo-fixtures.mjs';
import { takeoutZip } from '../../scripts/takeout-fixtures.mjs';
import { ARCHIVE_FORMAT_NAME } from '../domain/archive';
import { CHANGES_PACK_FORMAT_NAME } from '../domain/changes-pack';
import { exportArchive } from './archive';
import { encryptBackup } from '../exporters/archive/encrypt';
import { detectPhotoSource } from './photo-source';
import { createTestLibrary } from './test-client';

const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);
const zipOf = (files: Record<string, Uint8Array>) => blob(zipSync(files, { level: 0 }));
const manifest = (format: string) => strToU8(JSON.stringify({ format }));

describe('detectPhotoSource', () => {
  test('a Takeout ZIP, a Google Photos download and a single picture or video', async () => {
    expect(await detectPhotoSource(blob(takeoutZip()))).toEqual({ kind: 'takeout-album' });
    expect(await detectPhotoSource(blob(googlePhotosDownloadZip()))).toEqual({ kind: 'google-photos-zip' });
    expect(await detectPhotoSource(blob(jpeg(1)))).toEqual({ kind: 'media' });
    expect(await detectPhotoSource(blob(mp4(1)))).toEqual({ kind: 'media' });
  });

  test('a flat ZIP with metadata JSON files is a Takeout', async () => {
    expect(await detectPhotoSource(zipOf({ 'a.jpg': jpeg(1), 'a.jpg.json': strToU8('{}') }))).toEqual({ kind: 'takeout-album' });
  });

  test('a WhatsApp chat export, with or without pictures', async () => {
    expect(await detectPhotoSource(zipOf({ '_chat.txt': strToU8('[01/07/2019, 10:00:00] Ana: hi'), 'IMG-1.jpg': jpeg(1) }))).toEqual({ kind: 'whatsapp-chat' });
    expect(await detectPhotoSource(zipOf({ 'WhatsApp Chat with Ana.txt': strToU8('01/07/2019, 10:00 - Ana: hi') }))).toEqual({ kind: 'whatsapp-chat' });
  });

  test('this app\'s own backup and changes pack, by their manifest; an encrypted backup is a backup', async () => {
    const lib = await createTestLibrary();
    const { blob: backup } = await exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1' });
    expect(await detectPhotoSource(backup)).toEqual({ kind: 'backup' });
    expect(await detectPhotoSource(zipOf({ 'manifest.json': manifest(ARCHIVE_FORMAT_NAME) }))).toEqual({ kind: 'backup' });
    expect(await detectPhotoSource(zipOf({ 'manifest.json': manifest(CHANGES_PACK_FORMAT_NAME) }))).toEqual({ kind: 'changes-pack' });
    expect(await detectPhotoSource(await encryptBackup(backup, 'a password', { iterations: 10_000 }))).toEqual({ kind: 'backup' });
  });

  test.each([
    ['text', blob(strToU8('hello there, this is not a picture'))],
    ['a page named like a picture', blob(htmlDisguisedAsJpeg())],
    ['empty', blob(new Uint8Array(0))],
    ['a ZIP without pictures', zipOf({ 'a.pdf': strToU8('%PDF'), 'b.docx': strToU8('x') })],
    ['a ZIP with an unreadable tail', blob(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))],
    ['a manifest that is not ours and nothing else', zipOf({ 'manifest.json': manifest('something-else') })],
  ])('%s is unsupported', async (_name, file) => {
    expect(await detectPhotoSource(file)).toEqual({ kind: 'unsupported' });
  });

  test.each([
    ['a .docx', { '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<d/>'), 'word/media/image1.png': png(1), 'word/media/image2.png': png(2) }],
    ['a .pptx', { '[Content_Types].xml': strToU8('<Types/>'), 'ppt/media/image1.jpg': jpeg(1), 'ppt/media/image2.jpg': jpeg(2) }],
    ['a .xlsx', { 'xl/media/image1.png': png(1), 'xl/workbook.xml': strToU8('<w/>') }],
    ['an .epub', { mimetype: strToU8('application/epub+zip'), 'META-INF/container.xml': strToU8('<c/>'), 'OEBPS/cover.jpg': jpeg(1), 'OEBPS/p1.jpg': jpeg(2) }],
    ['an .odt', { mimetype: strToU8('application/vnd.oasis.opendocument.text'), 'Pictures/1.png': png(1), 'content.xml': strToU8('<c/>') }],
    ['an .apk', { 'AndroidManifest.xml': strToU8('<m/>'), 'res/a.png': png(1), 'res/b.png': png(2), 'res/c.png': png(3) }],
    ['a project folder with a few pictures among many files', { 'a.png': png(1), 'main.c': strToU8('x'), 'b.c': strToU8('x'), 'c.h': strToU8('x') }],
  ])('%s that embeds pictures is unsupported', async (_name, files) => {
    expect(await detectPhotoSource(zipOf(files))).toEqual({ kind: 'unsupported' });
  });

  test('thumbnails, notes and captions beside pictures do not make a download unsupported', async () => {
    const files = { 'a.jpg': jpeg(1), 'b.jpg': jpeg(2), 'index.html': strToU8('<p/>'), 'notes.txt': strToU8('x'), 'captions.csv': strToU8('x') };
    expect(await detectPhotoSource(zipOf(files))).toEqual({ kind: 'google-photos-zip' });
  });

  test('a ZIP over the entry limit is refused with a typed error', async () => {
    await expect(detectPhotoSource(zipOf({ 'a.jpg': jpeg(1), 'b.jpg': jpeg(2) }), { maxEntries: 1 })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  test('a stray text file beside pictures does not make a download a chat; a lone text file still does', async () => {
    expect(await detectPhotoSource(zipOf({ 'notes.txt': strToU8('hello'), 'a.jpg': jpeg(1) }))).toEqual({ kind: 'google-photos-zip' });
    expect(await detectPhotoSource(zipOf({ 'notes.txt': strToU8('hello') }))).toEqual({ kind: 'whatsapp-chat' });
  });

  test('the file name plays no part: only content decides', async () => {
    const renamed = new File([googlePhotosDownloadZip() as BlobPart], 'WhatsApp Chat - Ana.zip');
    expect(await detectPhotoSource(renamed)).toEqual({ kind: 'google-photos-zip' });
  });
});
