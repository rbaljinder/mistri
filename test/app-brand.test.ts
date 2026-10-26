/**
 * An App's own logo picture (`ui.logo: { src, dark, mark }`): parsed as paths, read from the App's directory and
 * admitted as a tenant's upload is, served from the App's own origin by content name, and said by check when it
 * has no dark answer (the theme contract's C10).
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppLogoImage } from '../packages/mistri/src/shared/appModel.js';
import { brandWarnings, readAppBrand, type AppBrand } from '../packages/mistri/src/server/app/appBrand.js';
import { brandRoute } from '../packages/mistri/src/server/http/brandRoutes.js';
import { isBrandAddress } from '../packages/mistri/src/shared/appBrandAddress.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { promiseOf } from '../packages/mistri/src/server/build/themeContract.js';

const HOME = { resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };
const parse = (logo: unknown) => parseAppConfig({ name: 'App', ...HOME, ui: { logo } }, 'app.ts').ui.logo;
/* The smallest PNG there is: one transparent pixel. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 24"><script>alert(1)</script><rect width="96" height="24" fill="#123456"/></svg>';

const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-brand-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
function appDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'brand'), { recursive: true });
  writeFileSync(join(dir, 'brand', 'acme.png'), PNG);
  writeFileSync(join(dir, 'brand', 'acme-night.svg'), SVG);
  return dir;
}

test('ui.logo is an icon, or the App own picture by its path; a URL, a stranger file or a stray key is refused', () => {
  assert.equal(parse('buildings'), 'buildings');
  assert.deepEqual(parse({ src: './brand/acme.png', dark: './brand/acme-night.svg', mark: 'brand/mark.webp' }), {
    src: './brand/acme.png',
    dark: './brand/acme-night.svg',
    mark: 'brand/mark.webp',
  });
  const refuse = (logo: unknown, pattern: RegExp) => assert.throws(() => parse(logo), pattern);
  refuse({ src: 'https://cdn.example.com/logo.png' }, /ui\.logo\.src "https:\/\/cdn\.example\.com\/logo\.png" is a URL/);
  refuse({ src: '//cdn.example.com/logo.png' }, /is a URL/);
  refuse({ src: './brand/logo.bmp' }, /ui\.logo\.src "\.\/brand\/logo\.bmp" is not a PNG, JPEG, WebP, GIF or SVG file/);
  refuse({ dark: './brand/acme.png' }, /ui\.logo\.src is required/);
  refuse({ src: './brand/acme.png', alt: 'Acme' }, /ui\.logo has no "alt"\. It takes: src, dark, mark/);
  // Each refusal is check's own code, so an agent fixing it lands on the logo's row.
  for (const logo of [{ src: 'https://x/y.png' }, { src: './a.bmp' }, { dark: './a.png' }])
    assert.throws(
      () => parse(logo),
      (error: Error) => validationCode(error.message) === 'app-logo',
    );
});

test('read from the App directory, admitted as an upload is, and named for its content', async () => {
  const dir = appDir('read');
  const app: { id: string; ui: { logo: AppLogoImage } } = {
    id: 'acme',
    ui: { logo: { src: './brand/acme.png', dark: './brand/acme-night.svg' } },
  };
  const brand = (await readAppBrand(app, dir, 'app.ts'))!;
  assert.match(app.ui.logo.href!, /^\/acme\/_brand\/acme-[0-9a-f]{12}\.png$/);
  assert.match(app.ui.logo.darkHref!, /^\/acme\/_brand\/acme-night-[0-9a-f]{12}\.svg$/);
  assert.ok(isBrandAddress(app.ui.logo.href) && isBrandAddress(app.ui.logo.darkHref));
  const svg = brand.files[app.ui.logo.darkHref!.split('/').pop()!]!.toString('utf8');
  assert.doesNotMatch(svg, /script|alert/, 'an SVG is written again from the allowlist');
  assert.deepEqual(Object.values(brand.sources).sort(), ['brand/acme-night.svg', 'brand/acme.png']);
  const refuse = (logo: Record<string, string>, pattern: RegExp) =>
    assert.rejects(readAppBrand({ id: 'acme', ui: { logo: { src: '', ...logo } } }, dir, 'app.ts'), pattern);
  await refuse({ src: './brand/missing.png' }, /ui\.logo\.src "\.\/brand\/missing\.png" is not a file in the App's directory/);
  writeFileSync(join(dir, 'brand', 'fake.png'), 'not a picture');
  await refuse({ src: './brand/fake.png' }, /ui\.logo\.src "\.\/brand\/fake\.png": This file is not a PNG, JPEG, WebP, GIF or SVG image/);
  symlinkSync('/etc/hosts', join(dir, 'brand', 'linked.png'));
  await refuse({ src: './brand/linked.png' }, /leads outside the App's directory/);
  await assert.rejects(readAppBrand(app, undefined, 'app.ts'), /load the App from its directory/);
  // An icon has no file to read.
  assert.equal(await readAppBrand({ id: 'acme', ui: { logo: 'buildings' } }, dir, 'app.ts'), undefined);
  for (const message of ['app.ts: ui.logo.src "./brand/fake.png": This file is not a PNG', 'app.ts: ui.logo.dark "./x.svg" is not a file'])
    assert.equal(validationCode(message), 'app-logo');
});

test('served by its content name with the walls an upload has; nothing undeclared answers', async () => {
  const brand: AppBrand = { files: { 'acme-0123456789ab.png': PNG }, types: { 'acme-0123456789ab.png': 'image/png' }, sources: {} };
  const server = createServer((req, res) => {
    if (!brandRoute({ req, res }, new URL(req.url!, 'http://x').pathname, (id) => (id === 'acme' ? brand : undefined)))
      res.writeHead(418).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${origin}/acme/_brand/acme-0123456789ab.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('content-security-policy')!, /default-src 'none'.*sandbox/);
    assert.match(ok.headers.get('cache-control')!, /immutable/);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
    assert.equal((await fetch(`${origin}/acme/_brand/other-0123456789ab.png`)).status, 404);
    assert.equal((await fetch(`${origin}/beta/_brand/acme-0123456789ab.png`)).status, 404);
    assert.equal((await fetch(`${origin}/acme/_brand/app.ts`)).status, 418);
  } finally {
    server.close();
  }
});

test('a picture with no dark answer is said, as the theme contract C10', () => {
  const [warning] = brandWarnings({ ui: { logo: { src: './brand/acme.png' } } });
  assert.match(warning!, /^ui\.logo\.src "\.\/brand\/acme\.png" has no dark: the same picture is drawn on the dark bar/);
  assert.equal(validationCode(`app.ts: ${warning}`), 'theme-dark');
  assert.equal(promiseOf('theme-dark'), 'C10');
  assert.deepEqual(brandWarnings({ ui: { logo: { src: './a.png', dark: './a.png' } } }), []);
  assert.deepEqual(brandWarnings({ ui: { logo: 'buildings' } }), []);
});

test('check says the logo with no dark answer by its promise, and build ships the pictures as served', async () => {
  const ROOT = resolve('.');
  const db = join(scratch, 'tick.db');
  spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  const dir = appDir('checked');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'app.ts'),
    `import { defineApp, listView } from '@mistriwork/mistri/app';
export default defineApp({
  id: 'acme',
  name: 'Acme',
  connection: 'tick',
  resources: { task: {} },
  views: { tasks: listView('Tasks', 'task') },
  home: 'tasks',
  ui: { logo: { src: './brand/acme.png' } },
});
`,
  );
  const env = { ...process.env, XDG_CONFIG_HOME: join(scratch, 'xdg') };
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
        { cwd: ROOT, env, timeout: 240_000 },
        (error, out) => done({ code: (error as { code?: number } | null)?.code ?? 0, out }),
      ),
    );
  const checked = await run(['check', '--app', dir, '--config', `${db}.json`, '--json']);
  const report = JSON.parse(checked.out) as { problems: Array<Record<string, string>> };
  const dark = report.problems.find((problem) => problem.code === 'theme-dark');
  assert.ok(dark, checked.out);
  assert.equal(dark.severity, 'warning');
  assert.equal(dark.promise, 'C10');
  const out = join(scratch, 'built');
  const built = await run(['build', '--app', dir, '--out', out]);
  assert.equal(built.code, 0, built.out);
  assert.match(built.out, /brand: brand\/acme\.png \(acme-[0-9a-f]{12}\.png\)/);
  const { loadApp } = await import('../packages/mistri/src/server/app/apps.js');
  const loaded = await loadApp(out);
  const href = (loaded.app.ui.logo as AppLogoImage).href!;
  assert.match(href, /^\/acme\/_brand\/acme-[0-9a-f]{12}\.png$/);
  assert.deepEqual(loaded.brand!.files[href.split('/').pop()!], readFileSync(join(dir, 'brand', 'acme.png')));
});
