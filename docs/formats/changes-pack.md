# Changes pack (format version 1)

The file two devices carry by hand to keep their archives in step (phase 7). A pack holds what one
device changed since the last time it gave something to another device, or, for a new device,
everything. Importing a pack is a **merge**: it never replaces the library and never deletes
messages or media on its own. A favorite or note the user deleted on another device is deleted here
too (when this device did not change it since), and an undone import is only offered, never applied
silently (see "Deletions").

Status: **export is implemented; merge is not.** Built: the data layer (schema v8: `device`,
`sync_peers`, `tombstones`, `seq` / `changed_by`; `lib/db/sync.ts`, `lib/usecases/sync-state.ts`),
the pack writer and a structural reader / verifier (`lib/exporters/changes-pack/`), the change-set
queries (`lib/db/changes.ts`) and the export use case (`lib/usecases/changes-pack-export.ts`).
Not built: merging a pack (the "Merge" section is still design), the conflicts list, any UI. Where
this document and later code disagree, fix the document in the same PR. Rationale is written next
to each decision because the product owner delegated them.

## Goals and non-goals

- Phone to desktop (and back, and a third device) with nothing but files. No server, no account,
  no clock agreement between devices.
- Importing the same pack twice changes nothing. Importing packs in any order, or via a third
  device, is designed to converge to the same archive (not yet verified by code), **except** where two devices edited the same record
  independently: that is a conflict, kept side by side until the user chooses (never decided by
  "last writer wins" in silence).
- Small: a pack carries only changed records and only the media they reference.
- Not a backup. A backup (`docs/formats/` and `lib/exporters/archive/format.ts`) is a snapshot
  that replaces an empty or chosen library. A pack merges. They are different formats on purpose
  (see "Why not reuse the backup database").
- Out of scope: highlights (they come back by importing the same `findings.json` on the other
  device; they are in every full backup), settings, the search index, thumbnails.

## Vocabulary

| Term | Meaning |
|------|---------|
| device id | Random v4 UUID created by the schema migration (`device.id`), once per library incarnation. A restore replaces it. |
| `seq` | A device's monotonic change counter. Every write to a synced record takes the next number and stamps the row. Local to the device that stamped it, never compared across devices. |
| watermark | A `seq` value plus a direction: "everything up to here has been exchanged". Kept per peer. |
| `upTo` | The counter value read, in the same step as the records, when a pack was built. |
| peer | Another device this one has exchanged a pack with (`sync_peers`). |
| tombstone | A row saying "this favorite / note / import batch was deleted here, at this time". |

## Why change numbers and not timestamps

Phone and desktop clocks differ and users change them. A per-device counter needs no agreement:
a pack for peer P is "records whose `seq` is above the watermark last sent to P". Timestamps
(`updatedAt`, `createdAt`, `deletedAt`) are carried for display and for the conflict screen only;
no merge decision reads them.

## Container

A ZIP with the same rules as the full backup, reusing its reader and writer
(`lib/exporters/archive`): central directory parsed first, ZIP64, `validateEntryPath`, duplicate
and unlisted entries refused, every entry checked against the manifest's size and SHA-256, the
same `ArchiveLimits` (entry count, total bytes, per-entry bytes, compression ratio, manifest
size). Streaming `Unzip` for blobs; the record files are read line by line and never held whole.
The only limit that does not apply is `maxDatabaseBytes`: a pack has no database.

- File name: `memory-archive-changes-YYYY-MM-DD-<first 8 hex of the source device id>.zip`.
- Optional encryption: the `.mabackup` envelope of `docs/formats/encrypted-backup.md`, unchanged.
  The reader tells a pack from a backup by the manifest's `format` after decrypting; a plain pack
  holds every changed message and photo readably and is marked private in the UI like a plain backup.
- A full-backup reader given a pack (and the reverse) fails with a clear "this is a changes pack /
  a backup" error, because the `format` names differ.

### Layout

```
manifest.json                        first entry, deflated
records/profiles.jsonl               (record and batch files are deflated; blobs are stored)
records/conversations.jsonl
records/blobs.jsonl                  one line per media file the records need (hash, size, mime)
records/favorites.jsonl
records/notes.jsonl
records/tombstones.jsonl
batches/<batch id>.jsonl             one entry per import batch: header line, then its messages
blobs/<aa>/<sha256>                  media bytes, named and stored exactly as in the backup
```

