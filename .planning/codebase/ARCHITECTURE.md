<!-- refreshed: 2026-08-23 -->
# Architecture

**Analysis Date:** 2026-08-23

## System Overview

```text
┌────────────────────────────────────────────────────────────────────┐
│  CLI entry — `src/index.ts` (commander)                              │
│  buildCli() -> .action() -> runParser(zip, opts)                     │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ zipPath, RunOptions
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│  Orchestrator — `src/model.ts` runParser()                          │
│  (1) chatInfoFromZip  (2) extractChatTxt  (3) parseMessages         │
│  (4) mergeCsv         (5) enrichTitles      (6) reconcileMedia      │
│  (7) renderOutputs                                              `model.ts` │
└───┬───────────┬───────────────┬───────────────┬───────────────────┘
    │           │               │               │
    ▼           ▼               ▼               ▼
┌────────┐ ┌─────────────┐ ┌──────────┐ ┌──────────────┐
│ extract│ │  parse/*    │ │ csv.ts   │ │ media.ts     │
│ `extract.ts`│ │ `message.ts` │ │`csv.ts`  │ │ `media.ts`     │
│         │ │ `timestamp`│ │          │ │               │
│         │ │ `types.ts` │ │          │ │               │
└────────┘ └─────────────┘ └────┬─────┘ └───────┬───────┘
                                │               │
                                ▼               ▼
                ┌───────────────────────────────────────────────┐
                │  SOURCE OF TRUTH:  <out>/<slug>/messages.csv   │
                └───────────────────────┬───────────────────────┘
                                        │ readCsv()
                                        ▼
                ┌───────────────────────────────────────────────┐
                │  Renderers — `src/render/*`                    │
                │   renderJson | renderMarkdown | renderHtml     │
                │   + buildMediaMap (media.ts)                   │
                │   + linkify (render/js/linkify.js)             │
                └───────────────────────────────────────────────┘
                                        │
                                        ▼
              messages.csv  messages.json  messages.md  messages.html
              (+ media/  folder of reconciled files)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI | Parse argv (`[zip]`, `--out`, `--day-first`, `--month-first`, `--verbose`, `--inline`, `--no-fetch-titles`); print final merge count | `src/index.ts` |
| Orchestrator | Drive the full vertical pipeline; call extract→parse→merge→enrich→media→render; emit verbose report | `src/model.ts` |
| Zip extract | Stream `_chat.txt` out of the ZIP without buffering media (fflate `Unzip` + `readline`); derive chat slug/name | `src/extract.ts` |
| Line parser | Streaming state machine: timestamp detection, continuation join, sender/body/media split, type classification, empty-body/attachment merge | `src/parse/message.ts` |
| Timestamp logic | Invisible-char stripping, single `TS_RE`, per-file `Detection`, `tryParseTimestamp`, year resolution, sanity window | `src/parse/timestamp.ts` |
| Message model | `Message` / `MessageType` types (the data contract) | `src/parse/types.ts` |
| CSV layer | Escape/unescape, `dedupeKey`, RFC-4180 read, `writeCsv`, incremental `mergeCsv` (sort+dedupe) | `src/csv.ts` |
| Media reconciliation | Read ZIP central directory, stream per-entry extraction to `<dir>/media/`, build disk media map, inlineability rules | `src/media.ts` |
| Title enrichment | Per-platform URL→title fetch (YouTube oEmbed, Reddit `.json`, Stack Exchange API, Medium/LinkedIn/X derivation), parallel workers, persist into CSV | `src/title.ts` |
| JSON renderer | Build `JsonEnvelope` (metadata + messages) from CSV, write `messages.json` | `src/render/json.ts` |
| Markdown renderer | Day-sectioned `messages.md` with media embeds / links | `src/render/md.ts` |
| HTML renderer | WhatsApp-style bubble HTML string + inline `transcript.js` + `#chat-data` JSON island | `src/render/html.ts` |
| Colors | Deterministic per-author accent hue + initials (mirrored in browser JS) | `src/render/colors.ts` |
| Linkify (shared) | URL regex, `deriveTitle`, `unwrapUrl` (LinkedIn redirect), `linkifyHtml`/`linkifyMarkdown` | `src/render/js/linkify.js` |
| Browser viewer | Client-side DOM build from `#chat-data` island, search/filter/theme | `src/render/js/transcript.js` |
| Fixture generator | Synthetic `_chat.txt` + media + ZIPs into `fixtures/` so tests run without personal data | `scripts/generate-fixtures.mjs` |

## Pattern Overview

**Overall:** Streaming transform pipeline with a **CSV source-of-truth**.

**Key Characteristics:**
- The ZIP is never fully buffered: `extractChatTxt` (`src/extract.ts:16`) inflates only `_chat.txt`; media entries are streamed per-entry from the central-directory index in `reconcileMedia` (`src/media.ts:171`).
- Parsing is a single-pass `AsyncGenerator` in `parseMessages` (`src/parse/message.ts:82`); lines are yielded as `Message` objects with constant memory regardless of chat size.
- `messages.csv` is the canonical, re-renderable artifact. All three renderers `readCsv()` from disk (`src/render/json.ts:85`, `src/render/md.ts:90`, `src/render/html.ts:254`), so old backups regenerate JSON/MD/HTML without the original ZIP.
- Incremental merge produces idempotent re-runs: a second run of the same chat adds **0 rows** (verified by `test/integration.test.ts:123`).
- Renderers and the browser viewer share the same `linkify.js` module so link/title behavior is identical server-side and client-side.

## Layers

**Ingestion layer (`src/extract.ts`):**
- Purpose: Get a streaming `AsyncIterable<string>` over `_chat.txt` from the ZIP.
- Location: `src/extract.ts`
- Contains: `extractChatTxt` (fflate `Unzip`, skips `__MACOSX`/`._*` companions), `readLines` (event-driven async iterator over `readline.Interface`), `chatNameFromZip` / `chatInfoFromZip` (header-only scan for the folder name), `slugifyChatName`.
- Depends on: `fflate`, `node:readline`, `node:fs`.
- Used by: `src/model.ts`.

**Parsing layer (`src/parse/*`):**
- Purpose: Turn raw chat lines into normalized `Message` objects with a resolved timestamp.
- Location: `src/parse/`
- Contains: `message.ts` (state machine + `classifyType`), `timestamp.ts` (`TS_RE`, `detectFormat`, `tryParseTimestamp`), `types.ts` (`Message`, `MessageType`).
- Depends on: `node:fs` (none), `date-fns` (only in `timestamp.ts` for `format`).
- Used by: `src/model.ts`.

**Persistence layer (`src/csv.ts`):**
- Purpose: Serialize/deserialize the message list to the CSV source-of-truth, with merge/dedupe/sort.
- Location: `src/csv.ts`
- Contains: `csvField`, `csvRow`, `csvHeader`, `dedupeKey`, `readCsv`, `writeCsv`, `mergeCsv`.
- Depends on: `node:fs` only.
- Used by: `src/model.ts`, all renderers, `src/title.ts`.

**Enrichment layer (`src/title.ts`, `src/media.ts`):**
- Purpose: Attach external context — fetched web-page titles and reconciled on-disk media.
- Location: `src/title.ts`, `src/media.ts`
- Depends on: `node:fs`, `node:zlib`, `node:crypto`, `fetch` (global), `src/render/js/linkify.js`.
- Used by: `src/model.ts`.

**Rendering layer (`src/render/*`):**
- Purpose: Emit the four synchronized outputs from `messages.csv`.
- Location: `src/render/`
- Contains: `json.ts`, `md.ts`, `html.ts`, `colors.ts`, `js/linkify.js`, `js/transcript.js`, `js/xss-sanitize.js`.
- Depends on: `src/csv.ts`, `src/media.ts`, `src/render/colors.ts`, `src/render/js/linkify.js`.
- Used by: `src/model.ts` (`renderOutputs`).

## Data Flow

### Primary Request Path (full run)

1. CLI parses args → `runParser(zipPath, opts)` (`src/index.ts:46` → `src/model.ts:83`).
2. `chatInfoFromZip(zipPath)` resolves `{ slug, name }` (header-only ZIP scan — `src/extract.ts:177`).
3. `extractChatTxt(zipPath)` returns an `AsyncIterable<string>` over `_chat.txt` (`src/extract.ts:16`).
4. `parseMessages(lines, { dayFirst, monthFirst, warnings, onDetection })` streams `Message` objects (`src/parse/message.ts:82`). Format detection runs once over the first ~200 lines via `detectFormat` (`src/parse/timestamp.ts:92`).
5. `mergeCsv(path, messages)` merges into `messages.csv`, dedupe by `dedupeKey`, stable ascending sort by `timestamp_iso` (`src/csv.ts:144`). Returns new-row count.
6. `readCsv(csvPath)` reloads merged rows; `enrichTitles(merged, { enabled, concurrency:8, timeoutMs:5000 })` fetches URL titles and `writeCsv` persists them (`src/title.ts:260`).
7. `reconcileMedia(zipPath, dir, distinctMedia)` copies matched media to `<dir>/media/` (`src/media.ts:171`).
8. `renderOutputs(dir, name, { inline })` re-reads CSV and writes `messages.json`, `messages.md`, `messages.html` (`src/model.ts:69`).
9. CLI prints `✓ Merged version` and the three rendered paths (`src/index.ts:58`).

### Single-message transformation shape

A `Message` (`src/parse/types.ts:11`):
```typescript
interface Message {
  timestamp_iso: string;          // 2026-07-23T09:47:18 (local, no TZ)
  type: MessageType;              // text|photo|video|sticker|document|system|deleted|omitted
  author: string;                 // raw, incl. bidi wrappers / ~ prefix (D-09)
  text: string;                   // body with markers stripped; may be ''
  media: string;                  // media filename or ''
  urlTitles?: Record<string,string>; // URL -> fetched title (enrichment)
}
```
`MessageType` is locked to 8 values (`src/parse/types.ts:1`); there is no `audio` type — audio files fall back to `document` (`src/parse/message.ts:31`).

### Incremental merge / dedupe (the core idempotency mechanism)

- `dedupeKey` (`src/csv.ts:59`) joins `(timestamp_iso, author, text, media)` with the ASCII Unit Separator `\u001f` (cannot appear in chat content, so no false collisions, D-16).
- `mergeCsv` (`src/csv.ts:144`):
  1. load existing rows (or `[]`);
  2. index existing keys in a `Set`;
  3. keep only `newMessages` whose key is absent (`fresh`);
  4. concatenate `existing.concat(fresh)` and stable-sort by `timestamp_iso` ascending, with the original array index as tiebreaker so same-second bursts keep insertion order (D-17);
  5. rewrite header + rows.
- Returned value is `fresh.length` — the count surfaced as "Merged N new message(s)".
- Re-running the same chat yields `fresh.length === 0` (verified `test/integration.test.ts:123`), making the tool safe to run repeatedly against the same output folder.

### Empty-body + attachment merge (no phantom rows)

`parseMessages` (`src/parse/message.ts:151`) holds an empty `Message` (`heldEmpty`) when a timestamped line has `text === '' && !media`. If the next line is a same-author attachment, the held-empty is discarded and only the media row is emitted (`src/parse/message.ts:139`). This avoids the phantom empty row before every media row (D-04/§3.4).

### Render-from-CSV (re-render without ZIP)

Renderers never depend on `parseMessages` output — they call `readCsv(csvPath)` (`src/render/json.ts:85`) and `buildMediaMap(dir, messages)` (`src/media.ts:236`). This is why `messages.html` can be regenerated later purely from the folder.

**State Management:** No global mutable state. `detection` and `warnings` are local to `parseMessages`; per-run config flows through `RunOptions` (`src/model.ts:15`) and `ParseOptions` (`src/parse/message.ts:53`). The only cross-invocation state is the CSV file on disk.

## Key Abstractions

**`Message` (`src/parse/types.ts:11`):** The universal data contract. Everything downstream (CSV, renderers, enrichment) operates on `Message`.

**`Detection` (`src/parse/timestamp.ts:36`):** The per-file format decision `{ dayFirst, is12h, example?, overridden? }`. Computed once via `detectFormat` over a bounded sample (PARSE-03), then applied to every line by `tryParseTimestamp`. CLI `--day-first`/`--month-first` short-circuit the vote and set `overridden: true`.

**`ReconcileResult` (`src/media.ts:153`):** `{ resolved, unresolved }` — drives the verbose media report in `src/model.ts:143`.

**`JsonEnvelope` (`src/render/json.ts:22`):** `{ metadata, messages }` — the structured shape written to `messages.json` and embedded as the `#chat-data` JSON island in `messages.html` for the browser viewer.

**`MediaEntry` (`src/media.ts:219`):** `{ relPath, mime, size, inlineable }` — returned by `buildMediaMap` so renderers know whether a media ref has an on-disk file and whether it may be base64-inlined.

## Entry Points

**CLI binary (`src/index.ts`):**
- Location: `src/index.ts`
- Triggers: `node dist/index.js <zip> [...]` (built), or `npm run dev -- <zip>` (`tsx src/index.ts`).
- Responsibilities: `buildCli()` wires commander; the `.action` callback resolves the ZIP path, calls `runParser`, reads `chatInfoFromZip` again for the final message (`src/index.ts:54`), and prints results. `buildCli().parseAsync(process.argv)` runs at module load (`src/index.ts:78`).
- `package.json` `bin`: `"wa-backup": "dist/index.js"` (`package.json:7`).

**Programmatic API (`src/model.ts`):**
- `runParser(zipPath, opts)` → `Promise<number>` (rows added).
- `renderOutputs(dir, chatName, opts)` → re-render the three artifacts from an existing CSV.
- `verboseReport(detection, warnings, count)` → stderr format report.
- Imported directly by tests (`test/integration.test.ts:8`).

## Architectural Constraints

- **Module system:** ESM only — `"type": "module"` (`package.json:5`); `tsconfig` `module: ESNext`, `moduleResolution: Bundler`. Imports of local `.js` extensions are required for the browser-shared `linkify.js` (`src/title.ts:3` imports `./render/js/linkify.js`).
- **Target runtime:** Node ≥ 22.12 (`package.json:13`); `engines.node` enforced. Built with `tsup` (`tsup.config.ts`) emitting `dist/` with a shebang.
- **Threading:** Single-threaded event loop. No worker threads. Parallelism is achieved via concurrent promises: title fetching uses bounded worker pool (`src/title.ts:287`), media writes use `Promise.all` (`src/media.ts:211`).
- **Global state:** None in source modules. Per-run state is local. The only persistent state is the CSV + `media/` folder on disk.
- **Memory safety:** Both ZIP reading paths avoid full-archive buffering — `extractChatTxt` never `start()`s media entries (`src/extract.ts:27`), and `reconcileMedia` reads the central directory (metadata only) then streams each member via a bounded `ReadStream` (`start`/`end`) (`src/media.ts:135`).
- **Circular imports:** Not present. Dependency direction is strictly `index → model → {extract, parse, csv, media, render, title}`; `title` depends only on `parse/types` + `render/js/linkify.js`; renderers depend on `csv`/`media`/`colors`/`linkify.js`.

## Anti-Patterns

### Buffering the whole ZIP to read `_chat.txt`

**What happens:** A naive `jszip.loadAsync(buffer)` reads the entire archive (including videos) into memory before any entry is available.
**Why it's wrong:** Fatal for large WhatsApp exports — defeats the memory-safety constraint (PARSE-02).
**Do this instead:** Use fflate's streaming `Unzip` and call `file.start()` only on the `_chat.txt` entry (`src/extract.ts:22-39`). For media, stream per-entry from the central-directory index (`src/media.ts:171`).

### `for await (const line of readline)` over an async-fed PassThrough

**What happens:** Node's built-in async iterator over a `readline.Interface` fed by fflate's inflate callback can hang (observed on Node 26) because `line` events fire before a listener is attached.
**Why it's wrong:** The stream silently stalls and the whole parse never completes.
**Do this instead:** Use the event-driven `readLines` queue (`src/extract.ts:73`) that buffers `line`/`close` events and fulfills a pending reader promise — fully streaming, no `line` event is ever missed.

### Treating an invalid date as a new message

**What happens:** A line that matches `TS_RE` shape but fails validation (e.g. `31/02`, or year < 2009) gets emitted as a row.
**Why it's wrong:** Produces phantom/junk messages.
**Do this instead:** `tryParseTimestamp` returns `null` for invalid/out-of-range dates; the parser appends the line as a continuation to the open message (`src/parse/message.ts:112-117`). Optional warnings are collected (`src/parse/timestamp.ts:167`).

### Regenerating renderers from parse output instead of CSV

**What happens:** A renderer imports `parseMessages` and re-parses the ZIP each time it renders.
**Why it's wrong:** Violates the "re-render from folder without ZIP" goal and duplicates work.
**Do this instead:** All renderers `readCsv(csvPath)` from the existing source-of-truth (`src/render/json.ts:85`, `src/render/md.ts:90`, `src/render/html.ts:254`).

## Error Handling

**Strategy:** Fail fast at the CLI boundary; recover gracefully inside the pipeline.

**Patterns:**
- ZIP missing `_chat.txt` → `extractChatTxt` rejects with `No _chat.txt entry found in ZIP` (`src/extract.ts:57`); propagated to CLI which prints a red error and sets `process.exitCode = 1` (`src/index.ts:69-72`) without crashing.
- Media never throws on unresolved: `reconcileMedia` returns `unresolved` refs and the renderers render placeholders (`MEDIA-03`/`MEDIA-04`). Missing media is reported on stderr, not into the artifacts (`src/model.ts:143`).
- Malformed CSV rows (wrong field count) are skipped but their raw text is preserved in `text` to avoid data loss (`src/csv.ts:107`).
- Title fetch failures degrade gracefully: every platform method falls back to `deriveTitle(url)` (offline URL-derived label) (`src/title.ts:246`).

## Cross-Cutting Concerns

**Logging:** `console.error` via `picocolors` for stderr diagnostics (`verboseReport`, media report, title verbose). Artifacts (JSON/MD/HTML/CSV) stay clean. `console.log` only for the final success line.

**Validation:** Timestamp validation in `tryParseTimestamp` (`src/parse/timestamp.ts:142`) — sanity window (`year >= 2009 && year <= currentYear+1`) and `isValidYmd`. Media name matching is tolerant via `normalizeMediaName` (`src/media.ts:24`).

**Authentication:** None. Title fetching uses a browser-like `User-Agent` (`src/title.ts:7`) and per-platform endpoints; no credentials.

**Security / XSS:** All renderer text is escaped before output — `escapeHtml` (`src/render/html.ts:11`), `escapeMd` (`src/render/md.ts:31`), and `linkify.js` escapes every interpolated value. The HTML renderer escapes `</` in the JSON island to defeat `</script>` injection (`src/render/html.ts:262`). The browser viewer builds DOM via `createElement` + `setText`/`textContent` only (`src/render/js/transcript.js:5`, `src/render/js/xss-sanitize.js`).

**Determinism:** Per-author accent colors are SHA-256-derived so server and browser render identically (`src/render/colors.ts:10` mirrors `src/render/js/transcript.js:16`).

---

*Architecture analysis: 2026-08-23*
