/**
 * A public command page on a tenant App (a field report): its signed-out visitor's run was answered "Sign in to do
 * that", because the tenant host had no page door. Here it has the ordinary host's door, taken by public intake: the
 * public address the visitor reads the page under (`?via=`) places the run with that tenant, as the tenant's mapped
 * host does, and an address that places nobody lands in triage. The door keeps the ordinary host's guards — a ticket,
 * the page's own origin, the command the page names — and `mistri check`'s words for what intake cannot take.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { issueTicket } from '../packages/mistri/src/server/forms/publicTicket.js';
import { tenantPageProblems } from '../packages/mistri/src/server/tenant/tenantIntakePages.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  APP_ID,
  NORTH,
  NORTH_HOST,
  NORTH_PUBLIC,
  openTenantPublicForms,
  publicFormsDatabase,
  SOUTH_PUBLIC,
  UNKNOWN,
  via,
} from './support/tenantPublicForms.js';

/* A ticket old enough to be a person's: issued in this process, under the key the server signs with. */
const aged = (page = 'lobby') => issueTicket(APP_ID, page, Date.now() - 5_000);
let submissions = 0;
const key = () => `page-submission-${String(++submissions).padStart(6, '0')}`;

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's public command page (${dialect})`, { skip }, () => {
    const database = publicFormsDatabase();
    after(async () => {
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });
    const open = (t: Parameters<typeof openTenantPublicForms>[0]) =>
      openTenantPublicForms(t, dialect, database, { publicReads: true, publicPage: true });
    type Forms = Awaited<ReturnType<typeof open>>;
    /* Each run from a budget of its own: the budgets are the public form's, proved in its suites, and these runs all
       come from one address. */
    const run = (f: Forms, query: string, name: string, init: { host?: string; headers?: Record<string, string> } = {}) =>
      (resetPublicFormLimits(), f).call(`/api/pages/lobby/commands/apply${query}`, {
        body: { input: { name }, submission: key() },
        ...init,
        headers: { 'x-mistri-ticket': aged(), ...init.headers },
      });
    const written = async (f: Forms) => ({
      lead: await f.rows('SELECT tenant_id, name FROM lead ORDER BY name'),
      intake: await f.rows('SELECT name FROM intake_submission ORDER BY name'),
    });

    test("a visitor's run lands with the tenant its public address or mapped host places, and nowhere else in triage", async (t) => {
      const f = await open(t);
      const ticket = await f.call('/api/pages/lobby/ticket');
      assert.equal(ticket.status, 200, ticket.text);
      assert.equal(typeof ticket.body.ticket, 'string');
      const north = await run(f, via(NORTH_PUBLIC), 'Ada');
      assert.equal(north.status, 200, north.text);
      assert.equal(north.body.reference, 'YRD-Ada');
      assert.equal(north.body.message, 'Application received.');
      assert.equal((await run(f, via(SOUTH_PUBLIC), 'Bo')).status, 200);
      assert.equal((await run(f, '', 'Cy', { host: `${NORTH_HOST}:${f.port}` })).status, 200);
      // No address, an unknown one, and a tenant's intake address (a form's, not the page's) place nobody.
      for (const [query, name] of [
        ['', 'Dee'],
        [via(UNKNOWN), 'Eve'],
        [via(NORTH), 'Fay'],
      ] as const)
        assert.equal((await run(f, query, name)).status, 200);
      assert.deepEqual(await written(f), {
        lead: [
          { tenant_id: 'north', name: 'Ada' },
          { tenant_id: 'south', name: 'Bo' },
          { tenant_id: 'north', name: 'Cy' },
        ],
        intake: [{ name: 'Dee' }, { name: 'Eve' }, { name: 'Fay' }],
      });
    });

    test("the visitor's App names the page's commands, so its page runs them signed out", async (t) => {
      const f = await open(t);
      const app = await f.call(`/api/app?app=${APP_ID}&via=${encodeURIComponent(NORTH_PUBLIC)}`);
      assert.equal(app.status, 200, app.text);
      assert.deepEqual(Object.keys(app.body.app.publicCommands), ['apply']);
    });

    test('the door keeps its guards, and a refused run writes nothing', async (t) => {
      const f = await open(t);
      const refusals: Array<[Promise<{ status: number; body: any; text: string }>, number, string?]> = [
        // A command the page does not name, and a view that is no public page, read as missing.
        [f.call('/api/pages/lobby/commands/quote', { body: { input: { name: 'X' }, submission: key() } }), 404, 'not_found'],
        [f.call('/api/pages/leads/ticket'), 404, 'not_found'],
        [f.call('/api/pages/lobby/commands/apply'), 405],
        // A ticket's address says nothing; a mapped host names its tenant, so an address there is a second one.
        [f.call(`/api/pages/lobby/ticket${via(NORTH_PUBLIC)}`), 400],
        [run(f, via(NORTH_PUBLIC), 'X', { host: `${NORTH_HOST}:${f.port}` }), 400],
        [run(f, via(NORTH_PUBLIC), 'X', { headers: { origin: 'http://elsewhere.example.test' } }), 403, 'cross_origin'],
        [run(f, via(NORTH_PUBLIC), 'X', { headers: { 'x-mistri-ticket': '' } }), 403, 'ticket_refused'],
        [run(f, via(NORTH_PUBLIC), 'X', { headers: { 'x-mistri-ticket': issueTicket(APP_ID, 'lobby') } }), 425, 'ticket_refused'],
        // Another page's ticket is not this page's.
        [run(f, via(NORTH_PUBLIC), 'X', { headers: { 'x-mistri-ticket': aged('elsewhere') } }), 403, 'ticket_refused'],
      ];
      for (const [answer, status, code] of refusals) {
        const { status: got, body, text: said } = await answer;
        assert.equal(got, status, said);
        if (code) assert.equal(body.code, code);
      }
      assert.deepEqual(await written(f), { lead: [], intake: [] });
    });
  });
}

