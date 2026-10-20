# Codebase Concerns

**Analysis Date:** 2026-08-23

## Tech Debt

**[Broken distributed build — runtime-loaded browser JS not shipped]**
- Issue: `src/render/html.ts:264` computes `jsPath` from `import.meta.url` and reads `js/transcript.js` at runtime via `fs.readFile`. `transcript.js` is loaded with `fs.readFile`, NOT imported as a module, so `tsup` (`tsup.config.ts`) never bundles or copies it into `dist/`. `package.json` publishes only `dist/`. Result: the published package throws `ENOENT: dist/render/js/transcript.js` whenever HTML rendering runs.
- Files: `src/render/html.ts:264-265`, `tsup.config.ts:3-12`, `package.json:10-12,7`
- Impact: `--inline` and any HTML output fails for all `npx wa-backup` / globally-installed users. Dev (`tsx`) and CI (`npm test` via tsx) never exercise the built artifact, so the bug is invisible in CI.
- Fix approach: Either (a) `import transcriptSource from './js/transcript.js?raw'` style inline, (b) read the file content and embed it as a string constant in `html.ts`, or (c) add a tsup `onSuccess`/`publicDir` step (or a `cp` in `build`) that copies `src/render/js/*.js` to `dist/render/js/`. Option (b) is most robust and removes the runtime path coupling.

**[Confusing `--no-fetch-titles` flag wiring]**
- Issue: `src/index.ts:52` computes `noFetchTitles: Boolean((opts as Record<string, unknown>).noFetchTitles ?? (opts as Record<string, unknown>).fetchTitles === false)`. Commander's `.option('--no-fetch-titles')` already exposes `opts.fetchTitles` (default `true`, set `false` by the flag). The dual `??`/`=== false` expression is fragile and unreadable, and the `noFetchTitles` key never actually exists on `opts`.
- Files: `src/index.ts:52`
- Impact: Correct only by accident; any future refactor of the Commander option name silently disables title fetching or breaks the negation.
- Fix approach: Use `noFetchTitles: opts.fetchTitles === false` (single source of truth) and drop the `noFetchTitles` key from `opts`.

**[Two divergent ZIP readers with different assumptions]**
- Issue: `_chat.txt` is extracted via fflate streaming (`src/extract.ts:16-62`), while media is extracted via a hand-rolled central-directory parser (`src/media.ts:76-151`). The two code paths assume different ZIP layouts and are maintained separately.
- Files: `src/extract.ts:16-62`, `src/media.ts:76-151`
- Impact: A bug fixed in one reader is not automatically fixed in the other; the custom parser can rot if fflate behavior changes. Higher maintenance burden and inconsistent failure modes.
- Fix approach: Document the intentional split (fflate mis-handles data-descriptor members on real exports — see `src/media.ts:67-74`) and add a shared fixture/contract test asserting both readers agree on offsets/sizes for the same archive.

**[Duplicated RFC-4180 CSV parser in tests]**
- Issue: `test/integration.test.ts:17-37` re-implements the exact CSV parsing logic from `src/csv.ts:64-97` instead of importing `readCsv`.
- Files: `test/integration.test.ts:17-37`, `src/csv.ts:64-97`
- Impact: If the production parser changes (e.g., quoting edge cases), tests can pass while the real output is wrong, or vice-versa.
- Fix approach: Import and reuse `readCsv` from `../src/csv` in the integration test.

**[Redundant `open()` in per-entry media extraction]**
- Issue: `src/media.ts:123-151` opens the ZIP file separately (`open(zipPath)`) for every entry just to read the 30-byte local header, then opens a second `createReadStream` on the same path. N media entries → 2N file opens.
- Files: `src/media.ts:128-139`
- Impact: Inefficient on exports with hundreds of media files; measurable wall-clock cost, not a correctness bug.
- Fix approach: Reuse a single opened file handle across all entries in `reconcileMedia`, or trust the central-directory offset and skip the local-header re-read.

## Known Bugs

**[HTML render reads `transcript.js` by relative path — fails in published build]**
- See Tech Debt above. This is both debt and a shipping bug; severity HIGH.
- Symptoms: `Error: ENOENT: no such file or directory, open '.../dist/render/js/transcript.js'` from `renderHtml`.
- Trigger: Any run that produces `messages.html` using a built (non-tsx) install, e.g. `npm i -g wa-backup` or `npx`.
- Workaround: Run via `npm run dev` / `tsx src/index.ts` (source present).

