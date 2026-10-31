'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ImportChoose } from '@/components/import-choose';
import { ImportDone, ImportRunning } from '@/components/import-run';
import { checkKey, choicesOf, newItem, percentOf, type FileItem, type RunState, type StepId, type UndoState } from '@/components/import-types';
import { ImportWizard, type WizardActions } from '@/components/import-wizard';
import { LibraryNotice } from '@/components/library-notice';
import type { ProfileFormValues } from '@/components/profile-form';
import { Shell } from '@/components/screen-shell';
import { PillButton } from '@/components/pill-button';
import { peekArchiveFile } from '@/hooks/peek-archive-file';
import { useSharedInbox } from '@/hooks/use-device-storage';
import { useImportActions } from '@/hooks/use-import';
import { useLibrary } from '@/hooks/use-library';
import { usePeople, useProfileActions } from '@/hooks/use-people';
import type { ImportProgress } from '@/lib/usecases/import';
import { guessedMe, importProblemOf, isImportableExport } from '@/lib/usecases/import-wizard';

type Phase = 'choose' | 'setup' | 'run' | 'done';

/**
 * The import wizard for WhatsApp exports (ZIP, or the plain .txt made without media). Choose files (picked, dropped or shared from
 * WhatsApp), go through five steps for each (what is in it, who it is for, which one is you,
 * what is new, check and confirm), then the files are added one after the other with progress
 * and a way to cancel, and the result of each is told in plain words with a way to undo it.
 *
 * Nothing is written until the last confirmation. A preview never writes (it runs in its own
 * worker); the person is created at step 2 on purpose (an empty person is a normal thing to
 * have), everything else waits. The state of every file is kept while the person goes back and
 * forth, so no choice is asked twice.
 */
