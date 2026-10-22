import { describe, expect, test } from 'vitest';
import { openMemoryDb } from '../db/open';
import { importMessages } from '../db/queries';
import { loadSnapshot, serializeDb } from '../db/snapshot';
import type { NewMessage } from '../domain/library';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import { buildSearchIndex, getSearchStatus, searchMessages } from './search';
import { createTestLibrary } from './test-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [ANA, C1, C2, C3] = [uuid(1), uuid(10), uuid(11), uuid(12)];
const NOW = '2026-02-01T12:00:00Z';
// Like real fingerprints, they differ in their first digits (a SHA-256 does), and the same message keeps its fingerprint.
const fingerprints = new Map<string, string>();
const fingerprintOf = (key: string) => {
  if (!fingerprints.has(key)) fingerprints.set(key, (fingerprints.size + 1).toString(16).padEnd(64, 'f'));
  return fingerprints.get(key)!;
};
const message = (body: string, day = 1, extra: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: fingerprintOf(`${day}:${body}`),
  sentAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body,
  mediaSha256: null,
  mediaName: '',
  ...extra,
});

async function setup() {
  const lib = await createTestLibrary();
  await lib.client.call('createProfile', { id: ANA, displayName: 'Ana', now: NOW });
  const add = (n: number, conversationId: string, title: string, profileIds: string[], messages: NewMessage[], batch = 100 + n) =>
    lib.client.call('importMessages', {
      batchId: uuid(batch),
      conversationId,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: NOW,
      blobs: [],
      messages,
      newConversation: { title, sourceKey: title, isGroup: false, profileIds },
      meAuthor: 'Ana',
    });
  await add(1, C1, 'Chat 1', [ANA], [message('Bon dia, com va la CANÇÓ nova?', 1), message('Vam anar a la platja', 2), message('Me encanta la canción', 3)]);
  await add(2, C2, 'Chat 2', [ANA], [message('La cançó de ahir', 4), message('<img src=x onerror=alert(1)> cançó', 5)]);
  await add(3, C3, 'Chat 3', [], [message('cançó sense persona', 6)]);
  return lib;
}

const ids = async (p: ReturnType<typeof searchMessages>) => (await p).map((r) => r.body);

