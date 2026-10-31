# Photo collection (library schema v13)

Pictures and videos the person brings in from a source that is not a chat. Three sources: a **Google
Photos Takeout** ZIP (an album, several albums, or a whole library; schema v11), **loose files** chosen on the
device, and a **Google Photos web download** ZIP (a selection from photos.google.com), the last two with
the date source of schema v12. Phase 8. The Photos screen imports and undoes; the assignment of photos to
profiles has its data layer (schema v13, "Assigning pictures to profiles"); the selection screen that drives it
(`/photos/select`, queue item 20b) is built.

Status: **implemented**: schema v11 + v12 + v13 (`lib/db/migrations.ts`), `lib/domain/photo.ts`,
`lib/db/photos.ts`, `lib/db/photo-assign.ts`, `lib/usecases/photo-assign.ts`, `lib/importers/takeout/`, `lib/importers/photos/`, `lib/usecases/photo-library.ts`,
`lib/usecases/photo-import.ts`, `lib/usecases/photo-source.ts`. No screen calls them yet.
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
| `source` | `takeout`, `loose` or `google-photos-zip`. A free label, so another source needs no schema change. |
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
| `taken_at` | UTC instant the source recorded for when it was taken, `YYYY-MM-DDTHH:MM:SSZ`; NULL when unknown. Unlike chat `sent_at` (local wall-clock), a photo date is a real instant for `sidecar`, `exif` and `file-modified`, because those carry an absolute time. Showing it in a day grid needs the viewer's time zone: that is the UI's job; but see `date_source` for the two exceptions. |
| `date_source` | Where `taken_at` came from (schema v12): `sidecar`, `exif`, `exif-local`, `file-modified` or `none`. See "Date source". `none` exactly when `taken_at` is NULL. |
| `taken_offset_minutes` | Schema v12. The camera's UTC offset in minutes (a multiple of 15, within +-840) when `date_source` is `exif`, else NULL. Lets a screen recover the wall-clock day at the place of the photo. |
| `latitude`, `longitude` | Both set (in range) or both NULL. |
| `description` | The caption written in Google Photos; `''` when none. Up to 4000 code points, control characters removed. |
| `source` | `takeout`, `loose` or `google-photos-zip`. |
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
- **Across sources the rule is the same: one item per `(sha256, source, album)`.** The same photo
  picked from the device and later found in a Takeout is two items over one blob. Why: the sources
  say different things about it (a Takeout sidecar has the original date and place, a loose file
  often only a guessed date), nothing is lost by keeping both, undoing one import never removes what
  another brought, and merging them would need a different unique key (a table rebuild) for a
  presentation problem. A grid that wants one tile per picture groups by `sha256` and shows the
  date of the most trustworthy item: `sidecar` > `exif` > `exif-local` > `file-modified` > `none`
  (`betterDate` in `lib/domain/photo.ts`).
- The key has nothing to do with the file name or the date, so a re-export of the same album with
  other file names or sidecar spellings still adds nothing.

### What is NOT created yet

- **No profile link table in v11/v12.** It came with its first entry point, in v13 (below), keyed by
  picture (`sha256`) rather than by item as first sketched: the grid has one tile per picture.
- No `people`, `url`, `favorited`, device or upload-date columns: the sidecar carries them, nothing
  displays them. People names are third parties' personal data; they are not stored.
- No decoded dimensions, thumbnails or EXIF: nothing here decodes an image. A thumbnail comes later
  from the existing thumbnail store, keyed by `sha256`.

## Date source (schema v12)

`taken_at` alone cannot tell the original date from a guess, and the UI must. `date_source`:

| Value | Meaning | Present it as |
|-------|---------|---------------|
| `sidecar` | Google Photos metadata JSON (`photoTakenTime`, epoch seconds). | The original date, a real instant. |
| `exif` | EXIF `DateTimeOriginal` with `OffsetTimeOriginal`: a real instant. | The original date. |
| `exif-local` | `DateTimeOriginal` without an offset (most cameras and phones older than 2016): the camera's wall-clock digits stored with `Z`. | The original **day**; show the time in UTC, never converted to the viewer's zone (the instant is unknown by up to a day). |
| `file-modified` | The file's last-modified time (loose files only). | **A guess**, never as the original date (it is as often the day the file was saved or copied). |
| `none` | Unknown; `taken_at` is NULL. | "No date". |

**Showing a date: `photoDisplayDate(item, zoneOffsetMinutes?)` (`lib/domain/photo.ts`) is the only rule; screens
must not derive a day from `taken_at` themselves.** It returns `{ day, time, zone, approximate }` or null:

