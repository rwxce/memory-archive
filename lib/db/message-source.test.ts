import { beforeEach, describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import { toDbError } from './errors';
import { openMemoryDb } from './open';
import { createConversation, getMessageSource, getMessageWindow, importMessages, undoImportBatch } from './queries';
import type { SqlDb } from './sql';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const [CONV, OTHER] = [uuid(10), uuid(11)];
const [B1, B2] = [uuid(100), uuid(101)];

const msg = (n: number): NewMessage => ({
  fingerprint: fp(n),
  sentAt: `2026-01-01T10:0${n}:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
});

let db: SqlDb;
const load = (batchId: string, conversationId: string, sourceLabel: string, now: string, messages: NewMessage[]) =>
  importMessages(db, { batchId, conversationId, source: 'whatsapp', sourceLabel, now, blobs: [], messages, meAuthor: null });
const idOf = (conversationId: string, body: string) => getMessageWindow(db, conversationId, 0, 50).find((m) => m.body === body)!.id;

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return toDbError(error).code;
  }
  return 'none';
};

beforeEach(async () => {
  db = (await openMemoryDb()).db;
  const base = { source: 'whatsapp', isGroup: false, participants: [], profileIds: [], now: '2026-01-01T00:00:00Z' };
  createConversation(db, { ...base, id: CONV, title: 'Ana' });
  createConversation(db, { ...base, id: OTHER, title: 'Bo' });
});

describe('getMessageSource', () => {
  test('returns the import that added the message', () => {
    load(B1, CONV, 'Ana.zip', '2026-02-01T12:00:00Z', [msg(1)]);
    expect(getMessageSource(db, CONV, idOf(CONV, 'synthetic 1'))).toEqual({
      messageId: idOf(CONV, 'synthetic 1'),
      source: 'whatsapp',
      sourceLabel: 'Ana.zip',
      importedAt: '2026-02-01T12:00:00Z',
      batchId: B1,
    });
  });

  test('a label may be empty', () => {
    load(B1, CONV, '', '2026-02-01T12:00:00Z', [msg(1)]);
    expect(getMessageSource(db, CONV, idOf(CONV, 'synthetic 1')).sourceLabel).toBe('');
  });

  test('a message seen again in a later export stays with the first batch', () => {
    load(B1, CONV, 'old.zip', '2026-02-01T12:00:00Z', [msg(1), msg(2)]);
    load(B2, CONV, 'new.zip', '2026-03-01T12:00:00Z', [msg(2), msg(3)]);
    expect(getMessageSource(db, CONV, idOf(CONV, 'synthetic 2'))).toMatchObject({ batchId: B1, sourceLabel: 'old.zip' });
    expect(getMessageSource(db, CONV, idOf(CONV, 'synthetic 3'))).toMatchObject({ batchId: B2, sourceLabel: 'new.zip' });
  });

  test('unknown message is not-found', () => {
    load(B1, CONV, 'Ana.zip', '2026-02-01T12:00:00Z', [msg(1)]);
    expect(codeOf(() => getMessageSource(db, CONV, 999_999))).toBe('not-found');
  });

  test('a message of another conversation is not-found, so ids cannot be probed across chats', () => {
    load(B1, OTHER, 'Bo.zip', '2026-02-01T12:00:00Z', [msg(1)]);
    const id = idOf(OTHER, 'synthetic 1');
    expect(getMessageSource(db, OTHER, id).batchId).toBe(B1);
    expect(codeOf(() => getMessageSource(db, CONV, id))).toBe('not-found');
    expect(codeOf(() => getMessageSource(db, uuid(99), id))).toBe('not-found');
  });

  test('malformed ids are invalid', () => {
    load(B1, CONV, 'Ana.zip', '2026-02-01T12:00:00Z', [msg(1)]);
    for (const bad of ['1', 0, -1, 1.5, Number.NaN, Infinity, null, undefined]) {
      expect(codeOf(() => getMessageSource(db, CONV, bad as never))).toBe('invalid');
    }
    for (const bad of ['nope', '', null, 5]) {
      expect(codeOf(() => getMessageSource(db, bad as never, 1))).toBe('invalid');
    }
  });

  test('after the batch is undone the message is gone', () => {
    load(B1, CONV, 'Ana.zip', '2026-02-01T12:00:00Z', [msg(1)]);
    const id = idOf(CONV, 'synthetic 1');
    undoImportBatch(db, B1);
    expect(codeOf(() => getMessageSource(db, CONV, id))).toBe('not-found');
  });
});
