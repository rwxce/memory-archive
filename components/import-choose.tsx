'use client';

import { useRef, useState, type DragEvent } from 'react';
import { FileArchive, Upload, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { FileItem } from '@/components/import-types';
import { PillButton } from '@/components/pill-button';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { Link } from '@/i18n/navigation';
import { formatBytes } from './format';

/**
 * The first screen of the import: choose ZIP or text files (a file picker, or drop them on the box on a
 * computer) and see the ones shared from WhatsApp, all in one list. File names are user data and
 * wrap when long. Nothing is read until Continue.
 */
export function ImportChoose({
  items,
  skipped,
  headingRef,
  onAdd,
  onRemove,
  onContinue,
}: {
  items: FileItem[];
  /** Files that were offered but cannot be imported yet (neither ZIP nor text). */
  skipped: number;
  headingRef: React.Ref<HTMLHeadingElement>;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onContinue: () => void;
}) {
  const t = useTranslations('import');
  const locale = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasShared = items.some((item) => item.sharedKey);

  /** Removes a file; focus goes to the next Remove button (or the last), or to the list heading when none is left. */
  const removeAt = (index: number, id: string) => {
    onRemove(id);
    setTimeout(() => {
      const buttons = list.current?.querySelectorAll<HTMLElement>('button[data-remove]');
      (buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : listHeading.current)?.focus();
    });
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    onAdd([...event.dataTransfer.files]);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 ref={headingRef} tabIndex={-1} className="font-display text-display outline-none">
          {t('title')}
        </h1>
        <p className="text-mu leading-relaxed">{t('intro')}</p>
        <Link
          href="/import/history?from=import"
          className="text-ac-tx focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {t('historyLink')}
        </Link>
      </div>

      <div
        data-testid="import-dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={cn(
          'bg-sf lg:in-data-panel:bg-bg border-line flex flex-col items-start gap-3 rounded-3xl border-[1.5px] border-dashed p-5 sm:items-center sm:p-8',
          dragging && 'border-ac bg-ac-soft',
        )}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept=".zip,.txt,application/zip,application/x-zip-compressed,text/plain"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="import-file-input"
          className="sr-only"
          onChange={(event) => {
            onAdd([...(event.target.files ?? [])]);
            // The same file can be chosen again after it was removed.
            event.target.value = '';
          }}
        />
        <PillButton size="lg" onClick={() => input.current?.click()}>
          <Upload aria-hidden />
          {t('choose.pick')}
        </PillButton>
        <p className="text-mu text-sm [@media(pointer:coarse)]:hidden">{t('choose.drop')}</p>
        <p className="text-mu text-sm leading-relaxed sm:text-center">{t('choose.hint')}</p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="import-list-title">
        <h2 id="import-list-title" ref={listHeading} tabIndex={-1} className="font-display text-name outline-none">
          {t('choose.listTitle', { count: items.length })}
        </h2>
        {items.length === 0 ? (
          <p className="text-mu">{t('choose.empty')}</p>
        ) : (
          <ul ref={list} className="flex flex-col gap-2">
            {items.map((item, index) => (
              <li key={item.id} className="bg-mint flex min-w-0 items-center gap-3 rounded-[18px] py-3 ps-3.5 pe-1.5 text-sm">
                <span aria-hidden className="bg-bg flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <FileArchive className="text-ac-tx size-5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium break-words">{item.file.name}</span>
                  <span className="text-t2">
                    {formatBytes(item.file.size, locale)}
                    {item.sharedKey && ` · ${t('choose.shared')}`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('choose.removeLabel', { name: item.file.name })}
                  title={t('choose.remove')}
                  data-remove
                  onClick={() => removeAt(index, item.id)}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {hasShared && <p className="text-mu text-sm">{t('choose.sharedNote')}</p>}
        <p role="status" className="text-mu text-sm break-words empty:hidden">
          {skipped > 0 ? t('choose.skipped', { count: skipped }) : ''}
        </p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/people"
          className="text-mu hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-full text-sm underline underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {t('backToPeople')}
        </Link>
        <PillButton
          size="lg"
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          aria-disabled={items.length === 0 || undefined}
          onClick={() => {
            if (items.length > 0) onContinue();
          }}
        >
          {t('choose.start', { count: items.length })}
        </PillButton>
      </div>
    </div>
  );
}
