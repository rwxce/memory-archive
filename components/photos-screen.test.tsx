import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import es from '@/messages/es.json';
import { photoFailureOf } from '@/hooks/use-photo-import';
import { DbError } from '@/lib/db/errors';
import { ArchiveError } from '@/lib/exporters/archive/format';
import { TakeoutError } from '@/lib/importers/takeout/paths';
import type { PhotoBatch } from '@/lib/domain/photo';
import { safeName } from './safe-name';
import { click, render, settle, type, type Rendered } from './test-utils';
import { PhotosScreen } from './photos-screen';

const detect = vi.fn();
const takeout = vi.fn();
const zip = vi.fn();
const loose = vi.fn();
const undo = vi.fn();
const list = vi.fn();

// Stable references, as the real provider's: a new `deps` or `register` each render would reload forever.
const ready = { status: 'ready', deps: {} };
const retry = vi.fn();
const register = () => () => undefined;
const refresh = async () => undefined;
vi.mock('@/hooks/use-library', () => ({
  useLibrary: () => ({ state: ready, retry }),
  useLibraryInternals: () => ({ state: ready, register, refresh }),
}));
vi.mock('@/lib/usecases/photo-source', () => ({ detectPhotoSource: (...a: unknown[]) => detect(...a) }));
vi.mock('@/lib/usecases/photo-import', () => ({
  importLoosePhotos: (...a: unknown[]) => loose(...a),
  importGooglePhotosZip: (...a: unknown[]) => zip(...a),
}));
vi.mock('@/lib/usecases/photo-library', () => ({
  importTakeoutAlbum: (...a: unknown[]) => takeout(...a),
  undoPhotoImport: (...a: unknown[]) => undo(...a),
  listPhotoBatches: (...a: unknown[]) => list(...a),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/photos',
}));

const p = en.photos;
const summary = (patch: Record<string, number> = {}) => ({
  added: 0, alreadyThere: 0, duplicatesInFile: 0, mediaAdded: 0, withoutDate: 0, ignoredFiles: 0, unusableSidecars: 0, tooLarge: 0, dateGuessed: 0, unreadableFiles: 0, ...patch,
});
const batch = (patch: Partial<PhotoBatch> = {}): PhotoBatch => ({ id: 'b1', source: 'takeout', sourceLabel: 'Viatge.zip', createdAt: '2026-03-01T10:00:00Z', addedCount: 12, skippedCount: 0, ...patch });

let view: Rendered | undefined;
const file = (name: string, size = 10, lastModified = 1) => new File([new Uint8Array(size)], name, { lastModified });
const text = () => view!.container.textContent!;
const q = (id: string) => view!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string | RegExp) =>
  [...view!.container.querySelectorAll<HTMLElement>('button')].find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));