| `date_source` | Shown as | `zone` | `approximate` |
|---------------|----------|--------|---------------|
| `exif` with `taken_offset_minutes` | `taken_at + offset`, the camera's wall clock as written (a 00:30 photo at +10:00 stays on its own day, not the previous UTC day) | `local-digits` | no |
| `exif` without an offset (not produced by the importers) | the instant in the viewer's zone | `utc` | no |
| `exif-local` | the stored digits as written, never converted | `local-digits` | no |
| `sidecar` (Google gives only a UTC instant) | the instant in the viewer's zone | `utc` | no |
| `file-modified` | the instant in the viewer's zone | `utc` | **yes** |
| `none` | null | | |

The viewer's zone is passed as `zoneOffsetMinutes(epochMs)` (e.g. `(ms) => -new Date(ms).getTimezoneOffset()`); the
default is UTC. When two copies of the same picture meet in one import, `betterDate` keeps the most trustworthy date;
on a tie the earliest `taken_at` wins, then the smaller offset, then the smaller file name, so the result never depends
on file order.

Why five values and not four: `exif-local` is honest about a zone-less time; collapsing it into `exif`
would shift photos across midnight when the viewer is in another zone, and adding a value later needs a table rebuild
(SQLite cannot alter a CHECK). Migration v12 adds the column (`NOT NULL DEFAULT 'none'`, CHECK on the
five values) and marks existing Takeout rows `sidecar` when they have a date and `none` otherwise. Migration v12 also adds `taken_offset_minutes` (CHECK: only with `exif`, a multiple of 15, within +-14:00; existing
rows NULL). v12 is amended in place (it was not released). The rule "`none` exactly when `taken_at` is NULL" is not a
CHECK (ADD COLUMN validates old rows against the default before the backfill) nor a trigger (snapshots may not carry
triggers): the writer (`lib/db/photos.ts`) refuses a row where they disagree, and `loadSnapshot` refuses a backup that
holds one. A Google Photos web
download ZIP never gets `file-modified`: a ZIP entry's time is when the archive was built, not when the picture
was taken. The Takeout importer does not read EXIF (a picture without a sidecar date stays `none`): known limit.

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

## Loose files and Google Photos downloads (`lib/importers/photos/`, `lib/usecases/photo-import.ts`)

`importLoosePhotos(deps, { files, label?, signal, onProgress, limits })` takes `File`s from
`<input type=file multiple accept="image/*,video/*">` or a gallery picker: source `loose`, album
= the optional user label (cleaned: control characters out, NFC, 200 code points, as every album; empty = none),
history label = the same. `importGooglePhotosZip(deps, { zip, fileName, ... })` takes the ZIP downloaded from
photos.google.com: flat, no folders or sidecars, source `google-photos-zip`, album `''`. A ZIP with a `Takeout/`
folder or any `.json` metadata file is a Takeout and is handed to `importTakeoutAlbum` unchanged
(`delegatedToTakeout: true`, source `takeout`, no EXIF, no sniffing: its documented behaviour).
`detectPhotoSource(file)` tells which importer a file needs (`media`, `takeout-album`,
`google-photos-zip`, `whatsapp-chat`, `backup`, `changes-pack`, `unsupported`) from the content only:
magic bytes, the central directory and, for this app's own ZIPs, the manifest's `format`. A ZIP that is a document or app
package (`[Content_Types].xml`, `mimetype`, `AndroidManifest.xml` at the root, or a `META-INF/`, `word/`, `ppt/`, `xl/`,
`OEBPS/`, `Payload/` folder: .docx, .pptx, .xlsx, .epub, .odt, .apk, .ipa), or a flat ZIP where pictures and videos do not
outnumber the other files (`.json`, `.txt`, `.html`, `.htm`, `.csv` and AppleDouble not counted), is `unsupported`;
`importGooglePhotosZip` refuses it with `invalid-takeout`. A stray `.txt`
beside pictures is not a chat unless it is `_chat.txt` or has "WhatsApp" in its name; an encrypted file is reported as `backup`.

