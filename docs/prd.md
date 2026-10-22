<!--
Product requirements as written by the project owner (2026-10-20).
Architecture decisions taken after the Phase 0 assessment (PWA, local-only storage, no Google
APIs, manual ZIP sync) are recorded in docs/roadmap.md and take precedence where the PRD lists
options to evaluate.
-->

# Memory Archive — Product Requirements & Architecture

## 1. Project overview

**Project:** Memory Archive  
**Repository:** `rwxce/memory-archive`  
**Upstream:** https://github.com/guionardo/wa-backup  
**Type:** Multi-profile, offline-first personal memory preservation platform.

### Mission

Build a completely offline application that allows users to preserve, organize, update, explore, export and restore their personal memories.

Memory Archive is not limited to preserving memories of deceased relatives.

It must support any number of people, including parents, partners, friends and other important contacts.

Each person has an independent profile containing conversations, photographs, videos, voice messages and associated memories.

The application must support incremental imports, multiple profiles, unified backups and long-term data portability.

**Core principle: Users must always own their memories and be able to recover their entire archive independently of the application.**

---

## 2. Multi-profile system

The application must support creating, editing, organizing and archiving multiple personal profiles.

A profile represents a person whose memories the user wants to preserve.

### Profile properties

Each profile should support:

- Unique immutable identifier (UUID).
- Display name.
- Optional profile photograph.
- Optional description.
- Optional relationship (mother, father, friend, partner, etc.).
- Creation date.
- Last updated date.
- Associated conversations.
- Associated media.
- Import history.
- User annotations.
- Favorites.

Example:

```text
Memory Archive
│
├── Mama
│   ├── WhatsApp conversations
│   ├── Photographs
│   ├── Videos
│   ├── Voice messages
│   └── Personal memories
│
├── Papa
│   ├── WhatsApp conversations
│   ├── Photographs
│   └── Voice messages
│
├── Anna
│   ├── WhatsApp conversations
│   └── Photographs
│
└── Marc
    ├── WhatsApp conversations
    ├── Videos
    └── Personal memories
```

Profiles must never depend exclusively on a contact's phone number or display name.

Phone numbers and contact names may change over time.

### Profile creation

Users must be able to create a profile before importing any information.

The application should allow:

1. Creating a new profile.
2. Choosing its name.
3. Setting an optional photograph.
4. Defining an optional relationship.
5. Importing memories into the newly created profile.

Users must also be able to create an empty profile and import data later.

---

## 3. Multi-conversation support

The application must support multiple independent conversations.

A profile may have one or several historical conversations.

Examples:

- Different WhatsApp exports from different years.
- Conversations associated with previous phone numbers.
- Historical conversations imported from different devices.
- Conversations from additional messaging platforms in future versions.

### Conversation requirements

Each conversation should have:

- Unique identifier.
- Associated profile or profiles.
- Original platform.
- Original chat identifier when available.
- Conversation title.
- Date range.
- Original participants.
- Import sources.
- Message count.
- Media references.

**Do not enforce a one-profile-to-one-conversation relationship.**

The data model must support multiple conversations and multiple participants without duplicating original message data.

For group chats, participants and profile associations must remain explicit.

A conversation involving several people must not automatically be treated as a private conversation with one person.

---

## 4. Incremental imports

This is a critical requirement.

Users must be able to import new conversations, photographs and media into existing profiles without recreating the archive.

### Import workflow

1. Open Memory Archive.
2. Select **Import memories**.
3. Select one or multiple files.
4. Choose the source format.
5. Select an existing destination profile or create a new one.
6. Preview the detected content.
7. Review duplicates and potential conflicts.
8. Confirm the import.
9. Merge new data into the archive.
10. Display an import summary.

### Destination assignment

**Every import must allow explicit selection of the destination profile.**

Example:

```text
Import memories

Source:
WhatsApp Export — Chat.zip

Destination profile:
[Mama                 v]

Detected:
- 12,450 messages
- 320 photographs
- 18 videos
- 146 voice messages

Duplicates:
- 8,240 existing messages

New content:
- 4,210 messages
- 75 media files

[Cancel] [Import memories]
```

