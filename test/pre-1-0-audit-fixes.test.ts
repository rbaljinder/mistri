/**
 * Regression suite for the pre-1.0.0 audit fixes:
 * - P0-1: signed-out visitors cannot download private component bundles or discover them via preload hints
 * - P0-2: public target-one commands cannot judge columns hidden from auth.public via fields/hidden
 * - P0-3: tablesReached enforces declared reads across virtual paths (cover, tags, rollups)
 * - P0-4: db.<table>.claim() miss does not poison the transaction, works with state-machine stamps
 *         and scoped data snapshots, and rejects undefined values in where
 * - P0-5: ui.site href validation rejects backslash open redirects (/\evil.com)
 * - P0-9: pack-manifest rcChangelog preserves 1.0.0 and stable 1.x+ release headings
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { conditionalExpected, isConditionalExpected } from '../packages/engine/src/adapters/adapter.js';
import { snapshotScopedData } from '../packages/engine/src/adapters/scoped/scopedReads.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { CapturedReply } from '../packages/engine/src/server/http/captured.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { bindHttpBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { publicPrincipal } from '../packages/mistri/src/server/commands/formHttp.js';
import { componentRoutes } from '../packages/mistri/src/server/http/componentRoutes.js';
import { strayRead, tablesReached } from '../packages/mistri/src/server/http/tablesReached.js';
import { publicComponentIds } from '../packages/mistri/src/shared/appComponentPlaces.js';
import { rcChangelog } from '../scripts/pack-manifest.mjs';
import { parseTestApp } from './support/commandCatalog.js';

/* ---------- P0-1: private component isolation ---------- */

test('P0-1: publicComponentIds and componentRoutes deny private page components to signed-out visitors even when auth.public is set', async () => {
  const app = parseTestApp(
    {
      id: 'shop',
      name: 'Shop',
      sources: { main: { connection: 'db' } },
      auth: {
        roles: { staff: { read: true, write: false } },
        public: { read: ['listing'] },
      },
      resources: { listing: {} },
      views: {
        listings: { kind: 'list', from: 'listing' },
        'public-door': {
          kind: 'page',
          label: 'Welcome',
          public: true,
          component: { id: 'page-door', module: './pages/door.page.tsx', kind: 'page' },
          reads: ['listing'],
          commands: [],
          params: [],
        },
        'staff-board': {
          kind: 'page',
          label: 'Staff Board',
          component: { id: 'page-staff', module: './pages/staff.page.tsx', kind: 'page' },
          reads: ['listing'],
          commands: [],
          params: [],
        },
      },
      home: 'public-door',
      nav: ['listings'],
    },
    'private component isolation',
  );

  const publicIds = publicComponentIds(app, []);
  assert.equal(publicIds.has('page-door'), true);
  assert.equal(publicIds.has('page-staff'), false, 'non-public free-form page must not be exposed to signed-out visitors');

  const compiled = {
    entries: {
      'page-door': { kind: 'page' as const, js: 'page-door-aaa.js', css: 'page-door-aaa.css' },
      'page-staff': { kind: 'page' as const, js: 'page-staff-bbb.js', css: 'page-staff-bbb.css' },
    },
    kit: { js: 'kit-ccc.js' },
    files: {
      'page-door-aaa.js': 'export default function Door() {}',
      'page-door-aaa.css': '.door {}',
      'page-door-aaa.js.map': '{"version":3}',
      'page-staff-bbb.js': 'export default function StaffSecret() {}',
      'page-staff-bbb.css': '.staff {}',
      'kit-ccc.js': 'export const kit = {};',
    },
  };
  const host = {
    app: { path: '/tmp/app.ts', app, pages: [], sources: {}, components: compiled },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/tmp/auth.db',
      close: async () => {},
      session: async () => null,
      handler: async () => {},
    },
  };

  const ask = async (path: string, signedIn = false) => {
    const res = new CapturedReply();
    const handled = await componentRoutes({
      req: { method: 'GET', headers: {} } as never,
      res: res as never,
      path,
      mount: { base: '', apps: {} },
      identity: signedIn ? { id: 'staff:1', who: 'staff@shop.test', role: 'staff' } : {},
      appHosts: [host as never],
    } as never);
    assert.equal(handled, true);
    return { status: res.statusCode };
  };

  assert.equal((await ask('/shop/_components/page-door-aaa.js')).status, 200);
  assert.equal((await ask('/shop/_components/page-door-aaa.css')).status, 200);
  assert.equal((await ask('/shop/_components/kit-ccc.js')).status, 200);
  assert.equal((await ask('/shop/_components/page-door-aaa.js.map')).status, 404, 'source maps stay private');
  assert.equal((await ask('/shop/_components/page-staff-bbb.js')).status, 404, 'private component JS must 404 for visitors');
  assert.equal((await ask('/shop/_components/page-staff-bbb.css')).status, 404, 'private component CSS must 404 for visitors');
  assert.equal((await ask('/shop/_components/page-staff-bbb.js', true)).status, 200, 'signed-in staff can load private component');
});