**What is kept.** A file is kept when its first bytes are a picture or video of a supported format and its
extension does not contradict them (`acceptMedia`): `File.type` and names are never trusted. Supported:
JPEG, PNG, GIF, WebP, HEIC/HEIF (brands heic/heix/hevc/hevx/heim/heis/mif1/msf1/heif/avci), AVIF, BMP, TIFF;
MP4/M4V/MOV/3GP, AVI, Matroska/WebM, MPEG. An `ftyp` brand of audio (M4A, M4B, M4P, F4A), Canon RAW (`crx `) or
JPEG 2000 is refused, not taken for MP4. The bytes decide
the stored `mime` and `kind` (a `.jpg` holding a PNG is a PNG). Refused and counted in `ignoredFiles`: unknown
bytes (HTML, scripts, documents, RAW), empty files, an extension that is not a media one (`.html`, `.exe`,
`.json` in a download) or that names the other kind (`.mp4` over a JPEG). No extension is fine (the bytes decide).
Same pipeline as the Takeout import: each file is streamed into the blob store, hashed on the way (only the first 256 KiB are
held in memory, to sniff and read EXIF), then one transaction saves batch and items; the same all-or-nothing, abort
(honoured until the save), busy-guard and orphan-cleanup rules. A **loose file that cannot be read** (cloud-only,
removed or changed after picking) is skipped and counted in `unreadableFiles`; the rest is imported. If every chosen
file is unreadable the import fails with `TakeoutError` `unreadable-files`. A damaged ZIP entry still fails the whole
import (all or nothing). The same bytes already in the collection
from another source reuse the blob and add an item (see Identity); the same `(sha256, source, album)` is skipped.

**Date and place** of a loose file or download entry, first match:
1. EXIF `DateTimeOriginal` (+ `OffsetTimeOriginal`) -> `exif` (offset known; kept in `taken_offset_minutes`) or
   `exif-local`. An offset is valid only as `+-HH:MM` with minutes 00/30/45 and at most 14:00; a damaged one keeps
   the digits as `exif-local`. A date of `0000:...` or exactly `1970:01:01 00:00:00` (an unset camera clock) is no
   date; `2000:01:01 00:00:00` is indistinguishable from a real one and is kept;
2. loose file only: `File.lastModified` -> `file-modified` (rejected when unset/0, before 1971, or more than a day
   in the future);
3. none.
EXIF GPS (N/S, E/W, degrees/minutes/seconds, in range, `0,0` = no fix) fills the location. The same bytes twice in
one import keep the most trustworthy date.

**EXIF reader** (`exif.ts`, no dependency, no image decoding): JPEG APP1 `Exif` segment and the HEIC/HEIF `Exif`
item found through `meta`/`iinf`/`iloc`. Reads only the first 256 KiB; every offset and length is checked against that
buffer; at most 128 JPEG segments, 512 entries per IFD, 4096 HEIF items; IFD0, the Exif IFD and the GPS IFD are each
read once (a pointer to a visited IFD is ignored, so no loops); strings are length-bounded; dates must be real calendar
dates in 1900-2100 (`0000:00:00`, month 13, 31 February are dropped); any failure means "no metadata", never an
exception. Not read: `DateTimeDigitized`/`DateTime` (modify date: a different thing), maker notes, XMP, video
creation times (mvhd), a HEIF whose Exif item lies beyond the first 256 KiB, `construction_method` other than 0,
Exif items with several extents.

**Limits** (`TakeoutLimits`, the same defaults as Takeout): `maxEntries` bounds the number of files (loose) or ZIP entries,
`maxMediaBytes` (4 GiB) one file (skipped and counted `tooLarge`), `maxTotalBytes` (256 GiB) the selection or declared ZIP total
(refused, `limit-exceeded`), compression ratio 100 for ZIP entries. Hostile entry names (traversal, absolute, drive letter,
backslash, control characters) refuse a ZIP; a loose file's name is reduced to its base name and cleaned, and never
becomes a path. Result: `{ batchId | null, summary: { added, alreadyThere, duplicatesInFile, mediaAdded, withoutDate,
dateGuessed, unreadableFiles, ignoredFiles, unusableSidecars (0 here), tooLarge } }`. The history label of a download is cleaned like any text.

## Assigning pictures to profiles (schema v13, queue item 20a)

Data layer and use cases (20a); the screen that calls them is `/photos/select` (20b). The PRD rule stands: **photos are never assigned
automatically.** Nothing assigns by date, album, name or source, there is no "assign all" and an import never
writes a link. The person selects pictures and chooses profiles; `assignPhotos` records exactly that.

### Table `photo_profiles` (expand only)

`photo_profiles(sha256 -> blobs, profile_id -> profiles ON DELETE CASCADE, created_at, PRIMARY KEY (sha256,
profile_id))` plus an index `(profile_id, sha256)` for "what has this profile". Empty after migrating; no existing
row changes, so a v1-v12 backup restores by migrating (tested for v12 and for a v13 round trip).

