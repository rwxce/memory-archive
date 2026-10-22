import type { Message } from '../../importers/whatsapp/types';
import type { MediaEntry, RenderOptions } from './media';
import { buildEnvelope, dayOf, timeOf } from './json';
import { getAccentColor, initials } from './colors';
import { linkifyHtml, deriveTitle } from './js/linkify.js';
import { sha256 } from './sha256';
import { VIEWER_SCRIPT } from './js/viewer-script.generated';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MEDIA_ICON: Record<string, string> = {
  photo: '📷 photo',
  sticker: '📷 photo',
  video: '🎬 video',
  document: '📄 document',
  audio: '🎧 audio',
};

/**
 * Render a media message as real HTML (MEDIA-02 / MEDIA-03):
 * - resolved + not inlining  -> <img>/<video>/<audio>/<a> with a relative `media/F` src
 * - `--inline` + inlineable  -> the same element with a `data:<mime>;base64,…` URI
 * - missing / not-inlineable (oversized or video under --inline) -> placeholder span
 * All `src`/`href`/`alt` values are HTML-escaped (OUT-05). Data URIs are built
 * from trusted local bytes, never from chat text.
 */
function mediaHtml(
  m: Message,
  media: Map<string, MediaEntry>,
  opts: RenderOptions,
): string | Promise<string> {
  const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
  const entry = media.get(m.media);
  const inline = Boolean(opts.inline);

  if (inline && entry && entry.inlineable && opts.loadDataUri) {
    // Bounded read (only inlineable files, < INLINE_MAX_BYTES).
    return inlineMediaHtml(m, entry, opts.loadDataUri);
  }
  if (!inline && entry) {
    const rel = escapeHtml(entry.relPath); // media/F (relative to messages.html)
    const alt = escapeHtml(m.media);
    if (m.type === 'photo' || m.type === 'sticker') {
      return `<img class="media-img" src="${rel}" alt="${alt}" loading="lazy">`;
    }
    if (m.type === 'video' || m.type === 'audio') {
      return `<${m.type} class="media-${m.type}" src="${rel}" controls preload="metadata"></${m.type}>`;
    }
    return `<a href="${rel}">${escapeHtml(label)}: ${alt}</a>`;
  }
  // Missing-but-expected, or not-inlineable under --inline: placeholder.
  return `<span class="media-placeholder">${escapeHtml(`${label}: ${m.media}`)}</span>`;
}

async function inlineMediaHtml(
  m: Message,
  entry: MediaEntry,
  loadDataUri: NonNullable<RenderOptions['loadDataUri']>,
): Promise<string> {
  const dataUri = await loadDataUri(entry);
  const alt = escapeHtml(m.media);
  if (m.type === 'photo' || m.type === 'sticker') {
    return `<img class="media-img" src="${dataUri}" alt="${alt}" loading="lazy">`;
  }
  if (m.type === 'video' || m.type === 'audio') {
    return `<${m.type} class="media-${m.type}" src="${dataUri}" controls></${m.type}>`;
  }
  return `<a href="${dataUri}">${escapeHtml(MEDIA_ICON[m.type] ?? `📎 ${m.type}`)}: ${alt}</a>`;
}

/** Comparable form of an author name: invisible marks dropped, trimmed, lower-case. */
function authorKey(s: string): string {
  return s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().toLowerCase();
}

/**
 * The export owner (outgoing side). An explicit `me` wins when it matches an
 * author (exactly, or ignoring case and invisible marks); otherwise the most
 * frequent author is guessed.
 */
export function resolveSelfAuthor(messages: Message[], me?: string): string {
  return (me ? findAuthor(messages, me) : undefined) ?? pickSelfAuthor(messages);
}

/** The author matching `name` exactly, or ignoring case and invisible marks. */
export function findAuthor(messages: Message[], name: string): string | undefined {
  const authors = new Set(messages.map((m) => m.author));
  if (authors.has(name)) return name;
  const key = authorKey(name);
  for (const a of authors) if (a && authorKey(a) === key) return a;
  return undefined;
}

