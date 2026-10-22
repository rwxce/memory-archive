import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import {
  MAX_WINDOW,
  countPersonMedia,
  createConversation,
  createProfile,
  importMessages,
  linkConversationProfile,
  listPersonMedia,
  setProfileArchived,
} from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const NOW = '2026-02-01T12:00:00Z';
const [ANA, BO] = [uuid(1), uuid(2)];
const [C1, C2, C3, SHARED] = [uuid(10), uuid(11), uuid(12), uuid(13)];
const VOICE = 'ab'.repeat(32);
const PIC = 'cd'.repeat(32);

let n = 0;
const msg = (sentAt: string, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: fp(++n),
  sentAt,
  ordinal: 0,
  type: 'audio',
  participantName: 'Ana',
  body: '',
  mediaSha256: VOICE,
  mediaName: 'PTT.opus',
  ...over,
});

let db: SqlDb;
let batch = 100;
function load(conversationId: string, messages: NewMessage[]) {
  importMessages(db, {
    batchId: uuid(batch++),
    conversationId,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs: [
      { sha256: VOICE, size: 3, mime: 'audio/ogg' },
      { sha256: PIC, size: 3, mime: null },
    ],
    messages,
    meAuthor: 'Ana',
  });
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return toDbError(error).code;
  }
  return 'none';
};

beforeEach(async () => {
  n = 0;
  batch = 100;
  db = (await openMemoryDb()).db;
  createProfile(db, { id: ANA, displayName: 'Ana', now: NOW });
  createProfile(db, { id: BO, displayName: 'Bo', now: NOW });
  const base = { source: 'whatsapp', isGroup: false, participants: [], now: NOW };
  createConversation(db, { ...base, id: C1, title: 'Ana 1', profileIds: [ANA] });
  createConversation(db, { ...base, id: C2, title: 'Ana 2', profileIds: [ANA] });
  createConversation(db, { ...base, id: C3, title: 'Bo only', profileIds: [BO] });
  createConversation(db, { ...base, id: SHARED, title: 'Family', isGroup: true, profileIds: [ANA, BO] });
});

