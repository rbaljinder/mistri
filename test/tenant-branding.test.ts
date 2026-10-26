/**
 * A tenant's branding, from its declaration to what a reader receives: what
 * an App may let its tenants change, the value a save admits (and the CSS,
 * markup and files it refuses), a logo's bytes, the copy every instance
 * shares and drops on a save, and the mail a tenant's link page and messages
 * wear. The HTTP routes and who may save are tenant-http.test.ts's; the store
 * is branding-store.test.ts's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import type { BrandingWrite, StoredBranding, StoredBrandingLogo } from '../packages/mistri/src/adapters/branding/branding.js';
import { parseTestApp } from './support/commandCatalog.js';
import { resolveViews } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { admitLogo, LogoRefused, sanitizeSvg } from '../packages/mistri/src/server/app/brandImage.js';
import { brandingLogoHeaders, createTenantBrandingService } from '../packages/mistri/src/server/tenant/tenantBranding.js';
import {
  audienceBranding,
  BrandingRefused,
  parseBrandingDeclaration,
  tenantTheme,
  validateTenantBranding,
} from '../packages/mistri/src/shared/tenantBranding.js';
import { fillMailBrand, mailLinkPage, mailLinkPolicy, type MailBrand } from '../packages/mistri/src/server/email/mailLinkPage.js';

const tenantAuth = { rows: 'tenant', roles: { admin: {}, agent: {}, staff: { realm: 'platform' } } } as never;
const ui = { theme: { preset: 'mono' } } as never;
const declare = (raw: unknown, auth: unknown = tenantAuth) => parseBrandingDeclaration(raw, { ui, auth: auth as never }, 'test');

test('an App lets its tenants change only what branding.allow names, and only its tenant roles save it', () => {
  const ok = declare({ allow: ['name', 'logo', 'accent', 'radius', 'density'], editors: ['admin'] });
  assert.deepEqual(ok.allow, ['name', 'logo', 'accent', 'radius', 'density']);
  assert.equal(ok.themes.length, 1);
  const refusals: Array<[unknown, RegExp, unknown?]> = [
    [{ allow: ['name'], editors: ['admin'] }, /needs a tenant App/, { roles: { admin: {} } }],
    [{ allow: ['ink'], editors: ['admin'] }, /Grounds, ink and recipes stay the App's/],
    [{ allow: ['preset'], editors: ['admin'] }, /needs more than one theme/],
    [{ allow: ['palette'], editors: ['admin'] }, /no theme offered has a palette/],
    [{ allow: ['name', 'name'], editors: ['admin'] }, /twice/],
    [{ allow: ['name'], editors: [] }, /must name the tenant roles/],
    [{ allow: ['name'], editors: ['nobody'] }, /not a tenant role/],
    [{ allow: ['name'], editors: ['staff'] }, /not a tenant role/],
    [{ allow: ['name'], editors: ['admin'], themes: ['nope'] }, /not a built-in theme/],
    [{ allow: ['name'], editors: ['admin'], grounds: '#fff' }, /unsupported field "grounds"/],
  ];
  for (const [raw, message, auth] of refusals) assert.throws(() => declare(raw, auth ?? tenantAuth), message);
  const two = declare({ allow: ['preset', 'palette'], editors: ['admin'], themes: ['mono', 'lumen'] });
  assert.deepEqual(
    two.themes.map((theme) => theme.id),
    ['mono', 'lumen'],
  );
});

test('a saved value is checked field by field: CSS and markup never pass, and an unreadable accent is refused in a sentence', () => {
  const declaration = declare({ allow: ['name', 'accent', 'radius', 'density'], editors: ['admin'] });
  const refused = (raw: unknown) => {
    try {
      validateTenantBranding(raw, declaration);
    } catch (error) {
      assert.ok(error instanceof BrandingRefused);
      return error.refusals.map((refusal) => refusal.field);
    }
    assert.fail(`${JSON.stringify(raw)} was admitted`);
  };
  assert.deepEqual(refused({ accent: 'red;}body{display:none' }), ['accent']);
  assert.deepEqual(refused({ accent: '#1d4ed8;}body{x:y' }), ['accent']);
  assert.deepEqual(refused({ accent: { light: '#1d4ed8', dark: 'url(https://evil.example/x)' } }), ['accent']);
  assert.deepEqual(refused({ accent: 'expression(alert(1))' }), ['accent']);
  assert.deepEqual(refused({ radius: '4px;color:red' }), ['radius']);
  assert.deepEqual(refused({ radius: '40px' }), ['radius']);
  assert.deepEqual(refused({ density: 'huge' }), ['density']);
  assert.deepEqual(refused({ name: '<img src=x onerror=alert(1)>' }), ['name']);
  assert.deepEqual(refused({ name: 'one\nline' }), ['name']);
  // Not allowed by this App, so not saved, whatever it says.
  assert.deepEqual(refused({ preset: 'lumen' }), ['name']);
  // A color a reader cannot read is refused by the theme validator, in its fixed sentence.
  const pale = (() => {
    try {
      validateTenantBranding({ accent: '#f5f5f5' }, declaration);
    } catch (error) {
      return error as BrandingRefused;
    }
  })();
  assert.ok(pale instanceof BrandingRefused);
  assert.equal(pale.refusals[0]!.field, 'accent');
  assert.match(pale.refusals[0]!.message, /^This accent is too light/);
  const value = validateTenantBranding({ name: '  North Co ', accent: '#1D4ED8', radius: '4px', density: 'compact' }, declaration);
  assert.deepEqual(value, {
    name: 'North Co',
    accent: { light: '#1d4ed8', dark: value.accent!.dark },
    radius: '4px',
    density: 'compact',
  });
  assert.match(value.accent!.dark, /^#[0-9a-f]{6}$/);
});

test('a deep brand blue reads by night in Lumen and Sage: the dark accent is lifted, not refused', () => {
  for (const theme of ['lumen', 'sage']) {
    const declaration = parseBrandingDeclaration(
      { allow: ['accent'], editors: ['admin'] },
      { ui: { theme: { preset: theme } } as never, auth: tenantAuth },
      'test',
    );
    const value = validateTenantBranding({ accent: '#1d4ed8' }, declaration);
    assert.equal(value.accent!.light, '#1d4ed8');
    assert.match(value.accent!.dark, /^#[0-9a-f]{6}$/);
    // Lighter than the plain 62% mix, and still a blue: the hue is kept.
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(value.accent!.dark.slice(at, at + 2), 16));
    assert.ok(b! > r! && b! > g!, value.accent!.dark);
    // A pair the person chose is held as chosen: a dark accent no reader can read is still refused.
    assert.throws(
      () => validateTenantBranding({ accent: { light: '#1d4ed8', dark: '#0a0a40' } }, declaration),
      (error: unknown) => error instanceof BrandingRefused && /too dark/.test(error.message),
    );
  }
});

test('a logo is sniffed by its bytes, held to its size, and an SVG is written again from an allowlist', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  const admitted = admitLogo(png);
  assert.equal(admitted.type, 'image/png');
  assert.match(admitted.hash, /^[0-9a-f]{64}$/);
  const big = Buffer.concat([png, Buffer.alloc(256 * 1024)]);
  assert.throws(
    () => admitLogo(big),
    (error: unknown) => error instanceof LogoRefused && /larger than 256 KB/.test(error.message),
  );
  assert.throws(() => admitLogo(Buffer.alloc(0)), LogoRefused);
  assert.throws(() => admitLogo(Buffer.from('<html><script>alert(1)</script></html>')), /not a PNG, JPEG, WebP, GIF or SVG/);
  assert.throws(() => admitLogo(Buffer.from(`<svg>${' '.repeat(65 * 1024)}</svg>`)), /too large to be an SVG mark/);
  assert.throws(
    () => admitLogo(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')),
    /document type or entities/,
  );

  const hostile = admitLogo(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
        '<script>alert(1)</script>' +
        '<a href="javascript:alert(1)"><rect width="1" height="1"/></a>' +
        '<rect width="10" height="10" fill="#123456" style="fill:url(https://evil.example)"/>' +
        '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>' +
        '<image href="https://evil.example/x.png"/>' +
        '<use xlink:href="https://evil.example/s.svg#a"/>' +
        '<circle cx="5" cy="5" r="2" onclick="alert(1)"/>' +
        '</svg>',
    ),
  );
  assert.equal(hostile.type, 'image/svg+xml');
  const text = hostile.bytes.toString('utf8');
  assert.doesNotMatch(text, /script|onload|onclick|javascript|foreignObject|iframe|evil|href|style|<image|<use/i);
  assert.match(text, /<rect[^>]*fill="#123456"/);
  assert.match(text, /<circle/);
  // Writing it again changes nothing: what is served is what was checked.
  assert.equal(sanitizeSvg(text), text);
});

test('a logo is served as its sniffed type, never sniffed again, cached for good, and runs nothing opened on its own', () => {
  const headers = brandingLogoHeaders({ type: 'image/svg+xml', bytes: new Uint8Array(12) });
  assert.equal(headers['content-type'], 'image/svg+xml');
  assert.equal(headers['content-length'], '12');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(headers['content-security-policy']!, /default-src 'none'/);
  assert.match(headers['content-security-policy']!, /\bsandbox\b/);
  assert.doesNotMatch(headers['content-security-policy']!, /script-src/);
});

function memoryStore() {
  const values = new Map<string, StoredBranding & { logoHash: string | null }>();
  const logos = new Map<string, StoredBrandingLogo>();
  const writes: BrandingWrite[] = [];
  return {
    writes,
    reads: 0,
    async read(query: { tenant: string }) {
      this.reads++;
      return values.get(query.tenant) ?? null;
    },
    async logo(query: { hash: string }) {
      return logos.get(query.hash) ?? null;
    },
    async write(write: BrandingWrite) {
      writes.push(write);
      if (write.logo) logos.set(write.logo.hash, { type: write.logo.type, bytes: write.logo.bytes });
      if (write.darkLogo) logos.set(write.darkLogo.hash, { type: write.darkLogo.type, bytes: write.darkLogo.bytes });
      const revision = (values.get(write.tenant)?.revision ?? 0) + 1;
      values.set(write.tenant, { value: write.value, revision, by: write.by, at: write.at, logoHash: write.logoHash });
      return revision;
    },
  };
}

const brandedApp = () =>
  parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      ui: { theme: { preset: 'mono' } },
      branding: { allow: ['name', 'accent', 'logo'], editors: ['admin'] },
      auth: { rows: 'tenant', roles: { admin: { read: true }, agent: { read: true } } },
      sources: { business: { connection: 'business' } },
      resources: { ticket: { physical: 'ticket', owner: 'tenant' } },
      views: { ticket: { kind: 'list', from: 'ticket' } },
      home: 'ticket',
    },
    'branding fixture',
  );

test('every instance reads a save on its next page: the copy they share is dropped, and a body cannot name a logo it did not upload', async () => {
  const app = brandedApp();
  const store = memoryStore();
  const cache = new MemoryCacheStore();
  const one = createTenantBrandingService({ app, store, cache });
  const two = createTenantBrandingService({ app, store, cache });
  assert.equal(await two.presentation('north'), undefined);
  const before = store.reads;
  assert.equal(await two.presentation('north'), undefined);
  assert.equal(store.reads, before, 'the second read is the shared copy');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 3)]);
  await one.save('north', { value: { name: 'North Co', accent: '#1d4ed8' }, logo: png.toString('base64') }, 'alice');
  const seen = await two.presentation('north');
  assert.equal(seen?.value.content.name, 'North Co');
  assert.match(String(seen?.value.mark?.src), /^\/api\/branding\/logo\/[0-9a-f]{64}$/);
  assert.equal(seen?.value.theme.light.accent, '#1d4ed8');

  // A hash in the body is not an upload: the stored logo stays, and another tenant's is never borrowed.
  const kept = store.writes.at(-1)!.logoHash;
  await one.save('north', { value: { name: 'North Co', logo: { hash: 'f'.repeat(64), type: 'image/png' } } }, 'alice');
  assert.equal(store.writes.at(-1)!.logoHash, kept);
  await one.save('north', { value: { name: 'North Co' }, logo: null }, 'alice');
  assert.equal(store.writes.at(-1)!.logoHash, null);
  assert.equal((await two.presentation('north'))?.value.mark, undefined);
  await assert.rejects(one.save('north', { value: {}, logo: 'not base64!' }, 'alice'), LogoRefused);
  await assert.rejects(one.save('north', { value: {}, logo: 42 }, 'alice'), LogoRefused);
  await assert.rejects(one.save('north', { value: { accent: 'red;}' } }, 'alice'), BrandingRefused);
  assert.equal(await two.presentation('south'), undefined);
});

test("a tenant's mail wears its name, logo and accent, from validated values only", async () => {
  const brand: MailBrand = {
    name: 'North & <Co>',
    logo: `/api/branding/logo/${'a'.repeat(64)}`,
    light: { accent: '#1d4ed8', onAccent: '#ffffff' },
    dark: { accent: '#9db8f2', onAccent: '#101010' },
  };
  const page = mailLinkPage({ app: 'Desk', what: 'Ticket', nonce: 'n0nce', view: { title: 'Help' }, brand, root: '../..' });
  assert.match(page, /--accent:#1d4ed8;--on-accent:#ffffff/);
  assert.match(page, /<img src="..\/..\/api\/branding\/logo\/a{64}" alt="North &amp; &lt;Co&gt;" width="96" height="24">/);
  assert.match(page, /<title>Help · North &amp; &lt;Co&gt;<\/title>/);
  assert.doesNotMatch(page, /<script/);
  assert.match(mailLinkPolicy('n0nce', brand), /img-src 'self'/);
  assert.doesNotMatch(mailLinkPolicy('n0nce'), /img-src/);

  // A value that is not a plain hex, or a logo address that is not one, never reaches the page.
  const forged = { ...brand, logo: 'https://evil.example/x.png', light: { accent: 'red;}body{x:y', onAccent: '#fff' } } as MailBrand;
  const safe = mailLinkPage({ app: 'Desk', what: 'Ticket', nonce: 'n0nce', view: { title: 'Help' }, brand: forged });
  assert.doesNotMatch(safe, /evil|red;|--on-accent:/);
  assert.doesNotMatch(mailLinkPolicy('n0nce', forged), /img-src/);

  const html = fillMailBrand(
    '<td style="background:{brand.accent}">{brand.logo}</td><p>{brand.name}</p>',
    brand,
    'https://desk.example.com/tools/',
    true,
  );
  assert.match(html, /background:#1d4ed8/);
  assert.match(
    html,
    /<img src="https:\/\/desk.example.com\/tools\/api\/branding\/logo\/a{64}" alt="North &amp; &lt;Co&gt;" width="96" height="24"/,
  );
  assert.match(html, /<p>North &amp; &lt;Co&gt;<\/p>/);
  assert.equal(fillMailBrand('From {brand.name}: {brand.logo}', brand, 'https://x', false), 'From North & <Co>: North & <Co>');
  assert.equal(fillMailBrand('{brand.accent}', forged, 'https://x', true), '');
  assert.equal(fillMailBrand('{brand.logo}', forged, 'https://x', true), 'North &amp; &lt;Co&gt;');
});

test("the mail brand is the App's own where a tenant saved none", async () => {
  const app = brandedApp();
  const service = createTenantBrandingService({ app, store: memoryStore(), cache: new MemoryCacheStore() });
  const own = await service.mail('north');
  assert.equal(own.name, 'Desk');
  assert.equal(own.logo, undefined);
  assert.match(own.light.accent, /^#[0-9a-f]{6}$/);
  assert.match(own.dark.onAccent, /^#[0-9a-f]{6}$/);
});

test('a dashboard with the Branding block resolves: the block reads no table, so the view is not dropped', () => {
  const app = parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      branding: { allow: ['name'], editors: ['admin'] },
      auth: { rows: 'tenant', roles: { admin: { read: true } } },
      sources: { business: { connection: 'business' } },
      resources: { ticket: { physical: 'ticket', owner: 'tenant' } },
      views: {
        ticket: { kind: 'list', from: 'ticket' },
        settings: { kind: 'dashboard', label: 'Settings', sections: [{ kind: 'branding', title: 'Branding' }] },
      },
      home: 'ticket',
      nav: ['ticket', 'settings'],
    },
    'branding dashboard',
  );
  const schema: DatabaseSchema = {
    label: 'Desk',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'ticket',
        name: 'ticket',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'tenant_id', type: 'TEXT', nullable: false, primaryKey: false },
        ],
      },
    ],
  } as DatabaseSchema;
  const settings = resolveViews(app, schema).settings as { error?: string; sections: { kind: string }[] };
  assert.equal(settings.error, undefined);
  assert.deepEqual(
    settings.sections.map((section) => section.kind),
    ['branding'],
  );
});

test("a tenant's accent is its charts' first series, in a theme whose first series was not its accent", () => {
  /* Lumen's accent is navy and its first series blue: the preview's bars and every dashboard stayed blue under a teal brand. */
  const declaration = declare({ allow: ['accent'], editors: ['admin'], themes: ['lumen'] });
  const theme = tenantTheme(declaration, { accent: { light: '#0f766e', dark: '#2dd4bf' } });
  assert.equal(theme.light.chart1, '#0f766e');
  assert.equal(theme.dark.chart1, '#2dd4bf');
  assert.equal(theme.light.accent, '#0f766e');
  /* The rest of the series stay the theme's. */
  assert.equal(theme.light.chart2, declaration.themes[0]!.light.chart2);
});

