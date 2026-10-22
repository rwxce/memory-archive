import { describe, expect, test } from 'vitest';
import { cleanReleaseMessage } from './clean-release-message.mjs';

describe('clean-release-message', () => {
  test('drops the block GitHub appends on a web squash-merge, with its co-authors', () => {
    const merged = [
      'release: v0.4.0 (#62)',
      '',
      'Release v0.4.0: the app redesign.',
      '',
      '---------',
      '',
      'Co-authored-by: Someone <someone@example.com>',
      'Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
      '',
    ].join('\n');
    expect(cleanReleaseMessage(merged)).toBe('release: v0.4.0 (#62)\n\nRelease v0.4.0: the app redesign.\n');
  });

  test('drops co-author trailers even without the separator, in any case', () => {
    const msg = 'release: v1.0.0 (#9)\n\nBody.\n\nCo-Authored-By: A <a@example.com>\nco-authored-by: B <b@example.com>\n';
    expect(cleanReleaseMessage(msg)).toBe('release: v1.0.0 (#9)\n\nBody.\n');
  });

  test('a clean message comes back unchanged', () => {
    const msg = 'release: v0.3.0 (#58)\n\nShort body.\n';
    expect(cleanReleaseMessage(msg)).toBe(msg);
    expect(cleanReleaseMessage('release: v0.3.0')).toBe('release: v0.3.0\n');
  });

  test('keeps a dash line that is not exactly the nine-dash separator', () => {
    const msg = 'release: v0.5.0 (#70)\n\n- a list item\n----\nend\n';
    expect(cleanReleaseMessage(msg)).toBe(msg);
  });
});
