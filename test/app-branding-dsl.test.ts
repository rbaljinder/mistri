import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { typecheck } from './support/tsc.js';
import { fromRecord } from '../packages/mistri/schema/app.mjs';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { parseAppPages } from '../packages/mistri/src/shared/appPages.js';
import { appLook, parseUi } from '../packages/mistri/src/shared/appUi.js';
import { servedApp, servedUi } from '../packages/mistri/src/shared/appPayload.js';
import { parseRecordBranding } from '../packages/mistri/src/shared/branding.js';
import { type ColumnMeta, type DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { appBrandingCatalog, appPayload, appProblems, bindAppBranding, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { publicPrefillProblems } from '../packages/mistri/src/server/forms/publicPrefill.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';

const options = () => ({
  by: 'host',
  tenantField: 'tenant_id',
  publishedField: 'published',
  fallback: { preset: 'sage' },
  fields: {
    name: 'name',
    preset: 'base',
    accent: 'color',
    fontPair: 'font',
    barStyle: 'bar',
    logo: { from: 'asset', key: { id: 'logo_id' }, alt: 'Company logo' },
  },
});
const descriptor = () => fromRecord('profile', options());
const raw = (theme: unknown = descriptor()) => ({
  id: 'brand-desk',
  name: 'Brand desk',
  resources: { profile: { physical: 'brand_profile' }, asset: { file: { content: 'bytes', name: 'filename' } } },
  views: { profiles: { kind: 'list', from: 'profile', show: ['name'] } },
  home: 'profiles',
  ui: { theme },
});
const parse = (theme?: unknown) => parseAppConfig(raw(theme), 'branding fixture');
const column = (name: string, type = 'TEXT', primaryKey = false): ColumnMeta => ({ name, type, primaryKey, nullable: false });
const schema = (): DatabaseSchema => ({
  label: 'Branding',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'profile',
      name: 'profile',
      schema: '',
      isView: false,
      columns: [
        column('id', 'TEXT', true),
        column('tenant_id'),
        column('version', 'BIGINT'),
        column('published', 'BOOLEAN'),
        column('name'),
        column('base'),
        column('color'),
        column('font'),
        column('bar'),
        column('logo_id', 'INTEGER'),
        column('secret'),
      ],
    },
    {
      id: 'asset',
      name: 'asset',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('bytes', 'BLOB'), column('filename')],
    },
  ],
});
const loaded = (app: AppDef): LoadedApp => ({ app, path: '/example/app.ts', pages: [], sources: {} });

