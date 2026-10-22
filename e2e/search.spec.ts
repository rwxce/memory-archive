import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The derived search index against the built app with the real database worker and the real
 * OPFS (SAH pool): a second database file attached to the library connection while search
 * works, detached again, next to imports. The page talks to `/db/worker.js` directly (there is
 * no search screen yet); the text is synthetic.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const message = (n: number, body: string) => ({
  fingerprint: `${n.toString(16)}${'a'.repeat(63)}`,
  sentAt: `2026-01-0${n}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body,
  mediaSha256: null,
  mediaName: '',
});
const imported = (batch: number, messages: unknown[], isNew: boolean) => ({
  batchId: uuid(batch),
  conversationId: uuid(10),
  source: 'whatsapp',
  sourceLabel: 'x.zip',
  now: '2026-02-01T12:00:00Z',
  blobs: [],
  messages,
  ...(isNew ? { newConversation: { title: 'Chat', sourceKey: 'chat', isGroup: false, profileIds: [] } } : {}),
});

/** Starts a database worker in the page (kept on `window`) and waits until it opens the library. */
async function openWorker(page: Page) {
  await page.evaluate(async () => {
    const w = window as unknown as { __call: (op: string, params?: unknown) => Promise<unknown> };
    const worker = new Worker('/db/worker.js', { type: 'module' });
    let next = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: { code: string; message: string } }>) => {
      const entry = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (event.data.ok) entry?.resolve(event.data.result);
      else entry?.reject(new Error(`${event.data.error?.code}: ${event.data.error?.message}`));
    };
    w.__call = (op, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, params });
      });
    // The previous page's worker may still hold the library for a moment (reload).
    for (let attempt = 0; ; attempt++) {
      try {
        await w.__call('status');
        return;
      } catch (error) {
        if (attempt > 20) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });
}

const call = <T>(page: Page, op: string, params?: unknown) =>
  page.evaluate(([o, p]) => (window as unknown as { __call: (op: string, params?: unknown) => Promise<unknown> }).__call(o as string, p), [op, params]) as Promise<T>;

async function buildIndex(page: Page) {
  for (let finished = false; !finished; ) finished = (await call<{ finished: boolean }>(page, 'stepSearchIndex')).finished;
}

test('search works on the real OPFS database, next to imports, and survives a reload', async ({ page }) => {
  await page.goto('/en/offline/');
  await openWorker(page);
  await call(page, 'importMessages', imported(100, [message(1, 'Bon dia, la CANÇÓ nova'), message(2, 'Vam anar a la platja')], true));

  expect(await call(page, 'getSearchStatus')).toEqual({ state: 'not-built', total: 2 });
  await buildIndex(page);
  expect(await call(page, 'getSearchStatus')).toEqual({ state: 'ready', total: 2 });
  const hits = await call<{ body: string; snippet: { text: string } }[]>(page, 'searchMessages', { query: 'CANCO', offset: 0, limit: 10 });
  expect(hits.map((h) => h.body)).toEqual(['Bon dia, la CANÇÓ nova']);

  // A write to the library after the index file was attached and detached again: one plain commit.
  await call(page, 'importMessages', imported(101, [message(3, 'tercer lliri')], false));
  expect(await call(page, 'getSearchStatus')).toEqual({ state: 'stale', total: 3 });
  await buildIndex(page);
  expect((await call<unknown[]>(page, 'searchMessages', { query: 'lliri', offset: 0, limit: 10 })).length).toBe(1);

  // A new session finds the index file on disk (built), verifies it once, and searches.
  await page.reload();
  await openWorker(page);
  expect((await call<{ state: string }>(page, 'getSearchStatus')).state).toBe('stale');
  await buildIndex(page);
  expect(await call(page, 'getSearchStatus')).toEqual({ state: 'ready', total: 3 });
  expect((await call<unknown[]>(page, 'searchMessages', { query: 'platja', offset: 0, limit: 10 })).length).toBe(1);

  // The undo of a batch drops the index file's contents (the text must not outlive the messages)...
  await call(page, 'undoImportBatch', { batchId: uuid(101) });
  expect(await call(page, 'getSearchStatus')).toEqual({ state: 'not-built', total: 2 });
  await expect(call(page, 'searchMessages', { query: 'lliri', offset: 0, limit: 10 })).rejects.toThrow(/not ready/);
  // ...and the next build starts over and finds only what is left.
  await buildIndex(page);
  expect((await call<unknown[]>(page, 'searchMessages', { query: 'lliri', offset: 0, limit: 10 })).length).toBe(0);
  expect((await call<unknown[]>(page, 'searchMessages', { query: 'platja', offset: 0, limit: 10 })).length).toBe(1);
});
