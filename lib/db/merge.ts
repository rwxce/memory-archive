import type { PackBatchHeader, PackConversation, PackMessage, PackNote, PackNoteTarget, PackProfile, PackTombstone } from '../domain/changes-pack';
import {
  PackRecordError,
  noteTombstoneKey,
  parsePackBatchHeader,
  parsePackBlob,
  parsePackConversation,
  parsePackFavorite,
  parsePackMessage,
  parsePackNote,
  parsePackProfile,
  parsePackTombstone,
} from '../domain/changes-pack-parse';
import { isUuid } from '../domain/library';
import type {
  LocalConversationVersion,
  LocalNoteVersion,
  LocalProfileVersion,
  MergeChangesPackInput,
  MergeChangesPackResult,
  MergeCounts,
  MergeRefusal,
  PackAddress,
} from '../domain/sync';
import { DbError } from './errors';
import { isReferenced } from './queries';
import { transaction, type SqlDb, type SqlValue } from './sql';
import { clearTombstone, currentChangeSeq, getDeviceId, getPeer, recordMergedTombstone, recordReceived, stampMergedRows } from './sync';

/**
 * Merging a changes pack into the library (`docs/formats/changes-pack.md`, "Merge"). ONE
 * transaction: blobs, profiles, conversations, batches (with messages), favorites, notes,
 * tombstones, then the received watermark. A failure anywhere rolls all of it back, watermark
 * included. The merge never replaces the library and never deletes messages or media on its own.
 *
 * Decisions use watermarks, never clocks:
 *   S changed it  = the record's `seq` is above `lastReceived` (our received watermark for the source);
 *   we changed it = our row's `seq` is above `lastSent` and it is not a version merged from S.
 * Crossed edits are kept beside the active record in `sync_conflicts` (`conflicts.ts`).
 */

const invalid = (message: string) => new DbError('invalid', message);

/** Re-types an untrusted request; a bad record is `invalid`, never a half-applied merge. */
function validate(raw: unknown): MergeChangesPackInput {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw invalid('params must be an object');
  const seqOf = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalid(`${what} must be a non-negative integer`);
    return v;
  };
  const list = (v: unknown, what: string): unknown[] => {
    if (!Array.isArray(v)) throw invalid(`${what} must be an array`);
    return v;
  };
  try {
    if (r.kind !== 'changes' && r.kind !== 'full') throw invalid('kind must be changes or full');
    if (!isUuid(r.sourceDeviceId)) throw invalid('source device id must be a lowercase UUID');
    if (r.targetDeviceId !== null && !isUuid(r.targetDeviceId)) throw invalid('target device id must be a lowercase UUID or null');
    if (typeof r.now !== 'string' || r.now === '') throw invalid('now must be a string');
    const since = seqOf(r.since, 'since');
    const upTo = seqOf(r.upTo, 'upTo');
    if (since > upTo) throw invalid('since is above upTo');
    if (r.kind === 'full' && since !== 0) throw invalid('a full pack starts at 0');
    const ack = r.ack === null ? null : seqOf(r.ack, 'ack');
    const unique = <T>(items: T[], keyOf: (item: T) => string, what: string): T[] => {
      if (new Set(items.map(keyOf)).size !== items.length) throw invalid(`${what} appears twice in the pack`);
      return items;
    };
    const batches = list(r.batches, 'batches').map((b) => {
      const o = b as { header?: unknown; messages?: unknown };
      return { header: parsePackBatchHeader(o?.header), messages: list(o?.messages, 'messages').map(parsePackMessage) };
    });
    return {
      kind: r.kind,
      sourceDeviceId: r.sourceDeviceId,
      targetDeviceId: r.targetDeviceId as string | null,
      since,
      upTo,
      ack,
      now: r.now,
      blobs: unique(list(r.blobs, 'blobs').map(parsePackBlob), (b) => b.sha256, 'a media file'),
      profiles: unique(list(r.profiles, 'profiles').map(parsePackProfile), (p) => p.id, 'a profile'),
      conversations: unique(list(r.conversations, 'conversations').map(parsePackConversation), (c) => c.id, 'a conversation'),
      batches: unique(batches, (b) => b.header.id, 'an import batch'),
      favorites: unique(list(r.favorites, 'favorites').map(parsePackFavorite), (f) => `${f.conversationId}/${f.fingerprint}`, 'a favorite'),
      notes: unique(list(r.notes, 'notes').map(parsePackNote), (n) => JSON.stringify(noteTombstoneKey(n.target)), 'a note'),
      tombstones: unique(list(r.tombstones, 'tombstones').map(parsePackTombstone), (t) => `${t.kind}/${t.scope}/${t.key}`, 'a deletion'),
    };
  } catch (error) {
    if (error instanceof PackRecordError) throw invalid(error.message);
    throw error;
  }
}

