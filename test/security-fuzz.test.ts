/**
 * Generated inputs, from a fixed seed, against the three readers of text a
 * stranger writes: the query language (a list's question, an export's, a
 * tab's), an App's address (the path a link or a crawler sends), and the
 * CSV writer (a cell anybody could have typed). Bounded and deterministic —
 * the same few thousand cases on every run — so a failure names a case that
 * reproduces. What each must hold: nothing throws past its own refusal, no
 * value ever becomes statement text, and what is written reads back as
 * exactly what it was, one field per column, with no formula left live.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import { parseQuery, quoteValue } from '../packages/engine/src/shared/query.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { compileView, PathError } from '../packages/engine/src/shared/view.js';
import { addressSlug, appAddressBook, readAppSegments, recordSegments } from '../packages/mistri/src/shared/appAddress.js';
import { addressFilterValue, addressSortValue, tabSlug } from '../packages/engine/src/shared/addressParams.js';
import { CRLF, csvField, csvRecord, jsonRecord } from '../packages/engine/src/shared/csv.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/** mulberry32: small, fast, and the same sequence for the same seed everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  return { next, int, pick };
}

/* The characters that mean something to a SQL statement, a URL, HTML or a spreadsheet — and some that mean nothing to any of them. */
const HOSTILE = [
  ...'\'"`\\;-/*%_=<>!@~:,.?#&+()[]{}|$^ \t\r\n\0',
  'é',
  'ß',
  '中',
  '🙂',
  '＝',
  // A right-to-left override, a line separator and a byte-order mark, which no editor shows.
  ...[0x202e, 0x2028, 0xfeff].map((code) => String.fromCharCode(code)),
];
const text = (r: ReturnType<typeof random>, max = 24) =>
  Array.from({ length: r.int(max) + 1 }, () => (r.next() < 0.6 ? r.pick(HOSTILE) : String.fromCharCode(97 + r.int(26)))).join('');

const schema: DatabaseSchema = {
  label: 'Fuzz',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'person',
      name: 'person',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'code', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
    {
      id: 'task',
      name: 'task',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'amount', type: 'NUMERIC', nullable: true, primaryKey: false },
        { name: 'due', type: 'DATE', nullable: true, primaryKey: false },
        { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'person', column: 'id' } },
      ],
    },
    {
      id: 'line',
      name: 'line',
      schema: '',
      isView: false,
      columns: [
        { name: 'task_id', type: 'INTEGER', nullable: false, primaryKey: true, references: { table: 'task', column: 'id' } },
        { name: 'n', type: 'INTEGER', nullable: false, primaryKey: true },
      ],
    },
  ],
  foreignKeys: [
    { name: 'task_owner', from: { table: 'task', columns: ['owner_id'] }, to: { table: 'person', columns: ['id'] } },
    { name: 'line_task', from: { table: 'line', columns: ['task_id'] }, to: { table: 'task', columns: ['id'] } },
  ],
} as unknown as DatabaseSchema;

const NOW = new Date('2026-09-23T12:00:00Z');
const WORDS = [
  'task',
  'person',
  'title',
  'amount',
  'due',
  'owner_id',
  'owner_id.name',
  'name',
  'show',
  'sort',
  'where',
  'and',
  'or',
  'not',
  'contains',
  'in',
  'is',
  'null',
  'empty',
  'today',
  'last',
  '30',
  'days',
  'me',
  'desc',
  'limit',
  '=',
  '!=',
  '>',
  '<',
  '>=',
  '(',
  ')',
  ',',
  '"',
  "'",
];

