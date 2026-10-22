import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { click, render, type Rendered } from './test-utils';
import { ConversationCalendar } from './conversation-calendar';
import type { ConversationDaysState } from '@/hooks/use-conversation-days';

const days = [
  { date: '2025-12-30', count: 2, firstOffset: 0 },
  { date: '2026-03-02', count: 1200, firstOffset: 2 },
  { date: '2026-03-17', count: 3, firstOffset: 1202 },
  { date: '2026-05-01', count: 4, firstOffset: 1205 },
];

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function open(state: ConversationDaysState = { status: 'ready', days }, over: { first?: string; last?: string; onPick?: () => void; onClose?: () => void; onRetry?: () => void } = {}) {
  const spies = { onPick: vi.fn(), onClose: vi.fn(), onRetry: vi.fn() };
  view = await render(
    <ConversationCalendar state={state} first={over.first ?? '2025-12-30'} last={over.last ?? '2026-05-01'} onPick={over.onPick ?? spies.onPick} onClose={over.onClose ?? spies.onClose} onRetry={over.onRetry ?? spies.onRetry} />,
  );
  return spies;
}
const q = (selector: string) => view!.container.querySelector<HTMLElement>(selector)!;
const byLabel = (label: string | RegExp) =>
  [...view!.container.querySelectorAll<HTMLElement>('button')].find((b) => (typeof label === 'string' ? b.getAttribute('aria-label') === label || b.textContent?.trim() === label : label.test(b.getAttribute('aria-label') ?? b.textContent ?? '')))!;
const key = (el: Element, name: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));

describe('ConversationCalendar', () => {
  test('years with message counts come first', async () => {
    await open();
    expect(q('h2').textContent).toBe('Choose a year');
    expect(byLabel('2025, 2 messages')).toBeTruthy();
    expect(byLabel('2026, 1,207 messages')).toBeTruthy();
  });

  test('a year opens its months; only months with messages can be chosen', async () => {
    await open();
    await click(byLabel(/^2026,/));
    expect(q('h2').textContent).toBe('Choose a month in 2026');
    expect((byLabel('March, 1,203 messages') as HTMLButtonElement).disabled).toBe(false);
    expect((byLabel('April, no messages') as HTMLButtonElement).disabled).toBe(true);
    await click(byLabel('All years'));
    expect(q('h2').textContent).toBe('Choose a year');
  });

  test('a single year skips the years step', async () => {
    await open({ status: 'ready', days: days.slice(1) });
    expect(q('h2').textContent).toBe('Choose a month in 2026');
    expect(byLabel('All years')).toBeUndefined();
  });

  test('the day grid: Monday first, empty days do nothing, a day with messages is picked', async () => {
    const { onPick } = await open();
    await click(byLabel(/^2026,/));
    await click(byLabel(/^March,/));
    expect(q('h2').textContent).toBe('March 2026');
    expect([...view!.container.querySelectorAll('th')].map((th) => th.getAttribute('abbr'))[0]).toBe('Monday');
    const empty = byLabel('Tuesday, March 3, 2026, no messages');
    expect(empty.getAttribute('aria-disabled')).toBe('true');
    await click(empty);
    expect(onPick).not.toHaveBeenCalled();
    const busy = byLabel('Monday, March 2, 2026, 1,200 messages');
    expect(busy.getAttribute('aria-disabled')).toBeNull();
    expect(busy.textContent).toContain('1.2K');
    await click(busy);
    expect(onPick).toHaveBeenCalledWith('2026-03-02');
  });

  test('arrow keys move through the days with one tab stop; Home and End go to the week ends', async () => {
    await open();
    await click(byLabel(/^2026,/));
    await click(byLabel(/^March,/));
    const grid = q('table');
    const stops = () => [...grid.querySelectorAll('button')].filter((b) => b.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].getAttribute('aria-label')).toContain('March 2, 2026'); // the first day with messages
    stops()[0].focus();
    await key(document.activeElement!, 'ArrowRight');
    expect(document.activeElement?.getAttribute('aria-label')).toContain('March 3, 2026');
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.getAttribute('aria-label')).toContain('March 10, 2026');
    await key(document.activeElement!, 'Home');
    expect(document.activeElement?.getAttribute('aria-label')).toContain('March 9, 2026');
    await key(document.activeElement!, 'End');
    expect(document.activeElement?.getAttribute('aria-label')).toContain('March 15, 2026');
    await key(document.activeElement!, 'ArrowUp');
    await key(document.activeElement!, 'ArrowUp');
    await key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement?.getAttribute('aria-label')).toContain('March 1, 2026'); // clamped to the month
    expect(stops()).toHaveLength(1);
  });

  test('month arrows stop at the first and last month of the conversation', async () => {
    await open();
    await click(byLabel(/^2026,/));
    await click(byLabel(/^May,/));
    expect(q('h2').textContent).toBe('May 2026');
    expect(byLabel('Next month').getAttribute('aria-disabled')).toBe('true');
    await click(byLabel('Next month'));
    expect(q('h2').textContent).toBe('May 2026');
    await click(byLabel('Previous month'));
    expect(q('h2').textContent).toBe('April 2026');
    for (let i = 0; i < 4; i++) await click(byLabel('Previous month'));
    expect(q('h2').textContent).toBe('December 2025');
    expect(byLabel('Previous month').getAttribute('aria-disabled')).toBe('true');
    await click(byLabel('Previous month'));
    expect(q('h2').textContent).toBe('December 2025');
  });

  test('Escape and the close button close it', async () => {
    const { onClose } = await open();
    await key(q('h2'), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(byLabel('Close calendar'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('loading, empty and failed states; Retry asks again', async () => {
    await open({ status: 'loading' });
    expect(q('[role="status"]').textContent).toBe('Loading the calendar…');
    view!.unmount();
    await open({ status: 'ready', days: [] });
    expect(view!.container.textContent).toContain('There are no days with messages to show.');
    view!.unmount();
    const { onRetry } = await open({ status: 'error' });
    expect(q('[role="alert"]').textContent).toContain('The calendar could not be read. Nothing was deleted.');
    await click(byLabel('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