// ----------------------------------------------------------- refusal

/** The reason this device cannot merge the pack, or `null`. Reads only. */
export function refusalOf(db: SqlDb, pack: PackAddress): MergeRefusal | null {
  if (!isUuid(pack.sourceDeviceId)) throw invalid('source device id must be a lowercase UUID');
  const me = getDeviceId(db);
  if (pack.kind === 'changes' && pack.targetDeviceId !== me) return 'wrong-device';
  if (pack.sourceDeviceId === me) return 'own-pack';
  if (pack.kind === 'changes' && pack.since > (getPeer(db, pack.sourceDeviceId)?.lastReceivedSeq ?? 0)) return 'gap';
  return null;
}

// -------------------------------------------------- local versions

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function readLocalProfile(db: SqlDb, id: string): (LocalProfileVersion & { seq: number; changedBy: string | null }) | null {
  return (
    db.all<LocalProfileVersion & { seq: number; changedBy: string | null }>(
      `SELECT id, display_name AS displayName, relationship, description, photo_sha256 AS photoSha256,
              archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt, seq, changed_by AS changedBy
         FROM profiles WHERE id = ?`,
      [id],
    )[0] ?? null
  );
}

export function readLocalConversation(db: SqlDb, id: string): (LocalConversationVersion & { seq: number; changedBy: string | null }) | null {
  const row = db.all<{
    id: string; title: string; source: string; sourceKey: string; isGroup: number; createdAt: string; seq: number; changedBy: string | null;
  }>(
    `SELECT id, title, source, source_key AS sourceKey, is_group AS isGroup, created_at AS createdAt, seq, changed_by AS changedBy
       FROM conversations WHERE id = ?`,
    [id],
  )[0];
  if (!row) return null;
  const profileIds = db
    .all<{ profileId: string }>('SELECT profile_id AS profileId FROM conversation_profiles WHERE conversation_id = ?', [id])
    .map((r) => r.profileId)
    .sort(byText);
  const participants = db
    .all<{ displayName: string; profileId: string | null; isMe: number }>(
      `SELECT display_name AS displayName, profile_id AS profileId, is_me AS isMe FROM participants
        WHERE conversation_id = ? AND (profile_id IS NOT NULL OR is_me = 1)`,
      [id],
    )
    .map((p) => ({ displayName: p.displayName, profileId: p.profileId, isMe: p.isMe === 1 }))
    .sort((a, b) => byText(a.displayName, b.displayName));
  return {
    id: row.id, title: row.title, source: row.source, sourceKey: row.sourceKey, isGroup: row.isGroup === 1, createdAt: row.createdAt,
    profileIds, participants, seq: row.seq, changedBy: row.changedBy,
  };
}

interface NoteWhere {
  where: string;
  params: SqlValue[];
  kind: PackNoteTarget['kind'];
  profileId: string | null;
  conversationId: string | null;
  fingerprint: string | null;
}

export function noteWhere(target: PackNoteTarget): NoteWhere {
  if (target.kind === 'profile') {
    return { where: 'profile_id = ?', params: [target.profileId], kind: 'profile', profileId: target.profileId, conversationId: null, fingerprint: null };
  }
  if (target.kind === 'conversation') {
    return {
      where: "kind = 'conversation' AND conversation_id = ?", params: [target.conversationId],
      kind: 'conversation', profileId: null, conversationId: target.conversationId, fingerprint: null,
    };
  }
  return {
    where: 'conversation_id = ? AND fingerprint = ?', params: [target.conversationId, target.fingerprint],
    kind: 'message', profileId: null, conversationId: target.conversationId, fingerprint: target.fingerprint,
  };
}

