---
phase: 01-parsing-model-core
verified_at: 2026-08-21 (re-verified after gap closures)
status: passed
mode: mvp
requirements: [PARSE-01, PARSE-02, PARSE-03, PARSE-04, PARSE-05, PARSE-06, PARSE-07]
---

# Phase 1 Verification: Parsing & Model Core

**Verdict: PASSED** — the phase goal is achieved by the shipped code, proven by an authoritative integration suite over both real exports.

## Goal-Backward Check

**Goal:** "The CLI reads a WhatsApp export ZIP and produces a normalized, accurate message model regardless of locale, encoding, or file-system quirks."

| Success Criterion | Evidence | Verdict |
|---|---|---|
| 1. ZIP arg → parsed model w/ correct senders/timestamps/bodies/media on real pt-BR sample | `test/integration.test.ts` asserts known lines in BOTH samples (senders incl. raw bidi `‪+55 …‬`, ISO timestamps, bodies w/ emoji + U+200E captions, media filenames); compiled CLI smoke ran `dist/index.js` | ✓ |
| 2. Locale-tolerant detection (D/M order, 12/24h) without config; overrides available | `detectFormat` majority vote tested (`test/timestamp.test.ts`); CLI smoke printed `DAY/MM (dd/mm)` + `24h` auto-detected; `--day-first/--month-first` short-circuit tests pass | ✓ |
| 3. Multi-line reconstructed; UTF-8/BOM/bidi preserved; AppleDouble ignored | Continuation join asserted (`Senha: TIMEWK2026` folded); UTF-8 no-BOM asserted byte-wise; extract skips `._*`/`__MACOSX` before any inflate (`src/extract.ts`, never `start()`ed) | ✓ |
| 4. Streaming line-by-line, constant memory, no full-archive buffering | fflate `Unzip` streams chunk-by-chunk; only `_chat.txt` entry inflated; event-driven line queue bounded; merge re-reads CSV from disk | ✓ |

## Quality Gates

- **Tests:** `npm test` → **27/27 pass** across 5 suites (tracer, timestamp, classify, csv, integration).
- **Types:** `tsc --noEmit` clean under `strict`.
- **Build:** `npm run build` → `dist/index.js` with shebang; runs headless.
- **Requirements traceability:** PARSE-01..07 all `[x]` Complete in REQUIREMENTS.md.
- **Plans:** 3/3 executed with SUMMARY.md each (01-01 f8e86ac/c27c698 · 01-02 e5eb826/3cbccf3 · 01-03 92167d1/e2fe890).
- **Locked decisions D-01..D-19:** all honored — local wall-clock ISO (no TZ), 8-value type set, raw authors, day-first default, 0x1F dedupe key, stable ascending order, UTF-8 no BOM.

## Gap Closure Record

All 6 UAT gaps diagnosed, fixed, and re-tested:

| Gap | Fix Plan | Retest |
|-----|----------|--------|
| G-01-4 CSV newline escaping | 01-04 (cb06a9b) | test 13 pass |
| G-01-7 npm flag reachability | 01-04 (f371e40) | test 14 pass |
| G-01-8 override flags via npm | 01-04 (f371e40) | test 15 pass |
| G-01-16 chat name from zip basename | 01-05 (0e436a2) | confirmed by user |
| G-01-17 slugified output folders | 01-06 (5de91a2) | test 18 pass |
| G-01-19 real path in success message | 01-07 (d804f92) | test 20 pass |

Final UAT: 20 tests — 14 passed outright + 5 issues fixed & retested + 1 restored. 30/30 automated tests green.

## Known Gaps (non-blocking)

- `--verbose` warning strings exercised only via unit paths (`tryParseTimestamp` warnings collector); no test asserts console output formatting. Cosmetic only.
- Same-second burst rows rely on insertion-order stability at parse time; a pathological out-of-order export could interleave burst groups after merge sort. Accepted for MVP (WhatsApp exports are chronological).

## Threat Mitigations Verified

- T-01-01 zip-slip: chat name sanitized, only `_chat.txt` inflated.
- T-01-03 zip-bomb DoS: streaming readline + PassThrough, per-entry inflation.
- T-01-04 ReDoS: TS_RE anchored, fixed alternation.