test("a role's theme (ui.theme.for) wins over the tenant's pick, the tenant's accent laid over it, and a save reads on it too", () => {
  const forUi = {
    theme: { preset: 'mono', for: { public: 'sage', roles: { agent: 'lumen' } } },
  } as never;
  const declaration = parseBrandingDeclaration(
    { allow: ['accent', 'preset', 'name'], editors: ['admin'], themes: ['mono', 'sage'] },
    { ui: forUi, auth: tenantAuth },
    'test',
  );
  assert.deepEqual(
    declaration.audienceThemes?.map((theme) => theme.id),
    ['sage', 'lumen'],
  );
  const value = validateTenantBranding({ name: 'North Co', accent: '#1d4ed8', preset: 'mono' }, declaration);
  const worn = (audience: { public?: boolean; roles?: string[] }) => {
    const branded = audienceBranding(declaration, value, audience);
    return tenantTheme(branded.declaration, branded.value);
  };
  // An agent wears Lumen with the tenant's accent; an admin the tenant's pick; a visitor the public theme.
  assert.equal(worn({ roles: ['agent'] }).base, 'lumen');
  assert.equal(worn({ roles: ['agent'] }).light.accent, '#1d4ed8');
  assert.equal(worn({ roles: ['admin'] }).base, 'mono');
  assert.equal(worn({ public: true }).base, 'sage');
  assert.equal(worn({ public: true }).label, 'North Co');
  // An accent that cannot be read on a theme some of the tenant's people wear is refused, naming that theme.
  assert.throws(
    () => validateTenantBranding({ accent: '#ffe066', preset: 'mono' }, declaration),
    (error: BrandingRefused) =>
      error.refusals.some((refusal) => / in (Lumen|Sage), which some of your people wear\.$/.test(refusal.message)),
  );
});