Record files are UTF-8, one JSON object per line, every line ended by `\n` (no blank lines, none
longer than 4 MiB **in UTF-8 bytes**, enforced by writer and reader alike), always present (possibly empty). Entry paths are validated against these exact
shapes (`<batch id>` is a lowercase UUID). The writer is deterministic: records sorted by their
identity, batches by id, blobs by hash, a batch's messages in the order they were stored here, and
fixed key order, so the same library and clock give the same bytes.

### Manifest

```json
{
  "format": "memory-archive-changes",
  "formatVersion": 1,
  "createdAt": "2026-03-04T05:06:07.000Z",
  "app": { "name": "memory-archive", "version": "0.10.0" },
  "schemaVersion": 8,
  "kind": "changes",
  "source": { "deviceId": "<uuid>" },
  "target": { "deviceId": "<uuid>" },
  "since": 41,
  "upTo": 97,
  "ack": 33,
  "counts": { "profiles": 0, "conversations": 0, "batches": 0, "messages": 0, "favorites": 0, "notes": 0, "tombstones": 0, "blobs": 0 },
  "entries": [{ "path": "records/profiles.jsonl", "size": 0, "sha256": "..." }]
}
```

| Field | Rule |
|-------|------|
| `kind` | `changes`: records with `seq > since`, for one named device. `full`: every record, for any device. |
| `source.deviceId` | The device that built the pack. |
| `target.deviceId` | Required for `changes`, `null` for `full` (written as `"target": { "deviceId": null }`). A `changes` pack is only meaningful to the device whose watermark it was cut against, so a different device refuses it. |
| `since` | Exclusive lower bound of the source's `seq` in this pack. `0` for `full`. |
| `upTo` | Inclusive upper bound: the source's counter when it read the records. `since <= upTo`. |
| `ack` | The highest **target** `seq` the source has merged from the target (the source's received watermark for the target); `null` if it never received from it, and always `null` in a `full` pack (it has no named target, so any device could receive it, and a wrong ack would move that device's sent watermark past changes it never delivered). Tells the target what the source really has (see "Watermarks"). |
| `schemaVersion` | The source's database schema. A reader whose own schema is older refuses (`newer-schema`): records may carry meaning it cannot keep. |
| `counts`, `entries` | As in the backup manifest: sizes and hashes for every entry except the manifest; counts must equal the lines in the files. |

Compatibility is the backup's rule: a reader accepts every `formatVersion` it ever shipped and
refuses a newer one (`newer-format`) with a message. Adding an optional field a reader may safely
ignore does not bump the version; anything an old reader could misread or drop does.

## Records

All ids are the library's own stable ids (UUIDs, fingerprints, SHA-256 hashes), never local
integer row ids. `seq` in a record is the **source's** number for that record's last change.

```
profile        { id, displayName, relationship, description, photoSha256|null, archivedAt|null,
                 createdAt, updatedAt, seq }
conversation   { id, title, source, sourceKey, isGroup, createdAt, seq,
                 profileIds: [uuid],
                 participants: [{ displayName, profileId|null, isMe }] }   // only linked or "me" ones
blob           { sha256, size, mime|null }
favorite       { conversationId, fingerprint, createdAt, seq }
note           { target: { kind: "profile", profileId }
                       | { kind: "conversation", conversationId }
                       | { kind: "message", conversationId, fingerprint },
                 body, createdAt, updatedAt, seq }
tombstone      { kind: "favorite"|"note"|"batch", scope, key, deletedAt, seq }
batch header   { id, conversationId, source, sourceLabel, createdAt, createdConversation, seq }
batch message  { fingerprint, sentAt, ordinal, type, author|null, body, mediaSha256|null, mediaName }
```

`scope` and `key` of a tombstone are exactly the schema's: favorite = (conversation id, message
fingerprint); note = (`''` or the conversation id, `profile:<id>` | `conversation` |
`message:<fingerprint>`); batch = (conversation id, batch id).

