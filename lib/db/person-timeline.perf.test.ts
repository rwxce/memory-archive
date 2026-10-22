import { beforeAll, describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import {
  TIMELINE_IDS_SQL,
  createProfile,
  findPersonTimelineOffsetByDate,
  getPersonTimelineBounds,
  getPersonTimelineWindow,
  linkConversationProfile,
  listPersonTimelineDays,
} from './queries';
import type { SqlDb } from './sql';
import { createSyntheticConversation } from './synthetic-archive';

/**
 * Performance guard for a person's combined timeline: ~200k messages over 4 conversations, 3 of
 * them one person's (75%) and one someone else's. The window must walk `messages_by_time` (v4)
 * in order: no sort, no table lookups for the OFFSET skip. `VITEST_PERF_COUNT=20000` shrinks
 * it. Budgets are loose (CI); the measured numbers are in `docs/blueprint.md`.
 */
const COUNT = Number(process.env.VITEST_PERF_COUNT ?? 200_000);
const BUDGET_MS = { window: 250, date: 250, days: 1500, bounds: 250 };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PERSON = uuid(1);
const OTHER = uuid(2);
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
  createProfile(db, { id: OTHER, displayName: 'Bo', now: '2026-02-01T12:00:00Z' });
  for (let i = 0; i < 4; i++) {
    createSyntheticConversation(db, { count: part, conversationId: uuid(10 + i), batchId: uuid(20 + i) });
    linkConversationProfile(db, { conversationId: uuid(10 + i), profileId: i < 3 ? PERSON : OTHER });
  }
  total = getPersonTimelineBounds(db, PERSON).count;
}, 120_000);

describe(`person timeline on a ${COUNT}-message synthetic archive (performance guard)`, () => {
  test('the window ids walk messages_by_time in order: no sort, no table scan', () => {
    const plan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${TIMELINE_IDS_SQL}`, [PERSON, 100, 100_000])
      .map((r) => r.detail)
      .join('\n');
    console.info(`[perf] person timeline plan:\n${plan}`);
    expect(plan).toContain('COVERING INDEX messages_by_time');
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  test('the person owns exactly their three conversations', () => {
    expect(total).toBe(Math.floor(COUNT / 4) * 3);
  });

  test.each([0, 0.5, 0.99])('getPersonTimelineWindow at %f of the timeline stays within budget', (fraction) => {
    const offset = Math.min(Math.floor(total * fraction), total - 100);
    const rows = getPersonTimelineWindow(db, PERSON, offset, 100);
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((r) => r.conversationId)).size).toBeGreaterThan(0);
    const took = ms(() => getPersonTimelineWindow(db, PERSON, offset, 100));
    console.info(`[perf] getPersonTimelineWindow offset ${offset}: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(BUDGET_MS.window);
  });

  test('the worst case for the time index: a person with 25% of the archive, last page', () => {
    const own = getPersonTimelineBounds(db, OTHER).count;
    const took = ms(() => getPersonTimelineWindow(db, OTHER, own - 100, 100));
    expect(getPersonTimelineWindow(db, OTHER, own - 100, 100)).toHaveLength(100);
    console.info(`[perf] getPersonTimelineWindow, person with ${own} of ${COUNT}, last page: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(BUDGET_MS.window);
  });

  test('bounds, date jump and days stay within budget and agree with the window', () => {
    const bounds = ms(() => getPersonTimelineBounds(db, PERSON));
    const date = '2020-03-01';
    const offset = findPersonTimelineOffsetByDate(db, PERSON, date);
    expect(getPersonTimelineWindow(db, PERSON, offset!, 1)[0].sentAt >= `${date}T00:00:00`).toBe(true);
    expect(offset === 0 || getPersonTimelineWindow(db, PERSON, offset! - 1, 1)[0].sentAt < `${date}T00:00:00`).toBe(true);
    const jump = ms(() => findPersonTimelineOffsetByDate(db, PERSON, date));
    const days = listPersonTimelineDays(db, PERSON);
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(total);
    const daysMs = ms(() => listPersonTimelineDays(db, PERSON));
    console.info(`[perf] person timeline bounds ${bounds.toFixed(1)} ms, date jump ${jump.toFixed(1)} ms, days (${days.length}) ${daysMs.toFixed(1)} ms`);
    expect(bounds).toBeLessThan(BUDGET_MS.bounds);
    expect(jump).toBeLessThan(BUDGET_MS.date);
    expect(daysMs).toBeLessThan(BUDGET_MS.days);
  });
});