test('a tenant may add a dark logo beside its logo: it rides the mark, falls back to none, and goes with the logo', async () => {
  const app = brandedApp();
  const store = memoryStore();
  const service = createTenantBrandingService({ app, store, cache: new MemoryCacheStore() });
  const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, fill)]);
  const address = /^\/api\/branding\/logo\/[0-9a-f]{64}$/;

  // Without a dark logo the mark is the one picture, as before.
  await service.save('north', { value: { name: 'North Co' }, logo: png(3).toString('base64') }, 'alice');
  const light = (await service.presentation('north'))?.value.mark;
  assert.match(String(light?.src), address);
  assert.equal(light?.dark, undefined);

  // The dark logo is stored, named in the value, and served by its own hash.
  await service.save('north', { value: { name: 'North Co' }, darkLogo: png(9).toString('base64') }, 'alice');
  const mark = (await service.presentation('north'))?.value.mark;
  assert.match(String(mark?.dark), address);
  assert.equal(mark?.src, light?.src, 'the light logo is kept when only the dark one is uploaded');
  assert.notEqual(mark?.dark, mark?.src);
  assert.ok(await service.logo(String(mark?.dark).split('/').pop()!));

  // A saved dark logo stays through a save that uploads nothing, and a body cannot name one it did not upload.
  await service.save('north', { value: { name: 'North Co', logoDark: { hash: 'f'.repeat(64), type: 'image/png' } } }, 'alice');
  assert.equal((await service.presentation('north'))?.value.mark?.dark, mark?.dark);

  // null removes it alone; removing the logo takes the dark one too; one that is not a picture is refused.
  await service.save('north', { value: { name: 'North Co' }, darkLogo: null }, 'alice');
  assert.equal((await service.presentation('north'))?.value.mark?.dark, undefined);
  await service.save('north', { value: { name: 'North Co' }, darkLogo: png(9).toString('base64') }, 'alice');
  await service.save('north', { value: { name: 'North Co' }, logo: null }, 'alice');
  assert.equal((await service.presentation('north'))?.value.mark, undefined);
  assert.equal(JSON.parse(store.writes.at(-1)!.value).logoDark, undefined);
  await assert.rejects(service.save('north', { value: {}, darkLogo: 'not base64!' }, 'alice'), LogoRefused);
});

test('a dark logo is allowed with the logo and with nothing else', () => {
  const withLogo = declare({ allow: ['name', 'logo'], editors: ['admin'] });
  const dark = { hash: 'a'.repeat(64), type: 'image/png' };
  assert.deepEqual(validateTenantBranding({ logo: dark, logoDark: dark }, withLogo).logoDark, dark);
  assert.throws(() => validateTenantBranding({ logoDark: { hash: 'nope', type: 'image/png' } }, withLogo), BrandingRefused);
  const without = declare({ allow: ['name'], editors: ['admin'] });
  assert.throws(() => validateTenantBranding({ logoDark: dark }, without), /does not let a customer change "logoDark"/);
});
