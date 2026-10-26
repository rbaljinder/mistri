import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import {
  bindRecordBranding,
  BrandingValidationError,
  compileBranding,
  fromRecord,
  parseRecordBranding,
  validateBranding,
  type BrandingCatalog,
  type BrandingSelection,
  type RecordBrandingSpec,
} from '../packages/mistri/src/shared/branding.js';
import { themeWarnings, THEME_BASES } from '../packages/engine/src/shared/theme.js';

const selection: BrandingSelection = {
  deployment: 'deployment',
  app: 'site',
  source: 'keystone',
  bindingRevision: '1',
  catalogRevision: '1',
  tenant: 'north',
};
const options = {
  by: 'host',
  tenantField: 'dealer_id',
  publishedField: 'published',
  fallback: { preset: 'sage' },
  fields: {
    preset: 'base',
    accent: 'color',
    fontPair: 'font',
    barStyle: 'bar',
    name: 'name',
    heading: 'headline',
    tagline: 'tagline',
    hours: 'hours',
    about: 'about',
    logo: { from: 'asset', key: { id: 'logo_id' }, alt: 'Dealer logo' },
    hero: { from: 'asset', key: { id: 'hero_id' } },
  },
} as const;
const spec = fromRecord('dealer_site', options);
const catalog: BrandingCatalog = {
  resources: {
    dealer_site: {
      primaryKey: ['id'],
      columns: {
        id: 'text',
        dealer_id: 'text',
        version: 'integer',
        published: 'boolean',
        base: 'text',
        color: 'text',
        font: 'text',
        bar: 'text',
        name: 'text',
        headline: 'text',
        tagline: 'text',
        hours: 'text',
        about: 'text',
        logo_id: 'text',
        hero_id: 'text',
      },
    },
    asset: { file: true, primaryKey: ['id'], columns: { id: 'text' } },
  },
};
const binding = bindRecordBranding(spec, catalog);
const row = () => ({
  id: 'site-1',
  dealer_id: 'north',
  version: 0,
  published: true,
  base: 'mono',
  color: '#1D3F8C',
  font: 'system',
  bar: 'plain',
  name: 'North dealer',
  headline: 'Find a car',
  tagline: null,
  hours: 'Mon–Fri 9–5',
  about: 'A local dealership.',
  logo_id: 'logo-1',
  hero_id: null,
});

test('fromRecord is detached, deeply frozen plain data and preserves literal references', () => {
  const own = { ...options, fallback: { preset: 'sage' as const }, fields: { logo: { from: 'asset', key: { id: 'logo_id' } } } };
  const descriptor = fromRecord('dealer_site', own);
  const typed: RecordBrandingSpec<'dealer_site'> = descriptor;
  assert.equal(typed.kind, 'fromRecord');
  assert.equal(typed.from, 'dealer_site');
  own.fields.logo.key.id = 'another';
  assert.equal(descriptor.fields.logo?.key.id, 'logo_id');
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.fallback));
  assert.ok(Object.isFrozen(descriptor.fields.logo?.key));
  assert.deepEqual(parseRecordBranding(JSON.parse(JSON.stringify(spec))), spec);
  assert.equal(Object.isFrozen(own), false);
});

test('descriptor parsing refuses unknown properties, callbacks, accessors and CSS/image injection', () => {
  let ran = false;
  const getter = Object.defineProperty({}, 'accent', {
    enumerable: true,
    get() {
      ran = true;
      return 'color';
    },
  });
  for (const input of [
    { ...spec, by: 'cookie' },
    { ...spec, kind: 'theme' },
    { ...spec, css: 'body{}' },
    { ...spec, fallback: { preset: 'sage', css: 'body{}' } },
    { ...spec, fallback: { preset: 'unknown' } },
    { ...spec, fields: { font: 'font' } },
    { ...spec, fields: { accent: () => '#123456' } },
    { ...spec, fields: getter },
    { ...spec, fields: { logo: 'https://example.test/logo.png' } },
    { ...spec, fields: { logo: { from: 'https://evil.test', key: { id: 'logo_id' } } } },
    { ...spec, fields: { logo: { from: 'asset', key: {}, href: 'javascript:alert(1)' } } },
    { ...spec, fields: { logo: { from: 'asset', key: { id: 'logo_id' }, css: 'color:red' } } },
    { ...spec, fields: JSON.parse('{"__proto__":"name"}') },
    { ...spec, tenantField: 'id; DROP TABLE dealer_site' },
  ])
    assert.throws(() => parseRecordBranding(input));
  assert.equal(ran, false);
  assert.throws(() => fromRecord('dealer_site', { ...options, kind: 'ignored' } as typeof options));
});

