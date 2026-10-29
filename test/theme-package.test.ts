/**
 * A published look (docs: Publish a look): a package whose `defineTheme` says the contract it was written to and
 * `from: import.meta.url`, so its stylesheet, the picture the sheet names and its face are read from the package and
 * held to it. The fixture (test/fixtures/theme-package) is installed into two Apps, as npm installs a copy: one
 * wears it as it is, one extends it. Both load, pass check and build; what a package may not say is theme-contract.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { brandRoute } from '../packages/mistri/src/server/http/brandRoutes.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { promiseOf } from '../packages/mistri/src/server/build/themeContract.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';

const ROOT = resolve('.');
const PACKAGE = join(ROOT, 'test/fixtures/theme-package');
const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-theme-package-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const db = join(scratch, 'tick.db');
spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });

/** An App with the package installed beside tablewalk, its definition saying `theme`. */
function app(name: string, head: string, ui: string): string {
  const dir = join(scratch, name);
  const installed = join(dir, 'node_modules', 'tablewalk-theme-daybook');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  cpSync(PACKAGE, installed, { recursive: true });
  mkdirSync(join(installed, 'fonts'), { recursive: true });
  copyFileSync(join(ROOT, 'packages/kit/src/client/fonts/inter-latin.woff2'), join(installed, 'fonts', 'daybook.woff2'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'app.ts'),
    `import { defineApp, defineTheme, listView } from '@mistriwork/mistri/app';
import daybook from 'tablewalk-theme-daybook';
${head}
export default defineApp({
  id: '${name}',
  name: '${name}',
  connection: 'tick',
  resources: { task: {} },
  views: { tasks: listView('Tasks', 'task') },
  home: 'tasks',
  ui: ${ui},
});
`,
  );
  return dir;
}

const plain = app('plain', '', `{ customThemes: [daybook], theme: { preset: 'daybook' } }`);
const extended = app(
  'extended',
  `const blue = defineTheme({ id: 'daybook-blue', label: 'Daybook Blue', extends: daybook, colors: { light: { accent: '#1d4ed8' } } });`,
  `{ customThemes: [blue], theme: { preset: 'daybook-blue' } }`,
);

const run = (args: string[]) =>
  new Promise<{ code: number; out: string }>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
      { cwd: ROOT, env: { ...process.env, XDG_CONFIG_HOME: join(scratch, 'xdg') }, timeout: 240_000 },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out: `${out}${err}` }),
    ),
  );

test('one published look in two Apps: its sheet, picture and face read from the package, scoped to the theme worn', async () => {
  for (const [dir, id] of [
    [plain, 'daybook'],
    [extended, 'daybook-blue'],
  ] as const) {
    const loaded = await loadApp(dir);
    const theme = loaded.app.ui.customThemes!.find((each) => each.id === id)!;
    assert.match(theme.stylesheet!.href!, new RegExp(`^/${loaded.app.id}/_brand/${id}-[0-9a-f]{12}\\.css$`));
    const sheet = loaded.brand!.files[theme.stylesheet!.href!.split('/').pop()!]!.toString('utf8');
    assert.match(sheet, /^@layer theme \{/);
    assert.ok(sheet.includes(`:root[data-visual-theme="${id}"] :is(`), sheet);
    // The picture beside the sheet, by its served name, so the sheet resolves it wherever the App is mounted.
    assert.match(sheet, /url\("paper-[0-9a-f]{12}\.png"\)/);
    assert.deepEqual(loaded.brand!.sources[theme.stylesheet!.href!.split('/').pop()!], 'daybook.css');
    // The face is the package's, inherited by the theme that extends it.
    assert.equal(theme.faces?.[0]?.family, 'Daybook Sans');
    assert.deepEqual(Object.values(loaded.fonts!.sources), ['fonts/daybook.woff2']);
    // The definition the browser is sent carries no path on this machine.
    assert.ok(!JSON.stringify(loaded.app.ui.customThemes).includes(scratch), 'no package directory in the definition');
  }
});

test('both Apps pass check, and a build serves the scoped sheet and its picture from brand/', async () => {
  for (const dir of [plain, extended]) {
    const checked = await run(['check', '--app', dir, '--config', `${db}.json`, '--json']);
    const report = JSON.parse(checked.out.slice(checked.out.indexOf('{'))) as {
      problems: Array<{ code: string; severity: string; message: string }>;
    };
    const theirs = report.problems.filter((problem) => problem.code.startsWith('theme-'));
    assert.deepEqual(theirs, [], checked.out);
  }
  const out = join(scratch, 'built');
  const built = await run(['build', '--app', plain, '--out', out]);
  assert.equal(built.code, 0, built.out);
  const loaded = await loadApp(out);
  const href = loaded.app.ui.customThemes![0]!.stylesheet!.href!;
  const sent: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
    },
    end(body?: Buffer) {
      sent.body = body?.toString('utf8');
    },
  };
  assert.equal(
    brandRoute({ req: { method: 'GET' } as never, res: res as never }, href, () => loaded.brand),
    true,
  );
  assert.equal(sent.status, 200);
  assert.equal(sent.headers!['content-type'], 'text/css; charset=utf-8');
  assert.match(sent.body!, /:root\[data-visual-theme="daybook"\]/);
  for (const picture of loaded.app.ui.customThemes![0]!.stylesheet!.files!)
    assert.deepEqual(loaded.brand!.files[picture], readFileSync(join(PACKAGE, 'paper.png')));
});

