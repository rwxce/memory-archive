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

function escapeMd(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Drop sentence punctuation that is almost never part of the URL. Deliberately
// excludes `)`/`]`/`}` so URLs like wikipedia disambiguation links stay intact.
function trimTrailingPunct(url) {
  return url.replace(/[.,;:!?]+$/, '');
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
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return host;
    return host + path;
  } catch (e) {
    return url;
  }
}

/**
 * LinkedIn shares links through a redirect wrapper
 * (e.g. `/safety/go/?url=<percent-encoded destination>`). Return the real
 * destination so titles, favicons and the clickable href point at the actual
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
    return decodeURIComponent(target);
  } catch {
    return url;
  }
}

/** Escape text and wrap http(s) URLs in safe <a> anchors. */
export function linkifyHtml(text, resolver, iconResolver) {
  if (!text) return '';
  const resolve = resolver ?? deriveTitle;
  const iconFor = iconResolver ?? (() => '');
  const re = new RegExp(URL_RE.source, 'gi');
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(last, m.index));
    const url = unwrapUrl(trimTrailingPunct(m[0]));
    const href = escapeHtml(url);
    const title = escapeHtml(resolve(url));
    const fav = iconFor(url);
    const favImg = fav
      ? `<img class="favicon" src="${escapeHtml(fav)}" alt="" loading="lazy">`
      : '';
    result += `<a href="${href}" target="_blank" rel="noopener noreferrer">${favImg}${title}</a>`;
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
    const url = unwrapUrl(trimTrailingPunct(m[0]));
    const title = resolve(url).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    result += `[${title}](${safeUrl})`;
    last = m.index + m[0].length;
  }
  result += escapeMd(text.slice(last));
  return result;
}

/** Default favicon URL for a page: the site's conventional `/favicon.ico`. */
export function faviconFor(url) {
  try {
    return new URL('/favicon.ico', url).href;
  } catch {
    return '';
  }
}
