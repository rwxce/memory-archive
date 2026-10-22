import { legacyArchiveFromEnvelope } from './json';
import { LegacyFormatError } from './types';
import type { LegacyArchive } from './types';

/**
 * The JSON island: `<script type="application/json" id="chat-data">…</script>`.
 * Attribute order, quoting, case and whitespace may vary. Script content is
 * raw text (no entity decoding); writers escape `</` as `<\/`, which is valid
 * JSON, so the first `</script` really ends the island.
 */
const ISLAND_RE =
  /<script\b(?=[^>]*\bid\s*=\s*(["']?)chat-data\1(?=[\s>/]))[^>]*>([\s\S]*?)<\/script\s*>/i;

/** Extract the `chat-data` JSON text from a generated `messages.html`. */
export function extractChatDataJson(html: string): string {
  const m = ISLAND_RE.exec(html);
  if (!m) throw new LegacyFormatError('no <script id="chat-data"> JSON island found in the HTML');
  return m[2].trim();
}

/** Read `messages.html`: parse the embedded envelope back into messages. */
export function readLegacyHtml(html: string): LegacyArchive {
  const json = extractChatDataJson(html.replace(/^\ufeff/, ''));
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new LegacyFormatError(`chat-data island is not valid JSON: ${(err as Error).message}`);
  }
  return legacyArchiveFromEnvelope(value, 'html');
}