test('what a package may not say is theme-contract (C13); a sheet the allowlist refuses is theme-css, by its line', async () => {
  const from = pathToFileURL(join(PACKAGE, 'theme.js')).href;
  const base = { kind: 'theme', id: 'pkg', label: 'Pkg', extends: 'lumen' };
  const refused = (spec: Record<string, unknown>, pattern: RegExp, code: string) =>
    assert.throws(
      () => compileAppTheme({ ...base, ...spec }, 'theme', new Set(), { faces: true }),
      (error: Error) => pattern.test(error.message) && validationCode(error.message) === code,
    );
  refused({ contract: 2 }, /theme\.contract is 2: this mistri reads theme contract 1/, 'theme-contract');
  refused(
    { from },
    /theme\.from names a package's directory, and a package says the contract it was written to: contract: 1/,
    'theme-contract',
  );
  refused(
    { contract: 1, from: 'https://cdn.example.com/theme.js' },
    /theme\.from must be the theme module's import\.meta\.url/,
    'theme-contract',
  );
  const middle = { kind: 'theme', id: 'middle', label: 'Middle', extends: { ...base } };
  refused({ extends: middle }, /theme\.extends is a theme that extends another theme/, 'theme-contract');
  refused({ stylesheet: '../theme.css' }, /theme\.stylesheet must be a \.css file beside the theme/, 'theme-css');
  assert.equal(promiseOf('theme-contract'), 'C13');
  assert.equal(promiseOf('theme-css'), 'C13');
  // A tenant's theme has no directory: no stylesheet and no package.
  assert.throws(() => compileAppTheme({ ...base, stylesheet: './theme.css' }, 'theme'), /has none to read it from/);

  // A sheet that hides a part is refused when the App loads, naming its line, and nothing of it is served.
  const hiding = app('hiding', '', `{ customThemes: [daybook], theme: { preset: 'daybook' } }`);
  writeFileSync(join(hiding, 'node_modules', 'tablewalk-theme-daybook', 'daybook.css'), '[data-part="stat"] {\n  display: none;\n}\n');
  await assert.rejects(loadApp(hiding), (error: Error) => {
    assert.match(error.message, /\("daybook"\) stylesheet \.\/daybook\.css line 2: display: none: .*C13/);
    assert.equal(validationCode(error.message), 'theme-css');
    return true;
  });
  // A sheet that leads out of its package is the package's fault, not the sheet's.
  const leaking = app('leaking', '', `{ customThemes: [daybook], theme: { preset: 'daybook' } }`);
  const sheet = join(leaking, 'node_modules', 'tablewalk-theme-daybook', 'daybook.css');
  rmSync(sheet);
  writeFileSync(join(leaking, 'outside.css'), '[data-part="stat"] { color: var(--ink); }\n');
  symlinkSync(join(leaking, 'outside.css'), sheet);
  await assert.rejects(loadApp(leaking), (error: Error) => {
    assert.match(error.message, /daybook\.css leads outside its package/);
    assert.equal(validationCode(error.message), 'theme-contract');
    return true;
  });
});
