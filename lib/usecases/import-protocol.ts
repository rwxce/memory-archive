import { DbError, type DbErrorCode } from '../db/errors';
import { ArchiveError, type ArchiveErrorCode } from '../exporters/archive/format';
import { BlobStoreError, type BlobStoreErrorCode } from '../storage/blob-store';
import {
  ImportError,
  type ImportErrorCode,
  type ImportProgress,
  type ImportResult,
  type ImportWhatsAppInput,
} from './import';

/**
 * Messages between the page and the import worker. Plain structured-cloneable data, plus the two
 * things that are meant to be shared or moved: the ZIP `Blob` (a reference to the file, not a copy
 * of its bytes) and the `MessagePort` to the database worker (transferred).
 */

/** The import request without the two callbacks-in-spirit (`signal`, `onProgress`) that cannot cross. */
export type ImportWorkerInput = Omit<ImportWhatsAppInput, 'signal' | 'onProgress'>;

export type ImportWorkerRequest =
  /** Starts the import. `dbPort` is a port to the database worker's own connection (`DbClient.connectPort()`). */
  | { type: 'start'; input: ImportWorkerInput; dbPort: MessagePort }
  /** Aborts the running import; before its save step the archive is left exactly as it was. */
  | { type: 'cancel' };

export type ImportWorkerEvent =
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'done'; result: ImportResult }
  | { type: 'error'; error: ImportFailure };

/** An error as data. `message` never contains chat text, author names or file names (the source errors guarantee it). */
export type ImportFailure =
  | { kind: 'import'; code: ImportErrorCode; message: string }
  | { kind: 'db'; code: DbErrorCode; message: string }
  | { kind: 'archive'; code: ArchiveErrorCode; message: string }
  | { kind: 'blob'; code: BlobStoreErrorCode; message: string }
  | { kind: 'aborted'; message: string }
  | { kind: 'internal'; message: string };

export function toImportFailure(error: unknown): ImportFailure {
  if (error instanceof ImportError) return { kind: 'import', code: error.code, message: error.message };
  if (error instanceof DbError) return { kind: 'db', code: error.code, message: error.message };
  if (error instanceof ArchiveError) return { kind: 'archive', code: error.code, message: error.message };
  if (error instanceof BlobStoreError) return { kind: 'blob', code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'aborted', message: error.message };
  return { kind: 'internal', message: error instanceof Error ? error.message : String(error) };
}

/** The typed error the caller of the worker client sees. `aborted` is returned as `undefined`: the caller owns the abort reason. */
export function fromImportFailure(failure: ImportFailure): Error | undefined {
  // Comes from another thread: a malformed failure is still a typed one, never an abort or a throw.
  if (typeof failure !== 'object' || failure === null) return new ImportError('worker-failed', 'the import worker sent an unreadable error');
  switch (failure.kind) {
    case 'import':
      return new ImportError(failure.code, failure.message);
    case 'db':
      return new DbError(failure.code, failure.message);
    case 'archive':
      return new ArchiveError(failure.code, failure.message);
    case 'blob':
      return new BlobStoreError(failure.code, failure.message);
    case 'aborted':
      return undefined;
    case 'internal':
      return new Error(failure.message);
    default:
      return new ImportError('worker-failed', 'the import worker sent an unreadable error');
  }
}
