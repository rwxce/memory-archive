import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useVirtualList, type ListStart, type VirtualList } from './use-virtual-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT = 500;
let heights = new Map<number, number>();
let observers: FakeObserver[] = [];

/** A ResizeObserver whose notifications the test sends by hand, with row heights the test chooses. */
class FakeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  notifyRows() {
    this.callback([...this.targets].filter((el) => (el as HTMLElement).dataset.index !== undefined).map((target) => ({ target })));
  }
}

let latest: VirtualList;
function Harness({ count, start }: { count: number; start: ListStart }) {
  const list = useVirtualList({ count, estimate: 50, overscan: 200, start });
  latest = list;
  return (
    <div ref={list.scrollerRef} onScroll={list.onScroll} data-testid="scroller">
      <div style={{ height: list.totalHeight, position: 'relative' }}>
        {list.items.map(({ index, top }) => (
          <div key={index} data-index={index} ref={list.rowRef} style={{ transform: `translateY(${top}px)` }}>
            row {index}
          </div>
        ))}
      </div>
    </div>
  );
}

let root: Root;
let container: HTMLElement;
const scroller = () => container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
const indexes = () => [...container.querySelectorAll<HTMLElement>('[data-index]')].map((el) => Number(el.dataset.index));
const mount = async (count: number, start: ListStart) => {
  await act(async () => root.render(<Harness count={count} start={start} />));
};

beforeEach(() => {
  heights = new Map();
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return this.dataset.testid === 'scroller' ? VIEWPORT : 0; } });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return { height: heights.get(Number(this.dataset.index)) ?? 50 } as DOMRect;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useVirtualList', () => {
  test('opens at the end, the start, or a row, with only the rows near the view mounted', async () => {
    await mount(10_000, { kind: 'end' });
    expect(scroller().scrollTop).toBe(10_000 * 50 - VIEWPORT);
    expect(Math.max(...indexes())).toBe(9_999);
    expect(indexes().length).toBeLessThan(30);
    act(() => root.unmount());
    root = createRoot(container);
    await mount(10_000, { kind: 'index', index: 4_000, within: 20 });
    expect(scroller().scrollTop).toBe(4_000 * 50 + 20);
    expect(indexes()).toContain(4_000);
    expect(Math.min(...indexes())).toBeGreaterThan(3_900);
  });

  test('an empty list renders nothing and does not throw', async () => {
    await mount(0, { kind: 'end' });
    expect(indexes()).toEqual([]);
    expect(latest.position()).toBeUndefined();
  });

  test('scrolling changes the rows in the DOM, not their number', async () => {
    await mount(10_000, { kind: 'start' });
    const first = indexes().length;
    await act(async () => {
      scroller().scrollTop = 250_000;
      scroller().dispatchEvent(new Event('scroll'));
    });
    expect(indexes()).toContain(5_000);
    expect(indexes()).not.toContain(0);
    expect(Math.abs(indexes().length - first)).toBeLessThanOrEqual(6); // the start has no rows above to keep
  });

  test('anchoring: rows above the view turning out taller do not move what is being read', async () => {
    await mount(1_000, { kind: 'index', index: 500 });
    const before = latest.position()!;
    expect(before).toEqual({ index: 500, within: 0 });
    // the rows above the view that are mounted (496-499: 200 px of margin) are measured at 130 px instead of 50
    for (let i = 496; i < 500; i++) heights.set(i, 130);
    await act(async () => observers.forEach((o) => o.notifyRows()));
    // 4 rows x 80 px more above the anchor: the view moved down by exactly that
    expect(scroller().scrollTop).toBe(500 * 50 + 4 * 80);
    expect(latest.position()).toEqual({ index: 500, within: 0 });
  });

  test('anchoring keeps the offset inside the row at the top of the view', async () => {
    await mount(1_000, { kind: 'index', index: 500, within: 30 });
    heights.set(497, 90);
    await act(async () => observers.forEach((o) => o.notifyRows()));
    expect(latest.position()).toEqual({ index: 500, within: 30 });
    expect(scroller().scrollTop).toBe(500 * 50 + 40 + 30);
  });

  test('a row below the view growing does not move the view', async () => {
    await mount(1_000, { kind: 'index', index: 500 });
    heights.set(505, 300);
    await act(async () => observers.forEach((o) => o.notifyRows()));
    expect(scroller().scrollTop).toBe(500 * 50);
  });

  test('at the end the view follows the end as the last rows are measured', async () => {
    await mount(1_000, { kind: 'end' });
    const mounted = indexes();
    for (const i of mounted) heights.set(i, 120);
    await act(async () => observers.forEach((o) => o.notifyRows()));
    const total = (1_000 - mounted.length) * 50 + mounted.length * 120;
    expect(latest.totalHeight).toBe(total);
    expect(scroller().scrollTop).toBe(total - VIEWPORT);
  });

  test('rows are observed while mounted and released when they leave', async () => {
    await mount(10_000, { kind: 'start' });
    const watched = () => observers.at(-1)!.targets.size;
    expect(watched()).toBe(indexes().length + 1); // the rows and the scroller
    await act(async () => {
      scroller().scrollTop = 250_000;
      scroller().dispatchEvent(new Event('scroll'));
    });
    expect(watched()).toBe(indexes().length + 1);
  });

  test('jump helpers go to the start, the end and a row', async () => {
    await mount(1_000, { kind: 'end' });
    await act(async () => latest.scrollToStart());
    expect(scroller().scrollTop).toBe(0);
    await act(async () => latest.scrollToIndex(300, 5));
    expect(scroller().scrollTop).toBe(300 * 50 + 5);
    await act(async () => latest.scrollToIndex(99_999));
    expect(scroller().scrollTop).toBe(999 * 50);
    await act(async () => latest.scrollToEnd());
    expect(scroller().scrollTop).toBe(1_000 * 50 - VIEWPORT);
  });
});