/* ---------- P0-2: public target-one command field-grant oracle ---------- */

test('P0-2: bindHttpBusinessCommands refuses a public target-one command whose when judges a column hidden from auth.public', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-pub-oracle-'));
  const file = join(dir, 'oracle.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE listing (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      internal_hold TEXT
    );
    INSERT INTO listing VALUES (1, 'Lamp', 'live', 'vip');
  `);
  raw.close();
  migrateSqliteCommandJournal(file);

  const registry = new Registry();
  registry.add({ id: 'oracle-db', name: 'Oracle', url: file, writable: true, source: 'config' });

  const commands = defineCommands({
    claimListing: defineCommand({
      source: 'main',
      target: 'listing',
      targets: 'one',
      public: true,
      read: ['listing'],
      write: ['listing'],
      when: 'internal_hold is empty',
      input: {},
      output: shape({ status: text() }),
      async handle(ctx) {
        await ctx.db.listing.update(ctx.record, { status: 'held' });
        return { status: 'held' };
      },
    }),
  });

  const app = parseTestApp(
    {
      id: 'oracle',
      name: 'Oracle',
      sources: { main: { connection: 'oracle-db' } },
      auth: {
        roles: { staff: { read: true, write: ['listing'], commands: ['claimListing'] } },
        public: {
          read: ['listing'],
          fields: { listing: { read: ['id', 'title', 'status'] } },
        },
      },
      resources: { listing: { access: 'write' } },
      views: {
        listings: { kind: 'list', from: 'listing' },
        door: {
          kind: 'page',
          label: 'Door',
          public: true,
          component: { id: 'page-door', module: './pages/door.page.tsx', kind: 'page' },
          reads: ['listing'],
          commands: ['claimListing'],
          params: [],
        },
      },
      home: 'door',
      nav: ['listings'],
    },
    'public command hidden column oracle',
    { claimListing: { public: true, targets: 'one', target: 'listing', input: {} } },
  );

  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, 'oracle-db', (owner) => releases.push(registry.lease(owner)));
    assert.throws(
      () => bindHttpBusinessCommands(app, commands, resources, (owner) => registry.configOf(owner)?.writable === true),
      /Public command "claimListing" judges a column of "listing".*"auth\.public" does not read/,
    );
  } finally {
    for (const release of releases.reverse()) release();
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- P0-3: tablesReached virtual path coverage ---------- */

test('P0-3: tablesReached and strayRead catch virtual paths for cover, tags, and rollups', () => {
  const schema: DatabaseSchema = {
    label: 'test',
    dialect: 'sqlite',
    readAt: '2026-01-01T00:00:00.000Z',
    tables: [
      {
        id: 'listing',
        schema: 'main',
        name: 'Listing',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'title', type: 'text', nullable: false, primaryKey: false },
        ],
        cover: { from: 'listing_photo', whose: 'listing_id', key: 'id', photoKey: 'id' },
        tags: { through: 'listing_tag', from: 'listing_id', key: 'id', to: 'tag', via: 'tag_id', tagKey: 'id', label: 'name' },
        rollups: {
          bid_count: { fn: 'count', via: 'bid.listing_id', type: 'integer' },
        },
      },
      {
        id: 'listing_photo',
        schema: 'main',
        name: 'Listing Photo',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'listing_id', type: 'integer', nullable: false, primaryKey: false },
        ],
      },
      {
        id: 'listing_tag',
        schema: 'main',
        name: 'Listing Tag',
        isView: false,
        columns: [
          { name: 'listing_id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'tag_id', type: 'integer', nullable: false, primaryKey: true },
        ],
      },
      {
        id: 'tag',
        schema: 'main',
        name: 'Tag',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'name', type: 'text', nullable: false, primaryKey: false },
        ],
      },
      {
        id: 'bid',
        schema: 'main',
        name: 'Bid',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'listing_id', type: 'integer', nullable: false, primaryKey: false },
        ],
      },
    ],
    foreignKeys: [],
  };

  const coverTables = tablesReached(schema, '/api/view/run', {
    view: { base: 'listing', columns: [{ path: 'id' }, { path: 'cover' }] },
  });
  assert.ok(coverTables?.includes('listing_photo'));
  assert.equal(
    strayRead(schema, ['listing'], '/api/view/run', { view: { base: 'listing', columns: [{ path: 'id' }, { path: 'cover' }] } }),
    'listing_photo',
  );

  const tagTables = tablesReached(schema, '/api/view/run', {
    view: { base: 'listing', columns: [{ path: 'id' }, { path: 'tags' }] },
  });
  assert.ok(tagTables?.includes('listing_tag'));
  assert.ok(tagTables?.includes('tag'));
  assert.equal(strayRead(schema, ['listing'], '/api/view/run', { view: { base: 'listing', columns: [{ path: 'tags' }] } }), 'listing_tag');

  const rollupTables = tablesReached(schema, '/api/view/run', {
    view: {
      base: 'listing',
      columns: [{ path: 'id' }],
      filter: { groups: [[{ path: 'bid_count', op: '>', value: 0 }]] },
    },
  });
  assert.ok(rollupTables?.includes('bid'));
  assert.equal(
    strayRead(schema, ['listing'], '/api/view/run', {
      view: { base: 'listing', columns: [{ path: 'id' }], orderBy: [{ path: 'bid_count', direction: 'desc' }] },
    }),
    'bid',
  );
});

/* ---------- P0-4: claim() miss does not poison transaction, preserves brand, rejects undefined ---------- */

test('P0-4: db.<table>.claim() miss does not poison subsequent writes in the same transaction and works with state-machine since stamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-claim-tx-'));
  const file = join(dir, 'claim.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE slot (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      status_at TEXT
    );
    CREATE TABLE waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      guest TEXT NOT NULL
    );
    INSERT INTO slot VALUES (1, 'held', NULL), (2, 'open', NULL);
  `);
  raw.close();
  migrateSqliteCommandJournal(file);

  const registry = new Registry();
  registry.add({ id: 'claim-db', name: 'Claim', url: file, writable: true, source: 'config' });

  const tryInput = {
    slot_id: { label: 'Slot', type: 'number', integer: true },
    guest: { label: 'Guest', type: 'text' },
  } as const;
  const commands = defineCommands({
    tryClaimOrWaitlist: defineCommand({
      source: 'main',
      target: 'slot',
      targets: 'none',
      public: true,
      read: ['slot', 'waitlist'],
      write: ['slot', 'waitlist'],
      input: tryInput,
      output: shape({ reference: text() }),
      async handle(ctx, input) {
        const claimed = await ctx.db.slot.claim(input.slot_id, {
          where: { status: 'open' },
          set: { status: 'held' },
        });
        if (!claimed) {
          // Subsequent write in the SAME transaction must succeed without transaction poisoning!
          await ctx.db.waitlist.insert({ slot_id: input.slot_id, guest: input.guest });
          return { reference: 'WAITLISTED' };
        }
        return { reference: `CLAIMED-${claimed.id}` };
      },
    }),
    badUndefinedClaim: defineCommand({
      source: 'main',
      target: 'slot',
      targets: 'none',
      public: true,
      read: ['slot'],
      write: ['slot'],
      input: {},
      output: shape({ reference: text() }),
      async handle(ctx) {
        await ctx.db.slot.claim(2, { where: { status_at: undefined as never }, set: { status: 'held' } });
        return { reference: 'OK' };
      },
    }),
  });

  const app = parseTestApp(
    {
      id: 'claimapp',
      name: 'Claim App',
      sources: { main: { connection: 'claim-db' } },
      auth: {
        roles: { staff: { read: true, write: false } },
        public: { read: ['slot'] },
      },
      resources: {
        slot: {
          access: 'write',
          machine: {
            column: 'status',
            since: 'status_at',
            states: {
              open: { on: { tryClaimOrWaitlist: 'held' } },
              held: { final: true },
            },
          },
        },
        waitlist: { access: 'write' },
      },
      views: {
        slots: { kind: 'list', from: 'slot' },
        book: {
          kind: 'page',
          label: 'Book',
          public: true,
          component: { id: 'page-book', module: './pages/book.page.tsx', kind: 'page' },
          reads: ['slot'],
          commands: ['tryClaimOrWaitlist', 'badUndefinedClaim'],
          params: [],
        },
      },
      home: 'book',
      nav: ['slots'],
    },
    'claim tx integrity',
    {
      tryClaimOrWaitlist: { public: true, input: tryInput },
      badUndefinedClaim: { public: true, input: {} },
    },
  );

  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, 'claim-db', (owner) => releases.push(registry.lease(owner)));
    const { binding } = bindHttpBusinessCommands(app, commands, resources, (owner) => registry.configOf(owner)?.writable === true);
    const visitor = publicPrincipal(app.id, 'book');

    // 1. Slot 1 is already 'held': claim() returns null AND waitlist.create() commits in the same transaction.
    const miss = await executeBusinessCommand(binding, visitor, {
      command: 'tryClaimOrWaitlist',
      commandVersion: 1,
      key: {},
      idempotencyKey: 'claim-miss-idempotency-0001',
      input: { slot_id: 1, guest: 'Dana' },
    });
    assert.equal(miss.status, 'applied');
    assert.deepEqual(miss.result, { reference: 'WAITLISTED' });

    const waitlistRows = await resources.adapter.query({ table: 'waitlist', limit: 10, offset: 0 });
    assert.equal(waitlistRows.rows.length, 1);
    assert.equal(waitlistRows.rows[0]!.guest, 'Dana');

    // 2. Slot 2 is 'open': claim() succeeds even though the state machine stamps `status_at`!
    const hit = await executeBusinessCommand(binding, visitor, {
      command: 'tryClaimOrWaitlist',
      commandVersion: 1,
      key: {},
      idempotencyKey: 'claim-hit-idempotency-0002',
      input: { slot_id: 2, guest: 'Evan' },
    });
    assert.equal(hit.status, 'applied');
    assert.deepEqual(hit.result, { reference: 'CLAIMED-2' });
    const slot2 = (
      await resources.adapter.query({ table: 'slot', filter: { groups: [[{ column: 'id', op: '=', value: 2 }]] }, limit: 1, offset: 0 })
    ).rows[0]!;
    assert.equal(slot2.status, 'held');
    assert.ok(slot2.status_at, 'state machine since stamp written alongside claim');

    // 3. Passing undefined in where rejects instead of silently coercing to NULL.
    await assert.rejects(
      () =>
        executeBusinessCommand(binding, visitor, {
          command: 'badUndefinedClaim',
          commandVersion: 1,
          key: {},
          idempotencyKey: 'claim-undef-idempotency-0003',
          input: {},
        }),
      (err: unknown) => /cannot be undefined/.test(String(refusalCause(err) ?? err)),
    );
  } finally {
    for (const release of releases.reverse()) release();
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-4: snapshotScopedData preserves the conditionalExpected WeakSet brand', () => {
  const expected = conditionalExpected({ status: 'open' });
  const cloned = snapshotScopedData({ table: 'slot', key: { id: 1 }, values: { status: 'held' }, expected });
  assert.notEqual(cloned.expected, expected);
  assert.equal(isConditionalExpected(cloned.expected), true);
});

