/*
 * The App's vocabulary, pinned. The internal model (AppDef) and the served
 * payload (/api/app) speak the authored DSL's nouns: parsing normalises what
 * was written, filling defaults and resolving references, and never lowers
 * it into a second shape with its own words. Each shape's keys are read from
 * its source by the compiler and compared with the sets below, so a renamed
 * or added key fails here until the set is changed on purpose — and the
 * change is then a line in this file's diff, beside the payload's readers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../support/tsc.js';
import { inPackages } from '../support/packages.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/* Sorted. Update on purpose, with the payload, its client readers and the docs. */
const PINNED: Record<string, { file: string; keys: string[] }> = {
  AppDef: {
    file: 'packages/mistri/src/shared/appModel.ts',
    keys: [
      'analytics',
      'api',
      'assistant',
      'audiences',
      'auth',
      'branding',
      'connection',
      'experiments',
      'flags',
      'home',
      'id',
      'landing',
      'live',
      'name',
      'nav',
      'resources',
      'retention',
      'sources',
      'track',
      'ui',
      'unions',
      'valueLabels',
      'views',
    ],
  },
  AppUi: {
    file: 'packages/mistri/src/shared/appModel.ts',
    keys: [
      'appSwitcher',
      'branding',
      'csp',
      'currency',
      'customThemes',
      'editing',
      'export',
      'footer',
      'locale',
      'localeColumn',
      'logo',
      'messages',
      'pwa',
      'shell',
      'theme',
      'timezone',
    ],
  },
  /* A resource's keys. `clone` (1.0) is the one key the tenant
     clone added: what a sandbox copies of a tenant-owned resource. */
  ResourceDef: {
    file: 'packages/mistri/src/shared/appModel.ts',
    keys: [
      'access',
      'actions',
      'address',
      'at',
      'audit',
      'clone',
      'computed',
      'consumes',
      'defined',
      'delete',
      'display',
      'favorite',
      'fields',
      'file',
      'flows',
      'form',
      'hidden',
      'import',
      'inputs',
      'labels',
      'live',
      'machine',
      'notify',
      'noun',
      'owner',
      'page',
      'physical',
      'recordLabel',
      'references',
      'restocks',
      'rollups',
      'search',
      'segments',
      'settings',
      'slug',
      'source',
      'tags',
      'text',
      'types',
      'validation',
      'view',
    ],
  },
  PageDef: {
    file: 'packages/engine/src/shared/page.ts',
    keys: [
      'aside',
      'base',
      'connection',
      'defaultAside',
      'document',
      'empty',
      'error',
      'id',
      'layout',
      'layoutWhy',
      'listTabs',
      'name',
      'path',
      'realm',
      'roles',
      'sections',
      'source',
    ],
  },
  AppPayload: {
    file: 'packages/mistri/src/shared/appPayload.ts',
    keys: ['app', 'appId', 'connection', 'live', 'loadError', 'loadProblem'],
  },
  AppPayloadApp: {
    file: 'packages/mistri/src/shared/appPayload.ts',
    keys: [
      'addresses',
      'apiTokens',
      'assistant',
      'components',
      // The fields a decision may suggest, by table, so a record holds their places before it asks (decide/decisionServing.ts).
      'decisions',
      // 1.0: the records on paper this reader may open, each a verb on its record (shared/appDocuments.ts).
      'documents',
      'exportableTables',
      'formCommands',
      'grantedActions',
      'grantedCommands',
      'home',
      'icons',
      'id',
      'inbox',
      'landingView',
      'messages',
      'name',
      'nav',
      'pages',
      'problems',
      // rc.1: a public page's public commands, by name, which its door runs signed out (http/pageCommandRoutes.ts).
      'publicCommands',
      'resources',
      'supportAudit',
      'supportLog',
      'ui',
      'views',
      'writableTables',
    ],
  },
};

/** The authored `ui`, from the published types. */
const AUTHORED_UI = { name: 'AppUi', file: 'packages/mistri/schema/app.d.ts' };

const files = [...new Set([...Object.values(PINNED).map((pin) => pin.file), AUTHORED_UI.file])].map((file) => join(root, file));
const { program, checker } = (() => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-vocabulary-'));
  try {
    const config = join(directory, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
        },
        files,
      }),
    );
    return project(config);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

/** Every property of an exported interface or type, inherited ones included, sorted. */
function keysOf(file: string, name: string): string[] {
  const source = program.getSourceFile(join(root, file));
  assert.ok(source, `${file} is not in the program`);
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find((candidate) => candidate.name === name);
  assert.ok(symbol, `${file} exports no ${name}`);
  return checker
    .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
    .map((property) => property.name)
    .sort();
}

for (const [name, { file, keys }] of Object.entries(PINNED)) {
  test(`${name} has exactly its pinned keys`, () => {
    assert.deepEqual(
      keysOf(file, name),
      keys,
      `${name} (${file}) changed its keys. If that is on purpose, update PINNED in test/repo/app-vocabulary.test.ts.`,
    );
  });
}

test('the internal ui keeps authored keys plus the captured record-branding binding; its shell keeps authored keys', () => {
  // ui.theme: fromRecord(...) becomes a fallback theme plus this server-owned
  // binding. It is not an additional authored key or a public selector DTO.
  // ui.locale: { column, default } is parsed into the tag (`locale`) and the
  // column it is read from (`localeColumn`), which is never served.
  assert.deepEqual(keysOf(PINNED.AppUi.file, 'AppUi'), [...keysOf(AUTHORED_UI.file, AUTHORED_UI.name), 'branding', 'localeColumn'].sort());
  assert.deepEqual(keysOf(PINNED.AppUi.file, 'AppShell'), keysOf(AUTHORED_UI.file, 'AppShell'));
});

/* Words from shapes and helpers the model no longer has. Any of them in
   a package's src/ is a second vocabulary coming back. */
const RETIRED = [
  'ResolvedNavEntry',
  'AppHomeCard',
  'ACCESS_MODES',
  'MENU_MODES',
  'lowerLeaf',
  'lowerHome',
  'singleListHome',
  'listHome',
  'landingDashboard',
  'legacy:',
  /* A public form was once an "intake"; it is a public command form now. The
     word came back meaning one thing only: placing a public form's submission
     with a tenant (tenantIntake.ts). The old form vocabulary stays gone. */
  'AppIntake',
  'AppIntakeCommandReference',
  'AppIntakeDone',
  'intakeId',
  'intakeCommand',
];
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const sources = inPackages('src').flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((file) => `${dir}/${file.split('\\').join('/')}`)
    .filter((file) => /\.(ts|tsx|js|mjs|css|html)$/.test(file)),
);

for (const word of RETIRED) {
  test(`src/ never says ${word}`, () => {
    const pattern = new RegExp(`(?<![\\w$])${word.replace(/[$]/g, '\\$&')}(?![\\w$])`);
    assert.deepEqual(
      sources.filter((file) => pattern.test(read(file))),
      [],
    );
  });
}
