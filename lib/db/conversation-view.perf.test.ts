import { beforeAll, describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import {
  MESSAGE_WINDOW_SQL,
  WINDOW_IDS_SQL,
  countMessages,
  findMessageOffsetByDate,
  getConversationBounds,
  getMessageWindow,
  listConversationDays,
} from './queries';
import type { SqlDb } from './sql';
import { createSyntheticConversation, type SyntheticConversation } from './synthetic-archive';

/**
 * Performance guard for the conversation view's reads (Phase 5: "a 200k-message archive scrolls
 * smoothly"). The read ops must stay index-driven: a window at offset 199,900 is a covering
 * index walk, never a table scan or a sort.
 *
 * Size: 200,000 messages by default (generation ~1 s); `VITEST_PERF_COUNT=20000` shrinks it.
 *
 * Budgets are 12-40x the numbers measured on the author's machine (Apple silicon, Node 24,
 * SQLite WASM in memory), so a loaded CI runner does not flake but a regression to a scan
 * (hundreds of ms to seconds) still fails. Measured (200k): see `docs/blueprint.md`.
 */
const COUNT = Number(process.env.VITEST_PERF_COUNT ?? 200_000);
const BUDGET_MS = { window: 250, date: 250, days: 1500, count: 250 };

let db: SqlDb;
let conv: SyntheticConversation;

/** Best of 3 runs, so one GC pause or a cold page does not decide the verdict. */
function ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const plan = (sql: string, params: (string | number)[]) =>
  db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r.detail).join('\n');

beforeAll(async () => {
  db = (await openMemoryDb()).db;
  const start = performance.now();
  conv = createSyntheticConversation(db, { count: COUNT });
  console.info(`[perf] generated ${COUNT} synthetic messages in ${Math.round(performance.now() - start)} ms`);
}, 120_000);

describe(`conversation view reads on a ${COUNT}-message synthetic archive (performance guard)`, () => {
  test('the archive has what the generator promised', () => {
    expect(countMessages(db, conv.conversationId)).toBe(COUNT);
    expect(getConversationBounds(db, conv.conversationId)).toMatchObject({ count: COUNT, firstSentAt: '2020-01-01T00:00:00' });
  });

  test('windows are index-driven: no table scan, no temp b-tree for ORDER BY', () => {
    const idsPlan = plan(WINDOW_IDS_SQL, [conv.conversationId, 100, 150_000]);
    expect(idsPlan).toContain('messages_timeline');
    expect(idsPlan).toContain('COVERING INDEX');
    expect(idsPlan).not.toMatch(/TEMP B-TREE/);
    const fullPlan = plan(MESSAGE_WINDOW_SQL, [conv.conversationId, 100, 150_000]);
    expect(fullPlan).not.toMatch(/SCAN m\b/);
    // The only sort is the final one over the window's own <= 500 rows.
    expect(fullPlan.match(/TEMP B-TREE/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  test('date jump and count are range scans on the same index', () => {
    const jump = plan('SELECT count(*) FROM messages WHERE conversation_id = ? AND sent_at < ?', [conv.conversationId, '2021-01-01T00:00:00']);
    expect(jump).toContain('COVERING INDEX messages_timeline');
    expect(jump).not.toMatch(/TEMP B-TREE/);
  });

  test.each([0, Math.floor(COUNT / 2), Math.floor(COUNT * 0.75), COUNT - 100])('getMessageWindow(offset %i) stays within budget', (offset) => {
    const rows = getMessageWindow(db, conv.conversationId, offset, 100);
    expect(rows).toHaveLength(100);
    const took = ms(() => getMessageWindow(db, conv.conversationId, offset, 100));
    console.info(`[perf] getMessageWindow offset ${offset}: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(BUDGET_MS.window);
  });

  test('findMessageOffsetByDate stays within budget and lands on the first message of the day', () => {
    const day = Math.floor(conv.days * 0.75);
    const date = new Date(Date.UTC(2020, 0, 1 + day)).toISOString().slice(0, 10);
    const offset = findMessageOffsetByDate(db, conv.conversationId, date);
    expect(offset).toBe(day * 200);
    expect(getMessageWindow(db, conv.conversationId, offset!, 1)[0].sentAt.startsWith(date)).toBe(true);
    const took = ms(() => findMessageOffsetByDate(db, conv.conversationId, date));
    console.info(`[perf] findMessageOffsetByDate: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(BUDGET_MS.date);
  });

  test('listConversationDays stays within budget and adds up to the message count', () => {
    const days = listConversationDays(db, conv.conversationId);
    expect(days).toHaveLength(conv.days);
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(COUNT);
    const took = ms(() => listConversationDays(db, conv.conversationId));
    console.info(`[perf] listConversationDays (${days.length} days): ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(BUDGET_MS.days);
  });

  test('countMessages stays within budget', () => {
    const took = ms(() => countMessages(db, conv.conversationId));
    console.info(`[perf] countMessages: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(BUDGET_MS.count);
  });
});
