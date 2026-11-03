import { describe, expect, test } from 'vitest';
import type { Message } from '../../importers/whatsapp/types';
import { renderHtml } from './html';
import { formatDay, labelsFor } from './labels';
import { renderMarkdown } from './md';

const MSG: Message = {
  timestamp_iso: '2026-01-05T10:00:00',
  author: 'Ana',
  text: 'hi',
  type: 'text',
  media: '',
} as Message;

describe('renderer labels', () => {
  test('no lang: legacy pt-BR output unchanged', async () => {
    const html = await renderHtml([MSG], 'Chat');
    expect(html).toContain('<html lang="pt-BR"');
    expect(html).toContain('<title>Chat — WhatsApp Backup</title>');
    expect(html).toContain('Todos os contatos');
    expect(html).toContain('placeholder="Buscar…"');
    expect(html).toContain('🌓 Tema</button>');
    expect(html).toContain('05 de janeiro de 2026');
    expect(await renderMarkdown([MSG], 'Chat')).toContain('## 05 de janeiro de 2026');
  });

  test.each([
    ['ca', '05 de gener del 2026', 'Tots els remitents', 'Cerca…'],
    ['es', '05 de enero de 2026', 'Todos los remitentes', 'Buscar…'],
    ['en', 'January 05, 2026', 'All senders', 'Search…'],
  ] as const)('%s: headings and toolbar', async (lang, day, all, search) => {
    const html = await renderHtml([MSG], 'Chat', { lang });
    expect(html).toContain(`<html lang="${lang}"`);
    expect(html).toContain('<title>Chat</title>');
    expect(html).not.toContain('WhatsApp Backup');
    expect(html).toContain(day);
    expect(html).toContain(all);
    expect(html).toContain(`placeholder="${search}"`);
    expect(await renderMarkdown([MSG], 'Chat', { lang })).toContain(`## ${day}`);
  });

  test('hostile title stays escaped with a lang', async () => {
    const html = await renderHtml([MSG], '"><script>x</script>', { lang: 'en' });
    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(html).not.toContain('<script>x</script>');
  });

  test('formatDay and labelsFor', () => {
    expect(formatDay('2026-03-01', 'en')).toBe('March 01, 2026');
    expect(labelsFor().locale).toBe('pt-BR');
  });
});