async function choose(id: string, files: File[]) {
  const input = q(id) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function open(messages: Record<string, unknown> = en) {
  view = await render(<PhotosScreen />, messages);
  await settle();
}

beforeEach(() => {
  for (const m of [detect, takeout, zip, loose, undo, list]) m.mockReset();
  list.mockResolvedValue([]);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('Photos screen: the notes and the empty state', () => {
  test('the two plain notes are always on screen, with the empty list', async () => {
    await open();
    expect(text()).toContain(p.notes.unassigned);
    expect(text()).toContain(p.notes.estimate);
    expect(text()).toContain(p.batches.empty);
  });
});

describe('Photos screen: a picked ZIP is routed by its content', () => {
  test('a Takeout album goes to the Takeout importer and the result lists what happened', async () => {
    detect.mockResolvedValue({ kind: 'takeout-album' });
    takeout.mockResolvedValue({ batchId: 'x', summary: summary({ added: 3, alreadyThere: 1, ignoredFiles: 2, tooLarge: 1 }) });
    await open();
    await choose('photos-zip-input', [file('album.zip')]);
    expect(takeout).toHaveBeenCalledTimes(1);
    expect(takeout.mock.calls[0][1]).toMatchObject({ fileName: 'album.zip' });
    const result = q('photos-result')!.textContent!;
    expect(result).toContain('3 photos and videos added to the collection.');
    expect(result).toContain('1 was already in the collection and was not added again.');
    expect(result).toContain('2 files were not photos or videos and were skipped.');
    expect(result).toContain('1 file was too large and was skipped.');
    expect(list).toHaveBeenCalledTimes(2); // opened, then read again after adding
  });

  test('a Google Photos download goes to its importer; a Takeout-shaped one says so; estimates are counted', async () => {
    detect.mockResolvedValue({ kind: 'google-photos-zip' });
    zip.mockResolvedValue({ batchId: 'x', delegatedToTakeout: true, summary: summary({ added: 1, dateGuessed: 2 }) });
    await open();
    await choose('photos-zip-input', [file('photos.zip')]);
    expect(zip).toHaveBeenCalledTimes(1);
    expect(text()).toContain(p.result.delegated);
    expect(text()).toContain('2 dates are estimates, taken from the file.');
  });

  test.each([
    ['whatsapp-chat', '/import', 'is a WhatsApp chat'],
    ['backup', '/backup', 'is a backup of this app'],
    ['changes-pack', '/sync', 'is a file of changes'],
  ])('%s points to its own screen and adds nothing', async (kind, href, words) => {
    detect.mockResolvedValue({ kind });
    await open();
    await choose('photos-zip-input', [file('x.zip')]);
    expect(text()).toContain(words);
    expect(q('photos-result')!.querySelector('a')!.getAttribute('href')).toBe(href);
    expect(takeout).not.toHaveBeenCalled();
    expect(zip).not.toHaveBeenCalled();
    expect(loose).not.toHaveBeenCalled();
  });

  test('anything else is a calm message, not an import', async () => {
    detect.mockResolvedValue({ kind: 'unsupported' });
    await open();
    await choose('photos-zip-input', [file('notes.zip')]);
    expect(q('photos-result')!.textContent).toContain(p.error.invalid);
    expect(zip).not.toHaveBeenCalled();
  });

  test('a lone picture handed to the ZIP picker joins the loose choice', async () => {
    detect.mockResolvedValue({ kind: 'media' });
    await open();
    await choose('photos-zip-input', [file('one.jpg')]);
    expect(q('photos-chosen')!.textContent).toBe('1 file chosen');
    expect(loose).not.toHaveBeenCalled();
  });

  test('a ZIP over the limits says so', async () => {
    detect.mockRejectedValue(new TakeoutError('limit-exceeded', 'big'));
    await open();
    await choose('photos-zip-input', [file('big.zip')]);
    expect(q('photos-result')!.textContent).toContain(p.error.limit);
  });
});

describe('Photos screen: loose files', () => {
  test('files wait in a visible choice that can be dropped; adding passes the files and the album name', async () => {
    loose.mockResolvedValue({ batchId: 'x', summary: summary({ added: 2, unreadableFiles: 1 }) });
    await open();
    await choose('photos-loose-input', [file('a.jpg'), file('b.jpg', 20)]);
    expect(q('photos-chosen')!.textContent).toBe('2 files chosen');
    // The same file again is not counted twice.
    await choose('photos-loose-input', [file('a.jpg')]);
    expect(q('photos-chosen')!.textContent).toBe('2 files chosen');

    await click(button(p.loose.remove));
    expect(q('photos-chosen')).toBeNull();
    expect(loose).not.toHaveBeenCalled();

    await choose('photos-loose-input', [file('a.jpg'), file('b.jpg', 20)]);
    await type(view!.container.querySelector('#photos-album'), 'Summer');
    await click(button(p.loose.add));
    await settle();
    expect(loose).toHaveBeenCalledTimes(1);
    expect(loose.mock.calls[0][1].files).toHaveLength(2);
    expect(loose.mock.calls[0][1].label).toBe('Summer');
    expect(q('photos-result')!.textContent).toContain('1 file could not be read and was skipped.');
    expect(q('photos-chosen')).toBeNull(); // spent
  });

  test('the album name is cut by code points, never in the middle of an emoji', async () => {
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await type(view!.container.querySelector('#photos-album'), '😀'.repeat(250));
    const value = (view!.container.querySelector('#photos-album') as HTMLInputElement).value;
    expect(Array.from(value)).toHaveLength(200);
    expect(value.endsWith('😀')).toBe(true);
  });

  test('a second click while it runs adds nothing twice', async () => {
    let finish!: (v: unknown) => void;
    loose.mockReturnValue(new Promise((r) => (finish = r)));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    const add = button(p.loose.add)!;
    await click(add);
    await click(add);
    expect(loose).toHaveBeenCalledTimes(1);
    expect(button(p.loose.add)?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => finish({ batchId: 'x', summary: summary({ added: 1 }) }));
    await settle();
    expect(q('photos-result')!.textContent).toContain('1 photo or video added');
  });

  test('Stop aborts, nothing is added and the choice stays for another try', async () => {
    loose.mockImplementation((_deps, input: { signal: AbortSignal }) => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason))));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    expect(button(p.stop)).toBeDefined();
    await click(button(p.stop));
    await settle();
    expect(q('photos-result')!.textContent).toBe(p.stopped);
    expect(q('photos-chosen')!.textContent).toBe('1 file chosen');
  });

  test('Stop is not offered once the save has begun', async () => {
    loose.mockImplementation(
      (_deps, input: { onProgress: (p: unknown) => void }) =>
        new Promise(() => {
          input.onProgress({ phase: 'saving', done: 0, total: 1 });
        }),
    );
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    expect(button(p.stop)?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Photos screen: errors are calm and typed', () => {
  test.each([
    [new TakeoutError('invalid-takeout', 'private text'), 'invalid'],
    [new TakeoutError('unsafe-path', 'private text'), 'invalid'],
    [new TakeoutError('unreadable-files', 'private text'), 'unreadable'],
    [new TakeoutError('limit-exceeded', 'private text'), 'limit'],
    [new ArchiveError('busy', 'private text'), 'busy'],
    [new ArchiveError('storage', 'private text'), 'storage'],
    [new DbError('newer-schema', 'private text'), 'newer'],
    [new DbError('closed', 'private text'), 'closed'],
    [new DbError('unavailable', 'private text'), 'closed'],
    [new DbError('constraint', 'private text'), 'generic'],
    [new Error('private text'), 'generic'],
  ])('%s maps to %s', (error, key) => {
    expect(photoFailureOf(error)).toBe(key);
  });

  test('the failure shows the calm message and never the raw one', async () => {
    loose.mockRejectedValue(new TakeoutError('unreadable-files', 'secret /home/ana/file.jpg'));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    expect(q('photos-result')!.textContent).toContain(p.error.unreadable);
    expect(text()).not.toContain('secret');
    expect(q('photos-chosen')!.textContent).toBe('1 file chosen'); // can try again
  });

  test('every message exists in all three languages', () => {
    for (const messages of [en, ca, es]) {
      for (const key of ['title', 'titleUnsure', 'titleWrong', 'invalid', 'unreadable', 'limit', 'busy', 'closed', 'newer', 'storage', 'generic']) {
        expect((messages.photos.error as Record<string, string>)[key]).toBeTruthy();
      }
    }
  });
});

describe('Photos screen: earlier imports and undo', () => {
  test('lists imports with a name, source, when and count, and the confirmation names it and says what stays', async () => {
    list.mockResolvedValue([batch(), batch({ id: 'b2', source: 'loose', sourceLabel: '', addedCount: 1 })]);
    await open();
    const rows = view!.container.querySelectorAll('[data-testid="photos-batch"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Viatge.zip');
    expect(rows[0].textContent).toContain('12 photos and videos added');
    expect(rows[1].textContent).toContain('From this device');

    await click(button(/Undo import/)); // first row
    expect(undo).not.toHaveBeenCalled();
    const ask = rows[0].textContent!;
    expect(ask).toContain('Take back Viatge.zip?');
    expect(ask).toContain('The 12 photos and videos it added will be removed from the collection.');
    expect(ask).toContain('used somewhere else, such as in a chat or a profile photo, stay there');
    expect(ask).not.toMatch(/forever|permanent/i);
  });

  test('Keep leaves everything as it was; confirming undoes once, reads the list again and says how many were removed', async () => {
    list.mockResolvedValueOnce([batch()]).mockResolvedValue([]);
    undo.mockResolvedValue({ found: true, removedItems: 12, removedMedia: 12 });
    await open();
    await click(button(/Undo import/));
    await click(button(p.batches.confirmKeep));
    expect(undo).not.toHaveBeenCalled();
    expect(button(/Undo import/)).toBeDefined();

    await click(button(/Undo import/));
    const yes = button(p.batches.confirmYes)!;
    await click(yes);
    await click(yes);
    await settle();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo.mock.calls[0][1]).toBe('b1');
    expect(q('photos-undo-result')!.textContent).toBe('12 photos and videos were removed from the collection.');
    expect(q('photos-batches')).toBeNull();
  });

  test('an import that was already taken back says so; a failure is calm', async () => {
    list.mockResolvedValue([batch()]);
    undo.mockResolvedValueOnce({ found: false, removedItems: 0, removedMedia: 0 });
    await open();
    await click(button(/Undo import/));
    await click(button(p.batches.confirmYes));
    await settle();
    expect(q('photos-undo-result')!.textContent).toBe(p.batches.undoneNone);

    undo.mockRejectedValueOnce(new Error('private'));
    await click(button(/Undo import/));
    await click(button(p.batches.confirmYes));
    await settle();
    expect(q('photos-undo-result')!.textContent).toBe(p.batches.undoFailed);
  });

  test('names are text, never markup, and long ones are cut in the sentence', async () => {
    const hostile = '<img src=x onerror=alert(1)>' + 'a'.repeat(300);
    list.mockResolvedValue([batch({ sourceLabel: hostile })]);
    await open();
    expect(view!.container.querySelector('img')).toBeNull();
    expect(q('photos-batch-name')!.textContent).toBe(`${hostile.slice(0, 200)}…`);
    await click(button(/Undo import/));
    const title = view!.container.querySelector('[role="group"] p')!.textContent!;
    expect(title).toContain('<img src=x onerror=alert(1)>');
    expect(title.length).toBeLessThan(130);
    expect(view!.container.querySelector('img')).toBeNull();
  });
});

const idleSave = (input: { onProgress: (p: unknown) => void }) => input.onProgress({ phase: 'saving', done: 0, total: 1 });
const RLO = '\u202e';

describe('Photos screen: an abort is only reported as a stop when nothing was saved', () => {
  test('Stop before the save is a stop, and the list is read again', async () => {
    loose.mockImplementation((_d, input: { signal: AbortSignal }) => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason))));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await click(button(p.stop));
    await settle();
    expect(q('photos-result')!.textContent).toBe(p.stopped);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test('an abort followed by a database failure after the save began is not "nothing was added"', async () => {
    loose.mockImplementation(
      (_d, input: { signal: AbortSignal; onProgress: (p: unknown) => void }) =>
        new Promise((_, reject) => {
          input.signal.addEventListener('abort', () => {
            idleSave(input);
            setTimeout(() => reject(new DbError('closed', 'private')), 0);
          });
        }),
    );
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await click(button(p.stop));
    await settle();
    const result = q('photos-result')!.textContent!;
    expect(result).toContain(p.error.titleUnsure);
    expect(result).toContain(p.error.closed);
    expect(result).not.toContain(p.stopped);
    expect(result).not.toContain(p.error.title);
    expect(list).toHaveBeenCalledTimes(2); // the list is read again so the person can see what is there
  });

  test('an unrelated error after a Stop is a failure, not a stop', async () => {
    loose.mockImplementation((_d, input: { signal: AbortSignal }) => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('private')))));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await click(button(p.stop));
    await settle();
    expect(q('photos-result')!.textContent).toContain(p.error.titleWrong);
  });

  test('storage and generic failures do not claim that nothing was added', async () => {
    loose.mockRejectedValue(new ArchiveError('storage', 'private'));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    const result = q('photos-result')!.textContent!;
    expect(result).toContain(p.error.titleWrong);
    expect(result).not.toContain(p.error.title);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('Photos screen: failures from the browser', () => {
  test.each([
    ['NotReadableError', 'unreadable'],
    ['NotFoundError', 'unreadable'],
    ['QuotaExceededError', 'storage'],
    ['SecurityError', 'generic'],
  ])('a DOMException %s maps to %s', (name, key) => {
    expect(photoFailureOf(new DOMException('private', name))).toBe(key);
  });
  test('a plain object with that name is also understood, and null is generic', () => {
    expect(photoFailureOf({ name: 'NotReadableError' })).toBe('unreadable');
    expect(photoFailureOf(null)).toBe('generic');
  });
});

describe('Photos screen: undo and imports do not overlap', () => {
  test('the undo confirmation cannot be confirmed while an import runs', async () => {
    list.mockResolvedValue([batch()]);
    loose.mockReturnValue(new Promise(() => undefined));
    await open();
    await click(button(/Undo import/));
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    const yes = button(p.batches.confirmYes)!;
    expect(yes.getAttribute('aria-disabled')).toBe('true');
    await click(yes);
    expect(undo).not.toHaveBeenCalled();
  });

  test('the last undo result is cleared when an import begins', async () => {
    list.mockResolvedValueOnce([batch()]).mockResolvedValue([]);
    undo.mockResolvedValue({ found: true, removedItems: 12, removedMedia: 12 });
    loose.mockReturnValue(new Promise(() => undefined));
    await open();
    await click(button(/Undo import/));
    await click(button(p.batches.confirmYes));
    await settle();
    expect(q('photos-undo-result')).not.toBeNull();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    expect(q('photos-undo-result')).toBeNull();
  });
});

describe('Photos screen: the loose choice belongs to the loose run', () => {
  test('an unrelated ZIP import that finishes does not clear the loose choice', async () => {
    detect.mockResolvedValue({ kind: 'takeout-album' });
    takeout.mockResolvedValue({ batchId: 'x', summary: summary({ added: 1 }) });
    loose.mockRejectedValue(new Error('private'));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add)); // fails: the choice stays
    await settle();
    expect(q('photos-chosen')!.textContent).toBe('1 file chosen');
    await choose('photos-zip-input', [file('album.zip')]);
    expect(q('photos-result')!.textContent).toContain('1 photo or video added');
    expect(q('photos-chosen')!.textContent).toBe('1 file chosen');
  });

  test('a finished loose run spends the choice', async () => {
    loose.mockResolvedValue({ batchId: 'x', summary: summary({ added: 1 }) });
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    expect(q('photos-chosen')).toBeNull();
  });
});

