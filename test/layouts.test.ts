/**
 * Layouts on disk.
 *
 * The point of the file is that a layout outlives the browser that made it,
 * so what is tested here is the round trip and the two edges that would make
 * it untrustworthy: a missing or corrupt file must not stop a record from
 * rendering, and removing a layout must leave *no* layout rather than an
 * empty one — the difference between falling back to the derived layout and
 * showing a blank record.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLayouts, layoutsFor, writeLayout } from '../packages/engine/src/server/layouts.js';

// Every directory a case makes, removed when the file is done.
const made: string[] = [];
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tablewalk-layouts-'));
  made.push(dir);
  return dir;
};
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));
const scratch = async () => join(await directory(), 'layouts.json');

describe('stored layouts', () => {
  test('a layout survives being written and read back', async () => {
    const path = await scratch();
    await writeLayout('demo', 'work_order', { name: 'work_order', sections: [{ kind: 'fields' }] }, path);
    const stored = await layoutsFor('demo', path);
    assert.deepEqual(stored.work_order, { name: 'work_order', sections: [{ kind: 'fields' }] });
  });

  test('layouts are separated by connection', async () => {
    const path = await scratch();
    await writeLayout('a', 'invoice', { name: 'from a' }, path);
    await writeLayout('b', 'invoice', { name: 'from b' }, path);
    assert.equal(((await layoutsFor('a', path)).invoice as { name: string }).name, 'from a');
    assert.equal(((await layoutsFor('b', path)).invoice as { name: string }).name, 'from b');
  });

  test('null removes the entry rather than storing an empty layout', async () => {
    const path = await scratch();
    await writeLayout('demo', 'invoice', { name: 'invoice' }, path);
    await writeLayout('demo', 'invoice', null, path);
    // Absent, not empty: absent falls back to the derived layout, empty would
    // render a record with nothing on it.
    assert.equal('invoice' in (await layoutsFor('demo', path)), false);
  });

  test('the last layout for a connection takes the connection with it', async () => {
    const path = await scratch();
    await writeLayout('demo', 'invoice', { name: 'invoice' }, path);
    await writeLayout('demo', 'invoice', null, path);
    assert.deepEqual(await readLayouts(path), {});
  });

  test('a missing file reads as no layouts, not an error', async () => {
    assert.deepEqual(await readLayouts(join(tmpdir(), 'tablewalk-does-not-exist.json')), {});
  });

  test('a corrupt file reads as no layouts rather than breaking the page', async () => {
    const path = await scratch();
    await writeFile(path, '{ this is not json');
    assert.deepEqual(await readLayouts(path), {});
  });

  test('writing creates the directory it needs', async () => {
    const path = join(await directory(), 'nested', 'deeper', 'layouts.json');
    await writeLayout('demo', 'invoice', { name: 'invoice' }, path);
    assert.equal(existsSync(path), true);
  });
});

/**
 * The default order.
 *
 * These are rules about what people want to see first, but the one that
 * matters is structural: an unordered LIMIT/OFFSET can repeat a row on page
 * two and never show another, so every query gets an order whether or not
 * anyone asked for one.
 */
import { defaultOrder, resolveOrder, withKey } from '../packages/engine/src/shared/schema.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';

const table = (name: string, columns: Array<[string, string, boolean?]>, indexed?: string[]): TableMeta => ({
  id: name,
  name,
  schema: 'main',
  isView: false,
  columns: columns.map(([col, type, pk]) => ({
    name: col,
    type,
    nullable: true,
    primaryKey: Boolean(pk),
  })),
  // Default: the key is indexed, as it always is in a real database.
  indexed: indexed ?? columns.filter(([, , pk]) => pk).map(([col]) => col),
});

