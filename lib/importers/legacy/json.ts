import { LEGACY_JSON_SCHEMA_VERSION } from '../../exporters/legacy/version';
import type { Message, MessageType } from '../whatsapp/types';
import { LegacyFormatError } from './types';
import type { LegacyArchive } from './types';

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  'text',
  'photo',
  'video',
  'sticker',
  'document',
  'audio',
  'system',
  'deleted',
  'omitted',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, index: number): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  throw new LegacyFormatError(`messages[${index}].${field} is not a string`);
}

function titles(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(v)) if (typeof t === 'string') out[k] = t;
  return out;
}

/**
 * Turn a parsed JSON envelope (`messages.json`, or the `chat-data` island of
 * `messages.html`) back into messages. Accepts schema 0 (no `schemaVersion`,
 * wa-backup) and 1; refuses newer schemas instead of guessing.
 */
export function legacyArchiveFromEnvelope(
  value: unknown,
  format: LegacyArchive['format'] = 'json',
): LegacyArchive {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new LegacyFormatError('not a messages.json envelope (no "messages" array)');
  }
  const schemaVersion = value.schemaVersion === undefined ? 0 : value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new LegacyFormatError('invalid schemaVersion');
  }
  if (schemaVersion > LEGACY_JSON_SCHEMA_VERSION) {
    throw new LegacyFormatError(
      `schemaVersion ${schemaVersion} is newer than this reader (${LEGACY_JSON_SCHEMA_VERSION}); update memory-archive`,
    );
  }

  const messages: Message[] = value.messages.map((raw, i) => {
    if (!isRecord(raw)) throw new LegacyFormatError(`messages[${i}] is not an object`);
    const timestamp = str(raw.timestampIso, 'timestampIso', i);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(timestamp)) {
      throw new LegacyFormatError(`messages[${i}].timestampIso is not a local ISO timestamp`);
    }
    const type = str(raw.type, 'type', i);
    if (!MESSAGE_TYPES.has(type)) throw new LegacyFormatError(`messages[${i}].type "${type}" is unknown`);
    return {
      timestamp_iso: timestamp,
      type: type as MessageType,
      author: str(raw.author, 'author', i),
      text: str(raw.text, 'text', i),
      media: str(raw.media, 'media', i),
      urlTitles: titles(raw.urlTitles),
    };
  });

  const meta = isRecord(value.metadata) ? value.metadata : {};
  const gen = isRecord(value.generator) ? value.generator : undefined;
  return {
    messages,
    chatName: typeof meta.chatName === 'string' && meta.chatName ? meta.chatName : undefined,
    schemaVersion,
    generator:
      gen && typeof gen.name === 'string' && typeof gen.version === 'string'
        ? { name: gen.name, version: gen.version }
        : undefined,
    format,
  };
}

/** Read `messages.json` text (a leading BOM is tolerated). */
export function readLegacyJson(text: string): LegacyArchive {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\ufeff/, ''));
  } catch (err) {
    throw new LegacyFormatError(`invalid JSON: ${(err as Error).message}`);
  }
  return legacyArchiveFromEnvelope(value, 'json');
}
