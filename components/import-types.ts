import type { ImportProgress, ImportResult } from '@/lib/usecases/import';
import type { ImportPreview } from '@/lib/usecases/import-preview';
import type { ConversationChoice, DateOrder, ImportProblem, WizardChoices } from '@/lib/usecases/import-wizard';

/** The wizard's state, as plain data: one `FileItem` per ZIP, kept while the person goes back and forth. */

export type StepId = 1 | 2 | 3 | 4 | 5;
export const STEPS: readonly StepId[] = [1, 2, 3, 4, 5];

/** The person's name is kept with the choice, so the result can name them whatever happens to the people list. */
export type Destination = { kind: 'person'; id: string; name: string } | { kind: 'later' };
/** "Me" is always an explicit choice: an author, or "not in this chat". `undefined` = not chosen yet. */
export type MeChoice = { kind: 'author'; name: string } | { kind: 'none' };

export type Loadable<T> =
  | { status: 'loading'; done?: number }
  | { status: 'ready'; value: T }
  | { status: 'error'; problem: ImportProblem };

export type Ambiguity = Pick<Extract<ImportPreview['duplicates'], { status: 'ambiguous' }>, 'reason' | 'candidates'>;

export type ImportedResult = Extract<ImportResult, { status: 'imported' }>;

export type UndoState = 'idle' | 'confirming' | 'working' | 'failed' | { removed: number } | 'gone';

export type RunState =
  | { status: 'waiting' }
  | { status: 'running' }
  | { status: 'done'; result: ImportedResult; lateCancel: boolean; undo: UndoState }
  | { status: 'failed'; problem: ImportProblem | 'changed' }
  | { status: 'cancelled' }
  | { status: 'notStarted' };

export interface FileItem {
  id: string;
  file: File;
  /** Cache key in the share inbox, when the file was shared to the app. */
  sharedKey?: string;
  /** Step 1: what is in the file (read once, kept). */
  preview?: Loadable<ImportPreview>;
  destination?: Destination;
  /** "Add a new person" is open: the earlier choice is kept until a person is actually created. */
  addingPerson?: boolean;
  me?: MeChoice;
  /** The "we guessed" notice stays while the selected author is still the guess. */
  guessedMe?: string;
  dateOrder?: DateOrder;
  /** Both readings of the first date, kept once the file turned out to be ambiguous. */
  dateAmbiguity?: { dayFirst: string; monthFirst: string };
  conversation: ConversationChoice;
  /** Kept once the conversation turned out to be ambiguous, so the choice stays on screen. */
  ambiguity?: Ambiguity;
  /** Step 4: the library check for the current person, date reading and conversation. */
  check?: { key: string; state: Loadable<ImportPreview> };
  skipVideos: boolean;
  confirmed: boolean;
  run: RunState;
}

export const newItem = (id: string, file: File, sharedKey?: string): FileItem => ({
  id,
  file,
  ...(sharedKey ? { sharedKey } : {}),
  conversation: { mode: 'auto' },
  skipVideos: false,
  confirmed: false,
  run: { status: 'waiting' },
});

/** Identifies what the step 4 check was asked, so an answer for an older question is ignored. */
export const checkKey = (item: Pick<FileItem, 'destination' | 'dateOrder' | 'conversation'>): string =>
  JSON.stringify([item.destination ?? null, item.dateOrder ?? null, item.conversation]);

export const choicesOf = (item: FileItem): WizardChoices => ({
  profileIds: item.destination?.kind === 'person' ? [item.destination.id] : [],
  meAuthor: item.me?.kind === 'author' ? item.me.name : null,
  conversation: item.conversation,
  ...(item.dateOrder ? { dateOrder: item.dateOrder } : {}),
  skipVideos: item.skipVideos,
});

/** What keeps Next from moving on, if anything. `loading` is silent (the button waits); the rest are explained. */
export type Blocker = 'loading' | 'person' | 'me' | 'date' | 'conversation';

export function blockerOf(item: FileItem, step: StepId): Blocker | undefined {
  switch (step) {
    case 1:
      return item.preview?.status === 'ready' ? undefined : 'loading';
    case 2:
      return item.destination && !item.addingPerson ? undefined : 'person';
    case 3:
      return item.me ? undefined : 'me';
    case 4: {
      // The two questions the person must answer come first, even while the library is still being asked.
      if (item.dateAmbiguity && !item.dateOrder) return 'date';
      if (item.ambiguity && item.conversation.mode === 'auto') return 'conversation';
      const check = item.check;
      if (!check || check.key !== checkKey(item) || check.state.status !== 'ready') return 'loading';
      const status = check.state.value.duplicates.status;
      if (status === 'date-format') return 'date';
      if (status === 'ambiguous') return 'conversation';
      return undefined;
    }
    case 5:
      return undefined;
  }
}

/** The check once it answers the current question, or undefined. */
export function currentCheck(item: FileItem): ImportPreview | undefined {
  const check = item.check;
  if (!check || check.key !== checkKey(item) || check.state.status !== 'ready') return undefined;
  return check.state.value;
}

/** Progress of one phase as a percentage, or undefined when it cannot be told (a bar that only moves). */
export function percentOf(progress: ImportProgress | undefined): number | undefined {
  if (!progress) return undefined;
  if (progress.phase === 'saving') return undefined;
  if (progress.phase === 'media' && progress.totalBytes) return clamp(((progress.bytes ?? 0) / progress.totalBytes) * 100);
  return progress.total > 0 ? clamp((progress.done / progress.total) * 100) : undefined;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