describe('search use cases', () => {
  test('status goes not-built -> ready; a change makes it stale; building again makes it ready', async () => {
    const lib = await setup();
    expect(await getSearchStatus(lib)).toEqual({ state: 'not-built', total: 6 });
    const progress: { done: number; total: number }[] = [];
    await buildSearchIndex(lib, { onProgress: (p) => progress.push(p) });
    expect(progress.at(-1)).toEqual({ done: 6, total: 6 });
    expect(await getSearchStatus(lib)).toEqual({ state: 'ready', total: 6 });
    await lib.client.call('importMessages', {
      batchId: uuid(900), conversationId: C1, source: 'whatsapp', sourceLabel: 'y.zip', now: NOW, blobs: [], messages: [message('nou missatge', 9)],
    });
    expect(await getSearchStatus(lib)).toEqual({ state: 'stale', total: 7 });
    await buildSearchIndex(lib);
    expect(await getSearchStatus(lib)).toEqual({ state: 'ready', total: 7 });
  });

  test('searching builds the index first; case and accents do not matter; results are newest first with the other lists shape', async () => {
    const lib = await setup();
    const hits = await searchMessages(lib, undefined, 'canco', 0);
    expect(hits.map((h) => h.body)).toEqual(['cançó sense persona', '<img src=x onerror=alert(1)> cançó', 'La cançó de ahir', 'Bon dia, com va la CANÇÓ nova?']);
    expect(hits[0]).toMatchObject({ conversationId: C3, conversationTitle: 'Chat 3', participantName: 'Ana', isMe: true, isFavorite: false, hasNote: false, type: 'text', isSystem: false });
    expect(await ids(searchMessages(lib, undefined, 'CANÇÓ', 0))).toEqual(await ids(searchMessages(lib, undefined, 'canco', 0)));
    // 'ç' and 'ó' fold to 'c' and 'o', so 'cancion' is another word and finds the Spanish one only.
    expect(await ids(searchMessages(lib, undefined, 'CANCIÓN', 0))).toEqual(['Me encanta la canción']);
  });

  test('every word must match and the last one matches as a prefix', async () => {
    const lib = await setup();
    expect(await ids(searchMessages(lib, undefined, 'platja', 0))).toEqual(['Vam anar a la platja']);
    expect(await ids(searchMessages(lib, undefined, 'vam an', 0))).toEqual(['Vam anar a la platja']);
    expect(await ids(searchMessages(lib, undefined, 'vam xyz', 0))).toEqual([]);
    expect(await ids(searchMessages(lib, undefined, 'pla vam', 0))).toEqual([]);
  });

  test('scopes: the whole archive, one person, one conversation', async () => {
    const lib = await setup();
    expect(await searchMessages(lib, undefined, 'cançó', 0)).toHaveLength(4);
    expect((await searchMessages(lib, { profileId: ANA }, 'cançó', 0)).map((h) => h.conversationId).sort()).toEqual([C1, C2, C2]);
    expect((await searchMessages(lib, { conversationId: C3 }, 'cançó', 0)).map((h) => h.body)).toEqual(['cançó sense persona']);
    await expect(searchMessages(lib, { profileId: uuid(99) }, 'x', 0)).rejects.toMatchObject({ code: 'not-found' });
    await expect(searchMessages(lib, { conversationId: uuid(99) }, 'x', 0)).rejects.toMatchObject({ code: 'not-found' });
    await expect(searchMessages(lib, { profileId: ANA, conversationId: C1 } as never, 'x', 0)).rejects.toMatchObject({ code: 'invalid' });
  });

  test('paging by offset and limit', async () => {
    const lib = await setup();
    const all = await searchMessages(lib, undefined, 'cançó', 0);
    expect((await searchMessages(lib, undefined, 'cançó', 1, 2)).map((h) => h.id)).toEqual(all.slice(1, 3).map((h) => h.id));
    expect(await searchMessages(lib, undefined, 'cançó', 50)).toEqual([]);
    await expect(searchMessages(lib, undefined, 'cançó', -1)).rejects.toMatchObject({ code: 'invalid' });
    await expect(searchMessages(lib, undefined, 'cançó', 0, Number.NaN)).rejects.toMatchObject({ code: 'invalid' });
  });

  test('snippets are plain text with match ranges as data; hostile text stays text', async () => {
    const lib = await setup();
    const [hit] = await searchMessages(lib, { conversationId: C2 }, 'img onerror', 0);
    expect(hit.body).toBe('<img src=x onerror=alert(1)> cançó');
    expect(hit.snippet.text).toBe('<img src=x onerror=alert(1)> cançó');
    expect(hit.snippet.ranges.map((r) => hit.snippet.text.slice(r.start, r.end))).toEqual(['img', 'onerror']);
    const [accent] = await searchMessages(lib, { conversationId: C3 }, 'CANCO', 0);
    expect(accent.snippet.ranges.map((r) => accent.snippet.text.slice(r.start, r.end))).toEqual(['cançó']);
  });

  test('operators, quotes and syntax typed by the person never reach FTS5', async () => {
    const lib = await setup();
    for (const q of ['"', '"cançó', 'cançó*', 'NEAR(cançó platja)', 'cançó OR platja', '-cançó', 'text:cançó', '(', ')', '^', 'AND', 'cançó NOT', '*', "'; DROP TABLE messages; --", '\u0001\u0002', 'a'.repeat(100_000)]) {
      await expect(searchMessages(lib, undefined, q, 0)).resolves.toBeInstanceOf(Array);
    }
    expect(await ids(searchMessages(lib, undefined, 'vam OR zzzz', 0))).toEqual([]);
    expect(await ids(searchMessages(lib, undefined, 'text:platja', 0))).toEqual([]);
    expect(await searchMessages(lib, undefined, '   ', 0)).toEqual([]);
    expect(lib.opened.db.all('SELECT count(*) AS n FROM messages')[0]).toEqual({ n: 6 });
  });

  test('control characters in a message cannot forge a highlight', async () => {
    const lib = await setup();
    await lib.client.call('importMessages', {
      batchId: uuid(901), conversationId: C1, source: 'whatsapp', sourceLabel: 'y.zip', now: NOW, blobs: [],
      messages: [message('fake \u0001highlight\u0002 zebra', 9)],
    });
    const [hit] = await searchMessages(lib, undefined, 'zebra', 0);
    expect(hit.snippet.ranges.map((r) => hit.snippet.text.slice(r.start, r.end))).toEqual(['zebra']);
  });

  test('file names and captions are searchable', async () => {
    const lib = await setup();
    const sha = 'ab'.repeat(32);
    await lib.client.call('importMessages', {
      batchId: uuid(902), conversationId: C1, source: 'whatsapp', sourceLabel: 'y.zip', now: NOW,
      blobs: [{ sha256: sha, size: 3, mime: null }],
      messages: [message('', 9, { type: 'photo', mediaSha256: sha, mediaName: 'IMG-2020-vacances.jpg' })],
    });
    const [hit] = await searchMessages(lib, undefined, 'vacances', 0);
    expect(hit).toMatchObject({ type: 'photo', mediaName: 'IMG-2020-vacances.jpg', mediaSha256: sha });
  });

  test('undo removes the messages from the results; an id reused by another message shows the new text', async () => {
    const lib = await setup();
    await buildSearchIndex(lib);
    await lib.client.call('importMessages', {
      batchId: uuid(903), conversationId: C1, source: 'whatsapp', sourceLabel: 'z.zip', now: NOW, blobs: [], messages: [message('efimer girasol', 9)],
    });
    expect(await ids(searchMessages(lib, undefined, 'girasol', 0))).toEqual(['efimer girasol']);
    await lib.client.call('undoImportBatch', { batchId: uuid(903) });
    expect(await ids(searchMessages(lib, undefined, 'girasol', 0))).toEqual([]);
    // The next message takes the freed id (INTEGER PRIMARY KEY without AUTOINCREMENT).
    await lib.client.call('importMessages', {
      batchId: uuid(904), conversationId: C1, source: 'whatsapp', sourceLabel: 'z.zip', now: NOW, blobs: [], messages: [message('altre tulipa', 9)],
    });
    expect(await ids(searchMessages(lib, undefined, 'girasol', 0))).toEqual([]);
    expect(await ids(searchMessages(lib, undefined, 'tulipa', 0))).toEqual(['altre tulipa']);
    // The undo dropped the index (privacy), so the next search rebuilt it from the archive.
    expect((await getSearchStatus(lib)).state).toBe('ready');
  });

  test('ids that now hold other content (same ids, other fingerprints) never show the old text, even before a rebuild', async () => {
    const lib = await setup();
    await buildSearchIndex(lib);
    // Outside any use case: the same rows get other text and fingerprints, as after an undo that reused ids.
    lib.opened.db.run("UPDATE messages SET body = 'completely different', fingerprint = printf('%016x', 900 + id) || substr(fingerprint, 17) WHERE id <= 3");
    expect(await lib.client.call('searchMessages', { query: 'platja', offset: 0, limit: 10 })).toEqual([]);
    expect(await lib.client.call('searchMessages', { query: 'different', offset: 0, limit: 10 })).toEqual([]);
    expect(await ids(searchMessages(lib, undefined, 'different', 0))).toHaveLength(3);
    expect(await ids(searchMessages(lib, undefined, 'platja', 0))).toEqual([]);
  });

  test('deleting a whole conversation (undo of its only batch) leaves nothing to find', async () => {
    const lib = await setup();
    expect(await searchMessages(lib, undefined, 'persona', 0)).toHaveLength(1);
    await lib.client.call('undoImportBatch', { batchId: uuid(103) });
    expect(await searchMessages(lib, undefined, 'persona', 0)).toEqual([]);
    expect(await getSearchStatus(lib)).toMatchObject({ state: 'ready', total: 5 });
  });

  test('re-importing an overlapping export adds nothing twice to the results', async () => {
    const lib = await setup();
    await searchMessages(lib, undefined, 'x', 0);
    const again = [message('Vam anar a la platja', 2)];
    await lib.client.call('importMessages', {
      batchId: uuid(906), conversationId: C1, source: 'whatsapp', sourceLabel: 'again.zip', now: NOW, blobs: [], messages: again,
    });
    expect(await ids(searchMessages(lib, undefined, 'platja', 0))).toEqual(['Vam anar a la platja']);
  });

  test('a build can be aborted between chunks and continues later', async () => {
    const lib = await setup();
    const controller = new AbortController();
    await expect(buildSearchIndex(lib, { signal: controller.signal, onProgress: () => controller.abort(new Error('stop')) })).rejects.toThrow('stop');
    expect((await getSearchStatus(lib)).state).not.toBe('ready');
    await buildSearchIndex(lib);
    expect((await getSearchStatus(lib)).state).toBe('ready');
    expect(await searchMessages(lib, undefined, 'platja', 0)).toHaveLength(1);
  });

  test('a joiner does not inherit another caller\'s abort; the build stops only when everyone aborted', async () => {
    const lib = await setup();
    const first = new AbortController();
    const a = buildSearchIndex(lib, { signal: first.signal });
    const b = buildSearchIndex(lib);
    first.abort(new Error('mine'));
    await expect(a).rejects.toThrow('mine');
    await b;
    expect((await getSearchStatus(lib)).state).toBe('ready');

    const x = new AbortController();
    const y = new AbortController();
    await lib.client.call('importMessages', {
      batchId: uuid(910), conversationId: C1, source: 'whatsapp', sourceLabel: 'q.zip', now: NOW, blobs: [], messages: [message('quart', 9)],
    });
    const p = buildSearchIndex(lib, { signal: x.signal });
    const q = buildSearchIndex(lib, { signal: y.signal });
    x.abort(new Error('x'));
    y.abort(new Error('y'));
    await expect(p).rejects.toThrow('x');
    await expect(q).rejects.toThrow('y');
  });

  test('two builds started together share one run', async () => {
    const lib = await setup();
    const a = buildSearchIndex(lib);
    const b = buildSearchIndex(lib);
    expect(a).toBe(b);
    await a;
  });
});

