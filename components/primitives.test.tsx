import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { avatarLetter, AVATAR_TINTS, tintIndex } from './avatar-tint';
import { FilterChip } from './filter-chip';
import { activeTab, isTopLevel } from './nav-items';
import { nextRadioIndex } from './radio-keys';
import { SegmentedControl } from './segmented-control';
import { TabBar } from './tab-bar';
import { click, render, type Rendered } from './test-utils';
import { Waveform, waveformHeights } from './waveform';

let pathname = '/people';
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => pathname,
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('tabs', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('activeTab knows the four top-level screens, the home page and trailing slashes; sub-screens have none', () => {
    expect(activeTab('/')).toBe('people');
    expect(activeTab('/people/')).toBe('people');
    expect(activeTab('/search')).toBe('search');
    expect(activeTab('/import')).toBe('import');
    expect(activeTab('/settings/')).toBe('settings');
    expect(activeTab('/import/history')).toBeUndefined();
    expect(activeTab('/person')).toBeUndefined();
    expect(isTopLevel('/conversation')).toBe(false);
  });

  test('the tab bar marks only the current tab with aria-current and names it "Settings" for the last tab', async () => {
    pathname = '/settings';
    view = await render(<TabBar />);
    const links = [...view.container.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual([en.nav.tabs.people, en.nav.tabs.search, en.nav.tabs.import, en.nav.tabs.settings]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, null, 'page']);
    expect(view.container.querySelector('nav')?.getAttribute('aria-label')).toBe(en.nav.primary);
  });
});

describe('SegmentedControl', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ];

  test('is a radiogroup with roving tabindex; arrows, Home and End move and select', async () => {
    const onChange = vi.fn();
    view = await render(<SegmentedControl label="Pick" value="a" options={options} onChange={onChange} />);
    const radios = [...view.container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(view.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Pick');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    const press = async (el: HTMLElement, key: string) =>
      act(async () => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    await press(radios[0], 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('b');
    await press(radios[0], 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('c');
    await press(radios[0], 'End');
    expect(onChange).toHaveBeenLastCalledWith('c');
    await click(radios[1]);
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  test('nextRadioIndex wraps and ignores other keys', () => {
    expect(nextRadioIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextRadioIndex('ArrowRight', 0, 3, true)).toBe(2);
    expect(nextRadioIndex('Enter', 0, 3)).toBeUndefined();
  });
});

describe('FilterChip', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('reflects pressed in aria-pressed and asks for the opposite on click', async () => {
    const onPressedChange = vi.fn();
    view = await render(
      <FilterChip pressed onPressedChange={onPressedChange}>
        Photos
      </FilterChip>,
    );
    const chip = view.container.querySelector('button')!;
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await click(chip);
    expect(onPressedChange).toHaveBeenCalledWith(false);
  });
});

describe('Waveform and avatar tint', () => {
  test('the same seed gives the same bars, a different seed does not', () => {
    expect(waveformHeights('x', 12)).toEqual(waveformHeights('x', 12));
    expect(waveformHeights('x', 12)).not.toEqual(waveformHeights('y', 12));
    expect(waveformHeights('x', 40).every((h) => h >= 0.2 && h <= 1)).toBe(true);
  });

  test('the waveform is hidden from assistive technology', async () => {
    const view = await render(<Waveform seed="m1" bars={5} />);
    expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(view.container.querySelectorAll('span span')).toHaveLength(5);
    view.unmount();
  });

  test('a name always gets the same tint, among the eight; the letter is the first whole character, upper-cased', () => {
    expect(tintIndex('Mama')).toBe(tintIndex('Mama'));
    expect(tintIndex('Mama')).toBeLessThan(AVATAR_TINTS.length);
    expect(avatarLetter('  ana')).toBe('A');
    expect(avatarLetter('😀 x')).toBe('😀');
    expect(avatarLetter('  ')).toBe('?');
  });
});
