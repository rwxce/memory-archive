import { createDbClient, createWorkerTransport, type DbClient } from '../db/client';
import { DbError, toDbError } from '../db/errors';
import { isUuid, type Profile } from '../domain/library';
import type { BlobStore } from '../storage/blob-store';
import { openOpfsBlobStore } from '../storage/opfs-blob-store';
import { webArchiveLock } from './archive-guard';
import { listConversations, withParticipants, listConversationRows, type ConversationRow } from './conversations';
import { listProfiles, type ProfileDeps } from './profiles';

/** An open library: what every profile and conversation use case needs, and a way to let go of it. */
export interface Library {
  deps: ProfileDeps;
  close(): void;
}

export interface OpenLibraryOptions {
  /** Where the built database worker is served, e.g. `${basePath}/db/worker.js`. */
  workerUrl: string;
  /** Test seams: the real worker and the real OPFS are used when absent. */
  createClient?: (workerUrl: string) => DbClient;
  openBlobStore?: () => Promise<BlobStore>;
}

/**
 * Opens the on-device library: starts the database worker, makes sure the
 * database opens (applying any pending upgrade), and opens the file store.
 * Rejects with a `DbError`: `unavailable` (another tab holds the library, or
 * this browser cannot keep private files), `newer-schema` (saved by a newer
 * version of the app) or `internal`. Nothing stays open after a failure.
 */
export async function openLibrary(options: OpenLibraryOptions): Promise<Library> {
  const client = (options.createClient ?? defaultCreateClient)(options.workerUrl);
  try {
    await client.call('status');
    const blobStore = await (options.openBlobStore ?? openOpfsBlobStore)();
    const lock = typeof navigator !== 'undefined' && 'locks' in navigator ? webArchiveLock : undefined;
    return { deps: { client, blobStore, ...(lock ? { lock } : {}) }, close: () => client.close() };
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
  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    for (const id of conversation.profileIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const people: People = { active: [], archived: [], unassigned: [] };
  for (const profile of profiles) {
    (profile.archivedAt === null ? people.active : people.archived).push({
      ...profile,
      conversationCount: counts.get(profile.id) ?? 0,
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
        if (settled) return opened.close();
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
