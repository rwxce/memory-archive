# Photo collection (library schema v11)

Pictures and videos the person brings in from a source that is not a chat. Today the only source is
a **Google Photos Takeout** ZIP (an album, several albums, or a whole library). Phase 8; this is its
first piece, the data layer and the import use case. The selection grid (queue item 20), the loose
photos / gallery picker / Google Photos web download paths (item 19) and the assignment of photos to
profiles are not built.

Status: **implemented**: schema v11 (`lib/db/migrations.ts`), `lib/domain/photo.ts`,
`lib/db/photos.ts`, `lib/importers/takeout/`, `lib/usecases/photo-library.ts`. No screen calls it yet.
Where this document and the code disagree, fix the document in the same PR.

## Principles

- **The collection belongs to the library, not to a profile.** Nothing is assigned by date or by
  anything else (PRD, "Google Photos association"). Assigning is a later, explicit act.
- **Same bytes, one file.** The picture is a content-addressed `blobs` row (SHA-256), stored once in
  OPFS, exactly like chat media. Nothing here has its own byte store.
- **Original metadata is kept as the source gave it.** The date taken is never replaced by the date
  of the import.
- **Idempotent.** Importing the same ZIP again, or an overlapping one, adds nothing.
- **All or nothing**, and media is stored before rows, like a chat import (see "Import").

## Data model (schema v11, expand only)

Two new tables, empty after migrating. No existing column or row changes, so backups of schema v1-v10
restore by migrating.

### `photo_batches`

One row per import that added at least one item (history and undo; the equivalent of
`import_batches`, which is tied to a conversation and cannot be reused).

| Column | Meaning |
|--------|---------|
| `id` | Random UUID (lowercase, 36 characters), made by the use case. |
| `source` | `takeout`. A free label, so another source needs no schema change. |
| `source_label` | Name of the imported file. Untrusted text, only displayed. |
| `created_at` | UTC instant of the import. |
| `added_count`, `skipped_count` | Items stored / items found already present. |

An import that adds nothing leaves no row (the same ZIP twice does not clutter the history).

### `photo_items`

One picture or video of the collection.

| Column | Meaning |
|--------|---------|
| `id` | Integer, insertion order. Not stable across devices (the changes pack does not carry items yet). |
| `batch_id` | The import that added it (`ON DELETE CASCADE`). |
| `sha256` | The bytes: `blobs.sha256`. A file cannot be removed while an item uses it. |
| `kind` | `photo` or `video`, from the file extension. |
| `mime` | Media type from the extension (`image/jpeg`, `video/mp4`, ...) or NULL. A display hint; the bytes are never sniffed or decoded here. |
| `taken_at` | UTC instant the source recorded for when it was taken, `YYYY-MM-DDTHH:MM:SSZ`; NULL when unknown. Unlike chat `sent_at` (local wall-clock), a photo date is a real instant, because Takeout stores epoch seconds. Showing it in a day grid needs the viewer's time zone: that is the UI's job. |
| `latitude`, `longitude` | Both set (in range) or both NULL. |
| `description` | The caption written in Google Photos; `''` when none. Up to 4000 code points, control characters removed. |
| `source` | `takeout`. |
| `album` | The album as the source names it; `''` when the file is in no album. Up to 200 code points, normalized to NFC (case kept). |
| `file_name` | The base name inside the ZIP (no folders), cleaned and NFC-normalized, up to 255 code points. Display only. |

Identity: `UNIQUE (sha256, source, album)`. Reasons and consequences:

- **One item per album membership, not one item with a list of albums.** The same photo in "Trip"
  and in "Family" is two items over one blob. The album is part of what the source says about the
  file (its description and original name can differ per album), the uniqueness key stays a plain
  constraint the database enforces, and a later album-level undo or filter needs no second table. A
  grid that wants one tile per picture groups by `sha256`. The cost, on purpose: the same bytes in
  two albums count twice in an item count, and once in storage.
- The same bytes twice **in one album** are one item (the first file name wins).
- The key has nothing to do with the file name or the date, so a re-export of the same album with
  other file names or sidecar spellings still adds nothing.

### What is NOT created yet

- **No profile link table.** Assigning photos to profiles is item 20's entry point; a table with no
  working entry point is dead schema (and a changes-pack format commitment). It will be an
  expand-only migration then (`photo_item_profiles(photo_item_id, profile_id)`, composite key).
