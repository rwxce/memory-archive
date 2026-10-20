import pc from 'picocolors';
import type { Message } from './parse/types';
import { URL_RE, deriveTitle, unwrapUrl } from './render/js/linkify.js';

// Browser-like UA reduces blocks on sites (Medium, etc.) that serve a
// placeholder to bots.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function cleanTitle(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 300);
}

/** Read a `<meta property|name="key" content="...">` value (either attribute
 * order) and unescape common HTML entities. */
function metaContent(html: string, key: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return cleanTitle(m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
  }
  return null;
}

/** Pull a page title: prefer `og:title` / `twitter:title`, fall back to the
 * document `<title>`. Returns null if neither is present. */
export function extractTitle(html: string): string | null {
  const meta = metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title');
  if (meta) return meta;
  const m = html.match(TITLE_RE);
  if (!m) return null;
  return cleanTitle(m[1]);
}

export type Platform =
  | 'youtube'
  | 'reddit'
  | 'linkedin'
  | 'medium'
  | 'stackoverflow'
  | 'x'
  | 'generic';

/** Classify a URL so each host can use its own title-extraction method. */
export function platformOf(url: string): Platform {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
    if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'reddit';
    if (h === 'linkedin.com' || h.endsWith('.linkedin.com')) return 'linkedin';
    if (h === 'medium.com' || h.endsWith('.medium.com')) return 'medium';
    if (h === 'stackoverflow.com') return 'stackoverflow';
    if (h === 'x.com' || h === 'twitter.com') return 'x';
    return 'generic';
  } catch {
    return 'generic';
  }
}

// ---- YouTube: official oEmbed endpoint (JSON) ----

export function youTubeOembedUrl(url: string): string {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
}

