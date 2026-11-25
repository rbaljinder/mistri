/**
 * End-to-end verification of the public custom-site capabilities across any custom site domain
 * (directories, editorial sites, booking portals, storefronts):
 *   1. Display rule `round: true` and static `<Choose count>` multi-resource ambiguity check.
 *   2. Resource-level `photos` -> `cover` virtual column via correlated SQL subquery (SQLite).
 *   3. Public site chrome (`ui.site`: header links, search, CTA, footer, signIn placement) & view reachability.
 *   4. `open: { page, param? }` on list views, landing embeds, and `related()`, with canonical slug URLs.
 *   5. Atomic conditional `db.<table>.claim()` with field-level refusal, and unified `public: true, targets: 'one'`
 *      state-machine verbs shared by public visitors and staff roles.
 *   6. First-paint `pageLoads` for root/named/record-bound custom pages and true SSR HTML rendering (`renderPublic`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseSync } from 'vite';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { readView } from '../packages/engine/src/server/resourceReadOperations.js';
import { COVER_COLUMN } from '../packages/engine/src/shared/coverPhotos.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { appCatalog, appCoverRules } from '../packages/mistri/src/shared/app.js';
import { appAddressBook, readAppSegments, recordSegments } from '../packages/mistri/src/shared/appAddress.js';
import { parseTestApp } from './support/commandCatalog.js';
import { scanPageSource } from '../packages/mistri/src/server/app/appPages.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { bindHttpBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { refuse } from '../packages/mistri/src/server/commands/commandErrors.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { publicPrincipal } from '../packages/mistri/src/server/commands/formHttp.js';
import { rowRevision } from '../packages/mistri/src/server/commands/commandRevision.js';
import { pageLoads, roomReads } from '../packages/mistri/src/server/http/firstPaintRooms.js';
import { formatColumnValue } from '../packages/kit/src/client/components/valueModel.js';

const parseAst = (code: string, opts: { lang: 'ts' | 'tsx' | 'js' | 'jsx' }) => parseSync(`page.${opts.lang}`, code).program;

/* ---------- 1. Display formatting & <Choose count> static check ---------- */

test('display rule supports round: true for rounded whole major units', () => {
  const app = parseTestApp(
    {
      id: 'estimates',
      name: 'Estimates',
      sources: { main: { connection: 'db' } },
      resources: {
        listing: {
          display: {
            price: { format: 'money', currency: 'USD', minor: true, whole: true },
            est_monthly: { format: 'money', currency: 'USD', minor: true, round: true },
            mileage: { format: 'number', unit: 'miles' },
          },
        },
      },
      views: { listings: { kind: 'list', from: 'listing' } },
      home: 'listings',
      nav: ['listings'],
    },
    'round display rule',
  );
  const rules = app.resources!.listing.display!;
  assert.equal(rules.est_monthly.round, true);
  assert.equal(
    formatColumnValue({ name: 'price', type: 'integer', nullable: false, primaryKey: false }, rules.price as never, 4890000),
    '$48,900',
  );
  assert.equal(
    formatColumnValue({ name: 'est_monthly', type: 'integer', nullable: false, primaryKey: false }, rules.est_monthly as never, 67917),
    '$679',
  );
  assert.equal(
    formatColumnValue({ name: 'mileage', type: 'integer', nullable: false, primaryKey: false }, rules.mileage as never, 42100),
    '42,100 miles',
  );
});

test('static page check refuses ambiguous <Choose count> on multi-resource pages and accepts explicit of', () => {
  const ambiguous = `
    import { definePage, Choose } from '@mistriwork/mistri/page';
    export default definePage({
      label: 'Directory',
      reads: ['listing', 'photo'],
      params: ['city'],
      component: () => <Choose param="city" column="city" count />,
    });
  `;
  const scan = scanPageSource(parseAst, ambiguous, 'tsx', {
    key: 'dir',
    reads: ['listing', 'photo'],
    commands: [],
  });
  assert.ok(
    scan.undeclared.some((f) => f.text.includes('[page-choose-count]')),
    `Expected [page-choose-count] finding, got: ${JSON.stringify(scan)}`,
  );

  const explicit = `
    import { definePage, Choose } from '@mistriwork/mistri/page';
    export default definePage({
      label: 'Directory',
      reads: ['listing', 'photo'],
      params: ['city'],
      component: () => <Choose param="city" column="city" count={{ of: 'listing' }} />,
    });
  `;
  const cleanScan = scanPageSource(parseAst, explicit, 'tsx', {
    key: 'dir',
    reads: ['listing', 'photo'],
    commands: [],
  });
  assert.equal(cleanScan.undeclared.filter((f) => f.text.includes('[page-choose-count]')).length, 0);
});

