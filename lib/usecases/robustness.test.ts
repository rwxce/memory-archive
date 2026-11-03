import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { ArchiveError } from '../exporters/archive/format';
import type { OpenedDb } from '../db/open';
import type { BlobStore } from '../storage/blob-store';
import { exportArchiveFromLibrary, restoreArchiveFromZip } from './archive-backup';
import { importProblemOf } from './import-wizard';
import { ImportError, importWhatsAppExport, type ImportResult } from './import';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';

/*
 * Phase 9 robustness: the failure paths a phone really hits (full storage, a bad file, a damaged
 * backup, a brand-new device). Everything here is synthetic. The rule behind every test: a
 * failure is a TYPED error and leaves the library exactly as it was (no half-restored rows, no
 * stray media files).
 */

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

const PHOTOS = [1, 2, 3].map((n) => `0000000${n}-PHOTO-2026-03-17-13-2${n}-00.jpg`);
const photo = (seed: number) => new Uint8Array(400).map((_, i) => (i * 7 + seed * 13) % 251);
const LINES = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok ñandú — 日本語 😀',
  ...PHOTOS.map((p, i) => `[17/03/2026, 13:2${i}:00] Ana: <attached: ${p}>`),
  '[18/03/2026, 09:00:00] Bo: Hola',
];
const exportZip = (lines = LINES, media = Object.fromEntries(PHOTOS.map((p, i) => [p, photo(i + 1)]))) =>
  new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...media }) as BlobPart]);

const NAME = 'WhatsApp Chat - Ana i Bo.zip';

async function setup() {
  const lib = await createTestLibrary();
  const profile = await createProfile(lib.deps, { displayName: 'Ana' });
  const input = (zip: Blob) => ({ zip, fileName: NAME, profileIds: [profile.id], meAuthor: 'Ana' });
  return { ...lib, profile, input };
}

const tableState = (opened: OpenedDb) =>
  JSON.stringify(
    opened.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((t) => [t.name, opened.db.all(`SELECT * FROM "${t.name}" ORDER BY rowid`)]),
  );

/** The user-visible content of a library, independent of ids and the device identity. */
async function content(lib: Lib) {
  const conversations = await lib.client.call('listConversations', {});
  const out = [];
  for (const c of conversations) {
    const messages = await lib.client.call('listMessages', { conversationId: c.id, limit: 1000 });
    out.push({ title: c.title, messages: messages.map((m) => [m.sentAt, m.body, m.mediaSha256, m.mediaName]) });
  }
  return { conversations: out, blobs: await lib.deps.blobStore.list() };
}

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

/** A store whose `put` fails with `error` on the nth call (1-based); everything else is the real store. */
function failingPut(real: BlobStore, nth: number, error: () => Error): BlobStore {
  let n = 0;
  return {
    put: async (source) => {
      if (++n === nth) throw error();
      return real.put(source);
    },
    has: (s) => real.has(s),
    open: (s) => real.open(s),
    size: (s) => real.size(s),
    delete: (s) => real.delete(s),
    list: () => real.list(),
    verify: (s) => real.verify(s),
  };
}

describe('full storage: a QuotaExceededError never leaves a half import', () => {
  test.each([1, 2, 3])('import: the store is full at media file %i: library unchanged, written blobs swept, reported as a storage problem', async (nth) => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const deps = { ...lib.deps, blobStore: failingPut(lib.deps.blobStore, nth, quota) };
    const error = await importWhatsAppExport(deps, lib.input(exportZip())).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).name).toBe('QuotaExceededError');
    expect(importProblemOf(error)).toBe('storage');
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    // Space came back: the same import now works, with everything in it.
    const retry = await importWhatsAppExport(lib.deps, lib.input(exportZip()));
    expect(retry.status).toBe('imported');
    expect(await lib.deps.blobStore.list()).toHaveLength(3);
  });

  test('a full store during a re-import that adds a new photo keeps what was there', async () => {
    const lib = await setup();
    await importWhatsAppExport(lib.deps, lib.input(exportZip()));
    const stored = await lib.deps.blobStore.list();
    const before = tableState(lib.opened);
    const newer = exportZip([...LINES, '[19/03/2026, 10:00:00] Ana: <attached: 00000009-PHOTO-2026-03-19-10-00-00.jpg>'], {
      ...Object.fromEntries(PHOTOS.map((p, i) => [p, photo(i + 1)])),
      '00000009-PHOTO-2026-03-19-10-00-00.jpg': photo(9),
    });
    const deps = { ...lib.deps, blobStore: failingPut(lib.deps.blobStore, 1, quota) };
    await expect(importWhatsAppExport(deps, lib.input(newer))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual(stored);
  });

  test.each([1, 2, 3])('restore: the store is full at media file %i: typed storage error, empty library, empty store, retry works', async (nth) => {
    const source = await setup();
    await importWhatsAppExport(source.deps, source.input(exportZip()));
    const { blob } = await exportArchiveFromLibrary(source.deps, { appVersion: 'test' });

    const target = await createTestLibrary();
    const before = tableState(target.opened);
    const deps = { ...target.deps, blobStore: failingPut(target.deps.blobStore, nth, quota) };
    const error = await restoreArchiveFromZip(deps, blob).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe('storage');
    expect(tableState(target.opened)).toBe(before);
    expect(await target.deps.blobStore.list()).toEqual([]);

    await restoreArchiveFromZip(target.deps, blob);
    expect(await content(target)).toEqual(await content(source));
  });
});

