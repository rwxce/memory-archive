import {
  HIGHLIGHT_CATEGORIES,
  FINDINGS_VERSION,
  parseFindings,
  type Highlight,
  type HighlightCategory,
  type HighlightImportCounts,
  type HighlightItem,
  type HighlightMessage,
} from '../domain/highlights';
import { DbError } from './errors';
import { findExistingFingerprints, MAX_WINDOW, requireConversation, requireProfile } from './queries';
import { transaction, type SqlDb, type SqlValue } from './sql';

/**
 * Highlights (schema v7): key moments, patterns and messages of interest imported from a
 * `findings.json`. A highlight is kept per conversation under the id its author gave it; its
 * messages by `(conversation, fingerprint)` with no link to the local message id, so they survive
 * backup, restore, merge and undo + re-import. Reads join `messages`: a highlight none of whose
 * messages is in the archive is dormant (not listed or counted) and returns with its messages.
 * Text is untrusted and never logged.
 */

function invalid(message: string): never {
  throw new DbError('invalid', message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireHighlightId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 100) invalid('highlight id must be 1 to 100 characters');
  return value;
}

export interface ImportHighlightsInput {
  conversationId: string;
  highlights: Highlight[];
  /** UTC instant (ISO 8601); recorded as `imported_at` of what is created or changed. */
  now: string;
}

/**
 * Stores the highlights of a file in a conversation, all or nothing. Idempotent by highlight id:
 * a new id is created, an id whose content changed is updated in place (messages replaced,
 * `imported_at` moves), an identical one changes nothing. Only fingerprints that are in the
 * conversation are stored; a highlight left with none is skipped (reported, and an existing one
 * with that id is left alone). The highlights are validated again here (`FINDINGS_LIMITS`):
 * `invalid` for bad data, `not-found` for an unknown conversation.
 */
export function importHighlights(db: SqlDb, input: ImportHighlightsInput): HighlightImportCounts {
  requireRecord(input, 'params');
  const conversationId = requireConversation(db, input.conversationId);
  if (typeof input.now !== 'string') invalid('now must be a string');
  const checked = parseFindings({
    version: FINDINGS_VERSION,
    conversation: { name: 'x', messageCount: 0 },
    highlights: input.highlights,
  });
  if (!checked.ok) invalid(`invalid highlights: ${checked.errors[0].path}: ${checked.errors[0].message}`);
  const highlights = checked.value.highlights;

  return transaction(db, () => {
    const all = [...new Set(highlights.flatMap((h) => h.messages))];
    const known = new Set(findExistingFingerprints(db, { conversationId, fingerprints: all }));
    const counts: HighlightImportCounts = { imported: 0, updated: 0, unchanged: 0, skippedHighlights: [], skippedFingerprints: 0 };

    for (const h of highlights) {
      counts.skippedFingerprints += h.messages.filter((f) => !known.has(f)).length;
      const messages = [...new Set(h.messages.filter((f) => known.has(f)))];
      if (messages.length === 0) {
        counts.skippedHighlights.push(h.id);
        continue;
      }
      const [existing] = db.all<{ category: string; title: string; summary: string; createdBy: string; createdAt: string }>(
        'SELECT category, title, summary, created_by AS createdBy, created_at AS createdAt FROM highlights WHERE conversation_id = ? AND id = ?',
        [conversationId, h.id],
      );
      if (existing) {
        const stored = db
          .all<{ fingerprint: string }>(
            'SELECT fingerprint FROM highlight_messages WHERE conversation_id = ? AND highlight_id = ? ORDER BY position',
            [conversationId, h.id],
          )
          .map((r) => r.fingerprint);
        const same =
          existing.category === h.category &&
          existing.title === h.title &&
          existing.summary === h.summary &&
          existing.createdBy === h.createdBy &&
          existing.createdAt === h.createdAt &&
          stored.length === messages.length &&
          stored.every((f, i) => f === messages[i]);
        if (same) {
          counts.unchanged++;
          continue;
        }
        db.run(
          'UPDATE highlights SET category = ?, title = ?, summary = ?, created_by = ?, created_at = ?, imported_at = ? WHERE conversation_id = ? AND id = ?',
          [h.category, h.title, h.summary, h.createdBy, h.createdAt, input.now, conversationId, h.id],
        );
        db.run('DELETE FROM highlight_messages WHERE conversation_id = ? AND highlight_id = ?', [conversationId, h.id]);
        counts.updated++;
      } else {
        db.run(
          'INSERT INTO highlights (conversation_id, id, category, title, summary, created_by, created_at, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [conversationId, h.id, h.category, h.title, h.summary, h.createdBy, h.createdAt, input.now],
        );
        counts.imported++;
      }
      messages.forEach((fingerprint, position) => {
        db.run('INSERT INTO highlight_messages (conversation_id, highlight_id, fingerprint, position) VALUES (?, ?, ?, ?)', [
          conversationId,
          h.id,
          fingerprint,
          position,
        ]);
      });
    }
    return counts;
  });
}

export interface HighlightScope {
  /** Only highlights in conversations linked to this person. */
  profileId?: string;
  /** Only highlights of this conversation. At most one of the two; none = the whole archive. */
  conversationId?: string;
}

export interface HighlightFilter {
  scope?: HighlightScope;
  /** Only this category; absent = all. */
  category?: HighlightCategory;
}

