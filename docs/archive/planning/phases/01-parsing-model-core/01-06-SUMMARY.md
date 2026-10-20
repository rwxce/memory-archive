---
phase: 01-parsing-model-core
plan: 06
subsystem: parser-core
tags: [cli, naming, slugify, gap-closure]
gap_closure: true
gap_ids: [G-01-17]
requires:
  - 01-05 chatNameFromZip basename fallback
provides:
  - slugifyChatName(name) — prefix strip + diacritic-free lowercase slug
affects:
  - output folder layout (terminal-friendly names)
tech-stack:
  added: []
  patterns: [slugify]
key-files:
  modified:
    - src/extract.ts
    - test/tracer.test.ts
    - test/classify.test.ts
    - test/integration.test.ts
decisions:
  - "Slug rule: strip ^'WhatsApp Chat - ' prefix, NFD-diacritics removed, lowercase, non-alphanumeric runs collapsed to single '-'"
metrics:
  duration: ~10 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 14000
  tasks: 1
  commits: 1
---

# Phase 1 Plan 6: Gap Closure — Slugged Chat-Name Folders Summary

Closes G-01-17: output folders are now the bare chat name, slugified for terminal handling.

## What Was Built

- **src/extract.ts** — exported `slugifyChatName`: strips the `WhatsApp Chat - ` prefix, removes diacritics via NFD normalization, lowercases, collapses non-alphanumeric runs to `-`. `chatNameFromZip` applies it to both folder-wrapped and root-level-derived names. `WhatsApp Chat - Plataforma WK` → `plataforma-wk`; `WhatsApp Chat - Notas pessoais` → `notas-pessoais`.
- **Tests** — all three suites now compute expected output dirs through the same helper; root-level test expects `root-level`.

## Verification Results

- `npm test` → **30/30 pass**.
- Real-export smoke: `npx tsx src/index.ts "data/WhatsApp Chat - Plataforma WK.zip" --out /tmp/uat3` → `/tmp/uat3/plataforma-wk/messages.csv`.

## Deviations from Plan

None.

## Gap Resolution

| Gap | Resolution |
|-----|------------|
| G-01-17 | Bare slugged chat-name folders |

## Self-Check: PASSED

- Commit 5de91a2 verified via git log.
