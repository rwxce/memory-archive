import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDbWorker } from './build-db-worker.mjs';

let outDir: string;
let worker: string;
let wasm: string;
let importWorker: string;

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-worker-'));
  ({ worker, wasm, importWorker } = await buildDbWorker({ outDir }));
});

afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

describe('build-db-worker', () => {
  test('emits the worker module and the SQLite binary side by side', () => {
    expect(path.dirname(worker)).toBe(path.dirname(wasm));
    const magic = fs.readFileSync(wasm).subarray(0, 4);
    expect([...magic]).toEqual([0x00, 0x61, 0x73, 0x6d]); // "\0asm"
  });

  test('the worker finds the .wasm relative to itself (same origin, no CDN)', () => {
    const code = fs.readFileSync(worker, 'utf8');
    expect(code).toContain('sqlite3.wasm');
    expect(code).toContain('import.meta.url');
  });

  test('no remote URL is reachable from the bundle', () => {
    const code = fs.readFileSync(worker, 'utf8');
    // Every URL literal must be documentation or an XML namespace, never a fetch target.
    const ALLOWED_HOSTS = new Set(['sqlite.org', 'www.sqlite.org', 'www.w3.org', 'github.com', 'emscripten.org']);
    const urls = [...code.matchAll(/https?:\/\/[^\s"'`)<>\\]+/gi)].map((m) => m[0]);
    const offenders = urls.filter((u) => !ALLOWED_HOSTS.has(new URL(u).hostname));
    expect(offenders).toEqual([]);
    // No network or remote-script call takes a literal remote target.
    expect(code).not.toMatch(/\b(?:fetch|importScripts|XMLHttpRequest[^;]*?open|WebSocket|EventSource|sendBeacon)\s*\(\s*[`"']\s*(?:https?:)?\/\//i);
  });

  test('bundles the SAH-pool VFS (no COOP/COEP headers needed)', () => {
    const code = fs.readFileSync(worker, 'utf8');
    expect(code).toContain('installOpfsSAHPoolVfs');
  });

  test('the import worker is its own bundle: no SQLite inside, no remote URL', () => {
    const code = fs.readFileSync(importWorker, 'utf8');
    expect(path.dirname(importWorker)).toBe(path.dirname(worker));
    expect(code).not.toContain('installOpfsSAHPoolVfs');
    expect(code).not.toContain('sqlite3.wasm');
    expect(code).toContain('memory-archive-blobs'); // it writes the blob store itself
    // Only a documentation link inside a date-fns error message.
    const urls = [...code.matchAll(/https?:\/\/[^\s"'`)<>\\]+/gi)].map((m) => new URL(m[0]).hostname);
    expect(urls.filter((host) => host !== 'github.com')).toEqual([]);
    expect(code).not.toMatch(/\b(?:fetch|importScripts|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/);
  });
});