export function readLocalNote(db: SqlDb, target: PackNoteTarget): (LocalNoteVersion & { seq: number; changedBy: string | null }) | null {
  const w = noteWhere(target);
  const row = db.all<{ body: string; createdAt: string; updatedAt: string; seq: number; changedBy: string | null }>(
    `SELECT body, created_at AS createdAt, updated_at AS updatedAt, seq, changed_by AS changedBy FROM notes WHERE ${w.where}`,
    w.params,
  )[0];
  return row ? { target, ...row } : null;
}

// ------------------------------------------------------ applying

export const profileExists = (db: SqlDb, id: string) => db.all('SELECT 1 FROM profiles WHERE id = ?', [id]).length > 0;
export const conversationExists = (db: SqlDb, id: string) => db.all('SELECT 1 FROM conversations WHERE id = ?', [id]).length > 0;
const blobExists = (db: SqlDb, sha256: string) => db.all('SELECT 1 FROM blobs WHERE sha256 = ?', [sha256]).length > 0;

function need(ok: boolean, what: string): void {
  if (!ok) throw invalid(`the pack refers to ${what} that is not here`);
}

/** Writes a profile's editable fields (inserting the row when `insert`). The caller stamps it. */
export function writeProfile(db: SqlDb, p: PackProfile | LocalProfileVersion, insert: boolean): void {
  if (p.photoSha256 !== null) need(blobExists(db, p.photoSha256), 'a profile photo');
  if (insert) {
    db.run(
      `INSERT INTO profiles (id, display_name, relationship, description, photo_sha256, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.displayName, p.relationship, p.description, p.photoSha256, p.archivedAt, p.createdAt, p.updatedAt],
    );
    return;
  }
  db.run(
    `UPDATE profiles SET display_name = ?, relationship = ?, description = ?, photo_sha256 = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    [p.displayName, p.relationship, p.description, p.photoSha256, p.archivedAt, p.updatedAt, p.id],
  );
}

const sameProfile = (a: LocalProfileVersion, b: LocalProfileVersion) =>
  a.displayName === b.displayName && a.relationship === b.relationship && a.description === b.description &&
  a.photoSha256 === b.photoSha256 && a.archivedAt === b.archivedAt;

const sameConversation = (a: LocalConversationVersion, b: LocalConversationVersion) =>
  a.title === b.title && a.source === b.source && a.sourceKey === b.sourceKey && a.isGroup === b.isGroup &&
  JSON.stringify([...a.profileIds].sort(byText)) === JSON.stringify([...b.profileIds].sort(byText)) &&
  JSON.stringify([...a.participants].sort((x, y) => byText(x.displayName, y.displayName))) ===
    JSON.stringify([...b.participants].sort((x, y) => byText(x.displayName, y.displayName)));

/**
 * Makes the conversation `c` here: its fields, its profile links and the profile / "me" link of
 * each named participant (participants that only carry messages are not part of the record and
 * are left alone). Every caller stamps the conversation afterwards, which is what lets a change to
 * `participants.profile_id` reach a third device. The profiles must exist.
 */
export function writeConversation(db: SqlDb, c: PackConversation | LocalConversationVersion, insert: boolean): void {
  for (const profileId of c.profileIds) need(profileExists(db, profileId), 'a profile');
  for (const p of c.participants) if (p.profileId !== null) need(profileExists(db, p.profileId), 'a profile');
  if (insert) {
    db.run('INSERT INTO conversations (id, title, source, source_key, is_group, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      c.id, c.title, c.source, c.sourceKey, c.isGroup ? 1 : 0, c.createdAt,
    ]);
  } else {
    db.run('UPDATE conversations SET title = ?, source = ?, source_key = ?, is_group = ? WHERE id = ?', [
      c.title, c.source, c.sourceKey, c.isGroup ? 1 : 0, c.id,
    ]);
    db.run('DELETE FROM conversation_profiles WHERE conversation_id = ?', [c.id]);
    db.run('UPDATE participants SET profile_id = NULL, is_me = 0 WHERE conversation_id = ? AND (profile_id IS NOT NULL OR is_me = 1)', [c.id]);
  }
  for (const profileId of c.profileIds) {
    db.run('INSERT INTO conversation_profiles (conversation_id, profile_id) VALUES (?, ?)', [c.id, profileId]);
  }
  for (const p of c.participants) {
    db.run('INSERT OR IGNORE INTO participants (conversation_id, display_name) VALUES (?, ?)', [c.id, p.displayName]);
    db.run('UPDATE participants SET profile_id = ?, is_me = ? WHERE conversation_id = ? AND display_name = ?', [
      p.profileId, p.isMe ? 1 : 0, c.id, p.displayName,
    ]);
  }
}

