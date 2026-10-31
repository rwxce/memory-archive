'use client';

import { useTranslations } from 'next-intl';
import { LibraryNotice } from '@/components/library-notice';
import { PageTitle } from '@/components/page-title';
import { Shell } from '@/components/screen-shell';
import { SyncDeviceCard } from '@/components/sync-device-card';
import { SyncExportCard } from '@/components/sync-export-card';
import { SyncConflictsCard } from '@/components/sync-conflicts-card';
import { SyncImportCard } from '@/components/sync-import-card';
import { SyncInbox } from '@/components/sync-inbox';
import { useChangesPackExport } from '@/hooks/use-changes-pack-export';
import { useChangesPackImport } from '@/hooks/use-changes-pack-import';
import { useLibrary } from '@/hooks/use-library';
import { useSyncConflicts } from '@/hooks/use-sync-conflicts';
import { useSyncDevice } from '@/hooks/use-sync-device';

/**
 * Sync devices: this device's short code and the devices it has exchanged files with; making a changes file for another
 * device (the delivery is recorded only when the person says they handed it over); receiving one, and settling what was changed on both devices. Files move by hand,
 * nothing goes over a network. One of the two runs at a time. The library opens here because all of it needs it.
 */
export function SyncScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell back={{ href: '/settings' }}>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <SyncContent />;
}

function SyncContent() {
  const t = useTranslations('sync');
  const tn = useTranslations('settings');
  const device = useSyncDevice();
  const exported = useChangesPackExport(device.reload);
  const imported = useChangesPackImport(device.reload);
  const conflicts = useSyncConflicts(device.reload);

  return (
    <Shell back={{ href: '/settings', label: tn('title') }}>
      <div className="flex flex-col gap-1.5">
        <PageTitle>{t('title')}</PageTitle>
        <p className="text-t2 leading-relaxed">{t('intro')}</p>
      </div>
      <SyncDeviceCard state={device.state} />
      <SyncExportCard device={device.state} pack={exported} busy={imported.state.status === 'working'} />
      <SyncInbox pack={imported} busy={exported.state.status === 'working'} />
      <SyncImportCard
        pack={imported}
        busy={exported.state.status === 'working'}
        openItems={conflicts.state.status === 'ready' ? conflicts.state.items.length : undefined}
      />
      <SyncConflictsCard conflicts={conflicts} />
    </Shell>
  );
}
