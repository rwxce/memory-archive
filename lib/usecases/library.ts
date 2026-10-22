import { createDbClient, createWorkerTransport, type DbClient } from '../db/client';
import { DbError, toDbError } from '../db/errors';
import { ArchiveError } from '../exporters/archive/format';
import { isUuid, type Profile } from '../domain/library';
import { createLogger } from '../log';
import type { BlobStore } from '../storage/blob-store';
import { openOpfsBlobStore } from '../storage/opfs-blob-store';
import { openOpfsThumbStore } from '../storage/opfs-thumb-store';
import type { ThumbStore } from '../storage/thumb-store';
import { isArchiveBusy, webArchiveLock, type ArchiveLock } from './archive-guard';
import { listConversations, withParticipants, listConversationRows, type ConversationRow } from './conversations';
import { sweepLeftovers } from './import';
import { listProfiles, type ProfileDeps } from './profiles';

const log = createLogger('library');

/** An open library: what every profile and conversation use case needs, and a way to let go of it. */
export interface Library {
  deps: ProfileDeps;
  /**
   * The open-time cleanup (`sweepLeftovers`), running when the library is handed out. Never
   * rejects (a failure is logged without data); tests and callers that need it done await it.
   */
  cleanup: Promise<void>;
  /** Where the built import worker is served (`importWorkerUrlOf` the database worker's URL). */
  importWorkerUrl: string;
  /** A new port to this library's database connection, to hand to the import worker. */
  connectPort(): MessagePort;
  /** An archive operation (import, undo, backup, restore, sweep) is running in this tab. */
  isBusy(): boolean;
  /**
   * Lets go of the library. While an archive operation runs it THROWS `ArchiveError` `busy` and
   * closes nothing: closing stops the database worker, which would leave an import worker
   * waiting forever on its port. Cancel the operation first, or pass `force` when the page is
   * going away anyway (`pagehide`, unmount): the operation is then abandoned, the archive keeps
   * the whole batch or nothing, and what it left is swept by the next open that gets the lock.
   */
  close(options?: { force?: boolean }): void;
}

export interface OpenLibraryOptions {
  /** Where the built database worker is served, e.g. `${basePath}/db/worker.js`. */
  workerUrl: string;
  /** Where the built import worker is served; by default next to `workerUrl` (`importWorkerUrlOf`). */
  importWorkerUrl?: string;
  /** Test seams: the real worker and the real OPFS are used when absent. */
  createClient?: (workerUrl: string) => DbClient;
  openBlobStore?: () => Promise<BlobStore>;
  /** The thumbnail cache; a cache that cannot be opened is skipped, never a reason to fail the open. */
  openThumbStore?: () => Promise<ThumbStore>;
  /** The cross-tab lock; `navigator.locks` (`webArchiveLock`) when absent and available. */
  lock?: ArchiveLock;
}

/**
 * The import worker is built into the same directory as the database worker
 * (`scripts/build-db-worker.mjs` writes both to `public/db/`), so its URL is the database
 * worker's with the file name replaced; the deployment base path is already in it.
 * `${base}/db/worker.js` -> `${base}/db/import-worker.js`.
 */
export const importWorkerUrlOf = (workerUrl: string): string => workerUrl.slice(0, workerUrl.lastIndexOf('/') + 1) + 'import-worker.js';

/**
 * Opens the on-device library: starts the database worker, makes sure the
 * database opens (applying any pending upgrade), opens the file store and starts cleaning up
 * what an interrupted import left (`sweepLeftovers`: temp files and orphan blobs).
 *
 * The cleanup runs only while this tab holds the archive lock and no archive operation runs in
 * it: a reload, a second tab or a reopened library must never delete the temp files and
 * not-yet-committed blobs of an import worker that is still writing. If the lock is taken (or
 * the browser has none) it is skipped silently and the next open tries again; a cleanup that
 * fails is logged (no data) and does not fail the open. It runs in the background:
 * `openLibrary` does not wait for it (`Library.cleanup` resolves when it is done), so it never counts
 * toward `OPEN_TIMEOUT_MS`; it holds the in-tab guard from the moment the library is handed out, so
 * an import started meanwhile is `busy`, and `close()` needs `force` until it ends.
 *
 * Rejects with a `DbError`: `unavailable` (another tab holds the library, or
 * this browser cannot keep private files), `newer-schema` (saved by a newer
 * version of the app) or `internal`. Nothing stays open after a failure.
 */
