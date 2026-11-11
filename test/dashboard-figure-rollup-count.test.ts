/**
 * A dashboard figure whose condition reads a count of related rows: a field report saw such a figure ignore its
 * condition on PostgreSQL while a funnel with the same condition filtered. The App is served as a browser meets it —
 * its payload from `/api/app`, every section's question asked of `/api/breakdowns` in the words the client builds
 * (dashboardAsks.ts, funnel.ts) — on SQLite and, under TABLEWALK_TEST_PG, on PostgreSQL in a database of its own,
 * read-only and writable. Each figure must equal the number its rows say, and the funnel's stage with the same
 * condition: a rollup count alone, beside another column, inside a date window, narrowed by the rollup's own query,
 * read through a computed column, and inherited from the list a figure opens.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { measureText, windowed, type AskedSection } from '../packages/engine/src/shared/dashboardAsks.js';
import { funnelText, type FunnelStage } from '../packages/engine/src/shared/funnel.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createApp } from './support/createApp.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

/* Five accounts and their tickets: Acme 2 (one open), Brio 1, Cato 2 (both open), Dune 3 (one open), Echo none.
   Created today, three days ago, sixty, forty-five and a hundred days ago. */
const ACCOUNTS: Array<[number, string, string, string]> = [
  [1, 'Acme', 'north', day(0)],
  [2, 'Brio', 'south', day(3)],
  [3, 'Cato', 'south', day(60)],
  [4, 'Dune', 'north', day(45)],
  [5, 'Echo', 'north', day(100)],
];
const TICKETS: Array<[number, number, string]> = [
  [1, 1, 'open'],
  [2, 1, 'closed'],
  [3, 2, 'closed'],
  [4, 3, 'open'],
  [5, 3, 'open'],
  [6, 4, 'open'],
  [7, 4, 'closed'],
  [8, 4, 'closed'],
];
const SQL = (integer: string, schema = '') => `${schema ? `CREATE SCHEMA ${schema};` : ''}
  CREATE TABLE ${schema && `${schema}.`}account (id ${integer} PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, created DATE NOT NULL);
  CREATE TABLE ${schema && `${schema}.`}ticket (id ${integer} PRIMARY KEY, account_id ${integer} NOT NULL REFERENCES ${schema && `${schema}.`}account(id), state TEXT NOT NULL);
  INSERT INTO ${schema && `${schema}.`}account VALUES ${ACCOUNTS.map(([id, name, region, created]) => `(${id}, '${name}', '${region}', '${created}')`).join(', ')};
  INSERT INTO ${schema && `${schema}.`}ticket VALUES ${TICKETS.map(([id, account, state]) => `(${id}, ${account}, '${state}')`).join(', ')};`;

/* What each figure must say, read off the rows above. */
const EXPECTED: Record<string, number> = {
  Busy: 3, // Acme, Cato, Dune
  'Busy in the north': 2, // Acme, Dune
  'Busy, created this month': 1, // Acme
  'Busy this month (window)': 1, // Acme, through the dashboard's window
  'With open tickets': 3, // Acme, Cato, Dune
  'Busy, by computed count': 3,
  'Busy list': 3,
  'Busy, by a computed flag = true': 3,
  'Open, through coalesce': 3,
  'Any ticket': 4, // all but Echo
  'No ticket': 1, // Echo
  'Any open ticket': 3,
  'Busy and an open ticket': 3,
  Quiet: 2, // Brio, Echo
};

const STAGES: FunnelStage[] = [{ label: 'Accounts' }, { label: 'Busy', query: 'tickets > 1' }, { label: 'North', query: 'region = north' }];

/* Over a schema of its own (`sources.<name>.schema`), as the field report's App was, or the connection's default. */
const definition = (schema?: string) => ({
  id: 'busy',
  name: 'Busy',
  ...(schema ? { sources: { crm: { connection: 'busy', schema, default: true } } } : { connection: 'busy' }),
  resources: {
    account: {
      rollups: {
        tickets: { fn: 'count', from: 'ticket' },
        open_tickets: { fn: 'count', from: 'ticket', query: "state = 'open'" },
      },
      computed: {
        ticket_count: { type: 'number', value: 'tickets * 1' },
        is_busy: { type: 'boolean', value: 'tickets > 1' },
        open_or_none: { type: 'number', value: 'coalesce(open_tickets, 0)' },
      },
    },
    ticket: {},
  },
  views: {
    accounts: { kind: 'list', from: 'account', label: 'Accounts' },
    busy: { kind: 'list', from: 'account', label: 'Busy accounts', query: 'tickets > 1' },
    overview: {
      kind: 'dashboard',
      label: 'Overview',
      window: 'last 30 days',
      sections: [
        { kind: 'metric', title: 'Busy', from: 'account', query: 'tickets > 1' },
        { kind: 'metric', title: 'Busy in the north', from: 'account', query: 'tickets > 1 and region = north' },
        { kind: 'metric', title: 'Busy, created this month', from: 'account', query: 'tickets > 1 and created = last 30 days' },
        { kind: 'metric', title: 'Busy this month (window)', from: 'account', query: 'tickets > 1', over: 'created' },
        { kind: 'metric', title: 'With open tickets', from: 'account', query: 'open_tickets > 0' },
        { kind: 'metric', title: 'Busy, by computed count', from: 'account', query: 'ticket_count > 1' },
        { kind: 'metric', title: 'Busy list', from: 'account', to: 'busy' },
        { kind: 'metric', title: 'Busy, by a computed flag = true', from: 'account', query: 'is_busy = true' },
        { kind: 'metric', title: 'Open, through coalesce', from: 'account', query: 'open_or_none >= 1' },
        { kind: 'metric', title: 'Any ticket', from: 'account', query: 'any ticket' },
        { kind: 'metric', title: 'No ticket', from: 'account', query: 'no ticket' },
        { kind: 'metric', title: 'Any open ticket', from: 'account', query: 'any ticket where state = open' },
        { kind: 'metric', title: 'Busy and an open ticket', from: 'account', query: 'tickets > 1 and any ticket where state = open' },
        { kind: 'metric', title: 'Quiet', from: 'account', query: 'tickets <= 1' },
        { kind: 'funnel', title: 'Road', from: 'account', stages: STAGES },
        {
          kind: 'funnel',
          title: 'Computed road',
          from: 'account',
          stages: [{ label: 'Accounts' }, { label: 'Busy', query: 'ticket_count > 1' }, { label: 'Flagged', query: 'is_busy = true' }],
        },
        {
          kind: 'funnel',
          title: 'Pointing road',
          from: 'account',
          stages: [
            { label: 'Accounts' },
            { label: 'Any ticket', query: 'any ticket' },
            { label: 'Open', query: 'any ticket where state = open' },
          ],
        },
      ],
    },
  },
  home: 'overview',
  nav: ['overview', 'accounts', 'busy'],
});

