import { layoutExport, type ExportGroup, type ExportSplit, type TextExportFormat } from '../exporters/export/files';
import { writeExportZip } from '../exporters/export/write';
import type { ExportLang } from '../exporters/legacy/labels';
import type { BlobStore } from '../storage/blob-store';
import type { LibraryDeps } from './profiles';
import { buildViewerExport, type ViewerSelection } from './viewer-export';
import {
  ViewerPackageError,
  exportViewerPackage,
  type ViewerPackageProgress,
  type ViewerPackageResult,
} from './viewer-package';

export { ArchiveError } from '../exporters/archive/format';
export { DbError } from '../db/errors';
export { EXPORT_LANGS, type ExportLang } from '../exporters/legacy/labels';
export type { ExportSplit } from '../exporters/export/files';
export type { ViewerSelection } from './viewer-export';
export { ViewerPackageError, fetchViewerTemplate } from './viewer-package';
export type { ViewerPackageProgress as ExportProgress, ViewerPackageResult as ExportPackageResult } from './viewer-package';

/**
 * The export screen's one entry point (docs/formats/export-package.md). `viewer` is the standalone
 * viewer package (`exportViewerPackage`, unchanged); `html`, `json` and `markdown` are a ZIP of
 * those files, with `media/` next to them when `selection.includeMedia` is set. Read-only on the
 * library.
 *
 * Rejects like `exportViewerPackage`: `ViewerPackageError` (`no-profiles`, `template-missing`,
 * `nothing-to-export`), `DbError` (`invalid` dates, `not-found` profile) or `ArchiveError`
 * (`blob-missing`, `integrity`, `limit-exceeded`, `storage`).
 */

export const EXPORT_FORMATS = ['viewer', 'html', 'json', 'markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportPackageOptions {
  format: ExportFormat;
  selection: ViewerSelection;
  /**
   * `together` (default): one set of files for the whole selection. `perProfile`: one folder per
   * selected profile, each with its own `media/`. Ignored by `viewer`, which is one page.
   */
  split?: ExportSplit;
  /** Language of the headings and toolbar in `html` / `markdown` files (default `en`). Ignored by `json` and `viewer`. */
  lang?: ExportLang;
  /** Required by `viewer` only (see `fetchViewerTemplate`). */
  loadTemplate?(): Promise<string>;
  onProgress?(progress: ViewerPackageProgress): void;
}

export function exportPackageFileName(format: ExportFormat, date: Date): string {
  return `memory-archive-${format}-${date.toISOString().slice(0, 10)}.zip`;
}

export async function exportPackage(
  deps: LibraryDeps & { blobStore: BlobStore },
  options: ExportPackageOptions,
): Promise<ViewerPackageResult> {
  const { format, selection } = options;
  if (format === 'viewer') {
    if (!options.loadTemplate) throw new ViewerPackageError('template-missing', 'the viewer template loader is missing');
    return exportViewerPackage(deps, { selection, loadTemplate: options.loadTemplate, onProgress: options.onProgress });
  }
  if (selection.profileIds.length === 0) throw new ViewerPackageError('no-profiles', 'select at least one profile');
  options.onProgress?.({ phase: 'reading' });

  const ids = [...new Set(selection.profileIds)];
  const split = options.split ?? 'together';
  const groups: ExportGroup[] = [];
  let missingMedia = 0;
  if (split === 'perProfile') {
    for (const id of ids) {
      const built = await buildViewerExport(deps, { ...selection, profileIds: [id] });
      missingMedia += built.missingMedia;
      groups.push({ name: built.data.profiles[0]?.displayName ?? '', data: built.data });
    }
    groups.sort((a, b) => a.name.localeCompare(b.name) || (a.data.profiles[0].id < b.data.profiles[0].id ? -1 : 1));
  } else {
    const built = await buildViewerExport(deps, selection);
    missingMedia = built.missingMedia;
    groups.push({ name: '', data: built.data });
  }

  const layout = await layoutExport(format as TextExportFormat, split, groups, options.lang ?? 'en');
  if (layout.files.length === 0) throw new ViewerPackageError('nothing-to-export', 'the selection has no messages');
  const now = (deps.now ?? (() => new Date()))();
  const blob = await writeExportZip({
    createdAt: groups[0].data.createdAt,
    files: layout.files,
    media: layout.media,
    readBlob: (sha256) => deps.blobStore.open(sha256),
    onProgress: (done, total) => options.onProgress?.({ phase: 'media', done, total }),
  });
  options.onProgress?.({ phase: 'finishing' });
  return { blob, fileName: exportPackageFileName(format, now), mediaCount: layout.media.length, missingMedia };
}