describe('the search index and backups', () => {
  test('an exported archive carries no search index, and a restore into an empty library searches after a rebuild', async () => {
    const lib = await setup();
    await buildSearchIndex(lib);
    expect(await searchMessages(lib, undefined, 'platja', 0)).toHaveLength(1);

    const { db } = lib.opened;
    const { blobStore } = lib.deps;
    const bytes = serializeDb(db);
    expect(new TextDecoder('latin1').decode(bytes)).not.toMatch(/fts5|docs_data|docs_idx|CREATE VIRTUAL/i);
    const { blob } = await exportArchive({ db, blobStore }, { appVersion: '1' });

    const empty = await createTestLibrary();
    await restoreArchiveIntoEmptyLibrary({ db: empty.opened.db, blobStore: empty.deps.blobStore }, blob);
    expect(empty.opened.db.all("SELECT name FROM sqlite_master WHERE name LIKE '%docs%' OR sql LIKE '%fts5%'")).toEqual([]);
    expect(await getSearchStatus(empty)).toEqual({ state: 'not-built', total: 6 });
    expect(await ids(searchMessages(empty, undefined, 'platja', 0))).toEqual(['Vam anar a la platja']);
    expect(await getSearchStatus(empty)).toEqual({ state: 'ready', total: 6 });
  });

  test('a library that had an index, restored from a backup, starts the index over', async () => {
    const source = await setup();
    const { blob } = await exportArchive({ db: source.opened.db, blobStore: source.deps.blobStore }, { appVersion: '1' });
    // The target had a search index over messages that are then all undone, so the library is empty again.
    const target = await setup();
    await searchMessages(target, undefined, 'platja', 0);
    for (const n of [101, 102, 103]) await target.client.call('undoImportBatch', { batchId: uuid(n) });
    target.opened.db.run('DELETE FROM profiles');
    await restoreArchiveIntoEmptyLibrary({ db: target.opened.db, blobStore: target.deps.blobStore }, blob);
    expect(await getSearchStatus(target)).toMatchObject({ state: 'not-built', total: 6 });
    expect(await ids(searchMessages(target, undefined, 'platja', 0))).toEqual(['Vam anar a la platja']);
  });

  test('a snapshot that carries a virtual table (an FTS5 index) is still refused', async () => {
    const { db } = await openMemoryDb();
    db.exec('CREATE VIRTUAL TABLE leak USING fts5(text)');
    importMessages(db, {
      batchId: uuid(1), conversationId: uuid(2), source: 'x', sourceLabel: 'x', now: NOW, blobs: [], messages: [],
      newConversation: { title: 't', sourceKey: 'k', isGroup: false, profileIds: [] },
    });
    const bytes = serializeDb(db);
    const target = (await openMemoryDb()).db;
    await expect(loadSnapshot(target, bytes)).rejects.toMatchObject({ code: 'invalid' });
    expect(target.all('SELECT 1 FROM conversations')).toEqual([]);
  });
});
