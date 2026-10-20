# Phase 2: Multi-Format Rendering - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Derive three synchronized outputs from the CSV source-of-truth in a single CLI run: structured JSON, chronological Markdown, and a WhatsApp-like HTML viewer. HTML is a **data-driven app**: an eta-rendered shell with an embedded JSON data island and client-side JS that populates the transcript dynamically (browse + filter). All content is XSS-escaped (OUT-05). Media renders as labeled placeholders — real media extraction is Phase 3.

</domain>

<decisions>
## Implementation Decisions

### Renderer Input & Pipeline
- **D-20:** Renderers read `messages.csv` from disk each run — true to D-13. Enables re-rendering old backups without the original ZIP. Single CLI run = parse → csv → render pipeline; if `messages.csv` doesn't exist yet it is produced first in the same run.

### File Layout & CLI Behavior
- **D-21:** All outputs live side by side: `output/<chat-slug>/messages.{csv,json,md,html}` — one folder per chat (matches Phase 1 slugged layout).
- **D-22:** One run ALWAYS emits all four formats — no format-selection flags. Matches OUT-04 ("single run") directly and guarantees outputs never drift out of sync.

### JSON Output
- **D-23:** Envelope structure: metadata at top (chat name, message count, date range, export source) + `messages` array.
- **D-24:** Field names camelCase (`timestampIso`, `type`, `author`, `text`, `media`) — idiomatic TypeScript for future web reuse (transformation from CSV snake_case is explicit at the boundary). — **Reversibility:** costly — JSON field names become the contract for the future web frontend consumers.
- **D-25:** Per-message precomputed fields: `day` (`yyyy-mm-dd`) and `time` (`HH:mm:ss`) so renderers/consumers skip date parsing.
- **D-26:** JSON is minified (smallest file) — human readability is served by MD/HTML.

### HTML Architecture (data-driven app)
- **D-27:** HTML = eta-rendered static shell (head, CSS, toolbar skeleton, data island) + inline `<script type="application/json" id="chat-data">` data island + client-side vanilla JS that builds the transcript DOM dynamically. Enables browsing/filtering without a server. — **Reversibility:** one-way — defines how the HTML output is consumed; changing later breaks anyone relying on the embedded-data format.
- **D-28:** The separate `messages.json` still ships alongside; the island is generated from the same object.
- **LANDMINE:** When embedding JSON inside `<script>`, escape `</` sequences (e.g. `<\/`) in the serialized string or message text containing `</script>` breaks the document.

### Client-Side Viewer
- **D-29:** Filtering/browsing: free-text search across message text + author, plus a sender dropdown filter. (Full date-range/type filters deferred.)
- **D-30:** Message rendering uses DOM APIs only (`createElement`/`textContent`) — injection-proof by construction; never `innerHTML` with untrusted strings. Satisfies OUT-05 client-side alongside eta's server-side escaping.

### HTML Appearance
- **D-31:** Theme: light AND dark with a small toggle button, persisted via localStorage (~10 lines inline vanilla JS before `</body>`).
- **D-32:** Bubble colors hybrid: WhatsApp authentic green/white bubbles (`#d9fdd3`/`#005c4b` outgoing; white/dark-gray incoming) PLUS deterministic per-sender accent color on sender name text (hash of author → hue).
- **D-33:** Fonts: system-ui stack (Segoe UI/Helvetica/Roboto) — zero font loading, offline-safe.
- **D-34:** Layout: centered chat column, max-width ~768px on neutral page background.
- **D-35:** Day dividers: WhatsApp-style centered pill chip, locale-aware pt-BR dates via `Intl`.
- **D-36:** System/deleted/omitted messages: centered gray pill, visually distinct from user bubbles.
- **D-37:** Consecutive same-sender messages within ~5 minutes group into bubble clusters (sender shown once, like WhatsApp).
- **D-38:** Avatars: small circular initials chips next to incoming bubbles, colored by per-sender accent.
- **D-39:** Print stylesheet (@media print: white bg, hide toggle) + hover shows exact timestamp on bubbles.
- **D-40:** Media renders as styled placeholder boxes (icon + filename) — Phase 3 replaces with real files.
- **D-41:** Single self-contained HTML file regardless of chat size — no pagination.

