'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_FINDINGS_TEXT, type Findings } from '@/lib/domain/highlights';
import { isUuid } from '@/lib/domain/library';
import { listConversations } from '@/lib/usecases/conversations';
import { checkFindingsText, importFindings, type ImportFindingsResult } from '@/lib/usecases/highlights';
import { useLibraryInternals } from './use-library';

/** A conversation of the person that a file can be imported into. */
export interface ImportTarget {
  id: string;
  title: string;
}

/** One thing wrong with a file: where (a JSON path, `''` for the file itself) and a fixed message, never file content. */
export interface FindingsProblem {
  path: string;
  message: string;
}

export type ImportFindingsState =
  | { status: 'idle' }
  | { status: 'checking'; fileName: string }
  | { status: 'invalid'; fileName: string; problems: FindingsProblem[]; reason?: 'too-large' | 'unreadable' }
  | { status: 'ready'; fileName: string; findings: Findings }
  | { status: 'importing'; fileName: string; findings: Findings }
  | { status: 'done'; fileName: string; findings: Findings; result: ImportFindingsResult }
  | { status: 'error'; fileName: string; findings: Findings; reason: 'missing' | 'failed' };

/**
 * Importing a `findings.json` into one of a person's conversations: pick a file (`pick`), see it
 * checked (`invalid` lists paths and fixed messages, never the file's content), choose the
 * conversation (`target`, set when there is one or exactly one has the file's name) and `confirm`.
 * A file larger than `MAX_FINDINGS_TEXT` is refused before it is read. `reset` goes back to `idle`.
 */
export function useImportFindings(profileId: string | null, onImported?: (result: ImportFindingsResult) => void) {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [state, setState] = useState<ImportFindingsState>({ status: 'idle' });
  const [targets, setTargets] = useState<ImportTarget[] | undefined>();
  const [target, setTarget] = useState('');
  const run = useRef(0);
  const callback = useRef(onImported);
  callback.current = onImported;

  useEffect(() => {
    if (!deps || !isUuid(profileId)) return;
    let alive = true;
    listConversations(deps, { profileId }).then(
      (rows) => alive && setTargets(rows.map((r) => ({ id: r.id, title: r.title }))),
      () => alive && setTargets([]),
    );
    return () => {
      alive = false;
    };
  }, [deps, profileId]);

  const pick = useCallback(
    async (file: File) => {
      const mine = ++run.current;
      const fileName = file.name;
      const settle = (next: ImportFindingsState) => {
        if (mine === run.current) setState(next);
      };
      if (file.size > MAX_FINDINGS_TEXT) return settle({ status: 'invalid', fileName, problems: [], reason: 'too-large' });
      setState({ status: 'checking', fileName });
      let text: string;
      try {
        text = await file.text();
      } catch {
        return settle({ status: 'invalid', fileName, problems: [], reason: 'unreadable' });
      }
      const checked = checkFindingsText(text);
      if (!checked.ok) return settle({ status: 'invalid', fileName, problems: checked.errors.map(({ path, message }) => ({ path, message })) });
      if (mine !== run.current) return;
      setTarget((now) => {
        if (targets?.some((t) => t.id === now)) return now;
        const named = targets?.filter((t) => t.title === checked.findings.conversation.name) ?? [];
        return targets?.length === 1 ? targets[0].id : named.length === 1 ? named[0].id : '';
      });
      setState({ status: 'ready', fileName, findings: checked.findings });
    },
    [targets],
  );

  const confirm = useCallback(async () => {
    if (!deps || (state.status !== 'ready' && state.status !== 'error')) return;
    if (!targets?.some((t) => t.id === target)) return;
    const { fileName, findings } = state;
    const mine = ++run.current;
    setState({ status: 'importing', fileName, findings });
    try {
      const result = await importFindings(deps, target, findings);
      if (mine !== run.current) return;
      setState({ status: 'done', fileName, findings, result });
      callback.current?.(result);
    } catch (error) {
      if (mine !== run.current) return;
      setState({ status: 'error', fileName, findings, reason: (error as { code?: string }).code === 'not-found' ? 'missing' : 'failed' });
    }
  }, [deps, state, target, targets]);

  const reset = useCallback(() => {
    run.current++;
    setState({ status: 'idle' });
  }, []);

  return { state, targets, target, setTarget, pick, confirm, reset };
}
