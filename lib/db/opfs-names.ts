/**
 * OPFS directory and files the library lives in; part of the on-device format. Kept apart from
 * `open.ts` so the erase use case can name them without loading SQLite WASM.
 */
export const OPFS_DIRECTORY = '/memory-archive-db';
export const OPFS_DB_FILE = '/library.sqlite3';
/** The derived full-text index (`search.ts`): same pool, never backed up, always rebuildable. */
export const OPFS_SEARCH_FILE = '/search.sqlite3';
