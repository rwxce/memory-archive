import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { ArchiveError, DbError, ViewerPackageError } from '@/lib/usecases/viewer-package';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';
import { useLibrary } from '@/hooks/use-library';
import { ViewerExportCard } from './viewer-export-card';

/** The backup screen opens the library before it shows the card; do the same here. */
function Screen() {
  useLibrary();
  return <ViewerExportCard />;
}

const download = vi.fn();
const exportViewerPackage = vi.fn();
vi.mock('@/hooks/download-blob', () => ({ downloadBlob: (...args: unknown[]) => download(...args) }));
// The use case is replaced at the boundary; the error classes stay the real ones.
vi.mock('@/lib/usecases/viewer-package', async (original) => ({
  ...(await original<typeof import('@/lib/usecases/viewer-package')>()),
  exportViewerPackage: (...args: unknown[]) => exportViewerPackage(...args),
  fetchViewerTemplate: () => async () => '<html></html>',
}));

const t = en.backup.viewer;
const ANA = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const LUIS = '4f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';

async function seeded() {
  const lib = await createTestLibrary();
  for (const [id, name] of [[ANA, 'Ana'], [LUIS, 'Luis']]) {
    lib.opened.db.run("INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [id, name]);
  }
  return lib;
}

const submit = (v: Rendered) => [...v.container.querySelectorAll('button')].find((b) => b.textContent === t.submit)!;
const boxes = (v: Rendered) => [...v.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const result = (v: Rendered) => v.container.querySelector<HTMLElement>('[data-testid="viewer-export-result"]');

let view: Rendered | undefined;
beforeEach(() => {
  download.mockClear();
  exportViewerPackage.mockReset();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('ViewerExportCard', () => {
  test('explains the copy and selects everyone and the media by default', async () => {
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    const text = view.container.textContent!;
    expect(text).toContain(t.howTo);
    expect(text).toContain(t.phoneNote);
    expect(text).toContain(t.notBackup);
    expect(boxes(view).map((b) => b.checked)).toEqual([true, true, true]);
  });

  test('sends the selection to the use case and hands the file to the browser', async () => {
    exportViewerPackage.mockImplementation(async (_deps, options) => {
      options.onProgress?.({ phase: 'media', done: 1, total: 2 });
      return { blob: new Blob(['zip']), fileName: 'memory-archive-viewer-2026-11-03.zip', mediaCount: 2, missingMedia: 1 };
    });
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    await act(async () => {
      const [, luis] = boxes(view!);
      luis!.click();
    });
    const [from] = view.container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(from, '2026-02-01');
      from!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(submit(view));
    await settle();
    expect(exportViewerPackage.mock.calls[0]![1].selection).toEqual({ profileIds: [expect.any(String)], from: '2026-02-01', to: null, includeMedia: true });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'memory-archive-viewer-2026-11-03.zip');
    const done = result(view)!;
    expect(done.textContent).toContain('memory-archive-viewer-2026-11-03.zip');
    expect(done.textContent).toContain('2 photos, videos and audio files included.');
    expect(done.textContent).toContain('1 file could not be found');
  });

  test('needs at least one person: the button does nothing and the reason is shown', async () => {
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    await act(async () => {
      for (const box of boxes(view!).slice(0, 2)) box.click();
    });
    expect(view.container.textContent).toContain(t.noPeopleSelected);
    await click(submit(view));
    expect(exportViewerPackage).not.toHaveBeenCalled();
  });

  test.each([
    [new ArchiveError('blob-missing', 'x'), t.error.missingMedia],
    [new ArchiveError('limit-exceeded', 'x'), t.error.limit],
    [new DbError('invalid', 'x'), t.error.dates],
    [new ViewerPackageError('template-missing', 'x'), t.error.template],
    [new Error('boom'), t.error.generic],
  ])('a failure is explained and nothing is downloaded (%#)', async (error, message) => {
    exportViewerPackage.mockRejectedValue(error);
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    await click(submit(view));
    await settle();
    expect(result(view)!.textContent).toBe(message);
    expect(download).not.toHaveBeenCalled();
  });
});
