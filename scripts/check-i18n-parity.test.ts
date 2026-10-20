import { describe, expect, test } from 'vitest';
import { compareCatalogs, flatten, placeholders } from './check-i18n-parity.mjs';

describe('check-i18n-parity', () => {
  test('flatten nests keys with dots and rejects non-strings', () => {
    expect(flatten({ a: { b: 'x', c: { d: 'y' } }, e: 'z' })).toEqual({ 'a.b': 'x', 'a.c.d': 'y', e: 'z' });
    expect(() => flatten({ a: 1 })).toThrow(/a: message must be a string/);
  });

  test('placeholders: top-level ICU arguments only, quoted braces ignored', () => {
    expect(placeholders('App {version}')).toEqual(['version']);
    expect(placeholders('{count, plural, one {# photo of {name}} other {# photos}}')).toEqual(['count']);
    expect(placeholders("Literal '{brace}' here")).toEqual([]);
  });

  test('parity: missing keys, placeholder drift and empty strings are reported', () => {
    const problems = compareCatalogs({
      en: { a: 'Hi {name}', b: 'Two', c: 'Three' },
      ca: { a: 'Hola {nom}', b: '' },
      es: { a: 'Hola {name}', b: 'Dos', c: 'Tres' },
    });
    expect(problems).toEqual([
      'a: placeholders differ (en={name} ca={nom} es={name})',
      'b: empty in ca',
      'c: missing in ca',
    ]);
  });

  test('the shipped catalogs are in parity', async () => {
    const [en, ca, es] = await Promise.all(
      ['en', 'ca', 'es'].map(async (l) => (await import(`../messages/${l}.json`)).default),
    );
    expect(compareCatalogs({ en, ca, es })).toEqual([]);
  });
});
