import { describe, expect, test } from 'vitest';
import { GENERATOR_NAME } from '../legacy/version';
import { VIEWER_DATA_ISLAND, renderViewerHtml } from './html';
import { VIEWER_DATA_FORMAT, VIEWER_SCHEMA_VERSION, type ViewerData, parseViewerData } from './format';

const TEMPLATE = `<html><body><div id="app"></div>${VIEWER_DATA_ISLAND}<script>run()</script></body></html>`;

function data(text: string): ViewerData {
  return {
    format: VIEWER_DATA_FORMAT,
    schemaVersion: VIEWER_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: '0' },
    createdAt: '2025-01-01T00:00:00.000Z',
    selection: { from: null, to: null, includeMedia: false },
    profiles: [],
    conversations: [{ id: 'c', title: text, source: 'whatsapp', isGroup: false, profileIds: [], participants: [], messages: [{ sentAt: '2024-01-01T00:00:00', type: 'text', author: text, isMe: false, text, media: null, mediaName: text }] }],
    media: [],
  };
}

describe('renderViewerHtml', () => {
  test('hostile text cannot close the island, and the data reads back unchanged', () => {
    const hostile = '</script><script>alert(1)</script><!-- $& $1 -->\u2028';
    const html = renderViewerHtml(TEMPLATE, data(hostile));
    const island = /<script type="application\/json" id="viewer-data">([\s\S]*?)<\/script>/.exec(html);
    expect(island).not.toBeNull();
    expect(island![1]).not.toMatch(/<|>/);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(parseViewerData(island![1]).conversations[0].title).toBe(hostile);
    expect(html.endsWith('<script>run()</script></body></html>')).toBe(true);
  });

  test('refuses a template without the island and unsafe pre-serialized data', () => {
    expect(() => renderViewerHtml('<html></html>', data('x'))).toThrow(/no data island/);
    expect(() => renderViewerHtml(TEMPLATE, '{"a":"</script>"}')).toThrow(/not safe/);
  });
});
