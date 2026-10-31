'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { archiveErrorKey } from '@/components/archive-status';
import { Outcome } from '@/components/backup-check-cards';
import { BackupMaker } from '@/components/backup-password';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { PackProgressBar } from '@/components/sync-progress';
import type { ChangesPackExport } from '@/hooks/use-changes-pack-export';
import { shortDeviceId, type SyncDeviceState } from '@/hooks/use-sync-device';

type SyncPeer = Extract<SyncDeviceState, { status: 'ready' }>['peers'][number];
const NEW_DEVICE = '';
const radioClass = 'accent-primary focus-visible:ring-ring/50 mt-0.5 size-5 shrink-0 outline-none focus-visible:ring-[3px]';

/**
 * "Send changes to another device": pick the device the file is for (or a new one, which gets everything), optionally
 * protect it with a password, and make it. The browser is handed the file from the click. Whether the other device HAS the
 * file is only the person's to say, so that is asked afterwards (`DeliveryStep`) and nothing is recorded before they answer.
 */
export function SyncExportCard({ device, pack, busy }: { device: SyncDeviceState; pack: ChangesPackExport; busy: boolean }) {
  const t = useTranslations('sync.export');
  const legendId = useId();
  const peers = device.status === 'ready' ? device.peers : [];
  const [choice, setChoice] = useState<string>();
  const [full, setFull] = useState(false);
  const { state } = pack;
  // A known device is the likelier target once there is one; a new device otherwise.
  const selected = choice !== undefined && (choice === NEW_DEVICE || peers.some((p) => p.peerId === choice)) ? choice : (peers[0]?.peerId ?? NEW_DEVICE);
  const working = state.status === 'working';
  // While the hand-over question is open (or being saved) a new file would leave it without an answer; the typed password is kept.
  const asking = state.status === 'saved' && state.confirmable;
  const disabled = working || busy || asking || device.status !== 'ready';

  return (
    <SectionCard className="gap-4 p-[18px]" aria-labelledby="sync-export-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="sync-export-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
      </div>

      <fieldset className="flex flex-col gap-2" aria-describedby={`${legendId}-note`}>
        <legend id={legendId} className="mb-1 text-[15px] font-medium">
          {t('peerLegend')}
        </legend>
        {peers.map((peer) => (
          <PeerOption key={peer.peerId} peer={peer} name={legendId} disabled={asking} checked={selected === peer.peerId} onSelect={() => setChoice(peer.peerId)} />
        ))}
        <label className="bg-bg flex min-h-11 cursor-pointer items-start gap-3 rounded-[14px] p-3 text-sm">
          <input type="radio" name={legendId} className={radioClass} disabled={asking} checked={selected === NEW_DEVICE} onChange={() => setChoice(NEW_DEVICE)} />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{t('newDevice')}</span>
            <span id={`${legendId}-note`} className="text-t2 leading-relaxed">
              {t('newDeviceHint')}
            </span>
          </span>
        </label>
      </fieldset>
      {selected !== NEW_DEVICE && (
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] font-medium">
            <input type="checkbox" disabled={asking} checked={full} onChange={(event) => setFull(event.target.checked)} className="accent-primary focus-visible:ring-ring/50 size-5 shrink-0 outline-none focus-visible:ring-[3px]" />
            {t('full')}
          </label>
          <p className="text-t2 text-sm leading-relaxed">{t('fullNote')}</p>
        </div>
      )}

      <BackupMaker
        disabled={disabled}
        labels={{ submit: t('submit'), privateNote: t('privateNote'), protectNote: t('protectNote') }}
        onBackup={(password) => void pack.exportPack({ peerId: selected === NEW_DEVICE ? null : selected, full: selected !== NEW_DEVICE && full, password })}
      />

      {state.status === 'working' && <PackProgressBar label={t('progressLabel')} progress={state.progress} />}
      {state.status === 'nothing' && (
        <Outcome icon="quiet" testId="sync-export-result">
          <p>{t('nothing')}</p>
        </Outcome>
      )}
      {state.status === 'failed' && <FailureNote code={state.code} />}
      {(state.status === 'saved' || state.status === 'handed' || state.status === 'not-handed') && <SavedPack pack={pack} />}
    </SectionCard>
  );
}

