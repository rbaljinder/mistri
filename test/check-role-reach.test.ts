/**
 * `mistri check` names what a role meets only when it signs in. Each
 * case is a mistake a Keystone App was built with and found at runtime: a
 * rollup over the bureau score some roles may not read cost them the queue's
 * presentation; a record name over it read "(row)"; a page naming a column one role may not
 * read opened on the default anatomy for that role; a command granted to a
 * role that cannot read its footprint lost its buttons; a write grant whose
 * columns cannot make a row offered a New that always failed; a resource with
 * no `access` granted nothing while the refusal blamed the role; and a public
 * form whose command answered no reference failed every submission.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appRoleReach, appRoleWarnings, sectionReads } from '../packages/mistri/src/server/app/appRoleChecks.js';
import { accessibleSchema } from '../packages/mistri/src/server/app/appAccess.js';
import { publicFormProblems } from '../packages/mistri/src/server/forms/savedFormChecks.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/pageConfig.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { PageSection } from '../packages/engine/src/shared/pageModel.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { parseTestApp } from './support/commandCatalog.js';

const column = (name: string, type = 'TEXT', more: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...more,
});
const id = column('id', 'INTEGER', { primaryKey: true, nullable: false, identity: 'by-default' });
const schema = {
  label: 'lender',
  dialect: 'sqlite',
  readAt: '2026-09-26T00:00:00Z',
  tables: [
    { id: 'application', name: 'application', schema: 'main', columns: [id, column('reference'), column('status')] },
    {
      id: 'file',
      name: 'file',
      schema: 'main',
      columns: [
        id,
        column('application_id', 'INTEGER', { references: { table: 'application', column: 'id' } }),
        column('score', 'INTEGER'),
        column('bureau'),
      ],
    },
    { id: 'dealer', name: 'dealer', schema: 'main', columns: [id, column('name'), column('intake_address')] },
    {
      id: 'vehicle',
      name: 'vehicle',
      schema: 'main',
      columns: [
        id,
        column('stock_number', 'TEXT', { nullable: false }),
        column('price', 'INTEGER'),
        column('featured', 'INTEGER', { nullable: false, default: '0' }),
      ],
    },
    {
      id: 'saved',
      name: 'saved',
      schema: 'main',
      columns: [id, column('vehicle_id', 'INTEGER', { references: { table: 'vehicle', column: 'id' } })],
    },
  ],
  foreignKeys: [
    { name: 'file_application', from: { table: 'file', columns: ['application_id'] }, to: { table: 'application', columns: ['id'] } },
    { name: 'saved_vehicle', from: { table: 'saved', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } },
  ],
} as DatabaseSchema;

const WITHOUT_BUREAU = ['id', 'application_id'];
function lender(
  options: {
    admin?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    pages?: unknown[];
    roles?: Record<string, unknown>;
    views?: Record<string, unknown>;
  } = {},
) {
  const app = parseTestApp(
    {
      id: 'lender',
      name: 'Lender',
      sources: { main: { connection: 'db', default: true } },
      resources: {
        application: { access: 'write', rollups: { best_score: { fn: 'max', from: 'file', column: 'score' } } },
        file: { access: 'write', recordLabel: 'File {score}' },
        dealer: {},
        vehicle: { access: 'write' },
        saved: { access: 'write' },
        ...options.resources,
      },
      auth: {
        roles: {
          underwriter: { read: true },
          admin: options.admin ?? { read: true, fields: { file: { read: WITHOUT_BUREAU } } },
          funder: { read: true, fields: { file: { read: WITHOUT_BUREAU } } },
          ...options.roles,
        },
      },
      views: { applications: { kind: 'list', from: 'application' }, ...options.views },
      home: 'applications',
      nav: ['applications'],
    },
    'lender fixture',
  );
  const pages = parsePagesConfig({ pages: options.pages ?? [] }, 'pages');
  return { app, path: '/apps/lender/app.ts', pages, sources: {} } as unknown as LoadedApp;
}

describe('a rollup, a record name or a page a role cannot read', () => {
  test('a record name over a column some roles cannot read is refused, the roles and the column named once', () => {
    const { problems } = appRoleReach(lender(), schema);
    assert.deepEqual(problems, [
      'app.ts: resources "file", recordLabel [role-cannot-read]: roles "admin" and "funder" cannot read "file.score", ' +
        'so its records have no name there and read "(row)". Add "score" to fields.file.read in each role\'s grant, or name the record by columns every role reads.',
    ]);
  });

  test('a list showing a rollup over a column a role cannot read is said: dropped, or drawn without its presentation', () => {
    const shows = (view: Record<string, unknown>) =>
      appRoleReach(
        lender({
          roles: { funder: { read: true } },
          resources: { file: { access: 'write' } },
          views: { best: { kind: 'list', from: 'application', ...view } },
        }),
        schema,
      ).warnings;
    assert.deepEqual(shows({ show: ['reference', 'best_score'] }), [
      'app.ts: view "best" [role-cannot-read]: it names the rollup "application.best_score", ' +
        'which reads "file.score", which role "admin" cannot read, so the view is not served to that role. Add "score" to roles.admin.fields.file.read, or leave it out of the view.',
    ]);
    assert.match(
      shows({ presentation: { kind: 'queue', primary: 'reference', properties: ['best_score'] } }).join('\n'),
      /view "best" \[role-cannot-read\]: its presentation names the rollup "application\.best_score", [\s\S]*so the view is drawn as a plain grid for that role\./,
    );
    // A rollup nothing shows is nobody's loss.
    assert.deepEqual(shows({ show: ['reference'] }), []);
  });

  test('a role only the API or a job principal holds is told nothing, unless a person signs in with it too', () => {
    const named = (reach: { problems: string[] }) => reach.problems.join('\n');
    // A job principal's role: no one opens a list or a page under it.
    assert.match(named(appRoleReach(lender(), schema, new Set(['funder']))), /role "admin" cannot read "file\.score"/);
    assert.doesNotMatch(named(appRoleReach(lender(), schema, new Set(['funder']))), /funder/);
    // The API's role, the same; and a home rule naming it makes it a person's again.
    const api = (loaded: LoadedApp, home?: unknown) =>
      ({ ...loaded, app: { ...loaded.app, api: { roles: ['funder'] }, ...(home ? { home } : {}) } }) as unknown as LoadedApp;
    assert.doesNotMatch(named(appRoleReach(api(lender()), schema)), /funder/);
    assert.match(
      named(appRoleReach(api(lender(), [{ view: 'applications', roles: ['funder'] }, { view: 'applications' }]), schema)),
      /roles "admin" and "funder"/,
    );
  });

  test('one role is told by its own grant; a role that reads every column is told nothing', () => {
    const one = appRoleReach(lender({ roles: { funder: { read: true } } }), schema).problems;
    assert.match(one[0], /role "admin" cannot read "file\.score"[\s\S]*Add "score" to roles\.admin\.fields\.file\.read/);
    assert.deepEqual(appRoleReach(lender({ admin: { read: true }, roles: { funder: { read: true } } }), schema), {
      problems: [],
      warnings: [],
    });
  });

  test('a page naming a column a role cannot read is a warning that the page leaves that section out, naming the section and the column', () => {
    const { warnings } = appRoleReach(
      lender({
        admin: { read: true, fields: { dealer: { read: ['id', 'name'] } } },
        roles: { funder: { read: true } },
        pages: [
          {
            id: 'dealer',
            label: 'Dealer',
            base: 'dealer',
            sections: [
              { kind: 'header', facts: ['name'] },
              { kind: 'fields', title: 'Dealership', show: ['name', 'intake_address'] },
            ],
          },
        ],
      }),
      schema,
    );
    assert.deepEqual(warnings, [
      'app.ts: page "Dealer" [role-cannot-read]: its section "Dealership" names "dealer.intake_address", which role "admin" cannot read, ' +
        'so the page leaves it out for that role. Add "intake_address" to roles.admin.fields.dealer.read, or leave it out of the page.',
    ]);
  });

  test("a header fact a role cannot read is named as the header's", () => {
    const { warnings } = appRoleReach(
      lender({
        roles: { funder: { read: true } },
        resources: { file: { access: 'write' } },
        pages: [{ id: 'file', label: 'File', base: 'file', sections: [{ kind: 'header', facts: ['application_id', 'bureau'] }] }],
      }),
      schema,
    );
    assert.match(warnings.join('\n'), /page "File" \[role-cannot-read\]: its header names "file\.bureau", which role "admin" cannot read/);
  });
  test('a related list a role reads but cannot add to keeps the section, without its New, and is not a warning', () => {
    const files = { kind: 'list', title: 'Files', from: 'file', whose: 'application_id', show: ['application_id'], create: 'Add file' };
    const { warnings } = appRoleReach(
      // Admin and funder read files (not the bureau) and write none of them.
      lender({
        pages: [
          {
            id: 'application',
            label: 'Application',
            base: 'application',
            sections: [{ kind: 'fields', title: 'Summary', show: ['reference'] }, files],
          },
          // A headline's earlier figure is the same: a role that cannot read it sees the figure alone.
          {
            id: 'file',
            label: 'File',
            base: 'file',
            sections: [{ kind: 'headline', show: ['application_id'], was: 'score' }],
          },
        ],
      }),
      schema,
    );
    assert.deepEqual(warnings, []);
  });
});

describe('grants that do less than they say', () => {
  const save = defineCommand({
    targets: 'none',
    source: 'main',
    target: 'saved',
    read: ['vehicle'],
    input: {},
    output: shape({}),
    async handle() {
      return {};
    },
  });
  const registry = { save } as unknown as BusinessCommandRegistry;

  test('a command granted to a role that cannot read its footprint is said, naming the table', () => {
    const loaded = lender({ roles: { customer: { read: ['saved'], commands: ['save'] } } });
    const said = appRoleWarnings(loaded, schema, registry).filter((line) => line.includes('[command-unreadable]'));
    assert.deepEqual(said, [
      'app.ts: role "customer" [command-unreadable]: it is granted command "save", which reads "vehicle"; the role does not read it, ' +
        "so the command's actions and form are never offered to it. Add it to roles.customer.read, or take the command from the role.",
    ]);
    const reads = lender({ roles: { customer: { read: ['saved', 'vehicle'], commands: ['save'] } } });
    assert.deepEqual(
      appRoleWarnings(reads, schema, registry).filter((line) => line.includes('[command-unreadable]')),
      [],
    );
  });

  test('a write grant whose columns cannot make a row offers no New, and is said where the App asks for one', () => {
    const manager = {
      read: true,
      write: ['vehicle'],
      fields: { vehicle: { read: ['id', 'stock_number', 'price', 'featured'], write: ['price', 'featured'] } },
    };
    const withForm = lender({ roles: { manager }, resources: { vehicle: { access: 'write', form: { show: ['price', 'featured'] } } } });
    assert.deepEqual(
      appRoleWarnings(withForm, schema).filter((line) => line.includes('[new-cannot-form]')),
      [
        'app.ts: role "manager" [new-cannot-form]: it writes "vehicle" but not "stock_number", which a new row needs, so it can edit vehicle rows and New is never offered to it. ' +
          'Add it to roles.manager.fields.vehicle.write, make the rows with a command, or say the role edits and never creates them (roles.manager.create).',
      ],
    );
    // Edit-only on purpose: nothing asks for a New, so nothing is said.
    assert.deepEqual(
      appRoleWarnings(lender({ roles: { manager } }), schema).filter((line) => line.includes('[new-cannot-form]')),
      [],
    );
    // Or said by the role: it edits vehicles and never makes one.
    const editsOnly = lender({
      roles: { manager: { ...manager, create: false as const } },
      resources: { vehicle: { access: 'write', form: { show: ['price', 'featured'] } } },
    });
    assert.deepEqual(
      appRoleWarnings(editsOnly, schema).filter((line) => line.includes('[new-cannot-form]')),
      [],
    );
    assert.equal(
      accessibleSchema(schema, resolveAppAccess(editsOnly.app, schema, ['manager'])).tables.find((table) => table.id === 'vehicle')!
        .insertable,
      false,
    );
    // And the catalog that role is served says so: its rows can be edited, never made.
    const served = accessibleSchema(schema, resolveAppAccess(withForm.app, schema, ['manager']));
    assert.equal(served.tables.find((table) => table.id === 'vehicle')!.insertable, false);
    const whole = accessibleSchema(schema, resolveAppAccess(withForm.app, schema, ['manager', 'underwriter']));
    assert.equal(whole.tables.find((table) => table.id === 'application')!.insertable, undefined);
  });

  /* customer: a borrower edits their profile, whose applicant_id points at a
     table the App never declares; only a write that sets it is refused. */
  test('a written column that references a table the role cannot read is said, and the rest of the row is not', () => {
    const said = (roles: Record<string, unknown>) =>
      appRoleWarnings(lender({ roles }), schema).filter((line) => line.includes('[write-unreadable-parent]'));
    assert.deepEqual(said({ clerk: { read: ['saved'], write: ['saved'] } }), [
      'app.ts: role "clerk" [write-unreadable-parent]: it writes "saved".vehicle_id, which references "vehicle", and the role does not read it: ' +
        'a write that sets it is refused, while the rest of the row edits. Let the role read "vehicle", or leave the column out of roles.clerk.fields.saved.write.',
    ]);
    assert.deepEqual(said({ clerk: { read: ['saved', 'vehicle'], write: ['saved'] } }), []);
    assert.deepEqual(
      said({ clerk: { read: ['saved'], write: ['saved'], fields: { saved: { read: ['id', 'vehicle_id'], write: ['id'] } } } }),
      [],
    );
  });

  test('a role writing a resource that is only read is told the resource is why', () => {
    assert.throws(
      () => lender({ admin: { read: true, write: ['dealer'] } }),
      /"write" names "dealer", and resources "dealer" is not written \(it has no access 'write'\) \[outside-ceiling\][\s\S]*resources\.dealer\.access: 'write' \(a command's target needs it too\)/,
    );
  });
});

