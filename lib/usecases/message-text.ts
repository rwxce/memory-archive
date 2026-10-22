import { deriveTitle, unwrapUrl, URL_RE } from '../exporters/legacy/js/linkify.js';

/**
 * Message text as plain pieces for the UI: runs of text and http(s) links. Nothing here builds
 * HTML: the UI renders `text` as text and sets `href` on an anchor, so chat content can never
 * become markup. Same URL rules as the standalone viewer (`linkify.js`), with one more guard:
 * a link is only ever `http:` or `https:` (a redirect wrapper that unwraps to anything else
 * stays as the original address).
 *
 * No network: the label comes from the address itself (host and path), never from the page.
 */
export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; href: string; label: string };

/** Sentence punctuation that is almost never part of a link (closing brackets stay, as in `linkify.js`). */
const trimTrailingPunctuation = (url: string) => url.replace(/[.,;:!?]+$/, '');

function webAddress(value: string): string | undefined {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = new RegExp(URL_RE.source, 'gi');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = trimTrailingPunctuation(match[0]);
    const href = webAddress(unwrapUrl(raw)) ?? webAddress(raw);
    if (!href) continue;
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) });
    parts.push({ kind: 'link', href, label: deriveTitle(href) });
    // Punctuation trimmed from the end of the address goes back to the text.
    last = match.index + raw.length;
    re.lastIndex = last;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