/** Inserts a note (`created`/`updated` as given) for a target that exists. The caller stamps it. */
export function insertNote(db: SqlDb, target: PackNoteTarget, body: string, createdAt: string, updatedAt: string): void {
  if (target.kind === 'profile') need(profileExists(db, target.profileId), 'a profile');
  else need(conversationExists(db, target.conversationId), 'a conversation');
  const w = noteWhere(target);
  db.run('INSERT INTO notes (kind, profile_id, conversation_id, fingerprint, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    w.kind, w.profileId, w.conversationId, w.fingerprint, body, createdAt, updatedAt,
  ]);
}

// -------------------------------------------------------- conflicts

export function storeConflict(
  db: SqlDb,
  peerId: string,
  kind: 'profile' | 'conversation' | 'note' | 'batch',
  scope: string,
  key: string,
  incoming: PackProfile | PackConversation | PackNote | PackTombstone,
  incomingDeleted: boolean,
  now: string,
): void {
  db.run(
    `INSERT INTO sync_conflicts (peer_id, kind, scope, key, incoming, incoming_deleted, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (peer_id, kind, scope, key) DO UPDATE SET incoming = excluded.incoming,
       incoming_deleted = excluded.incoming_deleted, detected_at = excluded.detected_at`,
    [peerId, kind, scope, key, JSON.stringify(incoming), incomingDeleted ? 1 : 0, now],
  );
}

/** The peer's version of this record now agrees with ours (or replaced it): the open conflict is moot. */
export function clearConflict(db: SqlDb, peerId: string, kind: string, scope: string, key: string): void {
  db.run('DELETE FROM sync_conflicts WHERE peer_id = ? AND kind = ? AND scope = ? AND key = ?', [peerId, kind, scope, key]);
}

/** Held by an open conflict: profile photos that have not been chosen yet (their bytes must stay). */
export function heldByConflicts(db: SqlDb): Set<string> {
  const held = new Set<string>();
  for (const row of db.all<{ incoming: string }>("SELECT incoming FROM sync_conflicts WHERE kind = 'profile' AND incoming_deleted = 0")) {
    const photo = (JSON.parse(row.incoming) as { photoSha256?: unknown }).photoSha256;
    if (typeof photo === 'string') held.add(photo);
  }
  return held;
}

// ------------------------------------------------------------ merge

const emptyCounts = (): MergeCounts => ({
  blobs: 0,
  profiles: { added: 0, updated: 0 },
  conversations: { added: 0, updated: 0 },
  batches: 0,
  messages: { added: 0, skipped: 0 },
  favorites: { added: 0, removed: 0 },
  notes: { added: 0, updated: 0, removed: 0 },
});

interface Ctx {
  db: SqlDb;
  peer: string;
  now: string;
  lastReceived: number;
  lastSent: number;
  counts: MergeCounts;
  conflicts: number;
  batchOffers: number;
  /** Media hashes whose row this merge may have left unreferenced: new rows and replaced photos. */
  maybeUnreferenced: Set<string>;
  /** Conversations this merge created. */
  createdConversations: Set<string>;
}

/** `S changed it`: the record is newer than anything received from the source before. */
const sChanged = (ctx: Ctx, seq: number) => seq > ctx.lastReceived;
/** `we changed it`: edited here since the source last saw our data, and not a version that came from the source. */
const weChanged = (ctx: Ctx, row: { seq: number; changedBy: string | null }) => row.seq > ctx.lastSent && row.changedBy !== ctx.peer;