export function parseYouTubeOembed(obj: unknown): string | null {
  const title = (obj as { title?: unknown })?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

// ---- Reddit: append `.json` and read the listing ----

export function redditJsonUrl(url: string): string {
  return url.split('?')[0].replace(/\/$/, '') + '.json';
}

export function parseRedditJson(obj: unknown): string | null {
  try {
    const title = (obj as any[])?.[0]?.data?.children?.[0]?.data?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

// ---- LinkedIn: no scraping — derive from the URL slug (offline) ----

export function deriveLinkedInTitle(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const m =
      path.match(/\/(?:in|pub|company)\/([^/?#]+)/) ??
      path.match(/\/jobs\/view\/([^/?#]+)/);
    if (!m) return null;
    const slug = m[1].replace(/[_]+/g, ' ').replace(/-/g, ' ').trim();
    return slug || null;
  } catch {
    return null;
  }
}

// ---- Medium: HTML with a browser UA, og:title-aware (see extractTitle) ----

export async function fetchMediumTitle(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct && !/html/i.test(ct)) return null;
  return extractTitle(await res.text());
}

// ---- Stack Overflow: Stack Exchange API ----

export function stackExchangeApiUrl(url: string): string | null {
  const m = url.match(/\/questions\/(\d+)/);
  if (!m) return null;
  return `https://api.stackexchange.com/2.3/questions/${m[1]}?site=stackoverflow`;
}

export function parseStackOverflowJson(obj: unknown): string | null {
  const title = (obj as { items?: Array<{ title?: unknown }> })?.items?.[0]?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

// ---- X / Twitter: no scraping — derive offline from the URL slug ----

export function deriveXTitle(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const user = parts[0].replace(/^@/, '');
    return `${user} on X`;
  } catch {
    return null;
  }
}

/** Generic HTML <title> fetch (used by default and as a fallback). */
async function fetchHtmlTitle(url: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct && !/html/i.test(ct)) return null;
  return extractTitle(await res.text());
}

/**
 * Fetch the page title for a single URL, dispatching per platform:
 * - linkedin/x   -> slug-derived, offline (no network)
 * - youtube      -> oEmbed JSON
 * - reddit       -> `.json` listing
 * - medium       -> HTML (og:title-aware) with a browser UA
 * - stackoverflow-> Stack Exchange API
 * - generic      -> HTML <title> (og:title-aware)
 * Any special method that fails falls back to the generic HTML fetch; any
 * failure there returns the offline-derived title so callers always get a
 * usable label.
 */
export async function fetchTitle(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const target = unwrapUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const platform = platformOf(target);

    if (platform === 'linkedin') return deriveLinkedInTitle(target) ?? deriveTitle(target);
    if (platform === 'x') return deriveXTitle(target) ?? deriveTitle(target);

    if (platform === 'youtube') {
      try {
        const res = await fetch(youTubeOembedUrl(target), { signal: ac.signal });
        if (res.ok) {
          const t = parseYouTubeOembed(await res.json());
          if (t) return t;
        }
      } catch {
        // fall through to generic HTML title
      }
    }

    if (platform === 'reddit') {
      try {
        const res = await fetch(redditJsonUrl(target), {
          signal: ac.signal,
          headers: { 'User-Agent': 'wa-backup/1.0 (+title-extractor)' },
        });
        if (res.ok) {
          const t = parseRedditJson(await res.json());
          if (t) return t;
        }
      } catch {
        // fall through to generic HTML title
      }
    }

    if (platform === 'medium') {
      try {
        const t = await fetchMediumTitle(target, ac.signal);
        if (t) return t;
      } catch {
        // fall through to generic HTML title
      }
    }

    if (platform === 'stackoverflow') {
      try {
        const api = stackExchangeApiUrl(target);
        if (api) {
          const res = await fetch(api, { signal: ac.signal });
          if (res.ok) {
            const t = parseStackOverflowJson(await res.json());
            if (t) return t;
          }
        }
      } catch {
        // fall through to generic HTML title
      }
    }

    return (await fetchHtmlTitle(target, ac.signal)) ?? deriveTitle(target);
  } catch {
    return deriveTitle(target);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enrich messages with a URL→title map. Unique http(s) URLs are fetched once
 * and **in parallel** via concurrent promise workers (bounded by
 * `concurrency`), then mapped back onto each message. When `enabled` is false,
 * every message gets `urlTitles = {}` and no network is touched.
 */
export async function enrichTitles(
  messages: Message[],
  opts: {
    enabled: boolean;
    concurrency?: number;
    timeoutMs?: number;
    verbose?: boolean;
  } = { enabled: true },
): Promise<Message[]> {
  const enabled = opts.enabled;
  if (!enabled) {
    for (const m of messages) m.urlTitles = {};
    return messages;
  }
  const urls = [
    ...new Set(
      messages
        .flatMap((m) => (m.text ?? '').match(URL_RE) ?? [])
        .map(unwrapUrl),
    ),
  ];
  const map: Record<string, string> = {};
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  let cursor = 0;
  // Each worker pulls the next URL and awaits its fetch; the workers run
  // concurrently, so distinct URLs are resolved as parallel promises.
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, urls.length || 1); i++) {
    workers.push(
      (async () => {
        while (cursor < urls.length) {
          const url = urls[cursor++];
          const title = await fetchTitle(url, { timeoutMs: opts.timeoutMs });
          if (opts.verbose) {
            // eslint-disable-next-line no-console
            console.error(pc.dim('[wa-backup] title:') + ` ${url} -> ${title}`);
          }
          map[url] = title;
        }
      })(),
    );
  }
  await Promise.all(workers);
  for (const m of messages) {
    if (!m.text) {
      m.urlTitles = {};
      continue;
    }
    const titles: Record<string, string> = {};
    for (const raw of m.text.match(URL_RE) ?? []) {
      const u = unwrapUrl(raw);
      titles[u] = map[u] ?? deriveTitle(u);
    }
    m.urlTitles = titles;
  }
  return messages;
}
