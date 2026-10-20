# Phase 2: Multi-Format Rendering — Research

**Researched:** 2026-08-24

## Overview

This phase renders a parsed WhatsApp chat model into three synchronized outputs:
1. **JSON** — structured envelope with metadata + `messages` array (camelCase fields)
2. **Markdown** — day-sectioned log (`## <date>` then `**Sender** · HH:mm — text`)
3. **HTML** — WhatsApp-like bubbles with per-sender colors, timestamps, day dividers, and XSS-safe rendering

All content is XSS-escaped (OUT-05). Media renders as labeled placeholders pending Phase 3.

## Key Decisions & Research Findings

### Renderer Input & Pipeline (D-20)
- Renderers read `messages.csv` from disk each run — true to D-13. Enables re-rendering old backups without the original ZIP.
- One run ALWAYS emits all four formats (CSV, JSON, MD, HTML) — no format-selection flags (D-22).
- CSV is the source-of-truth; renderers consume `readCsv()` from `src/csv.ts`.

### JSON Output (D-23, D-24, D-25)
- Envelope structure: metadata at top (chat name, message count, date range, export source) + `messages` array.
- Field names camelCase (`timestampIso`, `type`, `author`, `text`, `media`) — idiomatic TypeScript for future web reuse.
- Per-message precomputed fields: `day` (`yyyy-mm-dd`) and `time` (`HH:mm:ss`) so renderers skip date parsing.
- JSON is minified (smallest file) — human readability served by MD/HTML.

### HTML Architecture (D-27, D-28, D-30)
- HTML = eta-rendered static shell (head, CSS, toolbar skeleton) + embedded JSON data island (`<script type="application/json" id="chat-data">`) + client-side vanilla JS that builds the transcript DOM dynamically.
- **LANDMINE:** When embedding JSON inside `<script>`, must escape `</` sequences (e.g. `<\/`) in serialized string or message text containing `</script>` breaks the document.
- Client-side filtering: free-text search across message text + author, plus a sender dropdown filter.
- DOM APIs only (`createElement`/`textContent`) — injection-proof by construction; never `innerHTML` with untrusted strings.

### HTML Appearance (D-31 through D-41)
- Theme: light AND dark with a small toggle button, persisted via localStorage.
- Bubble colors: WhatsApp authentic green/white (`#d9fdd3`/`#005c4b` outgoing; white/dark-gray incoming) + deterministic per-sender accent color on sender name text (hash of author → hue).
- Fonts: system-ui stack (Segoe UI/Helvetica/Roboto) — zero font loading, offline-safe.
- Layout: centered chat column, max-width ~768px on neutral page background.
- Day dividers: centered pill chip, locale-aware dates via `Intl`.
- System/deleted/omitted messages: centered gray pill, visually distinct from user bubbles.
- Consecutive same-sender messages within ~5 minutes group into bubble clusters (sender shown once).
- Avatars: small circular initials chips next to incoming bubbles, colored by per-sender accent.
- Print stylesheet (`@media print: white bg, hide toggle`) + hover shows exact timestamp on bubbles.
- Media renders as styled placeholder boxes (icon + filename) — Phase 3 replaces with real files.

### Templating & Assets (D-42, D-43)
- Template engine: **eta 4.6** (3KB, auto-escape default, TS-native). Renders the shell only; bubbles/day-pills built by JS.
- CSS ships as a single inline `<style>` block in the head — file stays fully self-contained (no server).

### Markdown Style (D-45, D-46, D-47)
- Day sections: `## <localized full date>` then per message `**Sender** · HH:mm — text`.
- Media as labeled link `[📷 photo: FILENAME]` — never broken-image embeds before Phase 3.
- System/deleted/omitted as italic line `*text*`.

### XSS Verification (D-49)
- Adversarial fixture test: messages containing `<script>`, `<img onerror=...>`, `javascript:` URLs must render inert in HTML output (both eta path and JS-rendered path).

### Agent Discretion
- Exact CSS values (spacing, pill sizes, accent-hue hash algorithm)
- Search UX micro-interactions (free-text search + sender dropdown)
- Envelope key names beyond those specified
- Internal module split of `src/render/`

### Canonical References
- **Downstream agents MUST read** `.planning/REQUIREMENTS.md` — OUT-01..OUT-05 definitions (this phase's acceptance).
- **Stack guidance:** `AGENTS.md` — Tech stack constraints (TypeScript/Node ESM; core reusable in web frontend). STACK research recommends eta 4.6 for templating (confirmed in D-42).
- **Ground truth:** `data/WhatsApp Chat - Plataforma WK/_chat.txt` — real pt-BR sample incl. bidi authors, emoji, omitted markers.
- `data/WhatsApp Chat - Notas pessoais/_chat.txt` — second sample with deleted/document-omitted cases.

### Deferred Ideas (not blocking)
- Full date-range pickers and type-based filters in the HTML viewer — enhancement after basic search+sender filter proves out.
- Per-sender stats section in the JSON envelope.

## Research Gaps & Open Questions

1. **Accent color hash algorithm** — Determine the hash function used to map sender names to hues. Need to test with the pt-BR sample to ensure visual distinctness.

2. **Bubble clustering threshold** — Confirm the ~5-minute consecutive-same-sender clustering window. Test with chat data containing varying message tempos.

3. **Dark mode toggle persistence** — Design the localStorage key and persistence mechanism (~10 lines inline vanilla JS before `</body>`).

4. **Print stylesheet scope** — Verify all HTML elements render correctly under `@media print`, especially CSS-dependent bubble colors and hidden toggle.

5. **Media placeholder design** — Finalize the icon + filename style for media placeholders (Phase 3 will replace with real files). Need to decide on icon type (📷 photo, 🎬 video, 🎧 audio, etc.) and filename display format.

6. **Edge case: `<script>` in message text** — Ensure the `</` escaping for data islands works correctly when message bodies contain `</script>` or similar patterns. This is the top XSS landmine (D-32).

7. **CSV re-read vs. in-memory** — Confirm that reading `messages.csv` from disk each run (D-20) is performant enough, or if an in-memory model should be passed through the render pipeline.

## Dependencies & Canonical Sources

- `.planning/REQUIREMENTS.md` — OUT-01..OUT-05 definitions
- `.planning/phases/01-parsing-model-core/01-CONTEXT.md` — D-13/D-14/D-15/D-18: CSV source-of-truth, column schema, 8 message types, ISO timestamp contract
- `src/csv.ts` — `readCsv()` parses messages.csv back into `Message[]`; renderers consume this directly
- `src/model.ts` — `runParser()` orchestrator; rendering hooks in after CSV write
- `src/index.ts` — commander CLI with `--out/--day-first/--month-first/--verbose`
- `data/WhatsApp Chat - Plataforma WK/_chat.txt` — real pt-BR sample
- `data/WhatsApp Chat - Notas pessoais/_chat.txt` — second sample with deleted/document-omitted cases

## Decisions Recorded

- **D-20:** CSV source-of-truth, re-read each run
- **D-22:** One run emits all four formats
- **D-23:** JSON envelope structure + camelCase field names
- **D-27:** Data-driven HTML app (eta shell + JSON data island + client-side JS)
- **D-31:** Light/dark theme with localStorage persistence
- **D-32:** `</` escaping in data island JSON
- **D-42:** eta 4.6 templating engine
- **D-49:** XSS adversarial fixture test protocol