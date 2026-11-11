/**
 * Where mistri check says a finding was written (checkProblems.ts sourceLocator, TR10): in the modules the App
 * was loaded from and what they import, never a backup copy kept beside them; and a finding about a command at the
 * command's definition, never at a dashboard or a page that names it as a string.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathOfMessage, placeOf, sourceLocator } from '../packages/mistri/src/server/build/checkProblems.js';

test('a finding is placed in the modules the App loads, and one about a command at its definition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-locator-'));
  try {
    mkdirSync(join(dir, 'commands'));
    const app = [
      "import { views } from './views.ts';",
      "export default { id: 'shop', name: 'Shop', resources: { job: {} }, views };",
      '',
    ].join('\n');
    writeFileSync(join(dir, 'app.ts'), app);
    writeFileSync(
      join(dir, 'views.ts'),
      ['export const views = {', "  jobs: { kind: 'list', from: 'job', query: 'status = resolvd' },", '};', ''].join('\n'),
    );
    // A copy kept from before an edit: it says what the App once said, and the App never reads it.
    writeFileSync(join(dir, 'app-old.ts'), app.replace("'./views.ts'", "'./views-old.ts'"));
    writeFileSync(
      join(dir, 'views-old.ts'),
      ['export const views = {', "  jobs: { kind: 'list', from: 'job', query: 'status = resolvd' },", '};', ''].join('\n'),
    );
    writeFileSync(
      join(dir, 'dashboard.ts'),
      ['export const board = {', "  actions: { handOver: { label: 'Hand over', command: 'handOver' } },", '};', ''].join('\n'),
    );
    writeFileSync(
      join(dir, 'commands.ts'),
      [
        "import { defineCommands } from '@mistriwork/mistri/commands';",
        "import { handOver } from './commands/desk.ts';",
        'export default defineCommands({ handOver });',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'commands', 'desk.ts'),
      [
        "import { defineCommand } from '@mistriwork/mistri/commands';",
        '',
        'export const handOver = defineCommand({',
        "  target: 'job',",
        "  when: 'balance > 0',",
        '});',
        '',
      ].join('\n'),
    );
    const roots = [join(dir, 'app.ts'), join(dir, 'commands.ts')];
    const { at } = await sourceLocator(dir, roots);
    const place = (line: string) => {
      const found = at(line);
      return found && `${relative(dir, resolve(found.file))}:${found.line}`;
    };
    assert.equal(place('views "jobs": "resolvd" is not one of job.status (open, resolved), so it never matches.'), 'views.ts:2');
    assert.equal(
      place('Command "handOver" when: job: "balance" is not a column, a rollup or a computed column of it.'),
      'commands/desk.ts:3',
    );
    assert.equal(place('commands.ts: Command "handOver" has no "target" the App declares.'), 'commands/desk.ts:3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a finding about a role is placed at the role's declaration, not at a job that names it as a string", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-locator-'));
  try {
    writeFileSync(
      join(dir, 'app.ts'),
      [
        'export default {',
        '  auth: {',
        '    roles: {',
        '      admin: { label: "Admin" },',
        '      integration: {},',
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'jobs.mjs'),
      ['export const jobs = {', "  sync: { as: 'integration' },", "  other: { as: 'integration' },", '};', ''].join('\n'),
    );
    const { at } = await sourceLocator(dir, [join(dir, 'app.ts'), join(dir, 'jobs.mjs')]);
    const found = at('role "integration" [role-label]: it has no "label", so the screens that name it to people say "Integration".');
    assert.equal(found && `${relative(dir, resolve(found.file))}:${found.line}`, 'app.ts:5');
    assert.equal(at('role "ghost" [role-label]: it has no "label", so the screens say "Ghost".'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A field report: a problem on a feature's page was placed in another feature's module, where the same words were
   also written, because the walk from defineApp's object found no "pages" there and the text search took over. */
test("a finding about a feature's page is placed in that feature's module, not another that shares its words", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-locator-'));
  try {
    mkdirSync(join(dir, 'features'));
    writeFileSync(
      join(dir, 'app.ts'),
      [
        "import { defineApp } from '@mistriwork/mistri/app';",
        "import { major } from './features/major.ts';",
        "import { desk } from './features/desk.ts';",
        "export default defineApp({ id: 'ops', name: 'Ops', features: [major, desk] });",
        '',
      ].join('\n'),
    );
    const feature = (id: string, page: string) =>
      [
        "import { defineFeature } from '@mistriwork/mistri/app';",
        `export const ${id} = defineFeature({`,
        `  id: '${id}',`,
        '  pages: {',
        `    ${page}: {`,
        "      base: 'incident',",
        "      sections: [{ kind: 'related', from: 'task', query: 'priorty = high' }],",
        '    },',
        '  },',
        '});',
        '',
      ].join('\n');
    writeFileSync(join(dir, 'features', 'major.ts'), feature('major', 'outage'));
    writeFileSync(join(dir, 'features', 'desk.ts'), feature('desk', 'incidents'));
    const message = 'page "incidents", section 1: "priorty" is not a column of task.';
    const path = pathOfMessage(message);
    assert.equal(path, 'pages.incidents.sections[0]');
    /* What check walks once the App's origins say the page is the desk feature's. */
    const found = await placeOf([join(dir, 'app.ts')], `features.desk.${path}`, message, process.cwd());
    assert.equal(found && `${relative(dir, resolve(found.file))}:${found.line}`, 'features/desk.ts:7');
    /* A feature the list does not hold is placed at the list, never in a feature's module. */
    const missing = await placeOf([join(dir, 'app.ts')], 'features.ghost.pages.incidents', message, process.cwd());
    assert.equal(missing && `${relative(dir, resolve(missing.file))}:${missing.line}`, 'app.ts:4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
