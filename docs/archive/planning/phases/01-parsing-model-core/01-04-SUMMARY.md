---
phase: 01-parsing-model-core
plan: 04
subsystem: parser-core
tags: [csv, escaping, cli, gap-closure]
gap_closure: true
gap_ids: [G-01-4, G-01-7, G-01-8]
requires:
  - 01-01..01-03 parser + CSV modules
provides:
  - csvField/readCsv escape round-trip (one physical line per row)
  - CLI --zip option alias with exactly-one validation
  - flag-safe help examples (npm `--` separator)
affects:
  - Phase 2 renderers (CSV stays the source of truth; escaped form is canonical)
tech-stack:
  added: []
  patterns: [escape-round-trip, exactly-one-arg-resolution]
key-files:
  modified:
    - src/csv.ts
    - src/index.ts
    - test/csv.test.ts
    - test/tracer.test.ts
decisions:
  - "Escaping order: backslash first, then CR/LF -> \\n / \\r; unescape is a single left-to-right pass so \\\\n never double-decodes"
  - "Old-format CSVs (real newlines inside quoted fields) remain readable; next merge rewrites them in escaped form"
metrics:
  duration: ~15 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 26000
  tasks: 2
  commits: 2
---

# Phase 1 Plan 4: Gap Closure — CSV Escaping + CLI Flag Reachability Summary

Closes all three UAT gaps: every CSV row is now ONE physical line (embedded newlines written as literal `\n`, lossless round-trip), and CLI flags reach the parser through both direct and npm invocation forms.

## What Was Built

- **src/csv.ts** — `csvField` escapes `\` → `\\` then CR/LF → `\n`/`\r` literals before RFC-4180 quoting; `readCsv` applies the exact inverse per field. Backward compatible: old files with real newlines in quoted fields still parse and are rewritten escaped on next merge.
- **src/index.ts** — positional `[zip]` optional, `--zip <path>` alias added; exactly-one rule exits 1 with clear messages for both/neither. `--help` gained copy-paste examples including `npm run dev -- "<zip>" --verbose` with the `--` separator explained.
- **Tests** — physical-line count assertion across every field, lossless round-trip incl. backslash edge cases (`back\slash`, literal `\n` text), merge re-write stability; tracer suite now guards against raw line breaks leaking into any field.

## Verification Results

- `npm test` → **29/29 pass**.
- `tsc --noEmit` clean; build succeeds.
- CLI checks: `--zip … --verbose` prints detection report; both-given → exit 1; neither → exit 1 + usage; help shows npm example.

## Deviations from Plan

None — plan executed as written.

## Gap Resolution

| Gap | Resolution |
|-----|------------|
| G-01-4 | Escaped CR/LF, one physical line per row, lossless round-trip |
| G-01-7 | `--zip` alias + verbose reachable via documented forms |
| G-01-8 | Same fix family — override flags documented with `--` separator |

## Self-Check: PASSED

- Commits cb06a9b, f371e40 verified via git log.
