import { afterEach, describe, expect, test, vi } from 'vitest';
import { assertPublicHttpUrl, enrichTitles, fetchTitle, guardedFetch, isPrivateAddress } from './titles';
import type { Message } from '@/lib/importers/whatsapp';

const PUBLIC = { resolveHost: async () => ['93.184.216.34'] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2001:db8::1', 'not-an-ip',
  ])('%s is non-public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('assertPublicHttpUrl', () => {
  test.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'javascript:alert(1)',
    'http://user:pass@example.com/',
    'http://127.0.0.1/',
    'http://[::1]:8080/',
    'http://2130706433/', // 127.0.0.1 in decimal
    'http://169.254.169.254/latest/meta-data',
  ])('blocks %s', async (url) => {
    await expect(assertPublicHttpUrl(url, PUBLIC)).rejects.toThrow(/blocked/);
  });

  test('blocks a name that resolves to a private address (any record)', async () => {
    const resolveHost = async () => ['93.184.216.34', '10.0.0.5'];
    await expect(assertPublicHttpUrl('https://intranet.example/', { resolveHost })).rejects.toThrow(
      /non-public/,
    );
  });

  test('allows a public https URL', async () => {
    await expect(assertPublicHttpUrl('https://example.com/a', PUBLIC)).resolves.toBeInstanceOf(URL);
  });
});

describe('guardedFetch redirects', () => {
  test('a redirect to a private address is refused before it is requested', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    await expect(guardedFetch('https://example.com/', {}, PUBLIC)).rejects.toThrow(/blocked/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('redirects are capped', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(null, { status: 301, headers: { location: '/again' } }),
    );
    await expect(guardedFetch('https://example.com/', {}, PUBLIC)).rejects.toThrow(/too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // first request + 3 redirects
  });

  test('fetchTitle falls back to the derived title when blocked, without any request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await fetchTitle('http://localhost:3000/admin', { resolveHost: async () => ['127.0.0.1'] })).toBe(
      'localhost/admin',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enrichTitles keeps stored titles', () => {
  const msgs = (): Message[] => [
    {
      timestamp_iso: '2026-01-01T00:00:00',
      type: 'text',
      author: 'a',
      text: 'old https://example.com/old and new https://example.com/new',
      media: '',
      urlTitles: { 'https://example.com/old': 'Stored Title' },
    },
  ];

  test('disabled: nothing fetched, nothing removed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const m = msgs();
    await enrichTitles(m, { enabled: false });
    expect(m[0].urlTitles).toEqual({ 'https://example.com/old': 'Stored Title' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('enabled: only URLs without a stored title are fetched', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('<title>Fresh</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const m = msgs();
    await enrichTitles(m, { ...PUBLIC, enabled: true });
    expect(m[0].urlTitles).toEqual({
      'https://example.com/old': 'Stored Title',
      'https://example.com/new': 'Fresh',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.com/new');
  });
});
