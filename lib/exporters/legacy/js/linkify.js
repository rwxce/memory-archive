// linkify.js — turn URLs in message text into safe, offline-derived links.
// Shared by the Node renderers (html.ts, md.ts) and the browser viewer
// (transcript.js). No network access: titles are derived from the URL only.

export const URL_RE = /(https?:\/\/[^\s<>"'`]+)/gi;

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Make untrusted text inert in Markdown viewers: raw HTML (`& < >`) becomes
 * entities and every inline-syntax character is backslash-escaped, so text
 * can never open an image, link, emphasis or code span. `(` and `)` stay
 * literal on purpose: without an unescaped `]` before them they cannot start a
 * link destination. Block markers (`#`, `-`, `+`, `=`, `1.`) are escaped after
 * a line break so multi-line text cannot forge headings or lists.
 */
export function escapeMd(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]]/g, '\\$&')
    .replace(/(\n[ \t]*)([#+\-=])/g, '$1\\$2')
    .replace(/(\n[ \t]*\d+)([.)])/g, '$1\\$2');
}

// Drop sentence punctuation that is almost never part of the URL. Deliberately
// excludes `)`/`]`/`}` so URLs like wikipedia disambiguation links stay intact.
// A loop, not `/[.,;:!?]+$/`: that pattern is quadratic on a long run that is not at the end.
function trimTrailingPunct(url) {
  let end = url.length;
  while (end > 0 && '.,;:!?'.includes(url[end - 1])) end--;
  return url.slice(0, end);
}

/** True only for an absolute URL whose parsed protocol is http: or https:. */
export function isHttpUrl(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/**
 * Offline page "title": host (www. stripped) + non-root path. Falls back to the
 * raw URL if it cannot be parsed.
 */
export function deriveTitle(url) {
  try {
    const u = new URL(url);
    let host = u.hostname;
    if (host.startsWith('www.')) host = host.slice(4);
    let pathEnd = u.pathname.length;
    while (pathEnd > 0 && u.pathname[pathEnd - 1] === '/') pathEnd--;
    const path = u.pathname.slice(0, pathEnd);
    if (!path || path === '/') return host;
    return host + path;
  } catch (e) {
    return url;
  }
}

/**
 * LinkedIn shares links through a redirect wrapper
 * (e.g. `/safety/go/?url=<percent-encoded destination>`). Return the real
 * destination so titles and the clickable href point at the actual
 * page, not the LinkedIn interstitial. Non-LinkedIn / non-redirect URLs pass
 * through unchanged.
 */
export function unwrapUrl(url) {
  try {
    const u = new URL(url);
    const isLi =
      u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com');
    if (!isLi) return url;
    const isRedirect =
      /\/(safety\/go|redir\/redirect|feed\/link|redirect)\b/.test(u.pathname);
    if (!isRedirect) return url;
    const target = u.searchParams.get('url');
    if (!target) return url;
    const decoded = decodeURIComponent(target);
    // Only http(s) targets may replace the wrapper: javascript:, data:, file:,
    // vbscript: ... would become a clickable href.
    return isHttpUrl(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

// Unwrap, then guarantee the result is http(s); otherwise keep the original.
function safeLinkUrl(raw) {
  const url = unwrapUrl(raw);
  return isHttpUrl(url) ? url : raw;
}

/**
 * Escape text and wrap http(s) URLs in safe <a> anchors.
 *
 * Never emits a resource that loads from the linked site (no site icons, no
 * previews): opening a backup must not tell any server that it was opened.
 */
export function linkifyHtml(text, resolver) {
  if (!text) return '';
  const resolve = resolver ?? deriveTitle;
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, m.index));
    const url = safeLinkUrl(trimTrailingPunct(m[0]));
    const href = escapeHtml(url);
    const title = escapeHtml(resolve(url));
    result += `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    last = m.index + m[0].length;
  }
  result += escapeHtml(text.slice(last));
  return result;
}

/** Escape text and wrap http(s) URLs in Markdown `[title](url)` links. */
export function linkifyMarkdown(text, resolver) {
  if (!text) return '';
  const resolve = resolver ?? deriveTitle;
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeMd(text.slice(last, m.index));
    const url = safeLinkUrl(trimTrailingPunct(m[0]));
    if (!isHttpUrl(url)) {
      // Never emit a non-http(s) link target; keep it as inert text.
      result += escapeMd(url);
      last = m.index + m[0].length;
      continue;
    }
    // Fetched titles are untrusted: escape them and keep them on one line.
    const title = escapeMd(resolve(url).replace(/\s+/g, ' '));
    const safeUrl = url.replace(/[\\()]/g, '\\$&');
    result += `[${title}](${safeUrl})`;
    last = m.index + m[0].length;
  }
  result += escapeMd(text.slice(last));
  return result;
}