- **Per picture, not per item.** The same bytes from two albums or sources are two `photo_items` rows but one tile
  and one assignment. A picture assigned once is assigned for every item that holds it.
- **A link lives while an item holds the picture.** This cannot be a constraint (items are not unique per
  `sha256`), so it is kept by the writers and checked on read-back: `assignPhotos` refuses a hash that no item
  holds (a chat photo or profile photo in the blob store is not a collection picture); `undoPhotoBatch` deletes the
  links of a picture that loses its LAST item, in the same transaction and before the blob row goes (the FK to
  `blobs` would refuse otherwise) and reports them as `removedAssignments`; a picture still held by an item of
  another import keeps its links; `loadSnapshot` refuses a backup that links a picture no item holds. Re-importing
  a picture after its import was undone starts unassigned: undo discards the person's choices about it, which the
  UI must say before undoing (`removedAssignments` tells what was lost).
- **Blobs.** `isReferenced` is unchanged: a blob is referenced by an item, and a link implies an item, so a link
  alone never keeps (or loses) bytes. The FK from the link to `blobs` is the integrity backstop.
- **Profiles** are archived, not deleted, today; `ON DELETE CASCADE` covers a future hard delete and merge paths.
  Assigning to an archived profile is allowed (archiving hides a profile, it does not freeze it).
- **Erase everything / replace library** need no extra code: the first deletes the database file, the second
  clears every user table (`loadSnapshot` `replace`) and restores the snapshot's own links.

### Operations (`lib/db/photo-assign.ts`, worker ops; use cases in `lib/usecases/photo-assign.ts`)

| Operation | Notes |
|-----------|-------|
| `assignPhotos({sha256s, profileIds})` | 1..2000 pictures x 1..50 profiles, one transaction, idempotent (an existing pair keeps its `created_at`), returns `{added, alreadyThere, fresh}`; `fresh` is exactly the links THIS call inserted, per profile (`[{profileId, sha256s}]`), or `null` when more than 5,000 were added (the response stays small; such a call has no whole-call undo). `invalid` for malformed/empty/too many; `not-found` for an unknown picture or profile, and then nothing is written. |
| `unassignPhotos({sha256s, profileId})` | Removes those links only; the pictures stay. Idempotent, returns `{removed}`. |
| `unassignPhotoLinks({links: [{profileId, sha256s}]})` | Removes exactly these links (the `fresh` of an `assignPhotos` call) in ONE transaction: all or nothing, so a failed undo leaves nothing half done and is retried as it is. At most 50 profiles x 2000 pictures. Idempotent: a link already gone (another tab) counts for nothing; a profile that no longer exists is not an error. Returns `{removed}`. |
| `listPhotoPictures({scope, cursor, limit})` | One row per picture (`PhotoPicture`). `scope`: `all`, `unassigned`, `assigned` (any profile) or `assigned` + `profileId`. `limit` 1..500. Returns `{pictures, nextCursor}`; pass `nextCursor` back for the next page. |
| `listProfilePhotos(profileId, page)` | `listPhotoPictures` with `scope: assigned + profileId`. |
| `countPhotoPictures()` | `{pictures, unassigned, items}` for the UI. |
| `getPhotoPicture(sha256)` | One `PhotoPicture` or null. |
| `listPhotoMonths({scope, zoneOffsetMinutes})` | `{months: [{month, count}], undated}`, newest first. |
| `readPhotoFile(sha256)` / `readPhotoTile(sha256)` | The lightbox file / the tile image; only for a hash held by an item. |

**The picture row.** `sha256`, `kind`, `mime`, `takenAt`, `takenOffsetMinutes`, `dateSource`, `fileName` come from the
item with the most trustworthy date (the SQL ordering is `betterDate` written out; a test pins them to each other and
to arrival order); `albums` (distinct non-empty names, sorted, at most 5) with `albumCount`, `sources`, `itemCount`,
and `assignedProfileIds`. The date is shown only through `photoDisplayDate(picture, zone)`.

**Order and paging.** Newest first, undated last, then by hash so the order is total. The key is the wall clock at
the place of the photo: `takenAt + offset` for `exif` with an offset, `takenAt` as stored otherwise (`exif-local`
digits are already wall clock). Keyset paging: assigning or importing between pages never repeats a picture already
past the cursor. The key does not know the viewer's zone, so a `sidecar` or `file-modified` picture can sit up to the
viewer's UTC offset from where `photoDisplayDate` puts it: a screen that shows day headers must start a new header
whenever the displayed day changes, and never assume one run per day. The listing is a window query over the
collection per page (tens of thousands of items are fine; if a library reaches the hundreds of thousands, a
materialised picture table is the next step, behind the same operations).

