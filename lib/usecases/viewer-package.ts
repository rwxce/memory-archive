import { writeViewerPackage } from '../exporters/viewer/write';
import type { BlobStore } from '../storage/blob-store';
import type { LibraryDeps } from './profiles';
import { buildViewerExport, type ViewerSelection } from './viewer-export';

export { ArchiveError } from '../exporters/archive/format';
export { DbError } from '../db/errors';
export type { ViewerSelection } from './viewer-export';

/**
 * The viewer download: reads the library (`buildViewerExport`), fills the viewer template and zips
 * `viewer.html`, `README.txt` and `media/` (docs/formats/viewer-data.md). Read-only on the library.
 *
 * Rejects with `ViewerPackageError` (`no-profiles`, `template-missing`, `nothing-to-export`), `DbError` (`invalid` dates,
 * `not-found` profile) or `ArchiveError` (`blob-missing` / `integrity` while streaming media,
 * `limit-exceeded`, `storage`).
 */

export type ViewerPackageErrorCode = 'no-profiles' | 'template-missing' | 'nothing-to-export';

export class ViewerPackageError extends Error {
  readonly code: ViewerPackageErrorCode;
  constructor(code: ViewerPackageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ViewerPackageError';
    this.code = code;
  }
}

export type ViewerPackageProgress =
  | { phase: 'reading' }
  | { phase: 'media'; done: number; total: number }
  | { phase: 'finishing' };

export interface ViewerPackageOptions {
  selection: ViewerSelection;
  /** Returns the viewer template HTML; rejects or returns '' when it is not available. */
  loadTemplate(): Promise<string>;
  onProgress?(progress: ViewerPackageProgress): void;
}

export interface ViewerPackageResult {
  blob: Blob;
  fileName: string;
  /** Media files in the package. */
  mediaCount: number;
  /** Files the messages refer to that the blob store lacks (left out, not an error). */
  missingMedia: number;
}

export const VIEWER_TEMPLATE_PATH = 'viewer/viewer-template.html';

/**
 * Browser loader for `loadTemplate`: the app's own static asset, same origin. `basePath` is the
 * app's `NEXT_PUBLIC_BASE_PATH` ('' or '/sub'); the service worker serves it offline.
 */
export function fetchViewerTemplate(basePath = '', fetcher: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    try {
      const response = await fetcher(`${basePath}/${VIEWER_TEMPLATE_PATH}`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return await response.text();
    } catch (error) {
      throw new ViewerPackageError('template-missing', 'the viewer template could not be loaded', { cause: error });
    }
  };
}

export function viewerPackageFileName(date: Date): string {
  return `memory-archive-viewer-${date.toISOString().slice(0, 10)}.zip`;
}

export async function exportViewerPackage(
  deps: LibraryDeps & { blobStore: BlobStore },
  options: ViewerPackageOptions,
): Promise<ViewerPackageResult> {
  if (options.selection.profileIds.length === 0) throw new ViewerPackageError('no-profiles', 'select at least one profile');
  options.onProgress?.({ phase: 'reading' });
  let template: string;
  try {
    template = await options.loadTemplate();
  } catch (error) {
    if (error instanceof ViewerPackageError) throw error;
    throw new ViewerPackageError('template-missing', 'the viewer template could not be loaded', { cause: error });
  }
  if (!template) throw new ViewerPackageError('template-missing', 'the viewer template is empty');

  const built = await buildViewerExport(deps, options.selection);
  const blob = await writeViewerPackage({
    data: built.data,
    template,
    readBlob: (sha256) => deps.blobStore.open(sha256),
    onProgress: (done, total) => options.onProgress?.({ phase: 'media', done, total }),
  });
  options.onProgress?.({ phase: 'finishing' });
  const now = (deps.now ?? (() => new Date()))();
  return { blob, fileName: viewerPackageFileName(now), mediaCount: built.media.length, missingMedia: built.missingMedia };
}
