# Project Research Summary

**Project:** WhatsApp Chat Backup (wa-backup)
**Domain:** CLI tool that converts a WhatsApp "Export chat" ZIP (`_chat.txt` + media folders) into Markdown + HTML + JSON, with media reconciliation. Parsing core must be importable by a future web frontend.
**Researched:** 2026-08-21
**Confidence:** HIGH for stack/architecture/feature-structure; MEDIUM for locale date detection (hardest problem, needs a research phase of its own)

## Executive Summary

`wa-backup` is a **TypeScript/Node CLI** that turns a WhatsApp email/export ZIP into portable, no-server Markdown + WhatsApp-like HTML + structured JSON. The ecosystem is mature but fragmented — most tools parse the *database* or *upload to the cloud*; none popular tool cleanly does all three outputs locally in one pass. That combination, plus a future-web-reusable parser core, is the deliberate wedge. The project scope is intentionally lean: it targets only the **plain-text export ZIP**, not the encrypted Google-Drive/Crypt databases (a far larger, separate problem).

The recommended architecture is **Ports-and-Adapters (Hexagonal)** with a pure, platform-agnostic `core/` at the center and thin Node adapters (`fflate`, `node:readline`, `fs`) around it. This split is what makes the web-reuse goal free: `core/` imports zero Node APIs, so v2 swaps three driven adapters and reuses the parser, model, and renderers unchanged. The recommended stack (Commander, fflate, date-fns, eta, custom Markdown writer) was filtered through "does it also run in the browser?" so the same core loads in Node and a future bundler.

The single dominant risk is **locale-dependent timestamp parsing** — the export format changes by device, region, and language, and a single-format parser silently mis-dates or drops messages. This must be treated as a dedicated deep-dive phase (format-detection registry + `--day-first`/`--month-first` override), exactly as both STACK.md and ARCHITECTURE.md flag. The second risk class is **security** (XSS from chat content in HTML/MD, and path traversal on media write) — both are prevention-gated at specific components, not left to cross-cutting luck.

## Key Findings

### Recommended Stack

A TypeScript ESM Node CLI. Commander for argument parsing, fflate streaming unzip (the only reviewed ZIP lib that also runs in the browser — directly serving the reuse requirement), `node:readline` for constant-memory line streaming, eta for WhatsApp-like static HTML, a hand-rolled Markdown writer (no dependency), and date-fns + a custom multi-locale timestamp registry for the central hard problem. tsx to run, tsup to build the distributable bin.

**Core technologies:**
- **TypeScript 5.x + Node ≥ 22.12 (ESM, `type: module`)** — type safety for the message model and clean web reuse via the same core.
- **commander 15** — zero-dependency, TS-native arg parsing; ~25ms startup, ideal for a fixed-option transform CLI.
- **fflate 0.8.3** — tiny streaming `Unzip` that runs in Node AND browser; memory-safe on video-heavy zips (must use the streaming API, not the buffer API).
- **node:readline (built-in)** — one line at a time, constant memory regardless of chat size; the parser accumulates continuation lines.
- **eta 4.6** — 3KB embedded-JS HTML templating, browser-capable, XSS-safe escaping by default; `@kitajs/html` is the JSX alternative.
- **date-fns 4 + custom `formats.ts` registry** — library does NOT auto-detect WhatsApp locale format; the detection logic is custom work, not importable.
- **Custom `MarkdownWriter` (no dep)** — a chat log is a linear sequence; a hand-rolled writer with one escaper beats a heavy AST lib for v1.
- **tsx 4 / tsup 8 / picocolors 1** — standard 2025 TS-CLI toolchain (run, build bin, terminal styling).

### Expected Features