describe('two saves at once', () => {
  test('neither is lost', async () => {
    /* Saving a layout is read-the-whole-file, change one key, write it back.
       Two overlapping saves both read the same file and the second write
       lands on top of the first, so a layout saved in one tab vanished when
       another tab saved one — silently, which is what makes it a bug report
       nobody can reproduce.

       Started together on purpose. Serialised, each read sees the write
       before it; unserialised, this test is a coin toss that usually loses
       the first one. */
    const path = await scratch();
    await Promise.all([
      writeLayout('demo', 'customer', { name: 'customer', sections: [{ kind: 'fields' }] }, path),
      writeLayout('demo', 'invoice', { name: 'invoice', sections: [{ kind: 'fields' }] }, path),
      writeLayout('demo', 'employee', { name: 'employee', sections: [{ kind: 'fields' }] }, path),
    ]);

    assert.deepEqual(
      Object.keys(await layoutsFor('demo', path)).sort(),
      ['customer', 'employee', 'invoice'],
      'a concurrent save overwrote another',
    );
  });

  test('one failed save does not stop the next', async () => {
    /* The failure mode the chain could have introduced: waiting on a rejected
       promise, so one unwritable path poisons every save after it.

       The unwritable path is a directory that is really a *file*, which fails
       with ENOTDIR instantly on every platform. It used to be a path under
       `/proc`, which is a virtual filesystem on Linux and simply absent on
       macOS — a failure that depended on which machine was running it, and on
       one of them it did not fail quickly at all. */
    const blocked = await scratch();
    await writeFile(blocked, 'not a directory');

    await assert.rejects(() => writeLayout('demo', 'customer', { name: 'c', sections: [] }, join(blocked, 'layouts.json')));

    const path = await scratch();
    await writeLayout('demo', 'customer', { name: 'customer', sections: [{ kind: 'fields' }] }, path);
    assert.ok((await layoutsFor('demo', path)).customer, 'the save after a failure did not happen');
  });
});

