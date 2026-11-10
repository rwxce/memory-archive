# Viewer data (format version 1)

The data the standalone read-only viewer shows. It is an **export**: it is never restored from and
never the storage format (the archive ZIP and the SQLite library are). Code:
`lib/exporters/viewer/{format,build}.ts` and `lib/usecases/viewer-export.ts`.

## Why inlined

The viewer opens from disk on a desktop (`file://`), where `fetch` is blocked. The JSON is therefore
inlined in the HTML as `<script type="application/json">`. `serializeViewerData` writes `<`, `>`,
`&`, U+2028 and U+2029 as `\uXXXX`, so `</script>` and `<!--` cannot occur in the island and
`JSON.parse` returns the original data. Media sit next to the HTML in `media/`.

## Envelope

| Field | Meaning |
|-------|---------|
| `format` | `"memory-archive-viewer"` |
| `schemaVersion` | `1`. Bumped only when an older reader could misread the data. A reader accepts every version it shipped and refuses a newer one (`parseViewerData` throws `ViewerDataError` code `newer-schema`). |
| `generator` | `{ name, version }`, same constants as the legacy JSON (`lib/exporters/legacy/version.ts`) |
| `createdAt` | UTC instant of the export |
| `selection` | `{ from, to, includeMedia }`; `from` / `to` are local dates `YYYY-MM-DD`, inclusive, `null` = open |
| `profiles` | Selected profiles: `id, displayName, relationship, description` and, when the export has media, `photos` (see Photos), sorted by name then id |
| `conversations` | See below; sorted by first message, then id. Conversations with no message in the range are left out |
| `media` | Files included: `{ sha256, path, size, mime }`, sorted by `sha256` |

A conversation: `id, title, source, isGroup, profileIds` (selected profiles it is filed under),
`participants: [{ name, isMe }]`, `messages`. A message: `sentAt` (local `YYYY-MM-DDTHH:MM:SS`, no
zone), `type`, `author` (null for system), `isMe`, `text`, `media`, `mediaName`.

Text is the message body as stored. The original export line is not kept in the library, so it is
not in this format. Favorites and notes are not exported.

## Media

- `media` on a message is `media/<sha256>.<ext>` or `null`. `<sha256>` is the content hash; `<ext>`
  is `[a-z0-9]{1,8}` taken from the original name, else the media type, else `bin`. A file name
  never shapes the path. The same bytes are one file.
- `includeMedia: false`: no message has a path and `media` is empty; `mediaName` is still set.
- A file the message refers to but the blob store lacks is left out (`media: null`, `mediaName`
  kept) and counted in `missingMedia` of the use case result; it is not an error.

## Photos

The pictures and videos the person assigned to a profile from the photo collection
(`photo_profiles`; `docs/formats/photo-library.md`) travel with that profile, not with a
conversation. `ViewerProfile.photos` is an optional list; each item:

| Field | Meaning |
|-------|---------|
| `sha256`, `path` | the bytes; `path` is `media/<sha256>.<ext>` (same rules as message media) and is also an entry of `media` |
| `kind`, `mime` | `photo` / `video`; media type or null |
| `takenAt`, `takenOffsetMinutes`, `dateSource` | as stored in the collection. Show a date only through `photoDisplayDate` |
| `fileName` | untrusted, display only (never part of a path) |
| `albums` | album names (untrusted, at most 5) |

- Order: the grid's order, newest first by display date, undated last.
- `includeMedia: false`: `photos` is absent on every profile and no picture is exported (like message
  media, pictures are bytes). With media on, `photos` is present (possibly empty).
- Date range: a picture is kept when its `photoDisplayDate` day (UTC for `sidecar` and
  `file-modified` dates, the camera's own clock for `exif` / `exif-local`; not the exporting
  device's zone, so the output does not depend on where it is made) is within `from`..`to`. A picture with no
  date is kept only when no range is set.
- A picture whose bytes the blob store lacks is left out and counted in `missingMedia`. A picture
  that is also chat media is one `media` entry (content addressed). Pictures are read in pages of
  500; only metadata is in memory, the bytes are streamed by the writer.
- Same picture assigned to several selected profiles: listed under each, one file.
- Additive: `schemaVersion` stays `1`. A reader that predates it ignores the field; `parseViewerData`
  accepts data without it and checks every photo `path` like a media path.

## Untrusted data

Titles, authors, text, file names and album names are kept verbatim as plain data. The renderer
escapes them. `parseViewerData` checks structure and that every media (and photo) path stays inside
`media/`.

## Selection

`ViewerSelection { profileIds, from?, to?, includeMedia }`. A conversation linked to several
selected profiles appears once. Empty `profileIds`, a malformed or reversed date: `DbError`
`invalid`; an unknown profile: `not-found`. The output depends only on the library and the
selection (and the injected clock), not on the order of `profileIds`.

## Package layout

`exportViewerPackage` (`lib/usecases/viewer-package.ts`) returns the download, a ZIP written by
`lib/exporters/viewer/write.ts` with the archive writer's streaming sink (`archive/zip-sink.ts`):

```
viewer.html          template with the data inlined (exactly one data island)
README.txt           en / ca / es: open viewer.html on a desktop, keep media/ next to it, use the app on a phone
media/<sha256>.<ext> one stored (not recompressed) entry per `media` item; absent when includeMedia is false
```

Each media entry is rehashed while it streams out; a blob that is missing or no longer matches its
hash aborts the export (`ArchiveError` `blob-missing` / `integrity`). Paths must be exactly
`media/<sha256>.<ext>` for the entry's own hash, unique, and entry count and sizes stay within the
archive limits (`unsafe-path`, `limit-exceeded`). The template is the app's own static asset
(`/viewer/viewer-template.html`, same origin, no other network call).

The viewer shows a "Photos (N)" entry in the sidebar (for the selected profile, or all) when there
are photos; it opens a grid (120 at a time) of the pictures, narrowed by the viewer's date filter
by the same rule as the export. Names go in as text only.

## Known limits

The whole data object is built in memory (text and photo metadata only; media are copied by the
writer, streamed). Exports carry full-size pictures, no thumbnails: a large collection makes a
heavy page (images load lazily).