test('check says, naming the page, what tenant intake cannot take', () => {
  const input = { name: { label: 'Name', type: 'text', max: 80 } } as const;
  const output = shape({ reference: text(), message: literal('Thanks.') });
  const handle = async () => ({ reference: 'R-1', message: 'Thanks.' as const });
  const registry = defineCommands({
    enrol: defineCommand({ targets: 'none', source: 'main', target: 'lead', write: ['lead'], public: true, input, output, handle }),
    inside: defineCommand({ targets: 'none', source: 'main', target: 'lead', write: ['lead'], input, output, handle }),
    shared: defineCommand({ targets: 'none', source: 'main', target: 'make', write: ['make'], public: true, input, output, handle }),
    pick: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'lead',
      write: ['lead'],
      public: true,
      input: { make: { label: 'Make', type: 'choice', from: 'make', labelColumn: 'name' } },
      output,
      handle,
    }),
  });
  const page = (commands: string[]) => ({
    kind: 'page',
    label: 'Lobby',
    component: { id: 'page-lobby', module: './pages/lobby.page.tsx', kind: 'page' },
    reads: [],
    commands,
    public: true,
  });
  const app = parseTestApp(
    {
      id: 'yard',
      name: 'Yard',
      sources: { main: { connection: 'yard-db' } },
      resources: { lead: { access: 'write' }, make: { access: 'write' } },
      auth: { roles: { staff: { read: true } }, public: { read: ['lead'] } },
      views: {
        leads: { kind: 'list', from: 'lead' },
        lobby: page(['enrol']),
        mixed: page(['inside', 'shared', 'pick']),
      },
      home: 'leads',
    },
    'tenant page checks fixture',
    // The catalog the App is checked against says each is public; the registry it runs is what intake judges.
    { enrol: { public: true, input }, inside: { public: true, input }, shared: { public: true, input }, pick: { public: true } },
  );
  const kinds: Record<string, string> = { lead: 'tenant', make: 'global' };
  const problems = tenantPageProblems(app, registry, 'main', (table) => kinds[table]);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems[0]!, /^Public page "mixed" runs "inside", which is not a public command/);
  assert.match(
    problems[1]!,
    /^Public page "mixed" runs "shared", which writes "make", which is neither a tenant's table nor the platform's/,
  );
  assert.match(problems[2]!, /^Public page "mixed" runs "pick", whose field "make" chooses from a table.*give it fixed options/);
});
