import { sha256Hex } from '../domain/sha256';
import { DbError, toDbError } from './errors';
import { MIGRATIONS, migrate, readUserVersion, type Migration } from './migrations';
import { loadSqlite } from './open';
import { discardSearchIndex } from './search';
import { transaction, wrapOo1Db, type SqlDb, type SqlValue } from './sql';

/**
 * Whole-library operations for backups: take the database as bytes, and load
 * bytes from another device back in. Nothing else issues SQL for backups.
 */

/** A SQLite file starts with a 100-byte header; anything shorter is not a database. */
const MIN_DB_BYTES = 100;
const COPY_PAGE = 5000;

export interface BlobRow {
  sha256: string;
  size: number;
}

/** What `exportDatabase` returns; read in one synchronous step so the three parts describe the same moment. */
export interface DatabaseExport {
  schemaVersion: number;
  database: Uint8Array;
  blobs: BlobRow[];
}

export function exportDatabase(db: SqlDb): DatabaseExport {
  return { schemaVersion: readUserVersion(db), database: serializeDb(db), blobs: listBlobs(db) };
}

/** The database file as bytes (SQLite serialization). */
export function serializeDb(db: SqlDb): Uint8Array {
  if (!db.serialize) throw new DbError('unavailable', 'this database handle cannot be serialized');
  return db.serialize();
}

/** Every media reference, sorted by hash. */
export function listBlobs(db: SqlDb): BlobRow[] {
  return db.all<BlobRow>('SELECT sha256, size FROM blobs ORDER BY sha256');
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function userTables(db: SqlDb): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);
}

/** True when no table of the library holds a row (also true for a fresh database). */
export function isLibraryEmpty(db: SqlDb): boolean {
  return userTables(db).every((t) => db.all(`SELECT 1 FROM ${quote(t)} LIMIT 1`).length === 0);
}

function columns(db: SqlDb, table: string): { name: string; type: string }[] {
  return db
    .all<{ name: string; type: string }>(`PRAGMA table_info(${quote(table)})`)
    .map((c) => ({ name: c.name, type: c.type }));
}

export interface LoadSnapshotOptions {
  /** Migration list to bring an older snapshot up to date; defaults to the app's. */
  migrations?: readonly Migration[];
  /** When given, the snapshot's `blobs` rows must equal this list exactly. */
  expectBlobs?: readonly BlobRow[];
  /**
   * `target` may hold data: every row is deleted and the snapshot's rows inserted in the SAME
   * transaction, so a failure anywhere leaves the old library exactly as it was. Default: the
   * caller has checked `target` is empty.
   */
  replace?: boolean;
  /**
   * With `replace`: the `databaseDigest` of the library the caller backed up. If the library has
   * changed since (a note, a favorite, a profile edit), nothing is touched and it throws `changed`.
   * Checked in the same synchronous step as the swap, so no write can slip in between.
   */
  unchangedSince?: string;
}

/** SHA-256 (hex) of the database bytes: a cheap "has the library changed?" token. */
export const databaseDigest = (bytes: Uint8Array): string => sha256Hex(bytes);

const invalid = (message: string) => new DbError('invalid', `invalid database snapshot: ${message}`);

/** Opens `bytes` as a scratch in-memory database. Throws `invalid` when they are not SQLite. */
async function openScratch(bytes: Uint8Array): Promise<SqlDb> {
  if (bytes.length < MIN_DB_BYTES) throw invalid('too small to be a SQLite file');
  const sqlite3 = await loadSqlite();
  const oo1 = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    oo1.checkRc(sqlite3.capi.sqlite3_deserialize(oo1.pointer!, 'main', pointer, bytes.length, bytes.length, flags));
  } catch (error) {
    oo1.close();
    throw invalid(toDbError(error).message);
  }
  return wrapOo1Db(oo1);
}

/**
 * Opens an untrusted snapshot in a scratch in-memory database and checks it (`integrity_check`,
 * `foreign_key_check`, newer schema refused, no triggers, views or virtual tables (before
 * migrating), same tables and columns as the current schema after migrating). The caller closes
 * the returned scratch; on failure it is closed here.
 */
