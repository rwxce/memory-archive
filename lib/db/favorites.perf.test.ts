import { beforeAll, describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import { countFavorites, createProfile, getMessageWindow, getPersonTimelineWindow, linkConversationProfile, listFavorites } from './queries';
import type { SqlDb } from './sql';
import { createSyntheticConversation } from './synthetic-archive';

/**
 * Performance guard for favorites: ~200k messages over 4 conversations (3 linked to one person) and
 * ~2k favorites (1%). The windows now LEFT JOIN `favorites` on its primary key for the page's rows
 * only, so they must stay as fast as without it; the favorites list sorts the few favorites.
 * `VITEST_PERF_COUNT=20000` shrinks it. Budgets are loose (CI); the measured numbers are in
 * `docs/blueprint.md`.
 */
const COUNT = Number(process.env.VITEST_PERF_COUNT ?? 200_000);
const BUDGET_MS = { window: 250, list: 100 };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PERSON = uuid(1);
let db: SqlDb;
let total: number;

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
  for (let i = 0; i < 4; i++) {
    createSyntheticConversation(db, { count: part, conversationId: uuid(10 + i), batchId: uuid(20 + i) });
    if (i < 3) linkConversationProfile(db, { conversationId: uuid(10 + i), profileId: PERSON });
  }
  total = part * 3;
}, 120_000);

const favorite = () =>
  db.run(`INSERT INTO favorites (conversation_id, fingerprint, created_at)
          SELECT conversation_id, fingerprint, '2026-02-01T12:00:00Z' FROM messages WHERE id % ? = 0`, [Math.round(COUNT / 2000)]);

describe(`favorites on a ${COUNT}-message synthetic archive (performance guard)`, () => {
  test('windows without and with ~2k favorites', () => {
    const offsets = [0, Math.floor(total / 2), total - 100];
    const run = () => offsets.map((o) => [ms(() => getMessageWindow(db, uuid(10), Math.min(o, Math.floor(COUNT / 4) - 100), 100)), ms(() => getPersonTimelineWindow(db, PERSON, o, 100))]);
    const before = run();
    favorite();
    const after = run();
    console.info(`[perf] windows before/after ~2k favorites (ms) conversation|timeline at start,middle,end: ${JSON.stringify(before.map((r) => r.map((v) => +v.toFixed(1))))} -> ${JSON.stringify(after.map((r) => r.map((v) => +v.toFixed(1))))}`);
    for (const [conversation, timeline] of after) {
      expect(conversation).toBeLessThan(BUDGET_MS.window);
      expect(timeline).toBeLessThan(BUDGET_MS.window);
    }
    expect(getPersonTimelineWindow(db, PERSON, 0, 500).some((m) => m.isFavorite)).toBe(true);
  });

  test('count and list pages (whole archive, one person, one conversation) stay within budget', () => {
    const n = countFavorites(db);
    expect(n).toBeGreaterThan(1500);
    const count = ms(() => countFavorites(db));
    const first = ms(() => listFavorites(db, undefined, 0, 100));
    const last = ms(() => listFavorites(db, undefined, n - 100, 100));
    const person = ms(() => listFavorites(db, { profileId: PERSON }, 0, 100));
    const one = ms(() => listFavorites(db, { conversationId: uuid(10) }, 0, 100));
    console.info(`[perf] favorites (${n}): count ${count.toFixed(1)} ms, first page ${first.toFixed(1)}, last ${last.toFixed(1)}, person ${person.toFixed(1)}, conversation ${one.toFixed(1)}`);
    for (const t of [count, first, last, person, one]) expect(t).toBeLessThan(BUDGET_MS.list);
    expect(listFavorites(db, undefined, n - 100, 100)).toHaveLength(100);
  });
});
