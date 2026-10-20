import { describe, expect, test } from 'vitest';
import { renderHtml } from '../../exporters/legacy/html';
import type { Message } from '../whatsapp/types';
import { extractChatDataJson, readLegacyHtml } from './html';

const MSGS: Message[] = [
  { timestamp_iso: '2026-01-01T10:00:00', type: 'text', author: 'Ana <x>', text: 'a </script><script>alert(1)</script> b', media: '', urlTitles: {} },
  { timestamp_iso: '2026-01-01T10:01:00', type: 'text', author: 'Bo', text: 'ação ✓ "quotes" & \\ backslash\nnew line', media: '', urlTitles: {} },
];

describe('readLegacyHtml', () => {
  test('reads back the island of a generated page, including </script> in text', async () => {
    const html = await renderHtml(MSGS, 'Chat');
    const archive = readLegacyHtml(html);
    expect(archive).toMatchObject({ format: 'html', chatName: 'Chat', schemaVersion: 1 });
    expect(archive.messages).toEqual(MSGS);
  });

  test('tolerates attribute order, single quotes and upper case', () => {
    const json = JSON.stringify({ messages: [] });
    for (const tag of [
      `<script id="chat-data" type="application/json">`,
      `<SCRIPT type='application/json' id='chat-data'>`,
      `<script type="application/json" id=chat-data >`,
    ]) {
      expect(extractChatDataJson(`<html><body>${tag}\n${json}\n</script></body></html>`)).toBe(json);
    }
  });

  test('ignores other scripts and similar ids', () => {
    const html =
      '<script id="chat-data-old">{"messages":[1]}</script>' +
      '<script>var x = "chat-data";</script>' +
      '<script type="application/json" id="chat-data">{"messages":[]}</script>';
    expect(readLegacyHtml(html).messages).toEqual([]);
  });

  test('a page without the island, or with broken JSON, is refused', () => {
    expect(() => readLegacyHtml('<html></html>')).toThrow(/no <script id="chat-data">/);
    expect(() => readLegacyHtml('<script id="chat-data">{oops</script>')).toThrow(/not valid JSON/);
  });
});
