# URL Title Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch webpage `<title>` for URLs in chat messages during CSV generation, store the URL→title map in the CSV (`url_titles`) and JSON (`urlTitles`), and render human-readable link labels in HTML/Markdown.

**Architecture:** A new `src/title.ts` enriches `Message.urlTitles` after the CSV is merged but before rendering; it fetches with the built-in `fetch` (no dependency), de-dupes URLs, and bounds concurrency. `linkifyHtml`/`linkifyMarkdown` gain a `resolver(url)` so renderers substitute the stored title. `runParser` persists the enriched map back into the CSV so it is the source-of-truth.

**Tech Stack:** TypeScript / ESM, Node ≥ 22.12 (built-in `fetch`, `AbortController`); `node:test` + `node:assert/strict`; run via `node --import tsx`.

## Global Constraints

- Node ≥ 22.12 (dev 26.5), ESM, `"type": "module"`. (from STACK.md / AGENTS)
- **No new runtime dependency** — use built-in `fetch` (from design decision).
- **XSS-safe (OUT-05):** all titles escaped at render; `linkify` already HTML/MD-escapes (from spec).
- **Fetch ONLY during CSV generation;** HTML/MD/JSON consume the stored title statically (from design decision).
- `--no-fetch-titles` opt-out for offline runs (from design decision).
- Memory-safe: messages are already in memory in `runParser`; enrichment adds only a bounded pool + a URL→title map (from spec).

---

## File Structure

- `src/parse/types.ts` — add `urlTitles?` to `Message`.
- `src/csv.ts` — 6-column header/row/read; `dedupeKey` unchanged.
- `src/render/json.ts` — `RenderedMessage.urlTitles`; `toRendered`.
- `src/render/js/linkify.js` — export `URL_RE`; add `resolver` param to `linkifyHtml`/`linkifyMarkdown`.
- `src/title.ts` (new) — `extractTitle`, `fetchTitle`, `enrichTitles`.
- `src/render/html.ts` — pass per-message `resolver` to `linkifyHtml`.
- `src/render/md.ts` — pass per-message `resolver` to `linkifyMarkdown`.
- `src/model.ts` — enrichment step in `runParser`; `RunOptions.noFetchTitles`.
- `src/index.ts` — `--no-fetch-titles` flag.
- `test/title.test.ts` (new), plus edits to `test/csv.test.ts`, `test/render.test.ts`, `test/integration.test.ts`, `test/tracer.test.ts` (header assertions).

---

### Task 1: CSV schema gains `url_titles` column

**Files:**
- Modify: `src/parse/types.ts`
- Modify: `src/csv.ts` (`csvHeader`, `csvRow`, `readCsv`)
- Test: `test/csv.test.ts`
- Also modify header-assertion sites: `test/csv.test.ts:90`, `test/integration.test.ts:57`, `test/tracer.test.ts:84`

**Interfaces:**
- `Message.urlTitles?: Record<string, string>` — produced by `enrichTitles` (Task 4), consumed by `linkify` resolver (Task 5) and JSON (Task 2).
- `csvRow(m)` / `readCsv(path)` — 6-field round-trip of `urlTitles` as a JSON string.

