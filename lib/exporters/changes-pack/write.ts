import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { CHANGES_PACK_FORMAT_NAME, CHANGES_PACK_FORMAT_VERSION, type ChangeSet, type PackMessage } from '../../domain/changes-pack';
import { createSha256 } from '../../domain/sha256';
import { ArchiveError, DEFAULT_LIMITS, MANIFEST_PATH, blobPath, isSha256Hex, type ArchiveLimits, type ManifestEntry } from '../archive/format';
import { MAX_RECORD_LINE_BYTES, batchPath, recordPath, type ChangesPackCounts, type ChangesPackManifest, type RecordFileName } from './format';

export interface ChangesPackSource {
  app: { name: string; version: string };
  /** Instant recorded in the manifest and used as every entry's timestamp. */
  createdAt: Date;
  /** Everything but the messages, cut at one moment (`readChangeSet`). */
  changes: ChangeSet;
  /** The messages of one batch of `changes.batches`, in pages. */
  batchMessages(batchId: string): AsyncIterable<readonly PackMessage[]>;
  /** The stored bytes of one blob, or `undefined` when absent. */
  openBlob(sha256: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Bounds the pack must respect so its own reader accepts it; defaults to the backup's. */
  limits?: ArchiveLimits;
  /** Called after each media file has been written, with how many are done out of the total. */
  onProgress?(done: number, total: number): void;
}

export interface WrittenChangesPack {
  blob: Blob;
  manifest: ChangesPackManifest;
}

/** Produced bytes are folded into a `Blob` (which the browser may keep outside the JS heap) this often. */
const FLUSH_BYTES = 16 * 1024 * 1024;
const PIECE_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

/** A record file built off to the side, because the manifest (first in the ZIP) needs its size and hash. */
interface Staged {
  path: string;
  blob: Blob;
  size: number;
  sha256: string;
}

/** Collects bytes into a `Blob`, hashing as it goes; keeps at most ~16 MB of pieces in the JS heap. */
function stager(path: string, maxEntryBytes: number) {
  const hasher = createSha256();
  const folded: Blob[] = [];
  let parts: Uint8Array[] = [];
  let pending = 0;
  let size = 0;
  const push = (bytes: Uint8Array) => {
    hasher.update(bytes);
    parts.push(bytes);
    pending += bytes.length;
    size += bytes.length;
    if (pending >= FLUSH_BYTES) {
      folded.push(new Blob(parts as BlobPart[]));
      parts = [];
      pending = 0;
    }
  };
  let text = '';
  return {
    line(value: unknown) {
      const json = JSON.stringify(value);
      // The reader bounds a line in BYTES (not UTF-16 units): so does the writer, or it could produce a pack its own reader refuses.
      if (json.length * 3 > MAX_RECORD_LINE_BYTES && encoder.encode(json).length > MAX_RECORD_LINE_BYTES) {
        throw new ArchiveError('limit-exceeded', 'a record is too large for a changes pack');
      }
      text += `${json}\n`;
      if (text.length >= PIECE_BYTES) {
        push(encoder.encode(text));
        text = '';
        if (size > maxEntryBytes) throw new ArchiveError('limit-exceeded', 'the changes are too large for one pack (a record file)');
      }
    },
    finish(): Staged {
      if (text !== '') push(encoder.encode(text));
      if (size > maxEntryBytes) throw new ArchiveError('limit-exceeded', 'the changes are too large for one pack (a record file)');
      return { path, blob: new Blob([...folded, ...(parts as BlobPart[])]), size, sha256: hasher.digestHex() };
    },
  };
}

function stageRecords(name: RecordFileName, records: readonly unknown[], maxEntryBytes: number): Staged {
  const file = stager(recordPath(name), maxEntryBytes);
  for (const record of records) file.line(record);
  return file.finish();
}

/**
 * Writes the changes pack ZIP (format in `format.ts`, specification in `docs/formats/changes-pack.md`).
 *
 * Record files and batches are built first (messages are pulled page by page, never held whole)
 * because the manifest comes first and lists their size and SHA-256; media streams straight from the
 * blob store and is hashed again on the way out, so a damaged file aborts the export instead of
 * producing a pack the receiver would refuse. Output is deterministic: same `changes`, same
 * `createdAt`, same bytes. Not streamed to disk: assembled as a `Blob` like the backup.
 */
export async function writeChangesPack(source: ChangesPackSource): Promise<WrittenChangesPack> {
  const set = source.changes;
  const limits = source.limits ?? DEFAULT_LIMITS;
  const blobs = [...set.blobs].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  const known = new Set<string>();
  for (const blob of blobs) {
    if (!isSha256Hex(blob.sha256) || !Number.isSafeInteger(blob.size) || blob.size < 0 || known.has(blob.sha256)) {
      throw new ArchiveError('blob-missing', 'a media reference is malformed');
    }
    known.add(blob.sha256);
  }
  // The pack never points at media it does not carry.
  for (const profile of set.profiles) {
    if (profile.photoSha256 !== null && !known.has(profile.photoSha256)) throw new ArchiveError('blob-missing', 'a profile photo is not among the media to send');
  }

  const staged: Staged[] = [
    stageRecords('profiles', set.profiles, limits.maxEntryBytes),
    stageRecords('conversations', set.conversations, limits.maxEntryBytes),
    stageRecords('blobs', blobs, limits.maxEntryBytes),
    stageRecords('favorites', set.favorites, limits.maxEntryBytes),
    stageRecords('notes', set.notes, limits.maxEntryBytes),
    stageRecords('tombstones', set.tombstones, limits.maxEntryBytes),
  ];
  const batches = [...set.batches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let messages = 0;
  for (const header of batches) {
    const file = stager(batchPath(header.id), limits.maxEntryBytes);
    file.line(header);
    for await (const page of source.batchMessages(header.id)) {
      for (const message of page) {
        if (message.mediaSha256 !== null && !known.has(message.mediaSha256)) {
          throw new ArchiveError('blob-missing', 'a message refers to media that is not among the media to send');
        }
        file.line(message);
        messages++;
      }
    }
    staged.push(file.finish());
  }

  // Everything the reader will bound, known now, so a pack it would refuse is never handed over.
  const tooBig = (what: string) => new ArchiveError('limit-exceeded', `the changes are too large for one pack (${what})`);
  const names = [MANIFEST_PATH, ...staged.map((s) => s.path), ...blobs.map((b) => blobPath(b.sha256))];
  if (names.length > limits.maxEntries) throw tooBig('too many files');
  if (names.reduce((sum, name) => sum + 46 + name.length, 0) > limits.maxCentralDirectoryBytes) throw tooBig('too many files');
  let total = 0;
  for (const item of staged) total += item.size;
  for (const blob of blobs) {
    if (blob.size > limits.maxEntryBytes) throw tooBig('a media file');
    total += blob.size;
  }
  if (total > limits.maxTotalBytes) throw tooBig('total size');

  const counts: ChangesPackCounts = {
    profiles: set.profiles.length,
    conversations: set.conversations.length,
    batches: batches.length,
    messages,
    favorites: set.favorites.length,
    notes: set.notes.length,
    tombstones: set.tombstones.length,
    blobs: blobs.length,
  };
  const entries: ManifestEntry[] = [
    ...staged.map((s) => ({ path: s.path, size: s.size, sha256: s.sha256 })),
    ...blobs.map((b) => ({ path: blobPath(b.sha256), size: b.size, sha256: b.sha256 })),
  ];
  const manifest: ChangesPackManifest = {
    format: CHANGES_PACK_FORMAT_NAME,
    formatVersion: CHANGES_PACK_FORMAT_VERSION,
    createdAt: source.createdAt.toISOString(),
    app: source.app,
    schemaVersion: set.schemaVersion,
    kind: set.kind,
    source: { deviceId: set.sourceDeviceId },
    target: { deviceId: set.targetDeviceId },
    since: set.since,
    upTo: set.upTo,
    ack: set.ack,
    counts,
    entries,
  };

  const folded: Blob[] = [];
  let parts: Uint8Array[] = [];
  let pending = 0;
  let failure: unknown;
  const zip = new Zip((error, chunk) => {
    if (error) {
      failure = error;
      return;
    }
    parts.push(chunk);
    pending += chunk.length;
    if (pending >= FLUSH_BYTES) {
      folded.push(new Blob(parts as BlobPart[]));
      parts = [];
      pending = 0;
    }
  });
  const check = () => {
    if (failure) throw new ArchiveError('storage', 'could not assemble the changes pack', { cause: failure });
  };

  try {
    const head = new ZipDeflate(MANIFEST_PATH, { level: 6 });
    head.mtime = source.createdAt;
    zip.add(head);
    head.push(encoder.encode(JSON.stringify(manifest, null, 2)), true);
    check();

    for (const item of staged) {
      const file = new ZipDeflate(item.path, { level: 6 });
      file.mtime = source.createdAt;
      zip.add(file);
      const reader = item.blob.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        file.push(value, false);
        check();
      }
      file.push(EMPTY, true);
      check();
    }

    let done = 0;
    for (const blob of blobs) {
      const stream = await source.openBlob(blob.sha256);
      if (!stream) throw new ArchiveError('blob-missing', 'a media file referenced by the library is missing');
      const file = new ZipPassThrough(blobPath(blob.sha256));
      file.mtime = source.createdAt;
      zip.add(file);
      const hasher = createSha256();
      let size = 0;
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > blob.size) break;
          hasher.update(value);
          file.push(value, false);
          check();
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (size !== blob.size || hasher.digestHex() !== blob.sha256) {
        throw new ArchiveError('integrity', 'a media file no longer matches its recorded hash; the library is damaged');
      }
      file.push(EMPTY, true);
      check();
      source.onProgress?.(++done, blobs.length);
    }
  } catch (error) {
    zip.terminate();
    throw error;
  }
  zip.end();
  check();
  return { blob: new Blob([...folded, ...(parts as BlobPart[])], { type: 'application/zip' }), manifest };
}
