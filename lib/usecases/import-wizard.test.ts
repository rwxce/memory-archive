import { describe, expect, test } from 'vitest';
import { DbError } from '../db/errors';
import { ArchiveError } from '../exporters/archive/format';
import { BlobStoreError } from '../storage/blob-store';
import { ImportError } from './import';
import type { ImportPreview } from './import-preview';
import {
  guessedMe,
  importProblemOf,
  importRequest,
  isImportableExport,
  messagesToAdd,
  previewRequest,
  spaceFits,
} from './import-wizard';

const space = { neededBytes: 1, availableBytes: 1, videoBytes: 0, fits: true, fitsWithoutVideos: true, suggestSkipVideos: false };
const preview = (patch: Partial<ImportPreview> = {}): ImportPreview => ({
  chatTitle: 'Ana',
  sourceKey: 'ana',
  isGroup: false,
  messageCount: 10,
  firstAt: '2026-03-17T13:17:05',
  lastAt: '2026-03-18T09:10:00',
  authors: [
    { name: 'Ana', messageCount: 6, looksLikePhoneNumber: false },
    { name: '+34 600 11 22 33', messageCount: 4, looksLikePhoneNumber: true },
  ],
  authorsTruncated: false,
  suggestedMe: 'Ana',
  dateFormat: { dayFirst: true, ambiguous: false },
  rawLines: 0,
  media: { byKind: {}, totalCount: 0, totalBytes: 0, missing: 0 },
  space,
  duplicates: { status: 'new' },
  ...patch,
});
const file = new File(['x'], 'WhatsApp Chat - Ana.zip');

describe('importProblemOf', () => {
  test('maps typed errors to the problems the copy knows, never to the raw message', () => {
    expect(importProblemOf(new ImportError('invalid-export', 'secret detail'))).toBe('invalid-export');
    expect(importProblemOf(new ImportError('limit-exceeded', 'x'))).toBe('too-big');
    expect(importProblemOf(new ImportError('worker-failed', 'x'))).toBe('worker-failed');
    expect(importProblemOf(new ImportError('unknown-author', 'x'))).toBe('other');
    expect(importProblemOf(new ArchiveError('busy', 'x'))).toBe('busy');
    expect(importProblemOf(new ArchiveError('not-an-archive', 'x'))).toBe('other');
    expect(importProblemOf(new BlobStoreError('io', 'x'))).toBe('storage');
    expect(importProblemOf(new DbError('internal', 'x'))).toBe('other');
    expect(importProblemOf(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe('storage');
    expect(importProblemOf('weird')).toBe('other');
  });
});

describe('isImportableExport', () => {
  test('accepts ZIPs and plain-text exports by extension or type, not media', () => {
    expect(isImportableExport({ name: 'Chat.ZIP', type: '' })).toBe(true);
    expect(isImportableExport({ name: 'chat', type: 'application/zip' })).toBe(true);
    expect(isImportableExport({ name: 'chat', type: 'application/x-zip-compressed; x=y' })).toBe(true);
    expect(isImportableExport({ name: '_chat.txt', type: 'text/plain' })).toBe(true);
    expect(isImportableExport({ name: 'WhatsApp Chat with Ana.TXT', type: '' })).toBe(true);
    expect(isImportableExport({ name: 'chat', type: 'text/plain; charset=utf-8' })).toBe(true);
    expect(isImportableExport({ name: 'messages.json', type: '' })).toBe(true);
    expect(isImportableExport({ name: 'messages.HTML', type: '' })).toBe(true);
    expect(isImportableExport({ name: 'messages.csv', type: 'text/csv' })).toBe(true);
    expect(isImportableExport({ name: 'export', type: 'application/json' })).toBe(true);
    expect(isImportableExport({ name: 'messages.md', type: 'text/markdown' })).toBe(false);
    expect(isImportableExport({ name: 'notes.pdf', type: 'application/pdf' })).toBe(false);
    expect(isImportableExport({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
  });
});

describe('requests', () => {
  const storage = { usage: 10, quota: 100 };

  test('the preview request carries the person, the conversation target and the date reading', () => {
    expect(previewRequest(file, { profileIds: ['p'], conversation: { mode: 'auto' } }, storage)).toMatchObject({
      fileName: file.name,
      profileIds: ['p'],
      conversation: { mode: 'auto' },
      storage,
    });
    const day = previewRequest(file, { profileIds: [], conversation: { mode: 'new' }, dateOrder: 'day-first' }, storage);
    expect(day).toMatchObject({ dayFirst: true, conversation: { mode: 'new' } });
    expect(day).not.toHaveProperty('monthFirst');
    expect(previewRequest(file, { profileIds: [], conversation: { mode: 'auto' }, dateOrder: 'month-first' }, storage)).toMatchObject({ monthFirst: true });
  });

  test('the import request passes "me" (or null), the target, skipVideos and one date flag at most', () => {
    const request = importRequest(file, {
      profileIds: ['p'],
      meAuthor: null,
      conversation: { mode: 'existing', conversationId: 'c' },
      skipVideos: true,
      dateOrder: 'month-first',
    });
    expect(request).toMatchObject({
      profileIds: ['p'],
      meAuthor: null,
      conversation: { mode: 'existing', conversationId: 'c' },
      options: { skipVideos: true },
      monthFirst: true,
    });
    expect(request).not.toHaveProperty('dayFirst');
  });
});

describe('derived values', () => {
  test('messagesToAdd: the new ones for a known conversation, all of them otherwise', () => {
    expect(messagesToAdd(preview())).toBe(10);
    expect(
      messagesToAdd(preview({ duplicates: { status: 'existing', conversationId: 'c', title: 'Ana', storedCount: 7, alreadyThere: 7, wouldAdd: 3 } })),
    ).toBe(3);
  });

  test('guessedMe is only a name that can be selected', () => {
    expect(guessedMe(preview())).toBe('Ana');
    expect(guessedMe(preview({ suggestedMe: null }))).toBeNull();
    expect(guessedMe(preview({ suggestedMe: 'Gone' }))).toBeNull();
  });

  test('spaceFits follows skipVideos and keeps null (unknown) as null', () => {
    const tight = preview({ space: { ...space, fits: false, fitsWithoutVideos: true } });
    expect(spaceFits(tight, false)).toBe(false);
    expect(spaceFits(tight, true)).toBe(true);
    expect(spaceFits(preview({ space: { ...space, fits: null, fitsWithoutVideos: null } }), false)).toBeNull();
  });
});
