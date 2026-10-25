import { describe, expect, test } from 'vitest';
import { FINDINGS_LIMITS, parseFindings } from './highlights';

const FP = 'a'.repeat(64);

function valid() {
  return {
    version: 1,
    conversation: { name: 'Example Org', messageCount: 12, firstFingerprint: 'b'.repeat(64) },
    highlights: [
      {
        id: 'h-1',
        category: 'moment',
        title: 'A first plan',
        summary: 'Two lines\nof summary.',
        messages: [FP, 'c'.repeat(64)],
        createdBy: 'claude',
        createdAt: '2026-01-31T10:00:00Z',
      },
    ],
  };
}

function codes(input: unknown): string[] {
  const r = parseFindings(input);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('parseFindings', () => {
  test('accepts a valid file and returns it normalized', () => {
    const r = parseFindings({ ...valid(), extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.highlights[0]!.messages).toHaveLength(2);
      expect(r.value).not.toHaveProperty('extra');
    }
  });

  test('firstFingerprint and an empty summary are optional / allowed', () => {
    const f = valid();
    delete (f.conversation as { firstFingerprint?: string }).firstFingerprint;
    f.highlights[0]!.summary = '';
    expect(parseFindings(f).ok).toBe(true);
  });

  test('rejects non-objects without throwing', () => {
    for (const v of [null, 'x', 3, [], undefined]) expect(codes(v)).toEqual(['not-object']);
  });

  test('refuses other and newer versions', () => {
    expect(codes({ ...valid(), version: 2 })).toEqual(['unsupported-version']);
    expect(codes({ ...valid(), version: '1' })).toEqual(['unsupported-version']);
    const r = parseFindings({ ...valid(), version: 2 });
    expect(!r.ok && r.errors[0]!.message).toMatch(/newer/);
  });

  test('rejects bad categories and fingerprints', () => {
    const f = valid();
    f.highlights[0]!.category = 'other';
    expect(codes(f)).toContain('invalid-category');
    const g = valid();
    g.highlights[0]!.messages = ['A'.repeat(64), 'abc', FP.slice(1)];
    expect(codes(g)).toEqual(['invalid-fingerprint', 'invalid-fingerprint', 'invalid-fingerprint']);
    const h = valid();
    h.conversation.firstFingerprint = 'zz';
    expect(codes(h)).toContain('invalid-fingerprint');
  });

  test('rejects empty message lists, duplicate ids and bad ids', () => {
    const f = valid();
    f.highlights[0]!.messages = [];
    expect(codes(f)).toContain('invalid-highlight');
    const g = valid();
    g.highlights.push({ ...g.highlights[0]! });
    expect(codes(g)).toContain('duplicate-id');
    const h = valid();
    h.highlights[0]!.id = '../x';
    expect(codes(h)).toContain('invalid-highlight');
  });

  test('bounds sizes and counts', () => {
    const f = valid();
    f.highlights[0]!.title = 'x'.repeat(FINDINGS_LIMITS.title + 1);
    expect(codes(f)).toContain('too-long');
    const g = valid();
    g.highlights[0]!.messages = Array.from({ length: FINDINGS_LIMITS.messagesPerHighlight + 1 }, () => FP);
    expect(codes(g)).toEqual(['too-many-messages']);
    const h = valid();
    h.highlights = Array.from({ length: FINDINGS_LIMITS.highlights + 1 }, (_, i) => ({ ...valid().highlights[0]!, id: `h${i}` }));
    expect(codes(h)).toEqual(['too-many-highlights']);
  });

  test('rejects control characters, lone surrogates and bad dates', () => {
    const f = valid();
    f.highlights[0]!.title = 'a‮b';
    expect(codes(f)).toContain('invalid-highlight');
    const g = valid();
    g.highlights[0]!.title = 'a\nb';
    expect(codes(g)).toContain('invalid-highlight');
    const h = valid();
    h.highlights[0]!.summary = 'bad \uD800';
    expect(codes(h)).toContain('invalid-highlight');
    const d = valid();
    d.highlights[0]!.createdAt = '2026-13-45T10:00:00Z';
    expect(codes(d)).toContain('invalid-highlight');
  });

  test('rejects a bad conversation block', () => {
    const f = valid();
    f.conversation.messageCount = -1;
    expect(codes(f)).toContain('invalid-conversation');
    expect(codes({ ...valid(), conversation: null })).toContain('invalid-conversation');
  });

  test('caps the error list and never echoes values', () => {
    const f = valid();
    f.highlights[0]!.messages = Array.from({ length: 150 }, () => 'SECRET');
    const r = parseFindings(f);
    expect(!r.ok && r.errors.length).toBe(20);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  test('does not mutate or trust prototype keys', () => {
    const r = parseFindings(JSON.parse('{"version":1,"__proto__":{"x":1},"conversation":{"name":"n","messageCount":0},"highlights":[]}'));
    expect(r.ok).toBe(true);
  });
});
