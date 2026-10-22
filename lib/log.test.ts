import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLogger, setLogLevel } from './log';

describe('log', () => {
  afterEach(() => {
    setLogLevel('warn');
    vi.restoreAllMocks();
  });

  test('prints at or above the threshold, with a scope prefix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const log = createLogger('db');
    log.debug('hidden');
    log.warn('shown', 1);
    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[memory-archive:db]', 'shown', 1);
  });

  test('setLogLevel lowers the threshold', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    setLogLevel('debug');
    createLogger('x').debug('now shown');
    expect(debug).toHaveBeenCalledOnce();
  });
});
