import { describe, expect, test } from 'vitest';
import { defaultLocale, locales, pickLocale } from './routing';

describe('pickLocale', () => {
  test('first supported primary subtag wins', () => {
    expect(pickLocale(['de-DE', 'ca-ES', 'es'])).toBe('ca');
    expect(pickLocale(['es-419', 'en'])).toBe('es');
    expect(pickLocale(['EN_gb'])).toBe('en');
  });

  test('falls back to the default locale', () => {
    expect(pickLocale(['fr', 'de'])).toBe(defaultLocale);
    expect(pickLocale([])).toBe(defaultLocale);
    expect(pickLocale(undefined)).toBe(defaultLocale);
  });

  test('locales are ca, es, en with en as default', () => {
    expect([...locales].sort()).toEqual(['ca', 'en', 'es']);
    expect(defaultLocale).toBe('en');
  });
});
