import assert from 'node:assert/strict';
import { createTenantBrandingService } from '../packages/mistri/src/server/tenant/tenantBranding.js';
import { MemoryCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as turn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { withTenantApiRequests } from '../packages/mistri/src/server/tenant/tenantApiRequest.js';
import { openTenantNoticeMail } from '../packages/mistri/src/server/tenant/tenantNoticeMail.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { provisionSqliteBranding } from '../packages/mistri/src/adapters/branding/sqliteBranding.js';
import { parsePagesConfig, type PageDef } from '../packages/engine/src/shared/page.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { fromRecord } from '../packages/mistri/src/shared/branding.js';
import { parseTestApp } from './support/commandCatalog.js';

type HttpOwner = ReturnType<typeof createTenantHttpServer>;
type Answer = { status: number; headers: Headers; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; appId: string; accountId: string; tenantId: string; revision: number; expiresAt: number };
const appId = 'tenant-http',
  privateValue = 'PRIVATE_HTTP_TENANT_SENTINEL';
const ownerHeaders = ['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'].map((name) => `x-mistri-${name}`);
const assertion = (value: Context) => ({ tabId: value.tabId, expectedContext: value.context, expectedRevision: value.revision });
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function context(reply: Answer): Context {
  assert.equal(reply.status, 200, reply.text);
  for (const key of ['tabId', 'context', 'appId', 'accountId', 'tenantId']) assert.equal(typeof reply.body[key], 'string');
  assert.equal(typeof reply.body.expiresAt, 'number');
  assert.ok(Number.isSafeInteger(reply.body.revision) && Number(reply.body.revision) > 0);
  return reply.body as Context;
}
function rows(reply: Answer): Record<string, unknown>[] {
  assert.equal(reply.status, 200, reply.text);
  assert.ok(Array.isArray(reply.body.rows), reply.text);
  return reply.body.rows.map(object);
}
function noPrivate(reply: Answer) {
  assert.doesNotMatch(
    reply.text,
    /PRIVATE_HTTP_TENANT_SENTINEL|session-secret|db_item|db_task|db_note|private-store|business-db|__mistri_|tablewalk-tenant-http-/,
  );
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['sql', 'explain', 'params', 'stack', 'cause', 'sessionId', 'secret', 'tenant_id'].includes(key), `private key ${key}`);
      visit(child);
    }
  };
  visit(reply.body);
}
function denied(reply: Answer) {
  assert.ok(reply.status >= 400 || (Array.isArray(reply.body.errors) && reply.body.errors.length > 0), reply.text);
  noPrivate(reply);
  assert.equal('rows' in reply.body, false);
  for (const header of ownerHeaders) assert.equal(reply.headers.get(header), null, `error must not attest ${header}`);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
function owned(reply: Answer, owner: Context) {
  assert.equal(reply.status, 200, reply.text);
  noPrivate(reply);
  const values = [owner.appId, owner.accountId, owner.tenantId, owner.tabId, owner.context, String(owner.revision)];
  ownerHeaders.forEach((header, index) => assert.equal(reply.headers.get(header), values[index], header));
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.equal('value' in reply.body, false, 'private service result wrapper must not become a wire envelope');
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const metadataPages = () =>
  parsePagesConfig(
    {
      pages: [
        {
          id: 'items',
          label: 'Item',
          base: 'item',
          sections: [
            { kind: 'fields', show: ['name'] },
            { kind: 'list', from: 'note', whose: 'item_id', show: ['name'], create: 'New note' },
          ],
        },
        { id: 'hidden', label: privateValue, base: 'note', sections: [{ kind: 'fields', show: ['secret'] }] },
        {
          id: 'notes',
          label: 'Note',
          base: 'note',
          sections: [
            { kind: 'fields', show: ['name'] },
            { kind: 'metric', from: 'note', whose: 'item_id', about: 'item_id' },
          ],
        },
      ],
    },
    'metadata fixture',
  );

test('tenant metadata is context-owned and projects membership writes without hidden definitions or bindings', async (t) => {
  const pages = metadataPages(),
    f = await fixture(t, { foreignKey: true, metadata: true, pages });
  // Host mutation after enrollment cannot alter the captured page catalog.
  pages[0].name = privateValue;
  const a = await f.open();
  for (const path of ['/api/app', '/api/runtime', '/api/pages']) {
    const reply = await f.data(path, a);
    owned(reply, a);
    noPrivate(reply);
  }
  const app = object((await f.data('/api/app', a)).body.app);
  assert.deepEqual(app.writableTables, ['item']);
  assert.deepEqual(app.grantedCommands, ['advance']);
  assert.equal(object(app.ui).export, false);
  assert.doesNotMatch(JSON.stringify(app), /"auth"|"access"|"sources"|"physical"|"validation"|"form"|"problems"/);
  assert.equal((object(object(app.resources).task).actions as unknown[]).length, 1);
  const runtime = (await f.data('/api/runtime', a)).body;
  assert.equal(object((runtime.apps as unknown[])[0]).writable, true);
  const tables = (await f.data('/api/schema', a)).body.tables as Array<Record<string, unknown>>;
  const item = object(tables.find((table) => table.id === 'item'));
  assert.equal(item.insertable, true);
  assert.equal(item.deletable, false, 'private/full inbound dependencies still prevent Delete');
  assert.ok((item.columns as Array<Record<string, unknown>>).every((column) => column.writable === true));
  const task = object(tables.find((table) => table.id === 'task'));
  assert.equal(task.insertable, false, 'a command grant cannot enable generic insertion');
  assert.ok((task.columns as Array<Record<string, unknown>>).every((column) => column.writable === false));
  const version = object((task.columns as Array<Record<string, unknown>>).find((column) => column.name === 'version'));
  assert.equal(version.hasDefault, true);
  assert.equal(Object.hasOwn(version, 'default'), false);
  const listed = (await f.data('/api/pages', a)).body.pages as PageDef[];
  assert.deepEqual(
    listed.map((page) => page.id),
    ['items', 'notes'],
  );
  assert.equal(listed[0].name, 'Item');
  assert.equal(listed[0].connection, undefined);
  assert.equal('create' in listed[0].sections[1], false);
});

test('branding in tenant App payloads follows the admitted lease, fresh rows and membership fences', async (t) => {
  const f = await fixture(t, { branding: 'readable' });
  f.db.exec('UPDATE db_task SET business_id=tenant_id');
  const north = await f.open('north'),
    south = await f.open('south');
  const brand = (reply: Answer) =>
    object(object(object(reply.body.app).ui).theme).branding as {
      status: string;
      identity: { tenant: string; version: string };
      content: { name?: string };
    };
  const a = await f.data('/api/app', north);
  owned(a, north);
  assert.equal(brand(a).status, 'resolved');
  assert.equal(brand(a).content.name, 'North task');
  assert.equal(brand(await f.data('/api/app', south)).content.name, 'South task');
  f.db.exec("UPDATE db_task SET name='North revised',version=1 WHERE tenant_id='north'");
  const changed = await f.data('/api/app', north);
  owned(changed, north);
  assert.equal(brand(changed).content.name, 'North revised');
  assert.equal(brand(changed).identity.version, '1');
  denied(await f.call(f.select('/api/app', 'south'), undefined, f.headers(north)));
  denied(await f.call(f.select('/api/app', 'north')));
  await f.maintenance((admin) => admin.putMembership({ ...f.grant, status: 'revoked', expectedVersion: '1' }).then(() => {}));
  denied(await f.data('/api/app', north));
});

test("a tenant's branding is read by its members, saved only by its editors, and refused in a fixed sentence", async (t) => {
  const f = await fixture(t, { tenantBranding: true });
  const north = await f.open('north');
  const state = await f.data('/api/branding', north, {});
  owned(state, north);
  assert.equal(state.body.revision, 0);
  assert.equal(state.body.editor, false);
  assert.deepEqual(state.body.allow, ['name', 'accent', 'logo']);
  // An operator is a member, not an editor: refused, and nothing is written.
  const refused = await f.data('/api/branding/save', north, { branding: { name: 'North Co' } });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.body.code, 'forbidden');
  assert.equal((await f.data('/api/branding', north, {})).body.revision, 0);

  await f.maintenance((admin) => admin.putMembership({ ...f.grant, roles: ['operator', 'viewer'], expectedVersion: '1' }).then(() => {}));
  const editor = await f.open('north');
  assert.equal((await f.data('/api/branding', editor, {})).body.editor, true);
  // CSS cannot be smuggled in through the accent, nor markup through the name.
  for (const value of [{ accent: 'red;}body{display:none' }, { accent: '#123456;}' }, { name: '<script>x</script>' }, { theme: 'mono' }]) {
    const bad = await f.data('/api/branding/save', editor, { branding: value });
    assert.equal(bad.status, 422, bad.text);
    assert.equal(bad.body.code, 'branding_refused');
    assert.equal(bad.body.outcome, 'not_applied');
    assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length, bad.text);
  }
  const script = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="4" height="4" onload="alert(1)"/></svg>',
  );
  const saved = await f.data('/api/branding/save', editor, {
    branding: { name: 'North Co', accent: '#1d4ed8' },
    logo: script.toString('base64'),
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.revision, 1);
  const logo = object(object(saved.body.branding).logo);
  assert.match(String(logo.hash), /^[0-9a-f]{64}$/);
  assert.equal(logo.type, 'image/svg+xml');
  const big = Buffer.alloc(257 * 1024, 1);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const oversized = await f.data('/api/branding/save', editor, { branding: {}, logo: big.toString('base64') });
  assert.equal(oversized.status, 422, oversized.text.slice(0, 200));
  assert.equal(object((oversized.body.errors as unknown[])[0]).field, 'logo');

  // The shell wears it, from the lease's own tenant; the other tenant keeps the App's.
  const theme = (reply: Answer) => object(object(object(reply.body.app).ui).theme);
  const branded = theme(await f.data('/api/app', editor));
  assert.equal(object(object(branded.branding).content).name, 'North Co');
  assert.equal(object(object(branded.branding).mark).src, `/api/branding/logo/${logo.hash}`);
  const south = await f.open('south');
  const plain = object((await f.data('/api/app', south)).body.app) as { ui?: { theme?: { branding?: unknown } } };
  assert.equal(plain.ui?.theme?.branding, undefined);

  // What the service keeps of the SVG runs nothing.
  const kept = await (f.options as { branding: ReturnType<typeof memoryBranding> }).branding.logo(String(logo.hash));
  assert.ok(kept);
  const text = Buffer.from(kept.bytes).toString('utf8');
  assert.doesNotMatch(text, /script|onload|alert/i);
});

test('branding cannot read a hidden managed tenant field', async (t) => {
  const f = await fixture(t, { branding: 'managed' }),
    north = await f.open();
  const reply = await f.data('/api/app', north);
  owned(reply, north);
  const brand = object(object(object(object(reply.body.app).ui).theme).branding);
  assert.equal(brand.status, 'fallback');
  assert.deepEqual(brand.content, {});
});

test('metadata uses membership grants and cannot borrow a privileged global login role', async (t) => {
  const f = await fixture(t, { metadata: true, foreignKey: true, pages: metadataPages() });
  await f.maintenance((admin) => admin.putMembership({ ...f.grant, roles: ['viewer'], expectedVersion: '1' }).then(() => {}));
  const a = await f.open(),
    reply = await f.data('/api/app', a);
  owned(reply, a);
  assert.deepEqual(object(reply.body.app).writableTables, []);
  assert.deepEqual(object(reply.body.app).grantedCommands, []);
  assert.equal(object(((await f.data('/api/runtime', a)).body.apps as unknown[])[0]).writable, false);
  const tables = (await f.data('/api/schema', a)).body.tables as Array<Record<string, unknown>>;
  assert.ok(
    tables.every(
      (table) =>
        table.insertable === false &&
        table.deletable === false &&
        (table.columns as Array<Record<string, unknown>>).every((column) => column.writable === false),
    ),
  );
  assert.deepEqual(
    Object.values(object(object(reply.body.app).views)).map((view) => object(view).table),
    ['item'],
  );
  /* The viewer reads items and not their notes: the item page is served without its notes list, never dropped for
     it, and a page over notes is not served at all. */
  const pages = (await f.data('/api/pages', a)).body.pages as Array<Record<string, unknown>>;
  assert.deepEqual(
    pages.map((page) => [page.id, (page.sections as Array<{ kind: string }>).map((section) => section.kind)]),
    [['items', ['fields']]],
  );
  assert.ok(!JSON.stringify(pages).includes(privateValue));
});

test("batched tab counts and a count-free run pass the tenant allowlist and stay the tenant's own", async (t) => {
  const f = await fixture(t),
    a = await f.open();
  f.db.prepare(`INSERT INTO db_item VALUES ('north-item-2','north','other','North item two')`).run();
  // South's item shares north's business id: a count that escaped the scope would say 2 there.
  const counts = await f.data('/api/counts', a, { items: ['item', 'item name = "North item"', 'item business_id = same'] });
  owned(counts, a);
  noPrivate(counts);
  assert.deepEqual(
    (counts.body.results as Array<Record<string, unknown>>).map((result) => result.total),
    [2, 1, 1],
  );
  const bounded = await f.data('/api/counts', a, { items: ['item'], countLimit: 1 });
  owned(bounded, a);
  assert.deepEqual(bounded.body.results, [{ total: 1, exactTotal: true, cappedTotal: true }]);
  const run = await f.data('/api/run', a, { q: 'item', limit: 1, count: 'none' });
  owned(run, a);
  assert.equal(run.body.total, undefined);
  assert.equal(rows(run).length, 1);
  // A tenant host does not stream an export: the client reads it through /api/run instead.
  const exported = await f.data('/api/export', a, { q: 'item' });
  assert.notEqual(exported.status, 200);
  assert.doesNotMatch(exported.text, /North item|South item/);
  noPrivate(exported);
});

test('configured and suggested page plans and references stay on the selected tenant', async (t) => {
  const f = await fixture(t, { foreignKey: true, pages: metadataPages() }),
    a = await f.open();
  const suggestion = await f.call(f.select('/api/pages/suggested') + '&table=item', undefined, f.headers(a));
  owned(suggestion, a);
  noPrivate(suggestion);
  for (const page of ['items', 'suggested:item']) {
    const planned = await f.data('/api/pages/plan', a, { page, key: { id: 'north-item' } });
    owned(planned, a);
    noPrivate(planned);
    const plan = (planned.body.plans as Array<Record<string, unknown>>).find((plan) => plan.kind === 'list')!;
    const read = await f.data('/api/view/run', a, { view: plan.view });
    owned(read, a);
    assert.deepEqual(
      rows(read).map((row) => row.name),
      ['North note'],
    );
  }
  const refs = await f.data('/api/references', a, { table: 'item', key: { id: 'north-item' } });
  owned(refs, a);
  noPrivate(refs);
  assert.deepEqual(
    (refs.body.references as Array<Record<string, unknown>>).map((ref) => [ref.constraint, ref.count]),
    [['note.item_id', 1]],
  );
});

/* A composed part's timing is its own; everything it says is compared. */
const timeless = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(timeless)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'ms')
            .map(([key, item]) => [key, timeless(item)]),
        )
      : value;

