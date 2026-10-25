import { describe, expect, test } from 'vitest';
import { conversationHref, parseBackParam } from './conversation-link';

describe('conversationHref', () => {
  test('adds the message and, only with a person, the section to come back to', () => {
    const base = { conversationId: 'c1', sentAt: '2026-03-17T10:00:00', messageId: 7 };
    expect(conversationHref({ ...base, personId: 'p1', back: 'highlights' })).toBe('/conversation?id=c1&from=p1&date=2026-03-17&message=7&back=highlights');
    expect(conversationHref({ ...base, personId: 'p1' })).toBe('/conversation?id=c1&from=p1&date=2026-03-17&message=7');
    expect(conversationHref({ ...base, back: 'favorites' })).toBe('/conversation?id=c1&date=2026-03-17&message=7');
  });

  test('back= is a whitelist of names, never a path', () => {
    expect(parseBackParam('highlights')).toBe('highlights');
    expect(parseBackParam('favorites')).toBe('favorites');
    for (const bad of [null, '', '/people', '//evil.example', 'https://evil.example', 'Highlights']) expect(parseBackParam(bad)).toBeNull();
  });
});
