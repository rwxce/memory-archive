import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { isSearchable, SEARCH_DEBOUNCE_MS, useSearchInput } from './use-search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('isSearchable', () => {
  test('needs two letters or digits; punctuation and operators do not count', () => {
    expect(isSearchable('')).toBe(false);
    expect(isSearchable('a')).toBe(false);
    expect(isSearchable('  a  ')).toBe(false);
    expect(isSearchable('"-*')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
    expect(isSearchable('l’')).toBe(false);
    expect(isSearchable('çó')).toBe(true);
    expect(isSearchable('1 2')).toBe(true);
  });
});

describe('useSearchInput', () => {
  afterEach(() => vi.useRealTimers());

  function harness(initial: string) {
    const out: { current?: ReturnType<typeof useSearchInput> } = {};
    function Probe() {
      out.current = useSearchInput(initial);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    return { out: out as { current: ReturnType<typeof useSearchInput> }, unmount: () => act(() => root.unmount()) };
  }

  test('the query follows the field after a pause, trimmed; each keystroke restarts the pause', () => {
    vi.useFakeTimers();
    const { out, unmount } = harness('  start ');
    expect(out.current.query).toBe('start');
    act(() => out.current.setInput('ca'));
    act(() => void vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
    act(() => out.current.setInput(' canço '));
    act(() => void vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
    expect(out.current.query).toBe('start');
    act(() => void vi.advanceTimersByTime(60));
    expect(out.current.query).toBe('canço');
    unmount();
  });

  test('commit moves the query at once', () => {
    vi.useFakeTimers();
    const { out, unmount } = harness('');
    act(() => out.current.setInput('lluna '));
    act(() => out.current.commit());
    expect(out.current.query).toBe('lluna');
    unmount();
  });
});