export function mergeChangesPack(db: SqlDb, raw: unknown): MergeChangesPackResult {
  const input = validate(raw);
  return transaction(db, () => {
    const refused = refusalOf(db, input);
    if (refused !== null) return { refused };
    const peer = input.sourceDeviceId;
    const known = getPeer(db, peer);
    const ctx: Ctx = {
      db, peer, now: input.now,
      lastReceived: known?.lastReceivedSeq ?? 0,
      // What the source has seen of OUR data. The pack's own `ack` is the better witness: our stored
      // `lastSent` also counts packs we exported but the source never imported. A full pack carries no ack.
      lastSent: input.kind === 'changes'
        ? Math.min(known?.lastSentSeq ?? 0, input.ack ?? 0, currentChangeSeq(db))
        : (known?.lastSentSeq ?? 0),
      counts: emptyCounts(), conflicts: 0, batchOffers: 0,
      maybeUnreferenced: new Set(), createdConversations: new Set(),
    };

    for (const b of input.blobs) {
      const [existing] = db.all<{ size: number }>('SELECT size FROM blobs WHERE sha256 = ?', [b.sha256]);
      if (existing) {
        if (existing.size !== b.size) throw invalid('a media file has a different size than the one stored here');
        continue;
      }
      db.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, ?, ?)', [b.sha256, b.size, b.mime]);
      ctx.counts.blobs++;
      ctx.maybeUnreferenced.add(b.sha256);
    }
    for (const p of input.profiles) mergeProfile(ctx, p);
    for (const c of input.conversations) mergeConversation(ctx, c);
    for (const b of input.batches) mergeBatch(ctx, b.header, b.messages);
    for (const f of input.favorites) {
      if (!sChanged(ctx, f.seq)) continue;
      need(conversationExists(db, f.conversationId), 'a conversation');
      const added = db.run('INSERT OR IGNORE INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [
        f.conversationId, f.fingerprint, f.createdAt,
      ]);
      if (added > 0) {
        stampMergedRows(db, 'favorites', peer, 'conversation_id = ? AND fingerprint = ?', [f.conversationId, f.fingerprint]);
        ctx.counts.favorites.added++;
      }
      // Add wins: the favorite exists now, so a deletion of ours (if any) is superseded.
      clearTombstone(db, 'favorite', f.conversationId, f.fingerprint);
    }
    for (const n of input.notes) mergeNote(ctx, n);
    for (const t of input.tombstones) mergeTombstone(ctx, t);

    // The watermark moves with the data, or not at all. A pack older than what was merged leaves it
    // alone; one that is no newer (the same pack again) only counts for what its `ack` says that we
    // did not already know, so importing a pack twice changes nothing.
    const ackedSent = input.ack === null ? null : Math.min(input.ack, currentChangeSeq(db));
    const newer = input.upTo > ctx.lastReceived;
    if (newer || (input.upTo === ctx.lastReceived && ackedSent !== null && ackedSent !== (known?.lastSentSeq ?? 0))) {
      recordReceived(db, { peerId: peer, upToSeq: input.upTo, ackedSeq: input.ack, now: input.now });
    }

    const held = heldByConflicts(db);
    const unreferencedBlobs: string[] = [];
    for (const sha256 of ctx.maybeUnreferenced) {
      if (held.has(sha256) || isReferenced(db, sha256)) continue;
      db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
      unreferencedBlobs.push(sha256);
    }
    return {
      refused: null,
      counts: ctx.counts,
      conflicts: ctx.conflicts,
      batchOffers: ctx.batchOffers,
      unreferencedBlobs,
      peer: getPeer(db, peer)!,
    };
  });
}

function mergeProfile(ctx: Ctx, incoming: PackProfile): void {
  const { db } = ctx;
  const local = readLocalProfile(db, incoming.id);
  if (!local) {
    writeProfile(db, incoming, true);
    stampMergedRows(db, 'profiles', ctx.peer, 'id = ?', [incoming.id]);
    ctx.counts.profiles.added++;
    return;
  }
  if (sameProfile(local, incoming)) return clearConflict(db, ctx.peer, 'profile', '', incoming.id);
  if (!sChanged(ctx, incoming.seq)) return;
  if (weChanged(ctx, local)) {
    storeConflict(db, ctx.peer, 'profile', '', incoming.id, incoming, false, ctx.now);
    ctx.conflicts++;
    return;
  }
  if (local.photoSha256 !== null && local.photoSha256 !== incoming.photoSha256) ctx.maybeUnreferenced.add(local.photoSha256);
  writeProfile(db, incoming, false);
  stampMergedRows(db, 'profiles', ctx.peer, 'id = ?', [incoming.id]);
  clearConflict(db, ctx.peer, 'profile', '', incoming.id);
  ctx.counts.profiles.updated++;
}

