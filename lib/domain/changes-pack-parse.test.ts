import { describe, expect, test } from 'vitest';
import {
  PackRecordError,
  noteTombstoneKey,
  parsePackBatchHeader,
  parsePackBlob,
  parsePackConversation,
  parsePackFavorite,
  parsePackMessage,
  parsePackNote,
  parsePackPhotoBatchHeader,
  parsePackPhotoItem,
  parsePackPhotoLink,
  parsePackProfile,
  parsePackTombstone,
} from './changes-pack-parse';
import { IDS, MESSAGES, PHOTO_ITEMS, syntheticChangeSet } from '../exporters/changes-pack/test-pack';

const set = syntheticChangeSet();
const rejects = (parse: (raw: unknown) => unknown, raw: unknown) => expect(() => parse(raw)).toThrow(PackRecordError);

describe('parsing the records of a changes pack', () => {
  test('every record the exporter writes is accepted as it is, and unknown extra keys are ignored', () => {
    expect(parsePackProfile(set.profiles[0])).toEqual(set.profiles[0]);
    expect(parsePackConversation(set.conversations[0])).toEqual(set.conversations[0]);
    expect(parsePackBlob(set.blobs[0])).toEqual(set.blobs[0]);
    expect(parsePackFavorite(set.favorites[0])).toEqual(set.favorites[0]);
    expect(parsePackNote(set.notes[0])).toEqual(set.notes[0]);
    expect(parsePackTombstone(set.tombstones[0])).toEqual(set.tombstones[0]);
    expect(parsePackBatchHeader(set.batches[0])).toEqual(set.batches[0]);
    for (const m of MESSAGES) expect(parsePackMessage(m)).toEqual(m);
    expect(parsePackProfile({ ...set.profiles[0], futureField: 1 })).toEqual(set.profiles[0]);
  });

  test('profiles: ids, normalized text, photo hash, dates and change numbers', () => {
    const p = set.profiles[0];
    for (const bad of [
      null, [], 'x', { ...p, id: p.id.replace('4000', '4AAA') }, { ...p, displayName: '' }, { ...p, displayName: ' Ana' }, { ...p, displayName: 'x'.repeat(101) },
      { ...p, relationship: 'a\u0007b' }, { ...p, description: 1 }, { ...p, photoSha256: 'abc' }, { ...p, archivedAt: 'someday' },
      { ...p, createdAt: '' }, { ...p, updatedAt: 5 }, { ...p, seq: -1 }, { ...p, seq: 1.5 }, { ...p, seq: Number.MAX_SAFE_INTEGER + 1 }, { ...p, seq: '3' },
    ]) rejects(parsePackProfile, bad);
  });

  test('conversations: links and participants are lists without repeats and with at most one "me"', () => {
    const c = set.conversations[0];
    const person = { displayName: 'x', profileId: null, isMe: false };
    for (const bad of [
      { ...c, title: 5 }, { ...c, source: '' }, { ...c, isGroup: 'no' }, { ...c, profileIds: 'x' }, { ...c, profileIds: ['nope'] },
      { ...c, profileIds: [IDS.profile, IDS.profile] }, { ...c, participants: [person, person] },
      { ...c, participants: [{ ...person, isMe: true }, { ...person, displayName: 'y', isMe: true }] },
      { ...c, participants: [{ ...person, profileId: 'nope' }] }, { ...c, participants: [{ displayName: 'x' }] },
    ]) rejects(parsePackConversation, bad);
  });

  test('notes, favorites, blobs and batch headers', () => {
    const n = set.notes[0];
    for (const bad of [
      { ...n, body: '' }, { ...n, body: ' padded ' }, { ...n, body: 'x'.repeat(10_001) }, { ...n, target: { kind: 'message', conversationId: IDS.conversation } },
      { ...n, target: { kind: 'file' } }, { ...n, target: 'conversation' },
    ]) rejects(parsePackNote, bad);
    rejects(parsePackFavorite, { ...set.favorites[0], conversationId: 'x' });
    rejects(parsePackBlob, { ...set.blobs[0], size: -1 });
    rejects(parsePackBlob, { ...set.blobs[0], mime: 'image/jpeg; boundary=x' });
    rejects(parsePackBatchHeader, { ...set.batches[0], createdConversation: 1 });
    rejects(parsePackBatchHeader, { ...set.batches[0], source: '' });
  });

  test('messages: type, local time, ordinal, hash and text fields', () => {
    const m = MESSAGES[0];
    for (const bad of [
      { ...m, type: 'script' }, { ...m, sentAt: '2026-01-01' }, { ...m, sentAt: '2026-01-01T10:00:00Z' }, { ...m, ordinal: -1 }, { ...m, ordinal: 0.5 },
      { ...m, fingerprint: 'ab' }, { ...m, body: null }, { ...m, author: 5 }, { ...m, mediaSha256: 'x' }, { ...m, mediaName: 'x'.repeat(1001) }, { ...m, author: 'x'.repeat(1001) },
    ]) rejects(parsePackMessage, bad);
  });

  test('tombstones: the scope and key must be exactly the shapes the schema writes', () => {
    const fp = 'ab'.repeat(32);
    const ok = (kind: string, scope: string, key: string) => ({ kind, scope, key, deletedAt: '2026-01-01T00:00:00Z', seq: 2 });
    expect(parsePackTombstone(ok('note', '', `profile:${IDS.profile}`))).toBeTruthy();
    expect(parsePackTombstone(ok('note', IDS.conversation, 'conversation'))).toBeTruthy();
    expect(parsePackTombstone(ok('note', IDS.conversation, `message:${fp}`))).toBeTruthy();
    expect(parsePackTombstone(ok('batch', IDS.conversation, IDS.batch))).toBeTruthy();
    expect(parsePackTombstone(ok('photo-batch', '', IDS.photoBatch))).toBeTruthy();
    expect(parsePackTombstone(ok('photo-link', IDS.profile, fp))).toBeTruthy();
    for (const bad of [
      ok('photo-batch', IDS.conversation, IDS.photoBatch), ok('photo-batch', '', 'x'), ok('photo-batch', '', fp),
      ok('photo-link', '', fp), ok('photo-link', IDS.profile, IDS.photoBatch), ok('photo-link', 'x', fp), ok('photos', '', IDS.photoBatch),
      ok('note', '', 'conversation'), ok('note', '', 'profile:x'), ok('note', 'x', 'conversation'), ok('note', IDS.conversation, 'message:zz'),
      ok('favorite', IDS.conversation, 'short'), ok('favorite', '', fp), ok('batch', IDS.conversation, 'x'), ok('conversation', IDS.conversation, fp),
      { ...ok('batch', IDS.conversation, IDS.batch), seq: 0 },
    ]) rejects(parsePackTombstone, bad);
  });

  test('photo batch headers, items and links: every field is checked, and an offered shape is exactly what the exporter writes', () => {
    const header = set.photoBatches[0];
    expect(parsePackPhotoBatchHeader(header)).toEqual(header);
    for (const bad of [
      { ...header, id: 'x' }, { ...header, source: '' }, { ...header, source: 'x'.repeat(41) }, { ...header, createdAt: 'never' },
      { ...header, addedCount: -1 }, { ...header, skippedCount: 1.5 }, { ...header, seq: 'a' },
    ]) rejects(parsePackPhotoBatchHeader, bad);

    const item = PHOTO_ITEMS[0];
    expect(parsePackPhotoItem(item)).toEqual(item);
    expect(parsePackPhotoItem({ ...item, dateSource: 'exif', takenOffsetMinutes: 120, latitude: 41.4, longitude: 2.2 })).toBeTruthy();
    expect(parsePackPhotoItem({ ...item, takenAt: null, dateSource: 'none', mime: null, album: '' })).toBeTruthy();
    for (const bad of [
      { ...item, sha256: 'ab' }, { ...item, kind: 'audio' }, { ...item, mime: 'text/html; x=y' }, { ...item, takenAt: '2019-07-01' },
      { ...item, takenAt: '2019-02-31T10:00:00Z' }, { ...item, dateSource: 'guess' }, { ...item, dateSource: 'none' }, { ...item, takenAt: null },
      { ...item, takenOffsetMinutes: 120 }, { ...item, dateSource: 'exif', takenOffsetMinutes: 7 },
      { ...item, latitude: 10, longitude: null }, { ...item, latitude: 91, longitude: 0 }, { ...item, latitude: 0, longitude: 181 },
      { ...item, latitude: Number.NaN, longitude: 0 }, { ...item, fileName: '' }, { ...item, fileName: 'x'.repeat(256) },
      { ...item, album: 'x'.repeat(201) }, { ...item, description: 'x'.repeat(4001) }, { ...item, description: null },
    ]) rejects(parsePackPhotoItem, bad);
    // length is counted in code points, not UTF-16 units
    expect(parsePackPhotoItem({ ...item, album: '\u{1F600}'.repeat(200) })).toBeTruthy();

    const link = set.photoLinks[0];
    expect(parsePackPhotoLink(link)).toEqual(link);
    for (const bad of [{ ...link, sha256: 'x' }, { ...link, profileId: 'x' }, { ...link, createdAt: 'x' }, { ...link, seq: -1 }]) rejects(parsePackPhotoLink, bad);
  });

  test('a note and its tombstone are named the same way', () => {
    expect(noteTombstoneKey({ kind: 'profile', profileId: IDS.profile })).toEqual({ scope: '', key: `profile:${IDS.profile}` });
    expect(noteTombstoneKey({ kind: 'conversation', conversationId: IDS.conversation })).toEqual({ scope: IDS.conversation, key: 'conversation' });
    const fingerprint = 'cd'.repeat(32);
    expect(noteTombstoneKey({ kind: 'message', conversationId: IDS.conversation, fingerprint })).toEqual({ scope: IDS.conversation, key: `message:${fingerprint}` });
  });

  test('the error never carries the offending value', () => {
    try {
      parsePackProfile({ ...set.profiles[0], displayName: 'Secret Name'.repeat(20) });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('Secret');
    }
  });
});
