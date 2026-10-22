import { beforeAll, describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import {
  countNotes,
  createProfile,
  getMessageWindow,
  getPersonTimelineWindow,
  linkConversationProfile,
  listNotes,
  MESSAGE_WINDOW_SQL,
  TIMELINE_WINDOW_SQL,
} from './queries';
import type { SqlDb } from './sql';
import { createSyntheticConversation } from './synthetic-archive';

/**
 * Performance guard for notes: ~200k messages over 4 conversations (3 linked to one person) and
 * ~2k message notes (1%). The windows LEFT JOIN `notes` on its unique key for the page's rows
 * only, so they must stay as fast as without it; the notes list sorts the few notes.
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
const plan = (sql: string, params: (string | number)[]) =>
  db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r.detail).join('\n');

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

const annotate = () => {
  db.run(
    `INSERT INTO notes (kind, conversation_id, fingerprint, body, created_at, updated_at)
     SELECT 'message', conversation_id, fingerprint, 'synthetic note', '2026-02-01T12:00:00Z',
            '2026-02-01T12:00:' || printf('%02d', id % 60) || 'Z' FROM messages WHERE id % ? = 0`,
    [Math.round(COUNT / 2000)],
  );
  db.run("INSERT INTO notes (kind, profile_id, body, created_at, updated_at) VALUES ('profile', ?, 'about', 't', 't')", [PERSON]);
};

describe(`notes on a ${COUNT}-message synthetic archive (performance guard)`, () => {
  test('windows without and with ~2k notes', () => {
    const offsets = [0, Math.floor(total / 2), total - 100];
    const run = () => offsets.map((o) => [ms(() => getMessageWindow(db, uuid(10), Math.min(o, Math.floor(COUNT / 4) - 100), 100)), ms(() => getPersonTimelineWindow(db, PERSON, o, 100))]);
    const before = run();
    annotate();
    const after = run();
    console.info(`[perf] windows before/after ~2k notes (ms) conversation|timeline at start,middle,end: ${JSON.stringify(before.map((r) => r.map((v) => +v.toFixed(1))))} -> ${JSON.stringify(after.map((r) => r.map((v) => +v.toFixed(1))))}`);
    for (const [conversation, timeline] of after) {
      expect(conversation).toBeLessThan(BUDGET_MS.window);
      expect(timeline).toBeLessThan(BUDGET_MS.window);
    }
    expect(getPersonTimelineWindow(db, PERSON, 0, 500).some((m) => m.hasNote)).toBe(true);
  });

  test('the windows probe notes by its unique key, only for the rows of the page', () => {
    const conversation = plan(MESSAGE_WINDOW_SQL, [uuid(10), 100, 10_000]);
    expect(conversation).toMatch(/SEARCH nt USING (COVERING )?INDEX notes_one_per_message/);
    expect(conversation).not.toMatch(/SCAN (m|nt)\b/);
    const timeline = plan(TIMELINE_WINDOW_SQL, [PERSON, 100, 10_000]);
    expect(timeline).toMatch(/SEARCH nt USING (COVERING )?INDEX notes_one_per_message/);
    // the one SCAN is the covering walk of `messages_by_time` that yields the page's ids
    expect(timeline).not.toMatch(/SCAN nt\b/);
  });

  test('count and list pages (whole archive, one person, one conversation) stay within budget', () => {
    const n = countNotes(db);
    expect(n).toBeGreaterThan(1500);
    const count = ms(() => countNotes(db));
    const first = ms(() => listNotes(db, undefined, 0, 100));
    const last = ms(() => listNotes(db, undefined, n - 100, 100));
    const person = ms(() => listNotes(db, { profileId: PERSON }, 0, 100));
    const one = ms(() => listNotes(db, { conversationId: uuid(10) }, 0, 100));
    console.info(`[perf] notes (${n}): count ${count.toFixed(1)} ms, first page ${first.toFixed(1)}, last ${last.toFixed(1)}, person ${person.toFixed(1)}, conversation ${one.toFixed(1)}`);
    for (const t of [count, first, last, person, one]) expect(t).toBeLessThan(BUDGET_MS.list);
    expect(listNotes(db, undefined, n - 100, 100)).toHaveLength(100);
  });
});
