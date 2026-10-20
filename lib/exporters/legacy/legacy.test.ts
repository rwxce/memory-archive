import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256 } from './sha256';
import { accentHue } from './colors';
import { mergeMessages, parseCsv, serializeCsv } from './csv';
import { buildMediaMap, bytesToBase64, extOf } from './media';
import { renderHtml } from './html';
import { renderMarkdown } from './md';
import type { Message } from '../../importers/whatsapp/types';

const msg = (timestamp_iso: string, author: string, text: string, media = ''): Message => ({
  timestamp_iso,
  type: media ? 'photo' : 'text',
  author,
  text,
  media,
});

describe('sha256 (sync, platform-neutral)', () => {
  test.each(['', 'abc', 'Guionardo Furlan', '‪+55 99 99951-1234‬', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)])(
    'matches node:crypto for %j',
    (input) => {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      const actual = Buffer.from(sha256(new TextEncoder().encode(input))).toString('hex');
      expect(actual).toBe(expected);
    },
  );

  test('accent hue is the first 4 bytes of the digest modulo 360', () => {
    const d = createHash('sha256').update('Ana', 'utf8').digest();
    expect(accentHue('Ana')).toBe(d.readUInt32BE(0) % 360);
  });
});

describe('csv (pure)', () => {
  test('serialize -> parse round-trip', () => {
    const rows = [{ ...msg('2026-01-01T00:00:00', 'A,B', 'line\nwith "quotes"'), urlTitles: {} }];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });

  test('mergeMessages dedupes and sorts stably', () => {
    const a = msg('2026-01-01T10:00:00', 'A', 'one');
    const b = msg('2026-01-01T09:00:00', 'B', 'zero');
    const { messages, added } = mergeMessages([a], [a, b]);
    expect(added).toBe(1);
    expect(messages).toEqual([b, a]);
  });
});

describe('media + renderers (no file system)', () => {
  test('extOf / bytesToBase64', () => {
    expect(extOf('photo (1).JPG')).toBe('.JPG');
    expect(extOf('.hidden')).toBe('');
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  test('buildMediaMap resolves from a file list', () => {
    const map = buildMediaMap([{ name: 'IMG-1 (1).jpg', size: 3 }], [msg('2026-01-01T00:00:00', 'A', '', 'IMG-1.jpg')]);
    expect(map.get('IMG-1.jpg')).toEqual({
      relPath: 'media/IMG-1 (1).jpg',
      mime: 'image/jpeg',
      size: 3,
      inlineable: true,
    });
  });

  test('inline rendering uses the provided data-URI loader', async () => {
    const messages = [msg('2026-01-01T00:00:00', 'A', '', 'IMG-1.jpg')];
    const media = buildMediaMap([{ name: 'IMG-1.jpg', size: 2 }], messages);
    const loadDataUri = async () => 'data:image/jpeg;base64,aGk=';
    const html = await renderHtml(messages, 'Chat', { media, inline: true, loadDataUri });
    const md = await renderMarkdown(messages, 'Chat', { media, inline: true, loadDataUri });
    expect(html).toContain('src="data:image/jpeg;base64,aGk="');
    expect(md).toContain('](data:image/jpeg;base64,aGk=)');
  });
});
