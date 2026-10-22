import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStaticServer, resolveFile } from './serve-out.mjs';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-out-'));
  fs.mkdirSync(path.join(root, 'en', 'settings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), 'root');
  fs.writeFileSync(path.join(root, '404.html'), 'missing');
  fs.writeFileSync(path.join(root, 'en', 'index.html'), 'en');
  fs.writeFileSync(path.join(root, 'en', 'settings', 'index.html'), 'settings');
  fs.writeFileSync(path.join(root, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(path.dirname(root), 'serve-out-secret.txt'), 'secret');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(root), 'serve-out-secret.txt'), { force: true });
});

async function serve(basePath: string) {
  const server = createStaticServer({ root, basePath });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual' });
    return { status: res.status, body: await res.text(), type: res.headers.get('content-type'), res };
  };
  return { get, close: () => new Promise((r) => server.close(r)) };
}

describe('serve-out', () => {
  test('resolveFile: directories, extensionless paths, and no escape from root', () => {
    expect(resolveFile(root, '/en/')).toBe(path.join(root, 'en', 'index.html'));
    expect(resolveFile(root, '/en/settings')).toBe(path.join(root, 'en', 'settings', 'index.html'));
    expect(resolveFile(root, '/../serve-out-secret.txt')).toBeNull();
    expect(resolveFile(root, '/%2e%2e/serve-out-secret.txt')).toBeNull();
    expect(resolveFile(root, '/..%2fserve-out-secret.txt')).toBeNull();
    expect(resolveFile(root, '/%E0%A4%A')).toBeNull();
  });

  test('serves pages, MIME types and 404.html', async () => {
    const s = await serve('');
    try {
      expect(await s.get('/')).toMatchObject({ status: 200, body: 'root' });
      expect(await s.get('/en/settings/')).toMatchObject({ status: 200, body: 'settings' });
      expect((await s.get('/manifest.webmanifest')).type).toContain('application/manifest+json');
      expect(await s.get('/nope/')).toMatchObject({ status: 404, body: 'missing' });
    } finally {
      await s.close();
    }
  });

  test('honours a base path', async () => {
    const s = await serve('/memory-archive');
    try {
      const root = await s.get('/');
      expect(root.status).toBe(302);
      expect(root.res.headers.get('location')).toBe('/memory-archive/');
      expect(await s.get('/memory-archive/en/')).toMatchObject({ status: 200, body: 'en' });
      expect((await s.get('/en/')).status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
