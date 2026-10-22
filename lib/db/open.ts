import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { DbError, toDbError } from './errors';
import { OPFS_DB_FILE, OPFS_DIRECTORY, OPFS_SEARCH_FILE } from './opfs-names';
import { migrate, readUserVersion } from './migrations';
import { registerSearchTarget, type SearchTarget } from './search';
import { wrapOo1Db, type SqlDb } from './sql';

export type Persistence = 'opfs-sahpool' | 'memory';

export interface DbInfo {
  sqliteVersion: string;
  persistence: Persistence;
  /** Schema version of the open database (`PRAGMA user_version`). */
  schemaVersion: number;
}

export interface OpenedDb {
  db: SqlDb;
  info: DbInfo;
}

export { OPFS_DIRECTORY, OPFS_DB_FILE, OPFS_SEARCH_FILE };
/**
 * Files the pool must be able to hold: two databases, a rollback journal each, a super-journal
 * and some temporary files (the pool does not grow by itself; the default is 6).
 */
const OPFS_POOL_CAPACITY = 12;
const OPFS_VFS_NAME = 'memory-archive-opfs-sahpool';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

let sqlite3Promise: Promise<Sqlite3> | undefined;

/**
 * Loads the SQLite WASM module once per thread (also used by `snapshot.ts`). The `.wasm` file is a bundled,
 * same-origin asset (no CDN).
 */
export function loadSqlite(): Promise<Sqlite3> {
  sqlite3Promise ??= sqlite3InitModule().catch((error: unknown) => {
    sqlite3Promise = undefined;
    throw new DbError('unavailable', `could not load SQLite WebAssembly: ${toDbError(error).message}`);
  });
  return sqlite3Promise;
}

/** Foreign keys are off by default in SQLite; the schema relies on them. */
function prepare(db: SqlDb, sqlite3: Sqlite3, persistence: Persistence, search: SearchTarget): OpenedDb {
  try {
    db.exec('PRAGMA foreign_keys = ON');
    registerSearchTarget(db, search);
    migrate(db);
  } catch (error) {
    db.close();
    throw toDbError(error);
  }
  return { db, info: { sqliteVersion: sqlite3.version.libVersion, persistence, schemaVersion: readUserVersion(db) } };
}

/** A fresh in-memory library: Node tests, and nothing else. Nothing is persisted. */
export async function openMemoryDb(): Promise<OpenedDb> {
  const sqlite3 = await loadSqlite();
  return prepare(wrapOo1Db(new sqlite3.oo1.DB(':memory:', 'c'), sqlite3.capi), sqlite3, 'memory', { file: ':memory:', exists: false });
}

/**
 * The persisted library, in the browser's origin-private file system through
 * the SAH-pool VFS. Only works inside a Web Worker. Unlike the other OPFS
 * VFS it needs no COOP/COEP headers (a static host cannot always set them),
 * at the price of one connection at a time: a second tab gets `unavailable`.
 */
export async function openOpfsDb(): Promise<OpenedDb> {
  const sqlite3 = await loadSqlite();
  let pool: Awaited<ReturnType<Sqlite3['installOpfsSAHPoolVfs']>>;
  try {
    // `forceReinitIfPreviouslyFailed`: sqlite-wasm caches a rejected init per
    // VFS name; without it a second tab could never recover after the first
    // one closed. The option is missing from the package's type declarations.
    const options: Parameters<Sqlite3['installOpfsSAHPoolVfs']>[0] & { forceReinitIfPreviouslyFailed: boolean } = {
      name: OPFS_VFS_NAME,
      directory: OPFS_DIRECTORY,
      clearOnInit: false,
      forceReinitIfPreviouslyFailed: true,
    };
    pool = await sqlite3.installOpfsSAHPoolVfs(options);
  } catch (error) {
    throw new DbError(
      'unavailable',
      `the on-device database is not available (is it open in another tab, or is private storage unsupported?): ${toDbError(error).message}`,
    );
  }
  // Room for the search index file. Failing to get it must not keep the library from opening:
  // search would then report itself unavailable, nothing else.
  await pool.reserveMinimumCapacity(OPFS_POOL_CAPACITY).catch(() => undefined);
  return prepare(wrapOo1Db(new pool.OpfsSAHPoolDb(OPFS_DB_FILE), sqlite3.capi), sqlite3, 'opfs-sahpool', {
    file: OPFS_SEARCH_FILE,
    exists: pool.getFileNames().some((name) => name.endsWith(OPFS_SEARCH_FILE)),
    remove: () => {
      pool.unlink(OPFS_SEARCH_FILE);
    },
  });
}