describe('person media reads', () => {
  test('merges every conversation of the person in time order, with conversation, author and media', () => {
    load(C1, [msg('2026-01-03T10:00:00', { body: 'late' }), msg('2026-01-01T10:00:00', { participantName: 'Bo' })]);
    load(C2, [msg('2026-01-02T10:00:00')]);
    const items = listPersonMedia(db, ANA, ['audio'], 0, 10);
    expect(items.map((i) => i.sentAt)).toEqual(['2026-01-01T10:00:00', '2026-01-02T10:00:00', '2026-01-03T10:00:00']);
    expect(items.map((i) => i.conversationTitle)).toEqual(['Ana 1', 'Ana 2', 'Ana 1']);
    expect(items[0]).toMatchObject({ conversationId: C1, participantName: 'Bo', isMe: false, type: 'audio', mediaSha256: VOICE, mediaName: 'PTT.opus', mediaMime: 'audio/ogg', body: '' });
    expect(items[2]).toMatchObject({ participantName: 'Ana', isMe: true, body: 'late' });
    expect(countPersonMedia(db, ANA, ['audio'])).toBe(3);
  });

  test('ties are a stable total order (sent_at, ordinal, id) and pages tile exactly', () => {
    const same = '2026-01-01T10:00:00';
    load(C1, [msg(same, { ordinal: 1, body: 'c1-o1' }), msg(same, { ordinal: 0, body: 'c1-o0' })]);
    load(C2, [msg(same, { ordinal: 0, body: 'c2-o0' }), msg(same, { ordinal: 1, body: 'c2-o1' })]);
    const all = listPersonMedia(db, ANA, ['audio'], 0, 10).map((i) => i.body);
    expect(all).toEqual(['c1-o0', 'c2-o0', 'c1-o1', 'c2-o1']);
    expect([0, 2].flatMap((o) => listPersonMedia(db, ANA, ['audio'], o, 2).map((i) => i.body))).toEqual(all);
    expect(listPersonMedia(db, ANA, ['audio'], 0, 10).map((i) => i.body)).toEqual(all);
  });

  test('kinds filter: only the asked types, and text or file-less messages never appear', () => {
    load(C1, [
      msg('2026-01-01T10:00:00'),
      msg('2026-01-01T10:01:00', { type: 'photo', mediaSha256: PIC, mediaName: 'a.jpg' }),
      msg('2026-01-01T10:02:00', { type: 'text', mediaSha256: null, mediaName: '', body: 'hi' }),
      msg('2026-01-01T10:03:00', { type: 'omitted', mediaSha256: null, mediaName: '' }),
      msg('2026-01-01T10:04:00', { type: 'audio', mediaSha256: null, mediaName: '', body: 'audio omitted' }),
    ]);
    expect(listPersonMedia(db, ANA, ['audio'], 0, 10)).toHaveLength(1);
    expect(listPersonMedia(db, ANA, ['photo'], 0, 10).map((i) => i.mediaName)).toEqual(['a.jpg']);
    expect(listPersonMedia(db, ANA, ['audio', 'photo', 'audio'], 0, 10)).toHaveLength(2);
    expect(countPersonMedia(db, ANA, ['video', 'sticker', 'document'])).toBe(0);
    expect(countPersonMedia(db, ANA, ['audio', 'photo'])).toBe(2);
  });

  test("other people's conversations are excluded, a shared conversation shows for both", () => {
    load(C1, [msg('2026-01-01T10:00:00', { body: 'ana' })]);
    load(C3, [msg('2026-01-02T10:00:00', { body: 'bo' })]);
    load(SHARED, [msg('2026-01-03T10:00:00', { body: 'family' })]);
    expect(listPersonMedia(db, ANA, ['audio'], 0, 10).map((i) => i.body)).toEqual(['ana', 'family']);
    expect(listPersonMedia(db, BO, ['audio'], 0, 10).map((i) => i.body)).toEqual(['bo', 'family']);
    expect(countPersonMedia(db, BO, ['audio'])).toBe(2);
  });

  test('moving a conversation moves its media; an archived person still lists theirs', () => {
    load(C1, [msg('2026-01-01T10:00:00')]);
    linkConversationProfile(db, { conversationId: C1, profileId: BO });
    expect(countPersonMedia(db, BO, ['audio'])).toBe(1);
    setProfileArchived(db, { id: ANA, archived: true, now: NOW });
    expect(listPersonMedia(db, ANA, ['audio'], 0, 10)).toHaveLength(1);
  });

  test('edges: empty person, offset past the end, limit clamped', () => {
    expect(listPersonMedia(db, ANA, ['audio'], 0, 10)).toEqual([]);
    expect(countPersonMedia(db, ANA, ['audio'])).toBe(0);
    load(C1, Array.from({ length: MAX_WINDOW + 20 }, (_, i) => msg('2026-01-01T10:00:00', { ordinal: i })));
    expect(listPersonMedia(db, ANA, ['audio'], MAX_WINDOW + 20, 10)).toEqual([]);
    expect(listPersonMedia(db, ANA, ['audio'], 1_000_000, 10)).toEqual([]);
    expect(listPersonMedia(db, ANA, ['audio'], 0, 100_000)).toHaveLength(MAX_WINDOW);
    expect(listPersonMedia(db, ANA, ['audio'], MAX_WINDOW, 100_000)).toHaveLength(20);
    expect(listPersonMedia(db, ANA, ['audio'], 0, 0)).toHaveLength(1);
    expect(listPersonMedia(db, ANA, ['audio'], 0, 2.9)).toHaveLength(2);
  });

  test('an overlapping re-import does not duplicate the list', () => {
    const batchMsgs = [msg('2026-01-01T10:00:00')];
    load(C1, batchMsgs);
    load(C1, batchMsgs);
    expect(countPersonMedia(db, ANA, ['audio'])).toBe(1);
  });

  test('malformed input is invalid, an unknown profile not-found', () => {
    expect(codeOf(() => countPersonMedia(db, uuid(99), ['audio']))).toBe('not-found');
    expect(codeOf(() => listPersonMedia(db, uuid(99), ['audio'], 0, 10))).toBe('not-found');
    expect(codeOf(() => countPersonMedia(db, 'nope', ['audio']))).toBe('invalid');
    for (const kinds of [[], ['text'], ['system'], ['audio', 'nope'], 'audio', null, undefined, [1], ["audio') OR 1=1 --"]]) {
      expect(codeOf(() => countPersonMedia(db, ANA, kinds as never))).toBe('invalid');
      expect(codeOf(() => listPersonMedia(db, ANA, kinds as never, 0, 10))).toBe('invalid');
    }
    for (const offset of [-1, 1.5, Number.NaN, Infinity, '1' as unknown as number]) {
      expect(codeOf(() => listPersonMedia(db, ANA, ['audio'], offset, 10))).toBe('invalid');
    }
    for (const limit of [Number.NaN, Infinity, undefined as unknown as number]) {
      expect(codeOf(() => listPersonMedia(db, ANA, ['audio'], 0, limit))).toBe('invalid');
    }
  });
});
