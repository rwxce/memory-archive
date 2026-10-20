import { describe, expect, test } from 'vitest';
import { redirectPath } from './locale-redirect';

describe('redirectPath', () => {
  test('plain root goes to the locale home', () => {
    expect(redirectPath('ca', '')).toBe('/ca/');
    expect(redirectPath('en', '?utm_source=x')).toBe('/en/');
  });

  test('share target lands on the import screen with a bounded count', () => {
    expect(redirectPath('es', '?to=import&received=2')).toBe('/es/import/?received=2');
    expect(redirectPath('es', '?to=import&received=<script>')).toBe('/es/import/');
  });

  test('unknown or hostile targets are ignored (no open redirect)', () => {
    expect(redirectPath('en', '?to=//evil.example')).toBe('/en/');
    expect(redirectPath('en', '?to=../settings')).toBe('/en/');
  });
});
