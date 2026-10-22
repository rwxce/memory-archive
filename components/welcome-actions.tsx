'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveStatus } from '@/components/archive-status';
import { PillButton } from '@/components/pill-button';
import { useArchiveBackup } from '@/hooks/use-archive-backup';
import { usePrepareStorage } from '@/hooks/use-device-storage';
import { useLibraryStart, useLibraryState } from '@/hooks/use-library';
import { useRouter } from '@/i18n/navigation';

/**
 * First-run choices. *Start* asks the browser to keep this device's archive (persistent storage)
 * and goes to People, where the first person is added. *Open an archive* restores a Memory
 * Archive ZIP the person picks, into this (empty) device, then goes to People. The library is not opened until a file is picked
 * (Erase everything leaves nothing behind, and the welcome must not recreate it); on the home page People already opened it.
 */
export function WelcomeActions() {
  const t = useTranslations('welcome');
  const ta = useTranslations('archive');
  const prepareStorage = usePrepareStorage();
  const router = useRouter();
  const { state: library, retry } = useLibraryState();
  const startLibrary = useLibraryStart();
  const [pending, setPending] = useState<File>();
  const { state, restore } = useArchiveBackup();
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const working = state.status === 'working';

  // A file picked before the library was open waits here until it is (it is opened only when a file is picked).
  useEffect(() => {
    if (!pending) return;
    if (library.status === 'ready') {
      setPending(undefined);
      void restore(pending);
    } else if (library.status !== 'loading') {
      setPending(undefined);
      setNotice(ta('notReady'));
    }
  }, [pending, library.status, restore, ta]);

  useEffect(() => {
    if (state.status === 'done' && state.kind === 'restore') router.push('/people');
  }, [state, router]);

  const start = async () => {
    await prepareStorage();
    router.push('/people');
  };

  const pick = (file: File | undefined) => {
    if (!file || working) return;
    setNotice('');
    if (library.status === 'ready') void restore(file);
    else {
      setPending(file);
      if (library.status === 'loading') startLibrary();
      else retry();
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <PillButton size="lg" onClick={start}>
        {t('start')}
      </PillButton>
      <PillButton
        variant="outlined"
        className="h-[52px] text-[15px] aria-disabled:pointer-events-none aria-disabled:opacity-50"
        aria-disabled={working || undefined}
        onClick={() => !working && input.current?.click()}
      >
        {t('open')}
      </PillButton>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          pick(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <p className="text-mu pt-1 text-center text-xs leading-relaxed">{t('openHint')}</p>
      <ArchiveStatus state={state} className="min-h-5 text-center text-sm break-words" />
      <p role="status" aria-live="polite" className="text-center text-sm empty:hidden">
        {notice}
      </p>
    </div>
  );
}