**Months.** The viewer's zone is a function and cannot cross the worker boundary, so `listPhotoMonths` reads the date
fields of every picture in scope (5000 per page, by hash) and folds them with `photoDisplayDate`: the one date rule.
So a 00:30 `exif` photo at +10:00 counts in its own month, `exif-local` digits are never shifted, and a `sidecar`
instant lands in the month of the viewer's zone (UTC by default; pass `(ms) => -new Date(ms).getTimezoneOffset()`).
Undated pictures are counted apart. Months are a navigation aid: a `file-modified` guess counts in its month too.

**Reading.** `readPhotoFile` is `readBlob` (a lazy view of the stored file when the store has `file()`, else read
into memory up to the usual limit, `too-large` above it); `readPhotoTile` is `readTileThumbnail` for a photo (cached
thumbnail, made once for a photo within the 64 MiB decode limit and above 32 KiB; a file under 32 KiB as it is) and `null`
for a video, for a photo over the decode limit and for one the browser cannot thumbnail: the tile then shows a placeholder
(the file name), never the full file decoded in a tile. The full file is read when the picture is opened. Nothing here decodes more than that existing path; call them for the tiles near the screen only.

**Person page (not built).** The Gallery of a person lists chat media; `listProfilePhotos` gives the assigned
pictures in the same newest-first shape, with `takenAt`/`dateSource` for `photoDisplayDate`. Merging them into the
Gallery's order, and opening one in its lightbox via `readPhotoFile`, is UI work for a follow-up; the Gallery code
is untouched here.

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
machinery. `formatVersion` stays **1**; the manifest's `schemaVersion` is 13 (11 for the first release
with photos, 13 with assignments), so an app that only knows an older schema refuses the file with a clear `newer-schema`
message instead of dropping the photos, their date sources or their assignments, and every backup of schema v1-v12
restores by migrating (tested). `isLibraryEmpty` treats
both tables as content (a library holding only photos is not empty, so a restore never overwrites
it silently). `getStorageBreakdown` counts photo-item files as photos and videos.

## Sync (changes pack): known limit

The changes pack does **not** carry photo items, batches or the assignments of pictures to profiles yet, and the media of photo-only blobs is
not in a pack either. Photos reach another device through a full backup (restore). Carrying them
needs a pack record kind (`photo-item`, keyed by `(sha256, source, album)`, which is already
device-independent), tombstones for undone batches, and a pack `formatVersion` decision; it is
deliberately not half done here. `docs/formats/changes-pack.md` states the same.

## Tests

`lib/importers/photos/*.test.ts` (magic bytes, EXIF incl. hostile and fuzzed input, ZIP layout and path safety),
`lib/usecases/photo-import.test.ts` (dates and their sources, lying types and names, idempotent re-import, overlap,
cross-source dedupe and undo, big file hash, limits, abort, store and database failures, busy, backup round trip),
`lib/usecases/photo-source.test.ts` (detector), `lib/domain/photo.test.ts`, `lib/db/migrations.test.ts` (v11 to v12) and
`snapshot.test.ts` (v11 backup restores). Synthetic pictures: `scripts/photo-fixtures.mjs`
(also `fixtures/google-photos-download.zip`).

`lib/importers/takeout/*.test.ts` (paths, sidecar fields, name matching, layouts, hostile input),
`lib/db/photo-assign.test.ts` and `lib/usecases/photo-assign.test.ts` (one row per picture, order with undated and offsets,
paging without gaps or repeats, scopes, SQL best date vs `betterDate`, assign / unassign idempotency and bounds,
unknown picture or profile, cascade, undo with shared pictures, month buckets across the offset rules, reading, backup
round trip), `lib/db/migrations.test.ts` (v12 to v13) and `snapshot.test.ts` (v12 backup restores, orphan assignment refused),
`lib/db/photos.test.ts` (validation, idempotency, rollback, undo, paging),
`lib/db/migrations.test.ts` (v10 to v11) and `snapshot.test.ts` (a v10 backup restores),
`lib/usecases/photo-library.test.ts` (import, re-import, overlap, two albums one file, undo, abort,
store and database failures, busy guard, hostile ZIPs, sweep, storage breakdown, backup round trip).
The synthetic Takeout is `scripts/takeout-fixtures.mjs` (also written to `fixtures/takeout-albums.zip`
by `scripts/generate-fixtures.mjs`); no real export is ever read.