- No `people`, `url`, `favorited`, device or upload-date columns: the sidecar carries them, nothing
  displays them. People names are third parties' personal data; they are not stored.
- No decoded dimensions, thumbnails or EXIF: nothing here decodes an image. A thumbnail comes later
  from the existing thumbnail store, keyed by `sha256`.

## Import (`importTakeoutAlbum`)

Order, and why interrupting it at any point is safe (the same as a chat import):

1. **Read the layout** with the project's one ZIP reader (central directory, ZIP64): every entry
   name is checked, limits are applied to declared values, only the small JSON entries are read.
2. **Media**: each picture or video is streamed (`openZipEntry`, never buffered whole) into the blob
   store, hashed on the way. Bytes land in the store before the database knows them. On abort or
   failure the files this run wrote are removed again (files stored earlier are never touched); after
   a crash they are orphans that the library's start-up sweep removes.
3. **Save**: one database call, `importPhotoItems`, in one transaction: blob rows (`INSERT OR IGNORE`),
   the batch, the items (`INSERT OR IGNORE` on the unique key). If nothing was added the batch row is
   removed again. Files that no item, message or profile refers to afterwards are released and their
   bytes deleted.

It runs under the archive busy guard (and the cross-tab lock when given): a backup, restore, other
import, undo or sweep at the same time is refused with `busy`. Progress is `reading` / `media` (with
bytes) / `saving`; the `AbortSignal` is honoured until the save starts.

Result: `{ batchId | null, summary: { added, alreadyThere, duplicatesInFile, mediaAdded, withoutDate,
ignoredFiles, unusableSidecars, tooLarge } }`.

Re-importing the same ZIP re-reads and re-hashes its media (the identity of a picture is the hash of
its bytes, so it cannot be known without reading them) but stores and adds nothing.

**Undo** (`undoPhotoImport(batchId)`): removes the items of that batch and the files nothing else
uses. A picture that a later import found already present belongs to the batch that added it:
undoing the first batch removes it even though the second ZIP contained it (the same rule as chat
batches). Safe to repeat.

### Limits (`TakeoutLimits`, defaults)

100,000 entries; 32 MiB central directory; 4 GiB per picture or video; 256 GiB declared total;
compression ratio 100 for deflated entries; 256 KiB per sidecar. A picture above the size limit is
skipped and counted (`tooLarge`); an oversized, undecodable or non-object sidecar is counted
(`unusableSidecars`) and the picture is kept without metadata; everything else over a limit refuses
the file (`TakeoutError` `limit-exceeded`). Known limit: all items cross the worker boundary in one
request (a few tens of MB at the entry limit; the worst case, 100,000 items each with a full 4000
code point description, is a few hundred MB of text and is not realistic: real captions are short).
The import is one transaction, so it is not split into batches.

Text limits (album, file name, description, import label) count Unicode code points everywhere:
the importer truncates at the limit without splitting a surrogate pair and the database checks the
same measure, so an emoji-heavy name never fails an import. File extensions and other lookups use
maps, so names such as `a.constructor` are simply not pictures. The same bytes twice in one album of
a ZIP are one item that keeps the richer metadata (date, place, description) of either copy.

## Reading a Takeout ZIP (`lib/importers/takeout/`)

Untrusted input throughout. File names are never storage paths (bytes go by hash) and a hostile
name refuses the whole file.

**Paths**: an entry name with `..` or `.` segments, empty segments, a leading `/`, a drive letter, a
backslash, control characters or more than 1024 characters refuses the file (`unsafe-path`). Spaces
and non-ASCII letters are normal in Takeout and allowed. Folder entries are skipped.

**Album**: the folder of the file. With the usual `Takeout/<service folder>/<album>/<file>` layout
the first folder after `Takeout` is the service folder (its name follows the account language:
"Google Photos", "Google Fotos"), so a file directly in it is in no album (`''`). A `Photos from YYYY`
folder is Google's automatic grouping, not an album (`''`). Without a `Takeout` wrapper the folder is
the album. The album's own `metadata.json` `title` wins over the folder name when valid. Nested
folders: the innermost folder name.

**Pictures and videos** are recognised by extension (case-insensitive): jpg, jpeg, png, gif, webp,
heic, heif, avif, bmp, tif, tiff; mp4, m4v, mov, 3gp, avi, mkv, webm, mpg, mpeg. Everything else
(the HTML index, `.txt`, motion-photo `.MP` files, RAW) is ignored and counted (`ignoredFiles`).

