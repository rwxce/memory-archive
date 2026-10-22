import { describe, expect, test } from 'vitest';
import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS, SNIPPET_CHARS, queryTokens, snippetOf, toMatchExpression } from './search-query';

describe('toMatchExpression', () => {
  test('quotes every word and makes the last one a prefix', () => {
    expect(toMatchExpression('hola món')).toBe('"hola" "món"*');
    expect(toMatchExpression('  Cançó  ')).toBe('"Cançó"*');
  });

  test('a one-letter last word is not a prefix (it would walk every word of the archive)', () => {
    expect(toMatchExpression('hola m')).toBe('"hola" "m"');
    expect(toMatchExpression('hola mu')).toBe('"hola" "mu"*');
  });

  test('nothing to search for gives null', () => {
    for (const q of ['', '   ', '***', '"', '- - -', '()', '😀', '\u0000']) expect(toMatchExpression(q)).toBeNull();
  });

  test.each([
    ['text:secret', '"text" "secret"*'],
    ['a OR bc', '"a" "OR" "bc"*'],
    ['NEAR(a bc)', '"NEAR" "a" "bc"*'],
    ['-foo', '"foo"*'],
    ['"unbalanced', '"unbalanced"*'],
    ['a" OR "bc', '"a" "OR" "bc"*'],
    ['foo*', '"foo"*'],
    ['^foo AND NOT bar', '"foo" "AND" "NOT" "bar"*'],
    ["l'home", '"l" "home"*'],
  ])('operators and punctuation typed by the person are only words: %s', (input, expected) => {
    expect(toMatchExpression(input)).toBe(expected);
  });

  test('the output only ever holds quotes, letters, digits, marks, spaces and at most one trailing star', () => {
    for (const q of ['a"b', '\'; DROP TABLE x; --', 'a\u0001bb\u0002', 'x:y zz:{a bb}', '\\"']) {
      expect(toMatchExpression(q) ?? '').toMatch(/^("[\p{L}\p{N}\p{M}]+" )*"[\p{L}\p{N}\p{M}]+"\*?$|^$/u);
    }
  });

  test('very long input is bounded', () => {
    const long = 'palabra '.repeat(100_000);
    expect(queryTokens(long)).toHaveLength(MAX_QUERY_TOKENS);
    expect(queryTokens('x'.repeat(10_000))[0]).toHaveLength(MAX_QUERY_CHARS);
    expect(toMatchExpression('é'.repeat(1_000_000))?.length).toBeLessThan(MAX_QUERY_CHARS + 10);
  });

  test('a long word is kept whole, so it still finds its message when other words follow it', () => {
    const long = 'a'.repeat(120);
    expect(toMatchExpression(`${long} hola`)).toBe(`"${long}" "hola"*`);
  });

  test('a non-string is nothing', () => {
    expect(toMatchExpression(undefined as never)).toBeNull();
  });
});

describe('snippetOf', () => {
  const marked = (text: string, query: string) => {
    const s = snippetOf(text, query);
    return s.ranges.map((r) => s.text.slice(r.start, r.end));
  };

  test('highlights whole words without case or accents; the last word also as a prefix', () => {
    expect(marked('Bon dia, la CANÇÓ nova', 'canco')).toEqual(['CANÇÓ']);
    expect(marked('Bon dia, la CANÇÓ nova', 'bon di')).toEqual(['Bon', 'dia']);
    expect(marked('Bon dia, la CANÇÓ nova', 'bo dia')).toEqual(['dia']);
    expect(marked('a b ab', 'x a')).toEqual(['a']);
    expect(marked('a b ab', 'a')).toEqual(['a']);
    expect(marked('señor niño', 'NINO')).toEqual(['niño']);
    expect(marked('e\u0301cole', 'ecole')).toEqual(['e\u0301cole']);
  });

  test('operators in the query are not special', () => {
    expect(marked('this OR that near NEAR', 'near OR')).toEqual(['OR', 'near', 'NEAR']);
    expect(marked('a-b', '-b')).toEqual(['b']);
  });

  test('plain text in, plain text out: markup and control characters stay text', () => {
    const s = snippetOf('<b onclick=x>\u0001 hola \u0002</b>', 'hola');
    expect(s.text).toBe('<b onclick=x>\u0001 hola \u0002</b>');
    expect(s.ranges.map((r) => s.text.slice(r.start, r.end))).toEqual(['hola']);
  });

  test('a long text is cut around the first match with ellipses, ranges still point at the words', () => {
    const text = `${'palabra '.repeat(60)}tesoro ${'relleno '.repeat(60)}`;
    const s = snippetOf(text, 'tesoro');
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2);
    expect(s.ranges.map((r) => s.text.slice(r.start, r.end))).toEqual(['tesoro']);
    expect(snippetOf(text, 'zzz').ranges).toEqual([]);
  });

  test('a cut never splits a surrogate pair', () => {
    for (let pad = 0; pad < 4; pad++) {
      const text = `${'x'.repeat(pad)}${'😀 '.repeat(100)}needle ${'😀'.repeat(200)}`;
      const s = snippetOf(text, 'needle');
      expect(s.text).not.toMatch(/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(s.ranges.map((r) => s.text.slice(r.start, r.end))).toEqual(['needle']);
    }
    // a long emoji run right at the ends of the window
    const s = snippetOf(`${'😀'.repeat(300)} needle`, 'needle');
    expect(s.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test('no match or no query keeps the start of the text', () => {
    expect(snippetOf('hello', '')).toEqual({ text: 'hello', ranges: [] });
    expect(snippetOf('', 'a')).toEqual({ text: '', ranges: [] });
  });
});