describe('Photos screen: focus and announcements', () => {
  test.each([
    ['done', async () => { loose.mockResolvedValue({ batchId: 'x', summary: summary({ added: 1 }) }); }],
    ['failed', async () => { loose.mockRejectedValue(new TakeoutError('limit-exceeded', 'x')); }],
  ])('after a result (%s) focus moves to it', async (_name, arrange) => {
    await arrange();
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    expect(document.activeElement).toBe(q('photos-result'));
  });

  test('done, stopped and elsewhere outcomes are polite status regions', async () => {
    loose.mockResolvedValue({ batchId: 'x', summary: summary({ added: 1 }) });
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await settle();
    expect(q('photos-result')!.getAttribute('role')).toBe('status');

    detect.mockResolvedValue({ kind: 'backup' });
    await choose('photos-zip-input', [file('b.zip')]);
    expect(q('photos-result')!.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(q('photos-result'));
  });

  test('Keep returns focus to that row\'s Undo button', async () => {
    list.mockResolvedValue([batch()]);
    await open();
    await click(button(/Undo import/));
    await click(button(p.batches.confirmKeep));
    expect(document.activeElement).toBe(button(/Undo import/));
  });

  test('Remove choice returns focus to the picker button', async () => {
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.remove));
    expect(document.activeElement).toBe(button(p.loose.pick));
  });
});