- [ ] **Step 1: Write the failing tests** (append to `test/csv.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvHeader, csvRow, readCsv, writeCsv } from '../src/csv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('csv: url_titles round-trips as a JSON map', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-csvurl-'));
  const p = path.join(dir, 'messages.csv');
  const msg = {
    timestamp_iso: '2026-07-23T09:47:18',
    type: 'text' as const,
    author: 'Guionardo',
    text: 'see https://example.com/page',
    media: '',
    urlTitles: { 'https://example.com/page': 'Example Page' },
  };
  await writeCsv(p, [msg]);
  const back = readCsv(p);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].urlTitles, { 'https://example.com/page': 'Example Page' });
});

test('csv: legacy 5-column row parses with empty urlTitles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-csvurl2-'));
  const p = path.join(dir, 'messages.csv');
  fs.writeFileSync(p, 'timestamp_iso,type,author,text,media\n2026-07-23T09:47:18,text,Guionardo,hi,\n');
  const back = readCsv(p);
  assert.deepEqual(back[0].urlTitles, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/csv.test.ts`
Expected: FAIL (`urlTitles` undefined / deepEqual mismatch).

- [ ] **Step 3: Write minimal implementation**

In `src/parse/types.ts`, add to the `Message` interface (after `media`):

```ts
  /** Per-URL fetched page titles (enrichment); `{}` when absent/disabled. */
  urlTitles?: Record<string, string>;
```

In `src/csv.ts`:
- `csvHeader()` → `return 'timestamp_iso,type,author,text,media,url_titles\n';`
- `csvRow(m)` → change the array to:
  ```ts
  return [m.timestamp_iso, m.type, m.author, m.text, m.media, JSON.stringify(m.urlTitles ?? {})]
    .map(csvField)
    .join(',') + '\n';
  ```
- In `readCsv`, change the `out.push({...})` to include `urlTitles`:
  ```ts
  out.push({
    timestamp_iso: unescapeField(rec[0]),
    type: rec[1] as Message['type'],
    author: unescapeField(rec[2]),
    text: unescapeField(rec[3]),
    media: unescapeField(rec[4]),
    urlTitles: rec.length >= 6 ? jsonOrEmpty(unescapeField(rec[5])) : {},
  });
  ```
- Add this helper near `unescapeField`:
  ```ts
  function jsonOrEmpty(s: string): Record<string, string> {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  ```

- [ ] **Step 4: Update the 3 header-assertion sites**

Replace the literal `'timestamp_iso,type,author,text,media'` in these assertions with the 6-column header:
- `test/csv.test.ts:90`: `assert.equal(raw.toString('utf8').split('\n')[0], 'timestamp_iso,type,author,text,media,url_titles');`
- `test/integration.test.ts:57`: same replacement.
- `test/tracer.test.ts:84`: same replacement (`text.split('\n')[0]`).

(Leave `test/media.test.ts:97`/`110` fixture headers as 5-column — `readCsv` tolerates them and yields `urlTitles: {}`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/csv.test.ts test/integration.test.ts test/tracer.test.ts`
Expected: PASS (and the updated header assertions pass).

- [ ] **Step 6: Commit**

```bash
git add src/parse/types.ts src/csv.ts test/csv.test.ts test/integration.test.ts test/tracer.test.ts
git commit -m "feat(csv): add url_titles column + Message.urlTitles (6-col schema)"
```

---

### Task 2: JSON envelope carries `urlTitles`

**Files:**
- Modify: `src/render/json.ts` (`RenderedMessage`, `toRendered`)
- Test: `test/render.test.ts`

**Interfaces:**
- `RenderedMessage.urlTitles: Record<string, string>` — consumed by JSON readers / the data island.

- [ ] **Step 1: Write the failing test** (append to `test/render.test.ts`)

```ts
test('JSON: message carries urlTitles map', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jsonurl-'));
  await runFixture(WK, out);
  const env = readJson(out, WK);
  const withUrl = env.messages.find((m) => m.text && /https?:\/\//.test(m.text));
  // runFixture includes no URLs in WK sample; assert the field exists and is an object
  assert.ok(withUrl === undefined || (withUrl.urlTitles && typeof withUrl.urlTitles === 'object'));
  // explicitly unit-check toRendered maps it
  const r = toRendered(
    { timestamp_iso: '2026-07-23T09:47:18', type: 'text', author: 'a', text: 'x', media: '', urlTitles: { u: 'T' } },
  );
  assert.deepEqual(r.urlTitles, { u: 'T' });
});
```
(Import `toRendered` from `../src/render/json` at the top of the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/render.test.ts`
Expected: FAIL (`urlTitles` missing on `RenderedMessage`).

- [ ] **Step 3: Write minimal implementation**

In `src/render/json.ts`:
- Add to `RenderedMessage` interface: `urlTitles: Record<string, string>;`
- In `toRendered`, add: `urlTitles: m.urlTitles ?? {},`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/json.ts test/render.test.ts
git commit -m "feat(json): carry urlTitles map on rendered messages"
```

---

### Task 3: `linkify` exposes `URL_RE` and a `resolver`

**Files:**
- Modify: `src/render/js/linkify.js` (`linkifyHtml`, `linkifyMarkdown`, export `URL_RE`)
- Test: `test/linkify.test.ts`

**Interfaces:**
- `export const URL_RE` — reused by `src/title.ts` (Task 4) for URL detection.
- `linkifyHtml(text, resolver?)` / `linkifyMarkdown(text, resolver?)` where `resolver: (url: string) => string`; default = `deriveTitle`. Anchor/MD text uses `resolver(url)`.

- [ ] **Step 1: Write the failing test** (append to `test/linkify.test.ts`)

```ts
test('linkify: resolver overrides the displayed title', () => {
  const out = linkifyHtml('go https://example.com/x', (u) => (u.includes('example.com') ? 'Fetched Title' : u));
  assert.ok(out.includes('>Fetched Title</a>'), 'html uses resolver label');
  assert.ok(out.includes('href="https://example.com/x"'), 'href unchanged');
  const md = linkifyMarkdown('go https://example.com/x', () => 'Fetched Title');
  assert.ok(md.includes('[Fetched Title](https://example.com/x)'), 'md uses resolver label');
});

test('linkify: resolver defaults to deriveTitle when omitted', () => {
  const out = linkifyHtml('see https://example.com/path');
  assert.ok(out.includes('>example.com/path</a>'), 'falls back to derived title');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/linkify.test.ts`
Expected: FAIL (resolver arg ignored / wrong label).

- [ ] **Step 3: Write minimal implementation**

In `src/render/js/linkify.js`:
- Change line 5 to: `export const URL_RE = /(https?:\/\/[^\s<>"'`]+)/gi;`
- Replace `linkifyHtml`:
```js
export function linkifyHtml(text, resolver) {
  if (!text) return '';
  const resolve = resolver ?? deriveTitle;
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, m.index));
    const url = trimTrailingPunct(m[0]);
    const href = escapeHtml(url);
    const title = escapeHtml(resolve(url));
    result += `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    last = m.index + m[0].length;
  }
  result += escapeHtml(text.slice(last));
  return result;
}
```
- Replace `linkifyMarkdown`:
```js
export function linkifyMarkdown(text, resolver) {
  if (!text) return '';
  const resolve = resolver ?? deriveTitle;
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeMd(text.slice(last, m.index));
    const url = trimTrailingPunct(m[0]);
    const title = resolve(url).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    result += `[${title}](${safeUrl})`;
    last = m.index + m[0].length;
  }
  result += escapeMd(text.slice(last));
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/linkify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/js/linkify.js test/linkify.test.ts
git commit -m "feat(linkify): accept resolver(url) for display title; export URL_RE"
```

---

### Task 4: `src/title.ts` — extraction, fetch, enrichment

**Files:**
- Create: `src/title.ts`
- Test: `test/title.test.ts` (new)
- Depends on: `URL_RE`, `deriveTitle` from `src/render/js/linkify.js` (Task 3).

**Interfaces:**
- `extractTitle(html: string): string | null`
- `fetchTitle(url: string, opts?: { timeoutMs?: number }): Promise<string>` — returns `deriveTitle(url)` on any failure/non-HTML.
- `enrichTitles(messages: Message[], opts?: { enabled?: boolean; concurrency?: number; timeoutMs?: number }): Promise<Message[]>` — mutates `messages[i].urlTitles`.

- [ ] **Step 1: Write the failing tests** (create `test/title.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { extractTitle, fetchTitle, enrichTitles } from '../src/title';
import type { Message } from '../src/parse/types';

function startServer(body: string, { contentType = 'text/html; charset=utf-8', delayMs = 0 } = {}) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = createServer((_req, res) => {
      if (delayMs > 0) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': contentType });
          res.end(body);
        }, delayMs);
      } else {
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => srv.close() });
    });
  });
}

