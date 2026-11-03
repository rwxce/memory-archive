import type { ViewerData } from '../../lib/exporters/viewer/format';
import { fold } from './text';

/**
 * The viewer's read model: which conversations and messages are shown for a profile and a date
 * range, the timeline of a conversation, and full-text search. Pure (no DOM) and bounded: lists
 * of message positions are typed arrays, search is chunked and cancellable.
 */

export interface DateRange {
  /** Local dates `YYYY-MM-DD`, inclusive; null = open. */
  from: string | null;
  to: string | null;
}

export const NO_RANGE: DateRange = { from: null, to: null };

export interface ConversationSummary {
  /** Index in `data.conversations`. */
  index: number;
  title: string;
  isGroup: boolean;
  /** Messages in the date range. */
  count: number;
  /** `sentAt` of the first / last message in the range ('' when none). */
  first: string;
  last: string;
}

export interface TimelineMonth {
  year: number;
  month: number;
  /** Position (in the visible list) of the first message of this month. */
  pos: number;
  count: number;
}

export interface SearchHit {
  conv: number;
  /** Index in the conversation's `messages`. */
  msg: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when the search stopped at the limit. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Folded terms (see `queryTerms`); all must occur in a message. */
  terms: string[];
  profileId: string | null;
  /** Restrict to one conversation (index), or null for every conversation of the profile. */
  onlyConv: number | null;
  range: DateRange;
  limit: number;
}

export interface SearchControl {
  cancelled(): boolean;
  /** Called every few thousand messages; lets the page stay responsive. */
  yieldToUi(): Promise<void>;
}

const day = (sentAt: string) => sentAt.slice(0, 10);

function inRange(sentAt: string, range: DateRange): boolean {
  const d = day(sentAt);
  return (range.from === null || d >= range.from) && (range.to === null || d <= range.to);
}

const isOpen = (range: DateRange) => range.from === null && range.to === null;

const CHUNK = 4000;

export class ViewerModel {
  private readonly folded = new Map<number, (string | undefined)[]>();
  private cache: { key: string; value: Int32Array } | null = null;
  readonly mimeByPath = new Map<string, string>();

  constructor(readonly data: ViewerData) {
    for (const m of data.media) if (m.mime) this.mimeByPath.set(m.path, m.mime);
  }

  /** Conversation indexes filed under the profile (all of them for null). */
  conversationIndexes(profileId: string | null): number[] {
    const out: number[] = [];
    this.data.conversations.forEach((c, i) => {
      if (profileId === null || c.profileIds.includes(profileId)) out.push(i);
    });
    return out;
  }

  /** Conversations of the profile with a message in the range, most recent first. */
  summaries(profileId: string | null, range: DateRange): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const index of this.conversationIndexes(profileId)) {
      const c = this.data.conversations[index];
      let count = 0;
      let first = '';
      let last = '';
      if (isOpen(range)) {
        count = c.messages.length;
        first = c.messages[0]?.sentAt ?? '';
        last = c.messages[count - 1]?.sentAt ?? '';
      } else {
        for (const m of c.messages) {
          if (!inRange(m.sentAt, range)) continue;
          if (count === 0) first = m.sentAt;
          last = m.sentAt;
          count++;
        }
        if (count === 0) continue;
      }
      out.push({ index, title: c.title, isGroup: c.isGroup, count, first, last });
    }
    return out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : a.title.localeCompare(b.title)));
  }

  /** Positions (indexes into `messages`) of the messages in the range, in order. */
  visible(conv: number, range: DateRange): Int32Array {
    const key = `${conv}|${range.from}|${range.to}`;
    if (this.cache?.key === key) return this.cache.value;
    const messages = this.data.conversations[conv].messages;
    let value: Int32Array;
    if (isOpen(range)) {
      value = new Int32Array(messages.length);
      for (let i = 0; i < value.length; i++) value[i] = i;
    } else {
      const tmp: number[] = [];
      for (let i = 0; i < messages.length; i++) if (inRange(messages[i].sentAt, range)) tmp.push(i);
      value = Int32Array.from(tmp);
    }
    this.cache = { key, value };
    return value;
  }

  /** The smallest position in `visible` whose message index is at least `msg`. */
  positionOf(visible: Int32Array, msg: number): number {
    let lo = 0;
    let hi = visible.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (visible[mid] < msg) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Months that have messages, with the position of their first message. */
  timeline(conv: number, range: DateRange): TimelineMonth[] {
    const messages = this.data.conversations[conv].messages;
    const visible = this.visible(conv, range);
    const out: TimelineMonth[] = [];
    let current: TimelineMonth | null = null;
    for (let pos = 0; pos < visible.length; pos++) {
      const s = messages[visible[pos]].sentAt;
      const year = Number(s.slice(0, 4));
      const month = Number(s.slice(5, 7));
      if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
      if (current && current.year === year && current.month === month) current.count++;
      else {
        current = { year, month, pos, count: 1 };
        out.push(current);
      }
    }
    return out;
  }

  private foldedText(conv: number, msg: number): string {
    let list = this.folded.get(conv);
    if (!list) {
      list = new Array(this.data.conversations[conv].messages.length);
      this.folded.set(conv, list);
    }
    let value = list[msg];
    if (value === undefined) {
      const m = this.data.conversations[conv].messages[msg];
      value = fold(m.mediaName ? `${m.text}\n${m.mediaName}` : m.text);
      list[msg] = value;
    }
    return value;
  }

  /** Returns null when cancelled. */
  async search(options: SearchOptions, control: SearchControl): Promise<SearchResult | null> {
    const hits: SearchHit[] = [];
    if (options.terms.length === 0) return { hits, truncated: false };
    const convs = options.onlyConv === null ? this.conversationIndexes(options.profileId) : [options.onlyConv];
    let sinceYield = 0;
    for (const conv of convs) {
      const messages = this.data.conversations[conv].messages;
      for (let i = 0; i < messages.length; i++) {
        if (++sinceYield >= CHUNK) {
          sinceYield = 0;
          await control.yieldToUi();
          if (control.cancelled()) return null;
        }
        if (!isOpen(options.range) && !inRange(messages[i].sentAt, options.range)) continue;
        const text = this.foldedText(conv, i);
        if (!options.terms.every((t) => text.includes(t))) continue;
        if (hits.length >= options.limit) return { hits, truncated: true };
        hits.push({ conv, msg: i });
      }
    }
    return { hits, truncated: false };
  }
}