describe('Photos screen: untrusted names', () => {
  test('safeName strips direction and invisible characters and clamps by code points', () => {
    expect(safeName(`a${RLO}b\u2066c\u2069d\u200be\u0007f\ufeffg`)).toBe('abcdefg');
    const long = safeName('x'.repeat(300));
    expect(Array.from(long)).toHaveLength(81);
    expect(long.endsWith('…')).toBe(true);
    expect(safeName('😀'.repeat(100), 10)).toBe('😀'.repeat(10) + '…');
    expect(safeName(`${RLO}\u200b`)).toBe('');
  });

  test('a hostile file name is isolated, stripped and cut in the sentences that show it', async () => {
    detect.mockResolvedValue({ kind: 'backup' });
    await open();
    await choose('photos-zip-input', [file(`${RLO}gpj.${'z'.repeat(300)}.zip`)]);
    const result = q('photos-result')!;
    expect(result.textContent).not.toContain(RLO);
    expect(result.querySelector('bdi')).not.toBeNull();
    expect(result.textContent!.length).toBeLessThan(200);
    expect(result.querySelector('p')!.className).toContain('break-words');
  });

  test('the "looking at" line cuts and isolates the name too', async () => {
    let finish!: (v: unknown) => void;
    detect.mockReturnValue(new Promise((r) => (finish = r)));
    await open();
    await choose('photos-zip-input', [file(`${RLO}${'q'.repeat(300)}.zip`)]);
    const note = q('photos-status')!;
    expect(note.textContent).not.toContain(RLO);
    expect(note.querySelector('bdi')).not.toBeNull();
    expect(note.textContent!.length).toBeLessThan(150);
    await act(async () => finish({ kind: 'unsupported' }));
  });

  test('a batch label with direction controls is shown without them, inside bdi, in the row and the confirmation', async () => {
    list.mockResolvedValue([batch({ sourceLabel: `${RLO}fdp.${'k'.repeat(300)}` })]);
    await open();
    expect(q('photos-batch-name')!.textContent).not.toContain(RLO);
    expect(q('photos-batch-name')!.querySelector('bdi')).not.toBeNull();
    expect(button(/Undo import/)!.getAttribute('aria-label')).not.toContain(RLO);
    await click(button(/Undo import/));
    const title = view!.container.querySelector('[role="group"] p')!;
    expect(title.textContent).not.toContain(RLO);
    expect(title.querySelector('bdi')).not.toBeNull();
  });
});

describe('Photos screen: a pick while busy is not silent', () => {
  test('choosing a ZIP during an import says so and starts nothing', async () => {
    loose.mockReturnValue(new Promise(() => undefined));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    await choose('photos-zip-input', [file('late.zip')]);
    expect(q('photos-refused')!.textContent).toBe(p.busyNow);
    expect(detect).not.toHaveBeenCalled();
  });

  test('the inputs are disabled while an import runs', async () => {
    loose.mockReturnValue(new Promise(() => undefined));
    await open();
    await choose('photos-loose-input', [file('a.jpg')]);
    await click(button(p.loose.add));
    expect((q('photos-zip-input') as HTMLInputElement).disabled).toBe(true);
    expect((q('photos-loose-input') as HTMLInputElement).disabled).toBe(true);
  });
});
