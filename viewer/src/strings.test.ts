import { describe, expect, test } from 'vitest';
import { TABLES, makeTranslate, pickLocale } from './strings';

describe('viewer strings', () => {
  test('ca, es and en define the same keys with the same placeholders and no empty value', () => {
    const keys = Object.keys(TABLES.en).sort();
    for (const locale of ['ca', 'es'] as const) {
      expect(Object.keys(TABLES[locale]).sort()).toEqual(keys);
    }
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys as (keyof typeof TABLES.en)[]) {
      for (const locale of ['ca', 'es', 'en'] as const) {
        expect(TABLES[locale][key].trim(), `${locale}.${key}`).not.toBe('');
        expect(params(TABLES[locale][key]), `${locale}.${key}`).toEqual(params(TABLES.en[key]));
        expect(TABLES[locale][key], `${locale}.${key}`).not.toMatch(/!|<|>/);
      }
    }
  });
  test('picks the first supported browser language, English by default', () => {
    expect(pickLocale(['fr-FR', 'ca-ES', 'en'])).toBe('ca');
    expect(pickLocale(['es'])).toBe('es');
    expect(pickLocale(['de'])).toBe('en');
    expect(pickLocale(undefined)).toBe('en');
  });
  test('fills placeholders', () => {
    expect(makeTranslate('en')('messageMany', { count: '1,200' })).toBe('1,200 messages');
  });
});
