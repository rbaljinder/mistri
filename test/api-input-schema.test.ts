import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { renderApiInputSchema } from '../packages/mistri/src/server/api/apiInputSchema.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { readCommandInput } from '../packages/mistri/src/shared/commandInput.js';

test('actual JSON Schema and raw command reader agree on required scalar input', () => {
  const declarations = [
    {},
    { value: { type: 'boolean' } },
    {
      value: {
        type: 'choice',
        options: [
          { value: 0, label: 'Zero' },
          { value: '0', label: 'Text zero' },
          { value: ' 雪 ', label: 'Snow' },
        ],
      },
    },
    { value: { type: 'number' } },
    { value: { type: 'number', integer: true } },
    { value: { type: 'number', min: -2.5, max: 10 } },
    { value: { type: 'number', integer: true, min: Number.MAX_SAFE_INTEGER + 1 } },
  ];
  for (const input of declarations) {
    const fields = parseCommandInput(input, 'test');
    const preview = renderApiInputSchema({ input });
    const validate = new Ajv2020({ strict: true }).compile(preview.schema);
    const candidates: unknown[] = [
      {},
      null,
      [],
      'x',
      { extra: true },
      ...[
        null,
        '',
        ' ',
        '0',
        ' 雪 ',
        false,
        true,
        0,
        -0,
        -2.5,
        10,
        10.1,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        -Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER - 1,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        NaN,
        Infinity,
        -Infinity,
        {},
        [],
      ].map((value) => ({ value })),
    ];
    for (const candidate of candidates) {
      let accepted = true;
      try {
        readCommandInput(fields, candidate);
      } catch {
        accepted = false;
      }
      assert.equal(validate(candidate), accepted, JSON.stringify({ input, candidate }));
    }
    assert.ok(Object.isFrozen(preview.schema.properties));
    assert.ok(Object.isFrozen(preview.schema.required));
  }
});

test('normalizing, relational and nested declarations are described, never refused', () => {
  const cases: [Record<string, unknown>, unknown[], RegExp | undefined][] = [
    [{ type: 'number', optional: true, step: 0.01 }, [1.234, null], /multiple of 0\.01/],
    [{ type: 'number', step: 0.01, max: 5 }, [4.999], /At most 5 once rounded/],
    [{ type: 'text', min: 1 }, ['a'], /after trimming/],
    [{ type: 'text', max: 20 }, ['short'], /after trimming/],
    [{ type: 'text', case: 'upper' }, ['abc'], /upper case/],
    [{ type: 'text', format: 'email' }, ['a@b.co'], /email/],
    [{ type: 'text', pattern: '^ok$' }, ['ok'], /\^ok\$/],
    [{ type: 'textarea', max: 20 }, ['two\nlines'], /after trimming/],
    [{ type: 'textarea', case: 'lower', optional: true }, ['ABC', '', null], /lower case/],
    [{ type: 'date', min: '2026-01-01' }, ['2026-05-01'], /On or after 2026-01-01/],
    [{ type: 'date', max: '9999-12-31' }, ['2026-05-01'], /On or before/],
    [{ type: 'datetime' }, ['2026-10-12T09:00:00Z'], /ISO 8601/],
    [{ type: 'reference', from: 'people', by: 'id', labelColumn: 'name' }, [7, 'abc'], /"id" of a "people" row/],
    [{ type: 'group', fields: { yes: { type: 'boolean' } } }, [{ yes: true }], undefined],
    [{ type: 'group', repeat: { max: 3 }, fields: { yes: { type: 'boolean' } } }, [[{ yes: false }], [], null], undefined],
    [{ type: 'boolean', accept: true }, [true], undefined],
    [{ type: 'text', when: "record.status = 'open'" }, ['x', null], /status = 'open'/],
  ];
  for (const [field, values, said] of cases) {
    const input = { value: field };
    const fields = parseCommandInput(input, 'described');
    const preview = renderApiInputSchema({ input });
    assert.deepEqual(preview.undescribed, []);
    const validate = new Ajv2020({ strict: true }).compile(preview.schema);
    for (const value of values) {
      readCommandInput(fields, { value });
      assert.equal(validate({ value }), true, JSON.stringify({ field, value }));
    }
    assert.equal(validate({ value: { not: 'this' } }), false, JSON.stringify(field));
    if (said) assert.match(JSON.stringify(preview.schema.properties.value).replaceAll(String.raw`\"`, `"`), said);
  }
  const when = renderApiInputSchema({ input: { value: { type: 'text', when: 'record.open = true' } } });
  assert.deepEqual(when.schema.required, [], 'a when is required only where it holds, which no fixed schema says');
  for (const relation of ['below', 'above']) {
    const preview = renderApiInputSchema({
      input: { first: { type: 'date', [relation]: 'second' }, second: { type: 'date' } },
    });
    assert.match(String(preview.schema.properties.first.description), /"second" when both are given/);
  }
  const text = renderApiInputSchema({ input: { value: { type: 'text', max: 3 } } });
  const validate = new Ajv2020({ strict: true }).compile(text.schema);
  assert.equal(validate({ value: 'abcd' }), false);
});

