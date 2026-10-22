import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, useRef } from 'react';
import { render } from '@/components/test-utils';

let callback: IntersectionObserverCallback | undefined;
const disconnect = vi.fn();
const constructed = vi.fn();
class FakeObserver {
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    callback = cb;
    constructed(options);
  }
  observe() {}
  disconnect = disconnect;
}

import { useNearViewport } from './use-near-viewport';

function Probe({ active }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref, active);
  return <div ref={ref} data-near={String(near)} />;
}

afterEach(() => {
  vi.unstubAllGlobals();
  callback = undefined;
  vi.clearAllMocks();
});

describe('useNearViewport', () => {
  test('follows the observer, with a margin, and disconnects on unmount', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const view = await render(<Probe />);
    const el = () => view.container.firstElementChild!;
    expect(el().getAttribute('data-near')).toBe('false');
    expect(constructed).toHaveBeenCalledWith({ rootMargin: '600px 0px' });
    await act(async () => callback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(el().getAttribute('data-near')).toBe('true');
    await act(async () => callback!([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(el().getAttribute('data-near')).toBe('false');
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  test('creates no observer when inactive, and treats everything as near without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const inactive = await render(<Probe active={false} />);
    expect(constructed).not.toHaveBeenCalled();
    expect(inactive.container.firstElementChild!.getAttribute('data-near')).toBe('false');
    inactive.unmount();
    vi.stubGlobal('IntersectionObserver', undefined);
    const bare = await render(<Probe />);
    expect(bare.container.firstElementChild!.getAttribute('data-near')).toBe('true');
    bare.unmount();
  });
});
