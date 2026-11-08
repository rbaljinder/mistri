/* The deployment's name, logo, theme and locale for an App (config "presentation"): validated at startup, laid over the
   definition before it is parsed, under a tenant's own branding and over the App's. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { overlayPresentation, parsePresentation, presentServed } from '../packages/mistri/src/server/app/appPresentation.js';
import { assertPresentationNamesApps, presentationOf } from '../packages/mistri/src/server/cli/apps.js';
import { outward, settingsMount } from '../packages/engine/src/shared/mount.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>';
const definition = (ui: Record<string, unknown> = {}) => ({
  id: 'bank',
  name: 'Retail Banking',
  shortName: 'Retail',
  resources: { account: { physical: 'account' } },
  views: { accounts: { kind: 'list', from: 'account', label: 'Accounts' } },
  home: 'accounts',
  nav: ['accounts'],
  ui,
});
function appDirectory(ui: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-presentation-'));
  mkdirSync(join(directory, 'logos'));
  writeFileSync(join(directory, 'logos', 'north.svg'), SVG);
  writeFileSync(join(directory, 'app.json'), JSON.stringify(definition(ui)));
  return directory;
}
const FILE = '/etc/deploy/north.json';
const presenting = (raw: unknown) => ({ file: FILE, apps: parsePresentation(raw, FILE) });

test('the override is read from the config, each key held to its shape, an error naming the key', () => {
  assert.deepEqual(parsePresentation({ bank: { name: ' Northside Bank ', theme: 'mono', locale: 'en-AU' } }, FILE), {
    bank: { name: 'Northside Bank', theme: 'mono', locale: 'en-AU' },
  });
  assert.deepEqual(parsePresentation(undefined, FILE), {});
  assert.throws(() => parsePresentation([], FILE), /north\.json: "presentation" must name each App's presentation by its id/);
  assert.throws(
    () => parsePresentation({ bank: { token: 'x' } }, FILE),
    /"presentation\.bank" has no "token"\. It takes: name, logo, theme, locale/,
  );
  assert.throws(() => parsePresentation({ bank: { name: '' } }, FILE), /"presentation\.bank"\.name must be 1 to 80/);
  assert.throws(() => parsePresentation({ bank: { locale: 'not a tag' } }, FILE), /locale "not a tag" is not a language tag/);
  assert.throws(
    () => parsePresentation({ bank: { logo: 'https://example.com/a.svg' } }, FILE),
    /is a URL; a logo is a file in the App's directory/,
  );
  assert.throws(() => parsePresentation({ bank: { logo: 'a.txt' } }, FILE), /is not a PNG, JPEG, WebP, GIF or SVG file/);
  assert.throws(() => parsePresentation({ bank: { theme: { palette: 'teal' } } }, FILE), /theme needs a preset/);
});

test('a theme the App cannot wear is refused at load, naming the presentation key and what it can wear', async () => {
  const directory = appDirectory();
  try {
    await assert.rejects(
      loadApp(directory, { presentation: presenting({ bank: { theme: 'nope' } }) }),
      /north\.json: "presentation\.bank"\.theme "nope" is not a built-in theme or one this App registers in ui\.customThemes \(/,
    );
    await assert.rejects(
      loadApp(directory, { presentation: presenting({ bank: { theme: { preset: 'mono', palette: 'nope' } } }) }),
      /theme\.palette "nope" is not a palette of "mono"/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a logo that is not a file in the App directory is refused at load, by the presentation key', async () => {
  const directory = appDirectory();
  try {
    await assert.rejects(
      loadApp(directory, { presentation: presenting({ bank: { logo: 'logos/missing.svg' } }) }),
      /"presentation\.bank"\.logo "logos\/missing\.svg" is not a file in the App's directory/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a logo that leads outside the App directory is refused, even when the file exists', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'mistri-presentation-outer-'));
  const directory = join(outer, 'app');
  mkdirSync(directory);
  writeFileSync(join(directory, 'app.json'), JSON.stringify(definition()));
  writeFileSync(join(outer, 'secret.svg'), SVG);
  try {
    for (const logo of ['../secret.svg', join(outer, 'secret.svg')])
      await assert.rejects(loadApp(directory, { presentation: presenting({ bank: { logo } }) }), /leads outside the App's directory/);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('the deployment is over the App definition: name, logo, theme and locale, and the App keeps the rest', async () => {
  const directory = appDirectory({ theme: { preset: 'workshop' }, locale: 'en-US', currency: 'USD' });
  try {
    const plain = await loadApp(directory);
    assert.equal(plain.app.name, 'Retail Banking');
    assert.equal(plain.app.shortName, 'Retail');
    const loaded = await loadApp(directory, {
      presentation: presenting({ bank: { name: 'Northside Bank', logo: 'logos/north.svg', theme: { preset: 'mono' }, locale: 'en-AU' } }),
    });
    assert.equal(loaded.app.name, 'Northside Bank');
    assert.equal(loaded.app.shortName, undefined, "a phone's bar does not keep the name the App was written for");
    assert.equal(loaded.app.ui.theme?.preset, 'mono');
    assert.equal(loaded.app.ui.locale, 'en-AU');
    assert.equal(loaded.app.ui.currency, 'USD');
    const logo = loaded.app.ui.logo as { href?: string };
    assert.match(logo.href ?? '', /^\/bank\/_brand\/north-[0-9a-f]{12}\.svg$/);
    assert.deepEqual(Object.keys(loaded.brand?.files ?? {}).length, 1);
    // Under a base path the same address is carried under it (shared/mount.ts), and the root App's own segment drops.
    assert.match(outward(settingsMount(['bank'], { basePath: '/portal' }), logo.href!), /^\/portal\/_brand\/north-[0-9a-f]{12}\.svg$/);
    // What a reload passes again is what the load kept.
    assert.equal(loaded.presentation?.apps.bank?.name, 'Northside Bank');
    // Another App's presentation changes nothing here.
    assert.equal((await loadApp(directory, { presentation: presenting({ other: { name: 'Elsewhere' } }) })).app.name, 'Retail Banking');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a tenant's own branding stays over the deployment: its fromRecord binding is kept, the deployment's theme is its fallback", async () => {
  const binding = {
    kind: 'fromRecord',
    from: 'profile',
    by: 'tenant',
    tenantField: 'tenant_id',
    fallback: { preset: 'workshop' },
    fields: { preset: 'preset' },
  };
  const raw = await overlayPresentation(definition({ theme: binding }), { theme: 'mono', name: 'Northside Bank' }, { id: 'bank' });
  const ui = raw.ui as { theme: typeof binding };
  assert.equal(ui.theme.kind, 'fromRecord');
  assert.equal(ui.theme.from, 'profile');
  assert.deepEqual(ui.theme.fallback, { preset: 'mono' });
  assert.equal(raw.name, 'Northside Bank');
  // The App with no deployment says what it said.
  assert.deepEqual(
    ((await overlayPresentation(definition({ theme: binding }), {}, { id: 'bank' })).ui as { theme: unknown }).theme,
    binding,
  );
});

test('a reader-owned locale column stays; the deployment gives the default under it', async () => {
  const raw = await overlayPresentation(
    definition({ locale: { column: 'person.locale', default: 'en-US' } }),
    { locale: 'fr-CA' },
    { id: 'bank' },
  );
  assert.deepEqual((raw.ui as { locale: unknown }).locale, { column: 'person.locale', default: 'fr-CA' });
});

test('a presentation for an App the server does not serve is refused with the Apps it does', async () => {
  const directory = appDirectory();
  try {
    const loaded = await loadApp(directory);
    const presentation = presentationOf({ presentation: { bnak: { name: 'x' } }, configPath: FILE });
    assert.throws(
      () => assertPresentationNamesApps(presentation, [loaded]),
      /"presentation\.bnak" names no App this server serves \("bank"\)/,
    );
    assert.doesNotThrow(() => assertPresentationNamesApps(presentationOf({ presentation: { bank: {} }, configPath: FILE }), [loaded]));
    assert.equal(presentationOf({ configPath: FILE }), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a built App takes the name, theme and locale, and refuses a logo: a build carries its own', () => {
  const app = parseAppConfig(definition({ theme: { preset: 'workshop' } }), 'app.json');
  const shown = presentServed(app, { name: 'Harbor Credit Union', theme: 'mono', locale: 'en-NZ' }, { id: 'bank' });
  assert.equal(shown.name, 'Harbor Credit Union');
  assert.equal(shown.shortName, undefined);
  assert.equal(shown.ui.theme?.preset, 'mono');
  assert.equal(shown.ui.locale, 'en-NZ');
  assert.equal(app.name, 'Retail Banking', 'the compiled definition is not changed in place');
  assert.throws(
    () => presentServed(app, { logo: 'logos/north.svg' }, { id: 'bank' }),
    /"presentation\.bank"\.logo cannot change a built App/,
  );
});
