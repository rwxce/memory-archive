'use client';

import { useId, useRef } from 'react';
import { FileUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { useImportFindings } from '@/hooks/use-import-findings';
import type { ImportFindingsResult } from '@/lib/usecases/highlights';

/**
 * Importing a findings file into one of a person's conversations: choose the file, see what is
 * wrong with it (paths and fixed messages only, never its content) or what it holds, choose the
 * conversation, confirm, and read what happened. Names from the file or the archive are shown as
 * text. Importing the same file twice is safe, and the note says so in plain words.
 */
export function HighlightsImport({ personId, onImported }: { personId: string; onImported: (result: ImportFindingsResult) => void }) {
  const t = useTranslations('highlightsImport');
  const { state, targets, target, setTarget, pick, confirm, reset } = useImportFindings(personId, onImported);
  const input = useRef<HTMLInputElement>(null);
  const selectId = useId();
  const busy = state.status === 'checking' || state.status === 'importing';
  const choose = () => input.current?.click();
  const hasTargets = (targets?.length ?? 0) > 0;

  return (
    <SectionCard className="gap-3.5 p-[18px]" aria-labelledby="highlights-import-title">
      <Eyebrow as="h2" id="highlights-import-title" tone="muted" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      <p className="text-t2 text-sm leading-relaxed">{t('description')}</p>

      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void pick(file);
        }}
      />

      {targets && !hasTargets ? (
        <p className="text-t2 leading-relaxed">{t('noConversations')}</p>
      ) : (
        <>
          {(state.status === 'idle' || state.status === 'invalid') && (
            <div>
              <PillButton variant="outlined" onClick={choose} disabled={!targets}>
                <FileUp aria-hidden />
                {state.status === 'invalid' ? t('chooseAnother') : t('choose')}
              </PillButton>
            </div>
          )}

          <div role="status" className="text-t2 text-sm break-words">
            {state.status === 'checking' && t('checking')}
            {state.status === 'importing' && t('importing')}
          </div>

          {state.status === 'invalid' && (
            <div role="alert" className="flex flex-col gap-2 text-sm">
              <p dir="auto" className="text-foreground font-medium break-words">
                {t('file', { name: state.fileName })}
              </p>
              {state.reason === 'too-large' ? (
                <p>{t('tooLarge')}</p>
              ) : state.reason === 'unreadable' ? (
                <p>{t('unreadable')}</p>
              ) : (
                <>
                  <p className="font-medium">{t('invalid')}</p>
                  <ul className="flex flex-col gap-1.5">
                    {state.problems.map((problem, index) => (
                      <li key={index} className="break-words">
                        <code className="bg-sf2 rounded px-1.5 py-0.5 text-xs break-all">{problem.path || t('wholeFile')}</code> {problem.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {(state.status === 'ready' || state.status === 'importing' || state.status === 'error') && (
            <div className="flex flex-col gap-3.5">
              <p className="text-sm leading-relaxed break-words">
                <span dir="auto" className="font-medium">
                  {t('file', { name: state.fileName })}
                </span>
                <br />
                {t('found', { count: state.findings.highlights.length, name: state.findings.conversation.name })}
              </p>

              {targets && targets.length > 1 ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={selectId} className="text-sm font-medium">
                    {t('target')}
                  </label>
                  <select
                    id={selectId}
                    value={target}
                    disabled={busy}
                    onChange={(event) => setTarget(event.target.value)}
                    dir="auto"
                    className="bg-bg border-line focus-visible:ring-ring/50 min-h-11 w-full max-w-md rounded-xl border px-3 text-base outline-none focus-visible:ring-[3px]"
                  >
                    <option value="">{t('targetPlaceholder')}</option>
                    {targets.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.title}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                targets?.[0] && (
                  <p className="text-sm break-words">
                    {t('targetOne', { title: targets[0].title })}
                  </p>
                )
              )}

              {state.status === 'error' && (
                <p role="alert" className="text-destructive text-sm">
                  {state.reason === 'missing' ? t('failedMissing') : t('failed')}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <PillButton variant="outlined" onClick={reset} disabled={busy}>
                  {t('cancel')}
                </PillButton>
                <PillButton onClick={() => void confirm()} disabled={busy || target === ''}>
                  {state.status === 'importing' ? t('importing') : t('confirm')}
                </PillButton>
              </div>
            </div>
          )}

          {state.status === 'done' && (
            <div className="flex flex-col gap-3 text-sm">
              <p role="status" className="font-medium">
                {t('doneTitle')}
              </p>
              <ul className="flex list-disc flex-col gap-1 ps-5">
                <li>{t('resultImported', { count: state.result.imported })}</li>
                <li>{t('resultUpdated', { count: state.result.updated })}</li>
                <li>{t('resultUnchanged', { count: state.result.unchanged })}</li>
                {state.result.skippedHighlights.length > 0 && <li>{t('resultSkipped', { count: state.result.skippedHighlights.length })}</li>}
                {state.result.skippedFingerprints > 0 && <li>{t('resultMissing', { count: state.result.skippedFingerprints })}</li>}
              </ul>
              {state.result.warnings.length > 0 && (
                <div className="bg-sf2 flex flex-col gap-1.5 rounded-2xl p-3.5">
                  <p className="font-medium">{t('warningsTitle')}</p>
                  <ul className="flex list-disc flex-col gap-1 ps-5">
                    {state.result.warnings.map((warning) => (
                      <li key={warning}>{t(`warning.${warning}`)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <PillButton variant="outlined" onClick={reset}>
                  {t('importAnother')}
                </PillButton>
              </div>
            </div>
          )}
        </>
      )}

      <p className="text-mu text-sm leading-relaxed">{t('safeNote')}</p>
    </SectionCard>
  );
}
