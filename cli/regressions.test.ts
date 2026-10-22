/**
 * Regression tests for the known CLI bugs fixed in Phase 1 (see
 * docs/roadmap.md "Known issues"). Each block names the bug it guards.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';
import { zipSync } from 'fflate';
import { renderOutputs, runParser } from './pipeline';
import { readCsv } from './csv';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a synthetic export ZIP; returns its path. */
function exportZip(chat: string, lines: string[], media: Record<string, Uint8Array> = {}): string {
  const files: Record<string, Uint8Array> = {
    [`${chat}/_chat.txt`]: new TextEncoder().encode(lines.join('\n') + '\n'),
  };
  for (const [name, bytes] of Object.entries(media)) files[`${chat}/${name}`] = bytes;
  const zipPath = path.join(tmp('ma-reg-zip-'), 'export.zip');
  fs.writeFileSync(zipPath, zipSync(files));
  return zipPath;
}

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

function island(html: string): { messages: Array<Record<string, unknown>> } {
  const m = html.match(/<script type="application\/json" id="chat-data">([\s\S]*?)<\/script>/);
  return JSON.parse(m![1]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTML viewer script is inlined (transcript.js was missing from dist/)', () => {
  test('messages.html embeds a classic, self-contained script — no file read, no relative imports', async () => {
    const out = tmp('ma-reg-js-');
    await runParser(exportZip('WhatsApp Chat - Js', ['[01/02/2026 10:00:00] Ana: oi']), { out });
    const html = read(path.join(out, 'js'), 'messages.html');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const viewer = scripts.find((s) => s[2].includes('function populateTranscript'));
    expect(viewer).toBeDefined();
    expect(viewer![1]).not.toMatch(/type="module"/);
    expect(viewer![2]).not.toMatch(/^\s*import\s/m);
  });
});

