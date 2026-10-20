---
phase: 01-parsing-model-core
plan: 05
subsystem: parser-core
tags: [cli, naming, gap-closure]
gap_closure: true
gap_ids: [G-01-16]
requires:
  - 01-01 extract.ts chatNameFromZip
provides:
  - chatNameFromZip root-level fallback → ZIP file basename
affects:
  - output folder layout for all real exports
tech-stack:
  added: []
  patterns: [basename-fallback]
key-files:
  modified:
    - src/extract.ts
    - test/integration.test.ts
decisions:
  - "Root-level _chat.txt (real-export layout) names the output folder after the ZIP file; folder-wrapped exports keep the folder name"
metrics:
  duration: ~10 min
  completed: 2026-08-21
status: complete
actuals:
  tokens: 15000
  tasks: 1
  commits: 1
---

# Phase 1 Plan 5: Gap Closure — Chat Name from ZIP Basename Summary

Closes G-01-16: real WhatsApp exports (which store `_chat.txt` at the archive root) now produce `<out>/<zip basename>/messages.csv` instead of a generic `chat` folder.

## What Was Built

- **src/extract.ts** — `chatNameFromZip`: when the `_chat.txt` entry has no top-level folder, the name comes from `path.basename(zipPath)` with `.zip` stripped; sanitization unchanged. Folder-wrapped exports keep prior behavior.
- **test/integration.test.ts** — root-level-layout test asserting the CSV lands at `<out>/WhatsApp Chat - Root Level/messages.csv`.

## Verification Results

- `npm test` → **30/30 pass**.
- Real-export CLI smoke: `npx tsx src/index.ts "data/WhatsApp Chat - Plataforma WK.zip" --out /tmp/uat2 --verbose` → `/tmp/uat2/WhatsApp Chat - Plataforma WK/messages.csv`, detection report printed, 134 messages merged.

## Deviations from Plan

None — plan executed as written.

## Gap Resolution

| Gap | Resolution |
|-----|------------|
| G-01-16 | Output folder = ZIP basename for root-level exports |

## Self-Check: PASSED

- Commit 0e436a2 verified via git log.
