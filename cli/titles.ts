import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import pc from 'picocolors';
import type { Message } from '@/lib/importers/whatsapp';
import { URL_RE, deriveTitle, unwrapUrl } from '@/lib/exporters/legacy/js/linkify.js';

/**
 * Optional link-title enrichment. OFF by default (`--fetch-titles` opts in):
 * it is the only network access of the CLI. Every request goes through
 * `guardedFetch`, which refuses non-http(s) URLs and hosts that resolve to
 * private, loopback, link-local or otherwise non-public addresses, and follows
 * at most `MAX_REDIRECTS` redirects, re-checking each hop.
 */

// Browser-like UA reduces blocks on sites (Medium, etc.) that serve a
// placeholder to bots.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const MAX_REDIRECTS = 3;
/** Only the start of a page is read; titles live in `<head>`. */
const MAX_BODY_BYTES = 512 * 1024;

// ---- SSRF guard ----

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function isPrivateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal into 8 hextets (handles `::` and embedded IPv4). */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = parseIPv4(v4[2]);
    if (!p) return null;
    s = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
  if (all.length !== 8 || !all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

/**
 * True for any address a link in a chat must never make us contact:
 * loopback, private, link-local, CGNAT, multicast, unspecified, documentation
 * and benchmarking ranges, IPv6 ULA / link-local, and IPv4-mapped / NAT64
 * forms of those. Unparseable input counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPrivateIPv4(v4);
  const h = parseIPv6(ip);
  if (!h) return true;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  const embedded = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPrivateIPv4(embedded); // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(embedded); // NAT64
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}

export interface FetchGuardOptions {
  /** Resolve a host name to IP addresses (default: system DNS, all records). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Tests only: allow loopback/private targets (e.g. a local mock server). */
  allowPrivateHosts?: boolean;
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * Throw unless `raw` is an http(s) URL whose host resolves only to public
 * addresses. Note: `fetch` resolves the host again, so a hostile DNS server
 * could still answer differently between the check and the request (DNS
 * rebinding); the check stops plain links to internal hosts.
 */
export async function assertPublicHttpUrl(raw: string, opts: FetchGuardOptions = {}): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked scheme: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('blocked: credentials in URL');
  if (opts.allowPrivateHosts) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (opts.resolveHost ?? defaultResolveHost)(host);
  if (addresses.length === 0) throw new Error(`blocked: ${host} does not resolve`);
  for (const a of addresses) {
    if (isPrivateAddress(a)) throw new Error(`blocked: ${host} resolves to a non-public address`);
  }
  return url;
}

/** `fetch` with the SSRF guard on the URL and on every redirect hop. */
export async function guardedFetch(
  raw: string,
  init: RequestInit,
  opts: FetchGuardOptions = {},
): Promise<Response> {
  let current = raw;
  for (let hop = 0; ; hop++) {
    const url = await assertPublicHttpUrl(current, opts);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, url).href;
      continue;
    }
    return res;
  }
}

/** Read at most `MAX_BODY_BYTES` of a response as text. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    text += decoder.decode(value, { stream: true });
    if (bytes >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(await readCapped(res));
}

// ---- title extraction ----

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

// ---- HTML pages (Medium and generic): og:title-aware ----

async function fetchHtmlTitle(
  url: string,
  signal: AbortSignal,
  guard: FetchGuardOptions,
): Promise<string | null> {
  const res = await guardedFetch(url, { signal, headers: { 'User-Agent': UA } }, guard);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct && !/html/i.test(ct)) return null;
  return extractTitle(await readCapped(res));
}

export function fetchMediumTitle(
  url: string,
  signal: AbortSignal,
  guard: FetchGuardOptions = {},
): Promise<string | null> {
  return fetchHtmlTitle(url, signal, guard);
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

export interface FetchTitleOptions extends FetchGuardOptions {
  timeoutMs?: number;
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
 * failure there (including a blocked URL) returns the offline-derived title
 * so callers always get a usable label.
 */