**Must have (table stakes):**
- **Locale-tolerant date/time parsing** — format varies by device/region/language; single-format parsers silently mis-date. Central hard problem.
- **Multi-line message continuation** — only the first line carries a timestamp; continuation lines must append to the prior message.
- **Three outputs in one pass (Markdown + HTML + JSON)** — editing, viewing, and structured reuse.
- **Media reconciliation** — map `<attached>` / bare names to sibling-folder files with smart resolution (case-insensitive, strip `(1)`, handle embedded document names).
- **WhatsApp-like HTML rendering (bubbles, per-sender color, day grouping)** — faithful, readable backup.
- **Preserve `<Media omitted>` & deleted messages as placeholders** — full record including gaps.
- **Streaming / line-by-line parse** — memory-safe on large chats; project constraint.
- **UTF-8 / encoding robustness + portable no-server output** — opens via `file://` years later.

**Should have (competitive):**
- **Optional base64 inline → single self-contained HTML** — one file opens anywhere (cap per-file size, skip video).
- **Smart media filename resolution + per-day grouping + linkify URLs** — cheap wins that differentiate from naive parsers.
- **Privacy-local, no upload, no telemetry** — a stated value, emphasized proudly.

**Defer (v2+):**
- Search/filter, participant aggregation, batch multiple zips, PDF/CSV/Excel output, output encryption, web UI, sticker/GIF mapping — all explicitly out of v1 scope per anti-features.

### Architecture Approach

Ports-and-Adapters (Hexagonal): a pure `src/core/**` (model, parser, renderers, use-case) that imports only its own `ports/` interfaces and browser-safe libs, wrapped by thin Node adapters (`fflate-archive-reader`, `readline-line-source`, `fs-output-sink`) and a single `composition/container.ts` that is the only file seeing both sides. The parser core (`parseChat(lines: AsyncIterable<string>): AsyncIterable<ChatEvent>`) depends solely on `AsyncIterable<string>`, so it can be unit-tested with plain strings and built in parallel with archive extraction. Web v2 is a port swap (browser twins of the three driven adapters + a second container), not a rewrite.

**Major components:**
1. `core/parser/*` — `parse-chat.ts` (stateful async generator), `formats.ts` (locale registry + `detectFormat`), `classify.ts`, `media-ref.ts`. The reusable crux.
2. `core/ports/*` — `ChatArchiveReader`, `LineSource` (AsyncIterable<string>), `OutputSink`; core-owned interfaces implemented by adapters.
3. `core/render/*` — `escape.ts` (single XSS gate), `to-json`, `to-markdown`, `to-html`; all consume the same `NormalizedMessage` model.
4. `adapters/node/*` + `composition/container.ts` — the only place platform I/O and wiring live (v1).

### Critical Pitfalls

1. **C1 — Locale-dependent date/time formats** — per-file format auto-detection over a sample of header lines; support day/month ambiguity with `--day-first`/`--month-first` override; normalize non-Western digits; strip BOM/bidi marks; never invent a UTC offset. *Owning component: `parser/formats.ts`.*
2. **C5 — XSS from chat content** — escape ALL fields (sender, body, filename, URL) at render time; allowlist `http/https/mailto` schemes; treat MD output as unsafe too. *Owning component: `render/escape.ts` (security gate).*
3. **C6 — Path traversal on media write** — reduce every media filename to a safe basename, allowlist chars, then assert the resolved path stays inside the media dir. *Owning component: `adapters/node/fs-output-sink.ts`.*
4. **C2/C3 — Multi-line split & false-positive headers** — stateful line reader; require the sender delimiter (`] ` / ` - `), not just a date token; ignore macOS `._*` AppleDouble files. *Owning component: `parser/parse-chat.ts` + `classify.ts`.*
5. **C4 — Media filename mismatch & missing files** — basename, case-insensitive, strip `(1)`, tolerate iOS `<name>`/Android wrappers; emit an unresolved-media report; distinguish intentional omission from missing-but-expected. *Owning component: `parser/media-ref.ts` + `fs-output-sink.ts`.*

## Implications for Roadmap