test("a composed record page is read on one context, each part as its own request answers it, and only the tenant's own", async (t) => {
  const f = await fixture(t, {
      foreignKey: true,
      history: true,
      pages: parsePagesConfig(
        {
          pages: [
            {
              id: 'items',
              label: 'Item',
              base: 'item',
              sections: [
                { kind: 'fields', show: ['name'] },
                { kind: 'list', from: 'note', whose: 'item_id', show: ['name'] },
                { kind: 'history' },
              ],
            },
          ],
        },
        'compose fixture',
      ),
    }),
    a = await f.open();
  const composed = await f.data('/api/pages/compose', a, { page: 'items', key: { id: 'north-item' }, rows: 10 });
  owned(composed, a);
  noPrivate(composed);
  assert.equal(composed.body.planned, true);
  const planned = await f.data('/api/pages/plan', a, { page: 'items', key: { id: 'north-item' } });
  assert.deepEqual(composed.body.plans, planned.body.plans);
  const reads = composed.body.reads as Array<{ path: string; body: Record<string, unknown>; status: number; reply: unknown }>;
  assert.deepEqual(reads.map((read) => read.path).sort(), ['/api/record-history', '/api/view/run', '/api/view/run']);
  for (const read of reads) {
    const alone = await f.data(read.path, a, read.body);
    owned(alone, a);
    assert.deepEqual(timeless(read.reply), timeless(alone.body), read.path);
  }
  assert.ok(composed.text.includes('North note') && !composed.text.includes('South note'));
  // Another tenant's record composes nothing: its plan is refused, and so is the page.
  denied(await f.data('/api/pages/compose', a, { page: 'items', key: { id: 'south-item' } }));
  // A compose takes the page's own fields and nothing that names an owner.
  denied(await f.data('/api/pages/compose', a, { page: 'items', key: { id: 'north-item' }, tenant: 'south' }));
  denied(await f.data('/api/pages/compose', a, { page: 'items', key: { id: 'north-item' }, rows: 5000 }));
});

test('a composed record page asks which of its verbs are available, as one availability request does', async (t) => {
  const f = await fixture(t, {
      twoCommands: true,
      pages: parsePagesConfig(
        { pages: [{ id: 'tasks', label: 'Task', base: 'task', sections: [{ kind: 'fields', show: ['name'] }] }] },
        'compose verbs fixture',
      ),
    }),
    a = await f.open();
  const composed = await f.data('/api/pages/compose', a, { page: 'tasks', key: { id: 'north-task' } });
  owned(composed, a);
  const verbs = (composed.body.reads as Array<{ path: string; body: Record<string, unknown>; reply: unknown }>).find(
    (read) => read.path === '/api/commands/availability',
  );
  assert.ok(verbs);
  assert.deepEqual(verbs.reply, (await f.data('/api/commands/availability', a, verbs.body)).body);
  assert.equal(f.control.commands, 0);
  assert.equal(f.version(), 0);
});

test("a page releases its context over HTTP as it leaves, and the same tab's next page resumes it once", async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const release = (
    value: Context,
    body: Record<string, unknown> = { tabId: value.tabId, expectedContext: value.context, expectedRevision: value.revision },
  ) => f.call(`/api/tenant/context/release?app=${appId}`, body);
  const resume = (tabId: string, tenant = 'north') => f.call(f.select('/api/tenant/context/resume', tenant), { tabId });
  // Held by a page: never resumed by another.
  denied(await resume(a.tabId));
  // A release names its own lease, and says nothing of the context.
  denied(await release(a, { tabId: a.tabId, expectedContext: 'another', expectedRevision: a.revision }));
  const released = await release(a);
  assert.equal(released.status, 200, released.text);
  assert.deepEqual(released.body, { tabId: a.tabId, status: 'released' });
  for (const header of ownerHeaders) assert.equal(released.headers.get(header), null, header);
  // Another tenant's selector does not resume it.
  denied(await resume(a.tabId, 'south'));
  const resumed = context(await resume(a.tabId));
  assert.deepEqual(resumed, a);
  owned(await f.data('/api/count', resumed, { table: 'item' }), resumed);
  denied(await resume(a.tabId));
});

const componentPages = () =>
  parsePagesConfig(
    {
      pages: [
        {
          id: 'items',
          label: 'Item',
          base: 'item',
          sections: [
            {
              kind: 'custom',
              component: { id: 'card', module: './widgets/Card.tsx' },
              record: ['name'],
              rows: { notes: { from: 'note', whose: 'item_id', show: ['name'] }, every: { from: 'note', show: ['name'] } },
            },
          ],
        },
      ],
    },
    'component fixture',
  );

test('a custom component is served where its code is, and each read it declares is planned and run inside the tenant', async (t) => {
  const components = { card: { kind: 'section', href: `/${appId}/_components/card-0123abcd.js` } };
  const f = await fixture(t, { foreignKey: true, pages: componentPages(), components }),
    a = await f.open();
  const app = object((await f.data('/api/app', a)).body.app);
  assert.deepEqual(app.components, components, 'the page is told where each component is served, and nothing else about it');
  const planned = await f.data('/api/pages/plan', a, { page: 'items', key: { id: 'north-item' } });
  owned(planned, a);
  noPrivate(planned);
  const custom = object((planned.body.plans as Array<Record<string, unknown>>).find((plan) => plan.kind === 'custom'));
  const reads = object(custom.reads);
  // The record's own rows, and the rows it names with no path back to the record: both only this tenant's.
  for (const [name, expected] of [
    ['notes', ['North note']],
    ['every', ['North note']],
  ] as const) {
    const read = await f.data('/api/view/run', a, { view: object(reads[name]).view });
    owned(read, a);
    noPrivate(read);
    assert.deepEqual(
      rows(read).map((row) => row.name),
      expected,
      name,
    );
  }
  // Another tenant's record, by a forged key, plans nothing a component could be given.
  for (const key of [{ id: 'south-item' }, { id: 'missing' }]) denied(await f.data('/api/pages/plan', a, { page: 'items', key }));
  // A view naming another tenant's key still reads only this tenant's rows.
  const forged = {
    ...object(object(reads.notes).view),
    id: 'page:items:0:forged',
    filter: { groups: [[{ path: 'item_id', op: '=', value: 'south-item' }]] },
  };
  const read = await f.data('/api/view/run', a, { view: forged });
  owned(read, a);
  assert.deepEqual(rows(read), []);
});

const historyPages = () =>
  parsePagesConfig(
    { pages: [{ id: 'items', label: 'Item', base: 'item', sections: [{ kind: 'fields', show: ['name'] }, { kind: 'history' }] }] },
    'history fixture',
  );

test("a record's history is its tenant's: kept under its key and its owner, read only through a record the reader can read", async (t) => {
  const f = await fixture(t, { history: true, pages: historyPages() }),
    north = await f.open('north');
  owned(await f.data('/api/update', north, { table: 'item', key: { id: 'north-item' }, values: { name: 'North renamed' } }), north);
  const history = (context: Awaited<ReturnType<typeof f.open>>, id: string) =>
    f.data('/api/record-history', context, { table: 'item', key: { id } });
  const read = await history(north, 'north-item');
  owned(read, north);
  noPrivate(read);
  const entries = read.body.entries as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'update');
  assert.equal(entries[0].via, 'app');
  assert.deepEqual(entries[0].fields, [{ column: 'name', before: 'North item', after: 'North renamed' }]);
  // The store says whose each entry is: the owner is part of the record's key there, and never a change.
  const stored = f.db
    .prepare('SELECT resource, key_json, changes_json, actor FROM __mistri_history_change')
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(
    stored.map((row) => [row.resource, JSON.parse(String(row.key_json))]),
    [['db_item', { id: 'north-item', tenant_id: 'north' }]],
  );
  assert.doesNotMatch(String(stored[0].changes_json), /tenant_id/);
  assert.equal(stored[0].actor, 'Alice', "the verified account, never a request's word");
  /* Another tenant's record, by its key, has no history for this reader, and neither does a missing one, nor a record
     whose page keeps none: each the ordinary not-found, never the context's denial, which the browser takes for a lost
     session. A record's head asks this for any table a live change names, so the context answers on after it. */
  const notFound = (reply: Answer) => {
    denied(reply);
    assert.equal(reply.status, 404, reply.text);
    assert.equal(reply.body.code, 'not_found');
  };
  for (const id of ['south-item', 'alias-item', 'missing']) notFound(await history(north, id));
  notFound(await f.data('/api/record-history', north, { table: 'note', key: { id: 'north-note' } }));
  owned(await history(north, 'north-item'), north);
  /* The same key under another owner is another record's history: an entry
     planted for north-item as south's is never read in north, and south
     cannot read north-item's at all. */
  f.db
    .prepare(`INSERT INTO __mistri_history_change (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    SELECT write_id || '-planted', at, resource, '{"id":"north-item","tenant_id":"south"}', kind, changes_json, actor, actor_name, via, action
    FROM __mistri_history_change`)
    .run();
  assert.equal(((await history(north, 'north-item')).body.entries as unknown[]).length, 1);
  const south = await f.open('south');
  denied(await history(south, 'north-item'));
  owned(await history(south, 'south-item'), south);
  assert.deepEqual((await history(south, 'south-item')).body.entries, []);
  // The request names no tenant, owner or store key of its own.
  denied(await f.data('/api/record-history', north, { table: 'item', key: { id: 'north-item', tenant_id: 'south' } }));
  denied(await f.data('/api/record-history', north, { table: 'item', key: { id: 'north-item' }, tenant: 'south' }));
});

