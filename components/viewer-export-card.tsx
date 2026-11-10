'use client';

import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Outcome } from '@/components/backup-check-cards';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { PackProgressBar } from '@/components/sync-progress';
import { usePeople } from '@/hooks/use-people';
import { useViewerExport } from '@/hooks/use-viewer-export';
import { EXPORT_FORMATS, type ExportFormat, type ExportLang, type ExportSplit } from '@/lib/usecases/export-package';

const checkClass = 'accent-primary focus-visible:ring-ring/50 mt-0.5 size-5 shrink-0 outline-none focus-visible:ring-[3px]';
const inputClass =
  'bg-bg border-input h-11 min-w-0 rounded-xl border px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]';

/**
 * "Export a copy": choose a format (viewer, web pages, Markdown, JSON), whose conversations, an optional period and
 * whether photos and videos go in, then make a ZIP. It reads the archive and changes nothing, so it can run beside other
 * archive tasks. The browser is handed the file from the click.
 */
export function ViewerExportCard() {
  const t = useTranslations('backup.viewer');
  const people = usePeople();
  const viewer = useViewerExport();
  const noteId = useId();
  const formatName = useId();
  const splitName = useId();
  const personParam = useSearchParams()?.get('person') ?? null;
  // `null` = the default choice; once the person touches the list it holds exactly the ids that are ticked.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeMedia, setIncludeMedia] = useState(true);
  const [format, setFormat] = useState<ExportFormat>('viewer');
  const [split, setSplit] = useState<ExportSplit>('together');
  const lang = useLocale() as ExportLang;

  // Arriving from Settings (`/backup#viewer-export`): bring the card into view once, without animation.
  useEffect(() => {
    if (window.location.hash === '#viewer-export') document.getElementById('viewer-export')?.scrollIntoView({ block: 'start' });
  }, []);

  const everyone = people.status === 'ready' ? [...people.people.active, ...people.people.archived] : [];
  // Arriving from a person's menu (`?person=<id>`) starts with only that person; an unknown id changes nothing.
  const preselected = personParam && everyone.some((person) => person.id === personParam) ? new Set([personParam]) : null;
  const ticked = picked ?? preselected;
  const chosen = ticked ? everyone.filter((person) => ticked.has(person.id)) : everyone;
  const allChosen = chosen.length === everyone.length;
  const working = viewer.state.status === 'working';
  const none = people.status === 'ready' && chosen.length === 0;
  const canSplit = format !== 'viewer' && chosen.length > 1;
  const unavailable = people.status !== 'ready' || none || working;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen.map((person) => person.id));
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const toggleAll = () => setPicked(allChosen ? new Set() : new Set(everyone.map((person) => person.id)));

  return (
    <SectionCard id="viewer-export" className="scroll-mt-4 gap-4 p-[18px]" aria-labelledby="viewer-export-title" data-testid="viewer-export">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="viewer-export-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
        <p className="text-t2 leading-relaxed">{t('phoneNote')}</p>
        <p className="text-t2 leading-relaxed">{t('notBackup')}</p>
      </div>

      <fieldset className="flex flex-col gap-1" disabled={working}>
        <legend className="mb-1 text-[15px] font-medium">{t('formatLegend')}</legend>
        {EXPORT_FORMATS.map((option) => (
          <label key={option} className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5 text-[15px]">
            <input type="radio" name={formatName} className={checkClass} value={option} checked={format === option} onChange={() => setFormat(option)} />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{t(`formats.${option}.label`)}</span>
              <span className="text-t2 text-sm leading-relaxed">{t(`formats.${option}.help`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1" aria-describedby={none ? noteId : undefined}>
        <legend className="mb-1 text-[15px] font-medium">{t('peopleLegend')}</legend>
        {everyone.length > 1 && (
          <div>
            <button
              type="button"
              data-testid="viewer-export-select-all"
              disabled={working}
              onClick={toggleAll}
              className="text-primary focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-xl px-1 text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] disabled:opacity-50"
            >
              {allChosen ? t('selectNone') : t('selectAll')}
            </button>
          </div>
        )}
        {people.status === 'ready' && everyone.length === 0 && <p className="text-t2 text-sm">{t('noPeople')}</p>}
        {everyone.map((person) => (
          <label key={person.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
            <input type="checkbox" className={checkClass} disabled={working} checked={chosen.some((c) => c.id === person.id)} onChange={(event) => toggle(person.id, event.target.checked)} />
            <span className="min-w-0 break-words">
              {person.displayName}
              {person.archivedAt ? <span className="text-t2"> ({t('archivedTag')})</span> : null}
            </span>
          </label>
        ))}
        {none && everyone.length > 0 && (
          <p id={noteId} className="text-destructive text-sm">
            {t('noPeopleSelected')}
          </p>
        )}
      </fieldset>

      {canSplit && (
        <fieldset className="flex flex-col gap-1" disabled={working}>
          <legend className="mb-1 text-[15px] font-medium">{t('splitLegend')}</legend>
          {(['together', 'perProfile'] as const).map((option) => (
            <label key={option} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
              <input type="radio" name={splitName} className={checkClass} value={option} checked={split === option} onChange={() => setSplit(option)} />
              {t(`split.${option}`)}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[15px] font-medium">{t('datesLegend')}</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <label className="flex flex-col gap-1 text-sm">
            {t('from')}
            <input type="date" className={inputClass} value={from} max={to || undefined} disabled={working} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('to')}
            <input type="date" className={inputClass} value={to} min={from || undefined} disabled={working} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        <p className="text-t2 text-sm leading-relaxed">{t('datesHint')}</p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] font-medium">
          <input type="checkbox" className={checkClass} disabled={working} checked={includeMedia} onChange={(event) => setIncludeMedia(event.target.checked)} />
          {t('includeMedia')}
        </label>
        <p className="text-t2 text-sm leading-relaxed">{t('includeMediaNote')}</p>
      </div>

      <div>
        <PillButton
          aria-disabled={unavailable || undefined}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => {
            if (unavailable) return;
            void viewer.exportCopy({
              format,
              selection: { profileIds: chosen.map((person) => person.id), from: from || null, to: to || null, includeMedia },
              split: canSplit ? split : 'together',
              lang,
            });
          }}
        >
          {t('submit')}
        </PillButton>
      </div>

      {viewer.state.status === 'working' && <PackProgressBar label={t('progressLabel')} progress={viewer.state.progress} />}
      {viewer.state.status === 'failed' && (
        <Outcome icon="attention" testId="viewer-export-result">
          <p role="alert">{t(`error.${viewer.state.error}`)}</p>
        </Outcome>
      )}
      {viewer.state.status === 'done' && (
        <Outcome icon="ok" title={t('savedTitle')} testId="viewer-export-result">
          <div role="status" className="flex flex-col gap-1.5">
            <p className="break-words">{t('saved', { fileName: viewer.state.copy.fileName })}</p>
            <p>{viewer.state.copy.includeMedia ? t('savedMedia', { count: viewer.state.copy.mediaCount }) : t('savedNoMedia')}</p>
            {viewer.state.copy.includeMedia && viewer.state.copy.missingMedia > 0 && <p>{t('savedMissing', { count: viewer.state.copy.missingMedia })}</p>}
          </div>
          <div>
            <PillButton variant="outlined" onClick={viewer.reset}>
              {t('another')}
            </PillButton>
          </div>
        </Outcome>
      )}
    </SectionCard>
  );
}