export function ImportScreen() {
  const { state, retry } = useLibrary();
  const t = useTranslations('import');
  if (state.status !== 'ready') {
    return (
      <Shell>
        <h1 className="font-display text-display">{t('title')}</h1>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <ImportContent onRetry={retry} />;
}

function ImportContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('import');
  const tp = useTranslations('people');
  const tl = useTranslations('library');
  const people = usePeople();
  const profiles = useProfileActions();
  const importActions = useImportActions();
  const inbox = useSharedInbox();

  const [items, setItems] = useState<FileItem[]>([]);
  const [phase, setPhase] = useState<Phase>('choose');
  const [position, setPosition] = useState<{ index: number; step: StepId }>({ index: 0, step: 1 });
  const [message, setMessage] = useState('');
  const [skipped, setSkipped] = useState(0);
  /** Files that are changes files from another device: not chats, so they are left out and pointed to Sync devices. */
  const [syncFiles, setSyncFiles] = useState(0);
  const [progress, setProgress] = useState<ImportProgress>();
  const [cancelling, setCancelling] = useState(false);

  // Latest values for callbacks that outlive a render (workers answer later).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const actionsRef = useRef(importActions);
  actionsRef.current = importActions;
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const messages = useRef({ t, tp });
  messages.current = { t, tp };

  const jobs = useRef(new Map<string, AbortController>());
  const runAbort = useRef<AbortController>(undefined);
  const nextId = useRef(0);
  /** Batches of files whose kind is still being read. */
  const peeking = useRef(0);
  const seenShared = useRef(new Set<string>());
  const chooseHeading = useRef<HTMLHeadingElement>(null);
  const runHeading = useRef<HTMLHeadingElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  const patch = useCallback((id: string, change: Partial<FileItem> | ((current: FileItem) => Partial<FileItem>)) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...(typeof change === 'function' ? change(item) : change) } : item)));
  }, []);

  // ── files ──────────────────────────────────────────────────────────────────────────────────
  const add = useCallback((files: File[], sharedKeys: (string | undefined)[] = []) => {
    const accepted = files.map((file, i) => ({ file, key: sharedKeys[i] })).filter(({ file }) => isImportableExport(file));
    setSkipped(files.length - accepted.length);
    // A new count starts only when no other batch is still being looked at; otherwise it adds to theirs.
    if (peeking.current === 0) setSyncFiles(0);
    // Pick order is fixed now, before any file is looked at: a quick file must not jump the queue.
    const ids = accepted.map(() => nextId.current++);
    peeking.current++;
    void (async () => {
      try {
        // A changes file looks like any other ZIP: its manifest says what it is, never its name.
        const kinds = await Promise.all(accepted.map(({ file }) => peekArchiveFile(file)));
        const packs = accepted.filter((_, i) => kinds[i] === 'changes-pack').length;
        if (packs > 0) setSyncFiles((count) => count + packs);
        // A shared changes file stays in the inbox: Sync devices lists it and adds or removes it from there.
        const chats = accepted.map((entry, i) => ({ ...entry, seq: ids[i] })).filter((_, i) => kinds[i] !== 'changes-pack');
        setItems((list) => {
          const same = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
          const fresh = chats.filter(({ file }) => !list.some((item) => same(item.file, file)));
          const added = fresh.map(({ file, key, seq }) => newItem(`file-${seq}`, file, key));
          return [...list, ...added].sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
        });
      } finally {
        peeking.current--;
      }
    })();
  }, []);

  // Files shared from WhatsApp are offered in the same list, once each.
  useEffect(() => {
    const shared = inbox.files;
    if (!shared) return;
    const fresh = shared.filter((info) => !seenShared.current.has(info.key));
    if (fresh.length === 0) return;
    fresh.forEach((info) => seenShared.current.add(info.key));
    const zips = fresh.filter(isImportableExport);
    // A shared file that cannot be imported is not kept: it is a private chat file, and nothing here will ever use it.
    for (const info of fresh) if (!isImportableExport(info)) void inbox.discard(info.key);
    void Promise.all(zips.map((info) => inbox.take(info))).then((read) => {
      const present = zips.map((info, i) => ({ info, file: read[i] })).filter((entry): entry is { info: typeof entry.info; file: File } => !!entry.file);
      add(
        present.map((entry) => entry.file),
        present.map((entry) => entry.info.key),
      );
      if (fresh.length > present.length) setSkipped(fresh.length - present.length);
    });
  }, [inbox, add]);

  const stopJobs = useCallback((id: string) => {
    for (const kind of ['preview', 'check']) {
      jobs.current.get(`${kind}:${id}`)?.abort();
      jobs.current.delete(`${kind}:${id}`);
    }
  }, []);

  const remove = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      stopJobs(id);
      if (item?.sharedKey) void inboxRef.current.discard(item.sharedKey);
      setItems((list) => list.filter((candidate) => candidate.id !== id));
      setPhase('choose');
      setPosition({ index: 0, step: 1 });
    },
    [stopJobs],
  );

  // ── previews and checks (read-only, each in its own worker) ───────────────────────────────
  const startPreview = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item) return;
      jobs.current.get(`preview:${id}`)?.abort();
      const controller = new AbortController();
      jobs.current.set(`preview:${id}`, controller);
      patch(id, { preview: { status: 'loading' } });
      try {
        // Without a person yet: only what is in the file. "new" skips the library lookups.
        const value = await actionsRef.current.preview(
          item.file,
          { profileIds: [], conversation: { mode: 'new' } },
          {
            signal: controller.signal,
            onProgress: (p) => p.phase === 'reading' && patch(id, { preview: { status: 'loading', done: p.done } }),
          },
        );
        if (controller.signal.aborted) return;
        const guess = guessedMe(value);
        patch(id, (current) => ({
          preview: { status: 'ready', value },
          // The guess is pre-selected, visibly (the step says so); a choice already made is kept.
          ...(current.me === undefined
            ? guess !== null
              ? { me: { kind: 'author' as const, name: guess }, guessedMe: guess }
              : value.authors.length === 0
                ? { me: { kind: 'none' as const } }
                : {}
            : {}),
          ...(value.dateFormat.ambiguous && value.dateFormat.preview ? { dateAmbiguity: value.dateFormat.preview } : {}),
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        patch(id, { preview: { status: 'error', problem: importProblemOf(error) } });
      }
    },
    [patch],
  );

  const startCheck = useCallback(
    async (id: string, force = false) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item) return;
      // Nothing to ask the library until the dates are read one way: the person chooses first.
      if (item.dateAmbiguity && !item.dateOrder) return;
      const key = checkKey(item);
      if (!force && item.check?.key === key) return;
      jobs.current.get(`check:${id}`)?.abort();
      const controller = new AbortController();
      jobs.current.set(`check:${id}`, controller);
      patch(id, { check: { key, state: { status: 'loading' } } });
      const choices = choicesOf(item);
      try {
        const value = await actionsRef.current.preview(item.file, choices, { signal: controller.signal });
        if (controller.signal.aborted) return;
        patch(id, (current) => {
          // An answer to an older question is ignored.
          if (current.check?.key !== key) return {};
          const { duplicates } = value;
          return {
            check: { key, state: { status: 'ready', value } },
            ...(duplicates.status === 'ambiguous' ? { ambiguity: { reason: duplicates.reason, candidates: duplicates.candidates } } : {}),
            ...(duplicates.status === 'date-format' && value.dateFormat.preview ? { dateAmbiguity: value.dateFormat.preview } : {}),
          };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        patch(id, (current) => (current.check?.key === key ? { check: { key, state: { status: 'error', problem: importProblemOf(error) } } } : {}));
      }
    },
    [patch],
  );

  // ── the run ────────────────────────────────────────────────────────────────────────────────
  const startRun = useCallback(async () => {
    const controller = new AbortController();
    runAbort.current = controller;
    const { signal } = controller;
    const queue = itemsRef.current.filter((item) => item.run.status !== 'done');
    setCancelling(false);
    setProgress(undefined);
    setMessage('');
    setPhase('run');
    for (const entry of queue) patch(entry.id, { run: { status: 'waiting' } });

    for (const entry of queue) {
      if (signal.aborted) {
        patch(entry.id, { run: { status: 'notStarted' } });
        continue;
      }
      patch(entry.id, { run: { status: 'running' } });
      setProgress(undefined);
      let lastPhase: ImportProgress['phase'] | undefined;
      let lastBucket = -1;
      let lastPaint = 0;
      const onProgress = (p: ImportProgress) => {
        const now = Date.now();
        // Painted at most a few times a second; the announcement is rarer still: each phase, then every quarter.
        if (p.phase !== lastPhase || now - lastPaint >= 120) {
          lastPaint = now;
          setProgress(p);
        }
        const percent = percentOf(p);
        const bucket = percent === undefined ? -1 : Math.floor(percent / 25);
        const label = messages.current.t(`run.${p.phase}`);
        if (p.phase !== lastPhase) {
          lastPhase = p.phase;
          lastBucket = bucket;
          setMessage(label);
        } else if (bucket > lastBucket && bucket < 4) {
          lastBucket = bucket;
          setMessage(`${label} ${percent}%`);
        }
      };
      try {
        const result = await actionsRef.current.run(entry.file, choicesOf(entry), { signal, onProgress });
        if (result.status !== 'imported') {
          patch(entry.id, { run: { status: 'failed', problem: 'changed' } });
        } else {
          // `lateCancel`: the cancel arrived after the save began, so the import completed.
          patch(entry.id, { run: { status: 'done', result, lateCancel: signal.aborted, undo: 'idle' } });
          // Imported: the copy kept for the import is no longer needed.
          if (entry.sharedKey) void inboxRef.current.discard(entry.sharedKey);
        }
      } catch (error) {
        const cancelled = signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
        const run: RunState = cancelled ? { status: 'cancelled' } : { status: 'failed', problem: importProblemOf(error) };
        patch(entry.id, { run });
      }
    }
    runAbort.current = undefined;
    setCancelling(false);
    setProgress(undefined);
    setMessage('');
    setPhase('done');
  }, [patch]);

  const cancel = useCallback(() => {
    setCancelling(true);
    runAbort.current?.abort();
  }, []);

  // Closing the page or reloading while files are being added: the browser asks first.
  useEffect(() => {
    if (phase !== 'run') return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  // Leaving the screen stops what it started: previews are read-only, an import before its save step changes nothing.
  useEffect(() => {
    const running = jobs.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      runAbort.current?.abort();
    };
  }, []);

  // An announcement ("Mama was added.") is for the moment; it does not stay on screen into the next step.
  useEffect(() => {
    if (phase === 'setup') setMessage('');
  }, [phase, position.index, position.step]);

  // Focus follows the screen: the heading of what just appeared.
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    if (phase === 'choose') chooseHeading.current?.focus();
    if (phase === 'run') runHeading.current?.focus();
    if (phase === 'done') doneHeading.current?.focus();
  }, [phase]);

  // ── undo ───────────────────────────────────────────────────────────────────────────────────
  const setUndo = useCallback(
    (id: string, undo: UndoState) => patch(id, (current) => (current.run.status === 'done' ? { run: { ...current.run, undo } } : {})),
    [patch],
  );
  const undo = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item || item.run.status !== 'done') return;
      setUndo(id, 'working');
      try {
        const result = await actionsRef.current.undo(item.run.result.batchId);
        setUndo(id, result.found ? { removed: result.removedMessages } : 'gone');
        // No live-region message: the outcome takes the focus, which reads it.
      } catch {
        setUndo(id, 'failed');
      }
    },
    [setUndo],
  );

  // ── navigation ─────────────────────────────────────────────────────────────────────────────
  const index = Math.min(position.index, Math.max(0, items.length - 1));
  const current = items[index];

  const createPerson = useCallback(
    async (values: ProfileFormValues): Promise<string> => {
      const id = itemsRef.current[index]?.id;
      const created = await profiles.create(values);
      if (id) {
        patch(id, {
          destination: { kind: 'person', id: created.id, name: created.displayName },
          addingPerson: false,
          conversation: { mode: 'auto' },
          ambiguity: undefined,
        });
      }
      setMessage(messages.current.tp('created', { name: created.displayName }));
      return created.id;
    },
    [profiles, patch, index],
  );

  const confirmAndContinue = useCallback(() => {
    const id = itemsRef.current[index]?.id;
    if (!id) return;
    patch(id, { confirmed: true });
    const list = itemsRef.current;
    const later = list.findIndex((item, i) => i > index && !item.confirmed);
    const any = later >= 0 ? later : list.findIndex((item) => item.id !== id && !item.confirmed);
    if (any >= 0) setPosition({ index: any, step: 1 });
    else void startRun();
  }, [index, patch, startRun]);

  const wizardActions = useMemo<WizardActions | undefined>(() => {
    if (!current) return undefined;
    const id = current.id;
    return {
      patch: (change) => patch(id, change),
      ensurePreview: () => {
        if (!itemsRef.current.find((item) => item.id === id)?.preview) void startPreview(id);
      },
      retryPreview: () => void startPreview(id),
      ensureCheck: () => void startCheck(id),
      retryCheck: () => void startCheck(id, true),
      createPerson,
      remove: () => remove(id),
      toFiles: () => setPhase('choose'),
      back: () => {
        // Leaving the step closes an open new-person form; the earlier choice stays.
        patch(id, { addingPerson: false });
        setPosition((p) => (p.step > 1 ? { index: p.index, step: (p.step - 1) as StepId } : { index: Math.max(0, p.index - 1), step: 5 }));
      },
      next: () => {
        if (position.step < 5) setPosition({ index, step: (position.step + 1) as StepId });
        else confirmAndContinue();
      },
    };
  }, [current, patch, startPreview, startCheck, createPerson, remove, position.step, index, confirmAndContinue]);

  const review = useCallback(
    (id: string) => {
      const at = itemsRef.current.findIndex((item) => item.id === id);
      patch(id, { confirmed: false, check: undefined, ambiguity: undefined, conversation: { mode: 'auto' }, run: { status: 'waiting' } });
      setPosition({ index: Math.max(0, at), step: 4 });
      setPhase('setup');
    },
    [patch],
  );

  const another = useCallback(() => {
    setItems([]);
    setSkipped(0);
    setPosition({ index: 0, step: 1 });
    setPhase('choose');
  }, []);

  const peopleReady = people.status === 'ready' ? people.people : undefined;

  return (
    <Shell message={message} focused={phase === 'setup' || phase === 'run'}>
      {phase !== 'choose' && <h1 className="sr-only">{t('title')}</h1>}

      {phase === 'choose' && (
        <ImportChoose
          items={items}
          skipped={skipped}
          syncFiles={syncFiles}
          headingRef={chooseHeading}
          onAdd={(files) => add(files)}
          onRemove={remove}
          onContinue={() => {
            setPosition({ index: Math.max(0, items.findIndex((item) => !item.confirmed)), step: 1 });
            setPhase('setup');
          }}
        />
      )}

      {phase === 'setup' &&
        current &&
        wizardActions &&
        (peopleReady ? (
          <ImportWizard item={current} items={items} index={index} step={position.step} people={peopleReady} actions={wizardActions} />
        ) : people.status === 'error' ? (
          <section role="alert" className="bg-sf lg:in-data-panel:bg-bg flex flex-col gap-3 rounded-3xl p-5">
            <p>{t('loadFailed')}</p>
            <div>
              <PillButton variant="outlined" onClick={onRetry}>
                {tl('retry')}
              </PillButton>
            </div>
          </section>
        ) : (
          <LibraryNotice state={{ status: 'loading' }} onRetry={onRetry} />
        ))}

      {phase === 'run' && (
        <ImportRunning items={items} progress={progress} cancelling={cancelling} headingRef={runHeading} onCancel={cancel} />
      )}

      {phase === 'done' && (
        <ImportDone
          items={items}
          headingRef={doneHeading}
          onUndoAsk={(id) => setUndo(id, 'confirming')}
          onUndoCancel={(id) => setUndo(id, 'idle')}
          onUndo={(id) => void undo(id)}
          onReview={review}
          onRetry={() => void startRun()}
          onAnother={another}
        />
      )}
    </Shell>
  );
}
