import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import type { ChangesPackImport, PackImportFailure } from '@/hooks/use-changes-pack-import';
import type { ImportChangesPackResult } from '@/lib/usecases/changes-pack-import';
import { render, type Rendered } from './test-utils';
import { importErrorKey, SyncImportCard } from './sync-import-card';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const s = en.sync.import;
const counts = {
  blobs: 0,
  profiles: { added: 0, updated: 0 },
  conversations: { added: 0, updated: 0 },
  batches: 0,
  messages: { added: 0, skipped: 0 },
  favorites: { added: 0, removed: 0 },
  notes: { added: 0, updated: 0, removed: 0 },
};
const done = (patch: Partial<ImportChangesPackResult>, c = counts): ImportChangesPackResult => ({
  kind: 'changes',
  sourceDeviceId: 'x',
  encrypted: false,
  counts: c,
  conflicts: 0,
  batchOffers: 0,
  peer: { peerId: 'x', lastSentSeq: 0, lastSentAt: null, lastReceivedSeq: 1, lastReceivedAt: null },
  ...patch,
});
const packWith = (state: ChangesPackImport['state']): ChangesPackImport => ({ state, pick: vi.fn(), unlock: vi.fn(), reset: vi.fn() });

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('SyncImportCard result', () => {
  test('crossed edits are shown as a count with both versions kept, and no way to resolve them yet', async () => {
    view = await render(<SyncImportCard pack={packWith({ status: 'done', result: done({ conflicts: 2, batchOffers: 1 }, { ...counts, messages: { added: 4, skipped: 1 } }) })} busy={false} />);
    const text = view.container.textContent!;
    expect(text).toContain('4 new messages added.');
    expect(text).toContain('1 message was already in the archive');
    expect(view.container.querySelector('[data-testid="sync-conflicts"]')?.textContent).toContain('2 items were changed on both devices. Both versions are kept and nothing was overwritten.');
    expect(text).toContain(s.conflictsLater);
    expect(text).toContain('1 import was undone on the other device. Nothing was removed here.');
    expect(view.container.querySelectorAll('a')).toHaveLength(0);
  });

  test('a file with nothing new says so', async () => {
    view = await render(<SyncImportCard pack={packWith({ status: 'done', result: done({}) })} busy={false} />);
    expect(view.container.textContent).toContain(s.nothingNew);
  });

  test('every refusal code has its own calm words, never "sent" or a raw code', async () => {
    const codes: PackImportFailure[] = ['gap', 'wrong-device', 'own-pack', 'not-a-pack', 'invalid-manifest', 'integrity', 'not-an-archive', 'newer-format', 'limit-exceeded', 'storage', 'busy', 'encryption-unavailable', 'unknown'];
    for (const code of codes) {
      view = await render(<SyncImportCard pack={packWith({ status: 'failed', code, fileName: 'f.zip' })} busy={false} />);
      const message = view.container.querySelector('[role="alert"]')!.textContent!;
      expect(message.length, code).toBeGreaterThan(20);
      expect(message, code).not.toContain(code);
      expect(message, code).toMatch(/nothing (was )?(changed|added)|Nothing was changed|wait|Wait/i);
      view.unmount();
    }
    expect(importErrorKey('gap')).toBe('gap');
    expect(en.sync.import.error.gap).toContain('Send everything again');
  });
});