test("a dashboard's activity is its tenant's: the store reads that tenant's changes alone, and each record is read in the tenant first", async (t) => {
  const f = await fixture(t, { history: true, activity: true, pages: historyPages() });
  const north = await f.open('north'),
    south = await f.open('south');
  owned(await f.data('/api/update', north, { table: 'item', key: { id: 'north-item' }, values: { name: 'North renamed' } }), north);
  owned(await f.data('/api/update', south, { table: 'item', key: { id: 'south-item' }, values: { name: 'South renamed' } }), south);
  const feed = async (context: Awaited<ReturnType<typeof f.open>>) => {
    const read = await f.data('/api/record-activity', context, { view: 'feed', section: 0, period: 'week' });
    owned(read, context);
    noPrivate(read);
    return (read.body.entries as Array<Record<string, unknown>>).map((entry) => [
      entry.label,
      entry.key,
      (entry.fields as Array<{ after: unknown }>)[0]?.after,
    ]);
  };
  assert.deepEqual(await feed(north), [['North renamed', { id: 'north-item' }, 'North renamed']]);
  assert.deepEqual(await feed(south), [['South renamed', { id: 'south-item' }, 'South renamed']]);
  /* Another tenant's busy day never crowds a quiet one out: two hundred of
     south's changes, newer than north's one, and north's feed still has it.
     The store is asked for north's rows alone, before its limit. */
  f.db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
    INSERT INTO __mistri_history_change (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    SELECT 'busy-' || i, c.at, c.resource, c.key_json, c.kind, c.changes_json, c.actor, c.actor_name, c.via, c.action
    FROM n, __mistri_history_change c WHERE c.key_json = '{"id":"south-item","tenant_id":"south"}' AND c.write_id NOT LIKE 'busy-%'`)
    .run();
  assert.deepEqual(await feed(north), [['North renamed', { id: 'north-item' }, 'North renamed']]);
  /* A change stored as south's under north's record key is south's: north's
     feed never says it, though north can read north-item. */
  f.db
    .prepare(`INSERT INTO __mistri_history_change (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    SELECT 'planted', at, resource, '{"id":"north-item","tenant_id":"south"}', kind, '{"name":{"before":"x","after":"PLANTED"}}', actor, actor_name, via, action
    FROM __mistri_history_change WHERE key_json = '{"id":"north-item","tenant_id":"north"}'`)
    .run();
  assert.deepEqual(await feed(north), [['North renamed', { id: 'north-item' }, 'North renamed']]);
  // The request names the dashboard and its section, never a tenant or a resource of its own.
  denied(await f.data('/api/record-activity', north, { view: 'feed', section: 0, period: 'week', tenant: 'south' }));
  denied(await f.data('/api/record-activity', north, { view: 'item', section: 0, period: 'week' }));
});

test("notices are kept in the inbox of the tenant whose record was written, and read and marked only on that tenant's lease", async (t) => {
  const f = await fixture(t, { notify: true });
  const aliceNorth = await f.open('north'),
    aliceSouth = await f.open('south');
  owned(
    await f.data('/api/update', aliceNorth, { table: 'item', key: { id: 'north-item' }, values: { name: 'North renamed' } }),
    aliceNorth,
  );
  owned(
    await f.data('/api/update', aliceSouth, { table: 'item', key: { id: 'south-item' }, values: { name: 'South renamed' } }),
    aliceSouth,
  );
  const bobNorth = await f.open('north', 'bob'),
    bobSouth = await f.open('south', 'bob');
  const as = (context: Awaited<ReturnType<typeof f.open>>, path: string, body: unknown) =>
    f.call(f.select(path, context.tenantId), body, { ...f.headers(context), cookie: 'fixture=bob' });
  const inbox = async (context: Awaited<ReturnType<typeof f.open>>) => {
    const reply = await as(context, '/api/inbox', { limit: 20 });
    owned(reply, context);
    noPrivate(reply);
    return reply.body as { notices: Array<Record<string, unknown>>; unread: number };
  };
  // Each tenant's notice in that tenant's inbox, and only there.
  const north = await inbox(bobNorth),
    south = await inbox(bobSouth);
  assert.deepEqual(
    north.notices.map((notice) => [notice.title, notice.key]),
    [['Renamed to North renamed', { id: 'north-item' }]],
  );
  assert.deepEqual(
    south.notices.map((notice) => [notice.title, notice.key]),
    [['Renamed to South renamed', { id: 'south-item' }]],
  );
  // The store keeps them apart: neither is the App's own inbox, and the two are not one.
  const apps = f.db
    .prepare('SELECT DISTINCT app FROM __mistri_inbox_notice')
    .all()
    .map((row) => String(row.app));
  assert.equal(apps.length, 2);
  assert.ok(apps.every((app) => app.startsWith(`${appId}/`)));
  // Marking every one read in north leaves south's unread.
  owned(await as(bobNorth, '/api/inbox/read', { all: true }), bobNorth);
  assert.equal((await inbox(bobNorth)).unread, 0);
  assert.equal((await inbox(bobSouth)).unread, 1);
  /* A notice planted in north's inbox about south's record is never shown in
     north: the record is not one north's lease can read. */
  f.db
    .prepare(`INSERT INTO __mistri_inbox_notice (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
    SELECT app, recipient, at, resource, '{"id":"south-item"}', 'Planted', uses_json, actor, actor_name, action
    FROM __mistri_inbox_notice WHERE key_json = '{"id":"north-item"}'`)
    .run();
  assert.deepEqual(
    (await inbox(bobNorth)).notices.map((notice) => notice.title),
    ['Renamed to North renamed'],
  );
  // Whose inbox it is comes from the lease and the session alone.
  denied(await as(bobNorth, '/api/inbox', { limit: 20, recipient: 'alice@example.invalid' }));
  denied(await as(bobNorth, '/api/inbox', { limit: 20, app: `${appId}` }));
  // The writer is never told of their own write, and Alice reads nothing that was Bob's.
  assert.deepEqual((await f.data('/api/inbox', aliceNorth, { limit: 20 })).body.notices, []);
});

test("an @mention on a tenant's record tells that tenant's members at their accounts' emails, a team as its members, and never another tenant's", async (t) => {
  const f = await fixture(t, { mentions: true });
  const aliceNorth = await f.open('north');
  const mention = (id: string, label: string, group = false) =>
    `<span data-type="mention" data-id="${id}"${group ? ' data-kind="group"' : ''}>@${label}</span>`;
  const write = async (notes: string) =>
    owned(await f.data('/api/update', aliceNorth, { table: 'item', key: { id: 'north-item' }, values: { notes } }), aliceNorth);
  const told = () =>
    f.db
      .prepare('SELECT recipient, app, title FROM __mistri_inbox_notice ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  // South's Bob is not north's: a handle from another tenant tells nobody.
  await write(`<p>${mention('s-bob', 'Bob')}</p>`);
  assert.deepEqual(told(), []);
  // North's row names Carol's account, which is no member of north: the row is the tenant's, the membership is not.
  await write(`<p>${mention('n-carol', 'Carol')}</p>`);
  assert.deepEqual(told(), []);
  await write(`<p>${mention('n-bob', 'Bob')}</p>`);
  assert.deepEqual(
    told().map((row) => [row.recipient, row.title]),
    [['bob@example.invalid', 'Mentioned on North item']],
  );
  // The team is told as its members, but Bob, mentioned already, is not told again; south's team is nobody here.
  await write(`<p>${mention('n-bob', 'Bob')} ${mention('n-desk', 'Desk', true)} ${mention('s-desk', 'Desk', true)}</p>`);
  assert.deepEqual(
    told().map((row) => row.recipient),
    ['bob@example.invalid', 'alice@example.invalid'],
  );
  // Bob reads it in north's inbox, on north's lease alone.
  const bobNorth = await f.open('north', 'bob'),
    bobSouth = await f.open('south', 'bob');
  const inbox = async (context: Awaited<ReturnType<typeof f.open>>) => {
    const reply = await f.call(f.select('/api/inbox', context.tenantId), { limit: 20 }, { ...f.headers(context), cookie: 'fixture=bob' });
    owned(reply, context);
    return (reply.body as { notices: Array<{ title: string }> }).notices.map((notice) => notice.title);
  };
  assert.deepEqual(await inbox(bobNorth), ['Mentioned on North item']);
  assert.deepEqual(await inbox(bobSouth), []);
});

test("a CSV import lands every row in the member's own tenant, and cannot name another's", async (t) => {
  const f = await fixture(t, { imports: true }),
    north = await f.open('north');
  const post = (body: Record<string, unknown>) => f.data('/api/import', north, body);
  const file = (lines: string[]) => ({
    table: 'item',
    csv: ['id,business_id,name', ...lines].join('\r\n'),
    mapping: ['id', 'business_id', 'name'],
  });
  const checked = await post({ ...file(['imported-1,biz-1,Imported one', 'imported-2,biz-2,Imported two']), mode: 'check' });
  owned(checked, north);
  noPrivate(checked);
  assert.equal(checked.body.outcome, 'checked');
  assert.equal(checked.body.ready, 2);
  const applied = await post({ ...file(['imported-1,biz-1,Imported one', 'imported-2,biz-2,Imported two']), mode: 'commit' });
  owned(applied, north);
  assert.equal(applied.body.outcome, 'applied');
  assert.equal(applied.body.applied, 2);
  assert.deepEqual(
    f.db
      .prepare("SELECT id, tenant_id FROM db_item WHERE id LIKE 'imported-%' ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'imported-1', tenant_id: 'north' },
      { id: 'imported-2', tenant_id: 'north' },
    ],
  );
  // The owner is the runtime's: a file cannot map it, and a row keyed as another tenant's lands nowhere.
  const owner = await post({
    table: 'item',
    csv: 'id,tenant_id,name\r\nx-1,south,Mallory',
    mapping: ['id', 'tenant_id', 'name'],
    mode: 'commit',
  });
  assert.notEqual(owner.body.outcome, 'applied');
  const taken = await post({ ...file(['south-item,biz-9,Takeover']), mode: 'commit' });
  assert.notEqual(taken.body.outcome, 'applied');
  noPrivate(taken);
  assert.doesNotMatch(taken.text, /South item/);
  assert.deepEqual({ ...f.row('south') }, { id: 'south-item', tenant_id: 'south', business_id: 'same', name: 'South item' });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id = 'x-1'").get()!.n, 0);
  /* A command import finds its record by a business id both tenants hold, and
     runs the command on north's alone. */
  const advanced = await post({ table: 'task', csv: 'business_id\r\nsame', mapping: ['business_id'], mode: 'commit' });
  owned(advanced, north);
  assert.equal(advanced.body.outcome, 'applied', advanced.text);
  assert.deepEqual([f.version('north'), f.version('south')], [1, 0]);
  // North's lease addressed to south is no lease at all: nothing is checked, read or written there.
  denied(await f.call(f.select('/api/import', 'south'), { ...file(['smuggled-1,biz-3,Smuggled']), mode: 'commit' }, f.headers(north)));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id = 'smuggled-1'").get()!.n, 0);
  // South reads none of north's imported rows.
  const south = await f.open('south');
  assert.deepEqual(
    rows(await f.data('/api/query', south, { table: 'item' })).map((row) => row.id),
    ['south-item'],
  );
});

test("a tenant's emailed notices go to its own members as their own membership, link into that tenant, and never carry another tenant's record", async (t) => {
  const f = await fixture(t, { notify: 'email' });
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const accounts: Record<string, string> = {
    'alice@example.invalid': 'alice',
    'bob@example.invalid': 'bob',
    'carol@example.invalid': 'carol',
  };
  const sender = openTenantNoticeMail<IncomingMessage>({
    loaded: { app: f.app, pages: [] },
    deployment: f.enrollment.deployment,
    account: async (email) => (accounts[email] ? { id: accounts[email] } : null),
    transport: { name: 'test', send: async (message) => void sent.push(message) },
    baseURL: 'https://desk.example',
    names: async (tenants) => Object.fromEntries(tenants.map((tenant) => [tenant, `${tenant[0].toUpperCase()}${tenant.slice(1)} branch`])),
    warn: () => {},
  });
  const queued = () => Number(f.db.prepare('SELECT count(*) AS n FROM __mistri_inbox_mail').get()!.n);
  const aliceNorth = await f.open('north'),
    aliceSouth = await f.open('south');
  const rename = async (context: Awaited<ReturnType<typeof f.open>>, id: string, name: string) =>
    owned(await f.data('/api/update', context, { table: 'item', key: { id }, values: { name } }), context);
  await rename(aliceNorth, 'north-item', 'North renamed');
  await rename(aliceSouth, 'south-item', 'South renamed');
  assert.equal(queued(), 2);
  // Bob is told once in each tenant, each message about that tenant's own record and opening it there.
  assert.deepEqual(await sender.runOnce(), { sent: 2, skipped: 0, retried: 0, failed: 0 });
  const byTenant = (tenant: string) => sent.find((message) => message.text.includes(`?tenant=${tenant}`))!;
  assert.deepEqual(
    sent.map((message) => message.to),
    ['bob@example.invalid', 'bob@example.invalid'],
  );
  assert.equal(byTenant('north').subject, 'Renamed to North renamed');
  assert.match(byTenant('north').text, /In North branch\./);
  // The record under the list Bob's membership is served, not the whole App's first (a viewer's).
  assert.match(byTenant('north').text, new RegExp(`Open it: https://desk\\.example/${appId}/item/north-item\\?tenant=north\n`));
  assert.equal(byTenant('south').subject, 'Renamed to South renamed');
  assert.doesNotMatch(byTenant('north').text, /South/);
  assert.equal(queued(), 0);
  /* A row planted in north's outbox about south's record is read as Bob's north
     membership, which cannot read it: dropped, never sent. */
  f.db.exec(`INSERT INTO __mistri_inbox_notice (app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action)
    SELECT app, recipient, at, resource, '{"id":"south-item"}', 'Planted', uses_json, actor, actor_name, action
    FROM __mistri_inbox_notice WHERE key_json = '{"id":"north-item"}';
    INSERT INTO __mistri_inbox_mail (notice, state, due_at, attempts)
    SELECT id, 'queued', '2000-01-01T00:00:00.000Z', 0 FROM __mistri_inbox_notice WHERE title = 'Planted';`);
  sent.length = 0;
  assert.deepEqual(await sender.runOnce(), { sent: 0, skipped: 1, retried: 0, failed: 0 });
  assert.equal(sent.length, 0);
  // Carol has an account, and no membership of north, where a row names her: nobody is mailed.
  f.db.exec("UPDATE db_item SET watcher = 'carol@example.invalid' WHERE id = 'north-item'");
  await rename(aliceNorth, 'north-item', 'North again');
  assert.deepEqual(await sender.runOnce(), { sent: 0, skipped: 1, retried: 0, failed: 0 });
  assert.equal(sent.length, 0);
  // Made a member, she is told: it was the membership, not the address, that was missing.
  await f.maintenance((admin) => admin.putMembership({ ...f.grant, accountId: 'carol', membershipId: 'north-carol' }));
  await rename(aliceNorth, 'north-item', 'North for Carol');
  assert.deepEqual(await sender.runOnce(), { sent: 1, skipped: 0, retried: 0, failed: 0 });
  assert.deepEqual(
    sent.splice(0).map((message) => [message.to, message.subject]),
    [['carol@example.invalid', 'Renamed to North for Carol']],
  );
  f.db.exec("UPDATE db_item SET watcher = 'bob@example.invalid' WHERE id = 'north-item'");
  /* Bob turns email off in north, on north's lease: south's stays on, and the
     switch names no other inbox. */
  const bobNorth = await f.open('north', 'bob'),
    bobSouth = await f.open('south', 'bob');
  const email = (context: Awaited<ReturnType<typeof f.open>>, body: unknown) =>
    f.call(f.select('/api/inbox/email', context.tenantId), body, { ...f.headers(context), cookie: 'fixture=bob' });
  const off = await email(bobNorth, { email: false });
  owned(off, bobNorth);
  assert.deepEqual(off.body, { email: false });
  assert.deepEqual((await email(bobSouth, {})).body, { email: true });
  denied(await email(bobNorth, { email: true, recipient: 'alice@example.invalid' }));
  await rename(aliceNorth, 'north-item', 'North quietly');
  await rename(aliceSouth, 'south-item', 'South loudly');
  assert.deepEqual(await sender.runOnce(), { sent: 1, skipped: 1, retried: 0, failed: 0 });
  assert.deepEqual(
    sent.map((message) => message.subject),
    ['Renamed to South loudly'],
  );
  // The inbox itself is unchanged by the switch: the notice is there to read.
  const inbox = await f.call(f.select('/api/inbox', 'north'), { limit: 20 }, { ...f.headers(bobNorth), cookie: 'fixture=bob' });
  assert.equal((inbox.body as { email?: boolean }).email, false);
  assert.ok((inbox.body as { notices: Array<{ title: string }> }).notices.some((notice) => notice.title === 'Renamed to North quietly'));
});

test('a tenant App whose page shows a history does not start on a database without the history store', async (t) => {
  await assert.rejects(() => fixture(t, { pages: historyPages() }), { code: 'tenant_context_unavailable' });
});

test('metadata enrollment does not relax tenant-owned alternate uniqueness attestation', async (t) => {
  // The planner supports alternate keys, but a tenant-owned writer cannot
  // admit this global UNIQUE(name) constraint across independent tenants.
  await assert.rejects(() => fixture(t, { foreignKey: true, alternateKey: true, pages: metadataPages() }), {
    code: 'tenant_context_unavailable',
  });
});

for (const key of [{}, { id: 'south-item' }, { id: 'missing' }, { id: 'north-item', extra: 'x' }, { id: null }]) {
  test(`page plans and references refuse an unowned or incomplete root ${JSON.stringify(key)}`, async (t) => {
    const f = await fixture(t, { foreignKey: true, pages: metadataPages() }),
      a = await f.open();
    denied(await f.data('/api/pages/plan', a, { page: 'items', key }));
    denied(await f.data('/api/references', a, { table: 'item', key }));
  });
}

test('page planning refuses caller definitions, hidden IDs and cross-tenant about-parent keys', async (t) => {
  const f = await fixture(t, { foreignKey: true, pages: metadataPages() }),
    a = await f.open();
  for (const page of [metadataPages()[0], 'hidden', 'missing'])
    denied(await f.data('/api/pages/plan', a, { page, key: { id: 'north-item' } }));
  // The root is visible, but its current reference points to another tenant.
  f.db.prepare('UPDATE db_note SET item_id=? WHERE id=?').run('south-item', 'north-note');
  denied(await f.data('/api/pages/plan', a, { page: 'notes', key: { id: 'north-note' } }));
});

for (const suffix of ['', '&table=item&table=note', '&table=note&conn=business-db', '&table=missing'])
  test(`suggested pages refuse missing, competing and unknown selectors ${suffix}`, async (t) => {
    const f = await fixture(t, { foreignKey: true }),
      a = await f.open();
    denied(await f.call(f.select('/api/pages/suggested') + suffix, undefined, f.headers(a)));
  });

test('metadata and planning reject stale contexts and do not acknowledge old ownership after revocation', async (t) => {
  const f = await fixture(t, { foreignKey: true, pages: metadataPages() }),
    a = await f.open();
  await f.maintenance((admin) => admin.putMembership({ ...f.grant, status: 'revoked', expectedVersion: '1' }).then(() => {}));
  for (const path of ['/api/app', '/api/runtime', '/api/pages']) denied(await f.data(path, a));
  denied(await f.data('/api/pages/plan', a, { page: 'items', key: { id: 'north-item' } }));
  denied(await f.data('/api/references', a, { table: 'item', key: { id: 'north-item' } }));
});

for (const path of ['/api/app', '/api/runtime', '/api/pages/suggested', '/api/pages/plan', '/api/references'])
  test(`late membership revocation withholds the entire buffered ${path} result`, async (t) => {
    const f = await fixture(t, { foreignKey: true, pages: metadataPages() }),
      a = await f.open();
    const input =
      path === '/api/app' || path === '/api/runtime' || path === '/api/pages/suggested'
        ? undefined
        : path === '/api/pages/plan'
          ? { page: 'items', key: { id: 'north-item' } }
          : { table: 'item', key: { id: 'north-item' } };
    const read = () =>
      path === '/api/pages/suggested' ? f.call(f.select(path) + '&table=item', undefined, f.headers(a)) : f.data(path, a, input);
    const before = f.control.proofs;
    owned(await read(), a);
    const proofs = f.control.proofs - before;
    /* Entry, the runtime's guard before and at release, and the owner's own
       release proof, at least: revoking on the last guard proof lands after
       the body exists and before the membership fence that withholds it. */
    assert.ok(proofs >= 4, 'the real operation must include multiple guarded verification barriers');
    const revokeAt = f.control.proofs + proofs - 1;
    let revoked = false;
    f.control.proof = async () => {
      if (f.control.proofs === revokeAt) {
        revoked = true;
        await f.maintenance((admin) => admin.putMembership({ ...f.grant, status: 'revoked', expectedVersion: '1' }).then(() => {}));
      }
      return f.sessions.alice;
    };
    const reply = await read();
    assert.equal(revoked, true);
    denied(reply);
    assert.equal(
      'references' in reply.body || 'plans' in reply.body || 'app' in reply.body || 'apps' in reply.body || 'page' in reply.body,
      false,
    );
  });

test('the home is resolved from the current membership: one person starts differently in each tenant', async (t) => {
  const f = await fixture(t, { roleHome: true });
  await f.maintenance((admin) =>
    admin
      .putMembership({ ...f.grant, tenantId: 'south', membershipId: 'south-alice', roles: ['viewer'], expectedVersion: '1' })
      .then(() => {}),
  );
  const north = await f.open('north'),
    south = await f.open('south');
  // Alice's login says "global-admin", which no rule names; only the membership counts.
  assert.equal(object((await f.data('/api/app', north)).body.app).home, 'item', 'an operator in north starts on the rule for everyone');
  assert.equal(object((await f.data('/api/app', south)).body.app).home, 'task', "a viewer in south starts on the viewers' rule");
});

/** A tenant branding service over a Map: the store's own behavior is branding-store.test.ts's. */
function memoryBranding(app: AppDef) {
  const values = new Map<string, { value: string; revision: number; logoHash: string | null }>();
  const logos = new Map<string, { type: string; bytes: Uint8Array }>();
  return createTenantBrandingService({
    app,
    cache: new MemoryCacheStore(),
    store: {
      read: async ({ tenant }) => {
        const row = values.get(tenant);
        return row ? { value: row.value, revision: row.revision, by: 'x', at: 'x' } : null;
      },
      logo: async ({ hash }) => logos.get(hash) ?? null,
      write: async (write) => {
        if (write.logo) logos.set(write.logo.hash, { type: write.logo.type, bytes: write.logo.bytes });
        const revision = (values.get(write.tenant)?.revision ?? 0) + 1;
        values.set(write.tenant, { value: write.value, revision, logoHash: write.logoHash });
        return revision;
      },
    },
  });
}

async function fixture(
  t: TestContext,
  setup: {
    foreignKey?: boolean;
    alternateKey?: boolean;
    collision?: boolean;
    metadata?: boolean;
    roleHome?: boolean;
    twoCommands?: boolean;
    pages?: PageDef[];
    components?: Record<string, { kind: string; href: string }>;
    history?: boolean;
    notify?: boolean | 'email';
    /** An item's notes are rich text whose @mentions of the tenant's members, and their teams, are told. */
    mentions?: boolean;
    /** An item's tags, through a link table, each row its tenant's. */
    tags?: boolean;
    /** A command that updates `item`, a table with no version column. */
    unversioned?: boolean;
    imports?: boolean;
    branding?: 'readable' | 'managed';
    /** Each tenant brands the App (`branding`), its viewers the editors; the store a Map. */
    tenantBranding?: boolean;
    activity?: boolean;
    files?: boolean;
    richText?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-http-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  let owner: HttpOwner | undefined;
  let enrollment: Awaited<ReturnType<typeof createTenantEnrollment<IncomingMessage>>> | undefined;
  t.after(async () => {
    try {
      if (owner) {
        const stopped = new Promise<void>((resolve) => owner!.server.close(() => resolve()));
        owner.server.closeAllConnections();
        await stopped;
        await owner.retire();
      }
      await enrollment?.retire();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE db_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, name TEXT NOT NULL ${setup.alternateKey ? 'UNIQUE' : ''}, UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_task(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_note(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, secret TEXT NOT NULL
      ${setup.foreignKey ? `, item_id TEXT NOT NULL REFERENCES db_item(${setup.alternateKey ? 'name' : 'id'})` : ''});
    INSERT INTO db_item VALUES ('north-item','north','same','North item'),('south-item','south','same','South item'),
      ('alias-item','North','same','PRIVATE_HTTP_TENANT_SENTINEL');
    INSERT INTO db_task VALUES ('north-task','north','same','North task',0),('south-task','south','same','South task',0);
    INSERT INTO db_note VALUES ('north-note','north','North note','PRIVATE_HTTP_TENANT_SENTINEL'${setup.foreignKey ? (setup.alternateKey ? ",'North item'" : ",'north-item'") : ''}),
      ('south-note','south','South note','PRIVATE_HTTP_TENANT_SENTINEL'${setup.foreignKey ? (setup.alternateKey ? ",'South item'" : ",'south-item'") : ''});`);
  // An item's attachments: the bytes in a BLOB, each row its tenant's.
  if (setup.files)
    db.exec(`CREATE TABLE db_attachment(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES db_item(id),
      file_name TEXT NOT NULL, content_type TEXT, data BLOB NOT NULL, sha256 TEXT);`);
  // Who is told when an item changes: Bob, in each tenant.
  if (setup.notify) db.exec(`ALTER TABLE db_item ADD COLUMN watcher TEXT; UPDATE db_item SET watcher = 'bob@example.invalid';`);
  /* Each tenant's own people and teams: Bob is a member of both, under a different row in each; a handle is
     found only among the record's own tenant's rows. */
  if (setup.mentions)
    db.exec(`ALTER TABLE db_item ADD COLUMN notes TEXT;
    CREATE TABLE db_member(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, account_id TEXT NOT NULL);
    INSERT INTO db_member VALUES ('n-bob','north','Bob','bob'),('n-alice','north','Alice','alice'),
      ('s-bob','south','Bob','bob'),('n-carol','north','Carol','carol');
    CREATE TABLE db_team(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO db_team VALUES ('n-desk','north','Desk'),('s-desk','south','Desk');
    CREATE TABLE db_team_member(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, team_id TEXT NOT NULL REFERENCES db_team(id),
      member_id TEXT NOT NULL REFERENCES db_member(id));
    INSERT INTO db_team_member VALUES ('n-1','north','n-desk','n-bob'),('n-2','north','n-desk','n-alice'),('s-1','south','s-desk','s-bob');`);
  if (setup.tags)
    db.exec(`CREATE TABLE db_tag(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_item_tag(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES db_item(id),
      tag_id TEXT NOT NULL REFERENCES db_tag(id));
    INSERT INTO db_tag VALUES ('n-vpn','north','vpn'),('s-vpn','south','vpn');
    INSERT INTO db_item_tag VALUES ('n-1','north','north-item','n-vpn'),('s-1','south','south-item','s-vpn');`);
  if (setup.collision)
    db.exec(`
    CREATE TABLE "child.ref"(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES db_item(id));
    CREATE TABLE db_child(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, ref_fk_0 TEXT NOT NULL REFERENCES db_item(id));
    INSERT INTO "child.ref" VALUES ('other-north','north','north-item');
    INSERT INTO db_child VALUES ('child-1','north','north-item'),('child-2','north','north-item'),('child-south','south','south-item');
  `);
  const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'private-store' };
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  if (setup.history) provisionSqliteRecordHistory(path);
  if (setup.notify || setup.mentions) provisionSqliteInbox(path);
  if (setup.tenantBranding) provisionSqliteBranding(path);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['operator'],
    validUntil: 10000,
    expectedVersion: null,
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const accountId of ['alice', 'bob'])
        await admin.putMembership({ ...grant, tenantId, accountId, membershipId: `${tenantId}-${accountId}` });
    }
  });
  // The metadata setup puts private text in every authored place a hidden
  // definition could leak from: a home dashboard's card, a display rule and
  // a view's label and query.
  const app = parseTestApp(
    {
      id: appId,
      name: 'Tenant HTTP fixture',
      ...(setup.branding
        ? {
            ui: {
              theme: fromRecord('task', {
                by: 'tenant',
                tenantField: setup.branding === 'managed' ? 'tenant_id' : 'business_id',
                fallback: { preset: 'sage' },
                fields: { name: 'name' },
              }),
            },
          }
        : {}),
      ...(setup.tenantBranding ? { branding: { allow: ['name', 'accent', 'logo'], editors: ['viewer'] } } : {}),
      auth: {
        rows: 'tenant',
        ...(setup.mentions ? { me: { from: 'member', column: 'account_id' } } : {}),
        roles: {
          operator: {
            read: true,
            write: ['item', ...(setup.files ? ['attachment'] : []), ...(setup.tags ? ['item_tag'] : [])],
            commands: [...(setup.twoCommands ? ['advance', 'hold'] : ['advance']), ...(setup.unversioned ? ['rename'] : [])],
          },
          viewer: { read: setup.metadata ? ['item'] : true },
        },
      },
      sources: { business: { connection: binding.source.connection } },
      resources: {
        item: {
          physical: 'db_item',
          owner: 'tenant',
          access: 'write',
          fields: {
            read: ['id', 'business_id', 'name', ...(setup.notify ? ['watcher'] : []), ...(setup.mentions ? ['notes'] : [])],
            write: ['id', 'business_id', 'name', ...(setup.mentions ? ['notes'] : [])],
          },
          ...(setup.mentions
            ? {
                display: {
                  notes: {
                    format: 'richText',
                    mentions: {
                      from: 'member',
                      by: 'id',
                      labelColumn: 'name',
                      groups: { from: 'team', by: 'id', labelColumn: 'name', through: 'team_member' },
                    },
                  },
                },
                notify: [{ on: { changes: 'notes' }, mentions: { in: 'notes' }, title: 'Mentioned on {name}' }],
              }
            : {}),
          ...(setup.notify
            ? {
                notify: [{ on: 'update', to: 'watcher', title: 'Renamed to {name}', ...(setup.notify === 'email' ? { email: true } : {}) }],
              }
            : {}),
          ...(setup.imports ? { import: {} } : {}),
          ...(setup.unversioned
            ? { actions: { rename: { label: 'Rename', command: { id: 'rename', version: 1, target: 'item', input: {} } } } }
            : {}),
          ...(setup.tags ? { tags: { through: 'item_tag', to: 'tag' } } : {}),
          ...(setup.metadata ? { display: { name: { tone: { '*': 'info' } } } } : {}),
          ...(setup.richText ? { display: { name: { format: 'richText' } } } : {}),
        },
        task: {
          physical: 'db_task',
          owner: 'tenant',
          access: 'write',
          fields: { read: ['id', 'business_id', 'name', 'version'], write: ['id', 'business_id', 'name', 'version'] },
          actions: {
            advance: { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: {} } },
            ...(setup.twoCommands ? { hold: { label: 'Hold', command: { id: 'hold', version: 1, target: 'task', input: {} } } } : {}),
          },
          // A command import: each row runs Advance on the record its business id finds, in the member's own tenant.
          ...(setup.imports
            ? { import: { command: { id: 'advance', version: 1, target: 'task', input: {} }, match: ['business_id'] } }
            : {}),
        },
        note: {
          physical: 'db_note',
          owner: 'tenant',
          fields: { read: ['id', 'name', ...(setup.foreignKey ? ['item_id'] : [])] },
          ...(setup.metadata ? { display: { secret: { tone: { [privateValue]: 'bad' } } } } : {}),
        },
        ...(setup.mentions
          ? {
              member: { physical: 'db_member', owner: 'tenant', fields: { read: ['id', 'name', 'account_id'] } },
              team: { physical: 'db_team', owner: 'tenant', fields: { read: ['id', 'name'] } },
              team_member: { physical: 'db_team_member', owner: 'tenant', fields: { read: ['id', 'team_id', 'member_id'] } },
            }
          : {}),
        ...(setup.tags
          ? {
              tag: { physical: 'db_tag', owner: 'tenant', fields: { read: ['id', 'name'] } },
              item_tag: {
                physical: 'db_item_tag',
                owner: 'tenant',
                access: 'write',
                fields: { read: ['id', 'item_id', 'tag_id'], write: ['id', 'item_id', 'tag_id'] },
              },
            }
          : {}),
        ...(setup.files
          ? {
              attachment: {
                physical: 'db_attachment',
                owner: 'tenant',
                access: 'write',
                fields: {
                  read: ['id', 'item_id', 'file_name', 'content_type', 'data'],
                  write: ['id', 'item_id', 'file_name', 'content_type', 'data'],
                },
                file: { content: 'data', name: 'file_name', type: 'content_type', hash: 'sha256', maxBytes: 4096 },
              },
            }
          : {}),
        ...(setup.collision
          ? {
              other: { physical: 'child.ref', owner: 'tenant', fields: { read: ['id', 'parent_id'] } },
              child: { physical: 'db_child', owner: 'tenant', fields: { read: ['id', 'ref_fk_0'] } },
            }
          : {}),
      },
      views: {
        /* The whole App's first list over items, served to viewers alone: a mailed operator's link is the item
           under the list they are served. */
        ...(setup.notify === 'email' ? { watch: { kind: 'list', from: 'item', roles: ['viewer'] } } : {}),
        item: { kind: 'list', from: 'item', ...(setup.tags ? { filters: ['tags'] } : {}) },
        task: { kind: 'list', from: 'task' },
        ...(setup.activity
          ? { feed: { kind: 'dashboard', label: 'Feed', sections: [{ kind: 'activity', title: 'Latest', resources: { item: {} } }] } }
          : {}),
        ...(setup.metadata
          ? {
              note: { kind: 'list', from: 'note', label: privateValue, query: `secret = ${privateValue}` },
              start: {
                kind: 'dashboard',
                label: 'Home',
                sections: [
                  { kind: 'metric', title: 'Items', from: 'item' },
                  { kind: 'metric', title: privateValue, from: 'note', query: `secret = ${privateValue}` },
                ],
              },
            }
          : {}),
      },
      home: setup.roleHome ? [{ view: 'task', roles: ['viewer'] }, { view: 'item' }] : setup.metadata ? 'start' : 'item',
      nav: [
        ...(setup.notify === 'email' ? ['watch'] : []),
        'item',
        'task',
        ...(setup.metadata ? ['note', 'start'] : []),
        ...(setup.activity ? ['feed'] : []),
      ],
    },
    'tenant HTTP fixture',
  );
  let time = 1000;
  const sessions: Record<string, VerifiedSessionInstance | null> = {
    alice: { identity: { id: 'alice', who: 'Alice', role: 'global-admin' }, sessionId: 'session-secret-alice-1', expiresAt: 20000 },
    bob: {
      identity: { id: 'bob', who: setup.notify || setup.mentions ? 'bob@example.invalid' : 'Bob' },
      sessionId: 'session-secret-bob-1',
      expiresAt: 20000,
    },
  };
  const cookie = (req: IncomingMessage) => req.headers.cookie?.replace(/^fixture=/, '') ?? '';
  const control = {
    proofs: 0,
    verifies: 0,
    commands: 0,
    proof: undefined as ((req: IncomingMessage) => VerifiedSessionInstance | null | Promise<VerifiedSessionInstance | null>) | undefined,
    verify: undefined as ((req: IncomingMessage) => void | Promise<void>) | undefined,
    read: undefined as ((tenant: string) => void | Promise<void>) | undefined,
    commandAfter: undefined as (() => void | Promise<void>) | undefined,
    httpClock: undefined as (() => void) | undefined,
  };
  const rowScope: RowScope = {
    item: true,
    task: true,
    note: { groups: [[{ column: 'secret', op: '=', value: privateValue }]] },
    ...(setup.files ? { attachment: true } : {}),
    ...(setup.mentions ? { member: true, team: true, team_member: true } : {}),
    ...(setup.tags ? { tag: true, item_tag: true } : {}),
    ...(setup.collision ? { other: true, child: true } : {}),
  };
  /* A second verb on the same record, for the batch a record with two command
     actions asks: its visibility is answered beside Advance's, in one request. */
  const hold = defineCommand({
    source: 'business',
    target: 'task',
    input: {},
    // Matched by no seeded task, so a batch that reads it reads this `when` and
    // not Advance's: two checks, two answers, one transaction.
    when: 'name = "no task is named this"',
    output: { parse: (value: unknown) => ({ taskId: String(object(value).taskId) }) },
    async handle({ db, record }) {
      control.commands++;
      await db.task.update(record, { version: Number(record.version) + 1 });
      return { taskId: String(record.id) };
    },
  });
  /* Renames an item: a table with no version column, so its write has no version to check or return. */
  const rename = defineCommand({
    source: 'business',
    target: 'item',
    input: {},
    output: { parse: (value: unknown) => ({ itemId: String(object(value).itemId) }) },
    async handle({ db, record }) {
      control.commands++;
      await db.item.update(record, { name: `${String(record.name)} (renamed)` });
      return { itemId: String(record.id) };
    },
  });
  const registry = defineCommands({
    ...(setup.twoCommands ? { hold } : {}),
    ...(setup.unversioned ? { rename } : {}),
    advance: defineCommand({
      source: 'business',
      target: 'task',
      input: {},
      output: {
        parse(value: unknown) {
          const data = object(value);
          assert.equal(typeof data.taskId, 'string');
          assert.equal(typeof data.version, 'number');
          return { taskId: data.taskId as string, version: data.version as number };
        },
      },
      async handle({ db, record }) {
        control.commands++;
        const { version } = await db.task.update(record, { version: Number(record.version) + 1 });
        await control.commandAfter?.();
        return { taskId: String(record.id), version: Number(version) };
      },
    }),
  });
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId,
    storeId: binding.storeId,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      task: { kind: 'tenant', column: 'tenant_id' },
      note: { kind: 'tenant', column: 'tenant_id' },
      ...(setup.files ? { attachment: { kind: 'tenant' as const, column: 'tenant_id' } } : {}),
      ...(setup.collision
        ? { other: { kind: 'tenant' as const, column: 'tenant_id' }, child: { kind: 'tenant' as const, column: 'tenant_id' } }
        : {}),
      ...(setup.tags
        ? Object.fromEntries(['tag', 'item_tag'].map((name) => [name, { kind: 'tenant' as const, column: 'tenant_id' }]))
        : {}),
      ...(setup.mentions
        ? Object.fromEntries(['member', 'team', 'team_member'].map((name) => [name, { kind: 'tenant' as const, column: 'tenant_id' }]))
        : {}),
    },
    resolveMembershipRows: () => rowScope,
    resolveRows: async (principal) => {
      await control.read?.(principal.tenantId);
      return rowScope;
    },
    authorizeDeletedRecord: () => true,
    resultReferences: {
      advance: (result) => {
        const value = object(result);
        assert.equal(typeof value.taskId, 'string');
        return [{ table: 'task', key: { id: value.taskId as string } }];
      },
      ...(setup.twoCommands ? { hold: (result: unknown) => [{ table: 'task', key: { id: String(object(result).taskId) } }] } : {}),
      ...(setup.unversioned ? { rename: (result: unknown) => [{ table: 'item', key: { id: String(object(result).itemId) } }] } : {}),
    },
  });
  enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: setup.pages,
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'http-deployment',
    roles: ['operator', 'viewer'],
    maxLifetimeMs: 300000,
    now: () => {
      control.httpClock?.();
      return time;
    },
    commands: { registry },
    /* The sign-in store's addresses. Carol has an account, and no membership of north, where a row names her. */
    accountEmail: async (id) =>
      ({ alice: 'alice@example.invalid', bob: 'bob@example.invalid', carol: 'carol@example.invalid' })[id] ?? null,
    // The host's own verifier shape: a request the server made for someone (tenantApiRequest.ts) answers for itself.
    verifySession: withTenantApiRequests<IncomingMessage>(async (req) => {
      control.verifies++;
      await control.verify?.(req);
      return sessions[cookie(req)]?.identity ?? null;
    }),
  });
  const bound = { host: '127.0.0.1', port: 0 };
  const options = {
    app,
    enrollment,
    bound,
    ...(setup.components ? { components: setup.components } : {}),
    ...(setup.tenantBranding ? { branding: memoryBranding(app) } : {}),
    verifySessionInstance: (req: IncomingMessage) => {
      control.proofs++;
      return control.proof ? control.proof(req) : (sessions[cookie(req)] ?? null);
    },
  };
  owner = createTenantHttpServer(options);
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const call = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method = body === undefined ? 'GET' : 'POST',
  ): Promise<Answer> => {
    const response = await fetch(base + path, {
      method,
      headers: { cookie: 'fixture=alice', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: object(JSON.parse(text)) };
  };
  const raw = (path: string, body: string, headers: Record<string, string | string[]> = {}, method = 'POST'): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: bound.host,
          port: bound.port,
          path,
          method,
          headers: { cookie: 'fixture=alice', 'content-type': 'application/json', ...headers },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => {
            try {
              const returned = new Headers();
              for (const [key, value] of Object.entries(response.headers)) {
                if (value !== undefined) returned.set(key, Array.isArray(value) ? value.join(', ') : value);
              }
              resolve({ status: response.statusCode!, headers: returned, text, body: object(JSON.parse(text)) });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.setTimeout(10000, () => outgoing.destroy(new Error('HTTP fixture timeout')));
      outgoing.end(body);
    });
  const select = (path: string, tenant = 'north') => `${path}?app=${appId}&tenant=${tenant}`;
  const headers = (value: Context) => ({
    'x-mistri-tab': value.tabId,
    'x-mistri-context': value.context,
    'x-mistri-lease-revision': String(value.revision),
    'x-mistri-account': value.accountId,
  });
  const open = async (tenant = 'north', cookie = 'alice') =>
    context(await call(select('/api/tenant/context/open', tenant), {}, { cookie: `fixture=${cookie}` }));
  const data = (path: string, value: Context, body?: unknown) => call(select(path, value.tenantId), body, headers(value));
  const row = (tenant = 'north') => object(db.prepare('SELECT * FROM db_item WHERE id=?').get(`${tenant}-item`));
  const version = (tenant = 'north') => db.prepare('SELECT version FROM db_task WHERE id=?').get(`${tenant}-task`)!.version;
  const counts = () =>
    [COMMAND_JOURNAL_TABLES.receipt, sqliteAuditRows].map(
      (table) => db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()!.n,
    );
  const command = (tenant = 'north') => ({
    command: 'advance',
    commandVersion: 1,
    key: { id: `${tenant}-task` },
    expectedVersion: 0,
    idempotencyKey: 'http-context-attempt-0001',
    input: {},
  });
  return {
    owner,
    enrollment,
    app,
    options,
    db,
    call,
    raw,
    open,
    data,
    select,
    headers,
    base,
    control,
    sessions,
    row,
    version,
    counts,
    command,
    maintenance,
    grant,
    setTime: (value: number) => {
      time = value;
    },
  };
}

test('bootstrap discloses only own membership suggestions and open attests the verified context without a service wrapper', async (t) => {
  const f = await fixture(t),
    bootstrap = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(bootstrap.status, 200);
  noPrivate(bootstrap);
  assert.deepEqual(bootstrap.body, {
    status: 'ready',
    appId,
    accountId: 'alice',
    memberships: [{ tenantId: 'north' }, { tenantId: 'south' }],
  });
  for (const key of ['tenant', 'tab', 'context', 'lease-revision']) assert.equal(bootstrap.headers.get(`x-mistri-${key}`), null);
  const opened = await f.call(f.select('/api/tenant/context/open'), {}),
    a = context(opened);
  owned(opened, a);
  assert.deepEqual(Object.keys(opened.body).sort(), ['accountId', 'appId', 'context', 'expiresAt', 'revision', 'tabId', 'tenantId']);
  assert.equal(a.revision, 1);
  const query = await f.data('/api/query', a, { table: 'item' });
  owned(query, a);
  assert.deepEqual(rows(query), [{ id: 'north-item', business_id: 'same', name: 'North item' }]);
  const count = await f.data('/api/count', a, { table: 'item', exactCount: false });
  owned(count, a);
  assert.equal(count.body.count, 1);
  assert.equal(count.body.exact, true);
});

test("a bounded count passes the tenant allowlist, stays the tenant's own, and says capped past its bound", async (t) => {
  const f = await fixture(t),
    a = await f.open();
  // North now has two items of the table's three; south's stays out of every count.
  f.db.prepare(`INSERT INTO db_item VALUES ('north-item-2','north','other','North item two')`).run();
  const within = await f.data('/api/count', a, { table: 'item', countLimit: 2 });
  owned(within, a);
  assert.deepEqual(within.body, { count: 2, exact: true });
  const capped = await f.data('/api/count', a, { table: 'item', countLimit: 1 });
  owned(capped, a);
  assert.deepEqual(capped.body, { count: 1, exact: true, capped: true });
  const run = await f.data('/api/run', a, { q: 'item', limit: 1, countLimit: 1 });
  owned(run, a);
  assert.deepEqual([run.body.total, run.body.exactTotal, run.body.cappedTotal], [1, true, true]);
});

test('HTTP captures the expected account before a verifier can mutate the request headers', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  f.control.proof = (req) => {
    const index = req.rawHeaders.findIndex((value) => value.toLowerCase() === 'x-mistri-account');
    if (index >= 0) req.rawHeaders[index + 1] = 'alice';
    req.headers['x-mistri-account'] = 'alice';
    return f.sessions.alice;
  };
  const reply = await f.call(
    f.select('/api/update'),
    { table: 'item', key: { id: 'north-item' }, values: { name: 'BAD' } },
    { ...f.headers(a), 'x-mistri-account': 'bob' },
  );
  denied(reply);
  assert.equal(reply.body.outcome, 'rejected');
  assert.equal(f.row().name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
});

test('a later host-binding accessor is refused without execution or authentication', async (t) => {
  const f = await fixture(t);
  let traps = 0;
  const before = f.control.proofs;
  Object.defineProperty(f.options.bound, 'allowedHosts', {
    configurable: true,
    enumerable: true,
    get() {
      traps++;
      throw new Error(privateValue);
    },
  });
  try {
    denied(await f.call(`/api/tenant/bootstrap?app=${appId}`));
    assert.equal(traps, 0);
    assert.equal(f.control.proofs, before);
  } finally {
    Reflect.deleteProperty(f.options.bound, 'allowedHosts');
  }
  const a = await f.open();
  owned(await f.data('/api/query', a, { table: 'item' }), a);
});

test('schema and server-policy filtered rows hide owner/secret fields, global estimates and compiler diagnostics', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const schema = await f.data('/api/schema', a);
  owned(schema, a);
  assert.doesNotMatch(schema.text, /approxRows|tenant_id|secret/);
  const notes = await f.data('/api/query', a, { table: 'note' });
  owned(notes, a);
  assert.deepEqual(rows(notes), [{ id: 'north-note', name: 'North note' }]);
  denied(await f.data('/api/query', a, { table: 'note', columns: ['secret'] }));
  denied(await f.data('/api/query', a, { table: 'item', filter: { groups: [[{ column: 'tenant_id', op: '=', value: 'south' }]] } }));
});

for (const input of [
  { path: '/api/run', body: { q: 'item show name', limit: 1 } },
  { path: '/api/view/run', body: { view: { base: 'item', columns: ['name'] }, limit: 1 } },
  { path: '/api/breakdown', body: { text: 'item count by business_id' } },
]) {
  test(`${input.path} uses the tenant read facade and App projection`, async (t) => {
    const f = await fixture(t),
      a = await f.open(),
      result = await f.data(input.path, a, input.body);
    owned(result, a);
    assert.equal(rows(result).length, 1);
    assert.doesNotMatch(result.text, /South item/);
    if (input.path !== '/api/breakdown') assert.deepEqual(Object.values(rows(result)[0]), ['North item']);
  });
}

/* A dashboard's cards in one request on a tenant lease (tenantHttp.ts): each
   item answered as /api/breakdown answers it alone, in the tenant's rows only. */
test("/api/breakdowns answers each card in the tenant's own rows, and a failing card alone", async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const batch = await f.data('/api/breakdowns', a, {
    items: [{ text: 'item count by business_id' }, { text: 'item count' }, { text: 'item count by nowhere' }],
  });
  owned(batch, a);
  const [grouped, total, broken] = (batch.body as { results: Array<{ status: number; body: { rows?: unknown[]; errors?: unknown[] } }> })
    .results;
  const alone = await f.data('/api/breakdown', a, { text: 'item count by business_id' });
  assert.deepEqual(grouped.body.rows, rows(alone));
  assert.deepEqual(Object.values((total.body.rows as Array<Record<string, unknown>>)[0]).map(Number), [1]);
  assert.ok(broken.body.errors?.length);
  assert.doesNotMatch(batch.text, /South item|south/);
});

/* A tags filter, as the rail asks it (G61): the list and its facet counts read `tags has` in the tenant's own rows,
   and a question the catalog cannot answer refuses that one read, never the tenant context. */
test("a tags filter reads in the tenant's rows on the list and its rail counts; a bad question refuses only itself", async (t) => {
  const f = await fixture(t, { tags: true }),
    a = await f.open();
  const list = await f.data('/api/run', a, { q: 'item show name where tags has vpn', limit: 10 });
  owned(list, a);
  assert.deepEqual(
    rows(list).map((row) => row.name),
    ['North item'],
  );
  const counts = await f.data('/api/breakdowns', a, {
    items: [{ text: 'item where tags has vpn count by business_id' }, { text: 'item where tags has vpn count' }],
  });
  owned(counts, a);
  const [grouped, total] = (counts.body as { results: Array<{ status: number; body: { rows?: Array<Record<string, unknown>> } }> }).results;
  assert.equal(grouped.status, 200, JSON.stringify(grouped.body));
  assert.deepEqual(Object.values(total.body.rows![0]).map(Number), [1]);
  const alone = await f.data('/api/breakdown', a, { text: 'item where tags has vpn count' });
  owned(alone, a);
  // A column the reader's catalog has not is the request's fault: answered as such, and the lease still reads.
  for (const [path, body] of [
    ['/api/breakdown', { text: 'task where tags has vpn count' }],
    ['/api/run', { q: 'task where nowhere = 1', limit: 1 }],
    // Past the parser: a sort on nothing the breakdown shows fails in the compiler.
    [
      '/api/breakdowns',
      {
        items: [
          { def: { base: 'task', by: [{ path: 'name' }], measures: [{ fn: 'count' }], orderBy: [{ name: 'nowhere', direction: 'asc' }] } },
        ],
      },
    ],
  ] as const) {
    const bad = await f.data(path, a, body);
    assert.notEqual(bad.status, 403, bad.text);
    assert.doesNotMatch(bad.text, /tenant_context_unavailable/);
  }
  owned(await f.data('/api/run', a, { q: 'item show name', limit: 1 }), a);
});

/* A command that updates a table with no version column (a desk's notice rules, say): applied, in the
   tenant's own row, and the session stands. It answered 503 "transaction did not complete" and signed the
   person out. */
test('a command updates a table with no version column, in the tenant, and the session stands', async (t) => {
  const f = await fixture(t, { unversioned: true }),
    a = await f.open();
  // Prepared as a form asks it: the record's revision is its row's digest, with no column to read it from.
  const prepared = await f.data('/api/commands/prepare', a, { command: 'rename', commandVersion: 1, key: { id: 'north-item' } });
  assert.equal(prepared.status, 200, prepared.text);
  const expectedVersion = (prepared.body as { expectedVersion?: number }).expectedVersion;
  assert.equal(typeof expectedVersion, 'number', prepared.text);
  const ran = await f.data('/api/commands/execute', a, {
    command: 'rename',
    commandVersion: 1,
    key: { id: 'north-item' },
    expectedVersion,
    idempotencyKey: 'http-unversioned-rename-0001',
    input: {},
  });
  assert.equal(ran.status, 200, ran.text);
  assert.equal(ran.body.status, 'applied', ran.text);
  assert.deepEqual(
    f.db
      .prepare('SELECT id, name FROM db_item ORDER BY id')
      .all()
      .map((row) => [row.id, row.name]),
    [
      ['alias-item', 'PRIVATE_HTTP_TENANT_SENTINEL'],
      ['north-item', 'North item (renamed)'],
      ['south-item', 'South item'],
    ],
  );
  owned(await f.data('/api/run', a, { q: 'item show name', limit: 1 }), a);
});

/* The tags picker (G58) writes link rows by generic write: a tag put on and taken off in the tenant's own rows. */
test("a tenant's tags picker puts a tag on a record and takes it off, in the tenant's rows only", async (t) => {
  const f = await fixture(t, { tags: true }),
    a = await f.open();
  const links = () =>
    f.db
      .prepare('SELECT id, tenant_id, item_id, tag_id FROM db_item_tag ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  const put = await f.data('/api/insert', a, { table: 'item_tag', values: { id: 'n-2', item_id: 'north-item', tag_id: 'n-vpn' } });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(
    links().find((row) => row.id === 'n-2'),
    { id: 'n-2', tenant_id: 'north', item_id: 'north-item', tag_id: 'n-vpn' },
  );
  const off = await f.data('/api/delete', a, { table: 'item_tag', key: { id: 'n-2' }, confirm: true });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.deleted, true, off.text);
  assert.equal(
    links().some((row) => row.id === 'n-2'),
    false,
  );
  // Another tenant's link is not this tenant's to take off.
  const theirs = await f.data('/api/delete', a, { table: 'item_tag', key: { id: 's-1' }, confirm: true });
  assert.notEqual(theirs.body.deleted, true, theirs.text);
  assert.equal(
    links().some((row) => row.id === 's-1'),
    true,
  );
  owned(await f.data('/api/run', a, { q: 'item show name', limit: 1 }), a);
});

test('same account in two tenant contexts gets separate rows and command receipts for the same idempotency key', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    b = await f.open('south');
  const first = await f.data('/api/commands/execute', a, f.command());
  owned(first, a);
  assert.equal(first.body.status, 'applied');
  const second = await f.data('/api/commands/execute', b, f.command('south'));
  owned(second, b);
  assert.equal(second.body.status, 'applied');
  assert.notEqual(first.body.receiptId, second.body.receiptId);
  assert.deepEqual(f.counts(), [2, 2]);
  assert.equal(f.version(), 1);
  assert.equal(f.version('south'), 1);
  const status = await f.data('/api/commands/status', a, f.command());
  owned(status, a);
  assert.equal(status.body.replayed, true);
  assert.equal(f.control.commands, 2);
  const bRows = await f.data('/api/query', b, { table: 'item' });
  owned(bRows, b);
  assert.deepEqual(
    rows(bRows).map((row) => row.id),
    ['south-item'],
  );
});

test('switch rejects old-context data without authority headers; recovery returns only the settled selected context', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    other = await f.open();
  const switched = await f.call(f.select('/api/tenant/context/switch', 'south'), assertion(a));
  const b = context(switched);
  owned(switched, b);
  assert.equal(b.tabId, a.tabId);
  assert.notEqual(b.context, a.context);
  denied(await f.data('/api/query', a, { table: 'item' }));
  denied(await f.call(f.select('/api/query'), { table: 'item' }, f.headers(b)));
  const recovered = await f.call(`/api/tenant/context/recover?app=${appId}`, { tabId: a.tabId });
  owned(recovered, b);
  assert.deepEqual(recovered.body, switched.body);
  owned(await f.data('/api/query', other, { table: 'item' }), other);
});

for (const suffix of [
  '',
  '?tenant=north',
  `?app=${appId}&app=${appId}&tenant=north`,
  `?app=${appId}&tenant=north&tenant=north`,
  `?app=${appId}&tenant=north&tenant=south`,
  `?app=other&tenant=north`,
  `?app=${appId}&tenant=north&conn=business-db`,
  `?app=${appId}&tenant=north&tenantId=south`,
  `?app=${appId}&tenant=north&source=business`,
  `?app=${appId}&tenant=north&appId=${appId}`,
]) {
  test(`query refuses noncanonical selectors ${suffix || '(none)'} without falling through to a connection`, async (t) => {
    const f = await fixture(t),
      a = await f.open();
    denied(await f.call('/api/query' + suffix, { table: 'item' }, f.headers(a)));
    assert.equal(f.row().name, 'North item');
    assert.equal(f.row('south').name, 'South item');
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const path of [
  '/',
  '/api/auth/profile',
  '/api/whoami',
  '/api/connections',
  '/api/ddl',
  '/api/sql',
  '/api/pages/saved',
  '/api/pages/relations',
  '/api/records',
  '/api/view/explain',
  '/api/commands',
  '/api/insert-graph',
  '/api/delete-graph',
  '/api/mcp',
  '/api/tenant/context/unknown',
  '/api/filters',
  '/api/filters/save',
]) {
  test(`${path} is unavailable rather than dispatched to an ordinary resource or management server`, async (t) => {
    const f = await fixture(t),
      a = await f.open();
    denied(await f.data(path, a, { table: 'item' }));
    assert.equal(f.control.commands, 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const extra of [
  { tenant: 'north' },
  { tenantId: 'north' },
  { app: appId },
  { conn: 'business-db' },
  { source: 'business' },
  { principal: { accountId: 'alice', roles: ['operator'] } },
  { tabId: 'from-body', expectedContext: 'from-body' },
  { scope: { item: true } },
]) {
  test(`query refuses body routing/authority fields ${Object.keys(extra).join(',')}`, async (t) => {
    const f = await fixture(t),
      a = await f.open();
    denied(await f.data('/api/query', a, { table: 'item', ...extra }));
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const bad of [
  'missing tab',
  'missing context',
  'missing revision',
  'forged tab',
  'forged context',
  'wrong account',
  'duplicate tab',
  'duplicate context',
  'duplicate account',
  'duplicate revision',
]) {
  test(`expected ownership ${bad} refuses with no response authority`, async (t) => {
    const f = await fixture(t),
      a = await f.open(),
      headers: Record<string, string | string[]> = f.headers(a);
    if (bad === 'missing tab') delete headers['x-mistri-tab'];
    if (bad === 'missing context') delete headers['x-mistri-context'];
    if (bad === 'missing revision') delete headers['x-mistri-lease-revision'];
    if (bad === 'forged tab') headers['x-mistri-tab'] = '5bc37ab9-526c-4f52-90cc-1c9894fd26c7';
    if (bad === 'forged context') headers['x-mistri-context'] = '5bc37ab9-526c-4f52-90cc-1c9894fd26c7';
    if (bad === 'wrong account') headers['x-mistri-account'] = 'bob';
    if (bad === 'duplicate tab') headers['x-mistri-tab'] = [a.tabId, a.tabId];
    if (bad === 'duplicate context') headers['x-mistri-context'] = [a.context, a.context];
    if (bad === 'duplicate account') headers['x-mistri-account'] = ['alice', 'alice'];
    if (bad === 'duplicate revision') headers['x-mistri-lease-revision'] = [String(a.revision), String(a.revision)];
    denied(await f.raw(f.select('/api/query'), '{"table":"item"}', headers));
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('optional account precondition never supplies identity: absence works, another verified account cannot reuse tokens', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const headers = { 'x-mistri-tab': a.tabId, 'x-mistri-context': a.context, 'x-mistri-lease-revision': String(a.revision) };
  owned(await f.call(f.select('/api/query'), { table: 'item' }, headers), a);
  denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...headers, cookie: 'fixture=bob' }));
  denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), cookie: 'fixture=unknown' }));
  assert.deepEqual(f.counts(), [0, 0]);
});

test('HTTP renewal returns exact ownership and a replayable receipt; delayed old data requests report lease staleness', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  f.setTime(1500);
  const reply = await f.call(f.select('/api/tenant/context/renew'), assertion(a)),
    b = context(reply);
  owned(reply, b);
  assert.equal(b.revision, 2);
  assert.deepEqual({ ...b, revision: a.revision, expiresAt: a.expiresAt }, a);
  f.setTime(1600);
  const duplicate = await f.call(f.select('/api/tenant/context/renew'), assertion(a));
  owned(duplicate, b);
  assert.deepEqual(duplicate.body, reply.body);
  const stale = await f.data('/api/query', a, { table: 'item' });
  denied(stale);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'tenant_lease_stale');
  const staleWrite = await f.data('/api/update', a, { table: 'item', key: { id: 'north-item' }, values: { name: 'Stale' } });
  denied(staleWrite);
  assert.equal(staleWrite.status, 409);
  assert.equal(staleWrite.body.code, 'tenant_lease_stale');
  assert.equal(staleWrite.body.outcome, 'not_applied');
  for (const route of ['/api/commands/execute', '/api/commands/status']) {
    const refused = await f.data(route, a, f.command());
    denied(refused);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'tenant_lease_stale');
    assert.equal(refused.body.outcome, 'unknown');
  }
  owned(await f.data('/api/query', b, { table: 'item' }), b);
  const switched = await f.call(f.select('/api/tenant/context/switch', 'south'), assertion(b)),
    c = context(switched);
  owned(switched, c);
  assert.equal(c.revision, 1);
  assert.notEqual(c.context, b.context);
  denied(await f.call(f.select('/api/tenant/context/renew'), assertion(a)));
  denied(await f.call(f.select('/api/tenant/context/renew'), assertion(b)));
  owned(await f.data('/api/query', c, { table: 'item' }), c);
  assert.equal(f.row().name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
});

for (const revision of ['', '0', '-1', '1.5', '01', '+1', '1e0', '9007199254740992', 'NaN', 'Infinity']) {
  test(`HTTP data rejects noncanonical lease revision ${JSON.stringify(revision)} before session verification`, async (t) => {
    const f = await fixture(t),
      a = await f.open(),
      before = f.control.proofs;
    denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), 'x-mistri-lease-revision': revision }));
    assert.equal(f.control.proofs, before);
  });
}

for (const route of ['open', 'recover', 'switch', 'renew']) {
  test(`HTTP ${route} control rejects lease, tab, and context headers independently`, async (t) => {
    const f = await fixture(t),
      a = await f.open();
    const path = route === 'recover' ? `/api/tenant/context/recover?app=${appId}` : f.select(`/api/tenant/context/${route}`);
    const body = route === 'open' ? {} : route === 'recover' ? { tabId: a.tabId } : assertion(a);
    for (const [header, value] of Object.entries({
      'x-mistri-lease-revision': '1',
      'x-mistri-tab': a.tabId,
      'x-mistri-context': a.context,
    })) {
      const before = f.control.proofs;
      denied(await f.call(path, body, { [header]: value }));
      assert.equal(f.control.proofs, before);
    }
    owned(await f.data('/api/query', a, { table: 'item' }), a);
  });
}

test('HTTP renewal validates method, selectors and required revision without granting authority', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    path = f.select('/api/tenant/context/renew');
  denied(await f.call(path));
  for (const body of [
    { tabId: a.tabId, expectedContext: a.context },
    { ...assertion(a), expectedRevision: '1' },
    { ...assertion(a), expectedRevision: 0 },
    { ...assertion(a), expiresAt: 999999 },
    { ...assertion(a), tenantId: 'north' },
  ]) {
    denied(await f.call(path, body));
  }
  for (const suffix of [
    '',
    `?app=${appId}`,
    `?app=${appId}&tenant=north&tenant=north`,
    `?app=other&tenant=north`,
    `?app=${appId}&tenant=north&source=business`,
  ]) {
    denied(await f.call('/api/tenant/context/renew' + suffix, assertion(a)));
  }
  denied(await f.call(f.select('/api/tenant/context/renew', 'south'), assertion(a)));
  denied(await f.call(path, assertion(a), { cookie: 'fixture=bob' }));
  owned(await f.data('/api/query', a, { table: 'item' }), a);
});

test('HTTP renewal while a real command is pending preserves its captured response revision and receipt', { timeout: 15000 }, async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    entered = gate(),
    release = gate();
  f.control.commandAfter = async () => {
    entered.release();
    await release.promise;
  };
  const executing = f.data('/api/commands/execute', a, f.command());
  try {
    await entered.promise;
    f.setTime(1500);
    const renewed = await f.call(f.select('/api/tenant/context/renew'), assertion(a)),
      b = context(renewed);
    owned(renewed, b);
    release.release();
    const executed = await executing;
    owned(executed, a);
    assert.equal(executed.body.status, 'applied');
    const status = await f.data('/api/commands/status', b, f.command());
    owned(status, b);
    assert.equal(status.body.replayed, true);
    assert.equal(f.control.commands, 1);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.counts(), [1, 1]);
  } finally {
    release.release();
    await Promise.allSettled([executing]);
  }
});

test('HTTP expired renewal receipt is metadata only; recovery stays inactive until explicit next-revision renewal', async (t) => {
  const f = await fixture(t);
  f.sessions.alice = { ...f.sessions.alice!, expiresAt: 1000000 };
  await f.maintenance(async (admin) => {
    await admin.putMembership({ ...f.grant, validUntil: 1000000, expectedVersion: '1' });
  });
  const a = await f.open();
  f.setTime(1500);
  const first = await f.call(f.select('/api/tenant/context/renew'), assertion(a)),
    b = context(first);
  assert.equal(b.expiresAt, 301500);
  f.setTime(b.expiresAt);
  const recovered = await f.call(`/api/tenant/context/recover?app=${appId}`, { tabId: a.tabId });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, { tabId: a.tabId, status: 'inactive' });
  for (const name of ownerHeaders) assert.equal(recovered.headers.get(name), null);
  const duplicate = await f.call(f.select('/api/tenant/context/renew'), assertion(a));
  owned(duplicate, b);
  assert.deepEqual(duplicate.body, first.body);
  const expired = await f.data('/api/query', b, { table: 'item' });
  denied(expired);
  assert.equal(expired.status, 409);
  assert.equal(expired.body.code, 'tenant_lease_expired');
  const refused = await f.data('/api/update', b, { table: 'item', key: { id: 'north-item' }, values: { name: 'Expired' } });
  denied(refused);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'tenant_lease_expired');
  assert.equal(refused.body.outcome, 'not_applied');
  assert.equal(f.row().name, 'North item');
  const resumed = await f.call(f.select('/api/tenant/context/renew'), assertion(b)),
    c = context(resumed);
  owned(resumed, c);
  assert.equal(c.revision, 3);
  assert.equal(c.context, a.context);
  assert.equal(c.expiresAt, 601500);
  owned(await f.data('/api/query', c, { table: 'item' }), c);
});

for (const route of ['/api/tenant/bootstrap', '/api/tenant/context/recover']) {
  test(`${route} rejects tenant selectors and duplicated App selectors`, async (t) => {
    const f = await fixture(t),
      a = await f.open(),
      body = route.endsWith('recover') ? { tabId: a.tabId } : undefined;
    denied(await f.call(`${route}?app=${appId}&tenant=north`, body));
    denied(await f.call(`${route}?app=${appId}&app=${appId}`, body));
    denied(await f.call(route, body));
  });
}

test('host and cross-origin defenses run before verification, including schema reads and context mutations', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    proofs = f.control.proofs,
    verifies = f.control.verifies;
  denied(await f.raw(f.select('/api/schema'), '', { ...f.headers(a), host: 'attacker.invalid' }, 'GET'));
  denied(
    await f.raw(f.select('/api/update'), '{"table":"item","key":{"id":"north-item"},"values":{"name":"BAD"}}', {
      ...f.headers(a),
      origin: 'https://attacker.invalid',
    }),
  );
  denied(await f.raw(f.select('/api/tenant/context/open'), '{}', { origin: 'https://attacker.invalid' }));
  denied(await f.raw(f.select('/api/update'), '{}', { ...f.headers(a), 'content-type': 'text/plain' }));
  assert.equal(f.control.proofs, proofs);
  assert.equal(f.control.verifies, verifies);
  assert.equal(f.row().name, 'North item');
});

for (const path of [
  `/api/query?app=${appId}&tenant=north#fragment`,
  `/api/../api/query?app=${appId}&tenant=north`,
  `http://127.0.0.1/api/query?app=${appId}&tenant=north`,
  `/api/%71uery?app=${appId}&tenant=north`,
]) {
  test(`raw HTTP path alias refuses ${path}`, async (t) => {
    const f = await fixture(t),
      a = await f.open();
    denied(await f.raw(path, '{"table":"item"}', f.headers(a)));
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const filter of [{}, { groups: [{}] }, { groups: '' }, { groups: [[{ column: 'id', op: {}, value: 'north-item' }]] }]) {
  test(`malformed filter cannot silently remove WHERE: ${JSON.stringify(filter)}`, async (t) => {
    const f = await fixture(t),
      a = await f.open();
    denied(await f.data('/api/query', a, { table: 'item', filter }));
    denied(await f.data('/api/count', a, { table: 'item', filter, exactCount: false }));
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('a hostile readable OR still intersects mandatory tenant scope; hidden tables and physical names never fall through', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const reply = await f.data('/api/query', a, {
    table: 'item',
    filter: { groups: [[{ column: 'id', op: '=', value: 'south-item' }], [{ column: 'id', op: '!=', value: 'south-item' }]] },
  });
  owned(reply, a);
  assert.deepEqual(
    rows(reply).map((row) => row.id),
    ['north-item'],
  );
  for (const table of ['db_item', 'business.item', '__mistri_tenants', 'missing']) denied(await f.data('/api/query', a, { table }));
});

test('invalid raw JSON and oversized bodies refuse without operation effects or private error diagnostics', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  denied(await f.raw(f.select('/api/update'), '{', f.headers(a)));
  denied(
    await f.raw(
      f.select('/api/update'),
      JSON.stringify({ table: 'item', key: { id: 'north-item' }, values: { name: 'x'.repeat(300000) } }),
      f.headers(a),
    ),
  );
  assert.equal(f.row().name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
});

test('HTTP switch drains a paused old read and never echoes its retired ownership or private rows', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    entered = gate(),
    release = gate();
  let held = false,
    switched = false;
  f.control.read = async (tenant) => {
    if (tenant === 'north' && !held) {
      held = true;
      entered.release();
      await release.promise;
    }
  };
  const reading = f.data('/api/query', a, { table: 'item' });
  await entered.promise;
  const switching = f.call(f.select('/api/tenant/context/switch', 'south'), assertion(a));
  void switching.then(
    () => {
      switched = true;
    },
    () => {},
  );
  try {
    // Observe the CAS through its public admission boundary; a fetch being
    // scheduled does not mean its server-side candidate verification finished.
    let stopped: Answer | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = await f.data('/api/query', a, { table: 'item', columns: ['id'] });
      if (probe.status >= 400) {
        stopped = probe;
        break;
      }
    }
    assert.ok(stopped, 'switch must stop old-context admission before its paused read settles');
    denied(stopped);
    assert.equal(switched, false);
    release.release();
    denied(await reading);
    const result = await switching,
      b = context(result);
    owned(result, b);
    assert.equal(b.tenantId, 'south');
  } finally {
    release.release();
    await Promise.allSettled([reading, switching]);
  }
});

test('same-account new session during a live HTTP command rolls back instead of acknowledging a late success', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    entered = gate(),
    release = gate();
  f.control.commandAfter = async () => {
    entered.release();
    await release.promise;
  };
  const executing = f.data('/api/commands/execute', a, f.command());
  try {
    await entered.promise;
    f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    release.release();
    const result = await executing;
    denied(result);
    assert.equal(result.body.outcome, 'not_applied');
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    release.release();
    await Promise.allSettled([executing]);
  }
});

test('generic HTTP insert/update project ordinary values, inject ownership privately and cannot write command-owned tasks', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const inserted = await f.data('/api/insert', a, { table: 'item', values: { id: 'created', business_id: 'created', name: 'Created' } });
  owned(inserted, a);
  assert.deepEqual(inserted.body.key, { id: 'created' });
  assert.equal(typeof inserted.body.undoId, 'string');
  assert.equal(f.db.prepare("SELECT tenant_id FROM db_item WHERE id='created'").get()!.tenant_id, 'north');
  const updated = await f.data('/api/update', a, {
    table: 'item',
    key: { id: 'north-item' },
    expected: { name: 'North item' },
    values: { name: 'Edited' },
  });
  owned(updated, a);
  assert.equal(updated.body.affected, 1);
  assert.deepEqual(updated.body.applied, { name: 'Edited' });
  assert.equal(typeof updated.body.undoId, 'string');
  assert.equal(f.row().name, 'Edited');
  assert.equal(f.row('south').name, 'South item');
  denied(await f.data('/api/update', a, { table: 'task', key: { id: 'north-task' }, values: { version: 1 } }));
  denied(await f.data('/api/update', a, { table: 'item', key: { id: 'south-item' }, values: { name: 'STOLEN' } }));
  denied(
    await f.data('/api/insert', a, { table: 'item', values: { id: 'forged', business_id: 'forged', name: 'Forged', tenant_id: 'north' } }),
  );
  assert.equal(f.version(), 0);
  assert.equal(f.row('south').name, 'South item');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id='forged'").get()!.n, 0);
});

/* A record offering two command actions asks about both in one request, which is
   what the browser's action bar does. The request owns one transaction, so a
   collector that opened one per check refused every check after the first and
   the whole batch failed — and the bar, which hides a verb it cannot get an
   answer for, drew no buttons at all. Two answers in one reply is the fix. */
test('one availability request answers every command a record offers, each by its own condition', async (t) => {
  const f = await fixture(t, { twoCommands: true }),
    a = await f.open();
  const available = await f.data('/api/commands/availability', a, {
    checks: [
      { command: 'advance', commandVersion: 1, keys: [{ id: 'north-task' }, { id: 'south-task' }] },
      { command: 'hold', commandVersion: 1, keys: [{ id: 'north-task' }] },
    ],
  });
  owned(available, a);
  assert.deepEqual(available.body, {
    checks: [
      { command: 'advance', commandVersion: 1, available: [true, false] },
      { command: 'hold', commandVersion: 1, available: [false] },
    ],
  });
  // Visibility reads; it never runs a handler and never moves the record.
  assert.equal(f.control.commands, 0);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('HTTP command prepare is read-only and changed submission cannot replay another input under a retained key', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const available = await f.data('/api/commands/availability', a, {
    checks: [{ command: 'advance', commandVersion: 1, keys: [{ id: 'north-task' }, { id: 'south-task' }, { id: 'missing' }] }],
  });
  owned(available, a);
  assert.deepEqual(available.body, { checks: [{ command: 'advance', commandVersion: 1, available: [true, false, false] }] });
  const prepared = await f.data('/api/commands/prepare', a, { command: 'advance', commandVersion: 1, key: { id: 'north-task' } });
  owned(prepared, a);
  assert.deepEqual(prepared.body, { expectedVersion: 0 });
  assert.equal(f.control.commands, 0);
  assert.deepEqual(f.counts(), [0, 0]);
  owned(await f.data('/api/commands/execute', a, f.command()), a);
  const conflict = await f.data('/api/commands/execute', a, { ...f.command(), expectedVersion: 1 });
  denied(conflict);
  assert.equal(f.control.commands, 1);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
});

test('HTTP postcommit session loss reports unknown without owner headers; a fresh context can reauthorize the receipt', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  let changed = false;
  f.control.verify = () => {
    if (!changed && f.version() === 1) {
      changed = true;
      f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    }
  };
  const result = await f.data('/api/commands/execute', a, f.command());
  denied(result);
  assert.equal(result.body.outcome, 'unknown');
  assert.equal(changed, true);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  const fresh = await f.open(),
    status = await f.data('/api/commands/status', fresh, f.command());
  owned(status, fresh);
  assert.equal(status.body.replayed, true);
  assert.equal(f.control.commands, 1);
});

test('retirement drains a paused authenticated request without releasing private rows or an ownership attestation', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    entered = gate(),
    release = gate();
  let paused = false,
    retired = false;
  f.control.proof = async (req) => {
    if (!paused) {
      paused = true;
      entered.release();
      await release.promise;
    }
    return req.headers.cookie === 'fixture=alice' ? f.sessions.alice : null;
  };
  const reading = f.data('/api/query', a, { table: 'item' }).then(
    (reply) => ({ reply }),
    (error) => ({ error }),
  );
  await entered.promise;
  const retiring = f.owner.retire();
  void retiring.then(() => {
    retired = true;
  });
  try {
    await turn();
    assert.equal(retired, false);
    release.release();
    const result = await reading;
    if ('reply' in result) denied(result.reply);
    else assert.ok(result.error instanceof Error, 'closed socket must not masquerade as success');
    // The held request has settled and any response body is consumed; only
    // idle keep-alive sockets remain outside the operation-lifetime assertion.
    f.owner.server.closeIdleConnections();
    await retiring;
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    release.release();
    await Promise.allSettled([reading, retiring]);
  }
});

for (const invalid of ['enrollment copy', 'enrollment proxy', 'wrong App', 'options getter', 'verifier proxy']) {
  test(`HTTP constructor rejects ${invalid} before provider invocation`, async (t) => {
    const f = await fixture(t);
    let traps = 0,
      providers = 0;
    const trap = (): never => {
      traps++;
      throw new Error(privateValue);
    };
    const proxy = <T extends object>(value: T) =>
      new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, apply: trap });
    let options = {
      ...f.options,
      verifySessionInstance: (_req: IncomingMessage) => {
        providers++;
        return f.sessions.alice;
      },
    };
    if (invalid === 'enrollment copy') options = { ...options, enrollment: { ...f.enrollment } };
    if (invalid === 'enrollment proxy') options = { ...options, enrollment: proxy(f.enrollment) };
    if (invalid === 'wrong App') options = { ...options, app: { ...f.app, id: 'other-app' } };
    if (invalid === 'options getter') Object.defineProperty(options, 'now', { enumerable: true, get: trap });
    if (invalid === 'verifier proxy') options = { ...options, verifySessionInstance: proxy(options.verifySessionInstance) };
    assert.throws(
      () => createTenantHttpServer(options),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /PRIVATE_HTTP_TENANT_SENTINEL/);
        assert.equal('cause' in error, false);
        return true;
      },
    );
    assert.equal(traps, 0);
    assert.equal(providers, 0);
    const a = await f.open();
    owned(await f.data('/api/query', a, { table: 'item' }), a);
  });
}

test('HTTP delete preview has no mutation/history effect; opaque-token Undo restores the captured ordinary row', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const before = await f.data('/api/revert', a, {});
  owned(before, a);
  assert.deepEqual(before.body.writes, []);
  for (const confirm of [undefined, false]) {
    const preview = await f.data('/api/delete', a, {
      table: 'item',
      key: { id: 'north-item' },
      ...(confirm === undefined ? {} : { confirm }),
    });
    owned(preview, a);
    assert.deepEqual(preview.body, { impact: [], deleted: false });
    assert.equal(f.row().name, 'North item');
    assert.deepEqual((await f.data('/api/revert', a, {})).body.writes, []);
  }
  const removed = await f.data('/api/delete', a, { table: 'item', key: { id: 'north-item' }, confirm: true });
  owned(removed, a);
  assert.equal(removed.body.deleted, true);
  assert.equal(removed.body.affected, 1);
  assert.equal(typeof removed.body.undoId, 'string');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id='north-item'").get()!.n, 0);
  const preview = await f.data('/api/revert', a, {});
  owned(preview, a);
  assert.equal(object(preview.body.next).id, removed.body.undoId);
  denied(await f.data('/api/revert', a, { confirm: true, expectedId: 1 }));
  const undone = await f.data('/api/revert', a, { confirm: true, expectedId: removed.body.undoId });
  owned(undone, a);
  assert.equal(undone.body.reverted, true);
  assert.equal(undone.body.outcome, 'applied');
  assert.equal(f.row().name, 'North item');
  assert.equal(f.row().tenant_id, 'north');
  assert.equal(f.row('south').name, 'South item');
});

test('HTTP mixed insert/update/delete uses one history stack without allowing foreign-tenant tokens', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    b = await f.open('south');
  const inserted = await f.data('/api/insert', a, { table: 'item', values: { id: 'created', business_id: 'created', name: 'Created' } });
  owned(inserted, a);
  const updated = await f.data('/api/update', a, { table: 'item', key: { id: 'created' }, values: { name: 'Updated' } });
  owned(updated, a);
  const removed = await f.data('/api/delete', a, { table: 'item', key: { id: 'created' }, confirm: true });
  owned(removed, a);
  const foreign = await f.data('/api/update', b, { table: 'item', key: { id: 'south-item' }, values: { name: 'South edit' } });
  owned(foreign, b);
  denied(await f.data('/api/revert', b, { confirm: true, expectedId: removed.body.undoId }));
  assert.equal(f.row('south').name, 'South edit');
  for (const entry of [removed, updated, inserted]) {
    const preview = await f.data('/api/revert', a, {});
    owned(preview, a);
    assert.equal(object(preview.body.next).id, entry.body.undoId);
    const undone = await f.data('/api/revert', a, { confirm: true, expectedId: entry.body.undoId });
    owned(undone, a);
    assert.equal(undone.body.reverted, true);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id='created'").get()!.n, 0);
  assert.equal(object((await f.data('/api/revert', b, {})).body.next).id, foreign.body.undoId);
});

test('HTTP delete preview reauthorizes the actual row and cannot preview hidden, foreign or command-owned keys', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  for (const target of [
    { table: 'item', key: { id: 'south-item' } },
    { table: 'item', key: { id: 'missing' } },
    { table: 'task', key: { id: 'north-task' } },
    { table: 'note', key: { id: 'north-note' } },
  ])
    denied(await f.data('/api/delete', a, { ...target, confirm: false }));
  assert.equal(f.row().name, 'North item');
  assert.equal(f.row('south').name, 'South item');
  assert.equal(f.version(), 0);
  assert.deepEqual((await f.data('/api/revert', a, {})).body.writes, []);
});

test('parser-only HTTP 200 failures never attest response ownership or contain partial rows', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const result = await f.data('/api/run', a, { q: 'item where (' });
  assert.equal(result.status, 200, result.text);
  denied(result);
  assert.ok(Array.isArray(result.body.errors));
  assert.equal(f.row().name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
});

test('context control assertions cannot also appear as headers, and tenant selection cannot move into a header', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  denied(await f.call(f.select('/api/tenant/context/switch', 'south'), assertion(a), f.headers(a)));
  denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), 'x-mistri-tenant': 'north' }));
  denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), 'x-mistri-app': 'other' }));
  owned(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), 'x-mistri-app': appId }), a);
});