test('date-only schemas exactly retain command year zero and raw optional blank semantics', () => {
  for (const optional of [false, true]) {
    const input = { value: { type: 'date', optional }, flag: { type: 'boolean' } };
    const fields = parseCommandInput(input, 'date schema parity');
    const preview = renderApiInputSchema({ input });
    const validate = new Ajv2020({ strict: true }).compile(preview.schema);
    const values: unknown[] = [
      null,
      '',
      ' ',
      '\t\n\ufeff',
      false,
      true,
      0,
      20260101,
      [],
      {},
      '0000-01-01',
      '0000-02-29',
      '0000-12-31',
      '0001-01-01',
      '9999-12-31',
      '1900-02-29',
      '2000-02-29',
      '2100-02-29',
      '2026-04-31',
      '2026-02-30',
      '2026-00-01',
      '2026-13-01',
      '2026-01-00',
      '2026-01-32',
      '2026-1-01',
      '10000-01-01',
      '-0001-01-01',
      '2026-01-01T00:00:00Z',
      ' 2026-01-01',
      '2026-01-01 ',
      '2026-01-01\n',
      '2026-01-01\u2028',
      '\u0000',
      '\u200b',
      '\ud800',
    ];
    for (const raw of [{ flag: true }, ...values.map((value) => ({ flag: true, value }))]) {
      let accepted = true;
      try {
        readCommandInput(fields, raw);
      } catch {
        accepted = false;
      }
      assert.equal(validate(raw), accepted, JSON.stringify({ optional, raw }));
    }
    assert.equal(validate({ flag: true, value: '0000-02-29' }), true);
    if (optional) assert.deepEqual(readCommandInput(fields, { flag: true, value: '\t\n\ufeff' }), { flag: true });
  }
});