**[`isInlineable`/inline path reads whole file into memory]**
- `src/render/html.ts:64-79` `readFileAsDataUri` calls `fs.readFile` on the full file and base64-encodes it. Bounded by `INLINE_MAX_BYTES = 8MB` (`src/media.ts:13`), so a single file ≤ 8MB is fine, but many inlineable files are each fully buffered and concatenated into one HTML string in memory before write.
- Files: `src/render/html.ts:64-79`, `src/media.ts:13,51-53`
- Impact: `--inline` on a chat with many photos can spike memory (N × 8MB) during HTML string assembly; not constant-memory despite the streaming claim.
- Fix approach: Stream each media file as a chunk into the write stream, or cap total inline budget, or document the memory ceiling.

**[No CRC / integrity check on extracted media]**
- `src/media.ts:123-151` inflates/copies bytes but never verifies the stored CRC-32 against the central-directory value.
- Impact: Corrupt archives produce silently corrupted media with no error.
- Fix approach: Validate CRC (fflate exposes it via the central record) and warn on mismatch.

## Security Considerations

**[Unescaped `style` attribute is fed a derived-but-author-derived value]**
- `src/render/html.ts:114,120,138-140` inject `getAccentColor(first.author)` into `style="color:${accent}"` / `style="background:${accent}"`. `accent` is `escapeHtml(getAccentColor(...))` and `getAccentColor` returns a fixed `hsl(...)` string (`src/render/colors.ts:16-18`), so currently safe. However, the escaping is applied to the *color*, not the *author*, and the author is separately escaped — the pattern is easy to break in a future edit (e.g., injecting author directly into a style attribute).
- Files: `src/render/html.ts:114,120,140`, `src/render/colors.ts:16-18`
- Current mitigation: color value is a constant-format HSL string, no user input reaches the style attribute unescaped.
- Recommendations: Centralize a `styleAttr` helper that only accepts known-safe CSS values; never interpolate message-derived strings into `style=`.

**[XSS escaping is generally sound but relies on consistent `escapeHtml` use]**
- `src/render/html.ts:11-18`, `src/render/js/linkify.js:7-14`, and the `</` guard at `src/render/html.ts:262` are correct. The browser-side `transcript.js` renders message text via `linkifyHtml` into `innerHTML` (`src/render/js/transcript.js:85,104`) — `linkifyHtml` escapes the non-URL text and the URL `href`, so this is safe for standard chat content.
- Risk: Any future change that assigns raw `m.text` to `innerHTML` (e.g., a "rich text" feature) reintroduces XSS. The `xss-sanitize.js` module (`src/render/js/xss-sanitize.js`) documents the `textContent`-only rule but is not actually used for body text (linkify is). The safe pattern is enforced by convention, not enforced by code.
- Recommendations: Add a lint rule / test fixture asserting `<script>`/`<img onerror>` in chat text appears escaped in both `messages.html` and the JSON island.

**[SSRF / arbitrary outbound fetch from chat content]**
- `src/title.ts:181-252` `fetchTitle` fetches every `http(s)` URL found in message bodies, including potentially internal/link-local addresses (`http://169.254.169.254/...` cloud metadata, `http://localhost`, RFC1918). There is no URL allowlist or private-IP block.
- Files: `src/title.ts:181-252`, `src/title.ts:282-302` (enrichTitles workers)
- Current mitigation: `timeoutMs` 5s default (`src/title.ts:185`) and bounded concurrency 8 (`src/title.ts:282`); failures fall back to a derived title.
- Recommendations: Block non-public IP ranges before fetching; allow disabling network entirely by default (opt-in `--fetch-titles`); add a `file:`/`internal` URL guard.

**[Cookie/auth leakage via fake User-Agent]**
- `src/title.ts:7-9,124,162` sends a spoofed browser `User-Agent` to arbitrary third-party sites, which may set cookies / track the user.
- Impact: Low for a local personal tool, but it makes requests that look like a real browser and can receive `Set-Cookie`.
- Recommendations: Document the behavior; consider a distinctive `wa-backup/1.0` UA and honoring `robots`/privacy expectations.

## Performance Bottlenecks

