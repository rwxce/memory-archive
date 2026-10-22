import type { ConversationMessage } from '@/lib/domain/library';

/** Messages per page the view asks the database for. */
export const PAGE_SIZE = 100;
/** Pages kept in memory (about 1,200 messages): the visible ones, their neighbours, and a little history. */
export const MAX_PAGES = 12;

/** One window of messages, plus the message just before it (so the first row knows if the day or sender changed). */
export interface Page {
  index: number;
  messages: ConversationMessage[];
  before: ConversationMessage | null;
}

export interface MessageAt {
  message: ConversationMessage;
  /** The message before this one, when it is known. */
  previous: ConversationMessage | null;
}

/** The pages to load for rows `start`..`end` (exclusive): those rows' pages first, then one more on each side. */
export function pagesFor(start: number, end: number, count: number, pageSize = PAGE_SIZE): number[] {
  if (count === 0 || end <= start) return [];
  const last = Math.floor((count - 1) / pageSize);
  const first = Math.min(Math.floor(start / pageSize), last);
  const final = Math.min(Math.floor((Math.min(end, count) - 1) / pageSize), last);
  const order: number[] = [];
  for (let p = first; p <= final; p++) order.push(p);
  if (first > 0) order.push(first - 1);
  if (final < last) order.push(final + 1);
  return order;
}

/**
 * Identifies a message across feeds: on a person's timeline the rows carry their conversation; in a
 * conversation they do not, and `feedId` is that conversation's id.
 */
export const messageKey = (feedId: string, message: ConversationMessage): string =>
  `${'conversationId' in message ? String((message as { conversationId: unknown }).conversationId) : feedId}:${message.id}`;

/** A bounded cache of pages by page number. */
export class PageCache {
  private readonly pages = new Map<number, Page>();
  constructor(
    readonly max: number = MAX_PAGES,
    readonly pageSize: number = PAGE_SIZE,
  ) {}

  get size(): number {
    return this.pages.size;
  }

  has(index: number): boolean {
    return this.pages.has(index);
  }

  keys(): number[] {
    return [...this.pages.keys()].sort((a, b) => a - b);
  }

  set(page: Page): void {
    this.pages.set(page.index, page);
  }

  /** Drops the pages farthest from `center` until at most `max` remain; never the ones in `keep`. */
  trim(center: number, keep: ReadonlySet<number>): void {
    if (this.pages.size <= this.max) return;
    const victims = [...this.pages.keys()].filter((p) => !keep.has(p)).sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const p of victims) {
      if (this.pages.size <= this.max) break;
      this.pages.delete(p);
    }
  }

  /**
   * Replaces, in place, every cached message `change` returns a new object for (the row before a page
   * is a copy of another page's last row, so it is replaced too). Positions and counts do not move.
   */
  update(change: (message: ConversationMessage) => ConversationMessage | undefined): boolean {
    let changed = false;
    for (const [key, page] of this.pages) {
      const before = page.before && change(page.before);
      const messages = page.messages.map((m) => change(m) ?? m);
      const touched = before !== null && before !== undefined ? true : messages.some((m, i) => m !== page.messages[i]);
      if (!touched) continue;
      changed = true;
      this.pages.set(key, { ...page, messages, before: before ?? page.before });
    }
    return changed;
  }

  at(index: number): MessageAt | undefined {
    const page = this.pages.get(Math.floor(index / this.pageSize));
    if (!page) return undefined;
    const inPage = index - page.index * this.pageSize;
    const message = page.messages[inPage];
    if (!message) return undefined;
    return { message, previous: inPage > 0 ? page.messages[inPage - 1] : page.before };
  }
}