async function openChecked(target: SqlDb, bytes: Uint8Array, options: LoadSnapshotOptions) {
  const migrations = options.migrations ?? MIGRATIONS;
  const scratch = await openScratch(bytes);
  try {
    let versions: { from: number; to: number };
    try {
      // Nothing in the snapshot may run code on our behalf: no function in the
      // schema is trusted, and triggers, views and virtual tables are refused
      // before a single migration statement touches the scratch copy.
      scratch.exec('PRAGMA trusted_schema = OFF');
      if (
        scratch.all(
          `SELECT 1 FROM sqlite_master
            WHERE type IN ('trigger', 'view') OR (type = 'table' AND sql LIKE 'CREATE VIRTUAL%') LIMIT 1`,
        ).length > 0
      ) {
        throw invalid('triggers, views and virtual tables are not allowed');
      }
      const [check] = scratch.all<{ integrity_check: string }>('PRAGMA integrity_check');
      if (check?.integrity_check !== 'ok') throw invalid('integrity check failed');
      scratch.exec('PRAGMA foreign_keys = ON');
      versions = migrate(scratch, migrations);
    } catch (error) {
      if (error instanceof DbError) throw error;
      throw invalid(toDbError(error).message);
    }
    if (readUserVersion(target) !== versions.to) throw invalid('target schema version differs from the snapshot after migration');
    if (scratch.all('PRAGMA foreign_key_check').length > 0) throw invalid('foreign key violations');

    const tables = userTables(target);
    if (JSON.stringify(userTables(scratch)) !== JSON.stringify(tables)) throw invalid('tables differ from the current schema');
    for (const table of tables) {
      if (JSON.stringify(columns(scratch, table)) !== JSON.stringify(columns(target, table))) {
        throw invalid(`columns of ${table} differ from the current schema`);
      }
    }

    if (options.expectBlobs) {
      const have = JSON.stringify(listBlobs(scratch));
      const want = JSON.stringify([...options.expectBlobs].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)));
      if (have !== want) throw invalid('media references do not match the archive contents');
    }
    return { scratch, versions, tables };
  } catch (error) {
    scratch.close();
    throw error;
  }
}

/**
 * Runs every check `loadSnapshot` runs, writes nothing to `target` and returns the schema versions
 * (`from` the snapshot's, `to` the current one). Lets a caller refuse a bad backup before it does
 * anything irreversible; `loadSnapshot` still checks again when it loads.
 */
export async function checkSnapshot(target: SqlDb, bytes: Uint8Array, options: LoadSnapshotOptions = {}): Promise<{ from: number; to: number }> {
  const { scratch, versions } = await openChecked(target, bytes, options);
  scratch.close();
  return versions;
}

/**
 * Loads a snapshot from another device into `target`, which the caller has
 * already checked is empty (or, with `replace`, may hold data). The snapshot is untrusted: it is
 * checked in a scratch database (`openChecked`), and only then copied into `target` in one
 * transaction. On any failure `target` is untouched.
 */
export async function loadSnapshot(
  target: SqlDb,
  bytes: Uint8Array,
  options: LoadSnapshotOptions = {},
): Promise<{ from: number; to: number }> {
  const { scratch, versions, tables } = await openChecked(target, bytes, options);
  try {
    // Everything from here on is synchronous: no other request can write between this check and the swap.
    if (options.unchangedSince !== undefined && databaseDigest(serializeDb(target)) !== options.unchangedSince) {
      throw new DbError('changed', 'the library changed since its safety backup was made');
    }

    // The archive is about to change under any search index: drop it (it is rebuilt on the next search).
    discardSearchIndex(target);
    try {
      transaction(target, () => {
        target.exec('PRAGMA defer_foreign_keys = ON');
        if (options.replace) for (const table of tables) target.run(`DELETE FROM ${quote(table)}`);
        const count = (db: SqlDb, table: string) => db.all<{ n: number }>(`SELECT count(*) AS n FROM ${quote(table)}`)[0].n;
        for (const table of tables) {
          const before = count(target, table);
          const names = columns(target, table).map((c) => c.name);
          const insert = `INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
          // Keyset paging by rowid. The first page has no lower bound: rowids
          // are signed and a hostile snapshot may use negative ones.
          let after: SqlValue | undefined;
          for (;;) {
            const rows =
              after === undefined
                ? scratch.all<Record<string, SqlValue>>(
                    `SELECT rowid AS __rowid__, * FROM ${quote(table)} ORDER BY rowid LIMIT ${COPY_PAGE}`,
                  )
                : scratch.all<Record<string, SqlValue>>(
                    `SELECT rowid AS __rowid__, * FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${COPY_PAGE}`,
                    [after],
                  );
            for (const row of rows) target.run(insert, names.map((n) => row[n]));
            if (rows.length < COPY_PAGE) break;
            after = rows[rows.length - 1].__rowid__;
          }
          // Nothing may be lost or invented on the way (rowid edge cases).
          if (count(target, table) - before !== count(scratch, table)) throw invalid(`rows of ${table} were not copied completely`);
        }
        if (target.all('PRAGMA foreign_key_check').length > 0) throw invalid('foreign key violations');
      });
    } catch (error) {
      throw toDbError(error);
    }
    return versions;
  } finally {
    scratch.close();
  }
}