**[Non-strict backpressure in line streaming]**
- `src/extract.ts:73-110` `readLines` buffers lines in an in-memory array when the producer (fflate inflate) outpaces the consumer (`parseMessages`). For pathological archives (huge `_chat.txt` with very fast decompression) the buffer can grow unbounded before parsing catches up.
- Files: `src/extract.ts:73-110`, `src/parse/message.ts:164-177`
- Cause: The queue/promise bridge doesn't apply backpressure to the upstream `createReadStream`.
- Improvement path: Pipe through an explicit `Readable`/`AsyncIterator` with bounded high-water mark, or consume lines inside the inflate callback.

**[Whole-file buffering for `--inline`]**
- See Known Bugs: `readFileAsDataUri` (`src/render/html.ts:64-79`). Memory scales with the number of inlineable media files, not constant per the project's memory-safety constraint (PROJECT.md "must stream-parse").

**[Per-entry file open in media reconcile]**
- See Tech Debt: `src/media.ts:128`. Adds latency proportional to media count.

## Fragile Areas

**[Locale / date-format auto-detection is the hardest feature and the least tested]**
- `src/parse/timestamp.ts:92-131` `detectFormat` votes over the first ≤50 sampled lines; `src/parse/message.ts:65,164-184` re-samples the first 200 lines in-stream. The decision is global per-file.
- Why fragile: Only works when the export is internally consistent. Mixed/concatenated exports, Android `dd/mm/yy, hh:mm am` format, English locales, and 12-hour AM/PM detection (the `is12h` branch at `src/parse/timestamp.ts:159-162`) have little to no test coverage (see Test Coverage Gaps). A wrong day/month vote silently misdates every message.
- Safe modification: Any change to `TS_RE` (`src/parse/timestamp.ts:32-33`) or the vote logic MUST be accompanied by the synthetic fixtures in `scripts/generate-fixtures.mjs` being extended with the new format, plus a round-trip assertion.

**[Magic-string day-pill detection in HTML render]**
- `src/render/html.ts:205` identifies a day marker by `item.length === 10 && item[4] === '-'` (ISO date shape), then re-wraps it. Any change to day formatting breaks transcript layout silently.
- Files: `src/render/html.ts:195-211`
- Safe modification: Tag day markers explicitly (e.g., wrap in an object/`{day}` sentinel) instead of a string-length heuristic.

**["Outgoing" side inferred by message plurality]**
- `src/render/html.ts:82-97` `pickSelfAuthor` and `src/render/js/transcript.js:178-193` `mostFrequent` choose the most frequent author as the export owner ("outgoing"). In group chats or unevenly-participated 1:1 chats this mislabels senders (e.g., a business account that mostly receives messages).
- Files: `src/render/html.ts:82-97`, `src/render/js/transcript.js:178-193`
- Impact: Cosmetic (bubble alignment/color) but can be misleading for backups meant as a faithful record.
- Safe modification: Prefer the chat's own phone/owner if exported, or surface the choice; do not assume plurality.

**[`classifyFromFilename` has no `audio` type]**
- `src/parse/message.ts:26-33` maps anything containing AUDIO's filename tokens to `document` because the locked 8-type `MessageType` (`src/parse/types.ts:1-9`) has no `audio`. WhatsApp voice notes (`PTT`) are common and will render as a generic document link.
- Impact: Voice messages lose their semantic type; no playback affordance.
- Fix approach: Extend `MessageType` with `audio` and update `MEDIA_ICON` (`src/render/html.ts:20-26`, `src/render/js/transcript.js:8-14`).

## Scaling Limits

**[No ZIP64 support in custom central-directory reader]**
- `src/media.ts:76-114` reads 32-bit `cdOffset`/`cdSize`/`compressedSize`/`cdCount`. Archives >4 GB, >65,535 entries, or with Zip64 EOCD are unsupported and will throw "ZIP end-of-central-directory record not found" or parse incorrectly.
- Files: `src/media.ts:76-114`
- Current capacity: Standard WhatsApp exports (typically <2 GB) are fine.
- Scaling path: Detect the Zip64 EOCD signature (`0x06064b50`) and read 64-bit fields, or delegate media extraction back to fflate once its data-descriptor bug is resolved.

**[SAMPLE_LINES upper bound on format detection]**
- `src/parse/message.ts:65` buffers up to 200 lines before detection; `detectFormat` samples ≤50. Files shorter than the ambiguity threshold, or with all-ambiguous dates beyond the sample window, fall back to the day-first assumption (`src/parse/timestamp.ts:127`).
- Limit: A very long export whose first 200 lines are system messages (no parseable timestamps) defers detection until line 200; acceptable but worth noting.

