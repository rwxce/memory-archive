import { afterEach, describe, expect, test } from 'vitest';
import { render, type Rendered } from './test-utils';
import { Highlighted, splitByRanges } from './search-highlight';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('splitByRanges', () => {
  test('marks the ranges and keeps the rest, in order', () => {
    expect(splitByRanges('one two three', [{ start: 4, end: 7 }, { start: 8, end: 13 }])).toEqual([
      { text: 'one ', match: false },
      { text: 'two', match: true },
      { text: ' ', match: false },
      { text: 'three', match: true },
    ]);
    expect(splitByRanges('plain', [])).toEqual([{ text: 'plain', match: false }]);
  });

  test('skips ranges that are overlapping, empty, backwards, fractional or past the end', () => {
    const parts = splitByRanges('abcdef', [{ start: 1, end: 3 }, { start: 2, end: 4 }, { start: 4, end: 4 }, { start: 5, end: 3 }, { start: 1.5, end: 2 }, { start: 4, end: 99 }, { start: 4, end: 5 }]);
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['bc', 'e']);
    expect(parts.map((p) => p.text).join('')).toBe('abcdef');
  });
});

describe('Highlighted', () => {
  test('puts matches in <mark> and never parses markup', async () => {
    const text = '<img src=x onerror="window.__pwned=1"> <b>canço</b>';
    const start = text.indexOf('canço');
    view = await render(<p><Highlighted text={text} ranges={[{ start, end: start + 5 }]} /></p>);
    const marks = view.container.querySelectorAll('mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['canço']);
    expect(view.container.querySelector('img, b')).toBeNull();
    expect(view.container.textContent).toBe(text);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
