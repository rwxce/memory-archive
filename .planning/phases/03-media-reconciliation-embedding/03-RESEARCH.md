# Phase 3 Research: Media Reconciliation & Embedding

**Phase:** 03 — media-reconciliation-embedding
**Date:** 2026-08-22
**Audience:** Planner + executor. Documents the real WhatsApp export media
layout observed in the project samples and the integration points in the
current codebase (read first: `src/extract.ts`, `src/model.ts`,
`src/render/{json,md,html}.ts`, `src/parse/types.ts`, `src/parse/message.ts`).

## Observed export layout (verified against `data/WhatsApp Chat - Notas pessoais.zip`)

- **Structure:** `_chat.txt` sits at the archive **root**; media files are
  **flat at root** too (e.g. `IMG-20190424-WA0003.jpg`, `PTT-20190730-WA0001.opus`,
  `STK-20201022-WA0015.webp`, `VIDEO-*.mp4`, `*.pdf`). No `media/` subfolder.
- **References:** `_chat.txt` references each file with `<attached: FILENAME>`
  where `FILENAME` matches an actual entry **by basename, case-insensitively**.
- **Non-media noise:** exports can embed unrelated app payloads
  (`EPUB/media`, `META-INF`, `assets/fonts`, `lib/arm64-v8a`, `res/raw`, and an
  attached inner `.zip` like `00000068-Conversa do WhatsApp com Notas pessoais.zip`).
  These are ONLY pulled in if a `<attached:>` line names them — we never copy
  unreferenced entries (memory + correctness).
- **AppleDouble:** `__MACOSX/` and `._*` companions exist on macOS zips — already
  skipped by `extract.ts` (`isAppleDouble`). Keep that guard.

### Decision D-M1 — reconcile by basename, not full path
Match each `<attached: REF>` against zip entry **basenames** (ignore any folder
prefix). The current `extractChatTxt` already derives a `base = name.split('/').pop()`
for the AppleDouble check — reuse that normalization.

### Decision D-M2 — tolerant name matching (MEDIA-01)
Canonicalize both sides: `toLowerCase()`, strip a trailing parenthesized
duplicate marker `\(\d+\)` (e.g. `photo (1).jpg` → `photo.jpg`), collapse
runs of whitespace and `-`/underscore to nothing (`IMG 20190424 WA0003` ==
`IMG-20190424-WA0003`). Keep digits intact. This satisfies "case-insensitive,
ignoring `(1)`, dash/space variance" without over-collapsing real filenames.

### Decision D-M3 — streaming copy, never buffer (memory-safety, PARSE-02)
`reconcileMedia(zipPath, dir, refs)` enumerates entry names only (header pass,
no inflate — same pattern as `chatInfoFromZip`), then for each **matched** entry
calls `file.start()` and pipes the per-entry fflate stream straight to
`fs.createWriteStream(path.join(dir, 'media', baseName))`. Unmatched and
AppleDouble entries are never inflated → no full-archive buffering, even for
large videos.

### Decision D-M4 — MIME by extension (no dependency)
No built-in Node mime resolver; a small `.ext → type` map covers
`jpg/jpeg/png/webp/gif → image/…`, `mp4/webm/mov → video/…`,
`mp3/ogg/opus/m4a → audio/…`, `pdf → application/pdf`, else
`application/octet-stream`. Used for inline `data:` URIs and `<video>`/`<img>`
`type` hints.

### Decision D-M5 — disk-resident media map (decouples render from zip)
After copy, renderers resolve media **from the `media/` folder on disk**, not
the zip. `buildMediaMap(dir, messages)` scans `dir/media/*`, normalizes each
filename with the D-M2 rule, and maps each message `media` ref →
`{ relPath: 'media/<file>', mime, inlineable }`. This keeps Phase-2's
"re-render from CSV without the zip" property intact (a prior run already
populated `media/`).

### Decision D-M6 — inline with size cap (MEDIA-03)
New `--inline` flag. When set, HTML embeds resolved media as base64
`data:<mime>;base64,…` **only when** the file is under `INLINE_MAX_BYTES`
(default **8 MiB**) AND not a video. Oversized and video files are **skipped by
default** (requirement wording) and fall back to the relative `media/<file>`
link (which still exists because copy always runs). Inline reads the file from
`media/` on disk — bounded memory (sub-cap files only).

### Decision D-M7 — placeholder vs missing distinction (MEDIA-03 success #3, MEDIA-04)
Three distinct states must remain visually distinguishable:
1. **Intentional `<Media omitted>`** — `type: 'omitted'`, `media === ''` (no ref).
   Keep as-is placeholder. No lookup attempted.
2. **Deleted** — `type: 'deleted'`, `media === ''`. Keep as-is placeholder.
3. **Missing-but-expected** — `media` non-empty but no zip entry / no `media/`
   file resolves. Render the filename in a *placeholder* (not a broken
   `<img>`), and report it in the unresolved count so the run still succeeds.

`reconcileMedia` returns `{ resolved: string[], unresolved: string[] }`; the
CLI reports both counts and never throws on unresolved.

## Integration map (where code changes land)

| Concern | File | Change |
|---|---|---|
| Media copy + reconcile | `src/media.ts` (new) | `reconcileMedia`, `buildMediaMap`, `normalizeMediaName`, `mimeFromExt`, `INLINE_MAX_BYTES`, `isInlineable` |
| Orchestration | `src/model.ts` | `runParser` collects distinct media refs → `reconcileMedia`; extends `renderOutputs(dir, name, { inline })` |
| CLI flag | `src/index.ts` | add `--inline`; thread `opts.inline` |
| JSON | `src/render/json.ts` | add `mediaPath` (relPath or `null`) per message |
| Markdown | `src/render/md.ts` | `[📷 photo: F](media/F)` link when resolved, else `[📷 photo: F]` |
| HTML | `src/render/html.ts` | `<img>/<video>/<a>` when resolved; `data:` URI when inline+inlineable; placeholder when missing/oversized |

## Discretion items (planner decides)
- Exact `INLINE_MAX_BYTES` constant (recommend 8 MiB; expose as a named export for tests).
- Flag name `--inline` (confirm against Phase 4 which owns `--out`; no clash).
- Whether unresolved-media report goes to stderr (verbose-style) — recommend
  stderr so the JSON/MD/HTML artifacts stay clean.

## Verification anchors (real sample)
- Sample: `data/WhatsApp Chat - Notas pessoais.zip` (145 media entries, 17
  distinct `<attached:>` refs: stickers `.webp`, `IMG-*.jpg`, `VIDEO-*.mp4`,
  `PTT-*.opus`, `*.pdf`, and an attached inner `.zip`).
- Output slug: `notas-pessoais` → `output/notas-pessoais/media/`.
- Assertions: `media/` contains the 17 referenced files; `messages.json` has
  `mediaPath` for them; `messages.html` has `<img` for images and `<video` for
  the mp4; `--inline` emits `data:image/…`/`data:application/…` and skips the
  `.mp4`; unresolved count is 0 for this sample.