## Dependencies at Risk

**[`fflate` 0.8.3 — data-descriptor bug drives the custom media parser]**
- The custom central-directory parser in `src/media.ts` exists *because* fflate's streaming inflate mis-handles members stored with a data descriptor (`src/media.ts:67-74`). This is a known upstream limitation, not a pinned-version risk, but it means the project can never fully delete its second ZIP reader.
- Risk: If fflate is upgraded and the bug is fixed, the custom parser becomes dead weight; if fflate is kept, the custom parser must be maintained forever.
- Migration plan: Add a regression test with a data-descriptor inner-zip; if fflate ever handles it, switch `reconcileMedia` to fflate and delete `readCentralDirectory`.

**[`date-fns` 4.4.0 — only used for `format`]**
- `src/parse/timestamp.ts:1` imports `format` from `date-fns` solely to render ISO strings (`src/parse/timestamp.ts:178`). A hand-rolled `format` would drop a runtime dependency.
- Impact: Minor; low risk. Noted for footprint reduction.

## Missing Critical Features

**[No CLI-supplied chat owner / "self" identity]**
- The tool cannot be told who the export belongs to; "outgoing" is guessed (`src/render/html.ts:82-97`). A backup intended as a personal record should let the user assert ownership.
- Blocks: Correct outgoing/incoming styling in groups; future multi-chat merge.

**[No re-render without network]**
- `renderOutputs` (`src/model.ts:69-81`) re-reads CSV and is offline-safe, but title enrichment (`src/model.ts:113-121`) rewrites the CSV on every run and will re-fetch if titles are empty. There is no `--offline` render path that preserves already-fetched titles without touching network.
- Blocks: Reproducible/offline archival.

**[No ZIP integrity / media CRC validation]**
- See Known Bugs. Missing for a "faithful backup" tool.

## Test Coverage Gaps

**[Synthetic fixtures cover only iOS pt-BR, dd/mm/yyyy]**
- `scripts/generate-fixtures.mjs` and all `test/*.test.ts` exercise a single locale/format (iOS-bracketed, day-first, 4-digit year, pt-BR). The hardest subsystem — locale/format auto-detection — is effectively untested against:
  - Android format (`dd/mm/yy, hh:mm` without brackets, possible `am`/`pm`)
  - English / other locales
  - 12-hour AM/PM detection path (`src/parse/timestamp.ts:159-162`)
  - Mixed or concatenated exports
  - 2-digit year sliding-window edge (`src/parse/timestamp.ts:70-74`, year `00`/`99`)
- Files: `scripts/generate-fixtures.mjs`, `test/timestamp.test.ts`, `test/integration.test.ts`
- Risk: A regression in `detectFormat`/`tryParseTimestamp` would not be caught; mis-dated messages ship silently.
- Priority: HIGH.

**[CI runs tests against source (`tsx`), never the built `dist/`]**
- `package.json:39` `test` uses `tsx`; the `verify` job runs lint/test/build but never executes the built `dist/index.js` end-to-end. This is exactly why the `transcript.js` shipping bug (above) is latent.
- Risk: Build/runtime-path regressions (asset copying, `import.meta.url`, shebang) are not caught before publish.
- Priority: HIGH.
- Fix approach: Add a CI step that runs `node dist/index.js` against a fixture and checks `messages.html` (and presence of the embedded JS) is produced.

**[No HTML XSS regression fixture]**
- There is no test asserting that `<script>`/`<img onerror>` in chat text is escaped in `messages.html` or the JSON island. See Security.
- Priority: MEDIUM.

**[No ZIP64 / large-archive test]**
- `media.test.ts` uses tiny placeholder bytes (`scripts/generate-fixtures.mjs: PLACEHOLDER` = 8 bytes). No test exercises a real DEFLATE member, a data-descriptor member, or a >4GB/Zip64 archive.
- Priority: MEDIUM.

**[No negative/error-path tests for malformed ZIP]**
- `src/media.ts:90` throws on missing EOCD; `src/extract.ts:57` rejects on missing `_chat.txt`. Neither failure path is covered by tests.

---

*Concerns audit: 2026-08-23*
