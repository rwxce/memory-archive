import type { Message } from '../../importers/whatsapp/types';
import type { MediaEntry } from './media';
import { GENERATOR_NAME, GENERATOR_VERSION, LEGACY_JSON_SCHEMA_VERSION } from './version';

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

export interface JsonGenerator {
  name: string;
  version: string;
}

/** Schema: docs/formats/legacy-json.md. */
export interface JsonEnvelope {
  /** Envelope version (absent = 0, old wa-backup outputs). */
  schemaVersion: typeof LEGACY_JSON_SCHEMA_VERSION;
  /** Tool that wrote the file. */
  generator: JsonGenerator;
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
    schemaVersion: LEGACY_JSON_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    metadata: {
      chatName,
      messageCount: rendered.length,
      dateRange,
      exportSource: 'whatsapp-export',
    },
    messages: rendered,
  };
}

/** `messages.json` content. */
export function renderJson(
  messages: Message[],
  chatName: string,
  media?: Map<string, MediaEntry>,
): string {
  return JSON.stringify(buildEnvelope(messages, chatName, media));
}
