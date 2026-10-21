import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWhatsAppZip, streamWhatsAppZip } from './import';

const NOTAS_ZIP = path.join(process.cwd(), 'fixtures', 'WhatsApp Chat - Notas pessoais.zip');

describe('parseWhatsAppZip (browser-style input)', () => {
  test('parses the fixture from an in-memory Blob, as a browser File would be', async () => {
    // Only the fixture read uses Node; the importer receives a plain Blob and
    // reads it through web streams.
    const zip = new Blob([fs.readFileSync(NOTAS_ZIP)]);
    const res = await parseWhatsAppZip(zip, 'WhatsApp Chat - Notas pessoais.zip');
    expect(res.info).toEqual({ slug: 'notas-pessoais', name: 'Notas pessoais' });
    expect(res.detection?.dayFirst).toBe(true);
    expect(res.messages.length).toBeGreaterThan(5);
    expect(res.messages[0]).toMatchObject({
      timestamp_iso: '2026-03-17T13:17:59',
      author: 'Guionardo Furlan',
      text: 'https://lefthook.dev/',
    });
    expect(res.messages.some((m) => m.type === 'sticker')).toBe(true);
    expect(res.entries.some((e) => e.name.endsWith('.mp4'))).toBe(true);
  });

  test('honours day/month overrides', async () => {
    const zip = new Blob([fs.readFileSync(NOTAS_ZIP)]);
    const res = await parseWhatsAppZip(zip, 'n.zip', { monthFirst: true });
    expect(res.detection).toMatchObject({ dayFirst: false, overridden: true });
  });
});

describe('streamWhatsAppZip', () => {
  const zip = () => new Blob([fs.readFileSync(NOTAS_ZIP)]);

  test('yields the same messages, detection and warnings as parseWhatsAppZip, one at a time', async () => {
    const whole = await parseWhatsAppZip(zip(), 'WhatsApp Chat - Notas pessoais.zip');
    const stream = await streamWhatsAppZip(zip(), 'WhatsApp Chat - Notas pessoais.zip');
    const streamed = [];
    for await (const m of stream.messages) streamed.push(m);
    expect(streamed).toEqual(whole.messages);
    expect(stream.detection).toEqual(whole.detection);
    expect(stream.warnings).toEqual(whole.warnings);
    expect(stream.info).toEqual(whole.info);
  });

  test('an aborted signal stops the read, in the format pass and in the parse', async () => {
    const before = new AbortController();
    before.abort(new Error('stop'));
    await expect(streamWhatsAppZip(zip(), 'n.zip', { signal: before.signal })).rejects.toThrow('stop');
    const during = new AbortController();
    const stream = await streamWhatsAppZip(zip(), 'n.zip', { signal: during.signal });
    const iterator = stream.messages[Symbol.asyncIterator]();
    await iterator.next();
    during.abort(new Error('stop'));
    await expect(iterator.next()).rejects.toThrow('stop');
  });
});
