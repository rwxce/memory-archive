---
phase: 01-parsing-model-core
plan: 03
subsystem: parser-core
tags: [csv, merge, dedupe, integration]
requires:
  - 01-01/01-02 parser modules + Message model
provides:
  - dedupeKey(m) — 0x1F-joined 4-field identity (D-16)
  - readCsv(path) → Message[] — RFC-4180 reverse parse
  - mergeCsv(path, newMessages) → addedCount — dedupe + stable ascending sort (D-17)
affects:
  - Phase 2 renderers (consume sorted, deduplicated CSV)
  - Phase 3/4 media reconciliation (incremental append mechanism)
tech-stack:
  added: []
  patterns: [load-merge-stable-sort-rewrite]
key-files:
  created:
    - test/csv.test.ts
    - test/integration.test.ts
  modified:
    - src/csv.ts
    - src/model.ts
    - src/index.ts
decisions:
  - "runParser returns the ADDED-row count from mergeCsv; CLI reports 'Merged N new message(s)' so re-runs honestly show 0"
  - "Stable sort uses an explicit index tiebreaker in addition to Array.sort's spec-level stability (D-17 burst integrity)"
metrics:
  duration: ~20 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 58000
  tasks: 2
  commits: 2
---

# Phase 1 Plan 3: CSV Merge + Authoritative Verification Summary

The CSV source-of-truth now supports incremental merge — dedup by a collision-proof 4-field key, always ascending and BOM-free — locked in by an authoritative integration suite over both real exports. **27/27 tests green.**

## What Was Built

- **src/csv.ts** — `dedupeKey` (timestamp_iso+author+text+media joined with U+001F), `readCsv` (RFC-4180 reverse parse), `mergeCsv` (load existing → skip dupes → stable ascending sort with index tiebreaker → rewrite no-BOM; returns new-row count).
- **src/model.ts** — `runParser` merges instead of overwriting; returns added count.
- **src/index.ts** — CLI wording reflects merge semantics.
- **test/csv.test.ts** — double-merge zero-dup, partial add with dupe skip, ascending + stable burst order, header/no-BOM after rewrite.
- **test/integration.test.ts** — the phase's authoritative acceptance: both real exports end-to-end (known-line sender/timestamp/type/media incl. omitted/deleted/document cases and raw U+200E captions/bidi authors), re-run adds 0 rows, global ordering guard, phantom-row guard.

## Verification Results

- `npm test` → **27/27 pass** across all 5 suites (tracer, timestamp, classify, csv, integration).
- `tsc --noEmit` clean; `npm run build` succeeds.
- Compiled CLI smoke: `node dist/index.js <notas.zip> --out …` → "Merged 187 new message(s)".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2] Return-count semantics**
- **Issue:** plan said "Return the added-count" but tracer-era `runParser` still returned total parsed messages; CLI claimed "Wrote N messages" on zero-add re-runs
- **Fix:** return `added`; CLI reports "Merged N new message(s)"
- **Files:** src/model.ts, src/index.ts
- **Commit:** 92167d1

None otherwise — plan executed as written.

## Known Stubs

None.

## Self-Check: PASSED

- Commits 92167d1, e2fe890 verified via git log.
- SUMMARY.md present.