### Templating & Assets
- **D-42:** Template engine: **eta 4.6** (stack research rec: 3KB, auto-escape default, TS-native). Renders the shell only; bubbles/day-pills are built by JS.
- **D-43:** CSS ships as a single inline `<style>` block in the head — file stays fully self-contained (PROJECT constraint: opens standalone, no server).
- **D-44:** Templates live in `src/render/templates/`: page shell partial (+ room for day-group/bubble partials if needed).

### Markdown Style
- **D-45:** Day sections: `## <localized full date>` then per message `**Sender** · HH:mm — text`.
- **D-46:** Media as labeled link `[📷 photo: FILENAME]` — never broken-image embeds before Phase 3.
- **D-47:** System/deleted/omitted as italic line `*text*`.

### Verbose Reporting
- **D-48:** With `--verbose`: list each generated file with size + message/day/sender counts. Off by default (consistent with D-07).

### XSS Verification (OUT-05)
- **D-49:** Adversarial fixture test: messages containing `<script>`, `<img onerror=…>`, `javascript:` URLs must render inert in HTML output (both eta path and JS-rendered path).

### Agent's Discretion
- Exact CSS values (spacing, pill sizes, accent-hue hash algorithm), search UX micro-interactions, envelope key names beyond those specified, internal module split of `src/render/`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Contracts
- `.planning/phases/01-parsing-model-core/01-CONTEXT.md` — D-13/D-14/D-15/D-18: CSV source-of-truth, column schema, 8 message types, ISO timestamp contract. Renderers MUST consume these exactly.
- `.planning/REQUIREMENTS.md` — OUT-01..OUT-05 definitions (this phase's acceptance).

### Stack Guidance
- `AGENTS.md` — Tech stack constraints (TypeScript/Node ESM; core reusable in web frontend). STACK research recommends eta 4.6 for templating (confirmed in D-42).

### Ground Truth
- `data/WhatsApp Chat - Plataforma WK/_chat.txt` — real pt-BR sample incl. bidi authors, emoji, omitted markers.
- `data/WhatsApp Chat - Notas pessoais/_chat.txt` — second sample with deleted/document-omitted cases.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/csv.ts` — `readCsv()` parses messages.csv back into `Message[]`; renderers consume this directly.
- `src/parse/types.ts` — `Message` interface + 8-value `MessageType` union; the render-domain input type.
- `src/model.ts` — `runParser()` orchestrator; rendering hooks in after CSV write; `verboseReport()` pattern exists.
- `src/index.ts` — commander CLI with `--out/--day-first/--month-first/--verbose`; new flags (if any) extend this.

### Established Patterns
- Slugged output folders via `slugifyChatName` (`output/<slug>/messages.csv`) — new files join the same folder (D-21).
- Atomic per-task commits; tests colocated in `test/*.test.ts` run via `node --test`.
- Real-sample integration tests assert known lines from both fixtures.

### Integration Points
- `runParser()` currently ends at `mergeCsv()` — render step chains after it, reading the CSV back from disk (D-20).
- Success message prints resolved output path — extend to reflect all four files.

</code_context>

<specifics>
## Specific Ideas

- User explicitly framed the HTML as "a JavaScript function that reads the JSON as a message repository and populates the tags dynamically, for browsing and filtering" — the data-driven app architecture (D-27/D-29/D-30) captures this.
- "There's no problem having HTML+JSON for browser visualization" — shipping both is intended, not redundant.

</specifics>

<deferred>
## Deferred Ideas

- Full date-range pickers and type-based filters (media-only, deleted-only views) in the HTML viewer — candidate enhancement after basic search+sender filter proves out.
- Per-sender stats section in the JSON envelope.

None of these block Phase 2 scope.

</deferred>

---

*Phase: 2-multi-format-rendering*
*Context gathered: 2026-08-21*
