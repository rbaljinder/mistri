/**
 * `mistri check` warns when the project's dev script serves the App's source with plain `mistri --app`: a save is then
 * not followed and a restart lets the port go (a field report). It judges `dev`, else `start`; a subcommand and a
 * build directory are left alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devScriptWarning } from '../packages/mistri/src/server/build/checkDevScript.js';
import { BUILD_MANIFEST } from '../packages/mistri/src/server/app/appBuild.js';

function project(scripts: Record<string, string>, appDir = 'app') {
  const root = mkdtempSync(join(tmpdir(), 'mistri-dev-script-'));
  mkdirSync(join(root, appDir), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  return { root, app: join(root, appDir) };
}

test('a dev script that serves the source without dev is said, naming mistri dev', (t) => {
  const { root, app } = project({ dev: 'mistri --config mistri.json --app ./app' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const said = devScriptWarning(app);
  assert.match(said ?? '', /dev script serves this App with mistri --app, not mistri dev: use mistri dev --app \.\/app/);
});

test('npx, a bin path, --app=, and a command after another all count', (t) => {
  for (const dev of [
    'npx @mistriwork/mistri --app app',
    'node_modules/.bin/mistri --app=app --dev',
    'npm run seed && mistri --port 4000 --app "app"',
  ]) {
    const { root, app } = project({ dev });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.ok(devScriptWarning(app), dev);
  }
});

test('mistri dev, another subcommand, another App, or no mistri at all is quiet', (t) => {
  for (const dev of ['mistri dev --app app', 'mistri check --app app', 'mistri --app other', 'vite', 'mistri-ish --app app']) {
    const { root, app } = project({ dev });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(devScriptWarning(app), undefined, dev);
  }
});

test('start is judged only when there is no dev script', (t) => {
  const withDev = project({ dev: 'mistri dev --app app', start: 'mistri --app app' });
  const startOnly = project({ start: 'mistri --app app' });
  t.after(() => {
    rmSync(withDev.root, { recursive: true, force: true });
    rmSync(startOnly.root, { recursive: true, force: true });
  });
  assert.equal(devScriptWarning(withDev.app), undefined);
  assert.match(devScriptWarning(startOnly.app) ?? '', /start script/);
});

test('a build directory, which a production start serves, is left alone', (t) => {
  const { root, app } = project({ start: 'mistri --app dist' }, 'dist');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(app, BUILD_MANIFEST), '{}');
  assert.equal(devScriptWarning(app), undefined);
});

test('the App directory itself, with its package.json beside app.ts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mistri-dev-script-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'mistri --app .' } }));
  assert.ok(devScriptWarning(root));
});
