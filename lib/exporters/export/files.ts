import type { ViewerData } from '../viewer/format';
import type { ExportLang } from '../legacy/labels';
import { renderConversationHtml } from './html';
import { renderExportJson } from './json';
import { renderConversationMarkdown } from './markdown';
import { folderNames, numberedName } from './names';
import { renderPhotosHtml, renderPhotosMarkdown } from './photos';

/**
 * Lays out the ZIP of a non-viewer export (docs/formats/export-package.md): which text files exist,
 * where, and which media go next to them. Pure: viewer data in, `{ path, text }` and media entries
 * out. Every path is built from fixed words, positions and `slug`s, never from untrusted text.
 */

export type TextExportFormat = 'html' | 'json' | 'markdown';
export type ExportSplit = 'together' | 'perProfile';

/** One part of the export: the whole selection, or one profile's share of it. */
export interface ExportGroup {
  /** Display name of the profile, for the folder name (`perProfile` only). */
  name: string;
  data: ViewerData;
}

export interface ExportFile {
  path: string;
  text: string;
}

export interface ExportMediaEntry {
  /** Path inside the ZIP: `<folder>/media/<sha256>.<ext>` or `media/<sha256>.<ext>`. */
  path: string;
  sha256: string;
  size: number;
}

export interface ExportLayout {
  files: ExportFile[];
  media: ExportMediaEntry[];
}

export const JSON_FILE_NAME = 'memory-archive.json';

const EXTENSION: Record<TextExportFormat, string> = { html: 'html', json: 'json', markdown: 'md' };

export async function layoutExport(format: TextExportFormat, split: ExportSplit, groups: ExportGroup[], lang: ExportLang = 'en'): Promise<ExportLayout> {
  const folders = split === 'perProfile' ? folderNames(groups.map((g) => g.name)) : groups.map(() => '');
  const files: ExportFile[] = [];
  const media: ExportMediaEntry[] = [];
  for (const [i, group] of groups.entries()) {
    const prefix = folders[i] === '' ? '' : `${folders[i]}/`;
    if (format === 'json') {
      files.push({ path: `${prefix}${JSON_FILE_NAME}`, text: renderExportJson(group.data) });
    } else {
      const total = group.data.conversations.length;
      for (const [n, conversation] of group.data.conversations.entries()) {
        const path = `${prefix}${numberedName(n, total, conversation.title, 'chat')}.${EXTENSION[format]}`;
        const text =
          format === 'html' ? await renderConversationHtml(conversation, group.data, lang) : await renderConversationMarkdown(conversation, group.data, lang);
        files.push({ path, text });
      }
      // One photos page per profile that has assigned photos: `photos-<slug>.<ext>`. Conversation
      // names start with a digit, so the two sets cannot collide.
      const withPhotos = group.data.profiles.filter((p) => (p.photos?.length ?? 0) > 0);
      const slugs = folderNames(withPhotos.map((p) => p.displayName));
      for (const [n, profile] of withPhotos.entries()) {
        const photos = profile.photos ?? [];
        const path = `${prefix}photos-${slugs[n]}.${EXTENSION[format]}`;
        files.push({ path, text: format === 'html' ? renderPhotosHtml(profile, photos, lang) : renderPhotosMarkdown(profile, photos, lang) });
      }
    }
    for (const m of group.data.media) media.push({ path: `${prefix}${m.path}`, sha256: m.sha256, size: m.size });
  }
  return { files, media };
}
