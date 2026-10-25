import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConversationMessage } from '@/lib/domain/library';
import { ConversationBody, type FeedSource } from './conversation-body';
import { act } from 'react';
import { renderWithLibrary, settle, type Rendered } from './test-utils';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sub',
}));

const COUNT = 20;
const message = (i: number): ConversationMessage => ({
  id: 100 + i,
  sentAt: `2026-03-17T10:${String(i).padStart(2, '0')}:00`,
  ordinal: i,
  type: 'text',
  isSystem: false,
  participantName: 'Bo',
  isMe: false,
  body: `hello ${i}`,
  mediaSha256: null,
  mediaName: '',
  mediaMime: null,
  isFavorite: false,
  hasNote: false,
});

function source(over: Partial<FeedSource> = {}): FeedSource {
  return {
    id: 'feed-1',
    label: 'Feed',
    count: COUNT,
    firstSentAt: message(0).sentAt,
    lastSentAt: message(COUNT - 1).sentAt,
    start: { kind: 'index', index: 0 },
    readWindow: async (offset, limit) => Array.from({ length: Math.min(limit, COUNT - offset) }, (_, i) => message(offset + i)),
    findOffset: async () => 0,
    listDays: async () => [],
    ...over,
  };
}

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const row = (index: number) => view!.container.querySelector<HTMLElement>(`[role="feed"] article[data-index="${index}"]`);

describe('ConversationBody with a linked message', () => {
  test('asks the source for the message, marks and focuses its row and says so politely', async () => {
    const findMessageOffset = vi.fn(async () => 3);
    view = await renderWithLibrary(<ConversationBody source={source({ findMessageOffset })} messageId={103} />);
    await settle();
    expect(findMessageOffset).toHaveBeenCalledExactlyOnceWith(103);
    const target = row(3)!;
    expect(target.className).toContain('jump-flash');
    expect(target.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(target);
    expect(view.container.querySelector('[role="status"]')!.textContent).toBe('Message from Mar 17, 2026.');
    expect(row(4)!.className).not.toContain('jump-flash');
    expect(row(4)!.hasAttribute('tabindex')).toBe(false);
  });

  test('the flash is removed after ~1.5 s and focus stays on the message', async () => {
    const real = window.setTimeout.bind(window);
    const fades: Array<() => void> = [];
    const spy = vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 1500) {
        fades.push(fn);
        return 0;
      }
      return real(fn, delay, ...args);
    }) as typeof window.setTimeout);
    try {
      view = await renderWithLibrary(<ConversationBody source={source({ findMessageOffset: async () => 2 })} messageId={102} />);
      await settle();
      expect(row(2)!.className).toContain('jump-flash');
      expect(fades).toHaveLength(1);
      await act(async () => fades[0]());
      expect(row(2)!.className).not.toContain('jump-flash');
      expect(document.activeElement).toBe(row(2));
    } finally {
      spy.mockRestore();
    }
  });

  test('a message that is not in the feed leaves it where it opened, without a mark', async () => {
    view = await renderWithLibrary(<ConversationBody source={source({ findMessageOffset: async () => null })} messageId={999} />);
    await settle();
    expect(view.container.querySelector('.jump-flash')).toBeNull();
    expect(view.container.querySelector('[role="status"]')!.textContent).toBe('');
  });

  test('without a message id, or a source that cannot find one, nothing is looked up', async () => {
    const findMessageOffset = vi.fn(async () => 1);
    view = await renderWithLibrary(<ConversationBody source={source({ findMessageOffset })} />);
    await settle();
    expect(findMessageOffset).not.toHaveBeenCalled();
    view.unmount();
    view = await renderWithLibrary(<ConversationBody source={source()} messageId={105} />);
    await settle();
    expect(view.container.querySelector('.jump-flash')).toBeNull();
  });
});