describe('failed imports are typed and write nothing', () => {
  const utf16 = (text: string) => {
    const out = new Uint8Array(2 + text.length * 2);
    out.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) new DataView(out.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true);
    return out;
  };

  test.each([
    ['a transcript in UTF-16 (wrong encoding)', () => new Blob([zipSync({ '_chat.txt': utf16(LINES.join('\n')) }) as BlobPart])],
    ['a transcript of random bytes', () => new Blob([zipSync({ '_chat.txt': new Uint8Array(2000).map((_, i) => (i * 131) % 256) }) as BlobPart])],
    ['an empty transcript', () => new Blob([zipSync({ '_chat.txt': new Uint8Array(0) }) as BlobPart])],
    ['a ZIP with only media', () => new Blob([zipSync({ [PHOTOS[0]]: photo(1) }) as BlobPart])],
    ['an empty file', () => new Blob([])],
    ['binary junk that is not a ZIP', () => new Blob([new Uint8Array(3000).map((_, i) => (i * 17 + 3) % 256)])],
  ])('%s', async (_label, make) => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const error = await importWhatsAppExport(lib.deps, lib.input(make())).then(
      (r: ImportResult) => r,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect(['invalid-export', 'limit-exceeded']).toContain((error as ImportError).code);
    expect(importProblemOf(error)).not.toBe('storage');
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a ZIP cut at any point is a typed failure or a complete import, never a partial one', async () => {
    const whole = new Uint8Array(await exportZip().arrayBuffer());
    const reference = await setup();
    await importWhatsAppExport(reference.deps, reference.input(exportZip()));
    const expected = await content(reference);
    let refused = 0;
    for (const length of [0, 1, 22, 40, 100, 400, Math.floor(whole.length / 2), whole.length - 60, whole.length - 22, whole.length - 1]) {
      const lib = await setup();
      const before = tableState(lib.opened);
      const outcome = await importWhatsAppExport(lib.deps, lib.input(new Blob([whole.slice(0, length) as BlobPart]))).then(
        () => 'imported',
        (e: unknown) => e,
      );
      if (outcome === 'imported') {
        expect(await content(lib)).toEqual(expected);
      } else {
        refused++;
        expect(outcome).toBeInstanceOf(ImportError);
        expect(tableState(lib.opened)).toBe(before);
        expect(await lib.deps.blobStore.list()).toEqual([]);
      }
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe('corrupted backups: every damage is refused whole or harmless', () => {
  async function backup() {
    const source = await setup();
    await importWhatsAppExport(source.deps, source.input(exportZip()));
    const { blob } = await exportArchiveFromLibrary(source.deps, { appVersion: 'test' });
    return { source, bytes: new Uint8Array(await blob.arrayBuffer()), expected: await content(source) };
  }

  /** Restore into a clean device; the result is either the exact source content or a typed refusal with nothing written. */
  async function restoresWholeOrNothing(bytes: Uint8Array, expected: Awaited<ReturnType<typeof content>>) {
    const target = await createTestLibrary();
    const before = tableState(target.opened);
    const outcome = await restoreArchiveFromZip(target.deps, new Blob([bytes as BlobPart])).then(
      () => 'restored' as const,
      (e: unknown) => e,
    );
    if (outcome === 'restored') {
      expect(await content(target)).toEqual(expected);
      for (const sha of await target.deps.blobStore.list()) expect(await target.deps.blobStore.verify(sha)).toBe('ok');
      return 'restored';
    }
    expect(outcome).toBeInstanceOf(ArchiveError);
    expect(tableState(target.opened)).toBe(before);
    expect(await target.deps.blobStore.list()).toEqual([]);
    return (outcome as ArchiveError).code;
  }

  test('a bit flipped anywhere in the file', async () => {
    const { bytes, expected } = await backup();
    // Deterministic spread over the whole file (headers, media, database, directory).
    const positions = new Set<number>();
    let x = 12345;
    while (positions.size < 80) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      positions.add(x % bytes.length);
    }
    for (const p of [0, 1, 2, 3, bytes.length - 1, bytes.length - 22, bytes.length - 20]) positions.add(p);
    const codes = new Set<string>();
    for (const position of positions) {
      const damaged = bytes.slice();
      damaged[position] ^= 0x10;
      codes.add(await restoresWholeOrNothing(damaged, expected));
    }
    // Damage is detected, not shrugged off.
    expect([...codes].some((c) => c !== 'restored')).toBe(true);
  }, 60_000);

  test('a bit flipped inside the stored media bytes is a hash failure, not a restored bad photo', async () => {
    const { bytes, expected } = await backup();
    const needle = photo(2).slice(100, 140);
    let at = -1;
    for (let i = 0; i + needle.length <= bytes.length && at < 0; i++) if (needle.every((b, k) => bytes[i + k] === b)) at = i;
    expect(at).toBeGreaterThan(0);
    const damaged = bytes.slice();
    damaged[at + 5] ^= 0x01;
    expect(await restoresWholeOrNothing(damaged, expected)).not.toBe('restored');
  });

  test('truncated anywhere, including inside the central directory', async () => {
    const { bytes, expected } = await backup();
    const cuts = new Set<number>([0, 1, 10, 30, bytes.length - 1, bytes.length - 21, bytes.length - 22, bytes.length - 23]);
    for (let i = 1; i < 40; i++) cuts.add(Math.floor((bytes.length * i) / 40));
    for (let n = 30; n < 400; n += 37) cuts.add(bytes.length - n);
    for (const cut of cuts) {
      if (cut < 0 || cut >= bytes.length) continue;
      expect(await restoresWholeOrNothing(bytes.slice(0, cut), expected)).not.toBe('restored');
    }
  }, 60_000);

  test('trailing garbage after a valid backup never changes what is restored', async () => {
    const { bytes, expected } = await backup();
    const padded = new Uint8Array(bytes.length + 37);
    padded.set(bytes);
    // Either the whole content or a refusal: restoresWholeOrNothing asserts both shapes.
    await restoresWholeOrNothing(padded, expected);
  });
});

describe('restore on a clean device', () => {
  test('a backup made elsewhere restores to the same content, and the new device backs up again losslessly', async () => {
    const a = await setup();
    await importWhatsAppExport(a.deps, a.input(exportZip()));
    const first = await exportArchiveFromLibrary(a.deps, { appVersion: 'test' });

    const b = await createTestLibrary();
    expect(await b.deps.blobStore.list()).toEqual([]);
    await restoreArchiveFromZip(b.deps, first.blob);
    expect(await content(b)).toEqual(await content(a));

    const second = await exportArchiveFromLibrary(b.deps, { appVersion: 'test' });
    const c = await createTestLibrary();
    await restoreArchiveFromZip(c.deps, second.blob);
    expect(await content(c)).toEqual(await content(a));
    expect(second.blobCount).toBe(first.blobCount);
  });

  test('a restored device can import the same chat again without duplicates, and a newer export adds only the new message', async () => {
    const a = await setup();
    await importWhatsAppExport(a.deps, a.input(exportZip()));
    const { blob } = await exportArchiveFromLibrary(a.deps, { appVersion: 'test' });

    const b = await createTestLibrary();
    await restoreArchiveFromZip(b.deps, blob);
    const [profile] = await b.client.call('listProfiles', {});
    const input = (zip: Blob) => ({ zip, fileName: NAME, profileIds: [profile.id], meAuthor: 'Ana' });
    const before = await content(b);
    await importWhatsAppExport(b.deps, input(exportZip()));
    expect(await content(b)).toEqual(before);

    const newer = await importWhatsAppExport(b.deps, input(exportZip([...LINES, '[19/03/2026, 10:00:00] Bo: nou'])));
    expect(newer.status).toBe('imported');
    expect((newer as Extract<ImportResult, { status: 'imported' }>).summary.added).toBe(1);
  });

  test('a second restore into the now-used device is refused and changes nothing', async () => {
    const a = await setup();
    await importWhatsAppExport(a.deps, a.input(exportZip()));
    const { blob } = await exportArchiveFromLibrary(a.deps, { appVersion: 'test' });
    const b = await createTestLibrary();
    await restoreArchiveFromZip(b.deps, blob);
    const before = tableState(b.opened);
    await expect(restoreArchiveFromZip(b.deps, blob)).rejects.toMatchObject({ code: 'target-not-empty' });
    expect(tableState(b.opened)).toBe(before);
  });
});