Counts are illustrative.

### Multiple-file imports

Users must be able to select multiple files during one import operation.

The application should support batch processing and assigning each source to a destination profile.

Users should not be forced to complete the entire import workflow separately for every contact.

### Duplicate handling

Repeated imports must not create duplicated messages or media.

Duplicate detection should use stable identifiers when available.

When stable identifiers are unavailable, use carefully designed content fingerprints incorporating relevant source information.

Do not assume that two messages with identical text and timestamps are necessarily the same message.

Files with identical hashes can be stored once while maintaining references from multiple profiles or events.

The importer should support safe, repeatable and idempotent imports.

### Import transactions

Imports must not corrupt existing archives.

If an import fails halfway through, it must be possible to roll back the incomplete operation or resume safely.

The application must clearly report:

- Successfully imported items.
- Skipped duplicates.
- Unsupported content.
- Missing media.
- Errors.
- Warnings.

---

## 5. Supported import sources

### Initial support

- WhatsApp TXT exports.
- WhatsApp ZIP exports.
- WhatsApp media attachments.
- Google Photos Takeout archives.
- Individual photographs.
- Individual videos.
- Individual audio files.

Evaluate which formats the upstream project already supports before implementation.

### Future extensibility

Design an importer abstraction allowing additional sources, such as:

- Telegram.
- Signal exports, where supported.
- SMS backups.
- Email archives.
- Other messaging platforms.

Do not implement every integration in the initial release.

---

## 6. Historical timeline per profile

Each profile must have its own chronological timeline.

The timeline combines historical conversations and media associated with that person.

### Required functionality

- WhatsApp-style message visualization.
- Original timestamps.
- Chronological media integration.
- Voice-message playback.
- Video playback.
- Date navigation.
- Search.
- Favorites.
- Original source identification.
- Multiple conversations.
- Timeline virtualization for large archives.

Users should be able to switch between:

**Combined profile timeline:** all memories associated with a person, ordered chronologically.

**Conversation view:** messages and attachments from a specific conversation.

**Media gallery:** photographs and videos associated with the profile.

**Audio archive:** voice messages and audio files.

### Google Photos association

Photographs from Google Photos must not be automatically assigned to a person based solely on dates.

Allow the user to select and associate photographs with one or multiple profiles.

Preserve original metadata and avoid copying identical media unnecessarily.

---

## 7. Persistent local storage

The application requires persistent local data storage.

The archive must not depend exclusively on browser localStorage, IndexedDB or browser cache.

Choose an appropriate portable architecture after inspecting the upstream repository.

### Proposed approach

Consider SQLite for structured data and a local filesystem for original media.

Maintain a documented, versioned data model.

Conceptual entities:

```text
Archive
  ├── Profiles
  ├── Conversations
  ├── Participants
  ├── Messages
  ├── Media
  ├── TimelineEvents
  ├── ProfileEventAssociations
  ├── ImportBatches
  ├── Favorites
  └── Metadata
```

Separate source data from user-defined associations.

A user must be able to move a mistakenly imported conversation to another profile without physically duplicating or unnecessarily reimporting its data.

---

## 8. Complete backup and restore

**This is one of the highest-priority features.**

The user must be able to export the entire Memory Archive library into a single portable backup file.

### Full backup

Provide an action:

**Export complete archive**

This generates a file such as:

```text
memory-archive-backup-2026-10-20.zip
```

The backup must include:

- Every profile.
- Every conversation.
- Every message.
- All available photographs.
- All available videos.
- All available voice messages.
- Associated documents.
- Timeline metadata.
- Profile associations.
- Favorites.
- User annotations.
- Import history.
- Application preferences relevant to the archive.
- Database or equivalent structured data.
- File integrity manifest.
- Archive format version.

The backup must be self-contained.

It must not depend on references to files that only exist on the original computer.

### Full restoration

Provide an action:

**Restore archive from backup**

Workflow:

