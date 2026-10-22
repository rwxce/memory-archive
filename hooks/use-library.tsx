'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  LibraryOpenTimeout,
  libraryProblemOf,
  OPEN_BACKOFF_MS,
  openLibrary,
  openWithTimeout,
  type Library,
  type LibraryProblem,
} from '@/lib/usecases/library';
import type { ProfileDeps } from '@/lib/usecases/profiles';

/** What running an import in its worker needs besides the deps: where the worker is and a port to the database. */
export interface ImportAccess {
  workerUrl: string;
  connectPort(): MessagePort;
}

export type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; deps: ProfileDeps; import: ImportAccess }
  | { status: 'unavailable'; problem: LibraryProblem }
  | { status: 'error' };

type Reloader = () => Promise<void>;

interface LibraryContextValue {
  state: LibraryState;
  /** Lists register how to reload themselves; `refresh` runs them all and resolves when they are done. */
  register(reload: Reloader): () => void;
  refresh(): Promise<void>;
  /** Starts opening the library (once); screens call this when they mount. */
  start(): void;
  retry(): void;
}

const LibraryContext = createContext<LibraryContextValue | undefined>(undefined);

const WORKER_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/db/worker.js`;
const defaultOpen = () => openLibrary({ workerUrl: WORKER_URL });

/**
 * Owns the connection to the on-device library. It opens lazily, when the
 * first screen that needs it asks, so Settings and the other pages never hold
 * the library (only one tab can at a time).
 *
 * - Every attempt has a generation number: an open that finishes after the
 *   provider unmounted, the page was hidden or a retry started is closed and
 *   ignored, so React StrictMode's mount, cleanup, mount leaves one live library.
 * - The library is closed on unmount and on `pagehide`, so the next page can
 *   have it as early as possible (and reopened if the page returns from the
 *   back/forward cache).
 * - "In use" is retried automatically with a short backoff while the screen
 *   keeps showing "loading"; only then does the notice appear. Each open is
 *   raced against a timeout. Retrying never waits behind an earlier attempt.
 */
export function LibraryProvider({ children, open = defaultOpen }: { children: ReactNode; open?: () => Promise<Library> }) {
  const [state, setState] = useState<LibraryState>({ status: 'loading' });
  const library = useRef<Library>(undefined);
  const attempt = useRef<Promise<void>>(undefined);
  const generation = useRef(0);
  const wake = useRef<() => void>(undefined);
  const wanted = useRef(false);
  const reloaders = useRef(new Set<Reloader>());
  const openRef = useRef(open);
  openRef.current = open;

  /** Ends whatever the current attempt is doing: later results are stale, a pending wait ends now. */
  const supersede = useCallback(() => {
    generation.current++;
    wake.current?.();
  }, []);

  const run = useCallback(() => {
    supersede();
    const mine = generation.current;
    const current = () => mine === generation.current;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake.current = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    setState({ status: 'loading' });
    const done = (async () => {
      try {
        // One tick first: StrictMode's mount, cleanup, mount supersedes this attempt before any worker starts.
        await Promise.resolve();
        for (let tries = 0; current(); tries++) {
          try {
            const opened = await openWithTimeout(() => openRef.current());
            if (!current()) return opened.close({ force: true });
            library.current = opened;
            setState({
              status: 'ready',
              deps: opened.deps,
              import: { workerUrl: opened.importWorkerUrl, connectPort: () => opened.connectPort() },
            });
            return;
          } catch (error) {
            const wait = OPEN_BACKOFF_MS[tries];
            if (!current() || libraryProblemOf(error) !== 'in-use' || error instanceof LibraryOpenTimeout || wait === undefined) throw error;
            await sleep(wait);
          }
        }
      } catch (error) {
        if (!current()) return;
        attempt.current = undefined;
        const problem = libraryProblemOf(error);
        setState(problem === 'other' ? { status: 'error' } : { status: 'unavailable', problem });
      }
    })();
    attempt.current = done;
  }, [supersede]);

  const start = useCallback(() => {
    wanted.current = true;
    if (!attempt.current) run();
  }, [run]);

  const retry = useCallback(() => {
    library.current?.close({ force: true });
    library.current = undefined;
    run();
  }, [run]);

  useEffect(() => {
    const release = () => {
      supersede();
      library.current?.close({ force: true });
      library.current = undefined;
      attempt.current = undefined;
    };
    const onPageShow = (event: PageTransitionEvent) => {
      // Back from the back/forward cache: the library was released on pagehide.
      if (event.persisted && wanted.current && !attempt.current) run();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', onPageShow);
      release();
    };
  }, [supersede, run]);

  const register = useCallback((reload: Reloader) => {
    reloaders.current.add(reload);
    return () => void reloaders.current.delete(reload);
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([...reloaders.current].map((reload) => reload()));
  }, []);

  const value = useMemo(() => ({ state, register, refresh, start, retry }), [state, register, refresh, start, retry]);
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

function useLibraryContext(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used inside <LibraryProvider>');
  return value;
}

/** The library connection, and the request to open it: loading, ready (with the use-case dependencies), or why it is not. */
export function useLibrary(): { state: LibraryState; retry: () => void } {
  const { state, start, retry } = useLibraryContext();
  useEffect(() => start(), [start]);
  return { state, retry };
}

/** The connection as it is now, without asking for it to open (for notices on pages that do not need the library). */
export function useLibraryState(): { state: LibraryState; retry: () => void } {
  const { state, retry } = useLibraryContext();
  return { state, retry };
}

/** For hooks that already sit under a screen that called `useLibrary`. */
export function useLibraryInternals() {
  const { state, register, refresh } = useLibraryContext();
  return { state, register, refresh };
}

/** The use-case dependencies once the library is ready (`undefined` before), for screens that read through use cases. */
export function useLibraryDeps(): ProfileDeps | undefined {
  const { state } = useLibraryContext();
  return state.status === 'ready' ? state.deps : undefined;
}
