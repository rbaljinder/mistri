/**
 * Custom components, end to end on the server side: the declaration checked
 * as data, the placements refused where phase 1 refuses them, a page
 * section's reads judged against the schema, the module compiled with the
 * page's singletons left external and the server's modules refused, its CSS
 * layered and scoped, `mistri check`'s lints, the host modules the import
 * map points at, a real server serving the compiled files and listing them in
 * /api/app, and `mistri build` carrying the components/ graph; and an App's
 * control kit (Preview), compiled the same way and named in its page's head.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { componentPropValues, MAX_CUSTOM_READS, parseComponentDecl } from '../packages/engine/src/shared/appComponents.js';
import { appComponents } from '../packages/mistri/src/shared/appComponentPlaces.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import { compileComponents } from '../packages/mistri/src/server/app/appComponents.js';
import { componentsIndex } from '../packages/mistri/src/server/app/appBuild.js';
import { withHead } from '../packages/engine/src/server/clientHttp.js';
import { withHostPaths } from '../packages/mistri/src/server/http/componentRoutes.js';
import { lintComponents } from '../packages/mistri/src/server/app/componentLint.js';
import { hostModuleSource } from '../packages/mistri/src/server/app/componentSdk.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'mistri-components-'));
after(() => rmSync(work, { recursive: true, force: true }));
mkdirSync(join(work, 'node_modules'));
mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');

function dir(name: string, files: Record<string, string>): string {
  const at = join(work, name);
  for (const [file, text] of Object.entries({ 'package.json': '{ "type": "module" }\n', ...files })) {
    mkdirSync(join(at, file, '..'), { recursive: true });
    writeFileSync(join(at, file), text);
  }
  return at;
}

const HELLO = [
  "import { Value, useSectionSize } from '@mistriwork/mistri/ui';",
  "import './hello.css';",
  'export default function Hello({ rows }) {',
  '  const { compact } = useSectionSize();',
  "  return <ul className=\"c-hello-list\">{rows.tasks.map(task => <li key={task.id}>{task.name} <Value value={task.completed} /></li>)}{compact ? 'narrow' : ''}</ul>;",
  '}',
].join('\n');
const WIDGETS = {
  'widgets/Hello.jsx': HELLO,
  'widgets/hello.css': '.c-hello-list { color: var(--ink); }\n',
  'widgets/Done.jsx': "export default function Done({ value }) { return <b className=\"c-done\">{value ? 'done' : 'open'}</b>; }\n",
};

describe('the declaration', () => {
  test('a component is a name and a path inside the App, with checked props', () => {
    const decl = parseComponentDecl(
      { id: 'hello', module: './widgets/Hello.jsx', kind: 'section', props: { months: { type: 'number', default: 3, min: 1 } } },
      'here',
    );
    assert.deepEqual(componentPropValues(decl, undefined, 'here'), { months: 3 });
    assert.deepEqual(componentPropValues(decl, { months: 5 }, 'here'), { months: 5 });
    assert.throws(() => componentPropValues(decl, { months: 0 }, 'here'), /below its min of 1/);
    assert.throws(() => componentPropValues(decl, { weeks: 2 }, 'here'), /does not declare.*It declares: months/);
    for (const module of ['widgets/Hello.jsx', './../x.tsx', '/abs.tsx', './widgets/Hello.vue', './a//b.tsx']) {
      assert.throws(() => parseComponentDecl({ id: 'hello', module }, 'here'), /A module is a path inside the App directory/);
    }
    assert.throws(() => parseComponentDecl({ id: 'Hello', module: './a.tsx' }, 'here'), /lowercase letters/);
    assert.throws(
      () => parseComponentDecl({ id: 'x', module: './a.tsx', props: { n: { type: 'number', default: 'a' } } }, 'here'),
      /not a number/,
    );
    assert.throws(() => parseComponentDecl({ id: 'x', module: './a.tsx', kind: 'value' }, 'here', 'section'), /value renderer/);
  });

  const base = { name: 'Tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };
  const hello = { id: 'hello', module: './widgets/Hello.jsx', kind: 'section' };
  const done = { id: 'done', module: './widgets/Done.jsx', kind: 'value' };

  test('a value renderer stands where a display rule does, and one id is one component', () => {
    const app = parseAppConfig({ ...base, resources: { task: { display: { completed: done } } } }, 'fixture');
    assert.deepEqual(app.resources!.task.display!.completed, { component: done });
    assert.equal(appComponents(app, [], 'fixture').get('done')?.module, './widgets/Done.jsx');
    const twice = parseAppConfig(
      { ...base, resources: { task: { display: { completed: done, name: { ...done, module: './widgets/Other.jsx' } } } } },
      'fixture',
    );
    assert.throws(() => appComponents(twice, [], 'fixture'), /declares the component "done" differently/);
    assert.throws(
      () => parseAppConfig({ ...base, resources: { task: { display: { completed: hello } } } }, 'fixture'),
      /A display rule takes a component of kind "value"/,
    );
  });

  test('a rule with a component names no face, which the component sets itself; a mask still takes one', () => {
    const rule = (display: object) => parseAppConfig({ ...base, resources: { task: { display: { name: display } } } }, 'fixture');
    assert.throws(() => rule({ component: done, face: 'code' }), /"face", which a component sets itself/);
    assert.equal(rule({ face: 'code', masked: { prefix: 'ENC:' } }).resources!.task.display!.name.face, 'code');
    assert.throws(() => rule({ face: 'code', masked: true }), /"masked: true".*no "face"/);
  });

  test('a value renderer is drawn for a signed-out visitor where the public reads, and on a tenant App', () => {
    const app = parseAppConfig({ ...base, resources: { task: { display: { completed: done } } } }, 'fixture');
    assert.ok(appComponents({ ...app, auth: { public: { read: ['task'] } } } as AppDef, [], 'fixture').has('done'));
    // A tenant App's host serves it to a signed-in member, whose every read stays in their tenant.
    assert.ok(appComponents({ ...app, auth: { rows: 'tenant' } } as AppDef, [], 'fixture').has('done'));
  });

  const schema: DatabaseSchema = {
    label: 'Tick',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'task',
        name: 'task',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'completed', type: 'BOOLEAN', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const page = (rows: object): PageDef =>
    parsePagesConfig(
      {
        pages: [
          {
            id: 'task',
            base: 'task',
            label: 'Task',
            sections: [{ kind: 'custom', title: 'Others', component: hello, record: ['name'], rows }],
          },
        ],
      },
      'fixture',
    )[0];

  test("a page section's reads are judged as the lists they are planned as, before a reader sees one", () => {
    assert.equal(validatePage(schema, page({ tasks: { from: 'task', show: ['id', 'name'], sort: 'name' } })).error, undefined);
    assert.match(validatePage(schema, page({ tasks: { from: 'task', show: ['nmae'] } })).error ?? '', /nmae/);
    assert.match(validatePage(schema, page({ tasks: { from: 'tsk', show: ['id'] } })).error ?? '', /"tsk" is not a table/);
    /* A real section needs more than four reads; the cap is the fan-out one paint may ask, not a style limit. */
    const reads = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`read${i}`, { from: 'task', show: ['id'] }]));
    assert.equal(Object.keys((page(reads(MAX_CUSTOM_READS)).sections[0] as { reads?: object }).reads ?? {}).length, MAX_CUSTOM_READS);
    assert.ok(MAX_CUSTOM_READS >= 8);
    assert.throws(() => page(reads(MAX_CUSTOM_READS + 1)), new RegExp(`at most ${MAX_CUSTOM_READS}`));
  });

  test("a dashboard section's reads name declared resources and may follow the window", () => {
    const app = parseAppConfig(
      {
        ...base,
        views: {
          ...base.views,
          home: {
            kind: 'dashboard',
            label: 'Home',
            sections: [
              { kind: 'custom', title: 'Hello', component: hello, rows: { tasks: { from: 'task', show: ['id', 'name'], over: 'due_on' } } },
            ],
          },
        },
        home: 'home',
        nav: ['home', 'tasks'],
      },
      'fixture',
    );
    const section = (app.views.home as { sections: Array<{ kind: string; reads?: object }> }).sections[0];
    assert.equal(section.kind, 'custom');
    assert.deepEqual(section.reads, { tasks: { table: 'task', show: ['id', 'name'], over: 'due_on' } });
  });
});

