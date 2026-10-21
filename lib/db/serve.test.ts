import { describe, expect, test } from 'vitest';
import { createDbClient, createPortTransport, type DbTransport } from './client';
import { DbError } from './errors';
import { openMemoryDb, type OpenedDb } from './open';
import type { DbRequest, DbResponse } from './protocol';
import { createDbServer } from './serve';

const PROFILE = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Ana', now: '2026-03-01T10:00:00.000Z' };

/** A client that reaches the server the way the page does (direct replies). */
function directClient(server: ReturnType<typeof createDbServer>) {
  let respond: (r: DbResponse) => void = () => {};
  return createDbClient({
    send: (request: DbRequest) => server.handle(structuredClone(request), (r) => queueMicrotask(() => respond(structuredClone(r)))),
    onResponse: (l) => (respond = l),
    onFailure: () => {},
    close: () => {},
  });
}

function portClient(server: ReturnType<typeof createDbServer>) {
  const channel = new MessageChannel();
  server.handle({ type: 'connect', port: channel.port1 }, () => {});
  return createDbClient(createPortTransport(channel.port2));
}

describe('createDbServer: connect', () => {
  test('a connected port and the page talk to the same connection', async () => {
    const opened = await openMemoryDb();
    const server = createDbServer(async () => opened);
    const page = directClient(server);
    const viaPort = portClient(server);
    try {
      await viaPort.call('createProfile', PROFILE);
      expect((await page.call('listProfiles')).map((p) => p.displayName)).toEqual(['Ana']);
      expect((await viaPort.call('status')).persistence).toBe('memory');
    } finally {
      viaPort.close();
    }
  });

  test('errors cross the port as typed DbErrors; a bad request does not stop the port', async () => {
    const opened = await openMemoryDb();
    const viaPort = portClient(createDbServer(async () => opened));
    try {
      await expect(viaPort.call('getProfile', { id: PROFILE.id })).rejects.toMatchObject({ name: 'DbError', code: 'not-found' });
      await expect((viaPort.call as (op: string) => Promise<unknown>)('nope')).rejects.toMatchObject({ code: 'invalid' });
      await expect(viaPort.call('status')).resolves.toMatchObject({ schemaVersion: expect.any(Number) });
    } finally {
      viaPort.close();
    }
  });

  test('two ports run side by side and each gets only its own answers', async () => {
    const opened = await openMemoryDb();
    const server = createDbServer(async () => opened);
    const a = portClient(server);
    const b = portClient(server);
    try {
      const [pa, pb] = await Promise.all([
        a.call('createProfile', PROFILE),
        b.call('createProfile', { ...PROFILE, id: '00000000-0000-4000-8000-000000000002', displayName: 'Bo' }),
      ]);
      expect([pa.displayName, pb.displayName]).toEqual(['Ana', 'Bo']);
      expect(await a.call('listProfiles')).toHaveLength(2);
    } finally {
      a.close();
      b.close();
    }
  });

  test('the database opens once, on the first request from any source; a failed open is retried', async () => {
    let attempts = 0;
    let real: OpenedDb | undefined;
    const server = createDbServer(async () => {
      attempts++;
      if (attempts === 1) throw new DbError('unavailable', 'held by another tab');
      return (real ??= await openMemoryDb());
    });
    const viaPort = portClient(server);
    try {
      await expect(viaPort.call('status')).rejects.toMatchObject({ code: 'unavailable' });
      await expect(viaPort.call('status')).resolves.toBeTruthy();
      await directClient(server).call('status');
      expect(attempts).toBe(2);
    } finally {
      viaPort.close();
    }
  });
});

describe('DbClient.connectPort', () => {
  const transport = (extra: Partial<DbTransport> = {}): DbTransport => ({
    send: () => {},
    onResponse: () => {},
    onFailure: () => {},
    close: () => {},
    ...extra,
  });

  test('is unavailable when the transport cannot share its connection', () => {
    expect(() => createDbClient(transport()).connectPort()).toThrowError(expect.objectContaining({ code: 'unavailable' }));
  });

  test('hands out the transport\'s port, and refuses once the client is closed', () => {
    const channel = new MessageChannel();
    const client = createDbClient(transport({ connect: () => channel.port2 }));
    expect(client.connectPort()).toBe(channel.port2);
    client.close();
    expect(() => client.connectPort()).toThrowError(expect.objectContaining({ code: 'closed' }));
    channel.port1.close();
    channel.port2.close();
  });
});
