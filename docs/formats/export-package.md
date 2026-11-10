# Export package (HTML, JSON, Markdown)

The ZIP behind the export screen for readers other than the viewer. It is an **export**: never
restored from, never the storage format. Code: `lib/exporters/export/*` and
`lib/usecases/export-package.ts` (`exportPackage`). The `viewer` format is the existing package
(`viewer-data.md`); this document covers `html`, `json` and `markdown`.

## Selection

The same `ViewerSelection` as the viewer (`profileIds`, `from`, `to`, `includeMedia`; see
`viewer-data.md`) plus `split`:

- `together` (default): one set of files for the whole selection; a conversation linked to several
  selected profiles appears once.
- `perProfile`: one folder per selected profile, built from that profile alone (so a shared
  conversation appears in each folder) with its own `media/`. Folders follow the profile order of
  the viewer data (name, then id). A single profile with `perProfile` still gets its folder. `viewer`
  ignores `split`.

## Layout

```
<name>.html | <name>.md        one per conversation (html, markdown)
photos-<profile-slug>.html | .md  one per profile with assigned photos (html, markdown)
memory-archive.json            the whole group (json)
media/<sha256>.<ext>           stored entries; absent when includeMedia is false
```

With `perProfile` every path above is prefixed by `<profile-slug>/`.

- `<name>` is `NNN-<slug-of-title>`: `NNN` is the conversation's 1-based position (at least 3 digits)
  in the viewer-data order (first message, then id), so names are unique and ordered. Text files sit
  next to `media/`, so relative links work from any folder.
- Names are built only from fixed words, positions and `slug`: lower-case `[a-z0-9-]`, accents
  folded, at most 40 characters, with a fallback (`chat`, `profile`). A title or profile name never
  contributes a separator, `..`, a drive letter or markup. Equal profile slugs get `-2`, `-3`, ...
- `photos-<slug>`: the slug of the profile name, unique per export (`-2`, `-3`, ...); conversation
  names start with a digit, so they cannot collide. A profile with only photos still exports.
- A profile or conversation with no message in the range gets no files, except `json`, which always
  writes the envelope. If an `html` / `markdown` export would be empty, it fails with
  `ViewerPackageError` `nothing-to-export` instead of an empty ZIP.

## Contents

- **json**: the viewer-data envelope (`format: "memory-archive-viewer"`, `schemaVersion` 1),
  indented, read back by `parseViewerData`. Media paths are relative to the file.
- **html**: one standalone page per conversation from the legacy transcript renderer
  (`legacy/html.ts`): all text escaped, a CSP that allows no network and scripts only by hash, media
  as relative `<img>` / `<video>` / `<audio>` / links, placeholders for files that are not included.
- **markdown**: one file per conversation from the legacy renderer (`legacy/md.ts`): day sections;
  headings, lists, brackets, `*`, `_`, backticks, `<` and `>` in chat text are escaped; the title is
  forced onto one line; link targets are `http(s)` or `media/<name>` only.

- **Assigned photos** (`viewer-data.md`, Photos; same selection rules: media on, date range, undated
  only without a range): `json` has them in the envelope; `html` / `markdown` write the
  per-person photos page (`export/photos.ts`): a grid of `<img>` / `<video>` (html, same CSP as the
  transcripts minus scripts) or a list of links with `![]()` for photos (markdown), each with its file
  name, date (`≈` when the date is a guess) and albums, all escaped, linking `media/<sha256>.<ext>`
  only. Their bytes are `media/` entries like chat media; with `perProfile` each folder has its own
  photos page and copies.

Both renderers receive the conversation through `export/messages.ts`, which maps viewer data to the
legacy `Message[]` and media map. Their labels (day headings, `<html lang>`, search placeholder,
sender filter, theme button) come from the `lang` option, `'ca' | 'es' | 'en'` (default `'en'`), via
the table in `legacy/labels.ts`. The page title is the conversation title alone. Without `lang` the
legacy renderers keep their pt-BR labels and "WhatsApp Backup" title suffix (CLI output unchanged).
`json` and `viewer` ignore `lang`. Media type labels inside messages (`📷 photo`) are not translated.

## Media, limits, errors

Same as the viewer package: each file is streamed and rehashed (`blob-missing` / `integrity` abort
the export), paths must be `[<folder>/]media/<sha256>.<ext>` for the entry's own hash, unique, and
entry count and sizes stay within the archive limits (`unsafe-path`, `limit-exceeded`). In
`perProfile` a blob used by several profiles is stored once per folder (each folder is
self-contained) and counts that many times against the limits. Files the library lacks are left out
and counted in `missingMedia`.

`exportPackage(deps, { format, selection, split?, loadTemplate?, onProgress? })` resolves to
`{ blob, fileName, mediaCount, missingMedia }` (`memory-archive-<format>-<YYYY-MM-DD>.zip`) and
reports `{ phase: 'reading' } | { phase: 'media', done, total } | { phase: 'finishing' }`. It rejects
with `ViewerPackageError` (`no-profiles`, `template-missing`, `nothing-to-export`), `DbError`
(`invalid`, `not-found`) or `ArchiveError`, like `exportViewerPackage`. Output depends only on the
library, the selection and the injected clock.
