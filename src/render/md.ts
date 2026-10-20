import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readCsv } from '../csv';
import { buildMediaMap } from '../media';
import type { MediaEntry } from '../media';
import type { Message } from '../parse/types';
import { dayOf, timeOf } from './json';
import { linkifyMarkdown, deriveTitle } from './js/linkify.js';

const PT_BR_DATE = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function fullPtBrDate(day: string): string {
  // day = yyyy-mm-dd (local ISO). Anchor at noon UTC to avoid TZ/DST drift.
  const d = new Date(day + 'T12:00:00Z');
  return PT_BR_DATE.format(d);
}

const MEDIA_ICON: Record<string, string> = {
  photo: '📷 photo',
  sticker: '📷 photo',
  video: '🎬 video',
  document: '📄 document',
  audio: '🎧 audio',
};

function escapeMd(s: string): string {
  // Markdown viewers can execute raw HTML; escape to keep content inert (OUT-05).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Markdown body for a media message.
 * - photo/sticker -> embedded image `![alt](src)` (optionally a `data:` URI
 *   when `--inline` and the file is inlineable), with the caption as text.
 * - video/document/audio -> a Markdown link to the media path.
 * - unresolved media -> bracket placeholder (no broken link).
 */
async function mediaMarkdown(
  m: Message,
  media: Map<string, MediaEntry>,
  inline: boolean,
  outDir: string,
): Promise<string> {
  const entry = media.get(m.media);
  if (!entry) {
    const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
    return `[${label}: ${escapeMd(m.media)}]`;
  }
  const isImg = m.type === 'photo' || m.type === 'sticker';
  let src: string;
  if (inline && entry.inlineable) {
    const bytes = await fs.readFile(path.join(outDir, entry.relPath));
    src = `data:${entry.mime};base64,${bytes.toString('base64')}`;
  } else {
    src = entry.relPath;
  }
  if (isImg) {
    const img = `![${escapeMd(m.media)}](${src})`;
    const caption = m.text
      ? linkifyMarkdown(m.text, (u) => m.urlTitles?.[u] ?? deriveTitle(u))
      : '';
    return caption ? `${img} ${caption}` : img;
  }
  const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
  return `[${label}: ${escapeMd(m.media)}](${src})`;
}

/**
 * Render the chat as a day-sectioned Markdown log (D-45/D-46/D-47).
 * - `## <pt-BR full date>` per day
 * - `**Sender** · HH:mm — text` per message
 * - media -> embedded image `![FILENAME](media/FILENAME)` (photo/sticker) or
 *   a link for video/document; `--inline` embeds as a `data:` URI
 * - system/deleted/omitted -> italic `*text*` line
 */
export async function renderMarkdown(
  csvPath: string,
  outDir: string,
  chatName: string,
  _opts: { inline?: boolean } = {},
): Promise<string> {
  const messages = readCsv(csvPath);
  const media = buildMediaMap(outDir, messages);
  const inline = Boolean(_opts.inline);
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    const day = dayOf(m.timestamp_iso);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(m);
  }

  const sortedDays = [...groups.keys()].sort();

  const lines: string[] = [];
  lines.push(`# ${escapeMd(chatName)}`);
  lines.push('');
  for (const day of sortedDays) {
    lines.push(`## ${fullPtBrDate(day)}`);
    lines.push('');
    for (const m of groups.get(day)!) {
      if (m.type === 'system' || m.type === 'deleted' || m.type === 'omitted') {
        lines.push(`*${linkifyMarkdown(m.text, (u) => m.urlTitles?.[u] ?? deriveTitle(u))}*`);
      } else {
        const time = timeOf(m.timestamp_iso).slice(0, 5); // HH:mm
        const body = m.media
          ? await mediaMarkdown(m, media, inline, outDir)
          : linkifyMarkdown(m.text, (u) => m.urlTitles?.[u] ?? deriveTitle(u));
        lines.push(`**${escapeMd(m.author)}** · ${time} — ${body}`);
      }
      lines.push('');
    }
    lines.push('');
  }

  const outPath = path.join(outDir, 'messages.md');
  await fs.writeFile(outPath, lines.join('\n').replace(/\n+$/, '\n'), 'utf8');
  return outPath;
}
