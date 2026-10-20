/**
 * In-memory `CacheStorage` for tests (Node has `Request`/`Response` but no
 * Cache API). Implements the subset the app uses: open / has / delete / keys,
 * and per cache put / match / keys / delete, keyed by URL.
 */
export function createMemoryCacheStorage(): CacheStorage {
  const caches = new Map<string, Map<string, { body: ArrayBuffer; init: ResponseInit }>>();
  const keyOf = (r: RequestInfo | URL) => (typeof r === 'string' ? r : r instanceof URL ? r.href : r.url);

  const openCache = (name: string): Cache => {
    let entries = caches.get(name);
    if (!entries) caches.set(name, (entries = new Map()));
    const store = entries;
    const cache = {
      async put(request: RequestInfo | URL, response: Response) {
        store.set(keyOf(request), {
          body: await response.arrayBuffer(),
          init: { status: response.status, headers: [...response.headers.entries()] },
        });
      },
      async match(request: RequestInfo | URL) {
        const hit = store.get(keyOf(request));
        return hit ? new Response(hit.body.slice(0), hit.init) : undefined;
      },
      async keys() {
        return [...store.keys()].map((url) => new Request(url));
      },
      async delete(request: RequestInfo | URL) {
        return store.delete(keyOf(request));
      },
    };
    return cache as unknown as Cache;
  };

  const storage = {
    async open(name: string) {
      return openCache(name);
    },
    async has(name: string) {
      return caches.has(name);
    },
    async delete(name: string) {
      return caches.delete(name);
    },
    async keys() {
      return [...caches.keys()];
    },
    async match() {
      return undefined;
    },
  };
  return storage as unknown as CacheStorage;
}
