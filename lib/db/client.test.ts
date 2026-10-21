import { describe, expect, test } from 'vitest';
import { createDbClient, type DbTransport } from './client';
import { handleDbRequest } from './dispatch';
import { DbError } from './errors';
import { openMemoryDb, type OpenedDb } from './open';
import type { DbRequest, DbResponse } from './protocol';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * A worker stand-in: requests and responses cross `structuredClone` exactly as
 * they cross a real worker boundary (plain data only), and the real dispatcher
 * answers against a real in-memory database.
 */
function loopback(opened: OpenedDb, options: { reverse?: boolean } = {}) {
  let respond: (r: DbResponse) => void = () => {};
  let fail: (m: string) => void = () => {};
  const queue: DbResponse[] = [];
  const transport: DbTransport = {
    send: (request) => {
      const response = structuredClone(handleDbRequest(opened, structuredClone(request) as DbRequest));
      if (options.reverse) queue.push(response);
      else queueMicrotask(() => respond(response));
    },
    onResponse: (l) => (respond = l),
    onFailure: (l) => (fail = l),
    close: () => {},
  };
  return { transport, flush: () => queue.reverse().splice(0).forEach(respond), crash: (m: string) => fail(m) };
}

describe('db client', () => {
  test('round-trips typed calls through the dispatcher', async () => {
    const { transport } = loopback(await openMemoryDb());
    const client = createDbClient(transport);
    const status = await client.call('status');
    expect(status.persistence).toBe('memory');
    expect(status.schemaVersion).toBeGreaterThanOrEqual(1);
    await client.call('createProfile', { id: uuid(1), displayName: 'Ana', now: '2026-01-01T00:00:00Z' });
    expect((await client.call('listProfiles')).map((p) => p.displayName)).toEqual(['Ana']);
    expect(await client.call('listConversations')).toEqual([]);
  });

  test('matches responses to requests by id, whatever the order', async () => {
    const { transport, flush } = loopback(await openMemoryDb(), { reverse: true });
    const client = createDbClient(transport);
    const a = client.call('createProfile', { id: uuid(1), displayName: 'First', now: 't' });
    const b = client.call('createProfile', { id: uuid(2), displayName: 'Second', now: 't' });
    flush();
    expect((await a).displayName).toBe('First');
    expect((await b).displayName).toBe('Second');
  });

  test('database errors reject with a DbError carrying the code', async () => {
    const { transport } = loopback(await openMemoryDb());
    const client = createDbClient(transport);
    await expect(client.call('createProfile', { id: 'bad', displayName: 'X', now: 't' })).rejects.toMatchObject({
      name: 'DbError',
      code: 'invalid',
    });
    await client.call('createProfile', { id: uuid(1), displayName: 'Ana', now: 't' });
    const dup = client.call('createProfile', { id: uuid(1), displayName: 'Ana', now: 't' });
    await expect(dup).rejects.toBeInstanceOf(DbError);
    await expect(dup).rejects.toMatchObject({ code: 'constraint' });
  });

  test('an unknown operation is refused, not executed', async () => {
    const opened = await openMemoryDb();
    const response = handleDbRequest(opened, { id: 1, op: 'dropEverything' as 'status', params: undefined });
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(handleDbRequest(opened, { id: 2, op: 'constructor' as 'status', params: undefined })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
  });

  test('a worker failure rejects pending and later calls as unavailable', async () => {
    const { transport, crash } = loopback(await openMemoryDb(), { reverse: true });
    const client = createDbClient(transport);
    const pending = client.call('status');
    crash('worker failed to start');
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.call('status')).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('close rejects pending calls and refuses new ones', async () => {
    const { transport } = loopback(await openMemoryDb(), { reverse: true });
    const client = createDbClient(transport);
    const pending = client.call('status');
    client.close();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    await expect(client.call('status')).rejects.toMatchObject({ code: 'closed' });
  });

  test('a transport that throws on send leaves nothing pending and rejects the call', async () => {
    const boom = new Error('send failed');
    const transport: DbTransport = {
      send: () => {
        throw boom;
      },
      onResponse: () => {},
      onFailure: () => {},
      close: () => {},
    };
    const client = createDbClient(transport);
    await expect(client.call('status')).rejects.toBe(boom);
    // The client is still usable for the next call (nothing stuck in `pending`).
    await expect(client.call('status')).rejects.toBe(boom);
    client.close();
  });

  test('malformed params are invalid, not internal', async () => {
    const opened = await openMemoryDb();
    const bad = (op: string, params: unknown) =>
      handleDbRequest(opened, { id: 1, op: op as 'status', params: params as undefined });
    const invalid = { ok: false, error: { code: 'invalid' } };
    for (const params of [undefined, null, 'x', 7, []]) {
      expect(bad('listParticipants', params)).toMatchObject(invalid);
      expect(bad('listMessages', params)).toMatchObject(invalid);
      expect(bad('createProfile', params)).toMatchObject(invalid);
      expect(bad('createConversation', params)).toMatchObject(invalid);
      expect(bad('importMessages', params)).toMatchObject(invalid);
    }
    for (const params of [null, 'x', 7, []]) expect(bad('listConversations', params)).toMatchObject(invalid);
    const ok = { id: uuid(1), title: 'T', source: 'whatsapp', isGroup: false, now: 't' };
    expect(bad('createConversation', { ...ok, profileIds: 'nope', participants: [] })).toMatchObject(invalid);
    expect(bad('createConversation', { ...ok, profileIds: [], participants: [null] })).toMatchObject(invalid);
    expect(bad('createProfile', { id: uuid(2), displayName: 5, now: 't' })).toMatchObject(invalid);
    const imp = { batchId: uuid(3), conversationId: uuid(4), source: 'whatsapp', sourceLabel: '', now: 't' };
    expect(bad('importMessages', { ...imp, blobs: {}, messages: [] })).toMatchObject(invalid);
    expect(bad('importMessages', { ...imp, blobs: [], messages: 'x' })).toMatchObject(invalid);
    expect(bad('importMessages', { ...imp, blobs: [], messages: [null] })).toMatchObject(invalid);
    expect(bad('listMessages', { conversationId: uuid(4), limit: 'many' })).toMatchObject(invalid);
    expect(bad('listMessages', { conversationId: uuid(4), after: { sentAt: 1 } })).toMatchObject(invalid);
  });

  test('profile and conversation ops reject malformed params as invalid and unknown targets as not-found', async () => {
    const opened = await openMemoryDb();
    const bad = (op: string, params: unknown) =>
      handleDbRequest(opened, { id: 1, op: op as 'status', params: params as undefined });
    const invalid = { ok: false, error: { code: 'invalid' } };
    const notFound = { ok: false, error: { code: 'not-found' } };
    const ops = ['getProfile', 'updateProfile', 'setProfileArchived', 'renameConversation', 'moveConversation', 'linkConversationProfile', 'unlinkConversationProfile'];
    for (const op of ops) {
      for (const params of [undefined, null, 'x', 7, [], {}]) expect(bad(op, params), `${op} ${JSON.stringify(params)}`).toMatchObject(invalid);
    }
    for (const params of [null, 'x', 7, [], { state: 'deleted' }]) expect(bad('listProfiles', params)).toMatchObject(invalid);
    expect(bad('listProfiles', undefined)).toMatchObject({ ok: true });

    expect(bad('setProfileArchived', { id: uuid(1), archived: 'yes', now: 't' })).toMatchObject(invalid);
    expect(bad('updateProfile', { id: uuid(1), now: 't', photo: 'abc' })).toMatchObject(invalid);
    expect(bad('updateProfile', { id: uuid(1), now: 't', displayName: 5 })).toMatchObject(invalid);
    expect(bad('createProfile', { id: uuid(2), displayName: 'A', relationship: 5, now: 't' })).toMatchObject(invalid);

    expect(bad('getProfile', { id: uuid(1) })).toMatchObject(notFound);
    expect(bad('updateProfile', { id: uuid(1), now: 't' })).toMatchObject(notFound);
    expect(bad('setProfileArchived', { id: uuid(1), archived: true, now: 't' })).toMatchObject(notFound);
    expect(bad('renameConversation', { conversationId: uuid(1), title: 'T' })).toMatchObject(notFound);
    expect(bad('moveConversation', { conversationId: uuid(1), fromProfileId: uuid(2), toProfileId: uuid(3) })).toMatchObject(notFound);
    expect(bad('linkConversationProfile', { conversationId: uuid(1), profileId: uuid(2) })).toMatchObject(notFound);
    expect(bad('unlinkConversationProfile', { conversationId: uuid(1), profileId: uuid(2) })).toMatchObject(notFound);
  });

  test('new ops round-trip through the client with typed results', async () => {
    const { transport } = loopback(await openMemoryDb());
    const client = createDbClient(transport);
    await client.call('createProfile', { id: uuid(1), displayName: 'Ana', now: 't' });
    await client.call('createProfile', { id: uuid(2), displayName: 'Bo', now: 't' });
    await client.call('createConversation', { id: uuid(10), title: 'C', source: 'whatsapp', isGroup: false, profileIds: [uuid(1)], participants: [], now: 't' });
    expect((await client.call('getProfile', { id: uuid(1) })).displayName).toBe('Ana');
    expect((await client.call('setProfileArchived', { id: uuid(2), archived: true, now: 'u' })).archivedAt).toBe('u');
    expect((await client.call('listProfiles', { state: 'active' })).map((p) => p.displayName)).toEqual(['Ana']);
    expect((await client.call('moveConversation', { conversationId: uuid(10), fromProfileId: uuid(1), toProfileId: uuid(2) })).profileIds).toEqual([uuid(2)]);
    expect((await client.call('renameConversation', { conversationId: uuid(10), title: ' New ' })).title).toBe('New');
  });
});