1. Install or open Memory Archive on a new computer.
2. Select the backup ZIP.
3. Validate the archive.
4. Verify compatibility.
5. Verify file integrity.
6. Choose the restoration destination.
7. Restore all data.
8. Confirm restoration success.

After restoration, all profiles, conversations, media and user preferences must be available.

The user must not need to reimport every WhatsApp or Google Photos export individually.

### Restoration modes

Support or evaluate:

- Restore into an empty library.
- Replace an existing library after explicit confirmation and a safety backup.
- Merge two libraries with conflict detection.

The initial MVP must support full restoration into an empty library.

Merge restoration can be developed later.

### Backup security

Investigate optional password-protected encrypted backups using established cryptographic standards.

Unencrypted backups must be clearly identified as containing private information.

Implement strict ZIP extraction protections, including path traversal prevention, decompression limits and file validation.

---

## 9. Portable viewer exports

Full archive backups and viewable exports are different deliverables.

**Do not confuse backup functionality with HTML export.**

### A. Complete archive backup

Contains all editable and restorable application data.

Primary purpose: disaster recovery and migration.

### B. Single-profile export

Generate a portable package containing the memories of one selected person.

Possible formats:

- HTML.
- JSON.
- Markdown.
- ZIP with media.

### C. Complete read-only viewer

Generate a portable viewer containing all selected profiles and their associated memories.

Requirements:

- Offline operation.
- No remote backend.
- No external CDN.
- Local media access.
- Cross-platform compatibility.
- Search and timeline navigation where technically feasible.

### Export configuration

Allow users to choose:

- One profile.
- Multiple profiles.
- All profiles.
- Date ranges.
- Media inclusion.
- Export format.

The complete archive backup must always include all profiles and information required for restoration.

---

## 10. Application screens

The UX/UI design must now account for multiple profiles and archive management.

### Screen 1 — Home / People

Main application entry point.

Display all profiles as cards or a list.

Each profile displays:

- Photograph.
- Display name.
- Relationship, if available.
- Number of memories.
- Date range.
- Last import date.

Primary actions:

- Open profile.
- Add person.
- Import memories.
- Export complete archive.

### Screen 2 — Profile details

Personal memory space for a selected person.

Sections:

- Timeline.
- Conversations.
- Photographs.
- Videos.
- Audio.
- Favorites.

### Screen 3 — Timeline

Chronological combination of associated messages and memories.

### Screen 4 — Conversations

Show the profile's historical conversations separately.

### Screen 5 — Media gallery

Photographs and videos associated with a person.

### Screen 6 — Calendar

Navigate events by year, month and day.

### Screen 7 — Import wizard

Guided import process.

Must support:

- Multiple files.
- Source detection.
- Profile assignment.
- Profile creation.
- Preview.
- Duplicate detection.
- Confirmation.
- Results.

### Screen 8 — Import history

Show previous import operations.

Information:

- Import date.
- Source.
- Destination profiles.
- Imported item counts.
- Duplicates.
- Errors.
- Status.

### Screen 9 — Backup and restore

Dedicated section for:

- Full backup.
- Full restoration.
- Integrity verification.
- Portable exports.
- Storage statistics.

### Screen 10 — Settings

- Local storage configuration.
- Appearance.
- Archive management.
- Security.
- Data portability.
- Application version.
- Archive format version.

---

## 11. Offline-first architecture

All processing must happen locally.

No mandatory:

- Backend.
- Cloud hosting.
- User accounts.
- Remote APIs.
- Subscription.
- Telemetry.
- Third-party analytics.
- Network connectivity.

The application may use a local processing service or packaged desktop runtime if necessary.

Evaluate the advantages of:

- CLI + static HTML viewer.
- Local application with filesystem access.
- Tauri desktop application.
- Electron desktop application.
- Browser-based viewer.

A browser-only interface may not provide reliable unrestricted local filesystem access.

Select an architecture that supports persistent storage, large file imports, complete backups and restoration without sacrificing portability.

---

## 12. Data integrity and lifecycle

### Mandatory principles

