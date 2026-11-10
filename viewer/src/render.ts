import { h } from './dom';
import type { ViewerMessage, ViewerPhoto } from '../../lib/exporters/viewer/format';
import type { Translate } from './strings';
import { type Range, findRanges, splitLinks } from './text';

/**
 * Renders one message to DOM. Everything that comes from the data (author, text, file name) is
 * added as a text node; links are http(s) only and open with rel="noopener noreferrer"; media
 * paths were validated by `parseViewerData` and are set through setAttribute.
 */

export interface RenderContext {
  doc: Document;
  t: Translate;
  /** Folded search terms to highlight ([] for none). */
  terms: readonly string[];
  isGroup: boolean;
  mimeByPath: ReadonlyMap<string, string>;
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', '3gp']);
const AUDIO_EXT = new Set(['ogg', 'opus', 'mp3', 'm4a', 'aac', 'wav', 'amr']);

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export function mediaKind(path: string, mime: string | undefined): MediaKind {
  const group = mime?.split('/')[0];
  if (group === 'image' || group === 'video' || group === 'audio') return group;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'file';
}

/** Appends `text[start,end)` to `parent`, wrapping the parts that fall in `ranges` in <mark>. */
function appendMarked(doc: Document, parent: Node, text: string, start: number, end: number, ranges: readonly Range[]): void {
  let at = start;
  for (const r of ranges) {
    if (r.end <= at || r.start >= end) continue;
    const s = Math.max(r.start, at);
    const e = Math.min(r.end, end);
    if (s > at) parent.appendChild(doc.createTextNode(text.slice(at, s)));
    parent.appendChild(h(doc, 'mark', { text: text.slice(s, e) }));
    at = e;
  }
  if (at < end) parent.appendChild(doc.createTextNode(text.slice(at, end)));
}

/** Plain text with highlights, no links. */
export function appendHighlighted(doc: Document, parent: Node, text: string, ranges: readonly Range[]): void {
  appendMarked(doc, parent, text, 0, text.length, ranges);
}

/** Text with http(s) links and highlighted search terms. */
export function appendRichText(doc: Document, parent: Node, text: string, terms: readonly string[]): void {
  const ranges = findRanges(text, terms);
  for (const part of splitLinks(text)) {
    if (part.href === null) {
      appendMarked(doc, parent, text, part.start, part.end, ranges);
    } else {
      const a = h(doc, 'a', { attrs: { href: part.href, target: '_blank', rel: 'noopener noreferrer' } });
      appendMarked(doc, a, text, part.start, part.end, ranges);
      parent.appendChild(a);
    }
  }
}

function fileLink(ctx: RenderContext, path: string, name: string): HTMLElement {
  const { doc, t } = ctx;
  const a = h(doc, 'a', { class: 'file', attrs: { href: path, target: '_blank', rel: 'noopener noreferrer', title: t('openFile') } });
  appendRichName(ctx, a, name || t('attachment'));
  return a;
}

function appendRichName(ctx: RenderContext, parent: Node, name: string): void {
  appendHighlighted(ctx.doc, parent, name, findRanges(name, ctx.terms));
}

function renderMedia(ctx: RenderContext, path: string, name: string): HTMLElement {
  const { doc, t } = ctx;
  const kind = mediaKind(path, ctx.mimeByPath.get(path));
  const label = name || t('attachment');
  const box = h(doc, 'div', { class: `media media-${kind}` });
  if (kind === 'image') {
    const img = h(doc, 'img', { attrs: { src: path, alt: label, loading: 'lazy', decoding: 'async' } });
    // A format the browser cannot show (HEIC, ...) falls back to a link with the file name.
    img.addEventListener('error', () => img.replaceWith(fileLink(ctx, path, name)));
    const a = h(doc, 'a', { attrs: { href: path, target: '_blank', rel: 'noopener noreferrer', title: t('openFile') } }, [img]);
    box.append(a);
  } else if (kind === 'video') {
    box.append(h(doc, 'video', { attrs: { src: path, controls: true, preload: 'none', 'aria-label': label } }));
    box.append(fileLink(ctx, path, name));
  } else if (kind === 'audio') {
    box.append(h(doc, 'audio', { attrs: { src: path, controls: true, preload: 'none', 'aria-label': label } }));
  } else {
    box.append(fileLink(ctx, path, name));
  }
  return box;
}

/** `HH:MM` from a local `YYYY-MM-DDTHH:MM:SS` stamp (no time zone is involved). */
export function timeOf(sentAt: string): string {
  return sentAt.slice(11, 16);
}

export function renderMessage(ctx: RenderContext, message: ViewerMessage, index: number): HTMLElement {
  const { doc } = ctx;
  const system = message.author === null;
  const el = h(doc, 'div', {
    class: system ? 'msg system' : message.isMe ? 'msg mine' : 'msg theirs',
    attrs: { 'data-msg': index },
  });
  if (!system && !message.isMe && ctx.isGroup) {
    const author = h(doc, 'p', { class: 'author' });
    author.textContent = message.author;
    el.append(author);
  }
  if (message.media !== null) el.append(renderMedia(ctx, message.media, message.mediaName));
  else if (message.mediaName !== '') {
    const missing = h(doc, 'p', { class: 'file missing' });
    missing.append(h(doc, 'span', { class: 'file-name' }));
    appendRichName(ctx, missing.firstElementChild as HTMLElement, message.mediaName);
    missing.append(h(doc, 'span', { class: 'note', text: ` (${ctx.t('fileMissing')})` }));
    el.append(missing);
  }
  if (message.text !== '') {
    const body = h(doc, 'p', { class: 'text' });
    appendRichText(doc, body, message.text, ctx.terms);
    el.append(body);
  }
  if (message.sentAt.length >= 16) {
    el.append(h(doc, 'time', { class: 'time', text: timeOf(message.sentAt), attrs: { datetime: message.sentAt } }));
  }
  return el;
}

/**
 * One tile of a person's photo grid. File name and albums are untrusted: only `alt`, `title`,
 * `aria-label` and text nodes. A picture the browser cannot show (HEIC, ...) becomes a link with the
 * file name; a video loads nothing until it is played.
 */
export function renderPhotoTile(doc: Document, t: Translate, photo: ViewerPhoto, dateLabel: string): HTMLElement {
  const label = photo.fileName || t('attachment');
  const title = dateLabel ? `${label} · ${dateLabel}` : label;
  const li = h(doc, 'li', { class: `photo photo-${photo.kind}` });
  if (photo.kind === 'video') {
    li.append(h(doc, 'video', { attrs: { src: photo.path, controls: true, preload: 'none', 'aria-label': label } }));
    li.append(h(doc, 'a', { class: 'file', text: `${t('photoVideo')}: ${label}`, attrs: { href: photo.path, target: '_blank', rel: 'noopener noreferrer', title: t('openFile') } }));
  } else {
    const img = h(doc, 'img', { attrs: { src: photo.path, alt: label, loading: 'lazy', decoding: 'async' } });
    const a = h(doc, 'a', { attrs: { href: photo.path, target: '_blank', rel: 'noopener noreferrer', title } }, [img]);
    img.addEventListener('error', () => a.replaceChildren(h(doc, 'span', { class: 'file', text: label })));
    li.append(a);
  }
  if (dateLabel) li.append(h(doc, 'p', { class: 'muted small', text: dateLabel }));
  return li;
}
