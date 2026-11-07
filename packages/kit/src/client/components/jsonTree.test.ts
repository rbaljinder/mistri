/**
 * What the viewer knows beyond layout: a node's path said as code reaches it,
 * what a filter finds, what Copy takes, a machine's strings, and the raw text
 * as tokens whose text is the line, character for character.
 */
import { describe, expect, test } from 'vitest';
import { JsonBig, parseJsonText } from './jsonModel.js';
import { childPath, copyTextOf, hasNested, nodeCount, rawLines, search, splitOnMatches, textFace, tokenizeLine } from './jsonTree.js';

describe('paths', () => {
  test('identifiers are dotted, positions bracketed, and any other key quoted in brackets as JSON quotes it', () => {
    expect(childPath('', 'a')).toBe('a');
    expect(childPath('a', 'b')).toBe('a.b');
    expect(childPath('a.b', 2)).toBe('a.b[2]');
    expect(childPath('a.b[2]', 'c')).toBe('a.b[2].c');
    expect(childPath('', 0)).toBe('[0]');
    expect(childPath('', '$id')).toBe('$id');
    expect(childPath('headers', 'x-request-id')).toBe('headers["x-request-id"]');
    expect(childPath('', 'first name')).toBe('["first name"]');
    expect(childPath('a', '2fa')).toBe('a["2fa"]');
    expect(childPath('a', '')).toBe('a[""]');
    expect(childPath('a', 'say "hi"')).toBe('a["say \\"hi\\""]');
    expect(childPath('a', 'ünïcode')).toBe('a["ünïcode"]');
    // A dotted key and a nested one are never said the same way.
    expect(childPath('', 'a.b')).not.toBe(childPath('a', 'b'));
  });
});

describe('copy', () => {
  test('a string is copied as itself, a big integer as its digits, anything else as its JSON', () => {
    expect(copyTextOf('ada@example.com')).toBe('ada@example.com');
    expect(copyTextOf(new JsonBig('9007199254740993'))).toBe('9007199254740993');
    expect(copyTextOf(12.5)).toBe('12.5');
    expect(copyTextOf(false)).toBe('false');
    expect(copyTextOf(null)).toBe('null');
    expect(copyTextOf({ id: new JsonBig('9007199254740993'), tags: ['a'] })).toBe(
      '{\n  "id": 9007199254740993,\n  "tags": [\n    "a"\n  ]\n}',
    );
  });
});

describe('the filter', () => {
  const doc = {
    id: 'evt_1',
    customer: { name: 'Ada', email: 'ada@example.com', address: { city: 'London' } },
    lines: [
      { sku: 'A-1', qty: 12500 },
      { sku: 'B-2', qty: 1 },
    ],
    'x-ada-flag': true,
    note: null,
  };

  test('keys and values are matched case aside; positions are not keys; containers holding a match are named', () => {
    const found = search(doc, 'ADA', 'en-US')!;
    expect([...found.keys]).toEqual(['["x-ada-flag"]']);
    expect([...found.values].sort()).toEqual(['customer.email', 'customer.name']);
    expect([...found.inside]).toEqual(['customer']);
    expect(found.count).toBe(3);
    expect(search(doc, '0', 'en-US')!.count).toBe(1); // 12500 — never the index 0
  });

  test('a value is found by its JSON and by the words it is shown in', () => {
    expect([...search(doc, '12500', 'en-US')!.values]).toEqual(['lines[0].qty']);
    expect([...search(doc, '12,500', 'en-US')!.values]).toEqual(['lines[0].qty']);
    expect([...search(doc, 'null', 'en-US')!.values]).toEqual(['note']);
    expect([...search(doc, 'city', 'en-US')!.inside].sort()).toEqual(['customer', 'customer.address']);
    expect([...search({ day: '2026-11-04' }, 'Nov 4', 'en-US')!.values]).toEqual(['day']);
  });

  test('nothing to find is no filter, and a miss is said as zero', () => {
    expect(search(doc, '   ', 'en-US')).toBeNull();
    expect(search(doc, 'zebra', 'en-US')!.count).toBe(0);
  });

  test('a match is split out wherever it appears, case aside, and a pattern character is only itself', () => {
    expect(splitOnMatches('Ada and ada', 'ada')).toEqual(['', 'Ada', ' and ', 'ada', '']);
    expect(splitOnMatches('a.b[0]', '[0]')).toEqual(['a.b', '[0]', '']);
    expect(splitOnMatches('plain', '')).toEqual(['plain']);
  });

  test('the filter is offered past a screenful, and the folding tools only where something folds', () => {
    expect(nodeCount({ a: 1, b: { c: 2 } }, 100)).toBe(3);
    expect(nodeCount(doc, 5)).toBe(5);
    expect(hasNested({ a: 1, b: [] })).toBe(false);
    expect(hasNested({ a: 1, b: [1] })).toBe(true);
  });
});