The phase structure below is lifted 1:1 from ARCHITECTURE.md's build order (which maps onto PITFALLS' Phase-Specific Warnings). It is dependency-driven: the parser core is highest-risk and I/O-free, so it leads; archive extraction is parallelizable with it; renderers are mechanical once the model is fixed.

### Phase 1: Model + Parser Core
**Rationale:** Highest-risk, pure, zero-I/O piece; everything else renders its output. Can be unit-tested with plain strings (US/DE/TR/AR/pt-BR samples) before any file I/O exists.
**Delivers:** `model/*`, `parser/parse-chat.ts`, `parser/classify.ts`, `parser/media-ref.ts`, `ports/line-source.ts`, `adapters/node/readline-line-source.ts`.
**Addresses:** Multi-line continuation, UTF-8 robustness, classify system/omitted/deleted (table stakes).
**Avoids:** C2, C3, M1, M2, M3, M5, N2, N3, N4.

### Phase 2: Locale Detection
**Rationale:** The detection sub-problem is separable but blocks *trustworthy* output; ship it as its own phase so the format registry gets dedicated attention.
**Delivers:** `parser/formats.ts` (`detectFormat`) + `--day-first`/`--month-first` override + unresolved-format report.
**Uses:** date-fns 4.
**Implements:** C1, N2 — the flagged research-heavy area.

### Phase 3: Archive Extraction (parallelizable with P1)
**Rationale:** The parser's only I/O contract is `AsyncIterable<string>`, so the streaming `Unzip` adapter can be built in parallel with the parser; end-to-end wiring needs both.
**Delivers:** `ports/archive-reader.ts`, `adapters/node/fflate-archive-reader.ts` (streaming `Unzip`, NOT buffer API; ignore `._*`).
**Uses:** fflate 0.8.3.
**Avoids:** M4 (memory), C3 (`._*` ignore).

### Phase 4: Media Reconciliation + Safe Write
**Rationale:** Depends on the parser's `MediaRef` and the archive reader; resolves names and writes files safely.
**Delivers:** wired `media-ref.ts`, `adapters/node/fs-output-sink.ts` (safe basename), unresolved-media report.
**Addresses:** Media reconciliation (table stakes).
**Avoids:** C4, C6 — real sample showed documents embed their *original* filename in the body, not just WA prefixes.

### Phase 5: Renderers
**Rationale:** Low-risk once `NormalizedMessage` is fixed; JSON proves the model, MD/HTML are mechanical.
**Delivers:** `render/escape.ts`, `to-json.ts`, `to-markdown.ts`, `to-html.ts` (eta + bubbles + per-sender color + day grouping).
**Addresses:** Three outputs, WhatsApp-like HTML, placeholders.
**Avoids:** C5, M2, M5 (RTL `dir=auto`).

### Phase 6: CLI Wiring + Flags
**Rationale:** Pure wiring — trivial once the use-case and adapters exist.
**Delivers:** `cli/cli.ts`, `cli/options.ts`, `composition/container.ts`.
**Uses:** commander 15, picocolors 1.
**Implements:** integration of `<zip>`/`--out`/`--inline-media`/`--day-first`.

### Phase 7: Inline Media (HTML)
**Rationale:** Differentiator, low cost once media is resolved; single self-contained HTML for archiving/sharing.
**Delivers:** `--inline-media` base64-embed, `--embed-max-mb` cap, skip video by default.
**Avoids:** C6 (still safe basename when copying), M4.

### Phase 8 (v2): Web Adapters — deferred
**Rationale:** Swap the three driven adapters (fflate→DecompressionStream, readline→TextDecoderStream, fs→Blob/download) + a browser container; no core changes. Out of v1 scope.

### Phase Ordering Rationale

