/**
 * The feature-to-test map (test/coverage-map.json) gates a release: every public DSL name, CLI command and
 * flag, and package entry point in test/fixtures/public-surface.json belongs to a row, and every row names
 * tests that exist and exercise it. The inventory is regenerated whenever the surface changes
 * (scripts/public-surface.mjs --check fails otherwise), so a new key cannot land without a row here.
 *
 * It was written when the public examples narrowed to Tick and Lintel: a feature whose only journey ran in a
 * retired example would have gone untested without anyone noticing. So a row may not lean on an example that
 * does not ship, and a row only Lintel covers must name keys Lintel still spells.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spelledIn } from '../scripts/dsl-reference.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Row {
  id: string;
  surface: string[];
  tests: Array<{ file: string; title?: string }>;
  browser?: boolean;
  risk?: string;
  note?: string;
}
interface CoverageMap {
  rows: Row[];
  unmapped: string[];
}
type Inventory = { sections: Record<string, Record<string, string[]>> };

const map = JSON.parse(readFileSync(join(ROOT, 'test/coverage-map.json'), 'utf8')) as CoverageMap;
const inventory = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/public-surface.json'), 'utf8')) as Inventory;

/** What the map answers for: the DSL and the CLI name by name, the package by its entry points. */
function publicNames({ sections }: Inventory): string[] {
  const listed = (section: Record<string, string[]>) =>
    Object.entries(section)
      .filter(([status]) => status === 'public' || status === 'preview')
      .flatMap(([, names]) => names);
  return [
    ...listed(sections.dsl).map((name) => `dsl: ${name}`),
    ...listed(sections.cli).map((name) => `cli: ${name}`),
    ...listed(sections.package)
      .filter((name) => name.startsWith('export '))
      .map((name) => `package: ${name}`),
  ];
}

/** A surface is a prefix that ends where a name's part does (`resources.*.form` owns `resources.*.form.groups`,
 * not `resources.*.formula`), or, ending in `$`, that name alone. */
function covers(surface: string, name: string): boolean {
  if (surface.endsWith('$')) return name === surface.slice(0, -1);
  return name.startsWith(surface) && /^(?:$|[ .[:=])/.test(name.slice(surface.length));
}

/** The names no row owns. */
function unowned(names: string[], rows: Row[]): string[] {
  return names.filter((name) => !rows.some((row) => row.surface.some((surface) => covers(surface, name))));
}

const names = publicNames(inventory);
const files = new Map<string, string>();
const read = (file: string) => {
  if (!files.has(file)) files.set(file, readFileSync(join(ROOT, file), 'utf8'));
  return files.get(file)!;
};

describe('the coverage map', () => {
  test('every public name belongs to a row, or to the unmapped list, which only shrinks', () => {
    const missing = unowned(names, map.rows);
    const unlisted = missing.filter((name) => !map.unmapped.some((surface) => covers(surface, name)));
    assert.deepEqual(unlisted, [], 'Add a row to test/coverage-map.json naming the tests that exercise each of these.');
    const stale = map.unmapped.filter((surface) => !missing.some((name) => covers(surface, name)));
    assert.deepEqual(stale, [], 'A row owns these now, or they left the surface: take them off `unmapped`.');
  });

  test('the gate can fail: a name no row owns is reported', () => {
    assert.deepEqual(unowned(['dsl: app: resources.*.invented', 'dsl: app: resources.*.form.groups'], map.rows), [
      'dsl: app: resources.*.invented',
    ]);
    assert.equal(covers('dsl: app: resources.*.form', 'dsl: app: resources.*.formula'), false);
    assert.equal(covers('dsl: app: auth$', 'dsl: app: auth.roles'), false);
  });

  test('each row names a surface that is there, and ids are unique', () => {
    const ids = map.rows.map((row) => row.id);
    assert.deepEqual(
      ids.filter((id, at) => ids.indexOf(id) !== at),
      [],
    );
    const gone = map.rows.flatMap((row) =>
      row.surface.filter((surface) => !names.some((name) => covers(surface, name))).map((surface) => `${row.id}: ${surface}`),
    );
    assert.deepEqual(gone, [], 'These surfaces match no public name: the name moved or was retired.');
  });

  test('every cited test exists and holds the title it is cited by', () => {
    const problems: string[] = [];
    for (const row of map.rows)
      for (const { file, title } of row.tests) {
        if (!existsSync(join(ROOT, file))) problems.push(`${row.id}: ${file} does not exist`);
        else if (title && !read(file).includes(title)) problems.push(`${row.id}: ${file} has no test "${title}"`);
      }
    assert.deepEqual(problems, []);
  });

  test('every row has a test, and a browser row a spec', () => {
    const problems = map.rows.flatMap((row) => [
      ...(row.tests.length ? [] : [`${row.id} has no test`]),
      ...(row.browser && !row.tests.some(({ file }) => file.endsWith('.spec.ts')) ? [`${row.id} is a browser row with no spec`] : []),
    ]);
    assert.deepEqual(problems, []);
  });

  test('no row leans on an example that does not ship', () => {
    const leaning = map.rows.flatMap((row) =>
      row.tests
        .filter(({ file }) => file.startsWith('examples/apps/') && !/^examples\/apps\/(tick|lintel|ladle)\//.test(file))
        .map(({ file }) => `${row.id}: ${file}`),
    );
    assert.deepEqual(leaning, [], 'Only Tick, Lintel and Ladle ship; cite their tests or a fixture test.');
  });

  test('a row only Lintel covers names keys Lintel still spells', () => {
    const spelled = spelledIn('lintel');
    const dropped = map.rows
      .filter((row) => row.tests.every(({ file }) => file.startsWith('examples/apps/lintel/')))
      .flatMap((row) =>
        row.surface
          .filter((surface) => surface.startsWith('dsl: '))
          .map((surface) => [row.id, /([A-Za-z_][A-Za-z0-9_]*)\$?$/.exec(surface.replace(/\[[^\]]*\]/g, ''))?.[1]] as const)
          .filter(([, key]) => key && !spelled.has(key))
          .map(([id, key]) => `${id}: ${key}`),
      );
    assert.deepEqual(dropped, [], 'Lintel no longer spells these: cite another test, or put the feature back in Lintel.');
  });

  test('each feature the example retirement put at risk cites a test outside the examples', () => {
    const risks = new Map(map.rows.filter((row) => row.risk).map((row) => [row.risk!, row]));
    for (let n = 1; n <= 14; n++) {
      const row = risks.get(`R${n}`);
      assert.ok(row, `no row carries R${n}`);
      assert.ok(
        row.tests.some(({ file }) => !file.startsWith('examples/')),
        `${row.id} (R${n}) has no test outside examples/`,
      );
    }
  });
});
