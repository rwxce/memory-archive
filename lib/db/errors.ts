/**
 * Errors of the database layer. They cross the Web Worker boundary as plain
 * `{ code, message }` data, so messages must never contain chat text, author
 * names or file names (SQLite reports constraint names, never values).
 */
export type DbErrorCode =
  /** OPFS or WebAssembly is missing, or another tab holds the database. */
  | 'unavailable'
  /** The database was written by a newer app version; refuse instead of guessing. */
  | 'newer-schema'
  /** A UNIQUE / CHECK / FOREIGN KEY rule rejected the data. */
  | 'constraint'
  /** The request itself is malformed (bad id, unknown operation, ...). */
  | 'invalid'
  /** The profile or conversation a request refers to does not exist (or is not linked). */
  | 'not-found'
  /** A stored file is too big to load into memory on this path (and cannot be streamed). */
  | 'too-large'
  /** The worker went away before answering. */
  | 'closed'
  | 'internal';

export interface DbErrorData {
  code: DbErrorCode;
  message: string;
}

export class DbError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }

  toJSON(): DbErrorData {
    return { code: this.code, message: this.message };
  }
}

/** Normalizes anything thrown by SQLite or our own code into a `DbError`. */
export function toDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_CONSTRAINT|constraint failed/i.test(message)) return new DbError('constraint', message);
  return new DbError('internal', message);
}

export function fromDbErrorData(data: DbErrorData): DbError {
  return new DbError(data.code, data.message);
}