- **Parser-first** because it owns the riskiest pitfalls (C1, C2, C3, M1–M5, N2–N4) and is I/O-free — it can be validated before any archive code exists.
- **Archive extraction parallelizes with the parser** because the contract is just `AsyncIterable<string>`; two parallel sub-agents can build P1 and P3 simultaneously.
- **Renderers come after the model stabilizes** — JSON validates the shape, MD/HTML are mechanical; the `escape.ts` gate is mandatory before HTML ships.
- **CLI is last wiring** — lowest risk, depends on everything.
- The Hexagonal split means every pitfall maps to a *located* component, so none is left to cross-cutting luck.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Locale Detection):** the hardest, MEDIUM-confidence area; needs a dedicated format-registry design pass (non-Western digits, localized AM/PM, RTL, 2-vs-4-digit years). Recommend `/gsd-plan-phase --research-phase 2`.
- **Phase 4 (Media Reconciliation):** real-sample edge cases (documents embed original filename; nested ZIP; `._*` files) warrant a design spike before coding.

Phases with standard patterns (skip research-phase):
- **Phase 1, 3, 5, 6:** well-documented hexagonal/Node patterns; the stack and component boundaries are confirmed by existing parsers and official docs. Build directly.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Unanimous, version-verified via `npm view`; browser-reuse picks confirmed. |
| Features | MEDIUM | Format/structure facts corroborated across ≥5 independent tools; tool-specific feature tiers are indicative (verify at build). |
| Architecture | HIGH | Hexagonal-in-Node validated by nazarboyko write-up + readline async-iterator docs + real-sample inspection. |
| Pitfalls | MEDIUM–HIGH | Parsing facts corroborated across 3+ parsers; security facts from published CVE advisories. |

**Overall confidence:** HIGH (structure/stack/architecture), with one MEDIUM pocket (locale date detection) that is explicitly flagged for a research phase.

### Gaps to Address

- **Locale detection breadth:** the `formats.ts` registry must be validated against real US/DE/TR/AR/pt-BR/CJK samples; treat registry coverage as a planning deliverable for Phase 2, not assumed.
- **Real-sample coverage:** only one export (`Notas pessoais.zip`, pt-BR) was inspected first-hand. Add a US, a German/Android (`.` separators), and an Arabic/Persian (non-Western digits) sample to the Phase 1–2 test fixtures before claiming broad locale support.
- **iPhone ~40k truncation:** detection/warning is a Phase 3/5 concern; confirm how to surface "export looks truncated" without false alarms.
- **Nested ZIP handling:** port must not preclude it, but v1.1 only; confirm behavior (flag vs skip) during Phase 3 planning.

## Sources

### Primary (HIGH confidence)
- Hexagonal / Ports-and-Adapters in Node.js (nazarboyko.com, 2024) — validates `core/`/`adapters/`/`composition/` split.
- Node.js `readline` docs (nodejs.org, v26) — `createInterface` + `for await` yields one line, constant memory; basis for `LineSource` port.
- Isomorphic line-reader packages `readlineiter`/`fetchline` (npm) — prove `AsyncIterable<string>` works in Node/Deno/browser.
- `npm view <pkg> version` for every listed package (2026-08-21) — authoritative current versions.
- First-hand inspection of `WhatsApp Chat - Notas pessoais.zip` — confirmed pt-BR bracket format, bidi marks, deleted/omitted markers, embedded doc filename, nested ZIP.

### Secondary (MEDIUM confidence)
- whatsapp-chat-parser (npm, TS), whatsapp-export-md (PyPI), whatsapp-chat-to-pdf (PyPI), WhatsApp-Chat-Exporter (GitHub) — feature/format landscape and known failure modes.
- whatsapp-export-parser (NeverFar) — format reference, non-Western digits, bidi/BOM stripping, system-message handling.
- whatstk docs — header format codes per device/OS/language.
- CVE advisories: open-webui (GHSA-9f4f-jv96 / GHSA-pwxh-7358 / GHSA-hcwp-82g6), Orbis chat-widget XSS via `sender_name`, Discourse CVE-2024-52794 (image filename), nanobot GHSA-3f63-vcp3-hvqr (path traversal) — security facts for C5/C6.

---

*Research completed: 2026-08-21*
*Ready for roadmap: yes*
