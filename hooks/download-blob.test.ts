import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { downloadBlob } from './download-blob';

beforeEach(() => {
  vi.useFakeTimers();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.useRealTimers());

test('clicks one temporary anchor with the file name, removes it, and revokes the URL later', () => {
  const names: (string | null)[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.getAttribute('download'));
    expect(this.getAttribute('href')).toBe('blob:x');
  });
  downloadBlob(new Blob(['a']), 'report <final>.pdf');
  expect(click).toHaveBeenCalledTimes(1);
  expect(names).toEqual(['report <final>.pdf']);
  expect(document.querySelector('a[download]')).toBeNull();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  click.mockRestore();
});