describe('link titles are opt-in and never wiped (--no-fetch-titles wiped stored titles)', () => {
  test('default run makes no network request', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = tmp('ma-reg-net-');
    await runParser(exportZip('WhatsApp Chat - Net', ['[01/02/2026 10:00:00] Ana: https://example.com/a']), { out });
    expect(spy).not.toHaveBeenCalled();
  });

  test('a later offline run keeps titles fetched earlier; a later online run fetches only new URLs', async () => {
    let hits = 0;
    const srv = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = createServer((req, res) => {
        hits += 1;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<title>Title ${req.url}</title>`);
      });
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
      });
    });
    try {
      const chat = 'WhatsApp Chat - Keep';
      const first = [`[01/02/2026 10:00:00] Ana: see ${srv.url}/a`];
      const out = tmp('ma-reg-keep-');
      const guard = { allowPrivateHosts: true };
      await runParser(exportZip(chat, first), { out, fetchTitles: true, titleGuard: guard });
      const csvPath = path.join(out, 'keep', 'messages.csv');
      expect(readCsv(csvPath)[0].urlTitles).toEqual({ [`${srv.url}/a`]: 'Title /a' });
      expect(hits).toBe(1);

      // Offline re-run: nothing fetched, nothing wiped.
      await runParser(exportZip(chat, first), { out });
      expect(readCsv(csvPath)[0].urlTitles).toEqual({ [`${srv.url}/a`]: 'Title /a' });
      expect(hits).toBe(1);

      // Online re-run with one new URL: only that one is fetched.
      const second = [...first, `[01/02/2026 10:05:00] Bo: and ${srv.url}/b`];
      await runParser(exportZip(chat, second), { out, fetchTitles: true, titleGuard: guard });
      const rows = readCsv(csvPath);
      expect(rows[1].urlTitles).toEqual({ [`${srv.url}/b`]: 'Title /b' });
      expect(hits).toBe(2);
    } finally {
      srv.close();
    }
  });

  test('--fetch-titles refuses loopback targets without the test-only override', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = tmp('ma-reg-ssrf-');
    await runParser(
      exportZip('WhatsApp Chat - Ssrf', [
        '[01/02/2026 10:00:00] Ana: http://127.0.0.1:9/admin http://169.254.169.254/latest/meta-data',
      ]),
      { out, fetchTitles: true },
    );
    expect(spy).not.toHaveBeenCalled();
    // Offline-derived labels are stored instead.
    expect(readCsv(path.join(out, 'ssrf', 'messages.csv'))[0].urlTitles).toEqual({
      'http://127.0.0.1:9/admin': '127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data': '169.254.169.254/latest/meta-data',
    });
  });
});

describe('media rendering', () => {
  const chat = 'WhatsApp Chat - Media';
  const lines = [
    '[01/02/2026 10:00:00] Ana: <attached: 00000001-PHOTO-2026-02-01-10-00-00.jpg>',
    '[01/02/2026 10:01:00] Ana: <attached: 00000002-VIDEO-2026-02-01-10-01-00.mp4>',
    '[01/02/2026 10:02:00] Bo: <attached: 00000003-AUDIO-2026-02-01-10-02-00.opus>',
    '[01/02/2026 10:03:00] Bo: <attached: PTT-20260201-WA0004.opus>',
    '[01/02/2026 10:04:00] Bo: <attached: AUD-20260201-WA0005.m4a>',
  ];
  const media = {
    '00000001-PHOTO-2026-02-01-10-00-00.jpg': new Uint8Array([1]),
    '00000002-VIDEO-2026-02-01-10-01-00.mp4': new Uint8Array([2]),
    '00000003-AUDIO-2026-02-01-10-02-00.opus': new Uint8Array([3]),
    'PTT-20260201-WA0004.opus': new Uint8Array([4]),
  };

  async function render() {
    const out = tmp('ma-reg-media-');
    await runParser(exportZip(chat, lines, media), { out });
    return path.join(out, 'media');
  }

  test('mediaPath is filled in the JSON embedded in messages.html (was always null)', async () => {
    const dir = await render();
    const data = island(read(dir, 'messages.html'));
    expect(data.messages[0].mediaPath).toBe('media/00000001-PHOTO-2026-02-01-10-00-00.jpg');
    expect(data.messages[4].mediaPath).toBeNull(); // AUD-… not in the ZIP
    // Same as messages.json.
    expect(JSON.parse(read(dir, 'messages.json')).messages.map((m: { mediaPath: unknown }) => m.mediaPath)).toEqual(
      data.messages.map((m) => m.mediaPath),
    );
  });

  test('<video> and <audio> elements are closed', async () => {
    const html = read(await render(), 'messages.html');
    expect(html).toContain(
      '<video class="media-video" src="media/00000002-VIDEO-2026-02-01-10-01-00.mp4" controls preload="metadata"></video>',
    );
    expect(html.match(/<video\b/g)?.length).toBe(html.match(/<\/video>/g)?.length);
    expect(html.match(/<audio\b/g)?.length).toBe(html.match(/<\/audio>/g)?.length);
  });

  test('audio type: classified, <audio controls> in HTML, link in Markdown, placeholder when missing', async () => {
    const dir = await render();
    expect(readCsv(path.join(dir, 'messages.csv')).map((m) => m.type)).toEqual([
      'photo',
      'video',
      'audio',
      'audio',
      'audio',
    ]);
    const html = read(dir, 'messages.html');
    expect(html).toContain('<audio class="media-audio" src="media/PTT-20260201-WA0004.opus" controls preload="metadata"></audio>');
    expect(html).toContain('<span class="media-placeholder">🎧 audio: AUD-20260201-WA0005.m4a</span>');
    const md = read(dir, 'messages.md');
    expect(md).toContain('[🎧 audio: 00000003-AUDIO-2026-02-01-10-02-00.opus](media/00000003-AUDIO-2026-02-01-10-02-00.opus)');
    expect(md).toContain('[🎧 audio: AUD-20260201-WA0005.m4a]');
  });

  test('--inline embeds audio as a data URI', async () => {
    const out = tmp('ma-reg-inline-');
    await runParser(exportZip(chat, lines, media), { out, inline: true });
    expect(read(path.join(out, 'media'), 'messages.html')).toContain('<audio class="media-audio" src="data:audio/ogg;base64,');
  });
});

describe('--me chooses the outgoing side (was guessed by message count)', () => {
  const lines = [
    '[01/02/2026 10:00:00] Ana: um',
    '[01/02/2026 10:10:00] Ana: dois',
    '[01/02/2026 10:20:00] Ana: três',
    '[01/02/2026 10:30:00] Bo: quatro',
  ];

  test('default guess: most frequent author is outgoing', async () => {
    const out = tmp('ma-reg-me0-');
    await runParser(exportZip('WhatsApp Chat - Me', lines), { out });
    const html = read(path.join(out, 'me'), 'messages.html');
    expect(html).toContain('data-me="Ana"');
    expect(html).toMatch(/class="bubble-row outgoing" data-author="Ana"/);
  });

  test('--me Bo makes Bo outgoing (case-insensitive match)', async () => {
    const out = tmp('ma-reg-me1-');
    await runParser(exportZip('WhatsApp Chat - Me', lines), { out, me: 'bo' });
    const html = read(path.join(out, 'me'), 'messages.html');
    expect(html).toContain('data-me="Bo"');
    expect(html).toMatch(/class="bubble-row outgoing" data-author="Bo"/);
    expect(html).toMatch(/class="bubble-row incoming" data-author="Ana"/);
  });

  test('unknown --me warns and falls back to the guess', async () => {
    const out = tmp('ma-reg-me2-');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runParser(exportZip('WhatsApp Chat - Me', lines), { out });
    await renderOutputs(path.join(out, 'me'), 'Me', { me: 'Nobody' });
    expect(err.mock.calls.flat().join('\n')).toContain('--me "Nobody" matches no author');
    expect(read(path.join(out, 'me'), 'messages.html')).toContain('data-me="Ana"');
  });
});
