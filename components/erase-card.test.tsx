import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { click, render, settle, type Rendered } from './test-utils';
import { EraseCard } from './erase-card';

const replace = vi.hoisted(() => vi.fn());
const erase = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock('@/hooks/use-erase-device', () => ({ useEraseDevice: () => erase }));

const t = en.settings.erase;

// happy-dom has no modal <dialog>: a local stand-in that toggles `open`.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

describe('EraseCard', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    replace.mockReset();
    erase.mockReset();
  });

  const button = (label: string) => [...(view?.container.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  const dialog = () => view!.container.querySelector('dialog')!;

  test('explains where the data lives and does nothing until confirmed', async () => {
    view = await render(<EraseCard />);
    expect(view.container.textContent).toContain(t.description);
    expect(dialog().open).toBe(false);
    await click(button(t.button));
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain(t.backupAdvice);
    expect(erase).not.toHaveBeenCalled();
  });

  test('cancel closes the dialog without erasing', async () => {
    view = await render(<EraseCard />);
    await click(button(t.button));
    await click(button(t.cancel));
    expect(dialog().open).toBe(false);
    expect(erase).not.toHaveBeenCalled();
  });

  test('confirming erases and goes back to the welcome screen', async () => {
    erase.mockResolvedValue({ complete: true, failed: [] });
    view = await render(<EraseCard />);
    await click(button(t.button));
    await click(button(t.confirm));
    await settle();
    expect(erase).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith('/welcome');
  });

  test('an incomplete erase shows an error and can be retried', async () => {
    erase.mockResolvedValueOnce({ complete: false, failed: ['media'] }).mockResolvedValueOnce({ complete: true, failed: [] });
    view = await render(<EraseCard />);
    await click(button(t.button));
    await click(button(t.confirm));
    await settle();
    expect(replace).not.toHaveBeenCalled();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(t.failed);
    await click(button(t.retry));
    await settle();
    expect(erase).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('/welcome');
  });

  test('cannot be dismissed while erasing', async () => {
    let finish!: (value: { complete: boolean; failed: [] }) => void;
    erase.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    view = await render(<EraseCard />);
    await click(button(t.button));
    await click(button(t.confirm));
    expect(button(t.cancel)?.disabled).toBe(true);
    expect(button(t.confirm)?.disabled).toBe(true);
    expect(dialog().textContent).toContain(t.erasing);
    finish({ complete: true, failed: [] });
    await settle();
  });
});
