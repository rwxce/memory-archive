'use client';

import { useCallback, useRef, useState } from 'react';
import { ArchiveError, type ArchiveErrorCode } from '@/lib/usecases/archive-backup';
import { confirmChangesPackDelivered, exportChangesPack, type ExportChangesPackResult } from '@/lib/usecases/changes-pack-export';
import { downloadBlob } from './download-blob';
import { retryWhileBusy } from './retry-busy';
import { throttleProgress, type PackProgress } from './throttle-progress';
import { useLibraryInternals } from './use-library';

/** What the screen keeps of a pack after the file was handed to the browser: never the file itself. */
export type SavedPack = Pick<ExportChangesPackResult, 'peerId' | 'sourceDeviceId' | 'upTo' | 'since' | 'kind' | 'fileName' | 'encrypted' | 'counts'>;

export type ChangesPackExportState =
  | { status: 'idle' }
  | { status: 'working'; progress: PackProgress }
  /** There was nothing to put in a pack: no file was made and nothing was recorded. */
  | { status: 'nothing' }
  /**
   * The file was handed to the browser. `confirmable` is false for a pack cut for a device not known yet: there is
   * nothing to record, the other device's first pack back tells this one what it has. `problem` is set when
   * recording the hand-over failed (`library-replaced`: this archive was replaced after the pack was made).
   */
  | { status: 'saved'; pack: SavedPack; confirmable: boolean; recording: boolean; problem?: 'library-replaced' | 'unknown' }
  /** The person said they handed it over and it was recorded; `recorded` is false when the record had moved on meanwhile (nothing is lost). */
  | { status: 'handed'; pack: SavedPack; recorded: boolean }
  /** The person has not handed it over (yet): nothing was recorded, the next pack covers the same changes. */
  | { status: 'not-handed'; pack: SavedPack }
  | { status: 'failed'; code: ArchiveErrorCode | 'unknown' };

export interface ChangesPackExport {
  state: ChangesPackExportState;
  /** `peerId: null` = a device not known yet (a full pack). `full` sends everything to a known peer. The password is used for this call only. */
  exportPack(options: { peerId: string | null; full?: boolean; password?: string }): Promise<void>;
  /** Records that the person gave the file to the other device. Call it only after they said so. */
  confirmDelivered(): Promise<void>;
  /** The person did not hand the file over: nothing is recorded. */
  notHanded(): void;
  reset(): void;
}

/** A database refusal of the request (`DbError` `invalid`); hooks do not reach the db layer, so it is recognised by its shape. */
const isInvalidDbError = (error: unknown) => error instanceof Error && error.name === 'DbError' && (error as { code?: string }).code === 'invalid';

const isEmpty = (pack: Pick<ExportChangesPackResult, 'counts' | 'kind'>) => pack.kind === 'changes' && Object.values(pack.counts).every((n) => n === 0);

/** "Export changes pack": one at a time, with progress, a typed failure, and the delivery recorded only on the person's say-so. */
export function useChangesPackExport(onChange?: () => void): ChangesPackExport {
  const { state: library } = useLibraryInternals();
  const [state, setState] = useState<ChangesPackExportState>({ status: 'idle' });
  const busy = useRef(false);
  /** The latest state, for the guard below (a click can come before the next render). */
  const latest = useRef(state);
  latest.current = state;

  const exportPack = useCallback(
    async (options: { peerId: string | null; full?: boolean; password?: string }) => {
      if (library.status !== 'ready' || busy.current) return;
      // A hand-over question is still open: answer it first (the screen disables the button; this is the belt).
      if (latest.current.status === 'saved' && latest.current.confirmable) return;
      const deps = library.deps;
      busy.current = true;
      setState({ status: 'working', progress: { phase: 'preparing' } });
      const progress = throttleProgress((p) => setState({ status: 'working', progress: p }));
      try {
        const pack = await retryWhileBusy(() =>
          exportChangesPack(deps, {
            appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
            peerId: options.peerId,
            full: options.full,
            // Passed through unchanged: an empty string must reach the core, which refuses it (fail closed).
            password: options.password,
            onProgress: progress,
            onCryptoProgress: (p) => progress({ phase: 'encrypting', ...p }),
          }),
        );
        if (isEmpty(pack)) {
          setState({ status: 'nothing' });
          return;
        }
        // Still inside the click's continuation: the browser counts the download as the person's action.
        downloadBlob(pack.blob, pack.fileName);
        const { blob: _file, ...saved } = pack;
        setState({ status: 'saved', pack: saved, confirmable: saved.peerId !== null, recording: false });
      } catch (error) {
        setState({ status: 'failed', code: error instanceof ArchiveError ? error.code : 'unknown' });
      } finally {
        busy.current = false;
      }
    },
    [library],
  );

  const confirmDelivered = useCallback(async () => {
    if (library.status !== 'ready' || busy.current || state.status !== 'saved' || !state.confirmable) return;
    const { pack } = state;
    busy.current = true;
    setState({ ...state, recording: true, problem: undefined });
    try {
      const result = await confirmChangesPackDelivered(library.deps, pack);
      setState({ status: 'handed', pack, recorded: result.recorded });
      onChange?.();
    } catch (error) {
      setState({ status: 'saved', pack, confirmable: true, recording: false, problem: isInvalidDbError(error) ? 'library-replaced' : 'unknown' });
    } finally {
      busy.current = false;
    }
  }, [library, state, onChange]);

  const notHanded = useCallback(() => {
    if (state.status === 'saved') setState({ status: 'not-handed', pack: state.pack });
  }, [state]);

  const reset = useCallback(() => {
    if (!busy.current) setState({ status: 'idle' });
  }, []);

  return { state, exportPack, confirmDelivered, notHanded, reset };
}