test('fromRecord helper is package-local plain data and normalization detaches a frozen spec and static fallback', () => {
  const input = descriptor(),
    ui = parseUi({ theme: input }, 'branding fixture');
  assert.deepEqual(input, { ...options(), kind: 'fromRecord', from: 'profile' });
  assert.deepEqual(ui.branding, parseRecordBranding(input));
  assert.deepEqual(ui.theme, { preset: 'sage' });
  assert.ok(Object.isFrozen(ui.branding));
  assert.ok(Object.isFrozen(ui.branding!.fields.logo!.key));
  assert.ok(Object.isFrozen(ui.theme));
  input.fields.name = 'secret';
  input.fallback.preset = 'mono';
  assert.equal(ui.branding!.fields.name, 'name');
  assert.equal(ui.theme!.preset, 'sage');
  assert.deepEqual(parseUi({ theme: { ...descriptor(), by: 'tenant' } }, 'fixture').branding!.by, 'tenant');
  assert.doesNotMatch(
    readFileSync(new URL('../packages/mistri/schema/app.mjs', import.meta.url), 'utf8'),
    /(?:from|import\()\s*['"][^'"]*src\//,
  );
});

test('static themes, appLook and browser payloads retain the fallback without the private descriptor', () => {
  for (const theme of [
    undefined,
    { preset: 'mono' },
    { accent: '#334455', radius: '4px', font: 'serif' },
    { preset: 'mono', palette: 'default' },
  ]) {
    const ui = parseUi({ theme }, 'fixture');
    assert.deepEqual(ui.theme, theme);
    assert.equal(ui.branding, undefined);
  }
  const app = parse(),
    before = JSON.stringify(app);
  assert.deepEqual(appLook(app), { id: 'brand-desk', name: 'Brand desk', theme: { preset: 'sage' } });
  for (const ui of [servedUi(app.ui), servedApp(app, schema()).ui]) {
    assert.equal(Object.hasOwn(ui, 'branding'), false);
    assert.deepEqual(ui.theme, { preset: 'sage' });
    assert.doesNotMatch(JSON.stringify(ui), /tenantField|brand_profile|fromRecord/);
  }
  assert.equal(JSON.stringify(app), before);
  const narrowed = schema();
  narrowed.tables[0].columns = narrowed.tables[0].columns.filter((column) => column.name !== 'version');
  const payload = appPayload(loaded(app), 'test-db', undefined, narrowed);
  assert.doesNotMatch(JSON.stringify(payload), /fromRecord|tenantField|branding column/);
  assert.equal(bindAppBranding(parseAppConfig(raw({ preset: 'mono' }), 'static'), schema()), undefined);
});

test('branding parser closes every descriptor layer and never accepts a separate ui.branding key', () => {
  const valid = descriptor();
  const malformed = [
    { ...valid, kind: 'storedCss' },
    { ...valid, by: 'query' },
    { ...valid, from: 'profile; SELECT' },
    { ...valid, tenantField: undefined },
    { ...valid, versionField: 'version' },
    { ...valid, publishedField: 1 },
    { ...valid, fallback: {} },
    { ...valid, fallback: { preset: 'custom' } },
    { ...valid, fallback: { preset: 'sage', css: 'body{}' } },
    { ...valid, css: 'body{}' },
    { ...valid, fields: { css: 'secret' } },
    { ...valid, fields: { accent: '#334455' } },
    { ...valid, fields: { logo: { href: 'https://example.test/logo.png' } } },
    { ...valid, fields: { logo: { from: 'asset', key: {} } } },
    { ...valid, fields: { logo: { from: 'asset', key: { id: 'logo_id' }, alt: ' ' } } },
    { ...valid, fields: { name: () => 'secret' } },
    { ...valid, fields: { name: { column: 'name' } } },
  ];
  for (const theme of malformed) assert.throws(() => parseUi({ theme }, 'fixture'), /ui.theme fromRecord/);
  assert.throws(() => parseUi({ theme: { preset: 'mono' }, branding: valid }, 'fixture'), /branding/);
  let reads = 0;
  const accessor = Object.defineProperty({ ...valid }, 'fields', {
    enumerable: true,
    get() {
      reads++;
      return {};
    },
  });
  assert.throws(() => parseUi({ theme: accessor }, 'fixture'), /Invalid branding property/);
  assert.equal(reads, 0);
});

test('catalog adapter binds logical declared resources, exact file keys and detached immutable metadata', () => {
  const app = parse(),
    meta = schema();
  const catalog = appBrandingCatalog(app, meta),
    binding = bindAppBranding(app, meta)!;
  assert.deepEqual(binding.columns, ['bar', 'base', 'color', 'font', 'id', 'logo_id', 'name', 'published', 'tenant_id', 'version']);
  assert.equal(catalog.resources.profile.columns.version, 'integer');
  assert.equal(catalog.resources.profile.columns.published, 'boolean');
  assert.equal(catalog.resources.asset.file, true);
  assert.equal(catalog.resources.brand_profile, undefined);
  assert.ok(Object.isFrozen(catalog.resources.profile.columns));
  assert.ok(Object.isFrozen(binding));
  meta.tables[0].columns.find((c) => c.name === 'version')!.type = 'TEXT';
  assert.equal(catalog.resources.profile.columns.version, 'integer');
  assert.deepEqual(appProblems(loaded(app), schema()), []);
  const flag = schema();
  Object.assign(
    flag.tables[0].columns.find((c) => c.name === 'published')!,
    { type: 'INTEGER', flag: true },
  );
  assert.equal(bindAppBranding(app, flag)!.columnKinds.published, 'boolean');
});

test('catalog binding refuses missing, hidden and incompatible branding columns with authoring context', () => {
  const cases: Array<[string, (app: AppDef, meta: DatabaseSchema) => void]> = [
    [
      'undeclared resource',
      (app) => {
        delete app.resources!.profile;
      },
    ],
    [
      'text version',
      (_app, meta) => {
        meta.tables[0].columns.find((c) => c.name === 'version')!.type = 'TEXT';
      },
    ],
    [
      'fractional version',
      (_app, meta) => {
        meta.tables[0].columns.find((c) => c.name === 'version')!.type = 'NUMERIC';
      },
    ],
    [
      'numeric tenant',
      (_app, meta) => {
        meta.tables[0].columns.find((c) => c.name === 'tenant_id')!.type = 'INTEGER';
      },
    ],
    [
      'text publication',
      (_app, meta) => {
        meta.tables[0].columns.find((c) => c.name === 'published')!.type = 'TEXT';
      },
    ],
    [
      'numeric content',
      (_app, meta) => {
        meta.tables[0].columns.find((c) => c.name === 'name')!.type = 'INTEGER';
      },
    ],
    [
      'JSON content',
      (_app, meta) => {
        meta.tables[0].columns.find((c) => c.name === 'name')!.type = 'JSON';
      },
    ],
    [
      'resource hidden',
      (app) => {
        app.resources!.profile.hidden = ['name'];
      },
    ],
    [
      'resource column ceiling',
      (app) => {
        app.resources!.profile.fields = { read: ['id', 'version', 'published', 'tenant_id'] };
      },
    ],
    [
      'no primary key',
      (_app, meta) => {
        meta.tables[0].columns[0].primaryKey = false;
      },
    ],
    [
      'file not declared',
      (app) => {
        delete app.resources!.asset.file;
      },
    ],
    [
      'invalid file definition',
      (_app, meta) => {
        meta.tables[1].columns.find((c) => c.name === 'bytes')!.type = 'TEXT';
      },
    ],
    [
      'file key mismatch',
      (_app, meta) => {
        meta.tables[1].columns[0].name = 'asset_id';
      },
    ],
    [
      'file key type mismatch',
      (_app, meta) => {
        meta.tables[1].columns[0].type = 'TEXT';
      },
    ],
    [
      'hidden file key',
      (app) => {
        app.resources!.asset.hidden = ['id'];
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const app = parse(),
      meta = schema();
    mutate(app, meta);
    assert.throws(() => bindAppBranding(app, meta), /ui.theme fromRecord "profile":/, name);
    assert.ok(
      appProblems(loaded(app), meta).some((problem) => problem.includes('ui.theme fromRecord "profile"')),
      name,
    );
  }
});

test('JSON schema accepts static and record themes and agrees with closed descriptor parsing', () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  ajv.addSchema(read('theme'));
  ajv.addSchema(read('page'));
  const validate = ajv.compile(read('app'));
  for (const theme of [descriptor(), { preset: 'mono' }, { accent: '#123456' }]) {
    assert.equal(validate(raw(theme)), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => parse(theme));
  }
  for (const theme of [
    { ...descriptor(), preset: 'mono' },
    { ...descriptor(), fallback: { preset: 'url(evil)' } },
    { ...descriptor(), fields: { css: 'name' } },
    { ...descriptor(), fields: { logo: { from: 'asset', key: { id: 'logo_id' }, href: '/file' } } },
  ]) {
    assert.equal(validate(raw(theme)), false, JSON.stringify(theme));
    assert.throws(() => parse(theme));
  }
  assert.equal(validate({ ...raw(), ui: { branding: descriptor() } }), false);
});

test('local headline validation narrows view actions and leaves checked targets to their owner', () => {
  const input = {
    ...raw({ preset: 'mono' }),
    pages: {
      profile: {
        base: 'profile',
        sections: [
          {
            kind: 'headline',
            show: ['name'],
            links: [
              { label: 'Other App', to: { app: 'other', kind: 'view', view: 'there' } },
              { label: 'Local', to: 'profiles' },
            ],
          },
        ],
      },
    },
  };
  const app = parseAppConfig(input, 'fixture'),
    pages = parseAppPages(input, 'fixture');
  assert.deepEqual(publicPrefillProblems(app, pages, schema()), []);
  assert.deepEqual(appProblems({ ...loaded(app), pages }, schema()), []);
  input.pages.profile.sections[0].links[1].to = 'missing';
  const missing = parseAppPages(input, 'fixture');
  assert.ok(appProblems({ ...loaded(app), pages: missing }, schema()).some((problem) => problem.includes('opens "missing"')));
});

test('local public-form prefill still enforces published fields and prefillable inputs beside checked targets', () => {
  const input = {
    ...raw({ preset: 'mono' }),
    pages: {
      profile: {
        base: 'profile',
        sections: [
          {
            kind: 'headline',
            show: ['name'],
            links: [
              { label: 'Other App', to: { app: 'other', kind: 'view', view: 'there' } },
              { label: 'Ask', to: 'ask', prefill: { note: 'name' } },
            ],
          },
        ],
      },
    },
  };
  const app = {
    ...parse(),
    views: {
      ...parse().views,
      ask: {
        kind: 'form',
        label: 'Ask',
        public: true,
        prefillable: ['note'],
        command: { id: 'ask', version: 1, input: [{ name: 'note', label: 'Note', type: 'text', required: true }] },
      },
    },
    auth: { public: { read: ['profile'], fields: { profile: { read: ['id', 'name'] } } } },
  } as unknown as AppDef;
  assert.deepEqual(publicPrefillProblems(app, parseAppPages(input, 'fixture'), schema()), []);
  input.pages.profile.sections[0].links[1].prefill!.note = 'secret';
  assert.match(publicPrefillProblems(app, parseAppPages(input, 'fixture'), schema())[0].problem, /public grant does not open/);
  input.pages.profile.sections[0].links[1].prefill!.note = 'name';
  const unfillable = { ...app, views: { ...app.views, ask: { ...app.views.ask, prefillable: [] } } } as AppDef;
  assert.match(publicPrefillProblems(unfillable, parseAppPages(input, 'fixture'), schema())[0].problem, /does not name prefillable/);
});

test('generated App types check record branding resource/columns, file references and static preset names', () => {
  const filename = new URL('./.branding-types.ts', import.meta.url).pathname;
  const generated = new URL('./.branding-schema.d.ts', import.meta.url).pathname;
  const source = `import { defineApp, fromRecord, type AppConfig, type AppUi, listView } from '@mistriwork/mistri/app';
    import type { App } from './.branding-schema.js';
    const options = {by:'host',tenantField:'tenant_id',publishedField:'published',fallback:{preset:'sage'},fields:{name:'name'}} as const;
    const base = {name:'Brand',resources:{profile:{},asset:{}},views:{profiles:listView('Profile', 'profile')},home:'profiles'} as const;
    defineApp({...base,ui:{theme:fromRecord('profile',options)}} satisfies App);
    defineApp({...base,ui:{theme:fromRecord('profile',{...options,fields:{logo:{from:'asset',key:{id:'logo_id'}}}})}} satisfies App);
    defineApp({...base,ui:{theme:{preset:'mono'}}} satisfies App);
    const loose: AppConfig = {...base,ui:{theme:fromRecord('profile',options)}};
    // @ts-expect-error no authorable internal branding field
    const internal: AppUi = {branding:fromRecord('profile',options)};
    // @ts-expect-error unknown resource in generated schema
    const resource: App = {...base,ui:{theme:fromRecord('missing',options)}};
    // @ts-expect-error defineApp also checks the declared resource without a generated schema
    defineApp({...base,ui:{theme:fromRecord('missing',options)}});
    // @ts-expect-error hidden column is absent from generated readable columns
    const hidden: App = {...base,ui:{theme:fromRecord('profile',{...options,fields:{name:'secret'}})}};
    // @ts-expect-error unknown content column
    const field: App = {...base,ui:{theme:fromRecord('profile',{...options,fields:{name:'missing'}})}};
    // @ts-expect-error image source is a resource
    const image: App = {...base,ui:{theme:fromRecord('profile',{...options,fields:{logo:{from:'missing',key:{id:'logo_id'}}}})}};
    // @ts-expect-error image key values are columns of the branding record
    const imageColumn: App = {...base,ui:{theme:fromRecord('profile',{...options,fields:{logo:{from:'asset',key:{id:'missing'}}}})}};
    // @ts-expect-error file key names belong to the file resource (catalog checks the exact primary key)
    const imageKey: App = {...base,ui:{theme:fromRecord('profile',{...options,fields:{logo:{from:'asset',key:{missing:'logo_id'}}}})}};
    // @ts-expect-error no CSS fallback
    fromRecord('profile',{...options,fallback:{preset:'url(evil)'}});
    // @ts-expect-error no extra top-level helper options
    fromRecord('profile',{...options,css:'body{}'});
    // @ts-expect-error static preset references remain checked
    defineApp({...base,ui:{theme:{preset:'missing'}}});
  `;
  const files = new Map([
    [filename, source],
    [generated, typesForSchema(schema(), 'Branding', undefined, { profile: ['secret'] })],
  ]);
  assert.equal(typecheck(filename, { files: Object.fromEntries(files) }), '');
});
