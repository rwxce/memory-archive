import { describe, expect, test } from 'vitest';
import { splitLinks } from './message-text';

describe('splitLinks', () => {
  test('plain text is one text part; empty is nothing', () => {
    expect(splitLinks('hello there')).toEqual([{ kind: 'text', text: 'hello there' }]);
    expect(splitLinks('')).toEqual([]);
  });

  test('links are cut out, trailing punctuation goes back to the text, the label is host and path', () => {
    expect(splitLinks('see https://www.example.com/a/b/. ok')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'https://www.example.com/a/b/', label: 'example.com/a/b' },
      { kind: 'text', text: '. ok' },
    ]);
  });

  test('markup stays text: nothing is escaped or built here, the UI renders it as text', () => {
    const text = '<img src=x onerror=alert(1)> <script>x</script>';
    expect(splitLinks(text)).toEqual([{ kind: 'text', text }]);
  });

  test('only http(s): javascript:, data: and file: stay plain text', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'JaVaScRiPt:alert(1)']) {
      expect(splitLinks(text).every((part) => part.kind === 'text')).toBe(true);
    }
  });

  test('a LinkedIn redirect wrapper unwraps to its target, but never to a non-web address', () => {
    const wrapped = (target: string) => `https://www.linkedin.com/safety/go/?url=${encodeURIComponent(target)}`;
    expect(splitLinks(wrapped('https://example.org/x'))).toEqual([{ kind: 'link', href: 'https://example.org/x', label: 'example.org/x' }]);
    const [part] = splitLinks(wrapped('javascript:alert(1)'));
    expect(part).toMatchObject({ kind: 'link' });
    expect((part as { href: string }).href.startsWith('https://www.linkedin.com/')).toBe(true);
  });

  test('two links and right-to-left text keep their order', () => {
    const parts = splitLinks('مرحبا https://a.example/x و https://b.example/y');
    expect(parts.map((p) => p.kind)).toEqual(['text', 'link', 'text', 'link']);
    expect(parts.map((p) => (p.kind === 'link' ? p.href : p.text)).join('')).toBe('مرحبا https://a.example/x و https://b.example/y');
  });
});
