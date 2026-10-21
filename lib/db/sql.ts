/**
 * The narrow synchronous SQL surface the rest of `lib/db` is written against.
 * SQLite WASM's `oo1.DB` (in memory, in Node tests) and `OpfsSAHPoolDb`
 * (persisted in the browser) both fit it, so the migrations and queries that
 * run in production are the exact ones the Node tests exercise.
 */
import type { Database } from '@sqlite.org/sqlite-wasm';

export type SqlValue = string | number | null;

export interface SqlDb {
  /** Runs one or more statements without parameters (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): void;
  /** Runs one parameterized statement; returns the number of rows it changed. */
  run(sql: string, params?: readonly SqlValue[]): number;
  /** Runs one parameterized query and returns its rows as objects. */
  all<T extends object = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
  /**
   * The whole database file as bytes (SQLite's serialization). Present when the
   * wrapper was given the SQLite C API (`wrapOo1Db(db, capi)`); used by backups.
   */
  serialize?(): Uint8Array;
  close(): void;
}

/** What `wrapOo1Db` needs: SQLite WASM's `oo1.DB` and `OpfsSAHPoolDb` both fit. */
export type Oo1Db = Pick<Database, 'exec' | 'changes' | 'close' | 'pointer'>;

/** The one C-API function `serialize` needs (`sqlite3.capi`). */
export interface SerializeCapi {
  sqlite3_js_db_export(db: NonNullable<Oo1Db['pointer']>, schema?: string): Uint8Array;
}

export function wrapOo1Db(db: Oo1Db, capi?: SerializeCapi): SqlDb {
  return {
    exec: (sql) => {
      db.exec({ sql });
    },
    run: (sql, params) => {
      db.exec({ sql, ...(params ? { bind: [...params] } : {}) });
      return db.changes();
    },
    all: <T extends object>(sql: string, params?: readonly SqlValue[]) =>
      db.exec({
        sql,
        ...(params ? { bind: [...params] } : {}),
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as T[],
    ...(capi
      ? {
          serialize: () => {
            if (db.pointer === undefined) throw new Error('database is closed');
            return capi.sqlite3_js_db_export(db.pointer);
          },
        }
      : {}),
    close: () => db.close(),
  };
}

/**
 * Runs `fn` atomically: commit on success, roll back and rethrow on failure.
 * Not re-entrant (SQLite has no nested BEGIN); callers never nest.
 */
export function transaction<T>(db: SqlDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite already rolled back on its own (e.g. disk full); keep the original error.
    }
    throw error;
  }
}
