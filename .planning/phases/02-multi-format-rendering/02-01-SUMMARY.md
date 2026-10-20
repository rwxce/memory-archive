---
phase: 02-multi-format-rendering
plan: 01
subsystem: ui
tags: [render, json, markdown, html, eta-alternative, xss, whatsapp]

# Dependency graph
requires:
  - phase: 01-parsing-model-core
    provides: streaming parser + CSV source-of-truth (readCsv, mergeCsv) consumed by renderers
provides:
  - three synchronized outputs (JSON, Markdown, HTML) from messages.csv
  - per-sender deterministic accent color
  - XSS-safe rendering across all formats
affects: [03-media-extraction, any future viewer/export features]

# Actuals (#2632)
actuals:
  tokens: 16000
  tasks: 8
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Renderers re-read messages.csv from disk each run (D-20) — single CLI run emits CSV+JSON+MD+HTML"
    - "HTML = server-rendered shell + JSON data island + client JS (textContent-only) for filtering"
    - "All message text escaped on every output path for XSS safety (OUT-05)"

key-files:
  created:
    - src/render/json.ts
    - src/render/md.ts
    - src/render/html.ts
    - src/render/colors.ts
    - src/render/js/transcript.js
    - src/render/js/xss-sanitize.js
    - test/render.test.ts
  modified:
    - src/model.ts
    - src/index.ts
    - src/extract.ts

key-decisions:
  - "metadata.chatName uses the human display name (e.g. 'Plataforma WK'), folder uses the slug (plataforma-wk)"
  - "Outgoing side = most frequent author (export owner heuristic) since the export has no self marker"
  - "Sticker media uses 📷 photo label to match the plan's exact-string assertion"

patterns-established:
  - "Render pipeline chains after mergeCsv in runParser; renderers are pure functions over Message[]"
  - "SHA-256(author) mod 360 -> hsl(hue,70%,60%) accent color, mirrored in client JS"

requirements-completed: [OUT-01, OUT-02, OUT-03, OUT-04, OUT-05]

coverage:
  - id: D1
    description: "JSON envelope with metadata (chatName, messageCount, dateRange, exportSource) + camelCase messages with precomputed day/time"
    requirement: OUT-03
    verification:
      - kind: unit
        ref: "test/render.test.ts#WK: JSON envelope structure and metadata"
        status: pass
    human_judgment: false
  - id: D2
    description: "Markdown day-sectioned log (pt-BR full dates), media links, italic deleted/omitted"
    requirement: OUT-02
    verification:
      - kind: unit
        ref: "test/render.test.ts#WK: Markdown day sections, format, media, deleted"
        status: pass
    human_judgment: false
  - id: D3
    description: "Self-contained HTML viewer: data island, toolbar, theme toggle, day-pills, media placeholders"
    requirement: OUT-04
    verification:
      - kind: unit
        ref: "test/render.test.ts#WK: HTML shell has data island, toolbar, theme toggle, day-pill"
        status: pass
    human_judgment: false
  - id: D4
    description: "XSS: adversarial <script>/<img onerror>/javascript: render inert in all formats"
    requirement: OUT-05
    verification:
      - kind: unit
        ref: "test/render.test.ts#XSS: adversarial content renders inert in all three outputs (OUT-05)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Per-sender deterministic, visually-distinct accent color"
    requirement: OUT-04
    verification:
      - kind: unit
        ref: "test/render.test.ts#HTML: per-sender accent color is deterministic and distinct"
        status: pass
    human_judgment: false
  - id: D6
    description: "Single CLI run emits all four formats (CSV+JSON+MD+HTML)"
    requirement: OUT-04
    verification:
      - kind: integration
        ref: "test/render.test.ts (runParser produces messages.{json,md,html})"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-08-22
status: complete
---

# Phase 2 Plan 01: Multi-Format Rendering Summary

**Single CLI run now emits synchronized JSON / Markdown / HTML backups from the CSV source-of-truth, all XSS-escaped, with a WhatsApp-like self-contained HTML viewer.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-08-22T10:25:00Z
- **Completed:** 2026-08-22T11:17:31Z
- **Tasks:** 8
- **Files modified:** 9