/** A compiled statement's text, only where compiling it is not a refusal of its own. */
function compiled(query: string): { text: string; params: unknown[] } | undefined {
  const parsed = textToView(schema, query, { id: 'fuzz', name: 'fuzz', now: NOW });
  if (!parsed.view || parsed.errors.length) return undefined;
  try {
    return compileView(schema, parsed.view, ANSI_STYLE);
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
}

test('the query language reads any text as a question or a refusal, and never throws', () => {
  const r = random(0x7ab1e);
  for (let i = 0; i < 3000; i++) {
    const input =
      r.next() < 0.5 ? text(r, 60) : Array.from({ length: r.int(10) + 1 }, () => (r.next() < 0.8 ? r.pick(WORDS) : text(r, 6))).join(' ');
    assert.doesNotThrow(() => parseQuery(input, { schema, now: NOW }), `parseQuery(${JSON.stringify(input)})`);
    assert.doesNotThrow(() => compiled(input), `textToView → compileView(${JSON.stringify(input)})`);
  }
});

test('a value is always a bound parameter, never statement text, whatever it holds', () => {
  const r = random(0x5eed);
  let bound = 0;
  for (let i = 0; i < 1500; i++) {
    const marker = `zqx${i}q`;
    const value = `${text(r, 10)}${marker}${text(r, 10)}`;
    const quoted = quoteValue(value);
    const question = r.pick([
      `task title = ${quoted}`,
      `task title != ${quoted}`,
      `task title contains ${quoted}`,
      `task title in (${quoted}, "x")`,
      `task owner_id.name = ${quoted}`,
      `task title = ${quoted} or title contains ${quoted} show title, owner_id.name`,
      `person name = ${quoted} and code = ${quoted}`,
    ]);
    const statement = compiled(question);
    if (!statement) continue;
    bound++;
    assert.ok(!statement.text.includes(marker), `${question} → ${statement.text}`);
    assert.ok(
      statement.params.some((param) => typeof param === 'string' && param.includes(marker)),
      `${question}: the value is bound`,
    );
  }
  /* The rest are refused as questions that do not read — a value holding a
     line break has no spelling in the language yet — never run widened. */
  assert.ok(bound > 900, `most generated questions compile (${bound})`);
});

const book = appAddressBook({
  views: { tasks: { table: 'task' }, people: { table: 'person' }, lines: { table: 'line' } } as never,
  order: ['tasks', 'people', 'lines'],
  resources: { task: { slug: true }, person: { address: 'code' } } as never,
  pages: [],
  tables: schema.tables as never,
});

test('an address of any shape is read as an App address or not at all, and never throws', () => {
  const r = random(0xadd);
  const parts = [
    'tasks',
    'people',
    'lines',
    'new',
    '1',
    '1-a-slug',
    'id=1',
    'task_id=1,n=2',
    '%',
    '%E0%A4%A',
    '..',
    '.',
    '@x~1',
    'a:b',
    '~1',
    '!new',
    'code=x',
    '__proto__',
    'constructor',
    '%2F',
    '',
  ];
  for (let i = 0; i < 3000; i++) {
    const segments = Array.from({ length: r.int(6) }, () => (r.next() < 0.7 ? r.pick(parts) : encodeURIComponent(text(r, 8))));
    assert.doesNotThrow(() => readAppSegments(book, segments), JSON.stringify(segments));
    const parsed = readAppSegments(book, segments);
    if (parsed?.kind === 'record') {
      for (const [column, value] of Object.entries(parsed.key)) {
        assert.equal(typeof value, 'string', `${JSON.stringify(segments)}: ${column}`);
        assert.ok(Object.hasOwn(parsed.key, column));
      }
      assert.ok(!Object.hasOwn(parsed.key, '__proto__') && Object.getPrototypeOf(parsed.key) === Object.prototype);
    }
    const raw = text(r, 16);
    assert.doesNotThrow(() => {
      addressFilterValue(raw);
      addressSortValue(raw);
      tabSlug(raw);
      addressSlug(raw);
    }, JSON.stringify(raw));
  }
});

test("a record's address reads back as the same record, whatever its key holds, and stays one path segment per part", () => {
  const r = random(0x1d5);
  for (let i = 0; i < 2000; i++) {
    const code = text(r, 12);
    const slug = addressSlug(text(r, 20));
    assert.match(slug, /^[a-z0-9-]*$/, 'a slug is words and hyphens only');
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['task', { key: { id: r.int(1e9) }, slug }, {}],
      ['person', { key: { id: r.int(1e9) }, natural: code }, {}],
      ['line', { key: { task_id: r.int(1e6), n: text(r, 6) } }, {}],
    ];
    for (const [table, at] of cases) {
      const said = recordSegments(book, table, at as never);
      if (!said) continue;
      for (const segment of said) {
        assert.doesNotMatch(segment, /[/?#\s]/, `${table} ${JSON.stringify(at)} → ${said.join('/')}`);
        assert.notEqual(segment, '..');
      }
      const read = readAppSegments(book, said);
      assert.ok(
        read?.kind === 'record' && read.table === table,
        `${table} ${JSON.stringify(at)} → ${said.join('/')} → ${JSON.stringify(read)}`,
      );
      const key = (at as { key: Record<string, unknown> }).key;
      if (read.natural) assert.equal(read.natural.value, String(at.natural));
      else for (const [column, value] of Object.entries(key)) assert.equal(read.key[column], String(value), `${table}.${column}`);
    }
  }
});

/** RFC 4180, strictly: what a spreadsheet reads a file as. */
function parseCsv(document: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let at = 0;
  let quoted = false;
  while (at < document.length) {
    const c = document[at];
    if (quoted) {
      if (c === '"' && document[at + 1] === '"') {
        field += '"';
        at += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        at++;
        continue;
      }
      field += c;
      at++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      at++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      at++;
      continue;
    }
    if (c === '\r' && document[at + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      at += 2;
      continue;
    }
    assert.ok(c !== '"' && c !== '\r' && c !== '\n', `a bare ${JSON.stringify(c)} outside quotes at ${at}`);
    field += c;
    at++;
  }
  assert.equal(field, '');
  assert.equal(row.length, 0, "the file ends at a record's end");
  return rows;
}

const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

test('every cell reads back as exactly what it was, one field per column, and no cell is a live formula', () => {
  const r = random(0xc5f);
  const columns = ['a', 'b', 'c', 'd'];
  const value = (): unknown => {
    const roll = r.next();
    if (roll < 0.1) return null;
    if (roll < 0.15) return undefined;
    if (roll < 0.25) return r.pick([-5, 1.5e3, 0, -0.25, Number.MAX_SAFE_INTEGER]);
    if (roll < 0.3) return { note: text(r, 6) };
    if (roll < 0.35) return r.pick(['=1+1', '+cmd|" /C calc"!A0', '-2+3', '@SUM(A1)', '\t=x', '\r=x', '-5', '+1.5e3', '']);
    return text(r, 30);
  };
  const lines: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 1500; i++) {
    const row = Object.fromEntries(columns.map((column) => [column, value()]));
    rows.push(row);
    lines.push(csvRecord(columns, row) + CRLF);
  }
  const read = parseCsv(lines.join(''));
  assert.equal(read.length, rows.length);
  read.forEach((fields, i) => {
    assert.equal(fields.length, columns.length, `row ${i}`);
    fields.forEach((field, j) => {
      const original = rows[i][columns[j]];
      if (original === null || original === undefined) {
        assert.equal(field, '', `row ${i} ${columns[j]}`);
        return;
      }
      const said = typeof original === 'object' ? JSON.stringify(original) : String(original);
      const expected = FORMULA.test(said) && !NUMBER.test(said) ? `'${said}` : said;
      assert.equal(field, expected, `row ${i} ${columns[j]}`);
      assert.ok(!FORMULA.test(field) || NUMBER.test(field), `row ${i} ${columns[j]} is a live formula: ${JSON.stringify(field)}`);
    });
  });
  // A header is written by the same rule, and a column list naming what no row has writes nothing of Object's own.
  assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvRecord(['constructor', '__proto__', 'toString'], { title: 'x' }), ',,');
  assert.equal(JSON.stringify(jsonRecord(['constructor', '__proto__'], {})), '{"constructor":null,"__proto__":null}');
});
