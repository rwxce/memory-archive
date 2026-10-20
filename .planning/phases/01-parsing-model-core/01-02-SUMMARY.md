---
phase: 01-parsing-model-core
plan: 02
subsystem: parser-core
tags: [parser, locale-detection, classification]
requires:
  - 01-01 tracer modules (timestamp/message/model)
provides:
  - detectFormat(lines, opts) → Detection (day/month vote, is12h, override flag)
  - tryParseTimestamp / parseTimestamp(stripped, detection, warnings?)
  - resolveYear (sliding window, exported)
  - classifyType(body, media, hasSender) — attached > omitted > deleted > system > text
  - onDetection hook + verboseReport(detection, warnings, count)
affects:
  - 01-03 (consumes Message model + CSV writer for merge/dedupe)
tech-stack:
  added: []
  patterns: [per-file-format-vote, lazy-in-stream-sampling, ordered-type-classification]
key-files:
  created:
    - test/timestamp.test.ts
    - test/classify.test.ts
  modified:
    - src/parse/timestamp.ts
    - src/parse/message.ts
    - src/model.ts
decisions:
  - "Omitted-marker regex makes BOTH brackets optional — real Android exports write `image omitted`/`document omitted` without `<>`"
  - "Format detection runs lazily in-stream (bounded 200-line buffer) instead of a separate pre-pass — single pass, no second ZIP read"
  - "2-digit yy=99 resolves to 1999 by the window, then D-08 sanity gate rejects it as continuation — window math tested via exported resolveYear"
metrics:
  duration: ~25 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 61000
  tasks: 2
  commits: 2
---

# Phase 1 Plan 2: Locale Detection + Type Classification Summary

Per-file format detection (day/month majority vote, 12h/24h, sanity window) and complete message-type classification across all 8 locked values — verified by 17 passing tests including real Notas pessoais omitted/deleted/document cases.

## What Was Built

- **src/parse/timestamp.ts** — `detectFormat`: CLI overrides short-circuit; otherwise majority-validity vote over ≤50 sampled timestamped lines (tie → day-first A2); `is12h` when ANY AM/PM token appears. `tryParseTimestamp` applies the file-level decision per line: day/month assignment, PM/AM conversion (`pm&&h≠12→+12`, `am&&h==12→0`), sliding-window year, sanity window 2009..curYear+1, invalid dates → `null` (+ warning strings). `resolveYear` exported for tests.
- **src/parse/message.ts** — `classifyType(body, media, hasSender)` with locked ordering attached→omitted→deleted→system→text; omitted-marker brackets optional (real data has bare `image omitted`); deleted match anchored + case-insensitive. Detection now runs lazily in-stream: lines buffer until 200 samples or EOF, then `detectFormat` resolves once and everything replays through the same state machine — still a single streaming pass. `onDetection` hook exposes the decision.
- **src/model.ts** — collects warnings, prints `verboseReport` (order/clock/sample/warnings/parsed count via picocolors) when `--verbose`.
- **test/timestamp.test.ts** — 10 unit tests covering every D-0x behavior in the plan's acceptance list.
- **test/classify.test.ts** — real Notas assertions: line 6 `image omitted`, line 14 `Mensagem apagada`, line 15 `sticker omitted`, line 18 document-omitted w/ caption preserved, line 196 pdf attachment with raw U+200E mid-body caption; locked-8 type guard; byte-for-byte raw-author guard.

## Verification Results

- `npm test` → **17/17 pass** (was 4; no regressions).
- `tsc --noEmit` clean; `npm run build` succeeds.
- CLI verbose smoke on real Notas zip: reports `DAY/MM (dd/mm)`, `24h`, sample `[17/03/2026, 13:17:58]`, 187 messages.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's OMITTED_RE required closing `>`**
- **Issue:** `/<?(?:media|…)\s+omitted>/i` misses real Android markers written without brackets (Notas lines 6/15/18)
- **Fix:** both brackets optional `<?…\s+omitted\s*>?`
- **Commit:** e5eb826

**2. [Rule 1] Acceptance criteria conflict: `[15/08/99]` → 1999 vs sanity-window null**
- **Resolution:** keep both contracts — window math verified via exported `resolveYear`; `parseTimestamp('…99…')` correctly returns `null` because D-08 rejects pre-2009. Documented in test.
- **Commit:** 3cbccf3

**3. [Design deviation] Two-pass sampling replaced by lazy in-stream buffering**
- **Why:** extractChatTxt streams once; re-reading for a sample would need either a second ZIP pass or unbounded peeking. The bounded 200-line buffer inside the state machine achieves identical semantics in one pass.
- **Files:** src/parse/message.ts

## Known Stubs

None.

## Self-Check: PASSED

- Commits e5eb826, 3cbccf3 verified via git log.
- SUMMARY.md present.