test('extractTitle: pulls and sanitizes <title>', () => {
  const t = extractTitle('<html><head><title>  Hello\n\tWorld  </title></head></html>');
  assert.equal(t, 'Hello World');
});

test('extractTitle: null when absent', () => {
  assert.equal(extractTitle('<html></html>'), null);
});

test('fetchTitle: returns fetched title for html', async () => {
  const srv = await startServer('<title>My Page</title>');
  try {
    assert.equal(await fetchTitle(srv.url), 'My Page');
  } finally {
    srv.close();
  }
});

test('fetchTitle: falls back to derived title on timeout', async () => {
  const srv = await startServer('<title>Slow</title>', { delayMs: 200 });
  try {
    const r = await fetchTitle(srv.url, { timeoutMs: 40 });
    assert.ok(r.includes('127.0.0.1'), 'fell back to derived (host) title');
  } finally {
    srv.close();
  }
});

test('fetchTitle: falls back on non-html content', async () => {
  const srv = await startServer('plain text', { contentType: 'text/plain' });
  try {
    const r = await fetchTitle(srv.url);
    assert.ok(r.includes('127.0.0.1'), 'non-html -> derived title');
  } finally {
    srv.close();
  }
});

test('enrichTitles: maps each URL to a title and dedupes fetches', async () => {
  const srv = await startServer('<title>Shared Title</title>');
  try {
    const msgs: Message[] = [
      { timestamp_iso: '2026-07-23T09:47:18', type: 'text', author: 'a', text: 'one https://example.com/a', media: '' },
      { timestamp_iso: '2026-07-23T09:47:19', type: 'text', author: 'b', text: 'two https://example.com/a and https://example.com/b', media: '' },
    ];
    // point both URLs at the mock server
    const urlA = srv.url + 'a';
    const urlB = srv.url + 'b';
    msgs[0].text = `one ${urlA}`;
    msgs[1].text = `two ${urlA} and ${urlB}`;
    await enrichTitles(msgs, { timeoutMs: 2000 });
    assert.equal(msgs[0].urlTitles?.[urlA], 'Shared Title');
    assert.equal(msgs[1].urlTitles?.[urlA], 'Shared Title');
    assert.equal(msgs[1].urlTitles?.[urlB], 'Shared Title');
  } finally {
    srv.close();
  }
});