/** Most frequent author is treated as the export owner (outgoing side). */
function pickSelfAuthor(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.type === 'system' || m.type === 'deleted' || m.type === 'omitted') continue;
    counts.set(m.author, (counts.get(m.author) ?? 0) + 1);
  }
  let best = '';
  let bestN = -1;
  for (const [a, n] of counts) {
    if (n > bestN) {
      best = a;
      bestN = n;
    }
  }
  return best;
}

const FIVE_MIN = 5 * 60 * 1000;
function tsMs(iso: string): number {
  return new Date(iso).getTime();
}

function renderBubble(
  group: Message[],
  selfAuthor: string,
  media: Map<string, MediaEntry>,
  opts: RenderOptions,
): Promise<string> {
  const first = group[0];
  const outgoing = first.author === selfAuthor;
  const side = outgoing ? 'outgoing' : 'incoming';
  const accent = escapeHtml(getAccentColor(first.author));
  const av = escapeHtml(initials(first.author));

  const header =
    first.type === 'system' || first.type === 'deleted' || first.type === 'omitted'
      ? ''
      : `<div class="bubble-sender" style="color:${accent}">${escapeHtml(first.author)}</div>`;

  const lines = group
    .map(async (m) => {
      const time = escapeHtml(timeOf(m.timestamp_iso).slice(0, 5));
      let body: string;
      const resolve = (u: string) => m.urlTitles?.[u] ?? deriveTitle(u);
      if (m.type === 'system' || m.type === 'deleted' || m.type === 'omitted') {
        return `<div class="bubble-text system">${linkifyHtml(m.text, resolve)}</div>`;
      } else if (m.media) {
        body = await mediaHtml(m, media, opts);
      } else {
        body = `<span class="bubble-text">${linkifyHtml(m.text, resolve)}</span>`;
      }
      return `<div class="bubble-line">${body}<span class="bubble-time">${time}</span></div>`;
    });

  const avatar =
    side === 'incoming' && first.type !== 'system' && first.type !== 'deleted' && first.type !== 'omitted'
      ? `<div class="avatar" style="background:${accent}">${av}</div>`
      : '';

  return Promise.all(lines).then(
    (rendered) =>
      `<div class="bubble-row ${side}" data-author="${escapeHtml(first.author)}">` +
      avatar +
      `<div class="bubble">${header}${rendered.join('')}</div>` +
      `</div>`,
  );
}

function renderDayPill(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
  const label = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  return `<div class="day-pill">${escapeHtml(label)}</div>`;
}

/** One transcript item: a day separator or a group of same-sender messages. */
export type TranscriptItem =
  | { kind: 'day'; day: string }
  | { kind: 'group'; messages: Message[] };

/**
 * Split messages into day separators and bubble groups (same sender, within
 * five minutes, user messages only). Day separators are explicit items, not
 * strings recognised by their shape.
 */
