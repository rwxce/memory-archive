# Privacy

Memory Archive handles some of the most personal data a person has. These are the rules the
code must keep.

## Where data lives

| Data | Location |
| ---- | -------- |
| App code (HTML/JS/CSS) | Downloaded once from the public URL, cached by the service worker. Contains no user data. |
| Archive database (profiles, conversations, messages, favorites, notes, associations) | SQLite inside the browser's private file system (OPFS) on **this device only**. |
| Photos, videos, voice messages | Same private file system, stored once per content hash. |
| Thumbnails of photos | Same private file system, a cache derived from your photos so the gallery loads fast. Kept only on this device, never included in a backup, and safe to delete: they are made again when needed. |
| Backups and change packs | ZIP files the user explicitly exports and moves wherever they want. |

The CLI writes only to the output folder the user chooses.

## What the app never does

- Send chats, media or metadata to any server — ours or anyone else's.
- Require an account, a login or an API key.
- Include analytics, telemetry, crash reporting or third-party scripts / CDNs.
- Read files the user did not explicitly pick or share with it.

## Network access

- Loading and updating the app itself (static files).
- Nothing else by default. Any future feature that needs the network (for example fetching
  link titles) must be **opt-in**, off by default, and explained in the UI.

## Backups

- Your notes (on a person, a conversation or a message) are personal text you wrote: they are stored in the
  archive database, so they are inside every backup, and the app never logs or sends their text.
  A note stays with its conversation: removing a conversation removes its notes too.

- Unencrypted backups are clearly labelled as containing private information.
- Optional password-encrypted backups (AES-GCM, key derived from the password with WebCrypto)
  are planned for Phase 6.
- Restores validate the manifest, file hashes, paths (no `..`, no absolute paths) and sizes
  before writing anything.

## Development

- Never commit real WhatsApp exports, photos or chat text. Tests use synthetic fixtures from
  `scripts/generate-fixtures.mjs`.
- `fixtures/`, `output/`, `backup/`, `data/`, `*.zip` and `_chat.txt` are hidden from AI agents
  (`.rulesync/.aiignore`).