for (const fault of ['expired session', 'empty session ID']) {
  test(`bootstrap refuses ${fault} proof rather than disclosing memberships through account-only discovery`, async (t) => {
    const f = await fixture(t);
    f.sessions.alice = { ...f.sessions.alice!, ...(fault === 'expired session' ? { expiresAt: 1000 } : { sessionId: '' }) };
    const reply = await f.call(`/api/tenant/bootstrap?app=${appId}`);
    denied(reply);
    assert.equal('memberships' in reply.body, false);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('retirement destroys an incomplete body and drains without invoking authentication or a business operation', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    before = f.control.proofs;
  const accepted = once(f.owner.server, 'request');
  const outgoing = httpRequest(f.base + f.select('/api/update'), {
    method: 'POST',
    headers: {
      cookie: 'fixture=alice',
      'content-type': 'application/json',
      'content-length': '100',
      ...f.headers(a),
    },
  });
  const closed = new Promise<void>((resolve) => {
    outgoing.once('close', resolve);
  });
  outgoing.on('error', () => {});
  outgoing.flushHeaders();
  outgoing.write('{');
  try {
    await accepted;
    await f.owner.retire();
    await closed;
    assert.equal(f.control.proofs, before);
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    outgoing.destroy();
  }
});

test('HEAD schema verifies ownership without a body; route method mismatches refuse without executing writes', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const response = await fetch(f.base + f.select('/api/schema'), {
    method: 'HEAD',
    headers: { cookie: 'fixture=alice', ...f.headers(a) },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  owned({ status: response.status, headers: response.headers, text: '{}', body: {} }, a);
  denied(await f.call(f.select('/api/query'), undefined, f.headers(a), 'GET'));
  denied(await f.call(f.select('/api/schema'), {}, f.headers(a), 'POST'));
  denied(await f.call(f.select('/api/update'), { table: 'item', key: { id: 'north-item' }, values: { name: 'BAD' } }, f.headers(a), 'PUT'));
  assert.equal(f.row().name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
});

test('bootstrap release: session expiry during discovery refuses membership disclosure', async (t) => {
  const f = await fixture(t);
  let advanced = false;
  f.sessions.alice = { ...f.sessions.alice!, expiresAt: 1500 };
  f.control.verify = () => {
    if (!advanced) {
      advanced = true;
      f.setTime(1500);
    }
  };
  const result = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(advanced, true);
  denied(result);
  assert.equal('memberships' in result.body, false);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('bootstrap release: renewing the same session cannot extend the initial proof deadline mid-discovery', async (t) => {
  const f = await fixture(t);
  let renewed = false;
  f.sessions.alice = { ...f.sessions.alice!, expiresAt: 1500 };
  f.control.verify = () => {
    if (!renewed) {
      renewed = true;
      f.setTime(1600);
      f.sessions.alice = { ...f.sessions.alice!, expiresAt: 20000 };
    }
  };
  const result = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(renewed, true);
  denied(result);
  assert.equal('memberships' in result.body, false);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('bootstrap release: retirement reentrant from the final strong-proof clock cannot publish memberships', async (t) => {
  const f = await fixture(t);
  let fired = false,
    retirement: Promise<void> | undefined;
  f.control.httpClock = () => {
    // Discovery's own account verifier is observed without replacing its genuine
    // source. The next HTTP clock is in its final strong-session proof.
    if (!fired && f.control.verifies >= 3) {
      fired = true;
      retirement = f.owner.retire();
    }
  };
  const result = await f.call(`/api/tenant/bootstrap?app=${appId}`).then(
    (reply) => ({ reply }),
    (error) => ({ error }),
  );
  assert.equal(fired, true);
  if ('reply' in result) {
    denied(result.reply);
    assert.equal('memberships' in result.reply.body, false);
  } else assert.ok(result.error instanceof Error);
  // Bootstrap has settled (and call() consumed its response, if any). Do not
  // wait for production keep-alive expiry on the socket retired by this test.
  f.owner.server.closeIdleConnections();
  await retirement;
  assert.deepEqual(f.counts(), [0, 0]);
});

test('bootstrap release: membership revoked by final strong authentication must be checked by a later membership barrier', async (t) => {
  const f = await fixture(t);
  let revoked = false;
  f.control.proof = async () => {
    if (!revoked && f.control.verifies >= 3) {
      revoked = true;
      await f.maintenance(async (admin) => {
        await admin.putMembership({ ...f.grant, status: 'revoked', expectedVersion: '1' });
      });
    }
    return f.sessions.alice;
  };
  const result = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(revoked, true);
  denied(result);
  assert.equal('memberships' in result.body, false);
  assert.equal(f.row().name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
});

test('bootstrap release: same-account new login during discovery does not return the old membership list', async (t) => {
  const f = await fixture(t);
  let changed = false;
  f.control.verify = () => {
    if (!changed) {
      changed = true;
      f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    }
  };
  const result = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(changed, true);
  denied(result);
  assert.equal('memberships' in result.body, false);
});

test('schema FK projection: real physical constraint names become logical relationship names without dropping the relation', async (t) => {
  const f = await fixture(t, { foreignKey: true }),
    a = await f.open();
  const schema = await f.data('/api/schema', a);
  owned(schema, a);
  assert.ok(Array.isArray(schema.body.foreignKeys), schema.text);
  const relationships = schema.body.foreignKeys.map(object);
  assert.equal(relationships.length, 1, 'redaction must preserve the authorized relationship');
  const fk = relationships[0];
  assert.equal(fk.name, 'note.item_id');
  assert.deepEqual(fk.from, { table: 'note', columns: ['item_id'] });
  assert.deepEqual(fk.to, { table: 'item', columns: ['id'] });
  const query = await f.data('/api/view/run', a, { view: { base: 'note', columns: ['name', 'item_id.name'] } });
  owned(query, a);
  assert.equal(rows(query).length, 1);
  assert.ok(Object.values(rows(query)[0]).includes('North item'));
  assert.doesNotMatch(query.text, /South item/);
  const reverse = await f.data('/api/view/run', a, {
    view: { base: 'item', columns: ['name'], aggregates: [{ fn: 'count', via: fk.name, alias: 'notes' }] },
  });
  owned(reverse, a);
  assert.deepEqual(rows(reverse), [{ name: 'North item', notes: 1 }]);
  const parsed = await f.data('/api/run', a, { q: 'item show name count note via item_id as notes' });
  owned(parsed, a);
  assert.deepEqual(rows(parsed), [{ name: 'North item', notes: 1 }]);
});

test('host snapshot: replacing the constructor host cannot expand the allowed request hosts', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    oldHost = f.options.bound.host;
  const hostile = `attacker.invalid:${f.options.bound.port}`,
    proofs = f.control.proofs;
  f.options.bound.host = 'attacker.invalid';
  try {
    denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), host: hostile }));
    assert.equal(f.control.proofs, proofs);
  } finally {
    f.options.bound.host = oldHost;
  }
  owned(await f.data('/api/query', a, { table: 'item' }), a);
});

test('a logical reverse alias cannot be redirected by another resource physical constraint name', async (t) => {
  const f = await fixture(t, { collision: true }),
    a = await f.open();
  const schema = await f.data('/api/schema', a);
  owned(schema, a);
  const keys = (schema.body.foreignKeys as unknown[]).map(object);
  assert.deepEqual(keys.map((key) => key.name).sort(), ['child.ref_fk_0', 'other.parent_id']);
  const result = await f.data('/api/view/run', a, {
    view: { base: 'item', columns: ['name'], aggregates: [{ fn: 'count', via: 'child.ref_fk_0', alias: 'n' }] },
  });
  owned(result, a);
  assert.deepEqual(rows(result), [{ name: 'North item', n: 2 }]);
  const parsed = await f.data('/api/run', a, { q: 'item show name count child via ref_fk_0 as n' });
  owned(parsed, a);
  assert.deepEqual(rows(parsed), [{ name: 'North item', n: 2 }]);
});

test('HTTP cannot replace the genuine enrollment clock with a separately supplied later clock', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  assert.throws(
    () =>
      createTenantHttpServer({
        ...f.options,
        now: () => {
          calls++;
          return 1500;
        },
      } as typeof f.options),
    (error) => error instanceof Error && !error.message.includes(privateValue),
  );
  assert.equal(calls, 0);
  await f.maintenance((admin) => admin.putMembership({ ...f.grant, validUntil: 1200, expectedVersion: '1' }).then(() => {}));
  f.setTime(1500);
  const response = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.memberships, [{ tenantId: 'south' }]);
});

test('host snapshot: adding allowedHosts after construction cannot create a new trusted host', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    proofs = f.control.proofs;
  Object.defineProperty(f.options.bound, 'allowedHosts', { configurable: true, enumerable: true, value: ['attacker.invalid'] });
  try {
    denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...f.headers(a), host: 'attacker.invalid' }));
    assert.equal(f.control.proofs, proofs);
  } finally {
    Reflect.deleteProperty(f.options.bound, 'allowedHosts');
  }
  owned(await f.data('/api/query', a, { table: 'item' }), a);
});

