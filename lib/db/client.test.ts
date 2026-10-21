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
});
