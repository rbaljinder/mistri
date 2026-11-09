/**
 * `mistri migrate stores up` provisions the branding store a tenant App that declares `branding` needs, so its start,
 * which attests the store and never makes it, finds it (stores/storesCli.ts appStoreSteps).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appStoresPlan } from '../packages/mistri/src/server/stores/storesCli.js';
import { writeDepotApp } from './appApiCli.js';

test('a tenant App with branding has a branding store in its stores plan', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-branding-step-'));
  const registry = new Registry();
  try {
    const written = writeDepotApp(directory, {
      business: join(directory, 'business.db'),
      authStore: join(directory, 'auth.db'),
      physical: 'physical_item',
    });
    // The Depot App, with a tenant admin allowed to restyle it.
    const file = join(written.appDir, 'app.json');
    const definition = JSON.parse(readFileSync(file, 'utf8'));
    definition.auth.roles.admin = { read: true };
    definition.branding = { allow: ['name', 'accent'], editors: ['admin'] };
    writeFileSync(file, JSON.stringify(definition));
    const loaded = await loadApp(written.appDir, { lock: 'enforce' });
    assert.ok(loaded.app.branding, 'the App declares branding');
    registry.add({ id: 'data', name: 'data', url: join(directory, 'business.db'), writable: true, source: 'config' });
    // A database not made yet holds none of its stores: the plan names them without opening anything.
    const plan = await appStoresPlan({ registry, loaded, policy: written.policy });
    assert.deepEqual(plan.problems, []);
    assert.ok(
      plan.stores.some((store) => store.id === 'branding'),
      JSON.stringify(plan),
    );
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