describe('a public form answers a reference', () => {
  const form = {
    kind: 'form',
    label: 'Ask',
    public: true,
    done: { title: 'Sent' },
    command: { id: 'ask', version: 1, input: { note: { label: 'Note', type: 'text' } } },
    steps: [{ id: 'one', label: 'One', fields: ['note'] }],
  };
  const app = parseTestApp(
    {
      id: 'ask',
      name: 'Ask',
      sources: { main: { connection: 'db', default: true } },
      resources: { saved: { access: 'write' } },
      auth: { roles: { user: { read: true } } },
      views: { saved: { kind: 'list', from: 'saved' }, ask: form },
      home: 'saved',
      nav: ['saved'],
    },
    'public form fixture',
  );
  const command = (output: ReturnType<typeof shape>) =>
    defineCommands({
      ask: defineCommand({
        targets: 'none',
        source: 'main',
        target: 'saved',
        public: true,
        input: { note: { label: 'Note', type: 'text' } },
        output,
        async handle() {
          return {};
        },
      }),
    });

  test('an output without a reference is refused at load, not on every submission', () => {
    assert.match(
      publicFormProblems(app, command(shape({ message: literal('Sent.') })), schema) ?? '',
      /Form "ask": Command "ask" answers a public form \[public-form-reference\], and its output has no reference: every submission would be refused after it ran\./,
    );
    assert.equal(publicFormProblems(app, command(shape({ reference: text(), message: literal('Sent.') })), schema), undefined);
    assert.equal(publicFormProblems(app, command(shape({ reference: text() })), schema), undefined);
  });
});

