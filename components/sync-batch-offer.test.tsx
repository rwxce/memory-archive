import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import type { ConflictItem } from '@/hooks/use-sync-conflicts';
import { click, render, type Rendered } from './test-utils';
import { SyncBatchOffer } from './sync-batch-offer';

const p = en.sync.conflicts.photoBatch;
const offer = (patch: Partial<ConflictItem> = {}): ConflictItem => ({
  id: 1,
  peerId: 'abcdef123456',
  kind: 'photo-batch',
  scope: 'photo-batch',
  key: 'pb-1',
  incoming: { id: 'pb-1', kind: 'photo-batch', deletedAt: '2026-01-01T00:00:00.000Z' } as unknown as ConflictItem['incoming'],
  incomingDeleted: true,
  detectedAt: '2026-01-01T00:00:00.000Z',
  local: null,
  matched: true,
  photoBatch: { sourceLabel: '<b>trip</b>.zip', items: 3 },
  ...patch,
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});
const button = (name: string) => [...view!.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === name);

describe('SyncBatchOffer: a photo import undone on the other device', () => {
  test('the offer names the import as text and the number of photos', async () => {
    view = await render(<SyncBatchOffer conflict={offer()} working={false} onResolve={vi.fn()} />);
    const text = view.container.textContent!;
    expect(text).toContain('<b>trip</b>.zip');
    expect(view.container.querySelector('b')).toBeNull();
    expect(text).toContain('3 photos from it are still here.');
    expect(button(p.undo)).toBeDefined();
  });

  test('undoing asks first, naming the photos and the assignments, then resolves with theirs', async () => {
    const onResolve = vi.fn();
    view = await render(<SyncBatchOffer conflict={offer()} working={false} onResolve={onResolve} />);
    await click(button(p.undo));
    const ask = view.container.querySelector('[role="group"]')!.textContent!;
    expect(ask).toContain('The 3 photos added by that import will be removed.');
    expect(ask).toContain('assignments to people');
    expect(onResolve).not.toHaveBeenCalled();
    await click(button(p.confirm));
    expect(onResolve).toHaveBeenCalledWith('theirs');
  });

  test('Keep it resolves with mine, without asking', async () => {
    const onResolve = vi.fn();
    view = await render(<SyncBatchOffer conflict={offer()} working={false} onResolve={onResolve} />);
    await click(button(p.keep));
    expect(onResolve).toHaveBeenCalledWith('mine');
  });

  test('an import this device does not have is a calm note that can be closed', async () => {
    const onResolve = vi.fn();
    view = await render(<SyncBatchOffer conflict={offer({ matched: false, photoBatch: undefined })} working={false} onResolve={onResolve} />);
    expect(view.container.textContent).toContain(p.unmatched);
    expect(button(p.undo)).toBeUndefined();
    await click(button(p.close));
    expect(onResolve).toHaveBeenCalledWith('mine');
  });
});
