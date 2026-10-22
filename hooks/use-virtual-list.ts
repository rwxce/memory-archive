'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { flushSync } from 'react-dom';
import { HeightIndex } from './height-index';

/** Where the list opens. */
export type ListStart = { kind: 'end' } | { kind: 'start' } | { kind: 'index'; index: number; within?: number };

export interface VirtualItem {
  index: number;
  /** Top edge in px from the top of the list. */
  top: number;
}

export interface VirtualList {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onScroll(event: UIEvent<HTMLElement>): void;
  /** Height of the whole list, as far as it is known. */
  totalHeight: number;
  /** The rows to put in the DOM now: those in view plus a margin. Empty until the first layout. */
  items: VirtualItem[];
  range: { start: number; end: number };
  /** Stable ref for a row element carrying `data-index`; the row is measured while it is mounted. */
  rowRef(element: HTMLElement | null): void | (() => void);
  scrollToIndex(index: number, within?: number): void;
  scrollToStart(): void;
  scrollToEnd(): void;
  /** The row at the top of the view and how far into it the view starts. */
  position(): { index: number; within: number } | undefined;
}

/** How close to the end counts as "at the end" (px): below this the list keeps following new heights. */
const PIN_SLACK = 4;

export interface VirtualListOptions {
  count: number;
  /** Height assumed for a row until it is measured. */
  estimate?: number;
  /** Extra px rendered above and below the view. */
  overscan?: number;
  start: ListStart;
}

/**
 * Windowing for a list of `count` rows whose heights are only known once they are on screen.
 *
 * - Rows are absolutely placed inside one tall spacer; only the rows near the view are mounted.
 * - Row heights are measured with a ResizeObserver (text wrapping, an image arriving) into a
 *   `HeightIndex`; positions come from the measured heights, else the estimate.
 * - Anchoring: when a measurement changes the heights above the row at the top of the view,
 *   `scrollTop` is corrected in the same frame so what the person is reading does not move.
 *   While the view is at the end it keeps following the end instead.
 * - Native scroll anchoring is off (`overflow-anchor: none` on the scroller) so the two do not fight.
 *
 * Use with a `key` per conversation: the index is rebuilt only when `count` changes.
 */
export function useVirtualList({ count, estimate = 64, overscan = 640, start }: VirtualListOptions): VirtualList {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const index = useMemo(() => new HeightIndex(count, estimate), [count, estimate]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const startRef = useRef(start);
  const pinned = useRef(false);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [, setTick] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const idx = indexRef.current;
    const next = idx.rangeFor(el.scrollTop, el.clientHeight, overscan);
    pinned.current = idx.total() - el.scrollTop - el.clientHeight <= PIN_SLACK;
    setRange((prev) => (prev && prev.start === next.start && prev.end === next.end ? prev : next));
  }, [overscan]);

  const measure = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const el = scrollerRef.current;
      if (!el) return;
      const idx = indexRef.current;
      // The row at the top of the view, and how far into it: what must stay where it is.
      const anchor = idx.indexAt(el.scrollTop);
      const within = el.scrollTop - idx.offsetOf(anchor);
      let moved = false;
      let resized = false;
      for (const entry of entries) {
        if (entry.target === el) {
          resized = true;
          continue;
        }
        const row = entry.target as HTMLElement;
        if (idx.measure(Number(row.dataset.index), row.getBoundingClientRect().height) !== 0) moved = true;
      }
      if (moved) flushSync(() => setTick((t) => t + 1));
      if (moved || resized) {
        if (pinned.current) el.scrollTop = Math.max(0, idx.total() - el.clientHeight);
        else if (moved) el.scrollTop = idx.offsetOf(anchor) + within;
        update();
      }
    },
    [update],
  );

  const getObserver = useCallback(() => {
    if (!observer.current && typeof ResizeObserver !== 'undefined') observer.current = new ResizeObserver(measure);
    return observer.current;
  }, [measure]);

  // One stable ref for every row: it observes on mount and the returned cleanup stops on unmount.
  const rowRef = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      getObserver()?.observe(element);
      return () => observer.current?.unobserve(element);
    },
    [getObserver],
  );

  useEffect(() => {
    const el = scrollerRef.current;
    const ro = getObserver();
    if (el && ro) {
      ro.observe(el);
      for (const row of el.querySelectorAll('[data-index]')) ro.observe(row);
    }
    return () => {
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [getObserver]);

  // First layout: put the view where it opens, then compute the rows (before the first paint).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const opening = startRef.current;
    let top = 0;
    if (opening.kind === 'end') top = Math.max(0, index.total() - el.clientHeight);
    else if (opening.kind === 'index') top = index.offsetOf(Math.min(Math.max(0, opening.index), Math.max(0, count - 1))) + (opening.within ?? 0);
    el.scrollTop = top;
    update();
  }, [index, count, update]);

  const scrollToIndex = useCallback(
    (target: number, within = 0) => {
      const el = scrollerRef.current;
      if (!el) return;
      const idx = indexRef.current;
      // Instant, never animated: a jump across thousands of rows must not play, and it respects reduced motion.
      el.scrollTop = idx.offsetOf(Math.min(Math.max(0, target), Math.max(0, idx.count - 1))) + within;
      update();
    },
    [update],
  );
  const scrollToStart = useCallback(() => scrollToIndex(0), [scrollToIndex]);
  const scrollToEnd = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, indexRef.current.total() - el.clientHeight);
    update();
  }, [update]);

  const position = useCallback(() => {
    const el = scrollerRef.current;
    const idx = indexRef.current;
    if (!el || idx.count === 0) return undefined;
    const top = idx.indexAt(el.scrollTop);
    return { index: top, within: Math.max(0, el.scrollTop - idx.offsetOf(top)) };
  }, []);

  const shown = range ?? { start: 0, end: 0 };
  const items: VirtualItem[] = [];
  for (let i = shown.start; i < shown.end; i++) items.push({ index: i, top: index.offsetOf(i) });

  return {
    scrollerRef,
    onScroll: update,
    totalHeight: index.total(),
    items,
    range: shown,
    rowRef,
    scrollToIndex,
    scrollToStart,
    scrollToEnd,
    position,
  };
}