describe('a public form picks only from what auth.public opens', () => {
  const vehicle = { type: 'reference', from: 'vehicle', by: 'id', labelColumn: 'stock_number', label: 'Vehicle' } as const;
  const app = (publicGrant?: object) =>
    parseTestApp(
      {
        id: 'ask',
        name: 'Ask',
        sources: { main: { connection: 'db', default: true } },
        resources: { saved: { access: 'write' }, vehicle: {} },
        auth: { roles: { user: { read: true } }, ...(publicGrant ? { public: publicGrant } : {}) },
        views: {
          saved: { kind: 'list', from: 'saved' },
          ask: {
            kind: 'form',
            label: 'Ask',
            public: true,
            done: { title: 'Sent' },
            command: { id: 'ask', version: 1, input: { vehicle } },
            steps: [{ id: 'one', label: 'One', fields: ['vehicle'] }],
          },
        },
        home: 'saved',
        nav: ['saved'],
      },
      'public picker fixture',
    );
  const registry = defineCommands({
    ask: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'saved',
      public: true,
      read: ['vehicle'],
      input: { vehicle },
      output: shape({ reference: text() }),
      async handle() {
        return { reference: 'A-1' };
      },
    }),
  });

  test('a resource the public does not read, or a label column it may not, is refused by name; one it reads is served', () => {
    assert.match(
      publicFormProblems(app(), registry, schema) ?? '',
      /Form "ask": Command "ask" input "vehicle" \[public-form-picker\] is a picker over "vehicle" on a public form, and "auth.public" does not open "vehicle"/,
    );
    assert.match(
      publicFormProblems(app({ read: ['saved'] }), registry, schema) ?? '',
      /\[public-form-picker\][^\n]*does not open "vehicle"/,
    );
    assert.match(
      publicFormProblems(app({ read: ['vehicle'], fields: { vehicle: { read: ['id', 'price'] } } }), registry, schema) ?? '',
      /\[public-form-picker\][^\n]*a visitor may not read its column "stock_number"/,
    );
    assert.equal(publicFormProblems(app({ read: ['vehicle'] }), registry, schema), undefined);
    // The key stays readable however the fields narrow it, as a public read keeps it.
    assert.equal(
      publicFormProblems(app({ read: ['vehicle'], fields: { vehicle: { read: ['stock_number'] } } }), registry, schema),
      undefined,
    );
  });

  test("a public page's public command offers rows by the same read, and is refused by name the same way", () => {
    const choice = { type: 'choice', from: 'vehicle', labelColumn: 'stock_number', label: 'Vehicle' } as const;
    const paged = (publicGrant: object) =>
      parseTestApp(
        {
          id: 'ask',
          name: 'Ask',
          sources: { main: { connection: 'db', default: true } },
          resources: { saved: { access: 'write' }, vehicle: {} },
          auth: { roles: { user: { read: true } }, public: publicGrant },
          views: {
            saved: { kind: 'list', from: 'saved' },
            lobby: {
              kind: 'page',
              label: 'Lobby',
              component: { id: 'page-lobby', module: './pages/lobby.page.tsx', kind: 'page' },
              reads: ['saved'],
              commands: ['ask'],
              public: true,
            },
          },
          home: [{ view: 'lobby', signedOut: true }, { view: 'saved' }],
          nav: ['saved'],
        },
        'public page picker fixture',
        { ask: { public: true, input: { vehicle: choice } } },
      );
    const commands = defineCommands({
      ask: defineCommand({
        targets: 'none',
        source: 'main',
        target: 'saved',
        public: true,
        read: ['vehicle'],
        input: { vehicle: choice },
        output: shape({ reference: text() }),
        async handle() {
          return { reference: 'A-1' };
        },
      }),
    });
    assert.match(
      publicFormProblems(paged({ read: ['saved'] }), commands, schema) ?? '',
      /Page "lobby": Command "ask" input "vehicle" \[public-form-picker\] offers the rows over "vehicle" on a public page, and "auth.public" does not open "vehicle"/,
    );
    assert.match(
      publicFormProblems(paged({ read: ['saved', 'vehicle'], fields: { vehicle: { read: ['id', 'price'] } } }), commands, schema) ?? '',
      /Page "lobby": [^\n]*a visitor may not read its column "stock_number"/,
    );
    assert.equal(publicFormProblems(paged({ read: ['saved', 'vehicle'] }), commands, schema), undefined);
  });
});

describe('every page section kind is judged for a role', () => {
  /* The switch once ended in `default: return []`, so a kind it did not know named nothing a role could not read. */
  test('a section kind the check does not know is refused, not passed', () => {
    const unknown = { kind: 'gallery', from: 'file', path: 'application_id' } as unknown as PageSection;
    assert.throws(() => sectionReads(schema, 'application', unknown), /Unknown page section kind: "gallery"/);
  });

  test('the kinds that read nothing of their own name nothing', () => {
    for (const kind of ['note', 'history', 'flows', 'diagram'])
      assert.deepEqual(sectionReads(schema, 'application', { kind } as unknown as PageSection), [], kind);
  });

  test('a related list names what it reads, on the table it reads it from', () => {
    const list = { kind: 'list', from: 'file', path: 'application_id', columns: ['score'] } as unknown as PageSection;
    assert.deepEqual(sectionReads(schema, 'application', list), [
      { from: 'file', path: 'application_id' },
      { from: 'file', path: 'score' },
    ]);
  });
});
