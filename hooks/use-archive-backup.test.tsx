import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ArchiveBackup } from './use-archive-backup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn<() => Promise<void>>();
const replaceLibraryFromBackup = vi.fn();
const restoreArchiveFromZip = vi.fn();
const exportArchiveFromLibrary = vi.fn();

vi.mock('./use-library', () => ({
  useLibraryInternals: () => ({ state: { status: 'ready', deps: {} }, refresh }),
}));
vi.mock('./download-blob', () => ({ downloadBlob: vi.fn() }));
vi.mock('@/lib/usecases/archive-backup', async () => {
  const actual = await vi.importActual<typeof import('@/lib/usecases/archive-backup')>('@/lib/usecases/archive-backup');
  return {
    ...actual,
    replaceLibraryFromBackup: (...args: unknown[]) => replaceLibraryFromBackup(...args),
    restoreArchiveFromZip: (...args: unknown[]) => restoreArchiveFromZip(...args),
    exportArchiveFromLibrary: (...args: unknown[]) => exportArchiveFromLibrary(...args),
  };
});

const { useArchiveBackup } = await import('./use-archive-backup');

let current: ArchiveBackup;
let unmount: () => void;

function Probe() {
  current = useArchiveBackup();
  return null;
}

beforeEach(async () => {
  refresh.mockReset().mockResolvedValue();
  replaceLibraryFromBackup.mockReset().mockResolvedValue({ safetyBackupFileName: 'safety.zip' });
  restoreArchiveFromZip.mockReset().mockResolvedValue(undefined);
  exportArchiveFromLibrary.mockReset().mockResolvedValue({ blob: new Blob(['x']), fileName: 'b.mabackup', encrypted: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  unmount = () => act(() => root.unmount());
});

afterEach(() => unmount());

describe('useArchiveBackup', () => {
  test('a backup with a password is encrypted, the result says so, and the password is not kept in the state', async () => {
    await act(async () => current.backup({ password: 'a long phrase' }));
    expect(exportArchiveFromLibrary.mock.calls[0][1]).toMatchObject({ password: 'a long phrase' });
    expect(current.state).toEqual({ status: 'done', kind: 'backup', safetyBackupFileName: undefined, encrypted: true });
    expect(JSON.stringify(current.state)).not.toContain('a long phrase');
  });

  test('an empty password is forwarded as is, never turned into a plain backup', async () => {
    exportArchiveFromLibrary.mockResolvedValue({ blob: new Blob(['x']), fileName: 'b.zip', encrypted: false });
    await act(async () => current.backup({ password: '' }));
    expect(exportArchiveFromLibrary.mock.calls[0][1].password).toBe('');
  });

  test('a backup without a password is asked for as a plain one', async () => {
    exportArchiveFromLibrary.mockResolvedValue({ blob: new Blob(['x']), fileName: 'b.zip', encrypted: false });
    await act(async () => current.backup());
    expect(exportArchiveFromLibrary.mock.calls[0][1].password).toBeUndefined();
    expect(current.state).toMatchObject({ status: 'done', encrypted: false });
  });

  test('a wrong password on restore is a typed failure the screen can retry from', async () => {
    const { ArchiveError } = await import('@/lib/usecases/archive-backup');
    restoreArchiveFromZip.mockRejectedValueOnce(new ArchiveError('wrong-password', 'nope'));
    await act(async () => current.restore(new Blob(['x']), 'bad'));
    expect(current.state).toMatchObject({ status: 'failed', kind: 'restore', code: 'wrong-password' });
    await act(async () => current.restore(new Blob(['x']), 'good'));
    expect(restoreArchiveFromZip.mock.calls[1][2]).toMatchObject({ password: 'good' });
    expect(current.state).toMatchObject({ status: 'done', kind: 'restore' });
  });

  test('a replace that committed is a success even when reloading the screens throws', async () => {
    refresh.mockRejectedValue(new Error('reload failed'));
    await act(async () => current.replace(new Blob(['x'])));
    expect(current.state).toEqual({ status: 'done', kind: 'replace', safetyBackupFileName: 'safety.zip' });
  });

  test('a restore that committed is a success even when reloading the screens throws', async () => {
    refresh.mockRejectedValue(new Error('reload failed'));
    await act(async () => current.restore(new Blob(['x'])));
    expect(current.state).toMatchObject({ status: 'done', kind: 'restore' });
  });

  test('a call while another operation is working is ignored and does not overwrite its state', async () => {
    let finish!: (value: { safetyBackupFileName: string }) => void;
    replaceLibraryFromBackup.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    let first!: Promise<void>;
    await act(async () => {
      first = current.replace(new Blob(['a']));
    });
    expect(current.state).toMatchObject({ status: 'working', kind: 'replace' });

    await act(async () => {
      await current.replace(new Blob(['b']));
      await current.restore(new Blob(['c']));
    });
    expect(replaceLibraryFromBackup).toHaveBeenCalledTimes(1);
    expect(restoreArchiveFromZip).not.toHaveBeenCalled();
    expect(current.state).toMatchObject({ status: 'working', kind: 'replace' });

    await act(async () => {
      finish({ safetyBackupFileName: 'safety.zip' });
      await first;
    });
    expect(current.state).toMatchObject({ status: 'done', kind: 'replace' });
  });

  test('a new operation can start after the previous one failed', async () => {
    replaceLibraryFromBackup.mockRejectedValueOnce(new Error('boom'));
    await act(async () => current.replace(new Blob(['a'])));
    expect(current.state).toMatchObject({ status: 'failed', code: 'unknown' });
    await act(async () => current.replace(new Blob(['a'])));
    expect(current.state).toMatchObject({ status: 'done' });
  });
});