function mergeConversation(ctx: Ctx, incoming: PackConversation): void {
  const { db } = ctx;
  const local = readLocalConversation(db, incoming.id);
  if (!local) {
    writeConversation(db, incoming, true);
    stampMergedRows(db, 'conversations', ctx.peer, 'id = ?', [incoming.id]);
    ctx.createdConversations.add(incoming.id);
    ctx.counts.conversations.added++;
    return;
  }
  if (sameConversation(local, incoming)) return clearConflict(db, ctx.peer, 'conversation', '', incoming.id);
  if (!sChanged(ctx, incoming.seq)) return;
  if (weChanged(ctx, local)) {
    storeConflict(db, ctx.peer, 'conversation', '', incoming.id, incoming, false, ctx.now);
    ctx.conflicts++;
    return;
  }
  writeConversation(db, incoming, false);
  stampMergedRows(db, 'conversations', ctx.peer, 'id = ?', [incoming.id]);
  clearConflict(db, ctx.peer, 'conversation', '', incoming.id);
  ctx.counts.conversations.updated++;
}

function mergeBatch(ctx: Ctx, header: PackBatchHeader, messages: PackMessage[]): void {
  const { db } = ctx;
  if (db.all('SELECT 1 FROM import_batches WHERE id = ?', [header.id]).length > 0) return;
  // We undid this import ourselves: it stays undone.
  if (db.all("SELECT 1 FROM tombstones WHERE kind = 'batch' AND key = ?", [header.id]).length > 0) return;
  need(conversationExists(db, header.conversationId), 'a conversation');
  const created = header.createdConversation && ctx.createdConversations.has(header.conversationId);
  db.run(
    `INSERT INTO import_batches (id, conversation_id, source, source_label, created_at, created_conversation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [header.id, header.conversationId, header.source, header.sourceLabel, header.createdAt, created ? 1 : 0],
  );
  const participantIds = new Map<string, number>();
  const participantId = (name: string): number => {
    let id = participantIds.get(name);
    if (id === undefined) {
      db.run('INSERT OR IGNORE INTO participants (conversation_id, display_name) VALUES (?, ?)', [header.conversationId, name]);
      id = db.all<{ id: number }>('SELECT id FROM participants WHERE conversation_id = ? AND display_name = ?', [header.conversationId, name])[0].id;
      participantIds.set(name, id);
    }
    return id;
  };
  const checkedMedia = new Set<string>();
  let added = 0;
  for (const m of messages) {
    if (db.all('SELECT 1 FROM messages WHERE conversation_id = ? AND fingerprint = ?', [header.conversationId, m.fingerprint]).length > 0) continue;
    if (m.mediaSha256 !== null && !checkedMedia.has(m.mediaSha256)) {
      need(blobExists(db, m.mediaSha256), 'a media file');
      checkedMedia.add(m.mediaSha256);
    }
    added += db.run(
      `INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, ordinal, type, participant_id, body, media_sha256, media_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, fingerprint) DO NOTHING`,
      [
        header.conversationId, header.id, m.fingerprint, m.sentAt, m.ordinal, m.type,
        m.author === null ? null : participantId(m.author), m.body, m.mediaSha256, m.mediaName,
      ],
    );
  }
  ctx.counts.messages.skipped += messages.length - added;
  if (added === 0) {
    // Nothing new: no empty history entry (and running it again is still a no-op).
    db.run('DELETE FROM import_batches WHERE id = ?', [header.id]);
    return;
  }
  db.run('UPDATE import_batches SET added_count = ?, skipped_count = ? WHERE id = ?', [added, messages.length - added, header.id]);
  stampMergedRows(db, 'import_batches', ctx.peer, 'id = ?', [header.id]);
  ctx.counts.messages.added += added;
  ctx.counts.batches++;
}

function mergeNote(ctx: Ctx, incoming: PackNote): void {
  const { db } = ctx;
  const { scope, key } = noteTombstoneKey(incoming.target);
  const w = noteWhere(incoming.target);
  const local = readLocalNote(db, incoming.target);
  if (!local) {
    const [tombstone] = db.all<{ seq: number; changedBy: string | null }>(
      "SELECT seq, changed_by AS changedBy FROM tombstones WHERE kind = 'note' AND scope = ? AND key = ?",
      [scope, key],
    );
    if (tombstone) {
      if (!sChanged(ctx, incoming.seq)) return;
      // The source wrote it without having seen our deletion: keep both, resurrect nothing.
      if (weChanged(ctx, tombstone)) {
        storeConflict(db, ctx.peer, 'note', scope, key, incoming, false, ctx.now);
        ctx.conflicts++;
        return;
      }
      clearTombstone(db, 'note', scope, key);
    }
    insertNote(db, incoming.target, incoming.body, incoming.createdAt, incoming.updatedAt);
    stampMergedRows(db, 'notes', ctx.peer, w.where, w.params);
    ctx.counts.notes.added++;
    return;
  }
  if (local.body === incoming.body) return clearConflict(db, ctx.peer, 'note', scope, key);
  if (!sChanged(ctx, incoming.seq)) return;
  if (weChanged(ctx, local)) {
    storeConflict(db, ctx.peer, 'note', scope, key, incoming, false, ctx.now);
    ctx.conflicts++;
    return;
  }
  db.run(`UPDATE notes SET body = ?, created_at = ?, updated_at = ? WHERE ${w.where}`, [incoming.body, incoming.createdAt, incoming.updatedAt, ...w.params]);
  stampMergedRows(db, 'notes', ctx.peer, w.where, w.params);
  clearConflict(db, ctx.peer, 'note', scope, key);
  ctx.counts.notes.updated++;
}

function noteTargetOf(scope: string, key: string): PackNoteTarget {
  if (scope === '') return { kind: 'profile', profileId: key.slice('profile:'.length) };
  if (key === 'conversation') return { kind: 'conversation', conversationId: scope };
  return { kind: 'message', conversationId: scope, fingerprint: key.slice('message:'.length) };
}

function mergeTombstone(ctx: Ctx, t: PackTombstone): void {
  const { db } = ctx;
  // A deletion we already knew about (a replay or closure record) decides nothing.
  if (!sChanged(ctx, t.seq)) return;
  const hasTombstone = () =>
    db.all('SELECT 1 FROM tombstones WHERE kind = ? AND scope = ? AND key = ?', [t.kind, t.scope, t.key]).length > 0;

  if (t.kind === 'favorite') {
    const [local] = db.all<{ seq: number; changedBy: string | null }>(
      'SELECT seq, changed_by AS changedBy FROM favorites WHERE conversation_id = ? AND fingerprint = ?',
      [t.scope, t.key],
    );
    if (local) {
      // Added here since the source last saw our data: add wins, nothing is lost.
      if (weChanged(ctx, local)) return;
      db.run('DELETE FROM favorites WHERE conversation_id = ? AND fingerprint = ?', [t.scope, t.key]);
      ctx.counts.favorites.removed++;
    } else if (hasTombstone()) return;
    recordMergedTombstone(db, ctx.peer, 'favorite', t.scope, t.key, t.deletedAt);
    return;
  }

  if (t.kind === 'note') {
    const target = noteTargetOf(t.scope, t.key);
    const local = readLocalNote(db, target);
    if (local) {
      if (weChanged(ctx, local)) {
        // Deleted there, edited here: the note stays, the deletion is kept beside it.
        storeConflict(db, ctx.peer, 'note', t.scope, t.key, t, true, ctx.now);
        ctx.conflicts++;
        return;
      }
      const w = noteWhere(target);
      db.run(`DELETE FROM notes WHERE ${w.where}`, w.params);
      clearConflict(db, ctx.peer, 'note', t.scope, t.key);
      ctx.counts.notes.removed++;
    } else if (hasTombstone()) return;
    recordMergedTombstone(db, ctx.peer, 'note', t.scope, t.key, t.deletedAt);
    return;
  }

  // An undone import is only offered; nothing here is removed. If we undid it too, there is nothing to offer.
  if (hasTombstone()) return;
  storeConflict(db, ctx.peer, 'batch', t.scope, t.key, t, true, ctx.now);
  ctx.batchOffers++;
}