**Sidecar (metadata JSON) matching**, per folder, supported:

| Variant | Example |
|---------|---------|
| Classic | `IMG_1.jpg.json` |
| Supplemental | `IMG_1.jpg.supplemental-metadata.json` |
| Suffix cut by Google's name-length cap | `IMG_1.jpg.supplemental-meta.json`, `IMG_1.jpg.s.json` |
| Long picture name cut at 46 characters | `<first 46 chars of "<name>.supplemental-metadata">.json` |
| `(1)` duplicates | `IMG_1(1).jpg` uses `IMG_1.jpg(1).json` |
| Edited copy | `IMG_1-edited.jpg` uses the sidecar of `IMG_1.jpg` |
| Name matches nothing | the one sidecar of the folder whose `title` is exactly the picture's name (no `(n)` stripping) and that no other picture claimed by name |
| Live photo video without its own sidecar | borrows the metadata of the still with the same base name (exact case, same folder, other kind) and the reverse |

A match made through a cut name must be confirmed by the sidecar's `title` (a sidecar without a title is not accepted that way), so two
long names that share a 46-character prefix do not take each other's dates; without confirmation the
picture is imported without metadata rather than with the wrong date.

Not supported (the picture is still imported, without metadata unless another rule finds it):
localized "edited" suffixes (`-bearbeitet`, `-modifié`, `-editado`...); `-edited` combined with `(n)`;
a sidecar whose truncation does not follow the 46-character rule; localized year-folder names
(`Fotos de 2019` is read as an album named so); nested ZIPs; Takeout split in several ZIP parts
(each part is imported on its own: metadata in another part is not found).

**Sidecar fields** read (each validated on its own; a wrong one is dropped, not fatal):

- `photoTakenTime.timestamp` (epoch seconds, decimal string or number, year 1970-9999) -> `taken_at`.
  `creationTime` (the upload date) is deliberately **not** used.
- `geoData` latitude / longitude (what the person may have edited), else `geoDataExif` (the camera's);
  the pair must be finite and in range, and `0, 0` means "no location" in Takeout.
- `description` -> `description` (line breaks kept, other control characters replaced, bounded).
- `title` -> only to confirm a match; never stored, never a path.
- Ignored: `people`, `url`, `favorited`, `imageViews`, `googlePhotosOrigin`, device and app data.

A sidecar that is larger than 256 KiB, not strict UTF-8, not JSON or not an object is unusable. The
JSON is parsed with `JSON.parse` and only named own fields are read.

## Backup and restore

The backup ZIP is unchanged in layout: the database file carries both tables and the photo files are
`blobs` rows like any other, so they are exported, verified and restored with the existing
machinery. `formatVersion` stays **1**; the manifest's `schemaVersion` becomes 11, so an app that only
knows schema v10 refuses the file with a clear `newer-schema` message instead of dropping the
photos, and every backup of schema v1-v10 restores by migrating (tested). `isLibraryEmpty` treats
both tables as content (a library holding only photos is not empty, so a restore never overwrites
it silently). `getStorageBreakdown` counts photo-item files as photos and videos.

## Sync (changes pack): known limit

The changes pack does **not** carry photo items or batches yet, and the media of photo-only blobs is
not in a pack either. Photos reach another device through a full backup (restore). Carrying them
needs a pack record kind (`photo-item`, keyed by `(sha256, source, album)`, which is already
device-independent), tombstones for undone batches, and a pack `formatVersion` decision; it is
deliberately not half done here. `docs/formats/changes-pack.md` states the same.

## Tests

`lib/importers/takeout/*.test.ts` (paths, sidecar fields, name matching, layouts, hostile input),
`lib/db/photos.test.ts` (validation, idempotency, rollback, undo, paging),
`lib/db/migrations.test.ts` (v10 to v11) and `snapshot.test.ts` (a v10 backup restores),
`lib/usecases/photo-library.test.ts` (import, re-import, overlap, two albums one file, undo, abort,
store and database failures, busy guard, hostile ZIPs, sweep, storage breakdown, backup round trip).
The synthetic Takeout is `scripts/takeout-fixtures.mjs` (also written to `fixtures/takeout-albums.zip`
by `scripts/generate-fixtures.mjs`); no real export is ever read.
