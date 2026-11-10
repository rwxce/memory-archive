import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { ArchiveError, DbError, ViewerPackageError } from '@/lib/usecases/export-package';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';
import { useLibrary } from '@/hooks/use-library';
import { ViewerExportCard } from './viewer-export-card';

/** The backup screen opens the library before it shows the card; do the same here. */
function Screen() {
  useLibrary();
  return <ViewerExportCard />;
}

let search = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));

const download = vi.fn();
const exportPackage = vi.fn();
vi.mock('@/hooks/download-blob', () => ({ downloadBlob: (...args: unknown[]) => download(...args) }));
// The use case is replaced at the boundary; the error classes stay the real ones.
vi.mock('@/lib/usecases/export-package', async (original) => ({
  ...(await original<typeof import('@/lib/usecases/export-package')>()),
  exportPackage: (...args: unknown[]) => exportPackage(...args),
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
const radios = (v: Rendered) => [...v.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const result = (v: Rendered) => v.container.querySelector<HTMLElement>('[data-testid="viewer-export-result"]');

let view: Rendered | undefined;
beforeEach(() => {
  search = '';
  download.mockClear();
  exportPackage.mockReset();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const people = (v: Rendered) => boxes(v).slice(0, 2).map((b) => b.checked);
const toggleAll = (v: Rendered) => v.container.querySelector<HTMLButtonElement>('[data-testid="viewer-export-select-all"]')!;

describe('ViewerExportCard', () => {
  test('explains the copy and selects everyone and the media by default', async () => {
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    const text = view.container.textContent!;
    expect(text).toContain(t.formats.viewer.help);
    expect(text).toContain(t.phoneNote);
    expect(text).toContain(t.notBackup);
    expect(boxes(view).map((b) => b.checked)).toEqual([true, true, true]);
    expect(radios(view).map((r) => r.checked)).toEqual([true, false, false, false]);
  });

  test('sends the selection to the use case and hands the file to the browser', async () => {
    exportPackage.mockImplementation(async (_deps, options) => {
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
    expect(exportPackage.mock.calls[0]![1]).toMatchObject({ format: 'viewer', split: 'together', lang: 'en' });
    expect(exportPackage.mock.calls[0]![1].selection).toEqual({ profileIds: [expect.any(String)], from: '2026-02-01', to: null, includeMedia: true });
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
    expect(exportPackage).not.toHaveBeenCalled();
  });

  test.each([
    [new ArchiveError('blob-missing', 'x'), t.error.missingMedia],
    [new ArchiveError('limit-exceeded', 'x'), t.error.limit],
    [new DbError('invalid', 'x'), t.error.dates],
    [new ViewerPackageError('template-missing', 'x'), t.error.template],
    [new ViewerPackageError('nothing-to-export', 'x'), t.error.nothing],
    [new Error('boom'), t.error.generic],
  ])('a failure is explained and nothing is downloaded (%#)', async (error, message) => {
    exportPackage.mockRejectedValue(error);
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    await click(submit(view));
    await settle();
    expect(result(view)!.textContent).toBe(message);
    expect(download).not.toHaveBeenCalled();
  });

  test('another format is passed through, and the split choice appears only when it applies', async () => {
    exportPackage.mockResolvedValue({ blob: new Blob(['zip']), fileName: 'memory-archive-html-2026-11-03.zip', mediaCount: 0, missingMedia: 0 });
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    expect(view.container.textContent).not.toContain(t.splitLegend);
    await act(async () => radios(view!)[1]!.click());
    expect(view.container.textContent).toContain(t.splitLegend);
    await act(async () => radios(view!)[5]!.click());
    await click(submit(view));
    await settle();
    expect(exportPackage.mock.calls[0]![1]).toMatchObject({ format: 'html', split: 'perProfile', lang: 'en' });
    expect(exportPackage.mock.calls[0]![1].selection.profileIds).toHaveLength(2);
  });

  test('no split choice with one person selected, and the split is then sent as together', async () => {
    exportPackage.mockResolvedValue({ blob: new Blob(['zip']), fileName: 'f.zip', mediaCount: 0, missingMedia: 0 });
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    await act(async () => radios(view!)[2]!.click());
    await act(async () => radios(view!)[5]!.click());
    await act(async () => boxes(view!)[1]!.click());
    expect(view.container.textContent).not.toContain(t.splitLegend);
    await click(submit(view));
    await settle();
    expect(exportPackage.mock.calls[0]![1]).toMatchObject({ format: 'json', split: 'together' });
  });
  test('?person= starts with only that person ticked, and the choice stays editable', async () => {
    search = `person=${LUIS}`;
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    expect(boxes(view).slice(0, 2).map((b) => b.parentElement!.textContent)).toEqual(['Ana', 'Luis']);
    expect(people(view)).toEqual([false, true]);
    await act(async () => {
      boxes(view!)[0]!.click();
    });
    expect(people(view)).toEqual([true, true]);
  });

  test('an unknown ?person= is ignored and everyone stays ticked', async () => {
    search = 'person=not-a-profile';
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    expect(people(view)).toEqual([true, true]);
  });

  test('one button flips between selecting everyone and no one', async () => {
    search = `person=${ANA}`;
    view = await renderWithLibrary(<Screen />, { lib: await seeded() });
    await settle();
    expect(toggleAll(view).textContent).toBe(t.selectAll);
    await click(toggleAll(view));
    expect(people(view)).toEqual([true, true]);
    expect(toggleAll(view).textContent).toBe(t.selectNone);
    await click(toggleAll(view));
    expect(people(view)).toEqual([false, false]);
    expect(view.container.textContent).toContain(t.noPeopleSelected);
    expect(toggleAll(view).textContent).toBe(t.selectAll);
  });
});
