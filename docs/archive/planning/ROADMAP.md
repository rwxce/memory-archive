# Roadmap: WhatsApp Chat Backup

## Overview

This roadmap delivers a TypeScript/Node CLI that turns a WhatsApp "Export chat" ZIP (`_chat.txt` + media folders) into a self-contained, no-server backup of a single conversation — emitting three synchronized outputs (Markdown, WhatsApp-like HTML, structured JSON) with media reconciled and optionally inlined. The three phases proceed in dependency order: first the parsing core that produces an accurate, locale-tolerant normalized model; then the three-output renderers; then media reconciliation and inline embedding. Together they satisfy the v1 requirements and realize the core value — opening a full chat years later, text and media together, without WhatsApp, a phone, or an account.

## Phases

### Phase 1: Parsing & Model Core

**Goal:** The CLI reads a WhatsApp export ZIP and produces a normalized, accurate in-memory message model regardless of locale, encoding, or file-system quirks — the foundation every other phase consumes.
**Mode:** mvp
**Success Criteria**:

1. Running the tool with a ZIP path argument yields a parsed model with correct senders, timestamps, bodies, and media references for a real pt-BR sample chat.
2. A locale-tolerant parser detects day/month order and 12h/24h format from header lines without manual configuration (with `--day-first`/`--month-first` override available).
3. Multi-line messages are reconstructed as single messages; UTF-8 content (emoji, non-Latin scripts) is preserved with BOM/bidi handling; macOS `._*` AppleDouble artifacts are ignored and not mistaken for messages.
4. Extraction and parsing stream line-by-line so memory stays constant (no full-archive buffering) even on a large chat with video media.

**Requirements:** PARSE-01, PARSE-02, PARSE-03, PARSE-04, PARSE-05, PARSE-06, PARSE-07
**Plans:** 6/6 plans executed ✓ Verified 2026-08-21 (VERIFICATION.md)

Plans:

- [x] 01-07-PLAN.md

- [x] 01-05-PLAN.md

- [x] 01-04-PLAN.md

- [x] 01-01-PLAN.md — Streaming extract + parse a real export into CSV (tracer): bootstrap (ESM/tsconfig/deps), fflate Unzip (AppleDouble skip), timestamp/message parsing, RFC-4180 UTF-8-no-BOM CSV write, commander CLI
- [x] 01-02-PLAN.md — Harden locale detection (day/month majority vote, 12h/24h, separators, 2-digit year, sanity window, invalid→continuation) + omitted/deleted/system type classification + `--verbose`
- [x] 01-03-PLAN.md — CSV incremental append/dedupe/stable sort (D-16/D-17) + full end-to-end verification on both real samples

### Phase 2: Multi-Format Rendering

**Goal:** A parsed chat is rendered to three synchronized, portable outputs (JSON, Markdown, HTML) in a single run, with all content escaped against XSS.
**Mode:** mvp
**Success Criteria**:

1. A single run emits JSON, Markdown, and HTML files that together represent the full parsed chat.
2. The HTML renders messages as WhatsApp-like bubbles with deterministic per-sender colors, timestamps, and per-day dividers.
3. All chat content (sender, body, URLs, filenames) is HTML-escaped so injected scripts do not execute when the file is opened in a browser; Markdown output is likewise treated as unsafe.
4. `<Media omitted>` and deleted-message lines appear as visible placeholders in all three outputs.

**Requirements:** OUT-01, OUT-02, OUT-03, OUT-04, OUT-05
**Plans:** 1/1 plans executed ✓ 2026-08-22 (02-01-SUMMARY.md)

Plans:

- [x] 02-01-PLAN.md — Multi-format rendering pipeline: JSON envelope, Markdown log, WhatsApp-like HTML viewer (data island + client JS), per-sender color, XSS-safe across all outputs

### Phase 3: Media Reconciliation & Embedding

**Goal:** Media referenced in the transcript is located, copied, and optionally inlined so the backup is complete and self-contained.
**Mode:** mvp
**Success Criteria**:

1. Media filenames from `_chat.txt` resolve to actual files in sibling media folders (case-insensitive, ignoring `(1)` and dash/space variance) and are copied into the output folder referenced by relative path.
2. A `--inline` flag embeds resolved media as base64 into a single self-contained HTML file, respecting a per-file size cap (skipping oversized/video by default).
3. Unresolved media references are reported without crashing the run, and the distinction between intentional `<Media omitted>` and missing-but-expected files is preserved.
4. `<Media omitted>` and deleted-message placeholders remain visible in outputs alongside any reconciled media.

**Requirements:** MEDIA-01, MEDIA-02, MEDIA-03, MEDIA-04
**Plans:** 1/1 plans executed ✓ 2026-08-22 (03-01-SUMMARY.md)

Plans:

- [x] 03-01-PLAN.md — Media reconciliation & embedding: enumerate+match+copy media from ZIP (streaming), disk-resident media map, JSON `mediaPath` + MD links + HTML `<img>/<video>/<a>`, `--inline` base64 with size cap, placeholder preservation for omitted/deleted/missing

## Phase Summary

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Parsing & Model Core | Read a WhatsApp export ZIP into a normalized, locale-tolerant message model | PARSE-01, PARSE-02, PARSE-03, PARSE-04, PARSE-05, PARSE-06, PARSE-07 | 4 |
| 2 | Multi-Format Rendering | Emit JSON + Markdown + WhatsApp-like HTML in one XSS-safe run | OUT-01, OUT-02, OUT-03, OUT-04, OUT-05 | 4 |
| 3 | Media Reconciliation & Embedding | Locate, copy, and optionally inline media; preserve placeholders | MEDIA-01, MEDIA-02, MEDIA-03, MEDIA-04 | 4 (1/1 plans) |
