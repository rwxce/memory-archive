import { describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import { importMessages, undoImportBatch } from './queries';
import { discardSearchIndex, getSearchStatus, searchMessages, stepSearchIndex } from './search';
import type { SqlDb } from './sql';
import { createSyntheticConversation } from './synthetic-archive';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const C = uuid(10);

async function archive(count: number) {
  const { db } = await openMemoryDb();
  createSyntheticConversation(db, { count, conversationId: C, batchId: uuid(20) });
  return db;
}

const find = (db: SqlDb, query: string) => searchMessages(db, { query, offset: 0, limit: 500 }).map((r) => r.body);
const build = (db: SqlDb) => {
  for (let i = 0; i < 50; i++) if (stepSearchIndex(db).finished && getSearchStatus(db).state === 'ready') return;
  throw new Error('did not converge');
};
const searchSchema = (db: SqlDb) => db.all<{ name: string }>("SELECT name FROM search.sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);

describe('chunked passes and outside writes', () => {
  test('a write between two chunks makes the pass unverified; the next clean pass verifies', async () => {
    const db = await archive(450);
    const first = stepSearchIndex(db, 100);
    expect(first).toMatchObject({ processed: 100, finished: false });
    db.run("INSERT INTO favorites (conversation_id, fingerprint, created_at) SELECT conversation_id, fingerprint, '2026-02-01T12:00:00Z' FROM messages LIMIT 1");
    let last = first;
    while (!last.finished) last = stepSearchIndex(db, 100);
    expect(last.verified).toBe(false);
    expect(getSearchStatus(db).state).toBe('stale');
    let again = stepSearchIndex(db, 100);
    while (!again.finished) again = stepSearchIndex(db, 100);
    expect(again.verified).toBe(true);
    expect(getSearchStatus(db).state).toBe('ready');
  });

  test('a pass cut short, then an outside write of new messages, then resumed: the new ones are found', async () => {
    const db = await archive(450);
    stepSearchIndex(db, 100);
    importMessages(db, {
      batchId: uuid(30), conversationId: C, source: 'synthetic', sourceLabel: 'again', now: '2026-02-02T12:00:00Z', blobs: [],
      messages: [{ fingerprint: 'd'.repeat(64), sentAt: '2026-03-01T10:00:00', ordinal: 0, type: 'text', participantName: null, body: 'late arrival zebra', mediaSha256: null, mediaName: '' }],
    });
    let step = stepSearchIndex(db, 100);
    while (!step.finished) step = stepSearchIndex(db, 100);
    expect(step.verified).toBe(false);
    expect(find(db, 'zebra')).toEqual(['late arrival zebra']);
    build(db);
    expect(getSearchStatus(db)).toEqual({ state: 'ready', total: 451 });
  });
});

describe('privacy at rest', () => {
  test('an undo drops the index file contents: no table, no free pages, status not-built', async () => {
    const db = await archive(300);
    build(db);
    expect(find(db, 'synthetic message 12')).not.toEqual([]);
    undoImportBatch(db, uuid(20));
    discardSearchIndex(db);
    expect(searchSchema(db)).toEqual([]);
    expect(db.all('PRAGMA search.freelist_count')).toEqual([{ freelist_count: 0 }]);
    expect(getSearchStatus(db)).toEqual({ state: 'not-built', total: 0 });
    expect(() => searchMessages(db, { query: 'synthetic', offset: 0, limit: 5 })).toThrowError(/not ready/);
  });

  test('without an index nothing is attached or created', async () => {
    const db = await archive(300);
    discardSearchIndex(db);
    expect(db.all<{ name: string }>('PRAGMA database_list').map((r) => r.name)).toEqual(['main']);
  });

  test('the index file holds no page of the removed text after the drop', async () => {
    const db = await archive(300);
    build(db);
    discardSearchIndex(db);
    // the file is vacuumed to (almost) nothing: no page left that could hold old words
    const [{ page_count }] = db.all<{ page_count: number }>('PRAGMA search.page_count');
    expect(page_count).toBeLessThanOrEqual(1);
  });
});

describe('recovery of a damaged index', () => {
  test('damaged FTS5 shadow tables reset the index once; it works again after a rebuild', async () => {
    const db = await archive(300);
    build(db);
    db.exec('DELETE FROM search.docs_data');
    // The damage shows on the first read of the index; it is reset there, so there is nothing built to search yet.
    expect(() => find(db, 'synthetic')).toThrowError(/not ready/);
    expect(getSearchStatus(db).state).toBe('not-built');
    build(db);
    expect(find(db, 'synthetic message 299')).toEqual(['synthetic message 299']);
  });

  test('a table that is not an FTS5 index (wrong shape) resets too', async () => {
    const db = await archive(300);
    build(db);
    db.exec('DROP TABLE search.docs; CREATE TABLE search.docs (x)');
    expect(() => stepSearchIndex(db)).not.toThrow();
    build(db);
    expect(find(db, 'synthetic message 5')).toContain('synthetic message 5');
  });

  test('a cut-short write (the dirty mark in a new session) starts the index over', async () => {
    const db = await archive(300);
    build(db);
    // A new session has no pass in flight, but the file says a write never finished.
    db.exec("INSERT OR REPLACE INTO search.meta (key, value) VALUES ('dirty', '1')");
    expect(getSearchStatus(db).state).toBe('not-built');
  });
});
