import { describe, expect, test } from 'vitest';
import { serializeCsv } from '../../exporters/legacy/csv';
import type { Message } from '../whatsapp/types';
import { readLegacyCsv } from './csv';

describe('readLegacyCsv', () => {
  test('6-column file round-trips', () => {
    const msgs: Message[] = [
      { timestamp_iso: '2026-01-01T10:00:00', type: 'text', author: 'A, B', text: 'x\n"y"', media: '', urlTitles: { u: 'T' } },
    ];
    expect(readLegacyCsv(serializeCsv(msgs))).toEqual({ messages: msgs, schemaVersion: 0, format: 'csv' });
  });

  test('5-column file (before url_titles) gets empty titles', () => {
    const archive = readLegacyCsv(
      '\ufefftimestamp_iso,type,author,text,media\r\n2026-01-01T10:00:00,photo,Ana,,IMG-1.jpg\r\n',
    );
    expect(archive.messages).toEqual([
      { timestamp_iso: '2026-01-01T10:00:00', type: 'photo', author: 'Ana', text: '', media: 'IMG-1.jpg', urlTitles: {} },
    ]);
  });

  test.each(['name,email\na,b\n', 'timestamp_iso,type,author,text\n', 'timestamp_iso,type,author,text,media,extra\n', ''])(
    'refuses a CSV with header %j',
    (text) => {
      expect(() => readLegacyCsv(text)).toThrow(/not a messages.csv/);
    },
  );
});
