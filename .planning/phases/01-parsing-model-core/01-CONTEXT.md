# Phase 1: Parsing & Model Core - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Read a WhatsApp "Export chat" ZIP (with media) via **streaming** extraction and
produce a **normalized, locale-tolerant message model**, then persist that model
as the **CSV source-of-truth**. The CSV is the foundation every downstream phase
(Phase 2 render, Phase 3 media, Phase 4 CLI) consumes — JSON/MD/HTML are all
*derived* from it. This phase owns PARSE-01..07 and the CSV emit/merge behavior.

</domain>

<decisions>
## Implementation Decisions

### Locale & Timestamp Detection
- **D-01:** Ambiguous day/month order (e.g. `01/02`) with no override → **best-effort**: pick the order consistent with the majority of dates in the file; `--day-first` / `--month-first` override. — *Reversibility: reversible*
- **D-02:** 12h vs 24h → **detect per-file**: if any `AM`/`PM` token appears, treat all times as 12h; otherwise 24h. — *Reversibility: reversible*
- **D-03:** Format variants → support **both** iOS (`[DD/MM/YYYY, HH:MM:SS]`) and Android (`DD/MM/YYYY, HH:MM:SS`) styles, auto-detected **per line**; accept `.` / `-` / `/` separators and optional seconds. — *Reversibility: reversible*
- **D-04:** A line matches the timestamp pattern but the date fails to parse → treat the line as a **continuation** of the previous message (no new message started). — *Reversibility: reversible*
- **D-05:** 2-digit year → **sliding window**: `yy <= (currentYear-2000+1)` → `2000+yy`, else `1900+yy`. — *Reversibility: reversible*
- **D-06:** Timezone → store **local wall-clock, no timezone** (as exported). — *Reversibility: one-way* — changes the persisted time contract; later conversion would need a migration/flag.
- **D-07:** Detection transparency → `--verbose` reports detected format, locale guess, and applied overrides. Off by default. — *Reversibility: reversible*
- **D-08:** Out-of-range date (before 2009 or beyond next year) → **sanity-window guard**: treat as continuation of previous message + warn in verbose. — *Reversibility: reversible*
- **D-09:** Timestamp/sender separator → **auto-detect**: try ` - ` first, fall back to a single space, then expect `Name:`. — *Reversibility: reversible*
- **D-10:** Preamble → scan forward to the **first line matching a timestamp pattern**; lines before it are export preamble (e.g. "Messages and calls are end-to-end encrypted"), not messages. — *Reversibility: reversible*
- **D-11:** System events (timestamped line with no `Name:`) → classified as **type=system**, full line as body. Keeps them in the timeline, not dropped. — *Reversibility: reversible*
- **D-12:** **Strip leading BOM / LRM / RLM / zero-width chars** before timestamp detection. Real pt-BR exports embed `U+200E` immediately before `[` (e.g. `‎[23/07/2026, 12:41:48]`); without stripping, those messages are missed. — *Reversibility: reversible*

### CSV as Source of Truth (new architectural decision)
- **D-13:** **CSV is the canonical source of truth.** The parse flow emits a normalized CSV; JSON (OUT-01), Markdown, and HTML are all **derived from the CSV**, not from a separate in-memory dump. JSON is a downstream output, not the primary parse product. — *Reversibility: one-way* — reshapes the whole pipeline contract (parse → CSV → derive everything).
- **D-14:** CSV columns: **`timestamp_iso, type, author, text, media`**. Media filename lives in its own column; `text` holds the message body. — *Reversibility: costly* — renderers and JSON derive from these columns.
- **D-15:** `type` values = **`text, photo, video, sticker, document, system, deleted, omitted`** (8 granular types). Media kind is encoded directly in `type`; the `media` column carries the filename. — *Reversibility: costly*
- **D-16:** **Incremental append**: a new WhatsApp export can be merged into the existing CSV. Dedupe key = **`(timestamp_iso, author, text, media)`** — a row is a duplicate only if all four match (handles same-second collisions because body/media differ). No duplicates added. — *Reversibility: reversible*
- **D-17:** After every append/merge the CSV is kept **ordered by `timestamp_iso` ascending** (lexicographic ISO sort == chronological). — *Reversibility: reversible*
- **D-18:** `timestamp_iso` format = **ISO 8601 local, no timezone**: `2026-07-23T09:47:18` (seconds preserved). — *Reversibility: costly* — matches D-06.
- **D-19:** CSV encoding = **UTF-8, no BOM**. — *Reversibility: reversible*

### The agent's Discretion
- Internal in-memory model shape, streaming pipeline wiring (fflate `Unzip` → readline), and date construction library choice are left to the planner/executor, bounded by the decisions above and the STACK research in AGENTS.md.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Roadmap
- `.planning/REQUIREMENTS.md` — PARSE-01..07 (this phase) and OUT-01 (now derived from CSV), plus MEDIA-01..04 / CLI-01..03 context
- `.planning/ROADMAP.md` — Phase 1 "Parsing & Model Core" goal, success criteria, requirements PARSE-01..07
- `.planning/PROJECT.md` — Context (locale-dependent format is the central hard problem), Constraints (streaming, TS/Node, portability)

### Real sample data (ground-truth format reference)
- `data/WhatsApp Chat - Plataforma WK/_chat.txt` — pt-BR reference: bracketed `DD/MM/YYYY, HH:MM:SS` 24h, `U+200E` prefix before `[`, `<attached: FILENAME>` media, system events, same-second multi-attachment (lines 37–38)
- `data/WhatsApp Chat - Notas pessoais/_chat.txt` — second real sample export
- `data/WhatsApp Chat - Plataforma WK/` and `data/WhatsApp Chat - Notas pessoais/` — extracted media folders (stickers `.webp`, photos `.jpg`, video `.mp4`, documents `.pdf`) for reconciliation testing

### Stack / technical guidance
- `AGENTS.md` (STACK.md research) — fflate streaming `Unzip` (memory-safe), `node:readline` line streaming, date-fns for construction/formatting

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project (no `src/`, no `package.json` yet).

### Established Patterns
- None yet. The streaming constraint (no full-archive buffering) and TS/Node ESM choice are fixed by PROJECT.md Constraints and AGENTS.md STACK.

### Integration Points
- Parser output writes `${out}/<chat>/messages.csv` (source of truth); Phase 2 renderers and OUT-01 JSON read this file.
- Media reconciliation (Phase 3) later matches `media` column filenames against the extracted media folder.

</code_context>

<specifics>
## Specific Ideas

- Real `_chat.txt` media appears as `<attached: 00003010-STICKER-2026-07-23-12-41-49.webp>` on its own line, often following an **empty-body** timestamped line (e.g. line 36 empty body, line 37 the attachment). The parser must attach media to the preceding empty-body message, not create a phantom message.
- Same-second multiple attachments occur (lines 37–38 share `23:31:29`) — dedupe by full key, not timestamp alone.
- Senders may include `~ ` prefixes and phone numbers (`‪+55 47 99951‑9144‬`) — the `author` column should preserve the raw sender string; normalization/display is a later concern.
- Chats contain plaintext secrets (e.g. `Senha: TIMEWK2026`) — noted; redaction is **out of scope** for v1.

</specifics>

<deferred>
## Deferred Ideas

- None beyond the architectural CSV shift above (which is in-scope for Phase 1 as the parse output contract). Redaction of sensitive content deferred to a later differentiator.

</deferred>

---

*Phase: 1-Parsing & Model Core*
*Context gathered: 2026-08-21*
