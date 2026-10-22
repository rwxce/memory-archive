import { describe, expect, test } from 'vitest';
import { readLegacyOutput } from './read';

const JSON_TEXT = '{"messages":[]}';
const HTML_TEXT = '<!DOCTYPE html><script type="application/json" id="chat-data">{"messages":[]}</script>';
const CSV_TEXT = 'timestamp_iso,type,author,text,media,url_titles\n';

describe('readLegacyOutput', () => {
  test('dispatches by extension', () => {
    expect(readLegacyOutput('messages.json', JSON_TEXT).format).toBe('json');
    expect(readLegacyOutput('messages.HTML', HTML_TEXT).format).toBe('html');
    expect(readLegacyOutput('messages.csv', CSV_TEXT).format).toBe('csv');
  });

  test('sniffs content when the extension is unknown', () => {
    expect(readLegacyOutput('export', JSON_TEXT).format).toBe('json');
    expect(readLegacyOutput('export', HTML_TEXT).format).toBe('html');
    expect(readLegacyOutput('export', CSV_TEXT).format).toBe('csv');
    expect(() => readLegacyOutput('export', 'hello')).toThrow(/unrecognised/);
  });

  test('Markdown is refused with the reason', () => {
    expect(() => readLegacyOutput('messages.md', '# Chat')).toThrow(/lossy/);
  });
});