test('date schema matches the actual reader across every year leap boundary and month edges', () => {
  const input = { value: { type: 'date' } };
  const fields = parseCommandInput(input, 'calendar parity');
  const preview = renderApiInputSchema({ input });
  const validate = new Ajv2020({ strict: true }).compile(preview.schema);
  const check = (value: string) => {
    let accepted = true;
    try {
      readCommandInput(fields, { value });
    } catch {
      accepted = false;
    }
    assert.equal(validate({ value }), accepted, value);
  };
  for (let year = 0; year <= 9999; year++) check(`${String(year).padStart(4, '0')}-02-29`);
  for (const year of ['0000', '0001', '1900', '2000', '9999']) {
    for (let month = 1; month <= 12; month++)
      for (let day = 0; day <= 32; day++) {
        check(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      }
  }
  const two = renderApiInputSchema({ input: { first: { type: 'date' }, second: { type: 'date' } } });
  assert.equal(two.schema.properties.first, two.schema.properties.second, 'the exceptional-year schema is reused');
  assert.ok(Object.isFrozen(two.schema.properties.first));
});

test('required plain text schema matches raw trim and control acceptance, not normalized output', () => {
  const input = { value: { type: 'text' } };
  const fields = parseCommandInput(input, 'test');
  const preview = renderApiInputSchema({ input });
  const validate = new Ajv2020({ strict: true }).compile(preview.schema);
  const characters = [
    ...Array.from({ length: 161 }, (_, index) => String.fromCharCode(index)),
    '\u1680',
    '\u180e',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u200b',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
    '雪',
    '🙂',
    '\ud800',
    '\udfff',
  ];
  const values: unknown[] = [
    undefined,
    null,
    '',
    false,
    0,
    {},
    [],
    'hello',
    '  hello  ',
    '\t\nhello\r\n',
    ...characters.flatMap((char) => [char, `${char}x`, `x${char}`, `${char}x${char}`, `x${char}y`]),
  ];
  for (const value of values) {
    const raw = value === undefined ? {} : { value };
    let accepted = true;
    try {
      readCommandInput(fields, raw);
    } catch {
      accepted = false;
    }
    assert.equal(validate(raw), accepted, JSON.stringify(raw));
  }
  assert.equal(validate({ value: '\t hello \n' }), true);
  assert.deepEqual(readCommandInput(fields, { value: '\t hello \n' }), { value: 'hello' });
  assert.equal(validate({ value: 'hello\nworld' }), false);
  assert.equal(validate({ value: '\t\n\ufeff' }), false);
});

test('callback-bearing declarations and getters are never executed or accepted', () => {
  let calls = 0;
  const callback = () => {
    calls++;
    return {};
  };
  for (const declaration of [
    { input: {}, validate: callback },
    { input: {}, initial: callback },
    { input: {}, handler: callback },
    {
      get input() {
        calls++;
        return {};
      },
    },
    {
      input: {
        flag: {
          type: 'boolean',
          get label() {
            calls++;
            return 'Flag';
          },
        },
      },
    },
  ]) {
    assert.throws(() => renderApiInputSchema(declaration), /callback-free input declaration/);
  }
  assert.equal(calls, 0);
});

test('plain text and textarea optionality matches raw reader before blank omission and trimming', () => {
  const characters = [
    ...Array.from({ length: 161 }, (_, index) => String.fromCharCode(index)),
    '\u1680',
    '\u180e',
    '\u2000',
    '\u2007',
    '\u200b',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
    '雪',
    '🙂',
    '\ud800',
    '\udfff',
  ];
  for (const type of ['text', 'textarea'])
    for (const optional of [false, true]) {
      const input = { value: { type, optional }, flag: { type: 'boolean' } };
      const fields = parseCommandInput(input, 'test');
      const preview = renderApiInputSchema({ input });
      const validate = new Ajv2020({ strict: true }).compile(preview.schema);
      const values: unknown[] = [
        null,
        '',
        false,
        0,
        {},
        [],
        'hello',
        '  hello  ',
        '\t\n',
        'hello\nworld',
        'hello\tworld',
        'hello\rworld',
        'hello\vworld',
        ...characters.flatMap((char) => [char, `${char}x`, `x${char}`, `${char}x${char}`, `x${char}y`]),
      ];
      const candidates = [
        { flag: true },
        ...values.map((value) => ({ flag: true, value })),
        {},
        null,
        [],
        { flag: true, unknown: '' },
        { flag: null, value: 'hello' },
      ];
      for (const raw of candidates) {
        let accepted = true;
        try {
          readCommandInput(fields, raw);
        } catch {
          accepted = false;
        }
        assert.equal(validate(raw), accepted, JSON.stringify({ type, optional, raw }));
      }
      assert.deepEqual(preview.schema.required, optional ? ['flag'] : ['flag', 'value']);
      if (optional)
        for (const value of [null, '', '\t\n\ufeff']) {
          assert.equal(validate({ flag: true, value }), true);
          assert.deepEqual(readCommandInput(fields, { flag: true, value }), { flag: true });
        }
      if (type === 'textarea')
        assert.deepEqual(readCommandInput(fields, { flag: true, value: ' \nhello\tworld\r\n ' }), { value: 'hello\tworld', flag: true });
    }
});

test('optional boolean, number and choice schemas match exact raw blank omission and scalar acceptance', () => {
  const declarations = [
    { type: 'boolean' },
    { type: 'number' },
    { type: 'number', integer: true },
    { type: 'number', min: -2.5, max: 3 },
    { type: 'number', integer: true, min: Number.MAX_SAFE_INTEGER + 1 },
    {
      type: 'choice',
      options: [
        { value: 0, label: 'Number' },
        { value: '0', label: 'Text' },
        { value: ' 雪 ', label: 'Spaced' },
      ],
    },
  ];
  const characters = [
    ...Array.from({ length: 161 }, (_, code) => String.fromCharCode(code)),
    '\u1680',
    '\u180e',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u200b',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
    '\ud800',
  ];
  for (const declaration of declarations)
    for (const optional of [false, true]) {
      const input = { value: { ...declaration, optional }, flag: { type: 'boolean' } };
      const fields = parseCommandInput(input, 'optional scalar parity');
      const validate = new Ajv2020({ strict: true }).compile(renderApiInputSchema({ input }).schema);
      const values: unknown[] = [
        null,
        '',
        '\t\n\ufeff',
        false,
        true,
        0,
        -0,
        1,
        -2.5,
        -2.6,
        3,
        3.1,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        NaN,
        Infinity,
        '0',
        ' 0 ',
        ' 雪 ',
        '雪',
        'true',
        {},
        [],
        [0],
        ...characters.flatMap((char) => [char, `${char}${char}`, `${char}0`, `0${char}`]),
      ];
      for (const raw of [{ flag: true }, {}, null, [], { flag: true, extra: 1 }, ...values.map((value) => ({ flag: true, value }))]) {
        let accepted = true;
        try {
          readCommandInput(fields, raw);
        } catch {
          accepted = false;
        }
        assert.equal(validate(raw), accepted, JSON.stringify({ declaration, optional, raw }));
      }
      if (optional) {
        for (const value of [null, '', ...(declaration.type === 'choice' ? [] : characters.filter((character) => !character.trim()))]) {
          assert.deepEqual(readCommandInput(fields, { flag: true, value }), { flag: true });
        }
        if (declaration.type === 'choice') assert.equal(validate({ flag: true, value: ' ' }), false);
        if (declaration.type === 'boolean')
          assert.deepEqual(readCommandInput(fields, { flag: true, value: false }), { value: false, flag: true });
      }
    }
});
