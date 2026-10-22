import type { Message } from '../../importers/whatsapp/types';
import { dayOf, timeOf } from './json';
import type { MediaEntry, RenderOptions } from './media';
import { linkifyMarkdown, deriveTitle, escapeMd } from './js/linkify.js';

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

/**
 * Link/image target for a media reference, or null when it is not safe.
 * Allowed: a `data:` URI built by the caller for `--inline`, or
 * a plain `media/<file>` path. Names are percent-encoded so a file name cannot
 * close the destination or start another construct.
 */
function mdTarget(src: string): string | null {
  if (/^data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i.test(src)) return src;
  const encode = (s: string) =>
    encodeURIComponent(s).replace(/[()!'*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (src.startsWith('media/')) {
    const name = src.slice('media/'.length);
    if (name && name !== '.' && name !== '..' && !/[\\/]/.test(name)) return 'media/' + encode(name);
  }
  return null;
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
  opts: RenderOptions,
): Promise<string> {
  const entry = media.get(m.media);
  if (!entry) {
    const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
    return `[${label}: ${escapeMd(m.media)}]`;
  }
  const isImg = m.type === 'photo' || m.type === 'sticker';
  const label = MEDIA_ICON[m.type] ?? `📎 ${m.type}`;
  const src = mdTarget(
    opts.inline && entry.inlineable && opts.loadDataUri
      ? await opts.loadDataUri(entry)
      : entry.relPath,
  );
  if (src === null) return `[${label}: ${escapeMd(m.media)}]`;
  if (isImg) {
    const img = `![${escapeMd(m.media)}](${src})`;
    const caption = m.text
      ? linkifyMarkdown(m.text, (u: string) => m.urlTitles?.[u] ?? deriveTitle(u))
      : '';
    return caption ? `${img} ${caption}` : img;
  }
  return `[${label}: ${escapeMd(m.media)}](${src})`;
}

/**
 * Render the chat as a day-sectioned Markdown log (D-45/D-46/D-47).
 * - `## <pt-BR full date>` per day
 * - `**Sender** · HH:mm — text` per message
 * - media -> embedded image `![FILENAME](media/FILENAME)` (photo/sticker) or
 *   a link for video/document; `inline` embeds as a `data:` URI
 * - system/deleted/omitted -> italic `*text*` line
 */
export async function renderMarkdown(
  messages: Message[],
  chatName: string,
  opts: RenderOptions = {},
): Promise<string> {
  const media = opts.media ?? new Map<string, MediaEntry>();
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
        lines.push(`*${linkifyMarkdown(m.text, (u: string) => m.urlTitles?.[u] ?? deriveTitle(u))}*`);
      } else {
        const time = timeOf(m.timestamp_iso).slice(0, 5); // HH:mm
        const body = m.media
          ? await mediaMarkdown(m, media, opts)
          : linkifyMarkdown(m.text, (u: string) => m.urlTitles?.[u] ?? deriveTitle(u));
        lines.push(`**${escapeMd(m.author)}** · ${time} — ${body}`);
      }
      lines.push('');
    }
    lines.push('');
  }

  // Not `.replace(/\n+$/, '\n')`: quadratic on a long run of newlines inside a message.
  const out = lines.join('\n');
  let end = out.length;
  while (end > 0 && out[end - 1] === '\n') end--;
  return end === out.length ? out : out.slice(0, end) + '\n';
}
