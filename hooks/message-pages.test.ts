import { describe, expect, test } from 'vitest';
import type { ConversationMessage } from '@/lib/domain/library';
import { PageCache, pagesFor, type Page } from './message-pages';

const msg = (id: number): ConversationMessage => ({
  id,
  sentAt: '2026-01-01T10:00:00',
  ordinal: 0,
  type: 'text',
  isSystem: false,
  participantName: 'Ana',
  isMe: true,
  body: `m${id}`,
  mediaSha256: null,
  mediaName: '',
  mediaMime: null,
});
const page = (index: number, size = 10): Page => ({
  index,
  messages: Array.from({ length: size }, (_, i) => msg(index * size + i)),
  before: index > 0 ? msg(index * size - 1) : null,
});

describe('pagesFor', () => {
  test('the pages of the rows first, then one neighbour on each side', () => {
    expect(pagesFor(250, 320, 10_000, 100)).toEqual([2, 3, 1, 4]);
    expect(pagesFor(0, 50, 10_000, 100)).toEqual([0, 1]);
  });
  test('clipped to the real pages; nothing for an empty list', () => {
    expect(pagesFor(950, 1000, 1000, 100)).toEqual([9, 8]);
    expect(pagesFor(0, 10, 5, 100)).toEqual([0]);
    expect(pagesFor(0, 10, 0, 100)).toEqual([]);
    expect(pagesFor(5, 5, 100, 100)).toEqual([]);
  });
});

describe('PageCache', () => {
  test('a position resolves to its message and the one before, across pages too', () => {
    const cache = new PageCache(5, 10);
    cache.set(page(0));
    cache.set(page(1));
    expect(cache.at(0)).toMatchObject({ message: { id: 0 }, previous: null });
    expect(cache.at(15)).toMatchObject({ message: { id: 15 }, previous: { id: 14 } });
    expect(cache.at(10)).toMatchObject({ message: { id: 10 }, previous: { id: 9 } });
    expect(cache.at(20)).toBeUndefined();
  });

  test('trim drops the pages farthest from the centre and never the ones to keep', () => {
    const cache = new PageCache(4, 10);
    for (let p = 0; p < 8; p++) cache.set(page(p));
    cache.trim(5, new Set([5, 6]));
    expect(cache.keys()).toEqual([4, 5, 6, 7]); // 0-3 are the farthest
    cache.set(page(0));
    cache.trim(5, new Set([0, 5, 6]));
    expect(cache.size).toBe(4);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(5) && cache.has(6)).toBe(true);
  });

  test('the cache can exceed max only by what must be kept', () => {
    const cache = new PageCache(2, 10);
    for (let p = 0; p < 5; p++) cache.set(page(p));
    cache.trim(0, new Set([0, 1, 2, 3]));
    expect(cache.keys()).toEqual([0, 1, 2, 3]);
  });
});
