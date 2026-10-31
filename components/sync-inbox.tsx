'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { peekArchiveFile } from '@/hooks/peek-archive-file';
import type { ChangesPackImport } from '@/hooks/use-changes-pack-import';
import { useSharedInbox } from '@/hooks/use-device-storage';
import type { SharedFileInfo } from '@/lib/usecases/device-storage';

const ZIPLIKE = /\.(zip|mabackup)$/i;

/**
 * Files shared to the app that are changes files (or protected files, which only say what they are once opened): kept
 * by the import wizard for this screen. Each can be added or removed. A file leaves the inbox only when its changes were
 * added or the person removes it; a failed attempt keeps it. Nothing is shown when there is none.
 */
export function SyncInbox({ pack, busy }: { pack: ChangesPackImport; busy: boolean }) {
  const t = useTranslations('sync.inbox');
  const inbox = useSharedInbox();
  const [packs, setPacks] = useState<SharedFileInfo[]>([]);
  const adding = useRef<string>(undefined);
  const disabled = busy || pack.state.status === 'working' || pack.state.status === 'asking';

  useEffect(() => {
    const files = inbox.files?.filter((info) => ZIPLIKE.test(info.name));
    if (!files) return;
    let alive = true;
    void (async () => {
      const kept: SharedFileInfo[] = [];
      for (const info of files) {
        const file = await inbox.take(info);
        const kind = file ? await peekArchiveFile(file) : 'unknown';
        if (kind === 'changes-pack' || kind === 'encrypted') kept.push(info);
      }
      if (alive) setPacks(kept);
    })();
    return () => {
      alive = false;
    };
  }, [inbox]);

  // The changes were added: the file has done its job.
  const status = pack.state.status;
  useEffect(() => {
    if (status === 'done' && adding.current) {
      void inbox.discard(adding.current);
      adding.current = undefined;
    }
  }, [status, inbox]);

  if (packs.length === 0) return null;
  return (
    <SectionCard className="gap-4 p-[18px]" aria-labelledby="sync-inbox-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="sync-inbox-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
      </div>
      <ul className="flex flex-col gap-2" data-testid="sync-inbox">
        {packs.map((info) => (
          <li key={info.key} className="bg-bg flex flex-col gap-2 rounded-[14px] p-3 text-sm">
            <span className="font-medium break-words">{info.name}</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <PillButton
                aria-disabled={disabled || undefined}
                aria-label={t('addLabel', { fileName: info.name })}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={async () => {
                  if (disabled) return;
                  const file = await inbox.take(info);
                  if (!file) return;
                  adding.current = info.key;
                  void pack.pick(file);
                }}
              >
                {t('add')}
              </PillButton>
              <PillButton
                variant="outlined"
                aria-disabled={disabled || undefined}
                aria-label={t('removeLabel', { fileName: info.name })}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={() => {
                  if (disabled) return;
                  void inbox.discard(info.key);
                  setPacks((list) => list.filter((entry) => entry.key !== info.key));
                }}
              >
                {t('remove')}
              </PillButton>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
