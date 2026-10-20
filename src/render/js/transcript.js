// transcript.js — client-side viewer for the WhatsApp backup HTML output.
// Reads the `#chat-data` JSON island and builds the transcript with DOM APIs
// only (createElement + textContent). No innerHTML with untrusted strings.

import { setText, clear } from './xss-sanitize.js';
import { linkifyHtml, deriveTitle, faviconFor } from './linkify.js';

const MEDIA_ICON = {
  photo: '📷 photo',
  sticker: '📷 photo',
  video: '🎬 video',
  document: '📄 document',
  audio: '🎧 audio',
};

function accentColor(author) {
  // Mirror of src/render/colors.ts: SHA-256 -> hue.
  return new Promise((resolve) => {
    const buf = new TextEncoder().encode(author);
    crypto.subtle.digest('SHA-256', buf).then((h) => {
      const view = new DataView(h);
      const int = view.getUint32(0);
      resolve(`hsl(${int % 360}, 70%, 60%)`);
    });
  });
}

function initials(author) {
  const cleaned = author.replace(/[~\u202a\u202b]/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function mediaLabel(m) {
  const label = MEDIA_ICON[m.type] || `📎 ${m.type}`;
  return `${label}: ${m.media}`;
}

function matches(m, query, sender) {
  if (sender && m.author !== sender) return false;
  if (query) {
    const q = query.toLowerCase();
    if (!m.text.toLowerCase().includes(q) && !m.author.toLowerCase().includes(q)) {
      return false;
    }
  }
  return true;
}

function bubbleRow(m, selfAuthor, accent) {
  const outgoing = m.author === selfAuthor;
  const row = document.createElement('div');
  row.className = `bubble-row ${outgoing ? 'outgoing' : 'incoming'}`;
  row.dataset.author = m.author;
  row.dataset.text = m.text;

  if (!outgoing) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = accent;
    setText(avatar, initials(m.author));
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (m.type !== 'system' && m.type !== 'deleted' && m.type !== 'omitted') {
    const sender = document.createElement('div');
    sender.className = 'bubble-sender';
    sender.style.color = accent;
    setText(sender, m.author);
    bubble.appendChild(sender);
  }

  const line = document.createElement('div');
  line.className = 'bubble-line';
  const resolve = (u) => m.urlTitles?.[u] ?? deriveTitle(u);
  const icon = (u) => faviconFor(u);
  if (m.type === 'system' || m.type === 'deleted' || m.type === 'omitted') {
    const t = document.createElement('span');
    t.className = 'bubble-text system';
    t.innerHTML = linkifyHtml(m.text, resolve, icon);
    line.appendChild(t);
  } else if (m.media) {
    if (m.mediaPath) {
      const img = document.createElement('img');
      img.className = 'media-img';
      img.src = m.mediaPath;
      img.alt = m.media;
      img.loading = 'lazy';
      line.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'media-placeholder';
      setText(ph, mediaLabel(m));
      line.appendChild(ph);
    }
  } else {
    const t = document.createElement('span');
    t.className = 'bubble-text';
    t.innerHTML = linkifyHtml(m.text, resolve, icon);
    line.appendChild(t);
  }
  const time = document.createElement('span');
  time.className = 'bubble-time';
  setText(time, m.time.slice(0, 5));
  line.appendChild(time);
  bubble.appendChild(line);

  row.appendChild(bubble);
  return row;
}

function dayPill(day) {
  const d = new Date(day + 'T12:00:00Z');
  const label = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  const pill = document.createElement('div');
  pill.className = 'day-pill';
  setText(pill, label);
  return pill;
}

function sameCluster(a, b) {
  if (a.author !== b.author) return false;
  if (['system', 'deleted', 'omitted'].includes(a.type)) return false;
  if (['system', 'deleted', 'omitted'].includes(b.type)) return false;
  return new Date(b.timestampIso).getTime() - new Date(a.timestampIso).getTime() <= 5 * 60 * 1000;
}

export async function populateTranscript() {
  const island = document.getElementById('chat-data');
  const container = document.getElementById('transcript');
  if (!island || !container) return;
  const data = JSON.parse(island.textContent);
  const messages = data.messages;
  const selfAuthor = mostFrequent(messages);

  const accents = new Map();
  for (const m of messages) {
    if (!accents.has(m.author)) accents.set(m.author, await accentColor(m.author));
  }

  const query = (document.getElementById('search')?.value || '').trim();
  const sender = document.getElementById('sender-filter')?.value || '';

  clear(container);
  let lastDay = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!matches(m, query, sender)) continue;
    if (m.day !== lastDay) {
      container.appendChild(dayPill(m.day));
      lastDay = m.day;
    }
    const accent = accents.get(m.author);
    // Cluster consecutive same-sender bursts for display.
    const cluster = [m];
    let j = i + 1;
    while (j < messages.length && matches(messages[j], query, sender) && sameCluster(m, messages[j])) {
      cluster.push(messages[j]);
      j++;
    }
    for (const cm of cluster) {
      container.appendChild(bubbleRow(cm, selfAuthor, accents.get(cm.author)));
    }
    i = j - 1;
  }
}

function mostFrequent(messages) {
  const counts = new Map();
  for (const m of messages) {
    if (['system', 'deleted', 'omitted'].includes(m.type)) continue;
    counts.set(m.author, (counts.get(m.author) || 0) + 1);
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

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {
    /* storage unavailable */
  }
}

function init() {
  let saved = 'light';
  try {
    saved = localStorage.getItem('theme') || 'light';
  } catch (e) {
    /* storage unavailable */
  }
  applyTheme(saved);
  populateTranscript();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
