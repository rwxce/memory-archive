import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readCsv } from '../csv';
import { buildMediaMap } from '../media';
import type { MediaEntry } from '../media';
import type { Message } from '../parse/types';
import { buildEnvelope, dayOf, timeOf } from './json';
import { getAccentColor, initials } from './colors';
import { linkifyHtml, deriveTitle, faviconFor } from './js/linkify.js';

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
 * - resolved + not inlining  -> <img>/<video>/<a> with a relative `media/F` src
 * - `--inline` + inlineable  -> the same element with a `data:<mime>;base64,…` URI
 * - missing / not-inlineable (oversized or video under --inline) -> placeholder span
 * All `src`/`href`/`alt` values are HTML-escaped (OUT-05). Data URIs are built
 * from trusted local bytes, never from chat text.
 */
function mediaHtml(
  m: Message,
  media: Map<string, MediaEntry>,
  inline: boolean,
  dir: string,
): string | Promise<string> {
  const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
  const entry = media.get(m.media);

  if (inline && entry && entry.inlineable) {
    // Bounded read (only inlineable files, < INLINE_MAX_BYTES) from disk.
    return readFileAsDataUri(m, entry, dir);
  }
  if (!inline && entry) {
    const rel = escapeHtml(entry.relPath); // media/F (relative to messages.html)
    const alt = escapeHtml(m.media);
    if (m.type === 'photo' || m.type === 'sticker') {
      return `<img class="media-img" src="${rel}" alt="${alt}" loading="lazy">`;
    }
    if (m.type === 'video') {
      return `<video src="${rel}" controls>`;
    }
    return `<a href="${rel}">${escapeHtml(label)}: ${alt}</a>`;
  }
  // Missing-but-expected, or not-inlineable under --inline: placeholder.
  return `<span class="media-placeholder">${escapeHtml(`${label}: ${m.media}`)}</span>`;
}

async function readFileAsDataUri(
  m: Message,
  entry: MediaEntry,
  dir: string,
): Promise<string> {
  const bytes = await fs.readFile(path.join(dir, entry.relPath));
  const dataUri = `data:${entry.mime};base64,${bytes.toString('base64')}`;
  const alt = escapeHtml(m.media);
  if (m.type === 'photo' || m.type === 'sticker') {
    return `<img class="media-img" src="${dataUri}" alt="${alt}" loading="lazy">`;
  }
  if (m.type === 'video') {
    return `<video src="${dataUri}" controls>`;
  }
  return `<a href="${dataUri}">${escapeHtml(MEDIA_ICON[m.type] ?? `📎 ${m.type}`)}: ${alt}</a>`;
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
  inline: boolean,
  dir: string,
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
      const time = timeOf(m.timestamp_iso).slice(0, 5);
      let body: string;
      const resolve = (u: string) => m.urlTitles?.[u] ?? deriveTitle(u);
      const icon = (u: string) => faviconFor(u);
      if (m.type === 'system' || m.type === 'deleted' || m.type === 'omitted') {
        return `<div class="bubble-text system">${linkifyHtml(m.text, resolve, icon)}</div>`;
      } else if (m.media) {
        body = await mediaHtml(m, media, inline, dir);
      } else {
        body = `<span class="bubble-text">${linkifyHtml(m.text, resolve, icon)}</span>`;
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

function renderTranscript(
  messages: Message[],
  media: Map<string, MediaEntry>,
  inline: boolean,
  dir: string,
): Promise<string> {
  const self = pickSelfAuthor(messages);
  const out: (string | Promise<string>)[] = [];
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
      if (sameSender && withinWindow && bothUser) {
        group.push(cur);
        j++;
      } else {
        break;
      }
    }
    const day = dayOf(group[0].timestamp_iso);
    if (out.length === 0 || out[out.length - 1] !== day) {
      out.push(day);
    }
    out.push(renderBubble(group, self, media, inline, dir));
    i = j;
  }
  // Convert day markers to day-pills.
  return Promise.all(out).then((items) => {
    const html: string[] = [];
    for (const item of items) {
      if (item.length === 10 && item[4] === '-') {
        html.push(renderDayPill(item));
      } else {
        html.push(item);
      }
    }
    return html.join('\n');
  });
}

const CSS = `
:root { --bg:#efeae2; --panel:#ffffff; --ink:#111; --muted:#667781; --link:#0b93f6; }
[data-theme="dark"] { --bg:#0b141a; --panel:#1f2c34; --ink:#e9edef; --muted:#8696a0; --link:#58a6ff; }
* { box-sizing:border-box; }
a { color:var(--link); text-decoration:underline; }
body { margin:0; font-family: system-ui, "Segoe UI", Helvetica, Roboto, sans-serif; background:var(--bg); color:var(--ink); }
#toolbar { position:sticky; top:0; z-index:10; display:flex; gap:8px; padding:8px 12px; background:var(--panel); border-bottom:1px solid rgba(0,0,0,.1); }
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
.favicon { width:14px; height:14px; vertical-align:middle; margin-right:4px; border-radius:2px; }
.media-placeholder { display:inline-block; background:rgba(0,0,0,.06); border:1px solid rgba(0,0,0,.1); border-radius:6px; padding:2px 6px; font-size:12px; color:var(--muted); }
.media-img { max-width:220px; max-height:280px; border-radius:6px; cursor:zoom-in; display:block; }
.lightbox { position:fixed; inset:0; background:rgba(0,0,0,.88); display:none; align-items:center; justify-content:center; z-index:100; cursor:zoom-out; }
.lightbox.open { display:flex; }
.lightbox img { max-width:95vw; max-height:95vh; border-radius:4px; }
@media print { body { background:#fff; } #toolbar { display:none; } .outgoing .bubble, .incoming .bubble { box-shadow:none; } }
`;

export async function renderHtml(
  csvPath: string,
  outDir: string,
  chatName: string,
  _opts: { inline?: boolean } = {},
): Promise<string> {
  const messages = readCsv(csvPath);
  const inline = Boolean(_opts.inline);
  const media = buildMediaMap(outDir, messages);
  const envelope = buildEnvelope(messages, chatName);
  const transcript = await renderTranscript(messages, media, inline, outDir);

  // Escape `</` in serialized JSON so message text containing </script> cannot
  // break the document (D-32 landmine).
  const islandJson = JSON.stringify(envelope).replace(/<\//g, '<\\/');

  const jsPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'js', 'transcript.js');
  const js = await fs.readFile(jsPath, 'utf8');

  const authors = [...new Set(messages.map((m) => m.author))].sort();
  const authorOptions = authors
    .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR" data-theme="light">
<head>
<meta charset="utf-8">
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
<div id="transcript">
${transcript}
</div>
<script type="application/json" id="chat-data">${islandJson}</script>
<script type="module">
${js}
</script>
<div class="lightbox" id="lightbox"><img alt=""></div>
<script>
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
</script>
<script>
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
</script>
<script>
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
</script>
</body>
</html>
`;

  const outPath = path.join(outDir, 'messages.html');
  await fs.writeFile(outPath, html, 'utf8');
  return outPath;
}