test('bootstrap release: session expiry reentrant from the final strong-proof clock refuses membership disclosure', async (t) => {
  const f = await fixture(t);
  let expired = false;
  f.sessions.alice = { ...f.sessions.alice!, expiresAt: 1500 };
  f.control.httpClock = () => {
    if (!expired && f.control.verifies >= 3) {
      expired = true;
      f.setTime(1500);
    }
  };
  const result = await f.call(`/api/tenant/bootstrap?app=${appId}`);
  assert.equal(expired, true);
  denied(result);
  assert.equal('memberships' in result.body, false);
  assert.deepEqual(f.counts(), [0, 0]);
});

/* A read the database refused decided nothing about the tenant. Answered as
   the denial it is not (403 tenant_context_unavailable), it told the browser
   its tenant context was gone, and one bad menu count blanked the whole shell
   (a Keystone App's `= null` on PostgreSQL). SQLite refuses a LIKE pattern
   past 50,000 bytes, which is the same kind of failure made on demand. */
test('a read the database refuses is unavailable, not a lost tenant context, and the operator is told why', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const said: string[] = [];
  const error = console.error;
  console.error = (...line: unknown[]) => {
    said.push(line.join(' '));
  };
  try {
    for (const [path, body] of [
      ['/api/run', { q: `item name contains "${'x'.repeat(50_100)}"`, limit: 1 }],
      ['/api/counts', { items: [`item name contains "${'x'.repeat(50_100)}"`] }],
    ] as const) {
      const reply = await f.data(path, a, body);
      denied(reply);
      assert.equal(reply.status, 503, reply.text + said.join('\n'));
      assert.equal(reply.body.code, 'tenant_temporarily_unavailable');
    }
  } finally {
    console.error = error;
  }
  assert.match(
    said.join('\n'),
    /POST \/api\/run refused \(503 tenant_temporarily_unavailable\)[^\n]*\n\s+because: [^\n]*pattern too complex/i,
  );
});

