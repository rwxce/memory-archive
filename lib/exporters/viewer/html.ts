import { type ViewerData, serializeViewerData } from './format';

/**
 * Puts viewer data into the viewer template (built from `viewer/` by `scripts/build-viewer.mjs`).
 * Pure: strings in, string out. The data goes into the `<script type="application/json">` island
 * through `serializeViewerData`, which cannot produce `</script>` or `<!--`.
 */

export const VIEWER_DATA_PLACEHOLDER = '__VIEWER_DATA__';
export const VIEWER_DATA_ISLAND = `<script type="application/json" id="viewer-data">${VIEWER_DATA_PLACEHOLDER}</script>`;

export function renderViewerHtml(template: string, data: ViewerData | string): string {
  const at = template.indexOf(VIEWER_DATA_ISLAND);
  if (at < 0) throw new Error('viewer template has no data island');
  const json = typeof data === 'string' ? data : serializeViewerData(data);
  if (/<\/script|<!--/i.test(json)) throw new Error('viewer data is not safe to inline');
  // Spliced, not String.replace: the data may contain `$&` and similar patterns.
  return (
    template.slice(0, at) +
    `<script type="application/json" id="viewer-data">${json}</script>` +
    template.slice(at + VIEWER_DATA_ISLAND.length)
  );
}
