import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { parseViewerData } from '../exporters/viewer/format';
import { readZipEntries, readZipEntryBytes } from '../importers/whatsapp/zip';
import { exportArchiveFromLibrary, restoreArchiveFromZip } from './archive-backup';
import { exportPackage } from './export-package';
import { importWhatsAppExport } from './import';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';

/*
 * Volume: a big synthetic chat (generated here, nothing real) through import -> backup -> restore
 * on a clean library -> export. The size is a knob (`ROBUSTNESS_MESSAGES`, default 30k messages with
 * one photo per 50; `ROBUSTNESS_MESSAGES=200000` is the stress run, minutes). Budgets are generous on purpose: they catch an accidental quadratic
 * step or a lost streaming path, not a few percent of speed, so they hold on a slow CI runner.
 */
const MESSAGES = Number(process.env.ROBUSTNESS_MESSAGES ?? 30_000);
const MEDIA = Math.min(Math.floor(MESSAGES / 50), 2_000);
const BUDGET_MS = 120_000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** One distinct tiny "photo" per index; the bytes carry the index so every blob hashes differently. */
const photoBytes = (i: number) => new Uint8Array(64).map((_, k) => (k < 4 ? (i >> (8 * k)) & 0xff : (i * 31 + k * 7) & 0xff));
const photoName = (i: number) => `${pad(i, 8)}-PHOTO-2020-01-01-00-00-00.jpg`;

function bigExport(): Blob {
  const lines: string[] = [];
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < MESSAGES; i++) {
    // 400 messages a day, 3 minutes apart on the same day, so dates stay valid and ordered.
    const day = Math.floor(i / 400);
    const date = new Date(Date.UTC(2020, 0, 1 + day));
    const minute = (i % 400) * 3;
    const stamp = `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}, ${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}:00`;
    const author = i % 2 ? 'Bo' : 'Ana';
    const media = i % 50 === 49 ? Math.floor(i / 50) : -1;
    if (media >= 0 && media < MEDIA) {
      files[photoName(media)] = photoBytes(media);
      lines.push(`[${stamp}] ${author}: <attached: ${photoName(media)}>`);
    } else {
      lines.push(`[${stamp}] ${author}: synthetic message ${i}`);
    }
  }
  return new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...files }, { level: 0 }) as BlobPart]);
}

const countOf = (lib: Awaited<ReturnType<typeof createTestLibrary>>, table: string) =>
  lib.opened.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

describe('volume: a very long chat survives the whole pipeline', () => {
  test(
    'import -> re-import -> backup -> restore on a clean device -> JSON export',
    async () => {
      const a = await createTestLibrary();
      const ana = await createProfile(a.deps, { displayName: 'Ana' });
      const zip = bigExport();
      const input = { zip, fileName: 'WhatsApp Chat - Ana i Bo.zip', profileIds: [ana.id], meAuthor: 'Ana' };

      const started = Date.now();
      const first = await importWhatsAppExport(a.deps, input);
      expect(first.status).toBe('imported');
      expect(countOf(a, 'messages')).toBe(MESSAGES);
      expect(countOf(a, 'blobs')).toBe(MEDIA);
      expect(await a.deps.blobStore.list()).toHaveLength(MEDIA);

      // Idempotent at volume: the same export again adds nothing, in rows or in files.
      await importWhatsAppExport(a.deps, input);
      expect(countOf(a, 'messages')).toBe(MESSAGES);
      expect(await a.deps.blobStore.list()).toHaveLength(MEDIA);

      const { blob, blobCount } = await exportArchiveFromLibrary(a.deps, { appVersion: 'test' });
      expect(blobCount).toBe(MEDIA);

      // A clean device: empty database and empty blob store, nothing shared with the first.
      const b = await createTestLibrary();
      await restoreArchiveFromZip(b.deps, blob);
      expect(countOf(b, 'messages')).toBe(MESSAGES);
      expect(await b.deps.blobStore.list()).toEqual(await a.deps.blobStore.list());
      for (const sha of (await b.deps.blobStore.list()).filter((_, i) => i % 97 === 0)) expect(await b.deps.blobStore.verify(sha)).toBe('ok');

      // Re-importing the original export into the restored library still finds every message.
      const profiles = await b.client.call('listProfiles', {});
      await importWhatsAppExport(b.deps, { ...input, profileIds: [profiles[0].id] });
      expect(countOf(b, 'messages')).toBe(MESSAGES);

      const out = await exportPackage(b.deps, { format: 'json', selection: { profileIds: [profiles[0].id], includeMedia: true } });
      const entries = await readZipEntries(out.blob);
      const json = entries.find((e) => e.name === 'memory-archive.json')!;
      const data = parseViewerData(new TextDecoder().decode(await readZipEntryBytes(out.blob, json)));
      expect(data.conversations.reduce((n, c) => n + c.messages.length, 0)).toBe(MESSAGES);
      expect(out.mediaCount).toBe(MEDIA);
      expect(out.missingMedia).toBe(0);

      expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    },
    BUDGET_MS + 60_000,
  );
});
