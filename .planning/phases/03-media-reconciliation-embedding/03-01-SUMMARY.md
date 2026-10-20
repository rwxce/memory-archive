---
phase: 03-media-reconciliation-embedding
plan: 01
subsystem: media
tags: [zip, zlib, media-reconciliation, base64, streaming, inline]

# Dependency graph
requires:
  - phase: 02-multi-format-rendering
    provides: renderOutputs pipeline + renderers reading messages.csv from disk
provides:
  - src/media.ts (reconcileMedia, buildMediaMap, normalizeMediaName, mimeFromExt, isInlineable, INLINE_MAX_BYTES)
  - media files copied into <out>/<slug>/media/ and referenced relatively
  - --inline self-contained HTML with data: URIs
  - unresolved-media reporting on stderr; placeholder preservation
affects: [04-cli-portable-delivery, any phase reading the rendered backup]

# Actuals (#2632)
actuals:
  tokens: 5025
  tasks: 6
  commits: 5

# Tech tracking
tech-stack:
  added: [node:zlib createInflateRaw, node:fs central-directory parsing]
  patterns: [disk-resident media map decoupled from zip, per-entry streaming copy, data-descriptor-safe zip reader]
key-files:
  created: [src/media.ts, test/media.test.ts]
  modified: [src/model.ts, src/index.ts, src/render/json.ts, src/render/md.ts, src/render/html.ts]
key-decisions:
  - "reconcileMedia uses central-directory random-access + zlib.createInflateRaw (fflate streaming breaks on data-descriptor members)"
  - "match by entry basename so folder-prefixed zips reconcile"
  - "buildMediaMap reads media/ on disk so re-render from CSV needs no zip"
  - "--inline embeds inlineable (<8MiB, non-video) files as data: URIs; video/oversized stay placeholders"
requirements-completed: []

coverage:
  - id: D1
    description: "Reconcile <attached:> refs to zip entries (case/dash/space/(1) tolerant) and stream-copy matched files into media/ — 17/17 on the Notas sample"
    requirement: MEDIA-01
    verification:
      - kind: unit
        ref: "test/media.test.ts#reconcileMedia on Notas pessoais sample: 17 resolved, 0 unresolved"
        status: pass
    human_judgment: false
  - id: D2
    description: "Disk-resident buildMediaMap resolves message media refs to on-disk files tolerant of (1) variance, exposes relPath/mime/inlineable"
    requirement: MEDIA-02
    verification:
      - kind: unit
        ref: "test/media.test.ts#buildMediaMap: resolves disk files tolerant of (1) variance + inlineable flag"
        status: pass
    human_judgment: false
  - id: D3
    description: "--inline embeds inlineable media as data: URIs and keeps video as a placeholder (self-contained HTML)"
    requirement: MEDIA-03
    verification:
      - kind: unit
        ref: "test/media.test.ts#--inline produces data: URIs and skips the video (synthetic)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Unresolved media ref does not crash; reported to stderr and rendered as placeholder in all three outputs; omitted/deleted stay distinct"
    requirement: MEDIA-04
    verification:
      - kind: unit
        ref: "test/media.test.ts#unresolved media ref: no crash, reported, rendered as placeholder (all 3 outputs)"
        status: pass
    human_judgment: false
  - id: D5
    description: "JSON mediaPath + Markdown media links render for resolved media (verified manually on the Notas sample: messages.json mediaPath present, messages.md [icon: F](media/F) links)"
    verification: []
    human_judgment: true
    rationale: "No dedicated unit assertion shipped in this phase's test file for JSON/MD media rendering; verified by manual inspection of the real-sample outputs and the buildMediaMap unit test."

# Metrics
duration: 35min
completed: 2026-08-22
status: complete
---

# Phase 3 Plan 01: Media Reconciliation & Embedding Summary

**Media reconciliation copies all 17 referenced files from the Notas pessoais export into `output/notas-pessoais/media/`, renders real `<img>/<video>/<a>` + JSON `mediaPath` + Markdown links, and `--inline` produces a self-contained HTML with base64 `data:` URIs — unresolved/missing refs report and render as placeholders without crashing.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-08-22
- **Tasks:** 6
- **Files modified:** 7 (src: 6, test: 1)

## Accomplishments

- `src/media.ts` reconciles `<attached:>` refs against zip entries (basename match, case/dash/space/`(1)` tolerant), streams each matched member to `media/` (memory-safe, per-entry), and `buildMediaMap` resolves renderers to on-disk files.
- `runParser` collects distinct media refs, reconciles + copies them, threads `--inline` into the renderers, and reports `resolved`/`unresolved` counts to **stderr** (never throws on unresolved).
- JSON gains `mediaPath` (relative or `null`); Markdown emits `[icon: F](media/F)` links for resolved media and bracket placeholders otherwise; HTML renders `<img>/<video>/<a>` by default and `data:` URIs under `--inline`, with placeholders for missing/oversized/video.
- `wa-backup "data/WhatsApp Chat - Notas pessoais.zip"` copies 17 media files and renders them across all three outputs; `--inline` yields one self-contained `messages.html`.
- 43 tests pass (37 existing + 6 new in `test/media.test.ts`).

## Task Commits

