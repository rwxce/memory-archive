'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';
import { shortDeviceId, type SyncDeviceState } from '@/hooks/use-sync-device';

/** This device's short code and the devices it has exchanged files with, each with when the last file went and came. */
export function SyncDeviceCard({ state }: { state: SyncDeviceState }) {
  const t = useTranslations('sync.device');
  const format = useFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <SectionCard tone="soft" className="gap-4 p-[18px]" aria-labelledby="sync-device-title">
      <Eyebrow as="h2" id="sync-device-title" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      {state.status === 'loading' && <p role="status">{t('loading')}</p>}
      {state.status === 'error' && <p role="alert">{t('failed')}</p>}
      {state.status === 'ready' && (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-t2 text-sm">{t('codeLabel')}</p>
            <p className="font-mono text-lg font-semibold tracking-wider" data-testid="sync-device-code">
              {shortDeviceId(state.deviceId)}
            </p>
            <p className="text-t2 text-sm leading-relaxed">{t('codeHelp')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-medium">{t('peersTitle')}</h3>
            {state.peers.length === 0 ? (
              <p className="text-t2 text-sm leading-relaxed">{t('noPeers')}</p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="sync-peers">
                {state.peers.map((peer) => (
                  <li key={peer.peerId} className="bg-bg flex flex-col gap-0.5 rounded-[14px] p-3 text-sm">
                    <span className="font-medium break-words">{t('peerName', { code: shortDeviceId(peer.peerId) })}</span>
                    <span className="text-t2">{peer.lastSentAt ? t('sent', { date: when(peer.lastSentAt) }) : t('sentNever')}</span>
                    <span className="text-t2">{peer.lastReceivedAt ? t('received', { date: when(peer.lastReceivedAt) }) : t('receivedNever')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </SectionCard>
  );
}
