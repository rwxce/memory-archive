import { importMessages } from './queries';
import { transaction, type SqlDb } from './sql';

/**
 * Test helper: a deterministic synthetic conversation of any size, for performance guards (the
 * database layer's and, later, the conversation view's). Nothing here is real data.
 *
 * Rows go in through one `INSERT ... SELECT` over a recursive counter, so 200k messages take a
 * moment, but every table constraint (CHECKs, UNIQUE fingerprint, foreign keys) still applies.
 * Shape, by message index `i` (so the same `count` always yields the same archive):
 * - 200 messages a day from 2020-01-01, in pairs sharing the same second (`ordinal` 0 and 1), so
 *   same-time ordering is exercised;
 * - author `Ana` (the user, `is_me`) or `Bo`, alternating by `i`;
 * - every 10th message is a photo of one of 32 blobs, every 97th a system notice (no author).
 */
export const SYNTHETIC_MESSAGES_PER_DAY = 200;
const BLOBS = 32;
const BASE_UNIX = 1_577_836_800; // 2020-01-01T00:00:00Z

export const syntheticBlobHash = (n: number) => (n % BLOBS).toString(16).padStart(2, '0').repeat(32);

export interface SyntheticConversation {
  conversationId: string;
  batchId: string;
  count: number;
  /** Local date of the first message and number of days that have messages. */
  firstDate: string;
  days: number;
}

export function createSyntheticConversation(
  db: SqlDb,
  options: { count: number; conversationId?: string; batchId?: string },
): SyntheticConversation {
  const { count } = options;
  const conversationId = options.conversationId ?? '00000000-0000-4000-8000-0000000000c1';
  const batchId = options.batchId ?? '00000000-0000-4000-8000-0000000000b1';
  const now = '2026-02-01T12:00:00Z';
  // The conversation and its batch go through the real import path with no messages;
  importMessages(db, {
    batchId,
    conversationId,
    source: 'synthetic',
    sourceLabel: 'synthetic.zip',
    now,
    blobs: [],
    messages: [],
    newConversation: { title: 'Synthetic', sourceKey: 'synthetic', isGroup: false, profileIds: [] },
  });
  // (blobs are added after: an import with no message referring to them would drop them again)
  for (let n = 0; n < BLOBS; n++) db.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, ?)', [syntheticBlobHash(n), n % 2 ? 'image/png' : null]);
  db.run('INSERT INTO participants (conversation_id, display_name, is_me) VALUES (?, ?, 1), (?, ?, 0)', [conversationId, 'Ana', conversationId, 'Bo']);
  // the bulk rows are one statement over a counter.
  transaction(db, () => {
    db.run(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
       INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, ordinal, type,
                             participant_id, body, media_sha256, media_name)
       SELECT ?, ?, printf('%064x', i),
              strftime('%Y-%m-%dT%H:%M:%S', ? + (i / ?) * 86400 + ((i % ?) / 2) * 800, 'unixepoch'),
              i % 2,
              CASE WHEN i % 97 = 96 THEN 'system' WHEN i % 10 = 9 THEN 'photo' ELSE 'text' END,
              CASE WHEN i % 97 = 96 THEN NULL
                   ELSE (SELECT id FROM participants WHERE conversation_id = ? AND display_name = CASE WHEN i % 2 = 0 THEN 'Ana' ELSE 'Bo' END) END,
              'synthetic message ' || i,
              CASE WHEN i % 97 <> 96 AND i % 10 = 9 THEN replace(hex(zeroblob(32)), '00', printf('%02x', (i / 10) % ?)) END,
              CASE WHEN i % 97 <> 96 AND i % 10 = 9 THEN 'IMG-' || i || '.jpg' ELSE '' END
         FROM n`,
      [count, conversationId, batchId, BASE_UNIX, SYNTHETIC_MESSAGES_PER_DAY, SYNTHETIC_MESSAGES_PER_DAY, conversationId, BLOBS],
    );
  });
  return { conversationId, batchId, count, firstDate: '2020-01-01', days: Math.ceil(count / SYNTHETIC_MESSAGES_PER_DAY) };
}