export async function openLibrary(options: OpenLibraryOptions): Promise<Library> {
  const client = (options.createClient ?? defaultCreateClient)(options.workerUrl);
  try {
    await client.call('status');
    // The store is opened WITHOUT its own sweep of `tmp/`: that one is unconditional.
    const blobStore = await (options.openBlobStore ?? (() => openOpfsBlobStore({ sweep: false })))();
    const thumbStore = await (options.openThumbStore ?? openOpfsThumbStore)().catch(() => undefined);
    const lock = options.lock ?? (typeof navigator !== 'undefined' && 'locks' in navigator ? webArchiveLock : undefined);
    const deps: ProfileDeps = { client, blobStore, ...(thumbStore ? { thumbStore } : {}), ...(lock ? { lock } : {}) };
    // Started now (the guard is taken before `openLibrary` returns, so an import started meanwhile
    // is `busy`) but NOT awaited: a slow cleanup must never count toward the open timeout.
    const cleanup = sweepLeftovers(deps).then(
      () => undefined,
      (error: unknown) => log.warn('the open-time cleanup failed', error instanceof Error ? error.name : 'error'),
    );
    return {
      deps,
      cleanup,
      importWorkerUrl: options.importWorkerUrl ?? importWorkerUrlOf(options.workerUrl),
      connectPort: () => client.connectPort(),
      isBusy: () => isArchiveBusy(blobStore),
      close: (closeOptions) => {
        if (!closeOptions?.force && isArchiveBusy(blobStore)) {
          throw new ArchiveError('busy', 'an archive operation is running: cancel it before closing the library');
        }
        client.close();
      },
    };
  } catch (error) {
    client.close();
    // Not being able to open the file store means private storage is unavailable here.
    throw error instanceof DbError ? error : new DbError('unavailable', toDbError(error).message);
  }
}

function defaultCreateClient(workerUrl: string): DbClient {
  return createDbClient(createWorkerTransport(workerUrl));
}

/** Why the library could not be opened, in terms the UI can explain. */
export type LibraryProblem = 'in-use' | 'newer-version' | 'other';

export function libraryProblemOf(error: unknown): LibraryProblem {
  const { code } = toDbError(error);
  if (code === 'unavailable') return 'in-use';
  if (code === 'newer-schema') return 'newer-version';
  return 'other';
}

/** A profile as the People screen shows it. */
export interface Person extends Profile {
  /** Conversations filed under this person. */
  conversationCount: number;
  /** Earliest first message across their conversations (ISO local time as stored); null when none has messages. */
  firstMessageAt: string | null;
  /** Latest last message across their conversations; null when none has messages. */
  lastMessageAt: string | null;
}

export interface People {
  active: Person[];
  archived: Person[];
  /** Conversations filed under nobody (for instance after the last link was removed). They are never hidden. */
  unassigned: ConversationRow[];
}

/** Every profile, split into active and archived, each with its number of conversations. */
export async function listPeople(deps: ProfileDeps): Promise<People> {
  const [profiles, conversations] = await Promise.all([listProfiles(deps, 'all'), listConversations(deps)]);
  const stats = new Map<string, { count: number; first: string | null; last: string | null }>();
  for (const conversation of conversations) {
    for (const id of conversation.profileIds) {
      const s = stats.get(id) ?? { count: 0, first: null, last: null };
      s.count += 1;
      // sentAt is a fixed-width ISO string: lexical order is chronological order.
      if (conversation.firstMessageAt !== null && (s.first === null || conversation.firstMessageAt < s.first)) s.first = conversation.firstMessageAt;
      if (conversation.lastMessageAt !== null && (s.last === null || conversation.lastMessageAt > s.last)) s.last = conversation.lastMessageAt;
      stats.set(id, s);
    }
  }
  const people: People = { active: [], archived: [], unassigned: [] };
  for (const profile of profiles) {
    (profile.archivedAt === null ? people.active : people.archived).push({
      ...profile,
      conversationCount: stats.get(profile.id)?.count ?? 0,
      firstMessageAt: stats.get(profile.id)?.first ?? null,
      lastMessageAt: stats.get(profile.id)?.last ?? null,
    });
  }
  people.unassigned = await withParticipants(
    deps,
    conversations.filter((conversation) => conversation.profileIds.length === 0),
  );
  return people;
}

export interface PersonDetails {
  person: Person;
  /** Conversations filed under this person, shared and group chats included. */
  conversations: ConversationRow[];
  /** Everyone in the library, to choose where a conversation goes. */
  people: People;
}

/**
 * One person with their conversations. `undefined` when there is no such person
 * (an unknown or malformed id, e.g. from an old link): the caller shows a calm
 * "not found", not an error. Other failures reject.
 */
export async function getPersonDetails(deps: ProfileDeps, id: string): Promise<PersonDetails | undefined> {
  if (!isUuid(id)) return undefined;
  const people = await listPeople(deps);
  const person = [...people.active, ...people.archived].find((candidate) => candidate.id === id);
  if (!person) return undefined;
  return { person, conversations: await listConversationRows(deps, { profileId: id }), people };
}

/**
 * Waits between automatic retries when the library is "in use": the previous
 * page's worker (a full page navigation, a locale switch) may still hold the
 * database for a moment. About 8 s in total, then the UI shows the notice.
 */
export const OPEN_BACKOFF_MS = [250, 500, 1000, 2000, 4000];

/** A worker that never answers must not leave a screen loading forever. */
export const OPEN_TIMEOUT_MS = 10_000;

/** `unavailable`, but a hung worker is not worth retrying: the UI shows the notice at once. */
export class LibraryOpenTimeout extends DbError {
  constructor() {
    super('unavailable', 'opening the library took too long');
  }
}

/** Races one open against the timeout; an open that finishes after it is closed, not leaked. */
export function openWithTimeout(open: () => Promise<Library>, timeoutMs = OPEN_TIMEOUT_MS): Promise<Library> {
  return new Promise<Library>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new LibraryOpenTimeout());
    }, timeoutMs);
    new Promise<Library>((go) => go(open())).then(
      (opened) => {
        if (settled) return opened.close({ force: true });
        settled = true;
        clearTimeout(timer);
        resolve(opened);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
