import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { PeopleState } from '@/hooks/use-people';
import type { Person } from '@/lib/usecases/library';
import { click, render, type Rendered } from './test-utils';
import { PhotoAssignDialog } from './photo-assign-dialog';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const t = en.photos.select.assign;
const person = (n: number, name: string): Person => ({ id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, displayName: name }) as Person;
const ready = (...p: Person[]): PeopleState => ({ status: 'ready', people: { active: p, archived: [], unassigned: [] } as never });

let view: Rendered | undefined;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const button = (label: string) => [...view!.container.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === label);
const draw = (people: PeopleState, onConfirm = vi.fn()) =>
  act(async () => {
    view!.root.render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PhotoAssignDialog open count={3} people={people} working={false} onConfirm={onConfirm} onCancel={() => undefined} />
      </NextIntlClientProvider>,
    );
  });

describe('PhotoAssignDialog', () => {
  test('sends exactly the people it lists, and refuses to send when the list of people changed under the choice', async () => {
    const [ana, bru] = [person(1, 'Ana'), person(2, 'Bru')];
    const onConfirm = vi.fn();
    view = await render(<div />);
    await draw(ready(ana, bru), onConfirm);
    for (const box of view.container.querySelectorAll('input[type="checkbox"]')) await click(box);
    await click(button(t.next));
    // The people reload and Bru is gone (or is still loading): the two lists differ.
    await draw({ status: 'loading' }, onConfirm);
    await draw(ready(ana), onConfirm);
    const confirm = button(t.confirm)!;
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(view.container.querySelector('[role="alert"]')!.textContent).toBe(t.changed);
    await click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    // Back and forth to a consistent list: it sends the ids it shows.
    await draw(ready(ana, bru), onConfirm);
    expect(button(t.confirm)!.getAttribute('aria-disabled')).toBeNull();
    await click(button(t.confirm));
    expect(onConfirm).toHaveBeenCalledWith([ana.id, bru.id]);
  });
});
