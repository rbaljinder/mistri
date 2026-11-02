/**
 * A long App name was cut by a phone's bar ("Northwind Fi…") and by a home screen's icon label. `shortName` is what
 * those say instead; the full name stays the bar's accessible name and the page's title, and check advises a name a
 * bar would cut (`[short-name]`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { pwaManifest, pwaUrls } from '../packages/mistri/src/server/app/appPwa.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = { label: 'Field', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] } as unknown as DatabaseSchema;
const parsed = (root: object) =>
  parseAppConfig(
    {
      name: 'Northwind Field Service',
      resources: { job: {} },
      views: { jobs: { kind: 'list', from: 'job' } },
      home: 'jobs',
      nav: ['jobs'],
      ...root,
    },
    'run',
  );
const advice = (root: object) =>
  appAdvisories({ path: 'field.ts', app: parsed(root), pages: [], sources: {} } as unknown as LoadedApp, schema).filter((line) =>
    /short-name/.test(line),
  );

test('a short name of twelve characters or fewer is kept, and a longer or empty one is refused', () => {
  assert.equal(parsed({ shortName: ' Northwind ' }).shortName, 'Northwind');
  assert.equal(parsed({}).shortName, undefined);
  assert.throws(() => parsed({ shortName: 'Northwind Field' }), /"shortName" that is not 12 characters or fewer/);
  assert.throws(() => parsed({ shortName: '  ' }), /"shortName"/);
  assert.throws(() => parsed({ shortName: 7 }), /"shortName"/);
});

test('the payload carries it, and the installed icon says it', () => {
  const app = parsed({ shortName: 'Northwind' });
  assert.equal(servedApp(app, schema, []).shortName, 'Northwind');
  assert.equal(servedApp(parsed({}), schema, []).shortName, undefined);
  const urls = pwaUrls({ base: '', apps: {} }, app.id);
  const manifest = JSON.parse(pwaManifest(app, { light: '#fff', dark: '#000' }, urls)) as Record<string, unknown>;
  assert.equal(manifest.name, 'Northwind Field Service');
  assert.equal(manifest.short_name, 'Northwind');
});

test('a name a bar would cut, with no short name, is advised by its code', () => {
  const said = advice({});
  assert.equal(said.length, 1);
  assert.match(said[0], /name \[short-name\]: "Northwind Field Service" is 23 characters/);
  assert.equal(validationCode(said[0]), 'short-name');
  assert.deepEqual(advice({ shortName: 'Northwind' }), []);
  assert.deepEqual(advice({ name: 'Field Service' }), []);
});
