/**
 * The only place in the app allowed to write to the console (`no-console`
 * is an error everywhere else in `app/`, `components/`, `hooks/` and `lib/`).
 *
 * Local developer diagnostics only: nothing is sent anywhere, and callers must
 * never pass message text, author names or file names (privacy rules).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = 'warn';

/** Lowest level that is printed (default `warn`). */
export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const prefix = `[memory-archive:${scope}]`;
  console[level](prefix, ...args);
}

/** A logger tagged with a scope, e.g. `createLogger('db')`. */
export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', scope, args),
    info: (...args: unknown[]) => emit('info', scope, args),
    warn: (...args: unknown[]) => emit('warn', scope, args),
    error: (...args: unknown[]) => emit('error', scope, args),
  };
}
