# URL Linkification in HTML & Markdown — Design Spec

**Date:** 2026-08-22
**Status:** Approved (design)
**Feature:** Clickable links for URLs found in message text, in the HTML and Markdown outputs (and the client-rendered HTML path), showing an offline-derived page title.

## Problem

Today message text is rendered as plain escaped text in every output. URLs inside a chat message are not turned into links, so readers cannot click them. The user wants URLs converted to:

- **HTML:** `<a href="URL">TITLE</a>`
- **Markdown:** `[TITLE](URL)`

where `TITLE` is a human-readable label derived from the URL itself (offline — no network fetch), and `URL` is embedded in the `href`/`()` target.

## Constraints

- **Offline / privacy-safe** — no network access. Titles are derived locally from the URL string; the tool never fetches pages.
- **XSS-safe (OUT-05)** — link `href` values are HTML-escaped; only `http`/`https` schemes become links; `javascript:`, `data:`, and other non-http schemes stay as inert escaped text. Preserves the existing `render.test.ts` assertion that no `javascript:` href is emitted.
- **Memory-safe / streaming** — linkification is per-message string transformation; no buffering of the whole chat.
- **Standalone (`file://`)** — the client-rendered path (`transcript.js`) must keep working under `file://`; link HTML is built, not echoed.
- **No new dependency** — pure string/regex logic.

## Scope

| Output | Behavior |
|--------|----------|
| `messages.html` (server-rendered, `html.ts`) | URLs → `<a href>` with derived title |
| `messages.md` (`md.ts`) | URLs → `[title](url)` |
| Client HTML rebuild (`transcript.js`, http-served) | URLs → `<a href>` (coherence with server HTML) |
| `messages.json` (`json.ts`) | **Unchanged** — raw `text` only (no `links` field) |

System/deleted/omitted message text is also linkified where it contains a URL (e.g. a system "created group with https://…" line), for consistency; deleted/omitted bodies carry no real text so are unaffected.

## Architecture

A single shared module holds all link logic so the three renderers cannot drift:

**New file `src/render/js/linkify.js`** (plain JS, browser-safe, ESM):
- `deriveTitle(url: string): string`
- `linkifyHtml(text: string): string`
- `linkifyMarkdown(text: string): string`

Imported by:
- `src/render/html.ts` (Node build) — `import { linkifyHtml } from './js/linkify.js'`
- `src/render/md.ts` (Node build) — `import { linkifyMarkdown } from './js/linkify.js'`
- `src/render/js/transcript.js` (browser) — `import { linkifyHtml } from './linkify.js'`

This mirrors the existing `js/xss-sanitize.js` pattern (one JS source reused by both Node and browser).

### `deriveTitle(url)`

1. Parse with `new URL(url)`.
2. `host = hostname` with a leading `www.` removed.
3. `path = pathname` with a single trailing `/` removed.
4. Drop `search` (query) and `hash` (fragment).
5. Return `host + path` when `path` is non-empty and not just `/`; otherwise return `host`.

Examples:
- `https://www.github.com/owner/repo?x=1` → `github.com/owner/repo`
- `http://example.com/` → `example.com`
- `https://news.site/article/` → `news.site/article`

### `linkifyHtml(text)`

1. Tokenize `text` by the URL regex `/(https?:\/\/[^\s<>"'`]+)/gi`.
2. For each non-URL segment: HTML-escape (`&` `<` `>` `"` `'`).
3. For each URL segment:
   - Re-validate the scheme is `http`/`https`. If not, treat as ordinary text (escape it).
   - Emit `<a href="<esc url>" target="_blank" rel="noopener noreferrer"><esc deriveTitle(url)></a>`.
4. Return the joined string. Newlines are preserved verbatim (current renderer behavior; bubble CSS handles wrapping).

### `linkifyMarkdown(text)`

1. Same tokenization.
2. For each non-URL segment: escape `&` `<` `>` (existing `escapeMd` behavior).
3. For each URL segment: emit `[<esc deriveTitle(url)>](<esc url>)` where `]` and `\` in the title and `)`, `\` in the URL are escaped.

## Data flow

`renderBubble` (html.ts): text/system branches replace `escapeHtml(m.text)` with `linkifyHtml(m.text)`.
`renderMarkdown` (md.ts): text body replaces `escapeMd(m.text)` with `linkifyMarkdown(m.text)`.
`transcript.js` bubble/text + system branches: replace `setText(el, m.text)` with `el.innerHTML = linkifyHtml(m.text)` (safe because the HTML is constructed, not user-echoed).

Media branches (`photo`/`video`/etc.) are untouched — they already produce their own markup.

## Error handling

- Invalid URL string (fails `new URL`) inside `deriveTitle`: fall back to returning the raw (escaped) URL as the title rather than throwing.
- Non-`http(s)` scheme: never linked; rendered as escaped plain text.
- No network, so no timeouts/fetch failures to handle.

## Testing

**New `test/linkify.test.ts`** (no DOM needed):
- `deriveTitle` variants: www-strip, trailing-slash trim, query/fragment drop, port retained if present.
- `linkifyHtml`: single URL → `<a href="https://…" target="_blank" rel="noopener noreferrer">github.com/owner/repo</a>`; multiple URLs in one message; surrounding text preserved; newline preserved.
- `linkifyHtml` safety: `javascript:alert(1)` stays plain escaped text (no `<a>`); a literal `<script>` in text is HTML-escaped; `href` with `"` is escaped.
- `linkifyMarkdown`: `https://github.com/a/b` → `[github.com/a/b](https://github.com/a/b)`; title/url escaping for `)`/`]`/`\`.
- Render integration: run the Notas/real sample through `renderHtml` + `renderMarkdown`, assert the produced HTML contains `<a href="…" …>` with derived titles and the Markdown contains `[title](url)`; assert `messages.json` `text` is byte-for-byte unchanged from current output.
- Existing `render.test.ts` "no `javascript:` href" assertion must still pass.

## Completion criteria

- [ ] URLs in `messages.html` render as `<a href>` with an offline-derived title; `target="_blank" rel="noopener noreferrer"` present.
- [ ] URLs in `messages.md` render as `[title](url)`.
- [ ] Client `transcript.js` path renders the same links.
- [ ] `javascript:`/non-http and `<script>` stay inert (no XSS); existing XSS test still green.
- [ ] `messages.json` text unchanged.
- [ ] `test/linkify.test.ts` passes; full suite regression clean of new failures.
- [ ] No new dependency.
