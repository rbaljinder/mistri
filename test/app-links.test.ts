import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { appLink } from '../packages/mistri/schema/app.mjs';
import { bindAppTarget, parseAppTarget, parseAppLinkAction } from '../packages/engine/src/shared/appLinks.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parseAppPages } from '../packages/mistri/src/shared/appPages.js';
import { withAvailableEmptyActions, withAvailablePageEmptyActions } from '../packages/mistri/src/shared/appPayload.js';

const target = { app: 'lender', kind: 'record', resource: 'application', key: { id: { column: 'id' } } } as const;
const manifest = (action: unknown) => ({
  id: 'leads',
  name: 'Leads',
  resources: { application: {} },
  home: 'overview',
  views: { overview: { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'note', text: 'Continue', action }] } },
});

test('closed destinations and record-only bindings; helper is data-only', () => {
  assert.equal(appLink(target), target);
  assert.deepEqual(parseAppTarget(target, 'link', true), target);
  assert.throws(() => parseAppTarget(target), /record surface/);
  for (const malformed of [
    { app: 'lender', kind: 'home', view: 'work' },
    { app: 'lender', kind: 'view' },
    { app: 'lender', kind: 'view', view: '../work' },
    { ...target, view: 'work' },
    { ...target, href: '/elsewhere' },
    { ...target, key: {} },
    { ...target, key: { id: null } },
    { ...target, key: { id: undefined } },
    { ...target, key: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...target, key: { id: 1.5 } },
    { ...target, key: { id: { column: 'hidden.id' } } },
    { app: 'lender', kind: 'home', tenant: { kind: 'choose', id: 'north' } },
    { app: 'lender', kind: 'home', tenant: { kind: 'tenant', id: '@platform' } },
  ])
    assert.throws(() => parseAppTarget(malformed, 'link', true), JSON.stringify(malformed));
  assert.throws(() => parseAppLinkAction({ label: 'Open', view: 'work', to: target }, 'action', true), /unsupported field/);
});

test('binding uses only fields served to this reader and rechecks scalar/tenant grammar', () => {
  const bound = bindAppTarget(target, { id: '9007199254740993' }, ['id']);
  assert.deepEqual(bound, { ...target, key: { id: '9007199254740993' } });
  for (const row of [{}, { id: null }, { id: undefined }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: { from: 'other' } }]) {
    assert.throws(() => bindAppTarget(target, row, ['id']));
  }
  assert.throws(() => bindAppTarget(target, { id: '1' }, []), /unavailable source field/);
  assert.throws(
    () =>
      bindAppTarget({ ...target, tenant: { kind: 'tenant', id: { column: 'dealer' } } }, { id: '1', dealer: '@platform' }, [
        'id',
        'dealer',
      ]),
    /tenant selector/,
  );
});

test('dashboard and page notes/headlines accept cross-App actions and retain local actions', () => {
  const action = { label: 'Open', to: { app: 'lender', kind: 'view', view: 'applications' } } as const;
  const app = parseAppConfig(manifest(action), 'fixture');
  assert.deepEqual((app.views.overview as { sections: Array<{ action?: unknown }> }).sections[0].action, action);
  assert.doesNotThrow(() => parseAppConfig(manifest({ label: 'Local', to: 'overview' }), 'fixture'));
  assert.throws(() => parseAppConfig(manifest({ label: 'Record', to: target }), 'fixture'), /record surface/);
  const pages = parseAppPages(
    {
      ...manifest(action),
      pages: {
        application: {
          base: 'application',
          sections: [
            { kind: 'note', text: 'Open file', action: { label: 'Lender', to: target } },
            { kind: 'headline', show: ['id'], links: [{ label: 'Lender', to: target }] },
          ],
        },
      },
    },
    'fixture',
  );
  assert.equal(pages.length, 1);
  assert.deepEqual(withAvailablePageEmptyActions(pages, { views: {} }), pages);
  const payload = { views: { overview: app.views.overview } } as Parameters<typeof withAvailableEmptyActions>[0];
  assert.deepEqual(withAvailableEmptyActions(payload), payload);
  assert.throws(
    () =>
      parseAppPages(
        {
          pages: {
            application: {
              base: 'application',
              sections: [{ kind: 'headline', show: ['id'], links: [{ label: 'Lender', to: target, open: 'modal' }] }],
            },
          },
        },
        'fixture',
      ),
    /open/,
  );
});

test('JSON schema agrees on closed variants, scalar limits and record-only bindings', () => {
  const ajv = new Ajv2020({ strict: false });
  for (const name of ['theme', 'page', 'app'])
    ajv.addSchema(JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8')));
  const validate = ajv.getSchema('app.schema.json#/$defs/appTarget')!;
  for (const raw of [target, { app: 'lender', kind: 'home' }, { app: 'lender', kind: 'view', view: 'work', tenant: { kind: 'platform' } }])
    assert.equal(validate(raw), true, JSON.stringify(validate.errors));
  for (const raw of [
    { ...target, href: '/x' },
    { ...target, key: {} },
    { ...target, key: { id: null } },
    { ...target, key: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { app: 'lender', kind: 'home', view: 'work' },
  ])
    assert.equal(validate(raw), false);
  const app = ajv.getSchema('app.schema.json')!;
  assert.equal(app(manifest({ label: 'Open', to: { app: 'lender', kind: 'home' } })), true, JSON.stringify(app.errors));
  assert.equal(app(manifest({ label: 'Open', to: target })), false);
  const page = ajv.getSchema('page.schema.json')!;
  const raw = {
    base: 'application',
    sections: [
      { kind: 'note', text: 'Open', action: { label: 'Lender', to: target } },
      { kind: 'headline', show: ['id'], links: [{ label: 'Lender', to: target }] },
    ],
  };
  assert.equal(page(raw), true, JSON.stringify(page.errors));
  assert.equal(page({ ...raw, sections: [{ kind: 'note', text: 'Open', action: { label: 'Lender', view: 'local', to: target } }] }), false);
});