test('enrichTitles: disabled leaves urlTitles empty', async () => {
  const msgs: Message[] = [
    { timestamp_iso: '2026-07-23T09:47:18', type: 'text', author: 'a', text: 'one https://example.com/a', media: '' },
  ];
  await enrichTitles(msgs, { enabled: false });
  assert.deepEqual(msgs[0].urlTitles, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/title.test.ts`
Expected: FAIL (`../src/title` module not found).

- [ ] **Step 3: Write minimal implementation** (create `src/title.ts`)

```ts
import type { Message } from './parse/types';
import { URL_RE, deriveTitle } from './render/js/linkify.js';

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** Pull and sanitize the <title> from an HTML string. */
export function extractTitle(html: string): string | null {
  const m = html.match(TITLE_RE);
  if (!m) return null;
  return m[1]
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Fetch the page title for a single URL. On any failure (network error,
 * non-OK status, non-HTML content-type, missing/empty title) returns the
 * offline-derived title so callers always get a usable label.
 */
export async function fetchTitle(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return deriveTitle(url);
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !/html/i.test(ct)) return deriveTitle(url);
    const html = await res.text();
    return extractTitle(html) ?? deriveTitle(url);
  } catch {
    return deriveTitle(url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enrich messages with a URL→title map. Unique http(s) URLs are fetched once
 * (bounded concurrency), then mapped back onto each message. When `enabled`
 * is false, every message gets `urlTitles = {}` and no network is touched.
 */
export async function enrichTitles(
  messages: Message[],
  opts: { enabled?: boolean; concurrency?: number; timeoutMs?: number } = {},
): Promise<Message[]> {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    for (const m of messages) m.urlTitles = {};
    return messages;
  }
  const urls = [...new Set(
    messages.flatMap((m) => (m.text ?? '').match(URL_RE) ?? []),
  )];
  const map: Record<string, string> = {};
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      map[url] = await fetchTitle(url, { timeoutMs: opts.timeoutMs });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length || 1) }, worker),
  );
  for (const m of messages) {
    if (!m.text) {
      m.urlTitles = {};
      continue;
    }
    const titles: Record<string, string> = {};
    for (const u of m.text.match(URL_RE) ?? []) {
      titles[u] = map[u] ?? deriveTitle(u);
    }
    m.urlTitles = titles;
  }
  return messages;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/title.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src/title.ts test/title.test.ts
git commit -m "feat(title): extract/fetch webpage titles; enrichTitles with bounded pool + fallback"
```

---

### Task 5: Renderers consume the stored title

**Files:**
- Modify: `src/render/html.ts` (text branch(es) of `renderBubble`)
- Modify: `src/render/md.ts` (text branch(es))
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes `m.urlTitles` (from `Message`) via a `resolver = (u) => m.urlTitles?.[u] ?? deriveTitle(u)` passed to `linkifyHtml` / `linkifyMarkdown`.

- [ ] **Step 1: Write the failing test** (append to `test/render.test.ts`)

```ts
test('render: link label uses stored urlTitles when present', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-linkurl-'));
  await runFixture(WK, out);
  const dir = path.join(out, slugifyChatName(WK));
  // Hand-write a CSV row with a URL + url_titles, then render md/html.
  const csv = path.join(dir, 'messages.csv');
  const rows = fs.readFileSync(csv, 'utf8').trimEnd().split('\n');
  rows.push(
    '2026-08-01T10:00:00,text,Guionardo,visit https://example.com/foo,,"{' +
      '"https://example.com/foo":"Example Foo"}"',
  );
  fs.writeFileSync(csv, rows.join('\n') + '\n');
  await renderMarkdown(csv, dir, 'WK', {});
  await renderHtml(csv, dir, 'WK', {});
  const md = fs.readFileSync(path.join(dir, 'messages.md'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
  assert.ok(md.includes('[Example Foo](https://example.com/foo)'), 'md uses stored title');
  assert.ok(html.includes('>Example Foo</a>'), 'html uses stored title');
});
```
(Import `renderMarkdown` from `../src/render/md` and `renderHtml` from `../src/render/html` at the top of the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/render.test.ts`
Expected: FAIL (label shows derived `example.com/foo`, not `Example Foo`).

- [ ] **Step 3: Write minimal implementation**

In `src/render/html.ts`:
- Add `deriveTitle` to the linkify import: `import { linkifyHtml, deriveTitle } from './js/linkify.js';`
- In `renderBubble`, where the text body is built (the branch that currently calls `linkifyHtml(m.text)`), change it to:
  ```ts
  const resolver = (u: string) => m.urlTitles?.[u] ?? deriveTitle(u);
  body = linkifyHtml(m.text, resolver);
  ```
  Apply the same `resolver` change to any other `linkifyHtml(m.text)` call in the file (e.g., system/deleted branches if present).

In `src/render/md.ts`:
- Add `deriveTitle` to the linkify import: `import { linkifyMarkdown, deriveTitle } from './js/linkify.js';`
- In the text branch where `linkifyMarkdown(m.text)` is called, change to:
  ```ts
  const resolver = (u: string) => m.urlTitles?.[u] ?? deriveTitle(u);
  const body = m.media ? await mediaMarkdown(m, media, inline, outDir) : linkifyMarkdown(m.text, resolver);
  ```
  (If a caption branch also linkifies, apply the same `resolver`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/html.ts src/render/md.ts test/render.test.ts
git commit -m "feat(render): use stored urlTitles as link label in HTML/Markdown"
```

---

### Task 6: Wire enrichment into `runParser` + CLI flag

**Files:**
- Modify: `src/model.ts` (`RunOptions`, `runParser` enrichment step)
- Modify: `src/index.ts` (`--no-fetch-titles`)
- Test: `test/integration.test.ts` (new integration test with mock server)

**Interfaces:**
- `RunOptions.noFetchTitles?: boolean` — when true, `enrichTitles` is skipped.
- `runParser` persists enriched `urlTitles` into the CSV before `renderOutputs`.

- [ ] **Step 1: Write the failing integration test** (append to `test/integration.test.ts`)

```ts
test('integration: url_titles fetched + persisted to CSV/JSON/HTML', async () => {
  const { createServer } = await import('node:http');
  const srv = await new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Mock Title</title>');
    });
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/p`, close: () => s.close() });
    });
  });
  try {
    const chat = 'WhatsApp Chat - UrlTitle IT';
    const txt = `23/07/2026 09:47 - Owner: see ${srv.url}\n`;
    const zipped = zipSync({ [`${chat}/_chat.txt`]: Buffer.from(txt, 'utf8') });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ut-'));
    const zipPath = path.join(tmp, 'e.zip');
    fs.writeFileSync(zipPath, Buffer.from(zipped));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ut-out-'));
    await runParser(zipPath, { out });
    const dir = path.join(out, slugifyChatName(chat));
    const csv = fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8');
    assert.ok(csv.includes('url_titles'), 'CSV has url_titles column');
    assert.ok(csv.includes('Mock Title'), 'CSV stores fetched title');
    const env = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
    assert.equal(env.messages[0].urlTitles[srv.url], 'Mock Title');
    const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
    assert.ok(html.includes('>Mock Title</a>'), 'HTML link uses fetched title');
  } finally {
    srv.close();
  }
});

test('integration: --no-fetch-titles leaves urlTitles empty (offline)', async () => {
  const chat = 'WhatsApp Chat - UrlTitle Off';
  const txt = `23/07/2026 09:47 - Owner: see https://example.com/x\n`;
  const zipped = zipSync({ [`${chat}/_chat.txt`]: Buffer.from(txt, 'utf8') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ut2-'));
  const zipPath = path.join(tmp, 'e.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ut2-out-'));
  await runParser(zipPath, { out, noFetchTitles: true });
  const dir = path.join(out, slugifyChatName(chat));
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
  assert.deepEqual(env.messages[0].urlTitles, {});
});
```
(Ensure `runParser`, `slugifyChatName`, `zipSync`, `fs` are imported in `test/integration.test.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/integration.test.ts`
Expected: FAIL (column absent / title not stored / `noFetchTitles` unknown).

- [ ] **Step 3: Write minimal implementation**

In `src/model.ts`:
- Add `noFetchTitles?: boolean;` to `RunOptions`.
- Ensure `import { mergeCsv, readCsv, writeCsv } from './csv';` (add `readCsv, writeCsv` if not already imported).
- After the `mergeCsv(...)` call (line ~107) and before `reconcileMedia`, insert:
  ```ts
  // TITLE-ENRICH (always on; opt-out via --no-fetch-titles): fetch webpage
  // titles and persist the URL→title map back into the CSV source-of-truth.
  const { enrichTitles } = await import('./title.js');
  const merged = readCsv(path.join(dir, 'messages.csv'));
  await enrichTitles(merged, { enabled: !opts.noFetchTitles, concurrency: 8, timeoutMs: 5000 });
  await writeCsv(path.join(dir, 'messages.csv'), merged);
  ```

In `src/index.ts`:
- Add the option: `.option('--no-fetch-titles', 'skip fetching webpage titles (offline)')`
- When invoking `runParser`, pass `noFetchTitles: program.opts().fetchTitles === false` (commander maps `--no-fetch-titles` to `opts.fetchTitles` defaulting `true`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/integration.test.ts`
Expected: PASS (both new tests).

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/index.ts test/integration.test.ts
git commit -m "feat(pipeline): enrich + persist url titles at CSV gen; --no-fetch-titles opt-out"
```

---

### Task 7: Full-suite regression

**Files:** none (verification only).

- [ ] **Step 1: Run the entire suite**

Run: `node --import tsx --test "test/*.test.ts"`
Expected: all pass, 0 failures.

- [ ] **Step 2: Manual smoke (optional)**

Run: `node --import tsx src/index.ts "data/WhatsApp Chat - Notas pessoais.zip"` and open `output/notas-pessoais/messages.md` / `messages.html` to confirm URLs now show page titles (or derived titles offline).

- [ ] **Step 3: Commit the plan doc if not already committed**

```bash
git add docs/superpowers/plans/2026-08-22-url-title-enrichment.md
git commit -m "docs: implementation plan for URL title enrichment"
```

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1, 2), enrichment module (Task 4), pipeline wiring + flag (Task 6), rendering (Task 5), safety/perf (Task 4: dedupe, pool=8, timeout=5s, sanitize, only http(s) via `URL_RE`), testing (Task 4 local mock server; Task 6 integration with mock server). All spec sections mapped.
- **No placeholders:** every step has concrete code or test code.
- **Type consistency:** `urlTitles?: Record<string,string>` is used identically in `Message` (Task 1), `RenderedMessage` (Task 2), `enrichTitles` (Task 4), and the resolver in Task 5. `URL_RE`/`deriveTitle` exported in Task 3 and imported in Task 4/5. `resolver(url): string` signature matches `linkifyHtml`/`linkifyMarkdown` (Task 3).
- **Legacy headers:** only the three equality-assertion sites are updated; the `media.test.ts` fixtures remain 5-column and are explicitly tolerated by `readCsv`.
