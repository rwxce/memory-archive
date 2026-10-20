import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLegacyJson, readLegacyOutput } from '@/lib/importers/legacy';
import { isSafeFileName, normalizeMediaName, slugifyChatName } from '@/lib/importers/whatsapp';
import { mergeCsv } from './csv';
import { listMediaFiles } from './media';
import { renderOutputs } from './pipeline';

export interface LegacyOptions {
  /** Output root; the chat goes to `<out>/<slug>/`. Default: next to the file. */
  out?: string;
  /** Chat display name (default: from the file, a sibling messages.json, or the folder). */
  name?: string;
  me?: string;
  inline?: boolean;
}

export interface LegacyResult {
  dir: string;
  chatName: string;
  added: number;
  total: number;
}

/** `metadata.chatName` of `<dir>/messages.json`, if readable. */
function chatNameFromJson(dir: string): string | undefined {
  try {
    return readLegacyJson(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8')).chatName;
  } catch {
    return undefined;
  }
}

/** Copy the media the messages reference from `<from>/media` to `<to>/media`. */
function copyReferencedMedia(from: string, to: string, refs: string[]): void {
  const wanted = new Set(refs.filter(Boolean).map(normalizeMediaName));
  const files = listMediaFiles(from).filter(
    (f) => isSafeFileName(f.name) && wanted.has(normalizeMediaName(f.name)),
  );
  if (files.length === 0) return;
  fs.mkdirSync(path.join(to, 'media'), { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(from, 'media', f.name), path.join(to, 'media', f.name));
  }
}

/**
 * `memory-archive import-legacy <file>`: read an old output (messages.json,
 * messages.html or messages.csv), merge it into the canonical messages.csv and
 * re-render every output. Idempotent: importing the same file twice adds 0.
 */
export async function importLegacy(file: string, opts: LegacyOptions = {}): Promise<LegacyResult> {
  const text = fs.readFileSync(file, 'utf8');
  const archive = readLegacyOutput(path.basename(file), text);
  const srcDir = path.dirname(path.resolve(file));
  const chatName =
    opts.name ?? archive.chatName ?? chatNameFromJson(srcDir) ?? path.basename(srcDir);
  const dir = opts.out ? path.join(opts.out, slugifyChatName(chatName) || 'chat') : srcDir;
  fs.mkdirSync(dir, { recursive: true });
  if (path.resolve(dir) !== srcDir) {
    copyReferencedMedia(srcDir, dir, archive.messages.map((m) => m.media));
  }
  const added = await mergeCsv(path.join(dir, 'messages.csv'), archive.messages);
  await renderOutputs(dir, chatName, { inline: opts.inline, me: opts.me });
  return { dir, chatName, added, total: archive.messages.length };
}

/** `memory-archive render <dir>`: re-render all outputs from `<dir>/messages.csv`. */
export async function renderDir(
  dir: string,
  opts: Pick<LegacyOptions, 'name' | 'me' | 'inline'> = {},
): Promise<{ chatName: string }> {
  if (!fs.existsSync(path.join(dir, 'messages.csv'))) {
    throw new Error(`no messages.csv in ${dir}`);
  }
  const chatName =
    opts.name ?? chatNameFromJson(dir) ?? path.basename(path.resolve(dir));
  await renderOutputs(dir, chatName, { inline: opts.inline, me: opts.me });
  return { chatName };
}