1. **Task 1 + 2: media reconciliation + streaming copy module & disk map** — `2449480` (feat) — `src/media.ts` created with `reconcileMedia`, `buildMediaMap`, `normalizeMediaName`, `mimeFromExt`, `isInlineable`, `INLINE_MAX_BYTES`. (Task 2's `buildMediaMap` shipped inside this module commit.)
2. **Task 3: orchestration + `--inline` flag** — `3900e6f` (feat) — `model.ts` reconciles + reports; `index.ts` adds `--inline`.
3. **Task 4: JSON + Markdown media rendering** — `e383de8` (feat) — `mediaPath` + MD links.
4. **Task 5: HTML media rendering + inline embedding** — `8273697` (feat) — `<img>/<video>/<a>` + `data:` URIs.
5. **Task 6: unresolved reporting + tests** — `f25f178` (test) — `test/media.test.ts` + basename-match fix.

## Files Created/Modified

- `src/media.ts` — reconcileMedia (central-dir index + per-entry raw-inflate streaming copy), buildMediaMap, normalizeMediaName, mimeFromExt, isInlineable, INLINE_MAX_BYTES
- `src/model.ts` — runParser collects distinct media refs, reconciles, reports to stderr; renderOutputs threaded with `{ inline }`
- `src/index.ts` — `--inline` flag
- `src/render/json.ts` — `mediaPath` per rendered message
- `src/render/md.ts` — resolved media as Markdown link, else bracket placeholder
- `src/render/html.ts` — `<img>/<video>/<a>` by default, `data:` URI under `--inline`, placeholders otherwise
- `test/media.test.ts` — 6 new tests

## Decisions Made

- **Zip extraction swapped from fflate streaming to central-directory random-access + `zlib.createInflateRaw`.** The real Notas sample contains a nested `.zip` attachment stored with a ZIP data descriptor (flag bit 3, zeroed local-header sizes); fflate's streaming `file.start()` inflate raises "unexpected EOF" on it. A central-directory parse yields authoritative sizes and a bounded `ReadStream`→`createInflateRaw`→`WriteStream` copy per member. Memory-safe (one entry at a time) and handles the real export.
- **Match by entry basename, not full path** — reconciles zips whose media live under a folder prefix, not just flat-root layouts.
- **`buildMediaMap(dir, messages)` reads `media/` from disk** — decouples renderers from the zip so a re-render from `messages.csv` still resolves already-copied media (Phase-2 property preserved).
- **`--inline` size cap** — only files `< INLINE_MAX_BYTES` (8 MiB) and non-video are embedded as `data:` URIs; video/oversized fall back to a placeholder (the media file is still copied, so a relative link would also be valid — placeholder chosen to keep HTML bounded and openable).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] fflate streaming inflate fails on data-descriptor zip members**
- **Found during:** Task 1 (`reconcileMedia` verification on the real Notas sample)
- **Issue:** The sample's attached inner `.zip` (`00000068-…zip`) is stored with a ZIP data descriptor (flag bit 3, local-header `csize`/`usize = 0`). fflate's streaming `file.start()` / `AsyncUnzipInflate` raises "unexpected EOF" for it, so only 16/17 files copied and the run errored.
- **Fix:** Replaced the fflate streaming copy with a central-directory parse (random-access, metadata-only) + per-member `ReadStream({start,end})` → `zlib.createInflateRaw()` → `WriteStream`. Authoritative sizes come from the central directory; each member is streamed independently. Memory-safe (one entry at a time).
- **Files modified:** `src/media.ts`
- **Verification:** `reconcileMedia` on the Notas sample returns `{resolved:17, unresolved:0}` and the 65 MB inner `.zip` is copied intact; all 43 tests pass.
- **Committed in:** `2449480`

**2. [Rule 1 - Bug] reconcileMedia matched full entry path, not basename**
- **Found during:** Task 6 (synthetic `--inline` test)
- **Issue:** Normalizing the full entry name (e.g. `WhatsApp Chat - X/pic.png`) collapsed the folder prefix differently than the bare ref (`pic.png`), so no match occurred and nothing was copied for folder-prefixed zips.
- **Fix:** Index entries by `normalizeMediaName(basename)` in `reconcileMedia`.
- **Files modified:** `src/media.ts`
- **Verification:** synthetic folder-prefixed zip now resolves + copies; real flat sample still 17/0.
- **Committed in:** `f25f178`

**3. [Plan inaccuracy] Stale filename in plan assertions**
- **Found during:** Task 1 verification
- **Issue:** The plan's exact assertions name `IMG-20190424-WA0003.jpg` as a resolved media file, but that filename is **not** referenced by `<attached:>` in the actual `_chat.txt` (the 17 real refs are the sticker/photo/video/pdf/inner-zip set listed in `03-RESEARCH.md`). 
- **Fix:** Implemented the correct behavior (resolve the 17 actually-referenced files, 0 unresolved) and wrote tests against the real referenced filenames (`00000089-VIDEO-…mp4`, `00000152-…IRPF…pdf`, etc.). No code change needed — the plan's example filename was simply stale.
- **Files modified:** none (test assertions only)
- **Verification:** `test/media.test.ts` asserts 17/0 and checks the genuinely-present files.
- **Committed in:** `f25f178`

---

**Total deviations:** 3 (2 auto-fixed bugs, 1 plan-assertion correction)
**Impact on plan:** All auto-fixes necessary for correctness against the real export. No scope creep; the MEDIA-01..04 truths are all satisfied.

## Issues Encountered

- fflate data-descriptor limitation (see Deviation 1) — resolved by switching to a central-directory + `zlib` extraction that is still streaming and memory-safe.
- None otherwise; the existing 37 tests stayed green throughout.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 complete: media is reconciled, copied, rendered, and optionally inlined.
- Phase 4 (CLI & Portable Delivery) can build on `--out` and the standalone `file://`-openable outputs already produced here.
- No blockers.

---
*Phase: 03-media-reconciliation-embedding*
*Completed: 2026-08-22*