/** One known device as a choice: its short code, when a file last went to it, and what the next file holds. */
function PeerOption({ peer, name, checked, disabled, onSelect }: { peer: SyncPeer; name: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  const t = useTranslations('sync.export');
  const td = useTranslations('sync.device');
  const format = useFormatter();
  return (
    <label className="bg-bg flex min-h-11 cursor-pointer items-start gap-3 rounded-[14px] p-3 text-sm">
      <input type="radio" name={name} className={radioClass} disabled={disabled} checked={checked} onChange={onSelect} />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium break-words">{td('peerName', { code: shortDeviceId(peer.peerId) })}</span>
        <span className="text-t2">
          {peer.lastSentAt ? td('sent', { date: format.dateTime(new Date(peer.lastSentAt), { dateStyle: 'medium', timeStyle: 'short' }) }) : td('sentNever')}
        </span>
        <span className="text-t2 leading-relaxed">{t('peerHint')}</span>
      </span>
    </label>
  );
}

function FailureNote({ code }: { code: Parameters<typeof archiveErrorKey>[0] }) {
  const ta = useTranslations('archive.error');
  return (
    <Outcome icon="attention" testId="sync-export-result">
      <p role="alert">{ta(archiveErrorKey(code))}</p>
    </Outcome>
  );
}

/** The file is with the browser: where to find it, whether it is private, and (for a known device) the question that decides what is recorded. */
function SavedPack({ pack }: { pack: ChangesPackExport }) {
  const t = useTranslations('sync.export');
  const state = pack.state;
  if (state.status !== 'saved' && state.status !== 'handed' && state.status !== 'not-handed') return null;
  const saved = state.pack;
  const confirming = state.status === 'saved' && state.confirmable;
  return (
    <Outcome key={state.status === 'saved' ? 'saved' : 'answered'} icon="ok" title={t('savedTitle')} testId="sync-export-result">
      <p className="break-words">{t('saved', { fileName: saved.fileName })}</p>
      <p>{saved.encrypted ? t('savedProtected') : t('savedPrivate')}</p>
      <p>{saved.kind === 'full' ? t('savedFull') : t('savedChanges')}</p>
      {state.status === 'saved' && !state.confirmable && <p>{t('savedNewDevice')}</p>}
      {confirming && <DeliveryStep pack={pack} />}
      {state.status === 'handed' && <p role="status">{state.recorded ? t('handed') : t('handedStale')}</p>}
      {state.status === 'not-handed' && <p role="status">{t('notHanded')}</p>}
      {state.status !== 'saved' || !state.confirmable ? (
        <div>
          <PillButton variant="outlined" onClick={pack.reset}>
            {t('another')}
          </PillButton>
        </div>
      ) : null}
    </Outcome>
  );
}

/** "Did you hand the file to the other device?" Nothing is recorded unless the person answers yes. */
function DeliveryStep({ pack }: { pack: ChangesPackExport }) {
  const t = useTranslations('sync.export');
  const state = pack.state;
  const yes = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const failure = state.status === 'saved' ? state.problem : undefined;
  useEffect(() => {
    if (failure) yes.current?.focus();
  }, [failure]);
  if (state.status !== 'saved') return null;
  return (
    <div role="group" aria-labelledby={headingId} className="border-line mt-1 flex flex-col gap-2 border-t pt-3">
      <h4 id={headingId} className="text-[15px] font-semibold">
        {t('confirmTitle', { fileName: state.pack.fileName, code: state.pack.peerId ? shortDeviceId(state.pack.peerId) : '' })}
      </h4>
      <p className="text-t2 text-sm leading-relaxed">{t('confirmHelp')}</p>
      {failure && (
        <p role="alert" className="text-destructive text-sm">
          {failure === 'library-replaced' ? t('errorReplaced') : t('errorRecord')}
        </p>
      )}
      {state.recording && <p role="status">{t('recording')}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <PillButton ref={yes} aria-disabled={state.recording || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !state.recording && void pack.confirmDelivered()}>
          {t('confirmYes')}
        </PillButton>
        <PillButton variant="outlined" aria-disabled={state.recording || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !state.recording && pack.notHanded()}>
          {t('confirmNo')}
        </PillButton>
      </div>
    </div>
  );
}