describe('default ordering', () => {
  test('a last-touched column wins, newest first', () => {
    const t = table(
      'work_order',
      [
        ['id', 'INTEGER', true],
        ['created_at', 'TIMESTAMP'],
        ['sys_updated_at', 'TIMESTAMP'],
      ],
      ['id', 'created_at', 'sys_updated_at'],
    );
    assert.deepEqual(defaultOrder(t), [
      { column: 'sys_updated_at', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  test('a creation column is used when nothing records updates', () => {
    const t = table(
      'customer',
      [
        ['id', 'INTEGER', true],
        ['signed_up', 'DATE'],
      ],
      ['id', 'signed_up'],
    );
    assert.equal(defaultOrder(t)[0].column, 'signed_up');
    assert.equal(defaultOrder(t)[0].direction, 'desc');
  });

  test('a numeric key sorts newest first', () => {
    const t = table('note', [
      ['id', 'INTEGER', true],
      ['body', 'TEXT'],
    ]);
    assert.deepEqual(defaultOrder(t), [{ column: 'id', direction: 'desc' }]);
  });

  test('a text key sorts alphabetically, not backwards', () => {
    // `country` starting at ZW would be perverse.
    const t = table('country', [
      ['code', 'TEXT', true],
      ['name', 'TEXT'],
    ]);
    assert.deepEqual(defaultOrder(t), [{ column: 'code', direction: 'asc' }]);
  });

  test('a composite key groups children under their parent', () => {
    const t = table('invoice_line', [
      ['invoice_id', 'INTEGER', true],
      ['line_no', 'INTEGER', true],
      ['sku', 'TEXT'],
    ]);
    assert.deepEqual(defaultOrder(t), [
      { column: 'invoice_id', direction: 'asc' },
      { column: 'line_no', direction: 'asc' },
    ]);
  });

  test('a keyless table still gets a deterministic order', () => {
    const t = table('log', [
      ['message', 'TEXT'],
      ['level', 'TEXT'],
    ]);
    assert.equal(defaultOrder(t).length, 1);
  });

  test('a number named like a date is not treated as one', () => {
    // An INTEGER `updated_at` is an epoch; ordering by it descending is still
    // right, but it must be found as a number rather than as a date string.
    const t = table(
      'event',
      [
        ['id', 'INTEGER', true],
        ['updated_at', 'INTEGER'],
      ],
      ['id', 'updated_at'],
    );
    assert.equal(defaultOrder(t)[0].column, 'updated_at');
  });

  test('an unindexed recency column is not sorted by', () => {
    /* The whole point of the index rule: `ORDER BY updated_at DESC LIMIT 20`
       on an unindexed column scans and sorts the entire table to return
       twenty rows, on every table you click. */
    const t = table(
      'event',
      [
        ['id', 'INTEGER', true],
        ['updated_at', 'TIMESTAMP'],
      ],
      ['id'],
    );
    assert.deepEqual(defaultOrder(t), [{ column: 'id', direction: 'desc' }]);
  });

  test('an adapter that reports no indexes gets the key, not a guess', () => {
    const t: TableMeta = {
      ...table('event', [
        ['id', 'INTEGER', true],
        ['updated_at', 'TIMESTAMP'],
      ]),
      indexed: undefined,
    };
    assert.deepEqual(defaultOrder(t), [{ column: 'id', direction: 'desc' }]);
  });

  test('an explicit sort is made total by appending the key', () => {
    const t = table('work_order', [
      ['id', 'INTEGER', true],
      ['status', 'TEXT'],
    ]);
    const { order, implicit } = resolveOrder(t, [{ column: 'status', direction: 'asc' }]);
    assert.equal(implicit, false);
    assert.deepEqual(order, [
      { column: 'status', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  test('the key is not repeated when it is already the sort', () => {
    const t = table('work_order', [
      ['id', 'INTEGER', true],
      ['status', 'TEXT'],
    ]);
    const { order } = resolveOrder(t, [{ column: 'id', direction: 'desc' }]);
    assert.deepEqual(order, [{ column: 'id', direction: 'desc' }]);
  });

  test('a keyless table cannot be made stable and is left alone', () => {
    const t = table('log', [['message', 'TEXT']]);
    assert.deepEqual(withKey(t, [{ column: 'message', direction: 'asc' }]), [{ column: 'message', direction: 'asc' }]);
  });

  test('an implicit order is reported as implicit', () => {
    const t = table('note', [['id', 'INTEGER', true]]);
    assert.equal(resolveOrder(t, undefined).implicit, true);
    assert.equal(resolveOrder(t, []).implicit, true);
  });
});

/**
 * Taking clauses off a query.
 *
 * The risk here is a keyword inside a value: `status = "sort code"` contains
 * the word `sort` and does not contain a sort clause. Getting that wrong would
 * silently truncate someone's filter.
 */
import { splitQuery, withoutClause, activeClauses, splitConditions, withoutCondition } from '../packages/kit/src/client/clauses.js';

describe('a derived list section', () => {
  test('shows every column except the ones it joins on', async () => {
    const { listColumns } = await import('../packages/engine/src/shared/recordview.js');
    const child = table('work_order_part', [
      ['work_order_id', 'INTEGER', true],
      ['line_no', 'INTEGER', true],
      ['sku', 'TEXT'],
      ['quantity', 'INTEGER'],
    ]);
    /* Summarised, this used to come out as one column of quantities — a list
       of numbers with nothing to attach them to. */
    assert.deepEqual(listColumns(child, ['work_order_id']), ['line_no', 'sku', 'quantity']);
  });

  test('falls back to the key when the join is the whole table', async () => {
    const { listColumns } = await import('../packages/engine/src/shared/recordview.js');
    const child = table('link', [
      ['a_id', 'INTEGER', true],
      ['b_id', 'INTEGER', true],
    ]);
    assert.deepEqual(listColumns(child, ['a_id', 'b_id']), ['a_id']);
  });
});

describe('query clauses', () => {
  test('a bare table has nothing to remove', () => {
    assert.deepEqual(splitQuery('customer'), { table: 'customer', filter: '' });
    assert.deepEqual(activeClauses('customer'), []);
  });

  test('filter, sort and limit are separated', () => {
    const parts = splitQuery('work_order status = open sort opened_on desc limit 50');
    assert.equal(parts.table, 'work_order');
    assert.equal(parts.filter, 'status = open');
    assert.equal(parts.sort, 'sort opened_on desc');
    assert.equal(parts.limit, 'limit 50');
  });

  test('removing the sort leaves everything else', () => {
    assert.equal(withoutClause('work_order status = open sort opened_on desc limit 50', 'sort'), 'work_order status = open limit 50');
  });

  test('removing the filter leaves the trailing clauses', () => {
    assert.equal(withoutClause('work_order status = open sort opened_on', 'filter'), 'work_order sort opened_on');
  });

  test('a keyword inside a quoted value is not a clause', () => {
    const parts = splitQuery('product name = "sort code" limit 10');
    assert.equal(parts.filter, 'name = "sort code"');
    assert.equal(parts.sort, undefined);
    assert.equal(parts.limit, 'limit 10');
  });

  test('the last unquoted keyword wins', () => {
    // `sort` appears as a column name and as the clause.
    const parts = splitQuery('event sort_key = 3 sort created_at');
    assert.equal(parts.filter, 'sort_key = 3');
    assert.equal(parts.sort, 'sort created_at');
  });

  test('order by is recognised as well as sort', () => {
    assert.equal(withoutClause('invoice total > 10 order by total desc', 'sort'), 'invoice total > 10');
  });

  test('show is separated from sort', () => {
    const parts = splitQuery('customer active = true show name, email sort name');
    assert.equal(parts.filter, 'active = true');
    assert.equal(parts.show, 'show name, email');
    assert.equal(parts.sort, 'sort name');
  });

  test('clauses are labelled for display without their keyword', () => {
    assert.deepEqual(activeClauses('work_order status = open sort opened_on desc'), [
      { key: 'filter', index: 0, label: 'where', text: 'status = open' },
      { key: 'sort', label: 'sorted by', text: 'opened_on desc' },
    ]);
  });
});

describe('individual conditions', () => {
  test('top-level ands are separate conditions', () => {
    assert.deepEqual(splitConditions('active = true and name contains a'), ['active = true', 'name contains a']);
  });

  test('a bracketed or is one condition, not three', () => {
    // Splitting inside it would produce chips that cannot be removed
    // independently without changing what the query means.
    assert.deepEqual(splitConditions('active = true and (priority = 1 or priority = 2)'), [
      'active = true',
      '(priority = 1 or priority = 2)',
    ]);
  });

  test('a multi-word value containing "and" stays whole', () => {
    assert.deepEqual(splitConditions('name contains "a and b" and email contains example'), [
      'name contains "a and b"',
      'email contains example',
    ]);
  });

  test('a column named like the keyword survives', () => {
    assert.deepEqual(splitConditions('and_then = 3'), ['and_then = 3']);
  });

  test('removing a condition keeps the rest and the trailing clauses', () => {
    assert.equal(
      withoutCondition('customer name contains a and email contains example sort name', 0),
      'customer email contains example sort name',
    );
  });

  test('removing the only condition leaves a bare table', () => {
    assert.equal(withoutCondition('customer active = true', 0), 'customer');
  });

  test('conditions are labelled where, then and', () => {
    assert.deepEqual(
      activeClauses('customer a = 1 and b = 2').map((c) => c.label),
      ['where', 'and'],
    );
  });
});

/**
 * Refusing requests another site made on the user's behalf.
 *
 * Binding to loopback keeps tablewalk off the network and not away from the
 * browser: any page the user has open can POST to a localhost port, and while
 * the same-origin policy stops it reading the reply, the write still lands.
 * These are the checks that stop it.
 */
import { crossOriginRefusal, parseHostList } from '../packages/engine/src/server/http/trust.js';
import type { IncomingMessage } from 'node:http';

const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

const bound = { host: '127.0.0.1', port: 4111 };

describe('cross-origin refusal', () => {
  test('the page allowed', () => {
    assert.equal(
      crossOriginRefusal(request({ host: 'localhost:4111', origin: 'http://localhost:4111', 'content-type': 'application/json' }), bound),
      null,
    );
  });

  test('a request from another site is refused', () => {
    const refusal = crossOriginRefusal(
      request({ host: 'localhost:4111', origin: 'https://evil.example', 'content-type': 'application/json' }),
      bound,
    );
    assert.match(refusal ?? '', /evil\.example/);
  });

  test('a simple cross-origin POST is refused on its content type', () => {
    /* This is the actual attack: text/plain avoids the preflight, so the
       browser sends the request without ever asking us. Requiring JSON is what
       forces a preflight that we never answer. */
    assert.match(crossOriginRefusal(request({ host: 'localhost:4111', 'content-type': 'text/plain' }), bound) ?? '', /application\/json/);
  });

  test('a form post is refused', () => {
    assert.notEqual(
      crossOriginRefusal(request({ host: 'localhost:4111', 'content-type': 'application/x-www-form-urlencoded' }), bound),
      null,
    );
  });

  test('a body with no content type at all is refused', () => {
    assert.notEqual(crossOriginRefusal(request({ host: 'localhost:4111' }), bound), null);
  });

  test('a rebound DNS name is refused', () => {
    // attacker.example resolving to 127.0.0.1 makes their page same-origin
    // with us, so the Origin check alone would pass this.
    assert.match(
      crossOriginRefusal(
        request({ host: 'attacker.example:4111', origin: 'http://attacker.example:4111', 'content-type': 'application/json' }),
        bound,
      ) ?? '',
      /only answers on/,
    );
  });

  test('the bound interface is allowed when it is not loopback', () => {
    assert.equal(
      crossOriginRefusal(request({ host: '0.0.0.0:8080', origin: 'http://0.0.0.0:8080', 'content-type': 'application/json' }), {
        host: '0.0.0.0',
        port: 8080,
      }),
      null,
    );
  });

  test('a tool with no Origin is allowed', () => {
    // curl is not a confused deputy: it has no ambient credentials to abuse.
    assert.equal(crossOriginRefusal(request({ host: 'localhost:4111', 'content-type': 'application/json' }), bound), null);
  });

  test('a charset on the content type is still JSON', () => {
    assert.equal(crossOriginRefusal(request({ host: 'localhost:4111', 'content-type': 'application/json; charset=utf-8' }), bound), null);
  });
});

/**
 * Trusting an extra Host name.
 *
 * This is the case a container creates and nothing else does: the server binds
 * 0.0.0.0 and the browser sends the name the user typed, which is neither
 * loopback nor the bound interface. Every GET works, so the page loads and
 * looks fine — and then every POST is refused, which reads as "saving is
 * broken" rather than as a host check. What is tested here is that naming the
 * host fixes exactly that and nothing else: an unnamed host is still refused,
 * and the Origin and Content-Type checks still run against the trusted name.
 */
describe('allowed hosts', () => {
  const proxied = { host: '0.0.0.0', port: 4111, allowedHosts: ['tablewalk.internal'] };
  const json = { 'content-type': 'application/json' };

  test('a proxied host is refused when nothing extra is trusted', () => {
    assert.match(
      crossOriginRefusal(request({ host: 'tablewalk.internal', origin: 'http://tablewalk.internal', ...json }), {
        host: '0.0.0.0',
        port: 4111,
      }) ?? '',
      /only answers on/,
    );
  });

  test('and accepted once it is named', () => {
    assert.equal(crossOriginRefusal(request({ host: 'tablewalk.internal', origin: 'http://tablewalk.internal', ...json }), proxied), null);
  });

  test('an entry without a port matches any port', () => {
    // A proxy on 443 sends no port at all; one on 8080 sends 8080. Someone
    // writing the machine's name means the machine.
    assert.equal(crossOriginRefusal(request({ host: 'tablewalk.internal:8080', ...json }), proxied), null);
  });

  test('an entry with a port is taken literally', () => {
    const pinned = { host: '0.0.0.0', port: 4111, allowedHosts: ['tablewalk.internal:4111'] };
    assert.equal(crossOriginRefusal(request({ host: 'tablewalk.internal:4111', ...json }), pinned), null);
    assert.notEqual(crossOriginRefusal(request({ host: 'tablewalk.internal:9999', ...json }), pinned), null);
  });

  test('matching is case-insensitive, as host names are', () => {
    assert.equal(crossOriginRefusal(request({ host: 'TableWalk.Internal:4111', ...json }), proxied), null);
  });

  test('a host that was not named is still refused', () => {
    assert.match(crossOriginRefusal(request({ host: 'evil.example', ...json }), proxied) ?? '', /only answers on/);
  });

  test('a suffix of a trusted name is not a trusted name', () => {
    // nottablewalk.internal must not pass because it ends in the trusted name.
    assert.notEqual(crossOriginRefusal(request({ host: 'nottablewalk.internal', ...json }), proxied), null);
  });

  test('trusting a host does not turn off the Origin check', () => {
    assert.match(
      crossOriginRefusal(request({ host: 'tablewalk.internal', origin: 'https://evil.example', ...json }), proxied) ?? '',
      /evil\.example/,
    );
  });

  test('trusting a host does not turn off the content-type check', () => {
    assert.match(
      crossOriginRefusal(request({ host: 'tablewalk.internal', 'content-type': 'text/plain' }), proxied) ?? '',
      /application\/json/,
    );
  });

  test('an empty list changes nothing', () => {
    assert.equal(crossOriginRefusal(request({ host: 'localhost:4111', ...json }), { ...bound, allowedHosts: [] }), null);
    assert.notEqual(crossOriginRefusal(request({ host: 'elsewhere.example', ...json }), { ...bound, allowedHosts: [] }), null);
  });

  test('the env var takes commas or spaces, and drops the empties', () => {
    assert.deepEqual(parseHostList('a.example, b.example  c.example'), ['a.example', 'b.example', 'c.example']);
    assert.deepEqual(parseHostList(undefined), []);
    assert.deepEqual(parseHostList('  '), []);
  });
});

/* ---------- layouts from a config file ---------- */

import { parseLayoutsConfig } from '../packages/engine/src/shared/recordview.js';

describe('record layouts written in a config file', () => {
  /* The one composed surface that could only be built by clicking. Views,
     saved SQL and pages all read from mistri.json, so a team can commit
     them and review them like anything else; a record layout lived in
     layouts.json, written by the builder, and the only way to share one was
     to copy the file. */
  const one = (layout: unknown) => parseLayoutsConfig({ layouts: [layout] }, 'cfg.json');

  test('a layout is a table and its sections', () => {
    const [layout] = one({
      table: 'customer',
      name: 'Account desk',
      sections: [
        { kind: 'fields', title: 'Account', show: ['name', 'country_code.name'] },
        { kind: 'list', title: 'Invoices', from: 'invoice', whose: 'customer_id', limit: 5 },
      ],
    });
    assert.equal(layout.table, 'customer');
    assert.equal(layout.name, 'Account desk');
    assert.equal(layout.sections.length, 2);
    // Authored `show`, parsed to the internal `paths` the client reads.
    assert.deepEqual(layout.sections[0].paths, ['name', 'country_code.name']);
  });

  test('a list may name the relationship either way', () => {
    /* `via` is the constraint name, which is the right key — a child can
       point at a parent twice and the column alone would not say which — and
       the wrong thing to ask a person to type. Both are accepted; the pair is
       resolved against the schema when the layout is served. Authored `whose`
       becomes the internal `path`, the same translation a page section gets. */
    const [byPair] = one({
      table: 'customer',
      sections: [{ kind: 'list', from: 'invoice', whose: 'customer_id' }],
    });
    assert.equal(byPair.sections[0].from, 'invoice');
    assert.equal(byPair.sections[0].path, 'customer_id');

    const [byVia] = one({
      table: 'customer',
      sections: [{ kind: 'list', via: 'invoice_fk_1' }],
    });
    assert.equal(byVia.sections[0].via, 'invoice_fk_1');
  });

  test('a sort reads like the query bar, and lands as the structure the view runs', () => {
    const [layout] = one({
      table: 'customer',
      sections: [{ kind: 'list', via: 'fk', show: ['id', 'total'], sort: 'invoice_date desc, id' }],
    });
    assert.deepEqual(layout.sections[0].columns, ['id', 'total']);
    assert.deepEqual(layout.sections[0].orderBy, [
      { column: 'invoice_date', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  test('an absent section is not an error, and neither is an absent key', () => {
    assert.deepEqual(parseLayoutsConfig({}, 'cfg.json'), []);
    assert.deepEqual(parseLayoutsConfig({ layouts: [] }, 'cfg.json'), []);
  });

  describe('what it refuses, and what it says', () => {
    /* Named with the entry and the fix rather than skipped: a layout that
       silently did not appear is a bug report that starts "I definitely wrote
       it". The same rule parsePagesConfig follows. */
    const refuses = (layout: unknown, pattern: RegExp) => assert.throws(() => one(layout), pattern);

    test('a layout with no table', () => {
      refuses({ sections: [{ kind: 'fields', show: ['a'] }] }, /has no "table"/);
    });

    test('a layout with no sections', () => {
      refuses({ table: 'customer' }, /has no "sections"/);
      refuses({ table: 'customer', sections: [] }, /has no "sections"/);
    });

    test('a section that is neither fields nor list', () => {
      refuses({ table: 'customer', sections: [{ kind: 'metric', fn: 'count' }] }, /it must be "fields" or "list"/);
    });

    test('a fields section with no show', () => {
      refuses({ table: 'customer', sections: [{ kind: 'fields' }] }, /needs "show"/);
      refuses({ table: 'customer', sections: [{ kind: 'fields', show: [1] }] }, /needs "show"/);
    });

    test('a list that does not say which relationship it shows', () => {
      refuses({ table: 'customer', sections: [{ kind: 'list', title: 'Invoices' }] }, /needs either "via".*or "from" and "whose"/s);
      // `from` without `whose` is not a pair.
      refuses({ table: 'customer', sections: [{ kind: 'list', from: 'invoice' }] }, /needs either "via"/);
    });

    test('a limit that is not a whole number of rows', () => {
      refuses({ table: 'customer', sections: [{ kind: 'list', via: 'fk', limit: 2.5 }] }, /"limit" that is not a whole number/);
      refuses({ table: 'customer', sections: [{ kind: 'list', via: 'fk', limit: 0 }] }, /"limit" that is not a whole number/);
    });

    test('a sort that is not query-bar text', () => {
      refuses(
        { table: 'customer', sections: [{ kind: 'list', via: 'fk', sort: [{ column: 'id' }] }] },
        /"sort" that is not query-bar text/,
      );
      refuses({ table: 'customer', sections: [{ kind: 'list', via: 'fk', sort: 'id sideways' }] }, /Write it like the query bar/);
    });

    test('the pre-rename spellings are refused with the word that replaced them', () => {
      /* The layouts block learned the page section's words after the pages
         respelling, so one file speaks one language; anyone who wrote the old
         words gets the fix named at startup, not a layout that half-works. */
      refuses({ table: 'customer', sections: [{ kind: 'fields', paths: ['name'] }] }, /"paths", which is now "show"/);
      refuses({ table: 'customer', sections: [{ kind: 'list', from: 'invoice', path: 'customer_id' }] }, /"path", which is now "whose"/);
      refuses({ table: 'customer', sections: [{ kind: 'list', via: 'fk', columns: ['id'] }] }, /"columns", which is now "show"/);
      refuses(
        { table: 'customer', sections: [{ kind: 'list', via: 'fk', orderBy: [{ column: 'id' }] }] },
        /"orderBy", which is now "sort"/,
      );
      // `via` keeps its name: it is the constraint, not a direction.
      const [kept] = one({ table: 'customer', sections: [{ kind: 'list', via: 'invoice_fk_1' }] });
      assert.equal(kept.sections[0].via, 'invoice_fk_1');
    });

    test('two layouts for the same table, which would silently overwrite', () => {
      assert.throws(
        () =>
          parseLayoutsConfig(
            {
              layouts: [
                { table: 'customer', sections: [{ kind: 'fields', show: ['name'] }] },
                { table: 'customer', sections: [{ kind: 'fields', show: ['email'] }] },
              ],
            },
            'cfg.json',
          ),
        /repeats a layout for "customer"/,
      );
    });

    test('but the same table on two connections is two layouts', () => {
      const both = parseLayoutsConfig(
        {
          layouts: [
            { table: 'customer', connection: 'dev', sections: [{ kind: 'fields', show: ['name'] }] },
            { table: 'customer', connection: 'prod', sections: [{ kind: 'fields', show: ['email'] }] },
          ],
        },
        'cfg.json',
      );
      assert.equal(both.length, 2);
    });

    test('"layouts" that is not an array', () => {
      assert.throws(() => parseLayoutsConfig({ layouts: {} }, 'cfg.json'), /"layouts" must be an array/);
    });
  });
});

describe('the store survives what filesystems do', () => {
  test('a corrupt file is quarantined, not silently emptied and overwritten', async () => {
    const path = await scratch();
    await writeLayout('demo', 'invoice', { name: 'mine' }, path);
    // A crash mid-write, simulated: half a JSON document.
    const { writeFile: wf, readdir } = await import('node:fs/promises');
    await wf(path, '{ "demo": { "invoi');
    const read = await layoutsFor('demo', path);
    assert.deepEqual(read, {}, 'a corrupt store reads as empty');
    /* But the bytes survive beside it: the person still holds their work,
       and the next save cannot make the emptiness permanent by accident. */
    const dir = path.slice(0, path.lastIndexOf('/'));
    const names = await readdir(dir);
    const kept = names.find((n) => n.includes('.corrupt-'));
    assert.ok(kept, 'the unreadable original was kept');
  });

  test('a write leaves no temp file behind', async () => {
    const path = await scratch();
    await writeLayout('demo', 'invoice', { name: 'mine' }, path);
    const { readdir } = await import('node:fs/promises');
    const dir = path.slice(0, path.lastIndexOf('/'));
    const names = await readdir(dir);
    assert.ok(!names.some((n) => n.includes('.tmp-')), 'the rename consumed the temp file');
    assert.deepEqual((await layoutsFor('demo', path)).invoice, { name: 'mine' });
  });
});
