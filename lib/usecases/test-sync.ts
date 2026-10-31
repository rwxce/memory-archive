import { readBatchMessages, readChangeSet } from '../db/changes';
import { createProfile, importMessages, setFavorite, setNote } from '../db/queries';
import type { SqlDb } from '../db/sql';
import { getDeviceId } from '../db/sync';
import type { NewMessage } from '../domain/library';
import { confirmChangesPackDelivered, exportChangesPack, type ExportChangesPackOptions } from './changes-pack-export';
import { importChangesPack, type ImportChangesPackOptions } from './changes-pack-import';
import { createTestLibrary } from './test-client';

/** Test helpers for two or more libraries exchanging changes packs (synthetic data only). */
export type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const fp = (n: number) => n.toString(16).padStart(64, '0');
export const [ANA, BEN, CAL, C1, C2, C3, B1, B2, B3, B4] = [1, 2, 3, 10, 11, 12, 100, 101, 102, 103].map(uuid);
export const NOW = '2026-02-01T12:00:00Z';
export const AT = new Date('2026-05-06T00:00:00Z');
export const bytesOf = (seed: number) => new Uint8Array(500).map((_, i) => (i * seed + 3) % 251);

export async function putMedia(lib: Lib, seed: number) {
  const { sha256, size } = await lib.deps.blobStore.put(bytesOf(seed));
  return { sha256, size, mime: 'image/jpeg' };
}

export const msg = (n: number, author: string | null, body: string, mediaSha256: string | null = null): NewMessage => ({
  fingerprint: fp(n), sentAt: `2026-01-0${n}T10:00:00`, ordinal: 0, type: mediaSha256 ? 'photo' : 'text', participantName: author, body, mediaSha256, mediaName: mediaSha256 ? 'IMG.jpg' : '',
});

export const messageId = (lib: Lib, n: number) => lib.opened.db.all<{ id: number }>('SELECT id FROM messages WHERE fingerprint = ?', [fp(n)])[0].id;

/** Two people, two conversations with media, a favorite and a note. */
export async function populated(): Promise<Lib> {
  const lib = await createTestLibrary();
  const { db } = lib.opened;
  const m1 = await putMedia(lib, 5);
  const m2 = await putMedia(lib, 7);
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BEN, displayName: 'Ben', now: NOW });
  importMessages(db, {
    batchId: B1, conversationId: C1, source: 'whatsapp', sourceLabel: 'one.zip', now: NOW, blobs: [m1],
    messages: [msg(1, 'Ana', 'hello'), msg(2, 'Ben', 'photo', m1.sha256)],
    newConversation: { title: 'Ana & me', sourceKey: 'ana', isGroup: false, profileIds: [ANA] },
    meAuthor: 'Ben',
  });
  importMessages(db, {
    batchId: B2, conversationId: C2, source: 'whatsapp', sourceLabel: 'two.zip', now: NOW, blobs: [m2],
    messages: [msg(3, 'Ben', 'other chat', m2.sha256)],
    newConversation: { title: 'Ben', sourceKey: 'ben', isGroup: false, profileIds: [BEN] },
  });
  setFavorite(db, { conversationId: C1, messageId: messageId(lib, 1), favorite: true, now: NOW });
  setNote(db, { target: { kind: 'profile', profileId: ANA }, body: 'synthetic note', now: NOW });
  return lib;
}

/** A different person and chat, with ids that do not collide with `populated`. */
export async function populatedOther(): Promise<Lib> {
  const lib = await createTestLibrary();
  const { db } = lib.opened;
  const m = await putMedia(lib, 13);
  createProfile(db, { id: CAL, displayName: 'Cal', now: NOW });
  importMessages(db, {
    batchId: B4, conversationId: C3, source: 'whatsapp', sourceLabel: 'cal.zip', now: NOW, blobs: [m],
    messages: [msg(7, 'Cal', 'hi there'), msg(8, 'Cal', 'a photo', m.sha256)],
    newConversation: { title: 'Cal', sourceKey: 'cal', isGroup: false, profileIds: [CAL] },
  });
  setNote(db, { target: { kind: 'profile', profileId: CAL }, body: 'cal note', now: NOW });
  return lib;
}

export const idOf = (lib: Lib) => getDeviceId(lib.opened.db);

/** Cuts a pack on `from` for `to`, hands it over (confirms it) and merges it on `to`. */
export async function send(from: Lib, to: Lib, options: Partial<ExportChangesPackOptions> = {}, importOptions: ImportChangesPackOptions = {}) {
  const pack = await exportChangesPack(from.deps, { appVersion: '1.0.0', now: AT, peerId: idOf(to), ...options });
  await confirmChangesPackDelivered(from.deps, pack);
  const result = await importChangesPack(to.deps, pack.blob, importOptions);
  return { pack, result };
}

/** What a library holds, without the numbers that are local to a device (`seq`) or the device itself. */
export async function canon(lib: Lib) {
  const db = lib.opened.db;
  const cs = readChangeSet(db, { peerId: null });
  const strip = <T extends { seq: number }>(items: T[]) => items.map(({ seq: _seq, ...rest }) => rest);
  const batches = cs.batches.map((b) => {
    const { seq: _seq, ...header } = b;
    const messages = readBatchMessages(db, { batchId: b.id, after: 0, limit: 5000 }).messages.sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1));
    return { header, messages };
  });
  const bytes: Record<string, number> = {};
  for (const blob of cs.blobs) bytes[blob.sha256] = (await lib.deps.blobStore.size(blob.sha256)) ?? -1;
  return {
    profiles: strip(cs.profiles), conversations: strip(cs.conversations), blobs: cs.blobs, bytes,
    favorites: strip(cs.favorites), notes: strip(cs.notes), tombstones: strip(cs.tombstones), batches,
  };
}

/** Every row of every table: "importing again changes nothing" compares two of these. */
export function dump(db: SqlDb): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[name] = db.all(`SELECT * FROM "${name}" ORDER BY rowid`);
  }
  return out;
}

export const count = (lib: Lib, table: string) => lib.opened.db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0].n;
