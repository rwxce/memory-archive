import { act, StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DbError } from '@/lib/db/errors';
import type { Library } from '@/lib/usecases/library';
import { click, render, settle, type Rendered } from '@/components/test-utils';
import { LibraryProvider, useLibrary } from './use-library';

function Probe() {
  const { state, retry } = useLibrary();
  return (
    <div>
      <p data-testid="state">{state.status === 'unavailable' ? `unavailable:${state.problem}` : state.status}</p>
      <button onClick={retry}>retry</button>
    </div>
  );
}

const library = (): Library => ({
  deps: { client: { call: vi.fn() } } as unknown as Library['deps'],
  cleanup: Promise.resolve(),
  importWorkerUrl: '/db/import-worker.js',
  connectPort: vi.fn(),
  isBusy: () => false,
  close: vi.fn(),
});
const stateOf = (view: Rendered) => view.container.querySelector('[data-testid="state"]')?.textContent;

describe('LibraryProvider', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('is loading until the library opens, then ready', async () => {
    let finish: (l: Library) => void = () => {};
    const open = vi.fn(() => new Promise<Library>((resolve) => (finish = resolve)));
    view = await render(
      <LibraryProvider open={open}>
        <Probe />
      </LibraryProvider>,
    );
    expect(stateOf(view)).toBe('loading');
    finish(library());
    await settle();
    expect(stateOf(view)).toBe('ready');
    expect(open).toHaveBeenCalledOnce();
  });

  test('does not open the library until a screen asks for it', async () => {
    const open = vi.fn(async () => library());
    view = await render(
      <LibraryProvider open={open}>
        <p>settings</p>
      </LibraryProvider>,
    );
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  test.each([
    [new DbError('unavailable', 'x'), 'unavailable:in-use'],
    [new DbError('newer-schema', 'x'), 'unavailable:newer-version'],
    [new DbError('internal', 'x'), 'error'],
  ])('maps %s to %s', async (error, expected) => {
    vi.useFakeTimers();
    try {
      view = await render(
        <LibraryProvider open={async () => Promise.reject(error)}>
          <Probe />
        </LibraryProvider>,
      );
      // Past the whole automatic backoff for "in use".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(stateOf(view)).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  test('retry opens again and recovers (the other tab was closed)', async () => {
    vi.useFakeTimers();
    try {
      const open = vi
        .fn<() => Promise<Library>>()
        .mockRejectedValueOnce(new DbError('unavailable', 'x'))
        .mockRejectedValueOnce(new DbError('unavailable', 'x'))
        .mockRejectedValueOnce(new DbError('unavailable', 'x'))
        .mockRejectedValueOnce(new DbError('unavailable', 'x'))
        .mockRejectedValueOnce(new DbError('unavailable', 'x'))
        .mockRejectedValueOnce(new DbError('unavailable', 'x'))
        .mockResolvedValueOnce(library());
      view = await render(
        <LibraryProvider open={open}>
          <Probe />
        </LibraryProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(stateOf(view)).toBe('unavailable:in-use');
      await click(view.container.querySelector('button'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(stateOf(view)).toBe('ready');
      expect(open).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  test('retry lets go of a library that was open', async () => {
    const first = library();
    const open = vi.fn<() => Promise<Library>>().mockResolvedValueOnce(first).mockResolvedValueOnce(library());
    view = await render(
      <LibraryProvider open={open}>
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    await click(view.container.querySelector('button'));
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledWith({ force: true });
  });

  test('using the hook outside the provider is a programming error', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(render(<Probe />)).rejects.toThrow('inside <LibraryProvider>');
    quiet.mockRestore();
  });

  test('closes the library when the provider unmounts', async () => {
    const opened = library();
    view = await render(
      <LibraryProvider open={async () => opened}>
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    expect(opened.close).not.toHaveBeenCalled();
    view.unmount();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledWith({ force: true });
    view = undefined;
  });

  test('StrictMode (mount, cleanup, mount) leaves exactly one live library', async () => {
    const libraries: Library[] = [];
    const open = vi.fn(async () => {
      const next = library();
      libraries.push(next);
      return next;
    });
    view = await render(
      <StrictMode>
        <LibraryProvider open={open}>
          <Probe />
        </LibraryProvider>
      </StrictMode>,
    );
    await settle();
    expect(stateOf(view)).toBe('ready');
    const live = libraries.filter((l) => !vi.mocked(l.close).mock.calls.length);
    expect(live).toHaveLength(1);
  });

  test('two screens asking for the library share one open', async () => {
    const open = vi.fn(async () => library());
    view = await render(
      <LibraryProvider open={open}>
        <Probe />
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    expect(open).toHaveBeenCalledOnce();
    expect([...view.container.querySelectorAll('[data-testid="state"]')].map((e) => e.textContent)).toEqual(['ready', 'ready']);
  });

  test('an open that finishes after the provider unmounted is closed, not used', async () => {
    let finish: (l: Library) => void = () => {};
    const open = vi.fn(() => new Promise<Library>((resolve) => (finish = resolve)));
    view = await render(
      <LibraryProvider open={open}>
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    view.unmount();
    view = undefined;
    const late = library();
    finish(late);
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(late.close).toHaveBeenCalledWith({ force: true });
  });

  test('an open that finishes after a retry started is closed and does not set state', async () => {
    const resolvers: Array<(l: Library) => void> = [];
    const open = vi.fn(() => new Promise<Library>((resolve) => resolvers.push(resolve)));
    view = await render(
      <LibraryProvider open={open}>
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    await click(view.container.querySelector('button'));
    await settle();
    // Retrying never waits for the first attempt: it starts its own open at once.
    expect(resolvers).toHaveLength(2);
    const stale = library();
    resolvers[0]!(stale);
    await settle();
    expect(stale.close).toHaveBeenCalledOnce();
    expect(stale.close).toHaveBeenCalledWith({ force: true });
    expect(stateOf(view)).toBe('loading');
    const fresh = library();
    resolvers[1]!(fresh);
    await settle();
    expect(stateOf(view)).toBe('ready');
    expect(fresh.close).not.toHaveBeenCalled();
  });

  test('closes the library when the page is hidden, so the next page can have it', async () => {
    const opened = library();
    view = await render(
      <LibraryProvider open={async () => opened}>
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledWith({ force: true });
  });

  test('Retry after a newer-version notice is harmless', async () => {
    const open = vi.fn(async () => Promise.reject(new DbError('newer-schema', 'x')));
    view = await render(
      <LibraryProvider open={open}>
        <Probe />
      </LibraryProvider>,
    );
    await settle();
    await click(view.container.querySelector('button'));
    await settle();
    expect(stateOf(view)).toBe('unavailable:newer-version');
    expect(open).toHaveBeenCalledTimes(2);
  });

  describe('while the previous page still holds the library', () => {
    const inUse = () => Promise.reject(new DbError('unavailable', 'held'));
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const mount = (open: () => Promise<Library>) =>
      render(
        <LibraryProvider open={open}>
          <Probe />
        </LibraryProvider>,
      );
    afterEach(() => vi.useRealTimers());

    test('retries with a backoff, staying on loading, and then opens', async () => {
      vi.useFakeTimers();
      const open = vi.fn<() => Promise<Library>>().mockImplementationOnce(inUse).mockImplementationOnce(inUse).mockResolvedValue(library());
      view = await mount(open);
      expect(open).toHaveBeenCalledTimes(1);
      expect(stateOf(view)).toBe('loading');
      await advance(250);
      expect(open).toHaveBeenCalledTimes(2);
      expect(stateOf(view)).toBe('loading');
      await advance(500);
      expect(open).toHaveBeenCalledTimes(3);
      expect(stateOf(view)).toBe('ready');
    });

    test('shows the notice only after the backoff budget (about 8 s) is used up', async () => {
      vi.useFakeTimers();
      const open = vi.fn<() => Promise<Library>>(inUse);
      view = await mount(open);
      await advance(250 + 500 + 1000 + 2000);
      expect(stateOf(view)).toBe('loading');
      await advance(3999);
      expect(stateOf(view)).toBe('loading');
      await advance(1);
      expect(stateOf(view)).toBe('unavailable:in-use');
      expect(open).toHaveBeenCalledTimes(6);
      // The manual Try again still works.
      open.mockResolvedValueOnce(library());
      await click(view.container.querySelector('button'));
      await advance(0);
      expect(stateOf(view)).toBe('ready');
    });

    test('a hung open times out as unavailable, and Try again is not stuck behind it', async () => {
      vi.useFakeTimers();
      const open = vi.fn<() => Promise<Library>>(() => new Promise(() => {}));
      view = await mount(open);
      await advance(9999);
      expect(stateOf(view)).toBe('loading');
      await advance(1);
      expect(stateOf(view)).toBe('unavailable:in-use');
      expect(open).toHaveBeenCalledTimes(1);
      open.mockResolvedValueOnce(library());
      await click(view.container.querySelector('button'));
      await advance(0);
      expect(stateOf(view)).toBe('ready');
    });

    test('Try again during the backoff starts at once instead of waiting it out', async () => {
      vi.useFakeTimers();
      const open = vi.fn<() => Promise<Library>>().mockImplementationOnce(inUse).mockResolvedValue(library());
      view = await mount(open);
      await click(view.container.querySelector('button'));
      await advance(0);
      expect(stateOf(view)).toBe('ready');
      expect(open).toHaveBeenCalledTimes(2);
    });

    test('unmounting during the backoff leaves no timer and no further open', async () => {
      vi.useFakeTimers();
      const open = vi.fn<() => Promise<Library>>(inUse);
      view = await mount(open);
      view.unmount();
      view = undefined;
      await advance(20_000);
      expect(open).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