export async function fetchTitle(url: string, opts: FetchTitleOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const target = unwrapUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const signal = ac.signal;
  try {
    const platform = platformOf(target);

    if (platform === 'linkedin') return deriveLinkedInTitle(target) ?? deriveTitle(target);
    if (platform === 'x') return deriveXTitle(target) ?? deriveTitle(target);

    // The page itself must be a public http(s) URL even when an API is asked.
    await assertPublicHttpUrl(target, opts);

    if (platform === 'youtube') {
      try {
        const res = await guardedFetch(youTubeOembedUrl(target), { signal }, opts);
        if (res.ok) {
          const t = parseYouTubeOembed(await readJson(res));
          if (t) return t;
        }
      } catch {
        // fall through to generic HTML title
      }
    }

    if (platform === 'reddit') {
      try {
        const res = await guardedFetch(
          redditJsonUrl(target),
          {
            signal,
            headers: { 'User-Agent': 'memory-archive/0.1 (+https://github.com/rwxce/memory-archive)' },
          },
          opts,
        );
        if (res.ok) {
          const t = parseRedditJson(await readJson(res));
          if (t) return t;
        }
      } catch {
        // fall through to generic HTML title
      }
    }

    if (platform === 'medium') {
      try {
        const t = await fetchMediumTitle(target, signal, opts);
        if (t) return t;
      } catch {
        // fall through to generic HTML title
      }
    }

    if (platform === 'stackoverflow') {
      try {
        const api = stackExchangeApiUrl(target);
        if (api) {
          const res = await guardedFetch(api, { signal }, opts);
          if (res.ok) {
            const t = parseStackOverflowJson(await readJson(res));
            if (t) return t;
          }
        }
      } catch {
        // fall through to generic HTML title
      }
    }

    return (await fetchHtmlTitle(target, signal, opts)) ?? deriveTitle(target);
  } catch {
    return deriveTitle(target);
  } finally {
    clearTimeout(timer);
  }
}

export interface EnrichOptions extends FetchGuardOptions {
  enabled: boolean;
  concurrency?: number;
  timeoutMs?: number;
  verbose?: boolean;
}

/**
 * Enrich messages with a URL→title map.
 *
 * Titles already stored on a message (from an earlier run) are always kept.
 * When `enabled`, only URLs that have no stored title anywhere in the chat are
 * fetched, once each and in parallel (bounded by `concurrency`). When
 * disabled, nothing is fetched and nothing is removed.
 */
export async function enrichTitles(
  messages: Message[],
  opts: EnrichOptions = { enabled: false },
): Promise<Message[]> {
  const known: Record<string, string> = {};
  for (const m of messages) {
    m.urlTitles = m.urlTitles ?? {};
    for (const [u, t] of Object.entries(m.urlTitles)) known[u] ??= t;
  }
  if (!opts.enabled) return messages;

  const urls = [
    ...new Set(
      messages
        .flatMap((m) => (m.text ?? '').match(URL_RE) ?? [])
        .map(unwrapUrl)
        .filter((u) => !(u in known)),
    ),
  ];
  const fetched: Record<string, string> = {};
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  let cursor = 0;
  // Each worker pulls the next URL and awaits its fetch; the workers run
  // concurrently, so distinct URLs are resolved as parallel promises.
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
    workers.push(
      (async () => {
        while (cursor < urls.length) {
          const url = urls[cursor++];
          const title = await fetchTitle(url, opts);
          if (opts.verbose) {
            console.error(pc.dim('[memory-archive] title:') + ` ${url} -> ${title}`);
          }
          fetched[url] = title;
        }
      })(),
    );
  }
  await Promise.all(workers);
  for (const m of messages) {
    if (!m.text) continue;
    const titles: Record<string, string> = { ...m.urlTitles };
    for (const raw of m.text.match(URL_RE) ?? []) {
      const u = unwrapUrl(raw);
      titles[u] ??= known[u] ?? fetched[u] ?? deriveTitle(u);
    }
    m.urlTitles = titles;
  }
  return messages;
}
