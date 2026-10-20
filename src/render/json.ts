import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readCsv } from '../csv';
import { buildMediaMap } from '../media';
import type { MediaEntry } from '../media';
import type { Message } from '../parse/types';

export interface RenderedMessage {
  timestampIso: string;
  type: Message['type'];
  author: string;
  text: string;
  media: string;
  /** Relative path to the reconciled media file, or null when missing. */
  mediaPath: string | null;
  /** Per-URL fetched page titles (enrichment); `{}` when absent. */
  urlTitles: Record<string, string>;
  day: string;
  time: string;
}

export interface JsonEnvelope {
  metadata: {
    chatName: string;
    messageCount: number;
    dateRange: [string, string];
    exportSource: string;
  };
  messages: RenderedMessage[];
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function timeOf(iso: string): string {
  return iso.slice(11);
}

export function toRendered(
  m: Message,
  mediaPath: string | null = null,
): RenderedMessage {
  return {
    timestampIso: m.timestamp_iso,
    type: m.type,
    author: m.author,
    text: m.text,
    media: m.media,
    mediaPath,
    urlTitles: m.urlTitles ?? {},
    day: dayOf(m.timestamp_iso),
    time: timeOf(m.timestamp_iso),
  };
}

export function buildEnvelope(
  messages: Message[],
  chatName: string,
  mediaMap?: Map<string, MediaEntry>,
): JsonEnvelope {
  const rendered = messages.map((m) =>
    toRendered(m, mediaMap?.get(m.media)?.relPath ?? null),
  );
  const days = rendered.map((m) => m.day).filter(Boolean).sort();
  const dateRange: [string, string] =
    days.length > 0 ? [days[0], days[days.length - 1]] : ['', ''];
  return {
    metadata: {
      chatName,
      messageCount: rendered.length,
      dateRange,
      exportSource: 'whatsapp-export',
    },
    messages: rendered,
  };
}

export async function renderJson(
  csvPath: string,
  outDir: string,
  chatName: string,
  _opts: { inline?: boolean } = {},
): Promise<string> {
  const messages = readCsv(csvPath);
  const envelope = buildEnvelope(messages, chatName, buildMediaMap(outDir, messages));
  const outPath = path.join(outDir, 'messages.json');
  await fs.writeFile(outPath, JSON.stringify(envelope), 'utf8');
  return outPath;
}