/* `= null` in a tenant App's menu count (Keystone leads): the query language
   refuses it, and that refusal is the query's, said as the query's error. A
   tenant_context_unavailable code there tells the browser its tenant context
   is gone, which locks the whole shell over one bad count. */
test("a query the language refuses is the query's error, never a lost tenant context", async (t) => {
  const f = await fixture(t),
    a = await f.open();
  for (const [path, body] of [
    ['/api/run', { q: 'item name = null', limit: 1 }],
    ['/api/counts', { items: ['item name = null'] }],
    ['/api/run', { q: 'item nmae = x', limit: 1 }],
  ] as const) {
    const reply = await f.data(path, a, body);
    assert.equal(reply.status, 200, reply.text);
    assert.notEqual(reply.body.code, 'tenant_context_unavailable');
    const errors =
      path === '/api/counts'
        ? (reply.body.results as Array<{ errors?: Array<{ message: string }> }>)[0].errors
        : (reply.body.errors as Array<{ message: string }>);
    assert.match(errors![0].message, /compares with the word "null": write "name is empty"|"nmae" is not a column on item/);
  }
});

test("a tenant App's attachment uploads on the lease, reads back as its tenant's bytes, and is no other tenant's", async (t) => {
  const f = await fixture(t, { files: true }),
    north = await f.open('north');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
  const sent = await f.data('/api/file/upload', north, {
    table: 'attachment',
    values: { id: 'north-file', item_id: 'north-item' },
    file: { name: 'scan.png', type: 'image/png', data: bytes.toString('base64') },
  });
  owned(sent, north);
  assert.deepEqual(sent.body.key, { id: 'north-file' });
  const stored = f.db
    .prepare("SELECT tenant_id, file_name, content_type, hex(data) AS hex FROM db_attachment WHERE id = 'north-file'")
    .get()!;
  assert.deepEqual(
    { ...stored },
    { tenant_id: 'north', file_name: 'scan.png', content_type: 'image/png', hex: bytes.toString('hex').toUpperCase() },
  );
  // Read back on the lease: the bytes as base64, typed by what they are only when asked for in place.
  const read = await f.data('/api/file/read', north, { table: 'attachment', key: { id: 'north-file' }, inline: true });
  owned(read, north);
  assert.equal(read.body.name, 'scan.png');
  assert.equal(read.body.type, 'image/png');
  assert.deepEqual(Buffer.from(String(read.body.data), 'base64'), bytes);
  const download = await f.data('/api/file/read', north, { table: 'attachment', key: { id: 'north-file' } });
  assert.equal(download.body.type, 'application/octet-stream');
  // South's lease reads none of it, and cannot write a file onto north's item or name an owner.
  const south = await f.open('south');
  const stolen = await f.data('/api/file/read', south, { table: 'attachment', key: { id: 'north-file' } });
  assert.equal(stolen.status, 404);
  assert.doesNotMatch(stolen.text, /scan\.png/);
  const owner = await f.data('/api/file/upload', south, {
    table: 'attachment',
    values: { id: 'smuggled', item_id: 'south-item', tenant_id: 'north' },
    file: { name: 'x.txt', data: Buffer.from('x').toString('base64') },
  });
  assert.notEqual(owner.status, 200);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_attachment WHERE id = 'smuggled'").get()!.n, 0);
  // Past the resource's cap, into a resource that holds no files, or naming the file's own columns: nothing is written.
  const big = await f.data('/api/file/upload', north, {
    table: 'attachment',
    values: { id: 'big', item_id: 'north-item' },
    file: { name: 'big.bin', data: Buffer.alloc(5000).toString('base64') },
  });
  assert.equal(big.status, 413);
  const nowhere = await f.data('/api/file/upload', north, {
    table: 'item',
    values: { id: 'x' },
    file: { name: 'x.txt', data: Buffer.from('x').toString('base64') },
  });
  assert.equal(nowhere.status, 404);
  const columns = await f.data('/api/file/upload', north, {
    table: 'attachment',
    values: { id: 'cols', item_id: 'north-item', file_name: 'other' },
    file: { name: 'x.txt', data: Buffer.from('x').toString('base64') },
  });
  assert.equal(columns.status, 400);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM db_attachment').get()!.n, 1);
  // The hash is the server's: written by the upload, granted to no role, and named by no request on the lease.
  const hash = f.db.prepare("SELECT sha256 FROM db_attachment WHERE id = 'north-file'").get()!.sha256 as string;
  assert.match(hash, /^[0-9a-f]{64}$/);
  for (const [path, body] of [
    ['/api/query', { table: 'attachment', columns: ['id', 'sha256'], limit: 5, offset: 0 }],
    ['/api/query', { table: 'attachment', filter: { groups: [[{ column: 'sha256', op: '=', value: hash }]] }, limit: 5, offset: 0 }],
    ['/api/query', { table: 'attachment', orderBy: [{ column: 'sha256', direction: 'asc' }], limit: 5, offset: 0 }],
    ['/api/run', { q: `attachment sha256 = "${hash}"`, limit: 5, count: 'none' }],
    ['/api/update', { table: 'attachment', key: { id: 'north-file' }, values: { sha256: 'forged' } }],
    ['/api/insert', { table: 'attachment', values: { id: 'forged', item_id: 'north-item', file_name: 'f', data: 'eA==', sha256: hash } }],
  ] as const) {
    const reply = await f.data(path, north, body);
    assert.ok(
      reply.status !== 200 || (reply.body as { errors?: unknown[] }).errors?.length,
      `${path} ${JSON.stringify(body)}: ${reply.text}`,
    );
    assert.ok(!reply.text.includes(hash), path);
  }
  const listed = await f.data('/api/run', north, { q: 'attachment', limit: 5, count: 'none' });
  assert.equal(listed.status, 200, listed.text);
  assert.ok((listed.body as { rows: unknown[] }).rows.length && !/sha256/.test(listed.text) && !listed.text.includes(hash), listed.text);
  assert.equal(f.db.prepare("SELECT sha256 FROM db_attachment WHERE id = 'north-file'").get()!.sha256, hash);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM db_attachment').get()!.n, 1);
  // The file's other columns are the member's to edit, its hash kept as it was.
  const renamed = await f.data('/api/update', north, {
    table: 'attachment',
    key: { id: 'north-file' },
    values: { file_name: 'renamed.png' },
  });
  owned(renamed, north);
  assert.deepEqual(
    { ...f.db.prepare("SELECT file_name, sha256 FROM db_attachment WHERE id = 'north-file'").get()! },
    { file_name: 'renamed.png', sha256: hash },
  );
});

test("a tenant App's rich text column is sanitized on the lease's write, Markdown read into it", async (t) => {
  const f = await fixture(t, { richText: true }),
    north = await f.open('north');
  const written = await f.data('/api/update', north, {
    table: 'item',
    key: { id: 'north-item' },
    values: { name: '<p onclick="steal()">Hi <script>alert(1)</script><a href="javascript:alert(1)">there</a></p>' },
  });
  owned(written, north);
  assert.equal(f.row('north').name, '<p>Hi there</p>');
  await f.data('/api/update', north, { table: 'item', key: { id: 'north-item' }, values: { name: '**Done** - [x] shipped' } });
  assert.equal(f.row('north').name, '<p><strong>Done</strong> - [x] shipped</p>');
});
