import { describe, expect, test } from 'vitest';
import type { NewMessage } from '../domain/library';
import {
  linkConversationToProfile,
  listConversationRows,
  listConversations,
  moveConversation,
  renameConversation,
  unlinkConversationFromProfile,
} from './conversations';
import { archiveProfile, createProfile } from './profiles';
import { createTestLibrary } from './test-client';
import { CONVERSATION_TITLE_MAX } from '../domain/profile';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-02-01T12:00:00Z';
const [ANA, BO, CY] = [uuid(1), uuid(2), uuid(3)];
const PRIVATE = uuid(10);
const GROUP = uuid(11);

const message = (n: number): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-01T10:0${n}:00`,
  ordinal: 0,
  type: 'text',
  participantName: n % 2 ? 'Ana' : 'Bo',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
});

async function setup() {
  const lib = await createTestLibrary();
  for (const name of ['Ana', 'Bo', 'Cy']) await createProfile(lib.deps, { displayName: name });
  await lib.client.call('createConversation', { id: PRIVATE, title: 'Chat with Ana', source: 'whatsapp', isGroup: false, profileIds: [ANA], participants: [{ displayName: 'Ana', profileId: ANA }], now: NOW });
  await lib.client.call('createConversation', { id: GROUP, title: 'Group', source: 'whatsapp', isGroup: true, profileIds: [ANA, BO], participants: [{ displayName: 'Bo', profileId: BO }, { displayName: 'Ana', profileId: null }], now: NOW });
  for (const conversationId of [PRIVATE, GROUP]) {
    await lib.client.call('importMessages', { batchId: uuid(conversationId === PRIVATE ? 100 : 101), conversationId, source: 'whatsapp', sourceLabel: 'x.zip', now: NOW, blobs: [], messages: [message(1), message(2), message(3)] });
  }
  return lib;
}

/** Everything a move must not change. */
const dataOf = (db: Awaited<ReturnType<typeof setup>>['opened']['db']) => ({
  messages: db.all('SELECT * FROM messages ORDER BY id'),
  participants: db.all('SELECT * FROM participants ORDER BY id'),
  batches: db.all('SELECT * FROM import_batches ORDER BY id'),
  blobs: db.all('SELECT * FROM blobs'),
  conversationCount: count(db, 'conversations'),
});
function count(db: Awaited<ReturnType<typeof setup>>['opened']['db'], table: string): number {
  return db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0].n;
}

describe('list and rename', () => {
  test('lists all conversations or those of one profile, with their profiles', async () => {
    const { deps } = await setup();
    expect((await listConversations(deps)).map((c) => c.title)).toEqual(['Chat with Ana', 'Group']);
    expect((await listConversations(deps, { profileId: BO })).map((c) => c.title)).toEqual(['Group']);
    expect((await listConversations(deps, { profileId: CY }))).toEqual([]);
  });

  test('rename trims the title and leaves everything else alone', async () => {
    const { deps, opened } = await setup();
    const before = dataOf(opened.db);
    const renamed = await renameConversation(deps, PRIVATE, '  Old school friends  ');
    expect(renamed).toMatchObject({ id: PRIVATE, title: 'Old school friends', messageCount: 3, profileIds: [ANA] });
    expect(dataOf(opened.db)).toEqual(before);
  });

  test('rename rejects blank or over-long titles and unknown conversations', async () => {
    const { deps } = await setup();
    await expect(renameConversation(deps, PRIVATE, '  ')).rejects.toMatchObject({ code: 'invalid' });
    await expect(renameConversation(deps, PRIVATE, 'x'.repeat(CONVERSATION_TITLE_MAX + 1))).rejects.toMatchObject({ code: 'invalid' });
    await expect(renameConversation(deps, PRIVATE, 'a\nb')).rejects.toMatchObject({ code: 'invalid' });
    await expect(renameConversation(deps, uuid(999), 'X')).rejects.toMatchObject({ code: 'not-found' });
    expect((await listConversations(deps))[0].title).toBe('Chat with Ana');
  });
});

describe('move', () => {
  test('moves a conversation to another profile without touching or duplicating any data', async () => {
    const { deps, opened } = await setup();
    const before = dataOf(opened.db);
    const linksBefore = count(opened.db, 'conversation_profiles');
    const conversationColumns = 'SELECT id, title, source, source_key, is_group, created_at FROM conversations ORDER BY id';
    const conversationsBefore = opened.db.all(conversationColumns);
    const moved = await moveConversation(deps, PRIVATE, ANA, CY);
    expect(moved.profileIds).toEqual([CY]);
    expect(moved.messageCount).toBe(3);
    expect(dataOf(opened.db)).toEqual(before);
    expect(count(opened.db, 'messages')).toBe(6);
    // The conversation row is not cloned and the number of links is the same (one replaced by one).
    expect(count(opened.db, 'conversations')).toBe(2);
    expect(count(opened.db, 'conversation_profiles')).toBe(linksBefore);
    expect(opened.db.all(conversationColumns)).toEqual(conversationsBefore);
    expect((await listConversations(deps, { profileId: ANA })).map((c) => c.id)).toEqual([GROUP]);
    expect((await listConversations(deps, { profileId: CY })).map((c) => c.id)).toEqual([PRIVATE]);
  });

  test('moving to the profile it is already under is a no-op', async () => {
    const { deps, opened } = await setup();
    const before = JSON.stringify(opened.db.all('SELECT * FROM conversation_profiles ORDER BY 1, 2'));
    const result = await moveConversation(deps, PRIVATE, ANA, ANA);
    expect(result.profileIds).toEqual([ANA]);
    expect(JSON.stringify(opened.db.all('SELECT * FROM conversation_profiles ORDER BY 1, 2'))).toBe(before);
  });

  test('moving onto a profile that already has the conversation just drops the source link', async () => {
    const { deps } = await setup();
    expect((await moveConversation(deps, GROUP, ANA, BO)).profileIds).toEqual([BO]);
  });

  test('a missing target, conversation or source link is not-found and changes nothing', async () => {
    const { deps, opened } = await setup();
    const before = JSON.stringify(opened.db.all('SELECT * FROM conversation_profiles ORDER BY 1, 2'));
    await expect(moveConversation(deps, PRIVATE, ANA, uuid(999))).rejects.toMatchObject({ code: 'not-found' });
    await expect(moveConversation(deps, uuid(999), ANA, CY)).rejects.toMatchObject({ code: 'not-found' });
    await expect(moveConversation(deps, PRIVATE, BO, CY)).rejects.toMatchObject({ code: 'not-found' });
    await expect(moveConversation(deps, PRIVATE, ANA, 'nope')).rejects.toMatchObject({ code: 'invalid' });
    expect(JSON.stringify(opened.db.all('SELECT * FROM conversation_profiles ORDER BY 1, 2'))).toBe(before);
  });

  test('an archived profile can receive and keep conversations', async () => {
    const { deps } = await setup();
    await archiveProfile(deps, CY);
    expect((await moveConversation(deps, PRIVATE, ANA, CY)).profileIds).toEqual([CY]);
    await archiveProfile(deps, ANA);
    expect((await listConversations(deps, { profileId: ANA })).map((c) => c.id)).toEqual([GROUP]);
  });

  test('participant links are independent of filing: a move does not remap participants.profile_id (follow-up)', async () => {
    const { deps, opened } = await setup();
    const participants = opened.db.all('SELECT * FROM participants WHERE conversation_id = ? ORDER BY id', [GROUP]);
    const moved = await moveConversation(deps, GROUP, BO, CY);
    expect(moved.isGroup).toBe(true);
    expect(moved.profileIds.sort()).toEqual([ANA, CY].sort());
    expect(opened.db.all('SELECT * FROM participants WHERE conversation_id = ? ORDER BY id', [GROUP])).toEqual(participants);
  });
});

describe('link and unlink', () => {
  test('unlink does not touch participants.profile_id either', async () => {
    const { deps, opened } = await setup();
    const participants = opened.db.all('SELECT * FROM participants ORDER BY id');
    await unlinkConversationFromProfile(deps, PRIVATE, ANA);
    expect(opened.db.all('SELECT * FROM participants ORDER BY id')).toEqual(participants);
    expect(opened.db.all('SELECT profile_id FROM participants WHERE conversation_id = ? AND display_name = ?', [PRIVATE, 'Ana'])).toEqual([{ profile_id: ANA }]);
  });

  test('link adds a profile (idempotently), unlink removes one, messages never change', async () => {
    const { deps, opened } = await setup();
    const before = dataOf(opened.db);
    expect((await linkConversationToProfile(deps, PRIVATE, BO)).profileIds).toEqual([ANA, BO]);
    expect((await linkConversationToProfile(deps, PRIVATE, BO)).profileIds).toEqual([ANA, BO]);
    expect((await unlinkConversationFromProfile(deps, PRIVATE, ANA)).profileIds).toEqual([BO]);
    expect((await unlinkConversationFromProfile(deps, PRIVATE, ANA)).profileIds).toEqual([BO]);
    expect(dataOf(opened.db)).toEqual(before);
  });

  test('unlinking the last profile leaves the conversation unassigned, not deleted', async () => {
    const { deps, opened } = await setup();
    const result = await unlinkConversationFromProfile(deps, PRIVATE, ANA);
    expect(result).toMatchObject({ profileIds: [], messageCount: 3 });
    expect(count(opened.db, 'messages')).toBe(6);
    expect((await listConversations(deps)).map((c) => c.id)).toContain(PRIVATE);
  });

  test('linking to a missing profile or conversation is not-found', async () => {
    const { deps } = await setup();
    await expect(linkConversationToProfile(deps, PRIVATE, uuid(999))).rejects.toMatchObject({ code: 'not-found' });
    await expect(linkConversationToProfile(deps, uuid(999), ANA)).rejects.toMatchObject({ code: 'not-found' });
    await expect(unlinkConversationFromProfile(deps, uuid(999), ANA)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('linking to an archived profile works', async () => {
    const { deps } = await setup();
    await archiveProfile(deps, CY);
    expect((await linkConversationToProfile(deps, PRIVATE, CY)).profileIds).toEqual([ANA, CY]);
  });
});

describe('listConversationRows', () => {
  test('adds distinct participant names (including message authors) in the order they were first seen', async () => {
    const { deps } = await setup();
    const rows = await listConversationRows(deps);
    expect(rows.map((r) => [r.title, r.participants])).toEqual([
      ['Chat with Ana', ['Ana', 'Bo']],
      ['Group', ['Bo', 'Ana']],
    ]);
    expect(rows[1]).toMatchObject({ isGroup: true, messageCount: 3, firstMessageAt: '2026-01-01T10:01:00', lastMessageAt: '2026-01-01T10:03:00' });
    expect((await listConversationRows(deps, { profileId: BO })).map((r) => r.title)).toEqual(['Group']);
  });
});