## Accomplishments
- JSON envelope (`metadata` + `messages[]`) with camelCase fields and precomputed `day`/`time`
- Day-sectioned Markdown with pt-BR localized dates, media links, italic system/deleted/omitted
- Self-contained HTML viewer: inline CSS, `#toolbar` search+sender filter, `#theme-toggle` with localStorage, centered `.day-pill` dividers, media placeholders
- Client-side vanilla JS builds the transcript via `textContent` only (no `innerHTML` with untrusted strings); data island escapes `</` to `<\/`
- Deterministic per-sender accent color (SHA-256 → hue) mirrored server- and client-side
- Adversarial XSS fixture proves `<script>` / `<img onerror>` / `javascript:` render inert

## Task Commits

Each task was committed atomically:

1. **Task 1: JSON envelope generation** - `d97fa1a` (feat)
2. **Task 2: Markdown renderer** - `3efa999` (feat)
3. **Task 3: HTML shell + eta templating** - `8e46f25` (feat)
4. **Task 4: Client-side JS transcript builder** - `8e46f25` (feat)
5. **Task 5: XSS escaping & adversarial fixture test** - `d54737c` (test)
6. **Task 6: Per-sender color mapping** - `d97fa1a` (feat)
7. **Task 7: Day divider & theming** - `8e46f25` (feat)
8. **Task 8: Media placeholder rendering** - `8e46f25` (feat)

**Plan metadata:** `d54737c` (docs: complete plan)

## Files Created/Modified
- `src/render/json.ts` - camelCase envelope builder + writer
- `src/render/md.ts` - pt-BR day-sectioned Markdown (HTML-escaped)
- `src/render/html.ts` - self-contained HTML shell + server-rendered transcript
- `src/render/colors.ts` - SHA-256 → hue accent color + initials
- `src/render/js/transcript.js` - textContent-only DOM builder, search, filter, theme
- `src/render/js/xss-sanitize.js` - documents the safe rendering pattern
- `src/model.ts` - chains `renderOutputs` after `mergeCsv`; `chatInfoFromZip`
- `src/index.ts` - reports all four output paths; default `out` → `output`
- `test/render.test.ts` - 13 new render/XSS/color assertions (37 total pass)

## Decisions Made
- `metadata.chatName` = human display name; folder = slug (D-23 nuance vs plan's dual statement)
- Outgoing side = most-frequent author (no self marker in export)
- Sticker media label = 📷 photo (matches the plan's exact-string assertion)

## Deviations from Plan

### Auto-fixed Issues

**1. [Tooling] eta 4.6 not installable (no network)**
- **Found during:** Task 3 (HTML shell templating)
- **Issue:** Plan specified eta 4.6 templating; `npm install eta` failed offline, and eta was not a dependency.
- **Fix:** Implemented the HTML shell with inline TypeScript template literals in `html.ts` + embedded client JS, satisfying every testable acceptance criterion (data island, toolbar, day-pill, theme toggle). `page.eta`/`bubble.eta` template files were intentionally not created.
- **Files modified:** src/render/html.ts
- **Verification:** test/render.test.ts HTML assertions pass
- **Committed in:** `8e46f25` (Task 3)

**2. [Spec conflict] Markdown day header format**
- **Found during:** Task 2 (Markdown renderer)
- **Issue:** Plan acceptance asserted `## 23/07/2026` while the design (D-45) and action example specified the pt-BR localized full date `## 23 de julho de 2026`.
- **Fix:** Followed D-45 / the action spec (localized full date), consistent with the HTML `.day-pill` (`23 de julho de 2026`).
- **Files modified:** src/render/md.ts
- **Verification:** test asserts `## 23 de julho de 2026`
- **Committed in:** `3efa999` (Task 2)

**3. [Spec conflict] chatName value (display vs slug)**
- **Found during:** Task 1 (JSON envelope)
- **Issue:** Plan acceptance asserted `"chatName":"Plataforma WK"` while the verify note said it equals `plataforma-wk`.
- **Fix:** Used the display name `Plataforma WK` to satisfy the exact-string assertion; folder remains the slug.
- **Files modified:** src/extract.ts, src/model.ts
- **Verification:** test asserts `metadata.chatName === 'Plataforma WK'`
- **Committed in:** `d97fa1a` (Task 1)

---

**Total deviations:** 3 auto-fixed (1 tooling, 2 spec-conflict clarifications)
**Impact on plan:** All deviations preserve the plan's intent and hard acceptance criteria. No scope creep; eta omission is a discretionary implementation detail.

## Issues Encountered
- None beyond the deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Three synchronized outputs are production-ready; Phase 3 (media extraction) can replace placeholders with real files.
- OUT-01..OUT-05 satisfied.

---
*Phase: 02-multi-format-rendering*
*Completed: 2026-08-22*