describe('machine strings', () => {
  test('a hex color carries its swatch; a uuid and an email are set in the code face; words are words', () => {
    expect(textFace('#1d6a5a')).toEqual({ code: true, swatch: '#1d6a5a' });
    expect(textFace('#fff')).toEqual({ code: true, swatch: '#fff' });
    expect(textFace('#12345')).toEqual({ code: false });
    expect(textFace('3f1c2a9e-7b4d-4e8a-9c1f-2d5e6a7b8c9d')).toEqual({ code: true });
    expect(textFace('ada@example.com')).toEqual({ code: true });
    expect(textFace('Ada Lovelace')).toEqual({ code: false });
  });
});

describe('the raw text, tokenized', () => {
  const kinds = (line: string) => tokenizeLine(line).map((token) => [token.kind, token.text]);

  test('a key is a string a colon follows; values, literals and punctuation are each themselves', () => {
    expect(kinds('  "name": "Ada",')).toEqual([
      ['space', '  '],
      ['key', '"name"'],
      ['punct', ':'],
      ['space', ' '],
      ['string', '"Ada"'],
      ['punct', ','],
    ]);
    expect(kinds('  "n": -12.5e-3,')).toContainEqual(['number', '-12.5e-3']);
    expect(kinds('  "ok": true,')).toContainEqual(['boolean', 'true']);
    expect(kinds('  "off": false')).toContainEqual(['boolean', 'false']);
    expect(kinds('  "gone": null')).toContainEqual(['null', 'null']);
    expect(kinds('  [')).toEqual([
      ['space', '  '],
      ['punct', '['],
    ]);
  });

  test('escapes stay inside their string: a quote, a backslash, a colon and a brace are text there', () => {
    const [, line] = rawLines({ 'a"b': 'c\\": {x}', z: 1 });
    expect(line).toBe(String.raw`  "a\"b": "c\\\": {x}",`);
    expect(kinds(line)).toEqual([
      ['space', '  '],
      ['key', String.raw`"a\"b"`],
      ['punct', ':'],
      ['space', ' '],
      ['string', String.raw`"c\\\": {x}"`],
      ['punct', ','],
    ]);
  });

  test('unicode, escaped or not, is part of its string, and the tokens together are the line exactly', () => {
    const value = { ключ: 'naïve ✓ 😀', esc: '\u0007\n\t"' };
    for (const line of rawLines(value))
      expect(
        tokenizeLine(line)
          .map((token) => token.text)
          .join(''),
      ).toBe(line);
    expect(kinds(rawLines(value)[1])).toContainEqual(['key', '"ключ"']);
    expect(kinds(rawLines(value)[1])).toContainEqual(['string', '"naïve ✓ 😀"']);
    expect(kinds(rawLines(value)[2])).toContainEqual(['string', '"\\u0007\\n\\t\\""']);
  });

  test('a big integer is one number token of all its digits', () => {
    const read = parseJsonText('{"id": 9007199254740993, "n": [12345678901234567890]}')!;
    const lines = rawLines(read.value);
    expect(lines[1]).toBe('  "id": 9007199254740993,');
    expect(kinds(lines[1])).toContainEqual(['number', '9007199254740993']);
    expect(kinds(lines[3])).toContainEqual(['number', '12345678901234567890']);
  });
});
