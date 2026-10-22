import { describe, expect, test } from 'vitest';
import { loadPosition, savePosition } from './conversation-position';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('conversation position', () => {
  test('what was saved comes back for that conversation only', () => {
    const storage = memory();
    savePosition('a', { index: 40, within: 12.5 }, storage);
    expect(loadPosition('a', 100, storage)).toEqual({ index: 40, within: 12.5 });
    expect(loadPosition('b', 100, storage)).toBeUndefined();
  });

  test('a position past the end, negative, malformed or foreign is ignored', () => {
    const storage = memory();
    savePosition('a', { index: 400, within: 0 }, storage);
    expect(loadPosition('a', 100, storage)).toBeUndefined();
    storage.setItem('memory-archive:position:a', '{"index":-1,"within":0}');
    expect(loadPosition('a', 100, storage)).toBeUndefined();
    storage.setItem('memory-archive:position:a', 'not json');
    expect(loadPosition('a', 100, storage)).toBeUndefined();
    storage.setItem('memory-archive:position:a', '{"index":"3","within":0}');
    expect(loadPosition('a', 100, storage)).toBeUndefined();
  });

  test('unavailable storage is not an error', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => savePosition('a', { index: 1, within: 0 }, broken)).not.toThrow();
    expect(loadPosition('a', 10, broken)).toBeUndefined();
    expect(() => savePosition('a', undefined, broken)).not.toThrow();
  });
});
