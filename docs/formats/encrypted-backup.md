# Encrypted backup envelope (version 1)

An optional password-protected form of the backup. It wraps the bytes of the normal backup ZIP
(see `lib/exporters/archive/format.ts`) **unchanged**: the ZIP, its manifest and its
`formatVersion` are not touched. Code: `lib/exporters/archive/encrypt.ts`. No dependency: WebCrypto
only (`crypto.subtle`), which needs a secure context (HTTPS or localhost).

- File name: `memory-archive-YYYY-MM-DD.mabackup` (a plain backup stays `.zip`). The distinct,
  opaque extension stops people trying to unzip it. Detection never relies on the name: a file
  starting with the 8 bytes `MABACKUP` is encrypted; a ZIP starts with `PK`.
- Unencrypted backups hold every message and photo readably. `ExportArchiveResult.encrypted`
  is `false` for them; the UI marks them as private.

## Primitives

| What | Choice | Why |
|------|--------|-----|
| Cipher | AES-256-GCM, 128-bit tag | Authenticated, in every WebCrypto |
| KDF | PBKDF2-HMAC-SHA-256, 600,000 iterations (written) | Only password KDF in WebCrypto (OWASP 2023 figure). Argon2 would need a WASM dependency |
| Salt | 16 random bytes per file | A new key per file, so a (key, IV) pair is never reused across files |
| IV | 12 bytes = 8 random bytes (per file) + 4-byte big-endian chunk index | Unique per chunk within a file |
| Password | UTF-8 of `password.normalize('NFC')` | The same password typed on another keyboard or OS (composed vs decomposed accents) derives the same key. Nothing else is altered: no trim, no case folding |

## Layout (all integers big endian)

```
header, 44 bytes
   0   8  magic "MABACKUP"
   8   1  envelope version (1)
   9   1  KDF id (1 = PBKDF2-HMAC-SHA-256)
  10   2  reserved, zero
  12   4  PBKDF2 iterations
  16   4  plaintext chunk size in bytes (1 MiB written; at least 4 KiB)
  20  16  salt
  36   8  IV base
key check, 33 bytes: AES-GCM seal of the ASCII text "memory-archive-ok"
chunks: AES-GCM seal of each plaintext slice (ciphertext + 16-byte tag)
```

Chunk `i` (0-based) is `chunk size` bytes of the ZIP, except the last, which holds the rest
(possibly 0 bytes for an empty input; a ZIP is never empty, but the writer emits one chunk
anyway). So every stored chunk is `chunk size + 16` bytes except the last, and the reader derives
the chunk count from the file size. The key check is sealed like a chunk with index `0xFFFFFFFF`
and final = 1.

Every seal uses `AAD = header (44) || chunk index (u32) || final flag (u8: 1 for the last chunk)`.
So:

- header tampering (salt, iterations, chunk size, reserved bytes, IV base, version) fails
  authentication or the key check;
- a reordered, duplicated, dropped or substituted chunk fails (index in the AAD and IV);
- a chunk from another backup fails (different salt, so a different key, and a different header);
- truncation fails, even at a chunk boundary (the new last chunk was sealed with final = 0);
  appended bytes fail the same way.

## Reading rules

1. No magic: `not-an-archive` (callers treat the file as a plain ZIP first).
2. Version greater than 1: `newer-format`. Version 0 or an unknown KDF id: `integrity`.
3. Before any key derivation, bounds on the untrusted header: iterations in
   `[10,000 .. 2,000,000]` (the writer uses 600,000), chunk size in `[4 KiB .. 16 MiB]`; outside:
   `limit-exceeded`. A hostile file cannot make the app burn CPU, allocate a huge chunk, or
   demand one WebCrypto call per few bytes. The writer enforces the same bounds.
4. Derive the key, open the key check. Failure: `wrong-password`. A header damaged so that the key
   or the AAD changes lands here too: it cannot be told apart from a wrong password, and
   the message says so. Once the key check passes, the password is right.
5. Open every chunk in order; any failure is `integrity` ("damaged"). Everything is authenticated
   before the first byte is returned, so a truncated file never yields a partial ZIP.
6. A missing password is `password-required`; no WebCrypto is `encryption-unavailable`.

Errors carry fixed text only: never the password, file names or content. Nothing is logged.
`ArchiveError.cause` may carry the raw `DOMException` from WebCrypto; it must not be serialized
or logged.

## Memory

The input is read as `Blob` slices of one chunk and the output is a `Blob` of parts, folded into a
sub-`Blob` every 16 MiB so the JS heap holds only about that much plus one chunk. Restore and
verify decrypt the whole file to a `Blob` first (browsers may keep it outside the heap), then
read the ZIP as usual. Progress (`{done, total}` plaintext bytes) and `AbortSignal` (checked
between chunks) are supported. Key derivation is a single WebCrypto call that cannot be
interrupted, so Cancel takes effect only after it finishes (at most a few seconds at 600,000
iterations); the signal is checked between steps.

Honest limits: restore holds the encrypted file and the decrypted `Blob` at the same time, and
folding bounds the JS heap, not total memory. Multi-GB backups may fail on Safari/iOS. The
safety copy of the current library made before a replace is not encrypted and is unaffected.

## Compatibility

Version 1 is the only one. The format is unreleased, so the bounds above (chunk floor, iteration
ceiling) were tightened without a new version. A reader must refuse a newer version with `newer-format` and never guess.
Changing any constant above (iterations written, chunk size) needs no new version, since both are
in the header; a new cipher, KDF or layout does, and old readers must stay supported.
The safety backup that "replace a library" downloads is not encrypted.
