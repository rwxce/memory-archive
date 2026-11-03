import { describe, expect, test } from 'vitest';
import { buildViewerTemplate } from './build-viewer.mjs';
import { VIEWER_DATA_ISLAND, renderViewerHtml } from '../lib/exporters/viewer/html';

describe('viewer template', () => {
  test('is one self-contained file: inline style and script, one data island, nothing remote', async () => {
    const html = await buildViewerTemplate();
    expect(html.split(VIEWER_DATA_ISLAND)).toHaveLength(2);
    expect(html).not.toContain('__VIEWER_STYLE__');
    expect(html).not.toContain('__VIEWER_SCRIPT__');
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<link\b|<img\b[^>]*\bsrc=["']?https?:|@import|url\(\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/\bsrc=["']?(https?:)?\/\/(?!\/)/i);
  });

  test('the script parses and uses no HTML parsing, network or eval', async () => {
    const html = await buildViewerTemplate();
    const script = /<script>\n([\s\S]*)\n<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'eval(', 'new Function', 'fetch(', 'importScripts', 'localStorage', 'indexedDB']) {
      expect(script, banned).not.toContain(banned);
    }
  });

  test('exporting data into it keeps the template intact around the island', async () => {
    const html = await buildViewerTemplate();
    const out = renderViewerHtml(html, '{"format":"x"}');
    expect(out.length).toBeGreaterThan(html.length - 20);
    expect(out).toContain('id="viewer-data">{"format":"x"}</script>');
  });
});
