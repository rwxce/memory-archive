import { describe, expect, test } from 'vitest';
import { withEmojiPresentation } from './emoji';

describe('withEmojiPresentation', () => {
  test('adds the emoji selector to text-default emoji', () => {
    expect(withEmojiPresentation('hi ❤')).toBe('hi ❤️');
    expect(withEmojiPresentation('☺❤')).toBe('☺️❤️');
  });

  test('leaves alone what is already emoji, text or part of a sequence', () => {
    for (const same of ['❤️', '❤︎', '\u{1F600}', '\u{1F44D}\u{1F3FD}', '❤‍\u{1F525}', '1 # * © ® ™', '1️⃣', 'plain text', '']) {
      expect(withEmojiPresentation(same)).toBe(same);
    }
  });

  test('is idempotent', () => {
    const once = withEmojiPresentation('❤ ❤️');
    expect(withEmojiPresentation(once)).toBe(once);
  });
});
