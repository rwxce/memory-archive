---
phase: 01-parsing-model-core
plan: 07
subsystem: cli
tags: [cli, ux, gap-closure]
gap_closure: true
gap_ids: [G-01-19]
requires:
  - 01-06 slugified chat folders
provides:
  - success message with real resolved output path
affects: []
tech-stack:
  added: []
  patterns: []
key-files:
  modified:
    - src/index.ts
decisions:
  - "Path resolved via chatNameFromZip at print time (cheap header-only zip read) rather than changing runParser's return contract"
metrics:
  duration: ~5 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 9000
  tasks: 1
  commits: 1
---

# Phase 1 Plan 7: Gap Closure — Real Output Path in Success Message Summary

Closes G-01-19: the CLI now prints the actual output path.

## What Was Built

- **src/index.ts** — after `runParser`, resolves the chat name and prints `path.join(outDir, chat, 'messages.csv')`. Example: `✓ Merged 134 new message(s) into /tmp/uat5/plataforma-wk/messages.csv`.

## Verification Results

- `tsc --noEmit` clean; `npm test` → **30/30 pass**; build succeeds.
- CLI smoke shows the real path.

## Deviations from Plan

None.

## Gap Resolution

| Gap | Resolution |
|-----|------------|
| G-01-19 | Real path interpolated in success message |

## Self-Check: PASSED

- Commit d804f92 verified via git log.
