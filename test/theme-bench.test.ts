/**
 * The theme bench `mistri dev` serves (server/themeBench/), and `shot
 * --recipes`' variants: a spec compiled and read with every contrast it
 * measures, the line to paste back that says the same spec, an address that
 * is nothing until a dev start mounts it and then answers this machine only.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { benchReading, literal, pasteLine, startThemeBench, startingSpec } from '../packages/mistri/src/server/themeBench/bench.js';
import { mountThemeBench, themeBenchRoute } from '../packages/mistri/src/server/themeBench/mount.js';
import { recipeVariants, RECIPE_REGIONS, RECIPE_SHEET_PARTS } from '../packages/mistri/src/server/build/shot.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { RECIPE_MENU, RECIPE_PARTS } from '../packages/engine/src/shared/themeRecipes.js';
import { themePreset } from '../packages/engine/src/shared/themePresets.js';
import { NO_MOUNT } from '../packages/engine/src/shared/mount.js';

const SPEC = {
  id: 'ledger',
  label: 'Ledger',
  extends: 'mono',
  colors: { light: { accent: '#1f5f8b' } },
  recipes: { bar: 'dark', table: 'tinted' },
};

const host = (ui: Record<string, unknown> = {}) => ({ app: { app: { id: 'books', name: 'Books', ui } }, pages: [] }) as unknown as AppHost;

describe('the bench reads a spec', () => {
  test('compiled, with each contrast measured in light and dark, and the line to paste back saying the same spec', () => {
    const reading = benchReading(SPEC);
    assert.equal(reading.error, undefined);
    assert.equal(reading.theme?.id, 'ledger');
    assert.equal(reading.theme?.recipes?.bar, 'dark');
    const ink = reading.checks.find((row) => row.check === 'ink on surface');
    assert.ok(ink && ink.light! > 4.5 && ink.dark! > 4.5 && ink.needs === 4.5, JSON.stringify(ink));
    assert.match(reading.paste!, /^export const theme = defineTheme\(\{/);
    const said = new Function(`return ${reading.paste!.replace(/^export const theme = defineTheme\(/, '').replace(/\);$/, '')}`)();
    assert.deepEqual(said, SPEC);
  });

  test('a failing color is said as check says it, and a spec that does not compile says why', () => {
    const pale = benchReading({ ...SPEC, colors: { light: { accentInk: '#9fd3ff' } } });
    assert.ok(
      pale.problems.some((message) => /accentInk/.test(message)),
      pale.problems.join('\n'),
    );
    const broken = benchReading({ ...SPEC, extends: 'nothing' });
    assert.match(broken.error!, /extends must name a built-in look/);
    assert.equal(broken.theme, undefined);
  });

  test('the literal is the TypeScript an author writes: bare keys, single quotes, a quoted key only where it must be', () => {
    assert.equal(literal({ a: "it's", 'b-c': [1, 2] }), "{ a: 'it\\'s', 'b-c': [1, 2] }");
    assert.equal(pasteLine({ kind: 'theme', id: 'x', label: 'X' }), "export const theme = defineTheme({ id: 'x', label: 'X' });");
  });

  test('an App starts from the theme it wears as written, or a new one over the built-in it names', () => {
    const own = compileAppTheme({ kind: 'theme', ...SPEC }, 'test');
    assert.deepEqual(startingSpec(host({ theme: { preset: 'ledger' }, customThemes: [own] })), SPEC);
    assert.deepEqual(startingSpec(host({ theme: { preset: 'sage' } })), { id: 'books-theme', label: 'Books', extends: 'sage' });
  });
});

describe('the bench address', () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!themeBenchRoute(req, res, url, NO_MOUNT)) res.writeHead(404).end('app');
  });
  const ready = new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
  after(() => {
    mountThemeBench(undefined);
    server.close();
  });
  const ask = async (path: string, init: { method?: string; host?: string; body?: unknown } = {}) => {
    const port = await ready;
    return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((done, fail) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'GET',
          headers: { host: init.host ?? `127.0.0.1:${port}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => done({ status: res.statusCode!, headers: res.headers, text }));
        },
      );
      req.on('error', fail);
      req.end(init.body ? JSON.stringify(init.body) : undefined);
    });
  };

  test('is nothing until a dev start mounts the bench: the server answers it as any unknown address', async () => {
    assert.equal((await ask('/_mistri/theme/')).text, 'app');
    assert.equal((await ask('/_theme')).text, 'app');
  });

  test('mounted, serves the page under a policy that allows its own script, its state and its compile; this machine only', async () => {
    const bench = startThemeBench({ apps: () => [host({ theme: { preset: 'mono' } })] });
    try {
      const short = await ask('/_theme');
      assert.equal(short.status, 308);
      assert.equal(short.headers.location, '/_mistri/theme/');
      const page = await ask('/_mistri/theme/');
      assert.equal(page.status, 200);
      assert.match(String(page.headers['content-security-policy']), /script-src 'self' 'sha256-/);
      assert.match(page.text, /name="mistri-theme-bench:light"[\s\S]*name="mistri-theme-bench:dark"/);
      const state = JSON.parse((await ask('/_mistri/theme/state')).text);
      assert.deepEqual(state.apps, [{ id: 'books', name: 'Books', home: '/books' }]);
      assert.equal(state.spec.extends, 'mono');
      assert.deepEqual(state.recipes.bar, Object.keys(RECIPE_MENU.bar));
      // The type controls: the base, and each role's menu where it takes one (a title's sizes in its range, by 2px).
      assert.deepEqual(state.type.bases, ['13px', '14px', '15px', '16px']);
      assert.equal(state.type.roles.title.size[0], '20px');
      assert.equal(state.type.roles.title.size.at(-1), '36px');
      assert.deepEqual(state.type.roles.nav.weight, [400, 500, 600]);
      assert.equal(state.type.roles.body.size, undefined);
      const html = (await ask('/_mistri/theme/')).text;
      assert.match(html, /<h2>Type<\/h2>/);
      // The surface controls: a pattern's kind and strength behind the page and the menu, and the icons' weight.
      assert.match(html, /<h2>Surface<\/h2>/);
      assert.deepEqual(state.surface, {
        kinds: ['paper', 'grain', 'grid', 'dots', 'lines', 'scanlines'],
        strengths: [1, 2, 3],
        icons: ['regular', 'light', 'bold', 'fill'],
      });
      const compiled = JSON.parse((await ask('/_mistri/theme/compile', { method: 'POST', body: { app: 'books', spec: SPEC } })).text);
      assert.equal(compiled.theme.id, 'ledger');
      assert.ok(compiled.checks.length > 10);
      // A name rebound to this machine reaches the socket, not the bench.
      assert.equal((await ask('/_mistri/theme/state', { host: 'evil.example' })).status, 403);
    } finally {
      bench.stop();
    }
    assert.equal((await ask('/_mistri/theme/')).text, 'app');
  });
});

test('shot --recipes shoots each value of a part with only that part changed, and knows where every part shows', () => {
  const lumen = themePreset('lumen')!;
  const variants = recipeVariants(lumen, 'table');
  assert.deepEqual(
    variants.map((variant) => variant.value),
    Object.keys(RECIPE_MENU.table),
  );
  for (const { value, theme } of variants) {
    assert.equal(theme.recipes?.table, value);
    assert.equal(theme.base, 'lumen');
    assert.deepEqual({ ...theme.recipes, table: undefined }, { ...lumen.recipes, table: undefined });
    assert.deepEqual(theme.light, lumen.light);
  }
  assert.deepEqual(Object.keys(RECIPE_REGIONS).sort(), [...RECIPE_SHEET_PARTS].sort());
  assert.ok(RECIPE_PARTS.every((part) => RECIPE_SHEET_PARTS.includes(part)));
});

test("shot --recipes also shoots a control's corner, a pill's corner and a control's edge, nothing else changed", () => {
  const lumen = themePreset('lumen')!;
  const pills = recipeVariants(lumen, 'radius.pill');
  assert.deepEqual(
    pills.map((variant) => [variant.value, variant.theme.radius?.pill]),
    [
      ['round', undefined],
      ['4px', '4px'],
      ['0px', '0px'],
    ],
  );
  const corners = recipeVariants(lumen, 'radius.control');
  assert.deepEqual(
    corners.map((variant) => [variant.value, variant.theme.radius?.control, variant.theme.radius?.field]),
    [
      ['0px', '0px', lumen.radius?.field],
      ['4px', '4px', lumen.radius?.field],
      ['8px', '8px', lumen.radius?.field],
      ['round', '999px', lumen.radius?.field],
    ],
  );
  const edges = recipeVariants(lumen, 'border.control');
  assert.deepEqual(
    edges.map((variant) => [variant.value, variant.theme.light.rulesControl, variant.theme.dark.rulesControl]),
    [
      ['1px', '1px', '1px'],
      ['2px', '2px', '2px'],
    ],
  );
  for (const { theme } of [...corners, ...pills, ...edges]) assert.deepEqual(theme.recipes, lumen.recipes);
});