describe('the compile', () => {
  test("bundles the App's own modules, keeps the page's singletons external, layers and scopes the CSS", async () => {
    const at = dir('compiled', WIDGETS);
    const compiled = (await compileComponents(at, new Map([['hello', { id: 'hello', module: './widgets/Hello.jsx', kind: 'section' }]])))!;
    const entry = compiled.entries.hello;
    assert.match(entry.js, /^hello-[0-9a-f]{12}\.js$/);
    const js = compiled.files[entry.js];
    assert.match(js, /from "@mistriwork\/mistri\/ui"/);
    assert.match(js, /from "react\/jsx-runtime"/);
    assert.doesNotMatch(js, /react\.production|__SECRET_INTERNALS/);
    assert.match(compiled.files[entry.css!], /^@layer components \{\n@scope \(\[data-component="hello"\]\) \{\n\.c-hello-list/);
    assert.deepEqual(entry.sources, ['widgets/Hello.jsx', 'widgets/hello.css']);
    // Same source, same names: a reload that changed nothing serves the same files.
    const again = (await compileComponents(at, new Map([['hello', { id: 'hello', module: './widgets/Hello.jsx', kind: 'section' }]])))!;
    assert.equal(again.entries.hello.js, entry.js);
  });

  test("the App framework's own SDK name is the same page module, served as the same file", async () => {
    const at = dir('@mistriwork/ui', {
      'widgets/Hello.jsx': HELLO.replace("from '@mistriwork/mistri/ui'", "from '@mistriwork/mistri/ui'").replace(
        "import './hello.css';\n",
        '',
      ),
    });
    const compiled = (await compileComponents(at, new Map([['hello', { id: 'hello', module: './widgets/Hello.jsx', kind: 'section' }]])))!;
    const js = compiled.files[compiled.entries.hello.js];
    assert.match(js, /from "@mistriwork\/mistri\/ui"/);
    assert.match(withHostPaths(compiled.files, compiled.entries.hello.js, '/tick'), /from "\/tick\/_mistri\/sdk\/ui\.js"/);
  });

  test('refuses what a browser module may never reach, and a module with nothing to draw', async () => {
    const cases: Array<[string, RegExp]> = [
      [
        "import { defineCommands } from '@mistriwork/mistri/commands'; export default () => defineCommands;",
        /mistri\/commands" is server code/,
      ],
      ["import { readFileSync } from 'node:fs'; export default () => readFileSync;", /is a Node module/],
      ["import x from '../../outside.js'; export default () => x;", /outside the App directory/],
      ["import { useQuery } from '@tanstack/react-query'; export default () => useQuery;", /query cache of its own/],
      ['export const Named = () => null;', /no default export/],
    ];
    writeFileSync(join(work, 'outside.js'), 'export default 1;\n');
    for (const [i, [source, refusal]] of cases.entries()) {
      const at = dir(`refused-${i}`, { 'widgets/Bad.jsx': source });
      await assert.rejects(compileComponents(at, new Map([['bad', { id: 'bad', module: './widgets/Bad.jsx', kind: 'section' }]])), refusal);
    }
    await assert.rejects(
      compileComponents(dir('missing', {}), new Map([['gone', { id: 'gone', module: './widgets/Gone.jsx', kind: 'section' }]])),
      /does not exist/,
    );
  });
});

describe("mistri check's lints", () => {
  test("fails on markup and code from text and on the server's environment; warns on what a look cannot dress", async () => {
    const at = dir('linted', {
      'widgets/Loud.jsx': [
        "import './loud.css';",
        '// dangerouslySetInnerHTML in a comment is not a finding',
        'export default function Loud({ rows }) {',
        '  const key = process.env.SECRET;',
        '  const r = document.body.getBoundingClientRect();',
        "  return <div className=\"c-loud\" style={{ color: '#ff0000', transition: 'opacity 400ms' }} dangerouslySetInnerHTML={{ __html: rows }} onClick={() => eval('1')} />;",
        '}',
      ].join('\n'),
      'widgets/loud.css': [
        '.c-loud { color: #123456; border-radius: 6px; transition: opacity 120ms; box-shadow: 0 1px 2px var(--line); }',
        '.card { color: var(--ink); }',
        '@media (prefers-reduced-motion: no-preference) { .c-loud-in { transition: opacity 150ms; } }',
      ].join('\n'),
    });
    const compiled = (await compileComponents(at, new Map([['loud', { id: 'loud', module: './widgets/Loud.jsx', kind: 'section' }]])))!;
    const { problems, warnings } = await lintComponents(at, compiled);
    const said = (list: typeof problems) => list.map((finding) => `${finding.file}:${finding.line} ${finding.text}`).join('\n');
    assert.match(said(problems), /Loud\.jsx:4 .*server environment/);
    assert.match(said(problems), /Loud\.jsx:6 dangerouslySetInnerHTML/);
    assert.match(said(problems), /Loud\.jsx:6 eval runs text as code/);
    assert.doesNotMatch(said(problems), /Loud\.jsx:2 /);
    for (const expected of [
      /Loud\.jsx:5 .*ruler/,
      /Loud\.jsx:6 a literal color/,
      /Loud\.jsx:6 transition of 400ms/,
      /loud\.css:1 "#123456"/,
      /loud\.css:1 .*literal radius/,
      /loud\.css:1 transition outside @media/,
      /loud\.css:1 a shadow/,
      /loud\.css:2 the class "\.card"/,
    ]) {
      assert.match(said(warnings), expected);
    }
    assert.doesNotMatch(said(warnings), /loud\.css:3/);
  });
});

describe("the host modules a component's imports are served as", () => {
  test("each is the page's own copy, named from the package or the SDK", () => {
    assert.match(hostModuleSource('react.js')!, /export const \{ [^}]*\buseState\b/);
    assert.match(hostModuleSource('react-jsx-runtime.js')!, /\bjsx\b/);
    assert.match(hostModuleSource('ui.js')!, /\buseRows\b.*\bCard\b|\bCard\b.*\buseRows\b/);
    assert.doesNotMatch(hostModuleSource('react.js')!, /__CLIENT_INTERNALS|__SECRET/);
    assert.equal(hostModuleSource('fs.js'), undefined);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe('served, and built', () => {
  const db = join(work, 'tick.db');
  spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  const appDir = dir('served', {
    ...WIDGETS,
    'app.mjs': [
      "import { component, custom, dashboard, defineApp } from '@mistriwork/mistri/app';",
      "const hello = component('hello', { module: './widgets/Hello.jsx' });",
      "const done = component('done', { module: './widgets/Done.jsx', kind: 'value' });",
      "export default defineApp({ id: 'tick', name: 'Tick', connection: 'tick', resources: { task: { display: { completed: done } } },",
      "  views: { tasks: { kind: 'list', from: 'task' }, home: dashboard('Home', [custom('Hello', hello, { rows: { tasks: { from: 'task', show: ['id', 'name', 'completed'] } } })]) },",
      "  home: 'home', nav: ['home', 'tasks'] });",
    ].join('\n'),
  });

  test('a real server lists each component in /api/app and serves its files immutably, the host modules fresh', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, '--config', `${db}.json`, '--app', appDir, '--port', String(port)], {
      cwd: ROOT,
      env: { ...process.env, MISTRI_OPEN: '0', XDG_CONFIG_HOME: join(work, 'xdg') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => {
      log += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      log += String(chunk);
    });
    try {
      const deadline = Date.now() + 30_000;
      while (!log.includes('Listening on ')) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server did not start: ${log}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      const origin = `http://127.0.0.1:${port}`;
      const payload = (await (await fetch(`${origin}/api/app`, { headers: { 'x-mistri-connection': 'tick' } })).json()) as {
        app?: { components?: Record<string, { kind: string; href: string; css?: string }> };
      };
      const components = payload.app?.components;
      assert.ok(components, `no components in /api/app: ${JSON.stringify(payload).slice(0, 300)}`);
      assert.equal(components.done.kind, 'value');
      // The payload says the inside address; one App is served at the root (shared/mount.ts).
      assert.match(components.hello.href, /^\/tick\/_components\/hello-[0-9a-f]{12}\.js$/);
      const js = await fetch(origin + components.hello.href.slice('/tick'.length));
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type') ?? '', /text\/javascript/);
      assert.match(js.headers.get('cache-control') ?? '', /immutable/);
      // Its bare host imports are said as the host modules' paths: no page needs an import map for them.
      const code = await js.text();
      assert.match(code, /["']\/_mistri\/sdk\/ui\.js["']/);
      assert.doesNotMatch(code, /from\s*["'](?:react|@mistriwork\/mistri\/ui)["']/);
      assert.equal((await fetch(`${origin}/_components/hello-000000000000.js`)).status, 404);
      const react = await fetch(`${origin}/_mistri/sdk/react.js`);
      assert.equal(react.headers.get('cache-control'), 'no-cache');
      assert.match(await react.text(), /__mistri/);
      const shell = await fetch(`${origin}/`);
      assert.doesNotMatch(await shell.text(), /type="importmap"/, 'a page needs no import map, so a host page can mount the App');
    } finally {
      child.kill('SIGTERM');
    }
  });

  test("check fails a component's message key the App's catalog lacks, and a message in an App with no catalog", async () => {
    /* A field report: a component's text was missing in the browser while `check` passed. useMessage says a key the
       catalog lacks as itself, by design, so nothing failed until a person read the page. */
    const said = (name: string, files: Record<string, string>) => {
      const at = dir(name, {
        'widgets/Hello.jsx': [
          "import { useMessage } from '@mistriwork/mistri/ui';",
          '// useMessage("in.a.comment") is not a finding',
          'export default function Hello() {',
          '  return <p className="c-hello">{useMessage(\'hello.title\')} {useMessage("hello.count", { count: 2 })}</p>;',
          '}',
        ].join('\n'),
        'app.mjs': [
          "import { component, custom, dashboard, defineApp } from '@mistriwork/mistri/app';",
          "const hello = component('hello', { module: './widgets/Hello.jsx' });",
          "export default defineApp({ id: 'tick', name: 'Tick', connection: 'tick', resources: { task: {} },",
          "  views: { tasks: { kind: 'list', from: 'task' }, home: dashboard('Home', [custom('Hello', hello)]) },",
          "  home: 'home', nav: ['home', 'tasks'] });",
        ].join('\n'),
        ...files,
      });
      const run = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'check', '--app', at, '--config', `${db}.json`, '--warnings'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') },
        timeout: 120_000,
      });
      return { at, status: run.status, out: run.stdout + run.stderr };
    };
    const lacking = said('messages-lacking', {
      'messages/en.mjs':
        "import { defineMessages } from '@mistriwork/mistri/app';\nexport default defineMessages('en', { 'hello.title': 'Hello there' });\n",
    });
    assert.notEqual(lacking.status, 0, lacking.out);
    assert.match(lacking.out, /Hello\.jsx:4 {2}.*"hello\.count" is not in messages\/en\.mjs/);
    assert.doesNotMatch(lacking.out, /"hello\.title"/);
    assert.doesNotMatch(lacking.out, /in\.a\.comment/);
    // Serving keeps saying the slip as the key, as before: a missing message is check's to fail, not a load's.
    assert.deepEqual(Object.keys((await loadApp(lacking.at)).components!.entries), ['hello']);

    const none = said('messages-none', {});
    assert.notEqual(none.status, 0, none.out);
    assert.match(none.out, /Hello\.jsx:4 {2}.*useMessage\("hello\.title"\): the App has no messages\/<locale>\.ts/);

    const whole = said('messages-whole', {
      'messages/en.mjs':
        "import { defineMessages } from '@mistriwork/mistri/app';\n" +
        "export default defineMessages('en', { 'hello.title': 'Hello there', 'hello.count': '{count, plural, one {# task} other {# tasks}}', 'spare.key': 'Spare' });\n",
    });
    assert.equal(whole.status, 0, whole.out);
    // A key only a component says is named: check advised removing it, which is how a component's text goes missing.
    assert.match(whole.out, /"spare\.key" is named by no msg\(\)/);
    assert.doesNotMatch(whole.out, /"hello\.(title|count)" is named by no msg\(\)/);
  });

  test('mistri build writes the components/ graph and serves it back with no compiler', async () => {
    const out = join(work, 'build');
    const built = await new Promise<{ code: number; out: string; err: string }>((done) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', ENTRY, 'build', '--app', appDir, '--out', out],
        { cwd: ROOT, timeout: 120_000 },
        (error, stdout, stderr) => done({ code: (error as { code?: number } | null)?.code ?? 0, out: stdout, err: stderr }),
      ),
    );
    assert.equal(built.code, 0, built.err);
    assert.match(built.out, /components: done \(done-[0-9a-f]{12}\.js\), hello \(hello-[0-9a-f]{12}\.js, hello-[0-9a-f]{12}\.css\)/);
    const manifest = JSON.parse(readFileSync(join(out, 'mistri-build.json'), 'utf8')) as {
      outputs: { components?: string };
      sha256: Record<string, string>;
    };
    assert.equal(manifest.outputs.components, 'components/components.json');
    assert.ok(Object.keys(manifest.sha256).some((file) => /^components\/hello-[0-9a-f]{12}\.js$/.test(file)));
    const loaded = await loadApp(out);
    assert.deepEqual(Object.keys(loaded.components!.entries).sort(), ['done', 'hello']);
    assert.match(loaded.components!.files[loaded.components!.entries.hello.js], /mistri\/ui/);
  });
});

describe('the lint is held where a component is served', () => {
  const appWith = (name: string, jsx: string) =>
    dir(name, {
      'widgets/Raw.jsx': jsx,
      'app.mjs': [
        "import { component, custom, dashboard, defineApp } from '@mistriwork/mistri/app';",
        "const raw = component('raw', { module: './widgets/Raw.jsx' });",
        "export default defineApp({ id: 'raw', name: 'Raw', connection: 'tick', resources: { task: {} },",
        "  views: { home: dashboard('Home', [custom('Raw', raw, { rows: { tasks: { from: 'task', show: ['id', 'name'] } } })]) },",
        "  home: 'home', nav: ['home'] });",
      ].join('\n'),
    });

  test('a load refuses a component that sets raw HTML, with the text check gives, and accepts one that does not', async () => {
    const refused = appWith(
      'raw-html',
      'export default function Raw({ rows }) { return <div dangerouslySetInnerHTML={{ __html: rows }} />; }\n',
    );
    await assert.rejects(loadApp(refused), /widgets\/Raw\.jsx:1 {2}dangerouslySetInnerHTML turns text into markup/);
    const fine = appWith('raw-fine', 'export default function Raw({ rows }) { return <div>{String(rows)}</div>; }\n');
    assert.deepEqual(Object.keys((await loadApp(fine)).components!.entries), ['raw']);
  });
});

describe("mistri check's lints, spelled another way", () => {
  test('markup and code from text are found in their bracket, frame, parser and timer spellings too', async () => {
    const at = dir('linted-spellings', {
      'widgets/Sly.jsx': [
        'export default function Sly({ rows }) {',
        "  const el = document.createElement('div'); el['innerHTML'] = rows;",
        '  const frag = document.createRange().createContextualFragment(rows);',
        "  const doc = new DOMParser().parseFromString(rows, 'text/html');",
        "  setTimeout('alert(1)', 0);",
        '  return <iframe srcDoc={rows} title={String(frag) + String(doc)} />;',
        '}',
      ].join('\n'),
    });
    const compiled = (await compileComponents(at, new Map([['sly', { id: 'sly', module: './widgets/Sly.jsx', kind: 'section' }]])))!;
    const { problems } = await lintComponents(at, compiled);
    const lines = new Set(problems.map((finding) => finding.line));
    for (const line of [2, 3, 4, 5, 6]) assert.ok(lines.has(line), `line ${line} is a finding: ${JSON.stringify(problems)}`);
  });
});

describe("an App's control kit (Preview)", () => {
  /* The fixture e2e/ui-kit.spec.ts drives: a plain-HTML kit beside an App that declares it. */
  const KIT_DESK = join(ROOT, 'test/fixtures/apps/kit-desk');
  const kitApp = (name: string, kit: string) =>
    dir(name, {
      'ui/kit.jsx': kit,
      'app.mjs': [
        "import { defineApp } from '@mistriwork/mistri/app';",
        "export default defineApp({ id: 'tick', name: 'Tick', connection: 'tick', resources: { task: {} },",
        "  views: { tasks: { kind: 'list', from: 'task' } },",
        "  home: 'tasks', nav: ['tasks'], uiKit: './ui/kit.jsx' });",
      ].join('\n'),
    });

  test("is compiled beside the components, its sheet layered under the look, and listed in a build's index", async () => {
    const loaded = await loadApp(KIT_DESK);
    const kit = loaded.components?.kit;
    assert.ok(kit, 'the declared kit is compiled');
    assert.match(kit.js, /^ui-kit-[0-9a-f]{12}\.js$/);
    assert.match(kit.css ?? '', /^ui-kit-[0-9a-f]{12}\.css$/);
    // Page-wide, not scoped to a placement: the kit draws every page's controls, under the look's layer.
    assert.match(loaded.components!.files[kit.css!], /^@layer components \{[\s\S]*\.kit-button/);
    // React and the page module stay external: the kit draws in the page's one React, as a component does.
    assert.match(loaded.components!.files[kit.js], /from "react-dom";\nimport \{ defineUiKit \} from "@mistriwork\/mistri\/page";/);
    assert.deepEqual(componentsIndex(loaded.components!)['#uiKit'], { kind: 'kit', js: kit.js, css: kit.css });
  });

  test('a slot the kit does not have refuses the load, naming the nearest one', async () => {
    const bad = kitApp(
      'kit-misspelled',
      "import { defineUiKit } from '@mistriwork/mistri/page';\nexport default defineUiKit({ Buton: () => null });\n",
    );
    await assert.rejects(loadApp(bad), /the UI kit \(\.\/ui\/kit\.jsx\) has no slot named "Buton" \(did you mean "Button"\?\)/);
    const bare = kitApp('kit-bare', 'export default { Button: () => null };\n');
    await assert.rejects(loadApp(bare), /no default export made by defineUiKit/);
  });

  test("the page's head preloads the module and links the sheet before the first render; the Workbench's never does", () => {
    const page = '<html><head><meta charset="utf-8"><title>x</title></head><body></body></html>';
    const uiKit = { js: '/desk/_components/ui-kit-0123456789ab.js', css: '/desk/_components/ui-kit-0123456789ab.css' };
    const html = withHead(page, { uiKit });
    assert.match(html, /<link rel="modulepreload" crossorigin href="\/desk\/_components\/ui-kit-0123456789ab\.js">/);
    assert.match(html, /<link rel="stylesheet" href="\/desk\/_components\/ui-kit-0123456789ab\.css" data-component-css="ui-kit">/);
    assert.match(html, /<meta name="mistri-ui-kit" content="\/desk\/_components\/ui-kit-0123456789ab\.js" data-css="[^"]+\.css">/);
    assert.ok(html.indexOf('mistri-ui-kit') < html.indexOf('</head>'));
    assert.doesNotMatch(withHead(page, { uiKit, workbench: true }), /ui-kit/);
    assert.doesNotMatch(withHead(page, { title: 'No kit' }), /ui-kit/, 'an App without a kit is told of nothing extra');
  });

  test('mistri build carries the kit and serves it back with no compiler', async () => {
    const out = join(work, 'kit-build');
    const built = await new Promise<{ code: number; err: string }>((done) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', ENTRY, 'build', '--app', KIT_DESK, '--out', out],
        { cwd: ROOT, timeout: 120_000 },
        (error, _stdout, stderr) => done({ code: (error as { code?: number } | null)?.code ?? 0, err: stderr }),
      ),
    );
    assert.equal(built.code, 0, built.err);
    const loaded = await loadApp(out);
    assert.match(loaded.components?.kit?.js ?? '', /^ui-kit-[0-9a-f]{12}\.js$/);
    assert.match(loaded.components!.files[loaded.components!.kit!.js], /data-kit/);
    assert.deepEqual(Object.keys(loaded.components!.entries), []);
  });
});