Locally, favorites and tombstones carry `changed_by` like profiles, conversations and notes (NULL =
made here; a peer's id = the version merged from that peer). It is not part of a record on the
wire. A tombstone written here (an unfavorite, an emptied note, an undo) is always NULL, even when
it replaces one merged from a peer.

Removing a conversation (undoing the import that created it when nothing else is left in it)
deletes the conversation's favorites, notes and other batches with it. Each of those deletions
leaves its own tombstone, in the same transaction, so a peer sees them as ordinary deletions. The
tombstone of a *batch* is informational (see "Deletions").

Messages never change and are never edited, so they have no `seq` and no record of their own:
they travel inside their import batch, deduplicated by fingerprint on arrival. A message's
`author` is the display name as the source named it; the receiver finds or creates the
participant by `(conversation, name)`.

### What a pack contains

For `changes` with watermark `since`: every profile, conversation, favorite, note, tombstone and
import batch whose `seq > since`; for each batch all its messages. Then the **closure**: the
records those reference, even if unchanged (profiles named by an included conversation, the
conversation of an included batch, favorite or note), and the blob rows and bytes referenced by
included messages and profile photos. So a pack never points at something it does not carry and
the receiver needs no "missing reference" case. For `full`: everything, including every blob.

Blobs are included even if the target already has them: the source does not know what the target
holds, and listing hashes would need a round trip. The receiver skips bytes it has by hash.
(Lossy in size, not in data: the common phone-to-desktop case sends only new batches.)

## Merge

One transaction per pack, applied in this order, so references always resolve:
blobs, profiles, conversations, batches (with messages), favorites, notes, tombstones. A failure
anywhere leaves the library exactly as it was, **including the received watermark**
(`recordReceived` runs in the same transaction). Heavy work (unzip, parse, hash) runs in the
worker like an import.

Notation: `S` = the pack's source, `lastReceived` = `sync_peers.last_received_seq` for S and
`lastSent` = `last_sent_seq` for S, both read at the start of the merge. For an incoming record
`I` and a local record `L`:

- *S changed it* = `I.seq > lastReceived`. (Otherwise this is a replay or closure record and `L`,
  if present, is at least as new.)
- *we changed it* = `L.seq > lastSent` **and** `L.changed_by` is not S. (We edited it since S last
  saw our data; a version we merely merged from S does not count against S.)

### Blobs and messages

- Blob: exists by hash, skip; else store the bytes (hash-verified) and the row. Never overwritten.
- Batch: if a batch with that id exists locally, or a local tombstone for it exists (we undid it),
  skip the whole batch. Otherwise insert its messages with "do nothing on conflict" on
  `(conversation, fingerprint)`. If none were new the batch is **not** recorded (no empty history
  entry; running it again is still a no-op). Otherwise record the batch under the **same id**
  with `added` = the new messages and `skipped` = the rest, so a synced batch can be undone here
  like any import. Idempotent: the same message twice is one row.

### Profiles, conversations, notes (editable records)

| Local `L` | Rule |
|-----------|------|
| absent (notes: and no local tombstone) | Insert `I`; `changed_by = S`; new local `seq`. |
| equal content | Nothing. Same bytes in, same state out: this is what makes a second import a no-op. |
| different, S did not change it | Keep `L`. |
| different, S changed it, we did not | Take `I` (fast-forward); `changed_by = S`; new local `seq`. |
| different, both changed it | **Conflict**: keep `L` active, keep `I` beside it (below). |

"Content" excludes `seq`, `changed_by` and, for profiles and notes, `updatedAt`.
A conversation's content includes its profile links and its participants' profile / "me" links;
profiles are archived, never deleted (`archivedAt` is an ordinary field).

### Favorites (a set; add wins)

A favorite has no content to edit. `I` present and S changed it: create it here if absent
(`changed_by` does not apply), and remove any local tombstone for it. `I` not changed by S: skip.

### Deletions (tombstones)

- **Favorite** tombstone `T`: if the favorite exists locally and we did not (re)create it since S
  last saw our data, delete it and keep `T` (so it travels on to other devices). If we did, the
  favorite stays: **add wins**, nothing is lost. If it does not exist, keep the newer tombstone.
- **Note** tombstone `T`: if the note exists locally and we did not change it since S last saw it
  (or it came from S), delete it and keep `T`. If we edited it: **conflict** ("deleted there,
  edited here"): the note stays, the deletion is kept beside it.
- An incoming note against a local note tombstone (we deleted it): if S changed it and S had not
  yet seen our deletion (`T.seq > lastSent`), **conflict**: the note is stored beside, not
  resurrected. If S had seen our deletion and wrote the note afterwards, take it.
- **Import batch** tombstone ("S undid this import"): **not applied automatically.** Messages
  are the irreplaceable part of an archive and deleting them on one device because of an action
  on another is the one thing a manual sync must not do silently. The tombstone is listed for
  review ("Maria's phone undid the import of N messages from ...; remove here too?"); accepting
  runs the normal undo on this device, which records our own tombstone. The batch id matches
  because a synced batch keeps its id; if the messages came in through a different batch here, the
  user is told it cannot be matched. This is the only place where two devices deliberately do
  not converge by themselves.

### Conflicts

A conflict never changes the active record and never drops the incoming one. The merge stores
the incoming version (or incoming deletion) with its peer, kind and key in a conflicts list and
reports the count; the user later picks **mine**, **theirs**, or for a note **both** (the other
body appended below). Resolving is an ordinary local edit: it takes a new `seq`, travels as a
normal change, and on the other device it fast-forwards (that device's version was already sent
and is unchanged since). The schema for that list is added with the merge use case, which is its
first entry point (no table for it yet).

Granularity is the whole record: S renaming a person and this device editing the same person's
description is a conflict even though the fields differ, because the pack carries no base version
to compare fields against. Accepted for v1: false conflicts cost a click, not data.
While a conflict is open the two devices show different active versions; they converge once
either resolves it.

## Watermarks and the peer table

`sync_peers(peer_id, last_sent_seq, last_sent_at, last_received_seq, last_received_at)`; absent
row = never exchanged = watermarks 0.

- **Building** a `changes` pack for P: `since = lastSent(P)` (0 if P is unknown: still a `changes`
  pack, pinned to P); read the counter and the records in one synchronous step (`upTo`); set
  `ack = lastReceived(P)` (or null). **Building never moves a watermark.** Only after the file has
  been handed to the user (saved or shared) does the caller confirm it, which runs
  `recordSent(P, upTo, since)` (`confirmChangesPackDelivered`; it refuses if the library was restored in
  between). For a `changes` pack the move is a compare-and-set: the watermark becomes `upTo` only
  if it is still exactly the pack's `since`. If an `ack` lowered it meanwhile, or another pack was
  confirmed first, nothing is recorded and the result says `recorded: false`: a late confirmation
  can never undo the ack or move the watermark backwards. A `full` pack (since 0 by construction)
  only moves it forward. An export that is cancelled, fails or is never confirmed records nothing, so the next
  pack covers the same changes again. A device not known yet (no id to name) gets a `full` pack:
  there is no peer to record against, and its answer carries the `ack` that sets our sent
  watermark. A `full` pack can also be forced for a known peer (the remedy for a `gap`); confirming
  it records the watermark for that peer.
- **Merging** a pack from S, before anything else: refuse if `target` is not this device
  (`wrong-device`); if the source is this device (`own-pack`); if `kind = changes` and
  `since > lastReceived(S)` (`gap`: a pack between was never merged; the sender must send a
  `full` pack or catch up first). `since <= lastReceived` is fine: the overlap is skipped by the
  *S changed it* test. On success, `recordReceived(S, upTo, ack)` in the same transaction:
  `lastReceived = max(old, upTo)` and `lastSent = min(ack, our counter)`.
- **Why `ack` replaces `lastSent`**: `recordSent` is optimistic (the pack may never arrive, or be
  imported on the wrong machine). The peer's next pack says what it really merged; if that is
  lower than we recorded, we move back and resend (a resend is a harmless replay). A lost pack
  therefore heals on the next round trip, with no silent loss and no manual reset. A one-way flow
  (only the phone exports) never gets an ack; the receiver's `gap` check turns a missing pack
  into a clear error instead of a quiet hole.
- Records merged from S take a fresh local `seq`, so they reach a third device C through us
  (phone -> desktop -> tablet). They are also offered back to S, where they are equal and a
  no-op. The exporter does not skip them (an optimization, not needed for correctness).

### Device identity across restore and replace

The migration creates the `device` row (random id, counter 1), so reading the id never changes the
database file. A restored library is a **new device**: `loadSnapshot` ignores the backup's `device`
and `sync_peers` and creates a fresh id and an empty peer table (`renewDevice`). The counter
continues from the highest change number actually present in the backup (the maximum of every
`seq` and of the stored counter, never the stored counter alone, which a damaged file could set too
low). A change number that is negative or not a safe integer makes the backup invalid and the
target stays untouched. Same for "replace library with a backup". Reasons:

1. Two machines restored from the same backup must not share an id, or each would believe the
   other has seen changes it never saw.
2. Rolling one machine back to an older backup would leave its peers holding a watermark above
   data it no longer has; their next changes pack would skip changes the machine lost.
3. Cost: the first exchange after a restore is a `full` pack. Records are merged by identity, so
   nothing is duplicated; records both sides edited since the backup show up as conflicts, because
   without watermarks the common ancestor is unknown. Documented and accepted.

Tombstones travel in backups (they are data); the device row and peers do not. For deciding
whether a restore may go ahead without replacing anything, a library is empty when it holds no
content: its `device` row, its `sync_peers` and its `tombstones` do not count, so a library emptied
by undoing every import (or one that only exchanged packs) is still empty and its tombstones are
replaced by the backup's.

## Idempotency and convergence

- Same pack twice: blobs exist, batches exist or are tombstoned, editable records equal or
  stale, favorites present, tombstones already stored; the received watermark does not move. No
  row changes, no new `seq` is taken.
- Packs in a different order, or relayed: messages and blobs are sets keyed by identity;
  favorites are an add-wins set; editable records either fast-forward or become conflicts, never
  an arbitrary pick. Conflicts and unapplied batch tombstones are the only residue by design, and both wait
  for the user.
- Decisions use watermarks, never clocks. A device whose clock is wrong still merges correctly;
  only the displayed times are off.

## Why not reuse the backup database

The backup ships `db/library.sqlite`. For a merge that would mean opening another device's
database next to ours and diffing it: SQL against untrusted tables (triggers, views and virtual
tables are refused in a backup for exactly this reason), local integer ids that collide, and
a whole library sent for one new photo. JSON lines are streamable, size-bounded per line, easy
to validate, independent of the schema of either side (only `schemaVersion` gates), and the same
records can be listed on a conflict screen. The container, limits, hashing, blob layout and
encryption are the backup's, unchanged.

## Schema v8 (what this format needs, nothing more)

| Change | Why |
|--------|-----|
| `device(singleton, id, created_at, change_seq)` | Identity and the counter. Row created on first use, not by the migration, so a restore can never inherit an id. |
| `seq` on profiles, conversations, import_batches, favorites, notes | The only thing a changes pack selects on. Backfill: `1` for every existing row and counter start `1`, so "since 0" is the whole library and any later change is higher. Deterministic: no clock, no ordering. |
| `changed_by` on profiles, conversations, notes | Stops a merged version counting as a local edit against the same peer. NULL = made here. |
| `tombstones(kind, scope, key, deleted_at, seq)` | Deletions of favorites, notes and batches have to be able to travel. Written by the same code paths that delete. Cleared when the target is recreated. |
| `sync_peers` | The watermarks. |
| Indexes on `favorites.seq`, `notes.seq` | The two tables that can be large; the others are small. |

No triggers (a snapshot containing one is refused); stamping is done by the write paths in
`lib/db/queries.ts` through `lib/db/sync.ts`, and every path has a test that the stamp moves and
that a no-op does not stamp. Messages, participants, blobs and highlights have no `seq`.

**Stamping requirement for participants.** Participants have no `seq` of their own: their
`profile_id` / `is_me` travel inside the conversation record, so every write that changes them
must `stampRows(db, 'conversations', ...)` (setting "me" on import already does, and is tested).
Today nothing writes `participants.profile_id` after creation; the merge (queue item 15) will, and
it must stamp the conversation or the change never reaches a third device.

**Limits are checked before anything is handed over.** The writer bounds each record line, each
staged file (`maxEntryBytes`), the sum of all entries (`maxTotalBytes`), the entry count and the
central directory (including every entry name) with the same `ArchiveLimits` the reader applies,
and fails with `limit-exceeded` instead of producing a pack its own reader would refuse.

## Known limits (lossy or open, on purpose)

1. **Record-level conflicts** (no field merge): more clicks, never lost text.
2. **Undo of an import is a suggestion** to other devices, never an automatic delete.
3. **Highlights are not synced** (re-import the findings file; they are in full backups).
4. **Two profiles for one person.** Profile ids are generated per device, so the same person
   created independently on both devices stays two profiles after a sync. Nothing is lost;
   there is no merge-two-profiles feature yet (conversations can be moved with the existing move).
5. **A conversation deleted on one device by undoing its only import is re-created** if another
   device later sends a batch for it. There is no conversation tombstone, so nothing can block this;
   only the new messages arrive.
6. **First exchange after a restore is large and may be conflict-heavy** (see above).
7. **Pack size**: blobs the target already has are still shipped in a pack that references them.
8. **Tombstones are never purged.** They are a few dozen bytes each; purging needs every peer's
   watermark, which a manual workflow cannot know.
9. **A plain pack is as private as a plain backup**: use the encrypted envelope for anything that
   leaves the device through a service the user does not control.
10. **Two people editing one library on one device** is not a case: a library is one person's.
