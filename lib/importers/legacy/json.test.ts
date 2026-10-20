import { describe, expect, test } from 'vitest';
import { buildEnvelope } from '../../exporters/legacy/json';
import type { Message } from '../whatsapp/types';
import { legacyArchiveFromEnvelope, readLegacyJson } from './json';

const MSGS: Message[] = [
  { timestamp_iso: '2026-01-01T10:00:00', type: 'text', author: 'Ana', text: 'oi https://e.com', media: '', urlTitles: { 'https://e.com': 'E' } },
  { timestamp_iso: '2026-01-01T10:01:00', type: 'audio', author: 'Bo', text: '', media: 'PTT-1.opus', urlTitles: {} },
];

describe('readLegacyJson', () => {
  test('schema 1 envelope round-trips to the same messages', () => {
    const archive = readLegacyJson(JSON.stringify(buildEnvelope(MSGS, 'Chat')));
    expect(archive).toMatchObject({
      schemaVersion: 1,
      chatName: 'Chat',
      format: 'json',
      generator: { name: 'memory-archive' },
    });
    expect(archive.messages).toEqual(MSGS);
  });

  test('schema 0 (wa-backup, no schemaVersion/generator/urlTitles) is accepted', () => {
    const v0 = {
      metadata: { chatName: 'Old', messageCount: 1, dateRange: ['2025-01-01', '2025-01-01'], exportSource: 'whatsapp-export' },
      messages: [
        { timestampIso: '2025-01-01T08:00:00', type: 'text', author: 'Ana', text: 'hi', media: '', mediaPath: null, day: '2025-01-01', time: '08:00:00' },
      ],
    };
    const archive = readLegacyJson('\ufeff' + JSON.stringify(v0));
    expect(archive.schemaVersion).toBe(0);
    expect(archive.generator).toBeUndefined();
    expect(archive.messages).toEqual([
      { timestamp_iso: '2025-01-01T08:00:00', type: 'text', author: 'Ana', text: 'hi', media: '', urlTitles: {} },
    ]);
  });

  test.each([
    ['not json', /invalid JSON/],
    ['{"metadata":{}}', /no "messages" array/],
    ['{"schemaVersion":2,"messages":[]}', /newer than this reader/],
    ['{"schemaVersion":"1","messages":[]}', /invalid schemaVersion/],
    ['{"messages":[{"timestampIso":"yesterday","type":"text"}]}', /local ISO timestamp/],
    ['{"messages":[{"timestampIso":"2026-01-01T00:00:00","type":"poll"}]}', /unknown/],
    ['{"messages":[{"timestampIso":"2026-01-01T00:00:00","type":"text","author":7}]}', /author is not a string/],
  ])('rejects %s', (text, error) => {
    expect(() => readLegacyJson(text)).toThrow(error);
  });

  test('non-string url titles are dropped, not trusted', () => {
    const archive = legacyArchiveFromEnvelope({
      messages: [{ timestampIso: '2026-01-01T00:00:00', type: 'text', text: 'x', urlTitles: { a: 'A', b: 3 } }],
    });
    expect(archive.messages[0].urlTitles).toEqual({ a: 'A' });
    expect(archive.messages[0].author).toBe('');
  });
});
