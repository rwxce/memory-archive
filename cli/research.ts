import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pc from 'picocolors';
import { createFingerprinter, normalizeAuthor } from '@/lib/domain/fingerprint';
import { parseFindings } from '@/lib/domain/highlights';
import type { FindingsError } from '@/lib/domain/highlights';
import { parseWhatsAppZip } from '@/lib/importers/whatsapp';
import { CLI_CHAT_ZIP_LIMITS, openZip } from './zip';

/** A findings file is a few KB; refuse to read anything absurd before parsing it. */
export const MAX_FINDINGS_BYTES = 5 * 1024 * 1024;

export const RESEARCH_PRIVACY_WARNING =
  'PRIVACY: the file written below contains your chat messages in plain text. If you give it to an LLM ' +
  '(Claude, Codex, ...), that content leaves this device and is processed by a third party. Only do this ' +
  'with chats you are willing to share, never commit the file, and delete it when you are done.';

/** One line of the research JSONL. */
export interface ResearchRow {
  fingerprint: string;
  /** Local wall-clock time `YYYY-MM-DDTHH:MM:SS`, as exported. */
  ts: string;
  /** Normalized author; '' for system messages. */
  author: string;
  text: string;
}

export interface ResearchExport {
  file: string;
  metaFile: string;
  messageCount: number;
}

/**
 * Write `<out>/<chat-slug>.jsonl` (one `ResearchRow` per message, transcript order) and
 * `<out>/<chat-slug>.meta.json` (the `conversation` block of a findings file). Fingerprints
 * are computed exactly as the app's import does (`createMessageDrafter` in
 * `lib/usecases/import.ts`), so findings built from this file match messages in the PWA.
 */
export async function exportForResearch(zipPath: string, out = path.join('output', 'research')): Promise<ResearchExport> {
  const zip = await openZip(zipPath);
  const { info, messages } = await parseWhatsAppZip(zip, path.basename(zipPath), { limits: CLI_CHAT_ZIP_LIMITS });
  const next = createFingerprinter();
  const rows: ResearchRow[] = messages.map((m) => {
    const author = m.type === 'system' ? '' : normalizeAuthor(m.author);
    return {
      fingerprint: next({ sentAt: m.timestamp_iso, author, type: m.type, text: m.text, mediaName: m.media }),
      ts: m.timestamp_iso,
      author,
      text: m.text,
    };
  });
  await fs.mkdir(out, { recursive: true });
  const file = path.join(out, `${info.slug}.jsonl`);
  const metaFile = path.join(out, `${info.slug}.meta.json`);
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  const conversation = {
    name: info.name,
    messageCount: rows.length,
    ...(rows[0] ? { firstFingerprint: rows[0].fingerprint } : {}),
  };
  await fs.writeFile(metaFile, JSON.stringify(conversation, null, 2) + '\n', 'utf8');
  return { file, metaFile, messageCount: rows.length };
}

export interface FindingsCheck {
  ok: boolean;
  highlights: number;
  errors: FindingsError[];
}

/** Validate a findings file on disk with the domain validator. Never prints file content. */
export async function checkFindings(file: string): Promise<FindingsCheck> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_FINDINGS_BYTES) {
    return { ok: false, highlights: 0, errors: [{ code: 'too-long', path: '', message: 'File is larger than 5 MB.' }] };
  }
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { ok: false, highlights: 0, errors: [{ code: 'not-object', path: '', message: 'Not valid JSON.' }] };
  }
  const r = parseFindings(json);
  return r.ok
    ? { ok: true, highlights: r.value.highlights.length, errors: [] }
    : { ok: false, highlights: 0, errors: r.errors };
}

export function printResearchWarning(): void {
  console.error(pc.yellow('⚠ ' + RESEARCH_PRIVACY_WARNING));
}