/* ---------- 2. Resource photos -> synthetic cover column via SQLite ---------- */

test('resource.photos hydrates synthetic cover column in SQLite readView ordered by sort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-cover-'));
  const file = join(dir, 'cover.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE article (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE article_photo (
      id INTEGER PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES article(id),
      position INTEGER,
      content BLOB NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL
    );
    INSERT INTO article VALUES (1, 'First Post'), (2, 'No Photo Post');
    INSERT INTO article_photo VALUES
      (10, 1, 2, X'89504E47', 'second.png', 'image/png'),
      (11, 1, 1, X'89504E47', 'lead.png', 'image/png');
  `);
  raw.close();

  const adapter = new SqliteAdapter(file);
  try {
    const rawSchema = await adapter.introspect();
    const app = parseTestApp(
      {
        id: 'editorial',
        name: 'Editorial',
        sources: { main: { connection: 'db' } },
        resources: {
          article: {
            photos: { from: 'article_photo', whose: 'article_id', sort: 'position asc', aspect: '3/2' },
          },
          article_photo: {
            file: { content: 'content', name: 'filename', type: 'mime_type' },
          },
        },
        views: { articles: { kind: 'list', from: 'article' } },
        home: 'articles',
        nav: ['articles'],
      },
      'cover photo app',
    );
    const covers = appCoverRules(app, rawSchema);
    assert.equal(covers.problems.length, 0);
    assert.equal(covers.rules.get('article')?.from, 'article_photo');
    assert.equal(covers.rules.get('article')?.photoKey, 'id');
    assert.equal(covers.rules.get('article')?.aspect, '3/2');

    const schema = appCatalog(app, rawSchema);
    const articleTable = schema.tables.find((t) => t.id === 'article')!;
    assert.equal(articleTable.cover?.from, 'article_photo');

    const read = await readView(adapter, schema, {
      id: 'articles',
      name: 'Articles',
      base: 'article',
      columns: [{ path: 'id' }, { path: 'title' }, { path: COVER_COLUMN }],
      orderBy: [{ path: 'id', direction: 'asc' }],
    });
    assert.equal(read.result.rows.length, 2);
    assert.equal(read.result.rows[0]![COVER_COLUMN], 11, 'lead photo with position=1 wins');
    assert.equal(read.result.rows[1]![COVER_COLUMN], null, 'record with no photos gets null cover');
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 3 & 4. Public site chrome (ui.site) + open: { page, param? } routing ---------- */

test('ui.site parses links, search, cta, footer, signIn and makes site-only views reachable without desk nav', () => {
  const app = parseTestApp(
    {
      id: 'journal',
      name: 'Field Journal',
      sources: { main: { connection: 'db' } },
      auth: {
        roles: { editor: { read: true, write: true } },
        public: { read: ['article'] },
      },
      resources: {
        article: { slug: true },
      },
      ui: {
        site: {
          links: [
            { label: 'Articles', view: 'browse' },
            { label: 'About', view: 'about' },
            { label: 'RSS', href: 'https://example.com/rss.xml' },
          ],
          search: { view: 'browse', param: 'q', placeholder: 'Search articles…' },
          cta: { label: 'Subscribe', href: 'https://example.com/subscribe' },
          signIn: 'footer',
          footer: {
            text: '© 2026 Field Journal',
            links: [
              { label: 'About', view: 'about' },
              { label: 'Privacy', href: 'https://example.com/privacy' },
            ],
          },
        },
      },
      views: {
        'desk-articles': { kind: 'list', from: 'article', roles: ['editor'] },
        browse: { kind: 'list', from: 'article', open: { page: 'story', param: 'id' } },
        about: {
          kind: 'page',
          label: 'About',
          public: true,
          component: { id: 'page-about', module: './pages/about.page.tsx', kind: 'page' },
          reads: ['article'],
          commands: [],
          params: [],
        },
        story: {
          kind: 'page',
          label: 'Story',
          public: true,
          component: { id: 'page-story', module: './pages/story.page.tsx', kind: 'page' },
          reads: ['article'],
          commands: [],
          params: ['id'],
        },
      },
      home: [{ view: 'browse', signedOut: true }, { view: 'desk-articles' }],
      nav: ['desk-articles'],
    },
    'custom site with ui.site and open.page',
  );

  assert.equal(app.ui.site?.signIn, 'footer');
  assert.equal(app.ui.site?.links?.length, 3);
  assert.equal(app.ui.site?.footer?.text, '© 2026 Field Journal');
  assert.deepEqual((app.views.browse as { open?: unknown }).open, { page: 'story', param: 'id' });

  /* Canonical record route follows open: { page: 'story' } with slug support. */
  const book = appAddressBook({
    views: app.views as never,
    order: ['browse', 'about', 'story'],
    resources: app.resources ?? {},
    pages: [],
    tables: [
      {
        id: 'article',
        name: 'article',
        columns: [
          { name: 'id', primaryKey: true },
          { name: 'title', primaryKey: false },
        ],
      },
    ],
  });
  assert.equal(book.records.get('article')?.segment, 'story');
  assert.deepEqual(recordSegments(book, 'article', { key: { id: 42 }, slug: 'hello-world' }), ['story', '42-hello-world']);

  const parsed = readAppSegments(book, ['story', '42-hello-world']);
  assert.equal(parsed?.kind, 'record');
  if (parsed?.kind === 'record') {
    assert.equal(parsed.table, 'article');
    assert.deepEqual(parsed.key, { id: '42' });
    assert.equal(parsed.target.kind, 'dashboard');
    if (parsed.target.kind === 'dashboard') {
      assert.equal(parsed.target.view, 'story');
      assert.equal(parsed.target.recordParam, 'id');
      assert.equal(parsed.target.listView, 'browse');
    }
  }
});

/* ---------- 5. Atomic claim() + unified public/staff state-machine verb ---------- */

test('db.<table>.claim() atomically guards transitions and unified public+staff machine verb works for both visitors and staff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-claim-'));
  const file = join(dir, 'slots.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE slot (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_by TEXT
    );
    INSERT INTO slot VALUES (1, '10:00 AM', 'open', NULL), (2, '11:00 AM', 'open', NULL);
  `);
  raw.close();
  migrateSqliteCommandJournal(file);

  const registry = new Registry();
  registry.add({ id: 'slots-db', name: 'Slots', url: file, writable: true, source: 'config' });

  const reserveInput = { guest_name: { label: 'Guest', type: 'text', max: 60 } } as const;
  const commands = defineCommands({
    reserveSlot: defineCommand({
      source: 'main',
      target: 'slot',
      targets: 'one',
      public: true,
      read: ['slot'],
      write: ['slot'],
      input: reserveInput,
      output: shape({ reference: text() }),
      async handle(ctx, input) {
        const claimed = await ctx.db.slot.claim(ctx.record, {
          where: { status: 'open' },
          set: { status: 'held', claimed_by: input.guest_name },
        });
        if (!claimed) refuse('This slot is no longer open.', { field: 'guest_name' });
        return { reference: `SLOT-${claimed.id}` };
      },
    }),
  });

  const app = parseTestApp(
    {
      id: 'booking',
      name: 'Booking',
      sources: { main: { connection: 'slots-db' } },
      auth: {
        roles: { staff: { read: true, commands: ['reserveSlot'] } },
        public: { read: ['slot'] },
      },
      resources: {
        slot: {
          access: 'write',
          machine: {
            column: 'status',
            states: {
              open: { on: { reserveSlot: 'held' } },
              held: { final: true },
            },
          },
        },
      },
      views: {
        slots: { kind: 'list', from: 'slot' },
        book: {
          kind: 'page',
          label: 'Book',
          public: true,
          component: { id: 'page-book', module: './pages/book.page.tsx', kind: 'page' },
          reads: ['slot'],
          commands: ['reserveSlot'],
          params: ['id'],
        },
      },
      home: [{ view: 'book', signedOut: true }, { view: 'slots' }],
      nav: ['slots'],
    },
    'unified public+staff machine verb',
    { reserveSlot: { public: true, targets: 'one', target: 'slot', input: reserveInput } },
  );

  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, 'slots-db', (owner) => releases.push(registry.lease(owner)));
    const { binding } = bindHttpBusinessCommands(app, commands, resources, (owner) => registry.configOf(owner)?.writable === true);

    /* 1. Public visitor reserves slot 1 through the unified machine verb. */
    const visitor = publicPrincipal(app.id, 'book');
    const first = await executeBusinessCommand(binding, visitor, {
      command: 'reserveSlot',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'visit-1-hold-slot-1',
      input: { guest_name: 'Alice' },
    });
    assert.equal(first.status, 'applied');
    assert.deepEqual(first.result, { reference: 'SLOT-1' });

    /* 2. Second visitor attempting to reserve slot 1 is refused by the machine precondition (open -> held). */
    await assert.rejects(
      () =>
        executeBusinessCommand(binding, visitor, {
          command: 'reserveSlot',
          commandVersion: 1,
          key: { id: 1 },
          expectedVersion: 0,
          idempotencyKey: 'visit-2-hold-slot-1',
          input: { guest_name: 'Bob' },
        }),
      (err: unknown) => err instanceof BusinessCommandExecutionError && err.code === 'ineligible_state',
    );

    /* 3. Signed-in staff member runs the EXACT SAME verb on slot 2! */
    const staffActor = { id: 'staff:1', appId: app.id, roles: ['staff'] };
    const row2 = (
      await resources.adapter.query({ table: 'slot', filter: { groups: [[{ column: 'id', op: '=', value: 2 }]] }, limit: 1, offset: 0 })
    ).rows[0]!;
    const rev2 = rowRevision(row2, undefined)!;
    const staffRun = await executeBusinessCommand(binding, staffActor, {
      command: 'reserveSlot',
      commandVersion: 1,
      key: { id: 2 },
      expectedVersion: rev2,
      idempotencyKey: 'staff-1-hold-slot-2',
      input: { guest_name: 'Walk-in' },
    });
    assert.equal(staffRun.status, 'applied');
    assert.deepEqual(staffRun.result, { reference: 'SLOT-2' });
  } finally {
    for (const release of releases.reverse()) release();
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('db.<table>.claim() returns null when row no longer matches expected condition so handler can refuse on a field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-cas-'));
  const file = join(dir, 'cas.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE item (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO item VALUES (1, 'sold');
  `);
  raw.close();
  migrateSqliteCommandJournal(file);

  const registry = new Registry();
  registry.add({ id: 'cas-db', name: 'CAS', url: file, writable: true, source: 'config' });

  const holdInput = { item_id: { label: 'Item', type: 'number', integer: true } } as const;
  const commands = defineCommands({
    holdItem: defineCommand({
      source: 'main',
      target: 'item',
      targets: 'none',
      public: true,
      read: ['item'],
      write: ['item'],
      input: holdInput,
      output: shape({ reference: text() }),
      async handle(ctx, input) {
        const claimed = await ctx.db.item.claim(input.item_id, {
          where: { status: 'live' },
          set: { status: 'held' },
        });
        if (!claimed) refuse('This item is no longer available.', { field: 'item_id' });
        return { reference: `HOLD-${claimed.id}` };
      },
    }),
  });

  const app = parseTestApp(
    {
      id: 'casapp',
      name: 'CAS App',
      sources: { main: { connection: 'cas-db' } },
      auth: {
        roles: { staff: { read: true, write: false } },
        public: { read: ['item'] },
      },
      resources: { item: { access: 'write' } },
      views: {
        items: { kind: 'list', from: 'item' },
        hold: {
          kind: 'page',
          label: 'Hold',
          public: true,
          component: { id: 'page-hold', module: './pages/hold.page.tsx', kind: 'page' },
          reads: ['item'],
          commands: ['holdItem'],
          params: [],
        },
      },
      home: 'hold',
      nav: ['items'],
    },
    'cas claim refusal',
    { holdItem: { public: true, input: holdInput } },
  );

  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, 'cas-db', (owner) => releases.push(registry.lease(owner)));
    const { binding } = bindHttpBusinessCommands(app, commands, resources, (owner) => registry.configOf(owner)?.writable === true);

    const visitor = publicPrincipal(app.id, 'hold');
    await assert.rejects(
      () =>
        executeBusinessCommand(binding, visitor, {
          command: 'holdItem',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: 'cas-refuse-field-1',
          input: { item_id: 1 },
        }),
      (err: unknown) =>
        err instanceof BusinessCommandExecutionError &&
        err.code === 'invalid_input' &&
        err.field === 'item_id' &&
        err.message === 'This item is no longer available.',
    );
  } finally {
    for (const release of releases.reverse()) release();
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 6. First-paint pageLoads & SSR rendering of public custom pages ---------- */

test('roomReads plans pageLoads for record-bound custom pages and renderPublic SSR renders rows, cover images, formatted values, and SiteHeader', async () => {
  const schema = {
    tables: [
      {
        id: 'listing',
        name: 'Listing',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'title', type: 'text', nullable: false, primaryKey: false },
          { name: 'price', type: 'integer', nullable: false, primaryKey: false },
        ],
        cover: { from: 'listing_photo', whose: 'listing_id', photoKey: 'id', aspect: '3/2' },
      },
      {
        id: 'listing_photo',
        name: 'Listing Photo',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'listing_id', type: 'integer', nullable: false, primaryKey: false },
        ],
      },
    ],
    foreignKeys: [],
  };

  const payload = {
    id: 'northsite',
    name: 'North Site',
    home: 'door',
    nav: [],
    resources: {
      listing: {
        slug: true,
        display: { price: { format: 'money', currency: 'USD', minor: true, whole: true } },
      },
      listing_photo: {},
    },
    views: {
      catalog: { table: 'listing', label: 'Catalog', open: { page: 'detail', param: 'id' } },
      door: {
        label: 'Welcome',
        sections: [{ kind: 'custom', component: { id: 'page-door', kind: 'page' } }],
        page: { public: true, reads: ['listing'], commands: [], params: [], loader: 'featured' },
      },
      detail: {
        label: 'Listing Detail',
        sections: [{ kind: 'custom', component: { id: 'page-detail', kind: 'page' } }],
        page: { public: true, reads: ['listing'], commands: [], params: ['id'], loader: 'oneListing' },
      },
    },
    ui: {
      site: {
        links: [{ label: 'Catalog', view: 'catalog' }],
        cta: { label: 'Contact', href: 'https://example.com/contact' },
        signIn: 'footer' as const,
        footer: { text: '© 2026 North Site' },
      },
    },
  };

  /* 6a. roomReads plans scoped pageLoads for root home AND record-bound custom page `/detail/7-cedar-house`. */
  const homePlan = roomReads({
    app: 'northsite',
    path: '/northsite',
    search: '',
    payload: payload as never,
    schema: schema as never,
    pages: {},
    me: { public: true },
    visitor: true,
  });
  assert.equal(homePlan.reads.length, 1);
  assert.deepEqual(homePlan.reads[0]!.body, { page: 'door', params: {}, loader: 'featured', app: 'northsite' });

  const detailLoads = pageLoads(
    {
      app: 'northsite',
      path: '/northsite/detail/7-cedar-house',
      search: '',
      payload: payload as never,
      schema: schema as never,
      pages: {},
      me: { public: true },
      visitor: true,
    },
    [],
    { scoped: true },
  );
  assert.equal(detailLoads.length, 1);
  assert.deepEqual(detailLoads[0]!.body, { page: 'detail', params: { id: '7' }, loader: 'oneListing', app: 'northsite' });
});
