import { describe, expect, test } from 'vitest';
import { accentHue } from '@/lib/exporters/legacy/colors';
import { senderHue } from './sender-color';

describe('senderHue', () => {
  test('is stable, within a circle, and the same as the standalone viewer uses', () => {
    for (const name of ['Ana', 'Bo', 'María José', 'أحمد', '~ Eve']) {
      expect(senderHue(name)).toBe(senderHue(name));
      expect(senderHue(name)).toBeGreaterThanOrEqual(0);
      expect(senderHue(name)).toBeLessThan(360);
      expect(senderHue(name)).toBe(accentHue(name));
    }
    expect(senderHue('Ana')).not.toBe(senderHue('Bo'));
  });
});