1. Original files must remain immutable.
2. Imports must be repeatable.
3. Duplicate handling must be deterministic where possible.
4. Profile reassignment must be supported.
5. Backup restoration must be tested.
6. All important data must be exportable.
7. Source provenance must be retained.
8. Schema migrations must be versioned.
9. Missing files must be detectable.
10. The application must remain usable without network connectivity.

### Additional requirements

Use cryptographic hashes to detect file corruption.

Avoid relying on absolute paths tied to one computer.

Store paths relative to the archive root where applicable.

Support archival migration between operating systems.

Handle Unicode filenames and international date formats.

Preserve timezone information.

Do not silently discard messages or media because a parser encounters unexpected formatting.

---

## 13. Development roadmap

### Phase 0 — Repository audit

Inspect the actual `wa-backup` implementation.

Determine:

- Existing parsers.
- Export capabilities.
- Data model.
- Dependencies.
- Tests.
- Media handling.
- Licensing.
- Architectural limitations.

### Phase 1 — Multi-profile foundation

Implement:

- Profile creation.
- Profile editing.
- Profile identifiers.
- Conversations.
- Profile associations.
- Persistent local storage.

### Phase 2 — Incremental WhatsApp imports

Implement:

- Multi-file import.
- Destination selection.
- Deduplication.
- Import history.
- Safe transaction handling.

### Phase 3 — Google Photos integration

Implement:

- Google Takeout importer.
- Metadata processing.
- Profile association.
- Chronological normalization.

### Phase 4 — UX/UI

Design and implement:

- People dashboard.
- Profile details.
- Timeline.
- Conversations.
- Media gallery.
- Calendar.
- Import wizard.
- Backup management.

### Phase 5 — Full backup and restore

Implement:

- Complete ZIP backup.
- Integrity manifest.
- Validation.
- Full restoration.
- Cross-platform tests.

**A minimal backup/restore proof of concept should be implemented earlier, alongside persistent storage, to avoid architectural lock-in.**

### Phase 6 — Portable exports

Implement:

- Individual profile exports.
- Multi-profile HTML exports.
- JSON exports.
- Offline viewer packages.

### Phase 7 — Hardening

Test:

- Large archives.
- Multiple profiles.
- Repeated imports.
- Failed imports.
- Duplicate data.
- Missing media.
- Corrupted backups.
- Restoration on a clean machine.
- Browser and operating-system compatibility.

---

## 14. Acceptance criteria

The project is successful when the following scenario works reliably:

1. A user installs Memory Archive.
2. Creates a profile called "Mama".
3. Imports five years of WhatsApp conversations.
4. Imports Google Photos memories.
5. Associates selected photographs with Mama.
6. Creates another profile called "Papa".
7. Imports WhatsApp conversations for Papa.
8. Creates eight additional profiles.
9. Imports additional conversations for several profiles in a single batch.
10. Later imports another WhatsApp export for Mama.
11. Existing messages are preserved without unnecessary duplication.
12. The user can navigate the timeline of each person.
13. The user exports a single complete backup ZIP containing all ten profiles.
14. The original computer is lost.
15. The user installs Memory Archive on a different computer.
16. Imports the complete backup ZIP.
17. Every profile, conversation, media file and association is restored.
18. The user can export a complete offline HTML viewer or an individual person's archive.

**No original WhatsApp or Google Photos exports should be required for restoration after a verified complete backup has been created.**

---

## 15. Instructions for the coding agent

Do not immediately implement the application.

First complete a technical assessment and propose:

1. Repository audit.
2. Recommended local persistence architecture.
3. Multi-profile database schema.
4. Canonical event and conversation models.
5. Import and deduplication strategy.
6. Complete backup/restore format.
7. Offline viewer export strategy.
8. Screen-by-screen UX/UI architecture.
9. Implementation milestones.
10. Technical risks and mitigation strategies.

Pay particular attention to separating the internal archive format from the read-only HTML viewer.

Avoid destructive operations and unnecessary full reimports.

The application should scale from one person to hundreds of profiles without requiring architectural redesign.

**The highest priority is not merely viewing old conversations. It is maintaining a permanent, expandable, recoverable and fully portable collection of personal memories.**