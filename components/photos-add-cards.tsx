'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import type { PhotoImport } from '@/hooks/use-photo-import';
import { PHOTO_ALBUM_MAX, truncateCodePoints } from '@/lib/domain/photo';

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
const disabledClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

/**
 * The two ways in. A ZIP is checked by its content and added at once; a lone picture handed to the ZIP picker joins the
 * loose choice instead. Loose files wait in a choice the person can see (a count) and drop again before anything is added.
 * `disabled` while another import or an undo runs.
 */
export function PhotosAddCards({ run, disabled }: { run: PhotoImport; disabled: boolean }) {
  const t = useTranslations('photos');
  const zipPicker = useRef<HTMLInputElement>(null);
  const loosePicker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File[]>([]);
  const [label, setLabel] = useState('');
  const pickButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const { state } = run;

  // Once the chosen files were added (a finished run that came from them), the choice is spent. A failed or stopped run, or an
  // unrelated ZIP import that finishes, leaves it as it was for another try.
  useEffect(() => {
    if (state.status === 'done' && state.result.kind === 'loose') {
      setChosen([]);
      setLabel('');
    }
  }, [state]);

  // "Remove choice" takes its own button away: the keyboard goes to the picker, where choosing starts again.
  useEffect(() => {
    if (chosen.length === 0 && refocus.current) {
      refocus.current = false;
      pickButton.current?.focus();
    }
  }, [chosen.length]);

  const addToChoice = (files: File[]) => setChosen((now) => [...now, ...files.filter((f) => !now.some((n) => sameFile(n, f)))]);

  return (
    <>
      <SectionCard className="gap-4 p-[18px]" aria-labelledby="photos-zip-title">
        <div className="flex flex-col gap-1.5">
          <Eyebrow as="h2" id="photos-zip-title" tone="muted" className="tracking-widest">
            {t('zip.title')}
          </Eyebrow>
          <p className="text-t2 leading-relaxed">{t('zip.description')}</p>
        </div>
        <div>
          <input
            ref={zipPicker}
            type="file"
            accept=".zip,application/zip"
            hidden
            data-testid="photos-zip-input"
            disabled={disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              // While an import runs the hook refuses and says so, calmly; while an undo runs nothing starts.
              if (!file || (disabled && state.status !== 'working' && state.status !== 'checking')) return;
              void run.pickFile(file).then((outcome) => {
                if (outcome === 'media') addToChoice([file]);
              });
            }}
          />
          <PillButton aria-disabled={disabled || undefined} className={disabledClass} onClick={() => !disabled && zipPicker.current?.click()}>
            {t('zip.pick')}
          </PillButton>
        </div>
      </SectionCard>

      <SectionCard className="gap-4 p-[18px]" aria-labelledby="photos-loose-title">
        <div className="flex flex-col gap-1.5">
          <Eyebrow as="h2" id="photos-loose-title" tone="muted" className="tracking-widest">
            {t('loose.title')}
          </Eyebrow>
          <p className="text-t2 leading-relaxed">{t('loose.description')}</p>
        </div>
        <input
          ref={loosePicker}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          data-testid="photos-loose-input"
          disabled={disabled}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            if (files.length > 0 && !disabled) addToChoice(files);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <PillButton ref={pickButton} variant={chosen.length > 0 ? 'outlined' : 'primary'} aria-disabled={disabled || undefined} className={disabledClass} onClick={() => !disabled && loosePicker.current?.click()}>
            {chosen.length > 0 ? t('loose.pickMore') : t('loose.pick')}
          </PillButton>
        </div>
        {chosen.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p role="status" data-testid="photos-chosen" className="font-medium">
                {t('loose.chosen', { count: chosen.length })}
              </p>
              <PillButton variant="ghost-link" aria-disabled={disabled || undefined} className={disabledClass} onClick={() => {
                  if (disabled) return;
                  refocus.current = true;
                  setChosen([]);
                }}>
                {t('loose.remove')}
              </PillButton>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="photos-album" className="text-sm font-medium">
                {t('loose.labelLabel')}
              </label>
              <input
                id="photos-album"
                type="text"
                value={label}
                aria-describedby="photos-album-hint"
                autoComplete="off"
                onChange={(event) => setLabel(truncateCodePoints(event.currentTarget.value, PHOTO_ALBUM_MAX))}
                className="bg-bg border-input focus-visible:border-ring focus-visible:ring-ring/50 h-12 w-full rounded-2xl border px-4 text-base outline-none focus-visible:ring-[3px]"
              />
              <p id="photos-album-hint" className="text-t2 text-sm">
                {t('loose.labelHint')}
              </p>
            </div>
            <div>
              <PillButton
                aria-disabled={disabled || undefined}
                className={disabledClass}
                onClick={() => {
                  if (disabled) return;
                  void run.importLoose(chosen, label);
                }}
              >
                {t('loose.add')}
              </PillButton>
            </div>
          </div>
        )}
      </SectionCard>
    </>
  );
}
