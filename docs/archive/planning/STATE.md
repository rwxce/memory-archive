---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 03
current_phase_name: media-reconciliation-embedding
status: completed
stopped_at: Phase 3 plan 03-01 verified (passed)
last_updated: "2026-08-23T00:00:00.000Z"
progress:
  total_phases: 3
  completed_phases: 3
  total_plans: 8
  completed_plans: 8
---

# STATE.md

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-21)
**Core value:** A person can open their WhatsApp history years later and see the full conversation — text and media together — without needing WhatsApp, a phone, or any account.
**Current focus:** Phase 03 — media-reconciliation-embedding

## Phase Status

| Phase | Status | Plans | Progress |
|-------|--------|-------|----------|
| 1 | ✓ Complete | 7/7 | 100% |
| 2 | ✓ Complete | 1/1 | 100% |
| 3 | ✓ Complete | 1/1 | 100% |

## Current Position

**Phase:** 03 (media-reconciliation-embedding) — COMPLETE
**Plan:** 1 of 1
**Status:** Phase 03 complete — media reconciliation & embedding shipped

## Active Feature

Phase 01 parsing-model-core — streaming tracer parser delivered (01-01 ✓).

## Recent Activity

- 2026-08-21: Phase 1 UAT COMPLETE — all 20 tests resolved, all 6 gaps fixed & retested.
- 2026-08-21: 01-07 gap closure complete — real output path in success message.
- 2026-08-21: 01-06 gap closure complete — slugged chat-name folders.
- 2026-08-21: 01-05 gap closure complete — chat name from ZIP basename.
- 2026-08-21: 01-04 gap closure complete — CSV escaping + CLI flag reachability.
- 2026-08-21: Phase 1 VERIFIED — goal achieved, all gates green.
- 2026-08-21: 01-03 complete — CSV merge/dedupe + authoritative integration suite.
- 2026-08-21: 01-02 complete — locale detection + type classification.
- 2026-08-21: 01-01 complete — streaming tracer parser + real-sample integration tests.
- 2026-08-21: Project initialized; requirements defined; roadmap created.
- 2026-08-22: Phase 2 COMPLETE — 02-01 multi-format rendering (JSON+MD+HTML, XSS-safe) shipped; 37 tests pass.
- 2026-08-22: Phase 3 PLANNED — 03-01 media reconciliation & embedding (MEDIA-01..04): copy media, relative refs, `--inline` base64, placeholder preservation.
- 2026-08-22: Phase 3 COMPLETE — 03-01 media reconciliation & embedding shipped; 43 tests pass (37 existing + 6 new); `wa-backup <zip>` copies 17 media files + `--inline` self-contained HTML.

## Session

**Last session:** 2026-08-21T20:10:33.125Z
**Stopped at:** Phase 2 context gathered
**Resume file:** .planning/phases/02-multi-format-rendering/02-CONTEXT.md

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01-01 | 45m | 2 tasks | 12 files |
| Phase 01 P01-02 | 25m | 2 tasks | 5 files |
| Phase 01 P01-03 | 20m | 2 tasks | 5 files |
| Phase 01 P01-04 | 15m | 2 tasks | 4 files |
| Phase 01 P01-05 | 10m | 1 tasks | 2 files |
| Phase 01 P01-06 | 10m | 1 tasks | 4 files |
| Phase 01 P01-07 | 5m | 1 tasks | 1 files |
| Phase 03 03-01 | 35m | 6 tasks | 6 files |

## Decisions

- [Phase 01]: extractChatTxt returns AsyncIterable<string> — Node 26 readline for-await hang workaround
- [Phase 01]: SENDER_RE separator `:` + whitespace or EOL — empty-body lines merge, URLs safe
- [Phase ?]: Omitted-marker brackets optional (Android drops them); detection is lazy in-stream single pass
- [Phase ?]: runParser returns added-count; CSV merge is the incremental source-of-truth mechanism (D-13/D-16/D-17)
- [Phase 02]: Single CLI run emits CSV+JSON+MD+HTML; renderers re-read messages.csv (D-20/D-22)
- [Phase 02]: metadata.chatName = display name (e.g. "Plataforma WK"); folder = slug (plataforma-wk)
- [Phase 02]: Outgoing side = most-frequent author (no self marker in export); SHA-256(author)%360 -> hue
- [Phase 02]: eta 4.6 unavailable offline -> HTML shell via inline TS templates (deviation)
- [Phase 03]: reconcileMedia reads the ZIP central directory (random-access) + streams each member via Node `zlib.createInflateRaw` — required because fflate's streaming inflate breaks on data-descriptor members (the sample's nested `.zip` attachment), so the planned fflate `file.start()` path was replaced (deviation, Rule 1)
- [Phase 03]: match by entry BASENAME (not full path) so zips with a folder prefix also reconcile (MEDIA-01 robustness)
- [Phase 03]: disk-resident `buildMediaMap(dir, messages)` decouples renderers from the zip — re-render from CSV works without the archive (D-M5)
- [Phase 03]: `--inline` embeds inlineable files (< 8 MiB, non-video) as `data:` URIs; video/oversized stay placeholders; unresolved refs reported to stderr, never crash (MEDIA-03/04)
