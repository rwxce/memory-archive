# URL Title Enrichment — Design

**Date:** 2026-08-22
**Status:** Approved (design)
**Scope:** Fetch webpage `<title>` for URLs found in chat messages, store the
mapping in the CSV + JSON, and render human-readable link labels in HTML/Markdown.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| **Where fetching happens** | During **CSV generation** (enrichment step in `runParser`), not at render time. HTML/MD/JSON consume the stored title statically. |
| **Activation** | **Always on** at CSV generation. A `--no-fetch-titles` flag disables it for offline runs. |
| **Field shape** | JSON object mapping each URL to its title: CSV column `url_titles` = `{"<url>":"<title>"}`; JSON field `urlTitles` = same object. Correctly handles multiple links per message. |
| **Fallback** | When a fetch fails (offline, timeout, non-HTML, no `<title>`, rate-limit), store the **offline-derived title** (`deriveTitle(url)` = host + non-root path). The map is always populated per URL, so rendering never breaks. |
| **Implementation** | Node built-in `fetch` + regex extraction. **No new dependency.** |

## Schema changes

### `Message` (`src/parse/types.ts`)
Add an optional enrichment field:
```ts
/** Per-URL fetched page titles (enrichment); `{}` when absent/disabled. */
urlTitles?: Record<string, string>;
```

### CSV (`src/csv.ts`)
- Header becomes: `timestamp_iso,type,author,text,media,url_titles`
- `csvRow` appends `csvField(JSON.stringify(m.urlTitles ?? {}))` as the 6th field.
- `readCsv`: if a row has 6 fields, parse `rec[5]` via `JSON.parse(unescapeField(rec[5]))`
  (falls back to `{}` on parse error); if only 5 fields (legacy), `urlTitles = {}`.
- `csvHeader()` updated to the new 6-column header.
- `dedupeKey` is **unchanged** (titles are not part of message identity, so re-runs
  still dedupe correctly and don't re-add rows just because titles changed).

### JSON (`src/render/json.ts`)
- `RenderedMessage` gains `urlTitles: Record<string, string>`.
- `toRendered` copies `m.urlTitles ?? {}`.

## Enrichment module — `src/title.ts` (new)

```ts
extractTitle(html: string): string | null
  // regex /<title[^>]*>([\s\S]*?)<\/title>/i, then sanitize:
  // trim, collapse whitespace, strip control chars, cap ~300 chars.

fetchTitle(url: string, { timeoutMs = 5000 }): Promise<string>
  // global fetch with AbortController(timeoutMs); only http(s).
  // on !ok / non-html content-type / throw / missing title -> deriveTitle(url).

enrichTitles(messages: Message[], opts?):
  // opts: { enabled = true, concurrency = 8, timeoutMs = 5000 }
  // 1. scan each message.text for http(s) URLs (reuse linkify URL regex)
  // 2. dedupe URLs; fetch each once with a bounded pool (size = concurrency)
  // 3. assign the URL->title map back onto each message.urlTitles
  // 4. return the same messages (mutated in place is fine)
  // when enabled === false: leave urlTitles = {} (no network).
```

`deriveTitle` is imported from `src/render/js/linkify.js` (already exists).

## Pipeline integration (`src/model.ts` `runParser`)

Current order: parse → `mergeCsv` → `reconcileMedia` → `renderOutputs`.

New order:
1. parse → `mergeCsv` (writes CSV; 5- or 6-column, `urlTitles` empty).
2. **`enrichTitles(mergedMessages, { enabled: !opts.noFetchTitles })`** on the
   combined messages, then **`writeCsv` again** so the `url_titles` column persists
   as the source-of-truth (re-runs read it back; titles are stable).
3. `reconcileMedia` (unchanged).
4. `renderOutputs` reads the enriched CSV.

`mergeCsv` itself stays network-free; only the dedicated enrichment step touches
the network. `dedupeKey` excludes titles so re-runs don't create duplicates.

## Rendering (static titles)

`src/render/js/linkify.js`:
- `linkifyHtml(text, resolver?)` and `linkifyMarkdown(text, resolver?)` where
  `resolver(url) => string` returns the display label. Default resolver =
  `deriveTitle`. The `<a>`/`[]()` **text** uses `resolver(url)`; **href** stays the URL.

`src/render/html.ts` and `src/render/md.ts`:
- Build a per-message resolver:
  ```ts
  const resolver = (u: string) => m.urlTitles?.[u] ?? deriveTitle(u);
  ```
  and pass it into `linkifyHtml` / `linkifyMarkdown`. Titles are escaped on output
  (OUT-05 — XSS-safe, same as today).

`src/render/js/transcript.js` (client re-render under `http://`):
- Calls `linkifyHtml` **without** a resolver → derived-title fallback. Acceptable;
  the primary `file://` deliverable already has static titles baked in. (Optional
  future: thread `urlTitles` through the data island so client re-linkify matches.)

## Safety & performance

- Only `http(s)` URLs (linkify already restricts; `fetchTitle` also guards scheme).
- Per-URL timeout **5s** via `AbortController`.
- Bounded concurrency pool (**8**) so large chats don't open unbounded sockets.
- URLs de-duplicated: each unique URL fetched once, shared across all messages.
- Title sanitized: trimmed, whitespace-collapsed, control chars stripped, **capped
  at ~300 chars**. Rendered output is still HTML/MD-escaped.

## CLI (`src/index.ts`)

- `--no-fetch-titles` (boolean): skips enrichment (offline-safe). Default: fetch on.

## Testing

- **`test/title.test.ts`** (new): `extractTitle` from sample HTML; `fetchTitle`
  success against a **local `node:http` mock server** returning a known `<title>`;
  timeout → returns `deriveTitle`; 404/non-HTML → `deriveTitle`; sanitize (collapse
  whitespace, strip control chars, length cap). No external network.
- **`test/csv.test.ts`**: 6-column round-trip preserves the `urlTitles` map; legacy
  5-column row parses to `{}`.
- **`test/render.test.ts`** (or `json` test): a message containing a URL → JSON
  `urlTitles` populated; HTML `<a>` text and Markdown `[label](url)` use the fetched
  title (mock server) or derived fallback.
- **integration**: chat with a URL → after `runParser`, CSV has `url_titles` column
  with the map; JSON has `urlTitles`; HTML anchor text equals the title.

## Files changed

| File | Change |
|------|--------|
| `src/parse/types.ts` | `Message.urlTitles?` |
| `src/csv.ts` | 6-col header/row/read |
| `src/render/json.ts` | `RenderedMessage.urlTitles`, `toRendered` |
| `src/title.ts` | **new** — `extractTitle`, `fetchTitle`, `enrichTitles` |
| `src/render/js/linkify.js` | `resolver` param on `linkifyHtml`/`linkifyMarkdown` |
| `src/render/html.ts` | pass per-message resolver |
| `src/render/md.ts` | pass per-message resolver |
| `src/model.ts` | enrichment step in `runParser`; `noFetchTitles` opt |
| `src/index.ts` | `--no-fetch-titles` flag |
| `test/title.test.ts` | new unit tests |
| `test/csv.test.ts`, render/json tests | round-trip + label assertions |
| `docs/superpowers/specs/2026-08-22-url-title-enrichment-design.md` | this doc |

## Out of scope

- Full DOM/HTML parsing of pages (only `<title>` is needed).
- Caching titles across separate CLI invocations (titles persist in CSV within a
  run; cross-run reuse happens naturally because the CSV is re-read, but no
  explicit cache layer).
- Fetching titles for media/captions beyond text URLs.