test('binding checks declared resources, columns, types, exact file keys and catalog ownership', () => {
  assert.ok(Object.isFrozen(binding.columnKinds));
  assert.deepEqual(binding.primaryKey, ['id']);
  assert.ok(binding.columns.includes('logo_id'));
  for (const change of [
    { from: 'missing' },
    { tenantField: 'missing' },
    { tenantField: 'version' },
    { publishedField: 'name' },
    { fields: { accent: 'published' } },
    { fields: { logo: { from: 'dealer_site', key: { id: 'logo_id' } } } },
    { fields: { logo: { from: 'asset', key: { wrong: 'logo_id' } } } },
    { fields: { logo: { from: 'asset', key: { id: 'missing' } } } },
    { fields: { logo: { from: 'asset', key: { id: 'version' } } } },
  ])
    assert.throws(() => bindRecordBranding({ ...spec, ...change }, catalog));
  assert.throws(() =>
    bindRecordBranding(spec, { resources: { ...catalog.resources, dealer_site: { ...catalog.resources.dealer_site, primaryKey: [] } } }),
  );
  assert.throws(() =>
    bindRecordBranding(
      { ...spec, fields: { logo: { from: 'asset', key: { id: 'logo_id', extra: 'hero_id' } } } },
      { resources: { ...catalog.resources, asset: { file: true, primaryKey: ['id', 'id'], columns: { id: 'text', extra: 'text' } } } },
    ),
  );
});

test('composite file keys require every component or a wholly absent image', () => {
  const composite = bindRecordBranding(
    { ...spec, fields: { logo: { from: 'asset', key: { tenant: 'dealer_id', id: 'logo_id' } } } },
    { resources: { ...catalog.resources, asset: { file: true, primaryKey: ['tenant', 'id'], columns: { tenant: 'text', id: 'text' } } } },
  );
  const resolved = validateBranding(composite, row(), selection);
  assert.deepEqual(resolved.images.logo?.key, { id: 'logo-1', tenant: 'north' });
  assert.equal(compileBranding(composite, { ...row(), logo_id: null }, selection).status, 'fallback');
});

test('compiler generates deterministic light/dark tokens and safe file references without mutating presets or rows', () => {
  const input = row(),
    before = JSON.stringify(input);
  const compiled = validateBranding(binding, input, selection);
  assert.equal(compiled.status, 'resolved');
  assert.equal(compiled.theme.light.accent, '#1d3f8c');
  // The existing single-accent rule is 62% brand, 38% white, rounded to hex.
  assert.equal(compiled.theme.dark.accent, '#7388b8');
  assert.equal(compiled.tokens.dark['--accent'], '#7388b8');
  assert.equal(compiled.theme.palettes, undefined);
  assert.deepEqual(compiled.images.logo, { from: 'asset', key: { id: 'logo-1' }, alt: 'Dealer logo' });
  assert.equal(compiled.images.hero, undefined);
  assert.deepEqual(compiled.identity.recordKey, { id: 'site-1' });
  assert.equal(compiled.identity.version, '0');
  assert.deepEqual(themeWarnings([compiled.theme]), []);
  assert.deepEqual(validateBranding(binding, input, selection), compiled);
  assert.equal(JSON.stringify(input), before);
  for (const value of [
    compiled,
    compiled.theme,
    compiled.theme.light,
    compiled.tokens.light,
    compiled.content,
    compiled.identity.recordKey,
    compiled.images.logo?.key,
    compiled.diagnostics,
  ])
    assert.ok(Object.isFrozen(value));
  assert.equal(Object.isFrozen(input), false);
});

test('every base supports the bounded brand, fonts and bar choices and retains its structure', () => {
  for (const base of THEME_BASES)
    for (const bar of ['plain', 'brand']) {
      const compiled = validateBranding(binding, { ...row(), base, bar, font: 'editorial', color: '#17366c' }, selection);
      assert.equal(compiled.theme.base, base);
      assert.match(compiled.tokens.light['--heading-font'], /Georgia/);
      assert.equal(compiled.barStyle, bar);
      assert.deepEqual(themeWarnings([compiled.theme]), []);
      if (bar === 'brand') assert.notEqual(compiled.theme.light.navGround, compiled.theme.light.surface);
    }
  const darkest = validateBranding(binding, { ...row(), base: 'mono', color: '#000000' }, selection);
  assert.notEqual(darkest.theme.dark.accent, '#616161', 'dark derivation brightens beyond the legacy mix when necessary');
  assert.equal(darkest.theme.light.accent, '#000000');
});

