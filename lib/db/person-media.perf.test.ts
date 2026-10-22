import { beforeAll, describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import { countPersonMedia, createProfile, linkConversationProfile, listPersonMedia } from './queries';
import type { SqlDb } from './sql';
import { createSyntheticConversation } from './synthetic-archive';

/**
 * Performance guard for a person's media list: ~200k messages over 3 conversations of one person
 * (plus one of someone else), ~5% audio. No schema change: the plan is a nested loop over the
 * person's conversations on `messages_timeline` / `messages_by_media`, then one sort of the
 * matching ids only. `VITEST_PERF_COUNT=20000` shrinks it. Budgets are loose (CI); the measured
 * numbers are in `docs/blueprint.md`.
 */
const COUNT = Number(process.env.VITEST_PERF_COUNT ?? 200_000);
const BUDGET_MS = { page: 250, count: 250 };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PERSON = uuid(1);
const OTHER = uuid(2);

let db: SqlDb;

function ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

beforeAll(async () => {
  db = (await openMemoryDb()).db;
  const part = Math.floor(COUNT / 4);
  createProfile(db, { id: PERSON, displayName: 'Ana', now: '2026-02-01T12:00:00Z' });
  createProfile(db, { id: OTHER, displayName: 'Bo', now: '2026-02-01T12:00:00Z' });
  for (let i = 0; i < 4; i++) {
    createSyntheticConversation(db, { count: part, conversationId: uuid(10 + i), batchId: uuid(20 + i) });
    linkConversationProfile(db, { conversationId: uuid(10 + i), profileId: i < 3 ? PERSON : OTHER });
  }
  // About half of the photos (5-7% of messages) becomes audio.
  db.run("UPDATE messages SET type = 'audio' WHERE type = 'photo' AND id % 2 = 0");
}, 120_000);

describe(`person media on a ${COUNT}-message synthetic archive (performance guard)`, () => {
  test('the plan starts from the person\'s conversations and never scans messages', () => {
    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT m.id FROM messages m
          WHERE m.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)
            AND m.media_sha256 IS NOT NULL AND m.type IN (?)
          ORDER BY m.sent_at, m.ordinal, m.id LIMIT 100 OFFSET 0`,
        [PERSON, 'audio'],
      )
      .map((r) => r.detail)
      .join('\n');
    console.info(`[perf] person media plan:\n${plan}`);
    expect(plan).not.toMatch(/SCAN m\b/);
  });

  test('listing and counting audio stay within budget', () => {
    const total = countPersonMedia(db, PERSON, ['audio']);
    expect(total).toBeGreaterThan(COUNT * 0.02);
    expect(total).toBeLessThan(COUNT * 0.1);
    const first = listPersonMedia(db, PERSON, ['audio'], 0, 100);
    expect(first).toHaveLength(100);
    const page = ms(() => listPersonMedia(db, PERSON, ['audio'], 0, 100));
    const deep = ms(() => listPersonMedia(db, PERSON, ['audio'], total - 100, 100));
    const count = ms(() => countPersonMedia(db, PERSON, ['audio']));
    console.info(`[perf] person audio (${total} items): first page ${page.toFixed(1)} ms, last page ${deep.toFixed(1)} ms, count ${count.toFixed(1)} ms`);
    expect(page).toBeLessThan(BUDGET_MS.page);
    expect(deep).toBeLessThan(BUDGET_MS.page);
    expect(count).toBeLessThan(BUDGET_MS.count);
  });
});