type Answer = { status: number; text: string; body: any };
type Call = (method: 'GET' | 'POST', path: string, body?: object) => Promise<Answer>;

async function serve(url: string, writable: boolean, run: (call: Call) => Promise<void>, schema?: string) {
  const registry = new Registry();
  registry.add({ id: 'busy', name: 'Busy', url, source: 'config', ...(writable ? { writable: true } : {}) });
  const parsed = parseAppConfig(definition(schema), 'busy.ts');
  const hosts: AppHost[] = [{ app: { path: 'busy.ts', app: parsed, pages: [], sources: {} }, pages: [] }];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(async (method, path, body) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}${method === 'GET' ? `?app=${parsed.id}` : ''}`, {
        signal: AbortSignal.timeout(10000),
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify({ app: parsed.id, ...body }) } : {}),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, text, body: json };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('busy');
  }
}

type Served = AskedSection & { title?: string; stages?: FunnelStage[] };

/* The dashboard as served, every section asked as the client asks it, and each figure held to its rows and the funnel. */
async function figures(call: Call) {
  const app = await call('GET', '/api/app');
  assert.equal(app.status, 200, app.text);
  const view = app.body.app.views.overview as { window?: string; error?: string; sections: Served[] };
  assert.equal(view.error, undefined, view.error);
  const sections = view.sections.map((section) => {
    assert.equal(section.error, undefined, `${section.title}: ${section.error}`);
    return windowed(section, view.window ?? null);
  });
  const metrics = sections.filter((section) => section.kind === 'metric');
  const funnels = sections.filter((section) => section.kind === 'funnel');
  const items = [
    ...metrics.map((section) => ({ text: measureText(section, section.query), limit: 1 })),
    ...funnels.map((section) => ({ text: funnelText(section)! })),
  ];
  const asked = await call('POST', '/api/breakdowns', { items });
  assert.equal(asked.status, 200, asked.text);
  const answers = asked.body.results as Array<{ status: number; body: any }>;
  assert.equal(answers.length, items.length);
  const said = answers.map((answer, at) => {
    assert.equal(answer.status, 200, `${items[at].text}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.errors, undefined, `${items[at].text}: ${JSON.stringify(answer.body.errors)}`);
    return answer.body.rows as Array<Record<string, unknown>>;
  });
  const figure = (at: number) => {
    const row = said[at][0];
    return Number(row[Object.keys(row)[0]]);
  };
  const shown = Object.fromEntries(metrics.map((section, at) => [section.title, figure(at)]));
  assert.deepEqual(shown, EXPECTED, `each figure says what its rows say: ${items.map((item) => item.text).join(' | ')}`);
  const [road, computedRoad, pointingRoad] = funnels.map((_, at) => said[metrics.length + at][0]);
  assert.deepEqual(
    [road.stage_1, road.stage_2, road.stage_3].map(Number),
    [ACCOUNTS.length, EXPECTED['Busy'], EXPECTED['Busy in the north']],
    "the funnel's stages are the figures' counts",
  );
  assert.deepEqual([computedRoad.stage_1, computedRoad.stage_2, computedRoad.stage_3].map(Number), [
    ACCOUNTS.length,
    EXPECTED['Busy, by computed count'],
    EXPECTED['Busy, by a computed flag = true'],
  ]);
  assert.deepEqual([pointingRoad.stage_1, pointingRoad.stage_2, pointingRoad.stage_3].map(Number), [
    ACCOUNTS.length,
    EXPECTED['Any ticket'],
    EXPECTED['Any open ticket'],
  ]);
}

for (const writable of [false, true]) {
  const served = writable ? 'writable' : 'read-only';
  test(`SQLite: a figure over a count of related rows counts what the funnel counts (${served})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-figure-rollup-'));
    const file = join(directory, 'busy.db');
    const db = new DatabaseSync(file);
    db.exec(SQL('INTEGER'));
    db.close();
    try {
      await serve(file, writable, figures);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const schema of [undefined, 'crm']) {
    test(
      `PostgreSQL: a figure over a count of related rows counts what the funnel counts (${served}, ${schema ? 'a schema of its own' : 'public'})`,
      { skip: liveSkip('postgres', LIVE), timeout: 120000 },
      async () => {
        const owned = await uuidPostgresDatabase('tw_figure_rollup');
        try {
          const client = await pgClient(owned.url);
          try {
            await client.query(SQL('integer', schema));
          } finally {
            await client.end();
          }
          await serve(owned.url, writable, figures, schema);
        } finally {
          await owned.drop();
        }
      },
    );
  }
}