test('save-time contrast rejection uses shared interaction diagnostics; runtime returns a clean base', () => {
  for (const color of ['#ffffff', '#999999', '#ffff00']) {
    assert.throws(() => validateBranding(binding, { ...row(), color }, selection), BrandingValidationError);
    const fallback = compileBranding(binding, { ...row(), color }, selection);
    assert.equal(fallback.status, 'fallback');
    assert.equal(fallback.identity.recordKey, null);
    assert.equal(fallback.identity.version, null);
    assert.deepEqual(fallback.content, {});
    assert.deepEqual(fallback.images, {});
    assert.ok(fallback.diagnostics.some((item) => item.code === 'contrast'));
  }
  const interaction = compileBranding(binding, { ...row(), color: '#767676' }, selection);
  assert.ok(interaction.diagnostics.some((item) => /selected tab|accentSoft|navigation hover|focus ring/.test(item.message)));
});

test('stored data cannot become arbitrary CSS, fonts, images or markup in tokens', () => {
  const malicious = '</script><script>alert(1)</script><img src=x onerror=alert(1)>';
  const safe = validateBranding(binding, { ...row(), headline: malicious }, selection);
  // Content is plain text for the rendering owner to escape, not generated HTML.
  assert.equal(safe.content.heading, malicious);
  assert.ok(!JSON.stringify(safe.tokens).includes('<'));
  for (const changes of [
    { color: 'red' },
    { color: '#fff' },
    { color: '#123456;--ground:red' },
    { color: 'url(https://evil.test)' },
    { font: 'Arial; color:red' },
    { base: 'body{}' },
    { bar: 'url(https://evil.test)' },
    { name: 'x'.repeat(121) },
    { headline: 'a\u0000b' },
    { hours: 'x'.repeat(1001) },
    { about: 'x'.repeat(8001) },
    { logo_id: { href: 'https://evil.test' } },
    { logo_id: 42 },
    { version: -1 },
    { version: '01' },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { published: 1 },
    { dealer_id: 'south' },
  ]) {
    const answer = compileBranding(binding, { ...row(), ...changes }, selection);
    assert.equal(answer.status, 'fallback', JSON.stringify(changes));
    assert.equal(answer.diagnostics[0].code, 'invalid_record');
    assert.ok(!answer.diagnostics[0].message.includes('evil'));
  }
  const missing: Record<string, unknown> = row();
  delete missing.color;
  assert.equal(compileBranding(binding, missing, selection).status, 'fallback');
  assert.equal(validateBranding(binding, { ...row(), version: '9007199254740993' }, selection).identity.version, '9007199254740993');
});

// Compile-time contract checks are verified by the isolated program below.
// eslint-disable-next-line no-constant-condition -- Type-error assertions must be checked but never executed.
if (false) {
  // @ts-expect-error -- intent has precisely two sources.
  fromRecord('site', { ...options, by: 'cookie' });
  // @ts-expect-error -- fonts are not an author-supplied CSS surface.
  fromRecord('site', { ...options, fields: { fonts: 'font' } });
  // @ts-expect-error -- a file is a declared resource/key binding, not a URL.
  fromRecord('site', { ...options, fields: { logo: 'https://example.test/logo' } });
  // @ts-expect-error -- definitions and compiled projections are immutable.
  spec.fallback.preset = 'lumen';
}

test('the four-file foundation typechecks in an isolated TypeScript program', () => {
  const files = [
    '../packages/mistri/src/shared/branding.ts',
    '../packages/mistri/src/server/app/recordBranding.ts',
    './branding.test.ts',
    './record-branding.test.ts',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  assert.equal(
    typecheck(files, {
      options: { target: 'ES2023', lib: ['es2023', 'dom'], noUnusedLocals: true, noUnusedParameters: true, esModuleInterop: true },
    }),
    '',
  );
});

test('the look and the brand color are named as ui.theme names them, and the old words are refused by name', () => {
  assert.throws(
    () => parseRecordBranding({ ...spec, fallback: { base: 'sage' } }),
    /fromRecord fallback has "base", which is now "preset"/,
  );
  assert.throws(
    () => parseRecordBranding({ ...spec, fields: { brandColor: 'color' } }),
    /fromRecord fields has "brandColor", which is now "accent"/,
  );
});
