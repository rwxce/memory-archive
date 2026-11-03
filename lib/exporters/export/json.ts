import type { ViewerData } from '../viewer/format';

/**
 * The JSON export is the viewer-data envelope (docs/formats/viewer-data.md) as a plain file, so one
 * parser (`parseViewerData`) reads both. Indented for people; key order is fixed by the builder.
 */
export function renderExportJson(data: ViewerData): string {
  return JSON.stringify(data, null, 2) + '\n';
}
