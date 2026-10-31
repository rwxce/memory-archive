'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PeopleState } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import { PHOTO_ASSIGN_PROFILES_MAX } from '@/lib/domain/photo';
import type { Person } from '@/lib/usecases/library';
import { PersonAvatar } from './person-avatar';
import { PillButton } from './pill-button';
import { NAME_IN_ROW, safeName } from './safe-name';

const SEARCH_FROM = 8;

interface Props {
  open: boolean;
  count: number;
  people: PeopleState;
  working: boolean;
  onConfirm(profileIds: string[]): void;
  onCancel(): void;
}

/**
 * Asks who the chosen pictures are for, then asks once more, in words, before anything is written. A native
 * modal `<dialog>`: focus is trapped and returned by the browser, Escape cancels. Step one is a list of people
 * to tick (a search box above 8, archived people last and labelled); step two names the pictures and the people and
 * says that only these pictures are assigned. Nothing happens until "Assign". What is sent is exactly the people
 * listed in step two: if the list of people changed under the choice (someone left), "Assign" is off until the person goes back.
 */
export function PhotoAssignDialog({ open, count, people, working, onConfirm, onCancel }: Props) {
  const t = useTranslations('photos.select.assign');
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<'pick' | 'confirm'>('pick');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setStep('pick');
      setChosen(new Set());
      setQuery('');
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  // Each step starts at its heading, so the title and the question are read first.
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, step]);

  const everyone = useMemo<{ person: Person; archived: boolean }[]>(
    () => (people.status === 'ready' ? [...people.people.active.map((person) => ({ person, archived: false })), ...people.people.archived.map((person) => ({ person, archived: true }))] : []),
    [people],
  );
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? everyone.filter(({ person }) => person.displayName.toLocaleLowerCase().includes(needle)) : everyone;
  const names = everyone.filter(({ person }) => chosen.has(person.id));
  const full = chosen.size >= PHOTO_ASSIGN_PROFILES_MAX;
  // The people shown are the people sent. If the list reloaded and one chosen is no longer in it, the two differ and nothing is sent.
  const consistent = names.length === chosen.size;

  const toggle = (id: string) =>
    setChosen((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <dialog
      ref={dialog}
      aria-labelledby="assign-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) onCancel();
      }}
      className="bg-bg text-foreground shadow-soft m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-3xl p-6 backdrop:bg-black/50"
    >
      {open && (
        <div className="flex flex-col gap-4">
          <h2 id="assign-title" ref={heading} tabIndex={-1} className="font-display text-headline outline-none">
            {t(step === 'pick' ? 'title' : 'confirmTitle')}
          </h2>
          {step === 'pick' && (
            <>
              <p className="text-t2 text-sm leading-relaxed">{t('intro', { count })}</p>
              {people.status === 'loading' && <p role="status">{t('loading')}</p>}
              {people.status === 'error' && <p role="alert">{t('loadFailed')}</p>}
              {people.status === 'ready' && everyone.length === 0 && (
                <div className="flex flex-col gap-2" data-testid="assign-nobody">
                  <p>{t('nobody')}</p>
                  <PillButton asChild variant="ghost-link" className="w-fit px-0">
                    <Link href="/people">{t('nobodyLink')}</Link>
                  </PillButton>
                </div>
              )}
              {everyone.length > SEARCH_FROM && (
                <label className="flex flex-col gap-1 text-sm font-medium">
                  {t('search')}
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="border-line bg-sf focus-visible:ring-ring/50 min-h-11 rounded-xl border px-3 text-base font-normal outline-none focus-visible:ring-[3px]"
                  />
                </label>
              )}
              {everyone.length > 0 && shown.length === 0 && <p className="text-t2">{t('noMatch')}</p>}
              {shown.length > 0 && (
                <ul className="flex max-h-[45dvh] flex-col gap-1 overflow-y-auto" aria-label={t('listLabel')}>
                  {shown.map(({ person, archived }) => (
                    <li key={person.id}>
                      <label className="hover:bg-sf2 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 py-1">
                        <input
                          type="checkbox"
                          className="size-5 shrink-0"
                          checked={chosen.has(person.id)}
                          disabled={full && !chosen.has(person.id)}
                          onChange={() => toggle(person.id)}
                        />
                        <PersonAvatar name={person.displayName} size="sm" />
                        <span className="min-w-0 break-words">
                          <bdi>{safeName(person.displayName, NAME_IN_ROW)}</bdi>
                          {archived && <span className="text-t2 ms-2 text-sm">({t('archived')})</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {full && <p className="text-t2 text-sm">{t('limit', { max: PHOTO_ASSIGN_PROFILES_MAX })}</p>}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <PillButton variant="outlined" onClick={onCancel}>
                  {t('cancel')}
                </PillButton>
                <PillButton aria-disabled={chosen.size === 0 || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => chosen.size > 0 && setStep('confirm')}>
                  {t('next')}
                </PillButton>
              </div>
              {chosen.size === 0 && everyone.length > 0 && <p className="text-t2 -mt-2 text-sm">{t('pickOne')}</p>}
            </>
          )}
          {step === 'confirm' && (
            <>
              <div className="flex flex-col gap-2 text-sm leading-relaxed">
                <p>{t('confirmBody', { count })}</p>
                <ul className="list-disc ps-5 font-medium" data-testid="assign-confirm-people">
                  {names.map(({ person }) => (
                    <li key={person.id} className="break-words">
                      <bdi>{safeName(person.displayName, NAME_IN_ROW)}</bdi>
                    </li>
                  ))}
                </ul>
                <p className="font-medium">{t('only')}</p>
                {!consistent && (
                  <p role="alert" className="text-destructive">
                    {t('changed')}
                  </p>
                )}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <PillButton variant="outlined" aria-disabled={working || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !working && setStep('pick')}>
                  {t('back')}
                </PillButton>
                <PillButton
                  aria-disabled={working || !consistent || undefined}
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  onClick={() => !working && consistent && onConfirm(names.map(({ person }) => person.id))}
                >
                  {working ? t('working') : t('confirm')}
                </PillButton>
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