/* ---------- P0-5: ui.site backslash open redirect ---------- */

test('P0-5: parseAppConfig rejects backslash-prefixed open redirect URLs in ui.site links', () => {
  assert.throws(
    () =>
      parseTestApp(
        {
          id: 'site',
          name: 'Site',
          sources: { main: { connection: 'db' } },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
          nav: ['items'],
          ui: {
            site: {
              links: [{ label: 'Bad', href: '/\\evil.example' }],
            },
          },
        },
        'backslash redirect',
      ),
    /must start with https:\/\/, mailto:, tel:, or \//,
  );
});

/* ---------- P0-9: rcChangelog retains 1.0.0 and 1.x releases ---------- */

test('P0-9: rcChangelog preserves 1.0.0 and 1.x release headings alongside 1.0.0-rc.* and drops 0.x', () => {
  const sample = [
    '# Changelog',
    '',
    '## 1.1.0',
    '- Added feature.',
    '',
    '## 1.0.0',
    '- General availability.',
    '',
    '## 1.0.0-rc.89',
    '- Release candidate.',
    '',
    '## 0.9.0',
    '- Legacy release.',
    '',
  ].join('\n');
  const out = rcChangelog(sample);
  assert.ok(out.includes('## 1.1.0'));
  assert.ok(out.includes('## 1.0.0\n'));
  assert.ok(out.includes('## 1.0.0-rc.89'));
  assert.equal(out.includes('## 0.9.0'), false);
});