/** Validates the filter and returns its condition over `h` (highlights) and its parameters. */
function highlightFilter(db: SqlDb, filter: HighlightFilter | undefined): { where: string; params: SqlValue[] } {
  const f = filter === undefined ? {} : requireRecord(filter, 'params');
  const s = f.scope === undefined ? {} : requireRecord(f.scope, 'scope');
  if (s.profileId !== undefined && s.conversationId !== undefined) invalid('scope takes a profile or a conversation, not both');
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (s.profileId !== undefined) {
    parts.push('AND h.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)');
    params.push(requireProfile(db, s.profileId));
  } else if (s.conversationId !== undefined) {
    parts.push('AND h.conversation_id = ?');
    params.push(requireConversation(db, s.conversationId));
  }
  if (f.category !== undefined) {
    if (!(HIGHLIGHT_CATEGORIES as readonly unknown[]).includes(f.category)) invalid(`category must be one of ${HIGHLIGHT_CATEGORIES.join(', ')}`);
    parts.push('AND h.category = ?');
    params.push(f.category as string);
  }
  return { where: parts.join(' '), params };
}

/** Highlights with at least one message in the archive, with the count and earliest time of those. */
const VISIBLE = `
  FROM highlights h
  JOIN (SELECT hm.conversation_id AS cid, hm.highlight_id AS hid, count(*) AS n, min(m.sent_at) AS first
          FROM highlight_messages hm
          JOIN messages m ON m.conversation_id = hm.conversation_id AND m.fingerprint = hm.fingerprint
         GROUP BY hm.conversation_id, hm.highlight_id) v ON v.cid = h.conversation_id AND v.hid = h.id`;

/** How many highlights are visible for the filter (dormant ones are not counted). */
export function countHighlights(db: SqlDb, filter?: HighlightFilter): number {
  const { where, params } = highlightFilter(db, filter);
  return db.all<{ n: number }>(`SELECT count(*) AS n ${VISIBLE} WHERE 1 = 1 ${where}`, params)[0].n;
}

/** Visible highlights per category for a scope (the category in the filter is ignored). */
export function countHighlightsByCategory(db: SqlDb, scope?: HighlightScope): Record<HighlightCategory, number> {
  const { where, params } = highlightFilter(db, { scope });
  const out: Record<HighlightCategory, number> = { moment: 0, pattern: 0, interest: 0 };
  for (const r of db.all<{ category: HighlightCategory; n: number }>(
    `SELECT h.category AS category, count(*) AS n ${VISIBLE} WHERE 1 = 1 ${where} GROUP BY h.category`,
    params,
  )) {
    out[r.category] = r.n;
  }
  return out;
}

/**
 * `limit` highlights from position `offset`, in the order of their earliest message (ties by
 * conversation then id, so pages tile). Limit clamped to 1..MAX_WINDOW; past the end is empty.
 */
export function listHighlights(db: SqlDb, filter: HighlightFilter | undefined, offset: number, limit: number): HighlightItem[] {
  const { where, params } = highlightFilter(db, filter);
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
  if (!Number.isFinite(limit)) invalid('limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_WINDOW);
  return db.all<HighlightItem>(
    `SELECT h.id, h.conversation_id AS conversationId, c.title AS conversationTitle, h.category, h.title, h.summary,
            h.created_by AS createdBy, h.created_at AS createdAt, h.imported_at AS importedAt,
            v.n AS messageCount, v.first AS firstSentAt
       ${VISIBLE}
       JOIN conversations c ON c.id = h.conversation_id
      WHERE 1 = 1 ${where}
      ORDER BY v.first, h.conversation_id, h.id LIMIT ? OFFSET ?`,
    [...params, n, offset],
  );
}

type HighlightMessageRow = Omit<HighlightMessage, 'isMe'> & { isMe: number };

/**
 * The messages of one highlight that are in the archive, in the author's order (at most 200).
 * `not-found` when the highlight does not exist in that conversation.
 */
export function listHighlightMessages(db: SqlDb, conversationId: string, highlightId: string): HighlightMessage[] {
  const cid = requireConversation(db, conversationId);
  const hid = requireHighlightId(highlightId);
  if (db.all('SELECT 1 FROM highlights WHERE conversation_id = ? AND id = ?', [cid, hid]).length === 0) {
    throw new DbError('not-found', 'highlight not found');
  }
  return db
    .all<HighlightMessageRow>(
      `SELECT m.id, m.sent_at AS sentAt, m.type, p.display_name AS participantName, COALESCE(p.is_me, 0) AS isMe,
              m.body, m.media_name AS mediaName
         FROM highlight_messages hm
         JOIN messages m ON m.conversation_id = hm.conversation_id AND m.fingerprint = hm.fingerprint
         LEFT JOIN participants p ON p.id = m.participant_id
        WHERE hm.conversation_id = ? AND hm.highlight_id = ?
        ORDER BY hm.position`,
      [cid, hid],
    )
    .map((r) => ({ ...r, isMe: r.isMe === 1 }));
}

/** Deletes a highlight and its message links. `false` when there was none. Importing its file again brings it back. */
export function deleteHighlight(db: SqlDb, conversationId: string, highlightId: string): boolean {
  const cid = requireConversation(db, conversationId);
  const hid = requireHighlightId(highlightId);
  return transaction(db, () => {
    const found = db.all('SELECT 1 FROM highlights WHERE conversation_id = ? AND id = ?', [cid, hid]).length > 0;
    if (found) db.run('DELETE FROM highlights WHERE conversation_id = ? AND id = ?', [cid, hid]);
    return found;
  });
}
