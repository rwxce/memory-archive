---
phase: 01-parsing-model-core
plan: 01
subsystem: parser-core
tags: [parser, streaming, csv, cli, tracer]
requires:
  - WhatsApp export ZIP (`data/` real samples)
provides:
  - extractChatTxt(zipPath) → AsyncIterable<string> (streaming, media never inflated)
  - chatNameFromZip(zipPath) → sanitized chat folder name
  - parseTimestamp / stripInvisible / TS_RE (locale-tolerant detection)
  - parseMessages(lines, opts) → AsyncGenerator<Message>
  - writeCsv / csvField / csvRow (RFC-4180, UTF-8 no BOM)
  - runParser(zipPath, opts) orchestrator + commander CLI
affects:
  - 01-02 (expands timestamp detection + message types on these modules)
  - 01-03 (extends csv.ts with merge/dedupe; consumes Message model)
tech-stack:
  added: [fflate 0.8.3, date-fns 4.4.0, commander 15.0.0, picocolors 1.1.1, tsx 4.23.12, tsup 8.5.1, typescript ^5]
  patterns: [streaming-unzip-to-readline, async-generator-state-machine, event-driven-line-queue]
key-files:
  created:
    - package.json
    - tsconfig.json
    - tsup.config.ts
    - src/parse/types.ts
    - src/extract.ts
    - src/parse/timestamp.ts
    - src/parse/message.ts
    - src/csv.ts
    - src/model.ts
    - src/index.ts
    - test/tracer.test.ts
    - .gitignore
decisions:
  - "extractChatTxt returns AsyncIterable<string> instead of readline.Interface — Node 26 `for await` over a readline fed by an async PassThrough hangs; event-driven queue is the robust streaming contract"
  - "SENDER_RE separator is `:` + whitespace OR `:` at end-of-line — accepts empty-body `[ts] Name:` lines without misreading URLs as senders"
  - "Message bodies are invisible-stripped AND whitespace-trimmed; authors preserved raw (bidi wrappers intact)"
metrics:
  duration: ~45 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 68000
  tasks: 2
  commits: 2
---

# Phase 1 Plan 1: Streaming Tracer Parser Summary

Streaming fflate→readline→state-machine parser that turns a WhatsApp export ZIP into a normalized RFC-4180 CSV source-of-truth — verified end-to-end against both real pt-BR exports.

## What Was Built

- **Bootstrap:** ESM package (`type: module`), tsconfig strict NodeNext, tsup bin build (shebang emitted), scripts dev/build/test/typecheck.
- **src/extract.ts** — `extractChatTxt`: fflate `Unzip` streams the archive; ONLY the `_chat.txt` entry is `start()`-ed (AppleDouble `._*` / `__MACOSX` skipped, videos never inflated). Returns an event-driven async line iterable. `chatNameFromZip` reads entry names only (never inflates) and sanitizes the folder name.
- **src/parse/timestamp.ts** — leading invisible-run strip (U+FEFF/200E/200F/200B-D/2066-9); anchored `TS_RE` for iOS `[..]`/Android styles, `/ . -` separators, optional seconds + AM/PM; 2-digit-year sliding window; day-first default for ambiguous dates; LOCAL Date + date-fns format → ISO without timezone.
- **src/parse/message.ts** — async-generator state machine: continuations joined with `\n`, empty-body→same-author-attachment merged (no phantom rows), same-second bursts preserved as distinct rows, `<attached:` classified (sticker/photo/video/document), omitted/deleted/system markers.
- **src/csv.ts** — RFC-4180 quoting; header `timestamp_iso,type,author,text,media`; UTF-8 no BOM.
- **src/model.ts + src/index.ts** — `runParser` orchestrator writing `${out}/<chat>/messages.csv`; commander CLI with `<zip>` positional and `--out/--day-first/--month-first/--verbose`.
- **test/tracer.test.ts** — builds in-memory ZIPs from BOTH real samples via `zipSync`, runs the full streaming path, asserts header/no-BOM/ISO shape, sticker row, continuation join (`Senha: TIMEWK2026`), 36→37 photo merge, 5-row same-second burst with distinct media, raw bidi author, caption+attachment row, and a cross-sample phantom-row guard.

## Verification Results

- `npm test` → **4/4 pass** (both real samples).
- `tsc --noEmit` → clean under `strict`.
- `npm run build` → `dist/index.js` with shebang.
- CLI smoke: `npx tsx src/index.ts <zip> --out …` wrote 134-message CSV with correct header and first row.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TS_RE matched nothing**
- **Found during:** Task 1 verification (0 messages parsed)
- **Issue:** regex was written `^\\[?` (literal backslash before the optional bracket) instead of `^\[?`
- **Fix:** corrected to `^\[?`
- **Files modified:** src/parse/timestamp.ts
- **Commit:** f8e86ac

**2. [Rule 3 - Blocking] `for await (const line of rl)` hangs on Node 26**
- **Found during:** Task 1 verification (unsettled top-level await in runParser)
- **Issue:** readline.Interface async iteration never yields when its input is a PassThrough fed asynchronously by fflate's inflate callback; `.on('line')` works. Additionally, attaching listeners after resolution drops already-emitted `line` events.
- **Fix:** `extractChatTxt` now resolves to an event-driven `AsyncIterable<string>` (`readLines` queue attached synchronously at interface creation). Plan contract deviation documented above.
- **Files modified:** src/extract.ts, src/parse/message.ts, src/model.ts
- **Commit:** f8e86ac

**3. [Rule 1 - Bug] Empty-body timestamped lines misclassified as system**
- **Found during:** Task 2 tests (phantom `system` row `Camilla Araujo WK:` at 23:31:29)
- **Issue:** SENDER_RE required `:\s`; `[ts] Name:` (colon at EOL) failed → became a phantom system row instead of merging with the attachment
- **Fix:** separator is now `(?:\s|$)` — still rejects `https://…` URL false positives
- **Files modified:** src/parse/message.ts
- **Commit:** f8e86ac

**4. [Rule 2] Body hygiene — leading space after `Name: ` and attachment-marker residue leaked into CSV text fields**
- **Found during:** Task 1 acceptance check (row text had a stray space)
- **Fix:** trim whitespace after invisible-strip, and again after `<attached:>` removal
- **Files modified:** src/parse/message.ts
- **Commit:** f8e86ac

**5. [Rule 3] `node --test test/` directory import unsupported under ESM on Node 26**
- **Fix:** test script globs `test/*.test.ts`
- **Files modified:** package.json

## Known Stubs

None. Verbose reporting is intentionally minimal per plan scope (full locale report lands in plan 02).

## Notes

- `data/` (real personal exports, ~70 MB) is gitignored — ground truth lives on disk only; tests rebuild fixtures in-memory via `zipSync`.
- Dedupe identity `(timestamp_iso, author, text, media)` contract established here (D-16); implementation arrives in plan 03.

## Self-Check: PASSED

- Commits verified: f8e86ac (feat), c27c698 (test) via `git log`.
- SUMMARY.md present in phase directory.