export function transcriptItems(messages: Message[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let lastDay: string | null = null;
  let i = 0;
  while (i < messages.length) {
    const group: Message[] = [messages[i]];
    let j = i + 1;
    while (j < messages.length) {
      const prev = messages[j - 1];
      const cur = messages[j];
      const sameSender = prev.author === cur.author;
      const withinWindow = tsMs(cur.timestamp_iso) - tsMs(prev.timestamp_iso) <= FIVE_MIN;
      const bothUser =
        prev.type !== 'system' &&
        prev.type !== 'deleted' &&
        prev.type !== 'omitted' &&
        cur.type !== 'system' &&
        cur.type !== 'deleted' &&
        cur.type !== 'omitted';
      // A group never crosses midnight, so every day gets its own separator.
      const sameDay = dayOf(prev.timestamp_iso) === dayOf(cur.timestamp_iso);
      if (sameSender && withinWindow && bothUser && sameDay) {
        group.push(cur);
        j++;
      } else {
        break;
      }
    }
    const day = dayOf(group[0].timestamp_iso);
    if (day !== lastDay) {
      out.push({ kind: 'day', day });
      lastDay = day;
    }
    out.push({ kind: 'group', messages: group });
    i = j;
  }
  return out;
}

async function renderTranscript(
  messages: Message[],
  media: Map<string, MediaEntry>,
  opts: HtmlRenderOptions,
  self: string,
): Promise<string> {
  const html = await Promise.all(
    transcriptItems(messages).map((item) =>
      item.kind === 'day'
        ? renderDayPill(item.day)
        : renderBubble(item.messages, self, media, opts),
    ),
  );
  return html.join('\n');
}

const CSS = `
:root { --bg:#efeae2; --panel:#ffffff; --ink:#111; --muted:#667781; --link:#0b93f6; }
[data-theme="dark"] { --bg:#0b141a; --panel:#1f2c34; --ink:#e9edef; --muted:#8696a0; --link:#58a6ff; }
* { box-sizing:border-box; }
a { color:var(--link); text-decoration:underline; }
body { margin:0; font-family: system-ui, "Segoe UI", Helvetica, Roboto, sans-serif; background:var(--bg); color:var(--ink); }
#toolbar { position:sticky; top:0; z-index:10; display:flex; flex-wrap:wrap; gap:8px; padding:8px 12px; background:var(--panel); border-bottom:1px solid rgba(0,0,0,.1); }
#toolbar input, #toolbar select { padding:6px 8px; border:1px solid #ccc; border-radius:6px; font-size:14px; }
#theme-toggle { margin-left:auto; cursor:pointer; border:1px solid #ccc; border-radius:6px; background:var(--panel); color:var(--ink); padding:6px 10px; }
.chat-title { font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:40%; min-width:0; }
#transcript { max-width:768px; margin:16px auto; padding:0 8px; display:flex; flex-direction:column; gap:4px; }
.day-pill { align-self:center; background:rgba(0,0,0,.12); color:var(--muted); font-size:12px; padding:3px 10px; border-radius:10px; margin:8px 0; text-align:center; }
.bubble-row { display:flex; gap:8px; align-items:flex-end; }
.bubble-row.outgoing { justify-content:flex-end; }
.bubble-row.incoming { justify-content:flex-start; }
.avatar { width:28px; height:28px; border-radius:50%; color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
.bubble { max-width:75%; padding:6px 9px; border-radius:8px; font-size:14px; line-height:1.35; overflow-wrap:anywhere; word-break:break-word; min-width:0; }
.outgoing .bubble { background:#d9fdd3; }
[data-theme="dark"] .outgoing .bubble { background:#005c4b; }
.incoming .bubble { background:var(--panel); }
.bubble-sender { font-size:13px; font-weight:600; margin-bottom:2px; }
.bubble-line { display:flex; gap:6px; align-items:baseline; }
.bubble-text.system { font-style:italic; color:var(--muted); }
.bubble-time { font-size:11px; color:var(--muted); margin-left:auto; white-space:nowrap; }
.media-placeholder { display:inline-block; background:rgba(0,0,0,.06); border:1px solid rgba(0,0,0,.1); border-radius:6px; padding:2px 6px; font-size:12px; color:var(--muted); }
.media-img { max-width:220px; max-height:280px; border-radius:6px; cursor:zoom-in; display:block; }
.media-video { display:block; width:280px; max-width:100%; max-height:320px; border-radius:6px; background:#000; }
.media-audio { display:block; width:260px; max-width:100%; }
.bubble-line > video, .bubble-line > audio { flex:1 1 auto; min-width:0; }
.lightbox { position:fixed; inset:0; background:rgba(0,0,0,.88); display:none; align-items:center; justify-content:center; z-index:100; cursor:zoom-out; }
.lightbox.open { display:flex; }
.lightbox img { max-width:95vw; max-height:95vh; border-radius:4px; }
@media print { body { background:#fff; } #toolbar { display:none; } .outgoing .bubble, .incoming .bubble { box-shadow:none; } }
`;

export interface HtmlRenderOptions extends RenderOptions {
  /** Who owns the export (outgoing bubbles). Falls back to the most frequent author. */
  me?: string;
}

const LIGHTBOX_JS = `
  (function(){
    var lb = document.getElementById('lightbox');
    var img = lb && lb.querySelector('img');
    document.addEventListener('click', function(e){
      var t = e.target;
      if (t && t.classList && t.classList.contains('media-img') && img) {
        img.src = t.getAttribute('src'); img.alt = t.getAttribute('alt') || '';
        lb.classList.add('open'); e.preventDefault();
      } else if (lb && lb.classList.contains('open')) {
        lb.classList.remove('open');
      }
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && lb) lb.classList.remove('open');
    });
  })();
`;

const THEME_JS = `
  (function(){
    function applyTheme(t){
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem('theme', t); } catch (e) {}
    }
    try {
      var saved = localStorage.getItem('theme');
      if (saved) applyTheme(saved);
    } catch (e) {}
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', function(){
      var cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  })();
`;

const FILTER_JS = `
  (function(){
    function applyFilter() {
      var searchEl = document.getElementById('search');
      var senderEl = document.getElementById('sender-filter');
      var q = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();
      var sender = senderEl && senderEl.value ? senderEl.value : '';
      var rows = document.querySelectorAll('.bubble-row');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var text = (row.textContent || '').toLowerCase();
        var author = row.getAttribute('data-author') || '';
        var show = (!q || text.indexOf(q) !== -1) && (!sender || author === sender);
        row.style.display = show ? '' : 'none';
      }
      var pills = document.querySelectorAll('.day-pill');
      for (var j = 0; j < pills.length; j++) {
        var pill = pills[j];
        var sib = pill.nextElementSibling;
        var anyVisible = false;
        while (sib && !sib.classList.contains('day-pill')) {
          if (sib.classList.contains('bubble-row') && sib.style.display !== 'none') anyVisible = true;
          sib = sib.nextElementSibling;
        }
        pill.style.display = anyVisible ? '' : 'none';
      }
    }
    var searchEl = document.getElementById('search');
    var senderEl = document.getElementById('sender-filter');
    if (searchEl) searchEl.addEventListener('input', applyFilter);
    if (senderEl) senderEl.addEventListener('change', applyFilter);
  })();
`;

function sha256Base64(text: string): string {
  const bytes = sha256(new TextEncoder().encode(text));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Content-Security-Policy for the standalone page: no network at all, scripts
 * only by hash of the exact inline blocks. Inline `style=` attributes (accent
 * colours) need 'unsafe-inline' for styles; scripts stay locked down.
 * `file:` is listed because 'self' does not match local files in every browser.
 */
export function buildCsp(scripts: string[]): string {
  const hashes = scripts.map((x) => `'sha256-${sha256Base64(x)}'`).join(' ');
  return [
    "default-src 'none'",
    `script-src ${hashes}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' file: data: blob:",
    "media-src 'self' file: data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** `messages.html` content: a standalone, WhatsApp-like page. */
export async function renderHtml(
  messages: Message[],
  chatName: string,
  opts: HtmlRenderOptions = {},
): Promise<string> {
  const media = opts.media ?? new Map<string, MediaEntry>();
  const envelope = buildEnvelope(messages, chatName, media);
  const self = resolveSelfAuthor(messages, opts.me);
  const transcript = await renderTranscript(messages, media, opts, self);

  // Escape `<` (covers `</script>` and `<!--`) and the JS line separators in
  // serialized JSON so message text cannot break out of the island.
  const islandJson = JSON.stringify(envelope)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  // Self-contained bundle (see scripts/build-viewer-script.mjs); `</script`
  // can never appear literally inside the inline script.
  const js = VIEWER_SCRIPT.replace(/<\/script/gi, '<\\/script');
  const viewerJs = `\n${js}\n`;
  const csp = buildCsp([viewerJs, LIGHTBOX_JS, THEME_JS, FILTER_JS]);

  const authors = [...new Set(messages.map((m) => m.author))].sort();
  const authorOptions = authors
    .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR" data-theme="light">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(chatName)} — WhatsApp Backup</title>
<style>${CSS}</style>
</head>
<body>
<div id="toolbar">
  <div class="chat-title" id="chat-title">${escapeHtml(chatName)}</div>
  <input id="search" type="search" placeholder="Buscar…" aria-label="Buscar mensagens">
  <select id="sender-filter" aria-label="Filtrar por remetente">
    <option value="">Todos os contatos</option>
    ${authorOptions}
  </select>
  <button id="theme-toggle" type="button">🌓 Tema</button>
</div>
<div id="transcript" data-me="${escapeHtml(self)}">
${transcript}
</div>
<script type="application/json" id="chat-data">${islandJson}</script>
<script>${viewerJs}</script>
<div class="lightbox" id="lightbox"><img alt=""></div>
<script>${LIGHTBOX_JS}</script>
<script>${THEME_JS}</script>
<script>${FILTER_JS}</script>
</body>
</html>
`;

  return html;
}
