import { beforeAll, describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import { createProfile, linkConversationProfile } from './queries';
import { getSearchStatus, searchMessages, stepSearchIndex } from './search';
import type { SqlDb } from './sql';
import { createSyntheticConversation } from './synthetic-archive';

/**
 * Performance guard for search: ~200k synthetic messages over 4 conversations (3 linked to one
 * person). Every body is "synthetic message N" (plus a file name on photos), so "message" is the
 * worst case for a common word. `VITEST_PERF_COUNT=20000` shrinks it. Budgets are loose (CI); the
 * measured numbers are in `docs/blueprint.md`.
 */
const COUNT = Number(process.env.VITEST_PERF_COUNT ?? 200_000);
// `everything` = a word that most messages have: every match is sorted by time before the page is cut.
const BUDGET_MS = { query: 100, everything: 600, firstQuery: 250 };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PERSON = uuid(1);
let db: SqlDb;

function ms(fn: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
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
}, 120_000);

describe(`search on a ${COUNT}-message synthetic archive (performance guard)`, () => {
  test('build, clean re-check, then queries', () => {
    const start = performance.now();
    let steps = 0;
    let slowestStep = 0;
    for (;;) {
      const t = performance.now();
      const step = stepSearchIndex(db);
      slowestStep = Math.max(slowestStep, performance.now() - t);
      steps++;
      if (step.finished) {
        expect(step.verified).toBe(true);
        break;
      }
    }
    const build = performance.now() - start;
    const [{ page_count: pages }] = db.all<{ page_count: number }>('PRAGMA search.page_count');
    const [{ page_size: size }] = db.all<{ page_size: number }>('PRAGMA search.page_size');
    // Nothing changed: a whole re-check is only the anti-join of both sides.
    db.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) SELECT conversation_id, fingerprint, ? FROM messages LIMIT 1', ['2026-02-01T12:00:00Z']);
    expect(getSearchStatus(db).state).toBe('stale');
    const recheck = ms(() => {
      while (!stepSearchIndex(db).finished);
    }, 1);
    expect(getSearchStatus(db).state).toBe('ready');

    const q = (query: string, scope?: { profileId?: string; conversationId?: string }) => () => searchMessages(db, { scope, query, offset: 0, limit: 100 });
    const first = ms(q('message 1234'), 1);
    const timings = {
      status: ms(() => getSearchStatus(db)),
      rare: ms(q('synthetic message 123456')),
      common: ms(q('message')),
      commonPerson: ms(q('message', { profileId: PERSON })),
      commonConversation: ms(q('message', { conversationId: uuid(10) })),
      oneLetter: ms(q('m')),
      file: ms(q('img 9 jpg')),
      deepPage: ms(() => searchMessages(db, { query: 'message', offset: 50_000, limit: 100 })),
    };
    console.info(
      `[perf] search index: ${COUNT} messages in ${build.toFixed(0)} ms (${steps} steps, slowest ${slowestStep.toFixed(0)} ms), ` +
        `${((pages * size) / 1_048_576).toFixed(1)} MiB, re-check after a change ${recheck.toFixed(0)} ms; first query ${first.toFixed(1)} ms; ` +
        `queries (ms): ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, +v.toFixed(1)])))}`,
    );
    expect(first).toBeLessThan(BUDGET_MS.firstQuery);
    const everything = ['common', 'commonPerson', 'commonConversation', 'deepPage'];
    for (const [name, t] of Object.entries(timings)) expect(t, name).toBeLessThan(everything.includes(name) ? BUDGET_MS.everything : BUDGET_MS.query);
    expect(q('message')()).toHaveLength(100);
  }, 120_000);
});
