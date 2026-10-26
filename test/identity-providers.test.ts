/**
 * Sign-in through an OpenID Connect provider, end to end over HTTP: a real
 * Better Auth behind tablewalk's App server, and a provider in this process
 * (support/mockOidc.ts) that signs in whoever the test says and can be told to
 * issue a wrong token. What it proves:
 *
 *   - the whole authorization-code flow: discovery, PKCE, state and nonce,
 *     the callback, a session;
 *   - every wrong ID token is refused: a foreign issuer, another audience, a
 *     key the provider never published, `alg: none`, an expired token, and a
 *     nonce from another sign-in (a replayed token); a spent callback is
 *     refused the second time;
 *   - roles from claims: given at the first sign-in, recomputed at every one,
 *     left alone where no mapping speaks, written to the account trail, and a
 *     sign-in whose claims give no role refused;
 *   - linking only on a verified email: an unverified claim never reaches an
 *     account that has the address; a verified one does, and ends what an
 *     unverified account held (its password);
 *   - just-in-time sign-up by domain;
 *   - the step-up instant: the provider's own authentication time, counted
 *     only with more than one factor where the provider demands it;
 *   - no token, secret or provider configuration in anything a browser gets.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import {
  oidcConnectionOf,
  samlConnectionOf,
  samlServiceProvider,
  backchannelLogoutUrl,
  identityProblems,
  checkIdentityProviders,
  type IdentityProviderConfig,
} from '../packages/mistri/src/server/auth/identityConfig.js';
import { claimValues, showsMfa, stepUpInstant } from '../packages/mistri/src/server/auth/identityProviders.js';
import { mappedRoles, maySignUp } from '../packages/mistri/src/server/auth/identityRoles.js';
import { appRoleWarnings } from '../packages/mistri/src/server/app/appRoleChecks.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { oidc, saml } from '../packages/mistri/schema/app.mjs';
import { samlKeys } from './support/mockSaml.js';
import { supportManifest } from './support/tenantSupportFixture.js';
import { startMockOidc, type MockOidc, type NextSignIn } from './support/mockOidc.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe('the DSL', () => {
  const app = (auth: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseAppConfig(
      {
        name: 'Crew',
        resources: { work_order: { access: 'write' } },
        views: { orders: { kind: 'list', from: 'work_order' } },
        home: 'orders',
        nav: ['orders'],
        auth: { roles: { viewer: { read: true } }, ...auth },
        ...extra,
      },
      'crew',
    );

  test("oidc() names a config entry, oidc.tenants() each tenant's own; both are plain strings", () => {
    assert.equal(oidc('workforce'), 'oidc:workforce');
    assert.equal(oidc.tenants(), 'oidc:*');
    assert.deepEqual(app({ providers: ['email', oidc('workforce')] }).auth?.providers, ['email', 'oidc:workforce']);
    for (const wrong of ['oidc:Workforce', 'oidc:github', 'saml:X', 'saml:', 'ldap:x', 'oidc:'])
      assert.throws(() => app({ providers: [wrong] }), /providers/, wrong);
    assert.throws(() => app({ providers: ['email', 'email'] }), /twice/);
    assert.throws(() => app({ providers: [oidc.tenants()] }), /tenant App/);
  });

  test("saml() names a config entry, saml.tenants() each tenant's own, beside the OIDC ones", () => {
    assert.equal(saml('okta'), 'saml:okta');
    assert.equal(saml.tenants(), 'saml:*');
    assert.deepEqual(app({ providers: ['email', saml('okta'), oidc('workforce')] }).auth?.providers, [
      'email',
      'saml:okta',
      'oidc:workforce',
    ]);
    assert.deepEqual(
      app({ providers: ['email', saml('okta')], signUp: { providers: ['saml:okta'], domains: ['crew.example'] } }).auth?.signUp,
      { providers: ['saml:okta'], domains: ['crew.example'] },
    );
    assert.throws(() => app({ providers: [saml.tenants()] }), /tenant App/);
    assert.deepEqual(
      app({ providers: [saml('okta')], roles: { viewer: { read: true, claims: { groups: ['g1'] } } } }).auth?.roles?.viewer.claims,
      { match: { groups: ['g1'] } },
      "a SAML provider's attributes are the claims a role reads",
    );
  });

  test('just-in-time sign-up names identity providers and verified domains, never email', () => {
    assert.deepEqual(
      app({ providers: ['email', 'oidc:workforce'], signUp: { providers: ['oidc:workforce'], domains: ['crew.example'] } }).auth?.signUp,
      { providers: ['oidc:workforce'], domains: ['crew.example'] },
    );
    assert.throws(() => app({ providers: ['email'], signUp: { domains: ['crew.example'] } }), /lists none/);
    assert.throws(() => app({ providers: ['email', 'github'], signUp: { providers: ['email'] } }), /names email/);
    assert.throws(() => app({ providers: ['github'], signUp: { providers: ['google'] } }), /does not list/);
    assert.throws(() => app({ providers: ['github'], signUp: { domains: ['Crew.Example'] } }), /lower case/);
    assert.throws(() => app({ providers: ['github'], signUp: {} }), /neither/);
    assert.throws(() => app({ providers: ['github'], signUp: 'jit' }), /"open", "invite", or \{ providers, domains \}/);
  });

  test('roles from claims: a role the App declares, through a named provider, granting something, never in a tenant App', () => {
    const mapped = app({
      providers: ['oidc:workforce'],
      roles: { viewer: { read: true, claims: { groups: ['g1'], 'realm_access.roles': ['viewer'] } } },
    });
    assert.deepEqual(mapped.auth?.roles?.viewer.claims, { match: { groups: ['g1'], 'realm_access.roles': ['viewer'] } });
    assert.throws(
      () => app({ providers: ['email', 'github'], roles: { viewer: { read: true, claims: { groups: ['g1'] } } } }),
      /\[claim-without-provider\]/,
    );
    assert.throws(
      () => app({ providers: ['oidc:workforce'], roles: { viewer: { read: true }, idle: { claims: { groups: ['g1'] } } } }),
      /\[claim-grants-nothing\]/,
    );
    assert.throws(() => app({ providers: ['oidc:workforce'], roles: { viewer: { read: true, claims: { groups: [] } } } }), /nonempty list/);
    const tenant = supportManifest('/tmp/auth.db') as unknown as {
      auth: Record<string, unknown> & { roles: Record<string, Record<string, unknown>> };
    };
    tenant.auth.providers = ['oidc:workforce'];
    tenant.auth.roles.reviewer.claims = { groups: ['reviewers'] };
    assert.throws(() => parseAppConfig(tenant, 'tenant'), /\[claim-in-tenant-app\]/);
    assert.throws(
      () =>
        parseAppConfig(
          {
            name: 'Crew',
            resources: { work_order: { access: 'write' } },
            views: { orders: { kind: 'list', from: 'work_order' } },
            home: 'orders',
            nav: ['orders'],
            auth: { providers: ['oidc:workforce'], roles: { viewer: { read: true } } },
            features: [{ id: 'extra', auth: { roles: { viewer: { claims: { groups: ['g'] } } } } }],
          },
          'crew',
        ),
      /claims.*the App's/,
    );
  });

  test("a claim rule names the one provider whose claims it reads, and that provider is one of the App's (0.8.5 I1)", () => {
    const both = ['email', 'oidc:workforce', 'saml:contractors'];
    const mapped = app({
      providers: both,
      roles: { viewer: { read: true, claims: { provider: 'oidc:workforce', groups: ['g1'] } } },
    });
    assert.deepEqual(mapped.auth?.roles?.viewer.claims, { provider: 'oidc:workforce', match: { groups: ['g1'] } });
    assert.throws(
      () => app({ providers: both, roles: { viewer: { read: true, claims: { provider: 'oidc:other', groups: ['g1'] } } } }),
      /\[claim-provider-unknown\].*Name one of: oidc:workforce, saml:contractors/,
    );
    for (const provider of ['github', 'oidc:*', 'workforce', ['oidc:workforce'], 1])
      assert.throws(
        () => app({ providers: both, roles: { viewer: { read: true, claims: { provider, groups: ['g1'] } } } }),
        /not a named identity provider/,
        JSON.stringify(provider),
      );
    assert.throws(
      () => app({ providers: both, roles: { viewer: { read: true, claims: { provider: 'oidc:workforce' } } } }),
      /object of claim → values/,
      'a provider alone maps nothing',
    );
    const lock = authorityReport(mapped);
    assert.ok(lock.includes('role viewer claims from provider oidc:workforce — the App'), lock);
  });

  test('check warns of a claim rule without a provider only where the App has more than one to read it from', () => {
    const schema = {
      label: 'crew',
      dialect: 'sqlite',
      readAt: '2026-10-01T00:00:00Z',
      foreignKeys: [],
      tables: [
        {
          id: 'work_order',
          name: 'work_order',
          schema: 'main',
          columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
        },
      ],
    } as unknown as DatabaseSchema;
    const warned = (auth: Record<string, unknown>) =>
      appRoleWarnings({ app: app(auth), path: '/apps/crew/app.ts', pages: [], sources: {} } as unknown as LoadedApp, schema).filter(
        (line) => line.includes('[claim-any-provider]'),
      );
    const roles = (claims: Record<string, unknown>) => ({ viewer: { read: true, claims }, admin: { read: true, write: true } });
    assert.deepEqual(
      warned({ providers: ['email', 'oidc:workforce'], roles: roles({ groups: ['g1'] }) }),
      [],
      'one provider: any is that one',
    );
    assert.deepEqual(
      warned({ providers: ['oidc:workforce', 'saml:contractors'], roles: roles({ provider: 'oidc:workforce', groups: ['g1'] }) }),
      [],
    );
    assert.deepEqual(warned({ providers: ['oidc:workforce', 'saml:contractors'], roles: roles({ groups: ['g1'] }) }), [
      'app.ts: role "viewer" [claim-any-provider]: its claims are read from a sign-in through any of oidc:workforce, saml:contractors, ' +
        "so a claim of the same name from another of them gives it too. Say whose claims these are: roles.viewer.claims.provider, for example oidc('workforce').",
    ]);
  });

  test('authority.lock records the providers, who may sign up and which claims give each role', () => {
    const lock = authorityReport(
      app({
        providers: ['email', 'oidc:workforce'],
        signUp: { domains: ['crew.example'] },
        roles: { viewer: { read: true, claims: { groups: ['g2', 'g1'] } } },
      }),
    );
    for (const line of [
      'auth providers email, oidc:workforce — the App',
      'auth sign-up just-in-time — the App',
      'auth sign-up just-in-time domain crew.example — the App',
      'role viewer from claim groups "g1" — the App',
      'role viewer from claim groups "g2" — the App',
    ]) {
      assert.ok(lock.includes(line), `${line}\n${lock}`);
    }
  });
});

describe('an identity provider in the config file', () => {
  const at = 'mistri.json: connection "workforce"';
  const entry = (patch: Record<string, unknown> = {}) => ({
    name: 'workforce',
    kind: 'oidc',
    issuer: 'https://idp.example.com/tenant/v2.0',
    clientId: 'abc',
    clientSecret: '${WORKFORCE_CLIENT_SECRET}',
    ...patch,
  });

  test('is checked as it is read: the secret only ever a reference, https unless insecure, the name one an App can say', () => {
    assert.equal(oidcConnectionOf(entry(), at).clientSecret, '${WORKFORCE_CLIENT_SECRET}');
    assert.throws(() => oidcConnectionOf(entry({ clientSecret: 'hunter2-literal' }), at), /not a reference/);
    assert.throws(() => oidcConnectionOf(entry({ issuer: 'http://idp.example.com' }), at), /insecure/);
    assert.equal(oidcConnectionOf(entry({ issuer: 'http://127.0.0.1:9/x', insecure: true }), at).insecure, true);
    assert.throws(() => oidcConnectionOf(entry({ name: 'github' }), at), /oidc/);
    assert.throws(() => oidcConnectionOf(entry({ tenant: 'north' }), at), /"tenant" and no "domains"/);
    assert.throws(() => oidcConnectionOf(entry({ domains: ['North.com'], tenant: 'north' }), at), /domains/);
    assert.throws(() => oidcConnectionOf(entry({ audience: 'x' }), at), /takes no "audience"/);
  });

  test('gives an email domain to one tenant only', () => {
    const one = oidcConnectionOf(entry({ name: 'north', tenant: 'north', domains: ['north.example'] }), at);
    const two = oidcConnectionOf(entry({ name: 'south', tenant: 'south', domains: ['north.example'] }), at);
    assert.throws(() => checkIdentityProviders([one, two], 'mistri.json'), /both claim the domain "north.example"/);
  });

  test("check names a provider the App asks for that the config does not have, and a tenant's standing in for an App-wide one", () => {
    const app = { auth: { providers: ['email', 'oidc:workforce'] } } as never;
    assert.match(identityProblems(app, [])[0], /\[identity-provider-unknown\]/);
    const tenant = oidcConnectionOf(entry({ tenant: 'north', domains: ['north.example'] }), at);
    assert.match(identityProblems(app, [tenant])[0], /\[identity-provider-tenant\]/);
    assert.deepEqual(identityProblems(app, [oidcConnectionOf(entry(), at)]), []);
  });
});

describe('a SAML provider in the config file', () => {
  const at = 'mistri.json: connection "okta"';
  const { cert } = samlKeys('idp-a');
  const entry = (patch: Record<string, unknown> = {}) => ({
    name: 'okta',
    kind: 'saml',
    entityId: 'http://www.okta.com/exk1',
    ssoUrl: 'https://crew.okta.com/app/crew/exk1/sso/saml',
    certificates: [cert],
    ...patch,
  });

  test('is checked as it is read: its entity id, an https sign-in address, one or two certificates that can be read', () => {
    const read = samlConnectionOf(entry({ label: 'Okta', verifiedEmails: true, attributes: { email: 'mail' } }), at);
    assert.deepEqual(
      { ...read, certificates: read.certificates.length },
      {
        kind: 'saml',
        name: 'okta',
        entityId: 'http://www.okta.com/exk1',
        ssoUrl: 'https://crew.okta.com/app/crew/exk1/sso/saml',
        certificates: 1,
        attributes: { email: 'mail' },
        label: 'Okta',
        verifiedEmails: true,
      },
    );
    assert.equal(samlConnectionOf(entry({ certificates: [cert, samlKeys('idp-b').cert] }), at).certificates.length, 2);
    assert.throws(() => samlConnectionOf(entry({ entityId: '' }), at), /needs "entityId"/);
    assert.throws(() => samlConnectionOf(entry({ entityId: 'a b' }), at), /needs "entityId"/);
    assert.throws(() => samlConnectionOf(entry({ ssoUrl: 'http://crew.okta.com/sso' }), at), /insecure/);
    assert.throws(() => samlConnectionOf(entry({ ssoUrl: 'https://${OKTA_HOST}/sso' }), at), /reference/);
    assert.throws(() => samlConnectionOf(entry({ certificates: [] }), at), /one or two PEM/);
    assert.throws(() => samlConnectionOf(entry({ certificates: [cert, cert] }), at), /same certificate twice/);
    assert.throws(() => samlConnectionOf(entry({ certificates: [cert, cert, cert] }), at), /one or two PEM/);
    assert.throws(() => samlConnectionOf(entry({ certificates: ['${OKTA_CERT}'] }), at), /not a PEM certificate/);
    assert.throws(
      () => samlConnectionOf(entry({ certificates: ['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'] }), at),
      /cannot be read/,
    );
    assert.throws(() => samlConnectionOf(entry({ attributes: { role: 'x' } }), at), /"attributes"/);
    assert.throws(() => samlConnectionOf(entry({ attributes: {} }), at), /"attributes"/);
    assert.throws(() => samlConnectionOf(entry({ clientId: 'x' }), at), /takes no "clientId"/);
    assert.throws(() => samlConnectionOf(entry({ backchannelLogout: true }), at), /takes no "backchannelLogout"/);
    assert.throws(() => samlConnectionOf(entry({ verifiedEmails: false }), at), /true, or absent/);
    assert.throws(() => samlConnectionOf(entry({ name: 'google' }), at), /saml\('…'\)/);
    assert.throws(() => samlConnectionOf(entry({ tenant: 'north' }), at), /"tenant" and no "domains"/);
    assert.equal(samlConnectionOf(entry({ tenant: 'north', domains: ['north.example'] }), at).tenant, 'north');
  });

  test("the service provider's entity id and consumer service are the App's, one per provider", () => {
    assert.deepEqual(samlServiceProvider('https://crew.example/apps/', 'okta'), {
      entityId: 'https://crew.example/apps/api/auth/sso/saml2/sp/metadata?providerId=okta',
      acs: 'https://crew.example/apps/api/auth/sso/saml2/sp/acs/okta',
    });
    assert.equal(backchannelLogoutUrl('https://crew.example/', 'workforce'), 'https://crew.example/api/auth/backchannel-logout/workforce');
  });

  test('a name is one provider’s across both kinds, an entity id one entry’s, and a domain one tenant’s', () => {
    const oidcEntry = { name: 'okta', kind: 'oidc', issuer: 'https://idp.example.com', clientId: 'abc' };
    assert.throws(
      () => checkIdentityProviders([samlConnectionOf(entry(), at), oidcConnectionOf(oidcEntry, at)], 'mistri.json'),
      /two identity providers are named "okta"/,
    );
    assert.throws(
      () => checkIdentityProviders([samlConnectionOf(entry(), at), samlConnectionOf(entry({ name: 'okta-2' }), at)], 'mistri.json'),
      /same entityId/,
    );
    assert.throws(
      () =>
        checkIdentityProviders(
          [
            samlConnectionOf(entry({ tenant: 'north', domains: ['north.example'] }), at),
            oidcConnectionOf({ ...oidcEntry, name: 'north-oidc', tenant: 'south', domains: ['north.example'] }, at),
          ],
          'mistri.json',
        ),
      /both claim the domain "north.example"/,
    );
    assert.equal(oidcConnectionOf({ ...oidcEntry, backchannelLogout: true }, at).backchannelLogout, true);
    assert.throws(() => oidcConnectionOf({ ...oidcEntry, backchannelLogout: 'yes' }, at), /true, or absent/);
  });

  test('check names a SAML provider the config does not have, or has as the other kind', () => {
    const app = { auth: { providers: ['email', 'saml:okta'] } } as never;
    assert.match(identityProblems(app, [])[0], /\[identity-provider-unknown\].*"kind": "saml"/);
    const asOidc = oidcConnectionOf({ name: 'okta', kind: 'oidc', issuer: 'https://idp.example.com', clientId: 'abc' }, at);
    assert.match(identityProblems(app, [asOidc])[0], /\[identity-provider-kind\]/);
    assert.match(
      identityProblems(app, [samlConnectionOf(entry({ tenant: 'north', domains: ['north.example'] }), at)])[0],
      /\[identity-provider-tenant\]/,
    );
    assert.deepEqual(identityProblems(app, [samlConnectionOf(entry(), at)]), []);
  });
});

describe('claims', () => {
  test('a claim is read by its name first, then as a dotted path, as a string or a list', () => {
    const claims = { groups: ['a', 'b'], 'https://example.com/roles': 'lead', realm_access: { roles: ['underwriter'] } };
    assert.deepEqual(claimValues(claims, 'groups'), ['a', 'b']);
    assert.deepEqual(claimValues(claims, 'https://example.com/roles'), ['lead']);
    assert.deepEqual(claimValues(claims, 'realm_access.roles'), ['underwriter']);
    assert.deepEqual(claimValues(claims, 'missing.path'), []);
    assert.deepEqual(
      mappedRoles({ viewer: { match: { groups: ['b'] } }, lead: { match: { 'realm_access.roles': ['lead'] } } }, claims, 'oidc:workforce'),
      ['viewer'],
    );
  });

  test("a rule naming a provider is read only from that provider's sign-in; one naming none, from any", () => {
    const claims = { groups: ['admins'] };
    const mapping = {
      admin: { provider: 'oidc:workforce' as const, match: { groups: ['admins'] } },
      helper: { match: { groups: ['admins'] } },
    };
    assert.deepEqual(mappedRoles(mapping, claims, 'oidc:workforce'), ['admin', 'helper']);
    assert.deepEqual(
      mappedRoles(mapping, claims, 'saml:contractors'),
      ['helper'],
      "the contractors' IdP says groups too, and gives no admin",
    );
  });

  test('more than one factor is said by amr (mfa, or two kinds) or by an acr the provider lists', () => {
    assert.equal(showsMfa({ amr: ['pwd', 'mfa'] }, {}), true);
    assert.equal(showsMfa({ amr: ['pwd', 'otp'] }, {}), true);
    assert.equal(showsMfa({ amr: ['pwd'] }, {}), false);
    assert.equal(showsMfa({ acr: 'urn:mfa' }, { mfa: ['urn:mfa'] }), true);
    assert.equal(showsMfa({ acr: 'urn:mfa' }, {}), false);
  });

  test("a step-up counts from the provider's authentication, and only with more than one factor where the provider demands it", () => {
    assert.equal(stepUpInstant({ auth_time: 1_700_000_000 }, {}), 1_700_000_000_000);
    assert.equal(stepUpInstant({}, {}), null, 'without auth_time the provider has not said when it asked');
    assert.equal(stepUpInstant({ auth_time: 1_700_000_000, amr: ['pwd'] }, { mfa: ['urn:mfa'] }), null);
    assert.equal(stepUpInstant({ auth_time: 1_700_000_000, amr: ['pwd', 'mfa'] }, { mfa: ['urn:mfa'] }), 1_700_000_000_000);
  });

  test('just in time: through a listed provider, and with a verified email in a listed domain', () => {
    assert.equal(maySignUp({ providers: ['oidc:workforce'] }, 'oidc:workforce', 'a@x.test', false), true);
    assert.equal(maySignUp({ providers: ['oidc:workforce'] }, 'github', 'a@x.test', true), false);
    assert.equal(maySignUp({ domains: ['x.test'] }, 'github', 'a@x.test', true), true);
    assert.equal(
      maySignUp({ domains: ['x.test'] }, 'github', 'a@x.test', false),
      false,
      'a domain is only as good as the proof of the address',
    );
    assert.equal(maySignUp({ domains: ['x.test'] }, 'github', 'a@y.test', true), false);
    assert.equal(maySignUp('invite', 'github', 'a@x.test', true), false);
  });
});

describe('signing in through an OpenID Connect provider', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  let idp: MockOidc;
  let store: string;
  const errors: string[] = [];
  const error = console.error;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-oidc-'));
    idp = await startMockOidc();
    process.env.TEST_WORKFORCE_SECRET = idp.clientSecret;
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'crew');
    mkdirSync(dir, { recursive: true });
    store = join(tmp, 'auth.db');
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Crew',
        resources: { work_order: { access: 'write' } },
        auth: {
          providers: ['email', 'oidc:workforce'],
          signUp: { domains: ['crew.example'] },
          store,
          defaultRole: 'viewer',
          roles: {
            viewer: { read: true },
            dispatcher: { read: true, write: true, claims: { groups: ['dispatch'], 'realm_access.roles': ['dispatcher'] } },
            auditor: { read: true, claims: { roles: ['Auditor'] } },
            admin: { read: true, write: true, claims: { groups: ['crew-admins'] } },
          },
        },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    const loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: db, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    host = { app: loaded, pages: [] };
    server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const identity: IdentityProviderConfig[] = [
      oidcConnectionOf(
        {
          name: 'workforce',
          kind: 'oidc',
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: '${TEST_WORKFORCE_SECRET}',
          label: 'Crew SSO',
          mfa: ['urn:crew:mfa'],
          insecure: true,
        },
        'test',
      ),
    ];
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity });
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
  });

  after(async () => {
    console.error = error;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    await idp?.close();
    delete process.env.TEST_WORKFORCE_SECRET;
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (url: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body) headers['content-type'] = 'application/json';
    const res = await fetch(url.startsWith('http') ? url : `${origin}${url}`, { ...init, headers, redirect: 'manual' });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return {
      status: res.status,
      json,
      text,
      location: res.headers.get('location'),
      cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]),
    };
  };
  const jar = (...lists: string[][]) => {
    const kept = new Map<string, string>();
    for (const cookie of lists.flat()) {
      const [name] = cookie.split('=');
      kept.set(name, cookie);
    }
    return [...kept.values()].filter((cookie) => !cookie.endsWith('=')).join('; ');
  };
  const account = (email: string) => {
    const file = new DatabaseSync(store, { readOnly: true });
    try {
      const user = file.prepare('SELECT id, role, emailVerified FROM "user" WHERE email = ?').get(email) as
        | { id: string; role: string | null; emailVerified: number }
        | undefined;
      const methods = user
        ? (file.prepare('SELECT providerId, accessToken, refreshToken, idToken FROM account WHERE userId = ?').all(user.id) as Array<
            Record<string, unknown>
          >)
        : [];
      return { user, methods };
    } finally {
      file.close();
    }
  };
  const trail = (email: string) => {
    const file = new DatabaseSync(store, { readOnly: true });
    try {
      return file
        .prepare('SELECT action, actorEmail, principal, before, after FROM accountAudit WHERE targetEmail = ? ORDER BY createdAt')
        .all(email) as Array<Record<string, string>>;
    } finally {
      file.close();
    }
  };

  /** The whole flow: ask to sign in, let the provider answer, follow its redirect to the callback. */
  async function signIn(who: NextSignIn, options: { stepUp?: true } = {}) {
    const started = await call('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'workforce',
        callbackURL: `${origin}/crew/`,
        errorCallbackURL: `${origin}/crew/sign-in`,
        ...(options.stepUp ? { additionalParams: { mistri_step_up: '1' } } : {}),
      }),
    });
    assert.equal(started.status, 200, started.text);
    const authorize = String(started.json.url);
    idp.next(who);
    const answered = await call(authorize);
    assert.equal(answered.status, 302, answered.text);
    const callback = answered.location!;
    const back = await call(callback, { cookie: jar(started.cookies) });
    const landed = new URL(back.location ?? '', origin);
    const session = jar(started.cookies, back.cookies);
    const whoami = await call('/api/whoami', { cookie: session });
    return {
      authorize: new URL(authorize),
      callback,
      back,
      landed,
      error: landed.searchParams.get('error'),
      session,
      who: whoami.json.who as string | null,
      replay: () => call(callback, { cookie: jar(started.cookies) }),
    };
  }

  test('the door names the provider by its label, and says nothing of its configuration', async () => {
    const door = await call('/api/whoami');
    const info = door.json.signIn as Record<string, unknown>;
    assert.deepEqual(info.providers, ['email', 'oidc:workforce']);
    assert.deepEqual(info.labels, { 'oidc:workforce': 'Crew SSO' });
    assert.equal(info.signUp, 'provider', 'just-in-time sign-up is said as a kind, never as its domains');
    for (const secret of [idp.issuer, idp.clientId, idp.clientSecret, 'crew.example'])
      assert.equal(door.text.includes(secret), false, secret);
  });

  test('a first sign-in makes the account with the roles its claims give, through PKCE, state and nonce', async () => {
    const done = await signIn({
      sub: 'u-ada',
      email: 'ada@crew.example',
      email_verified: true,
      name: 'Ada',
      claims: { groups: ['dispatch'] },
    });
    assert.equal(done.error, null, done.back.location ?? '');
    assert.equal(done.who, 'ada@crew.example');
    const asked = done.authorize.searchParams;
    assert.equal(asked.get('code_challenge_method'), 'S256');
    assert.ok(asked.get('code_challenge') && asked.get('nonce') && asked.get('state'));
    assert.equal(asked.get('scope'), 'openid email profile');
    const { user, methods } = account('ada@crew.example');
    assert.equal(user?.role, 'dispatcher', 'the claims give the role; the default role is not added');
    // Only the ID token is kept: no access or refresh token that could call the provider.
    assert.deepEqual(
      methods.map((m) => [m.providerId, m.accessToken, m.refreshToken]),
      [['workforce', null, null]],
    );
    assert.deepEqual(
      trail('ada@crew.example').map((row) => [row.action, row.actorEmail, row.principal]),
      [['create', 'Crew SSO', 'sign-in:workforce']],
    );
    // The callback is spent: the same code and state do not sign anyone in twice.
    const again = await done.replay();
    assert.equal(new URL(again.location ?? '', origin).searchParams.has('error'), true);
  });

  test('roles from claims are recomputed at every sign-in, audited, and the others are left as an administrator set them', async () => {
    const file = new DatabaseSync(store);
    file.prepare('UPDATE "user" SET role = ? WHERE email = ?').run('dispatcher,viewer', 'ada@crew.example');
    file.close();
    const done = await signIn({ sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { roles: ['Auditor'] } });
    assert.equal(done.error, null);
    assert.equal(account('ada@crew.example').user?.role, 'viewer,auditor');
    const last = trail('ada@crew.example').at(-1)!;
    assert.equal(last.action, 'setRoles');
    assert.deepEqual(JSON.parse(last.before), { roles: ['dispatcher', 'viewer'] });
    assert.deepEqual(JSON.parse(last.after), { roles: ['viewer', 'auditor'] });
  });

  test('a sign-in whose claims give no role the App declares is refused with a sentence', async () => {
    const done = await signIn({ sub: 'u-bo', email: 'bo@crew.example', email_verified: true, claims: { groups: ['canteen'] } });
    assert.equal(done.error, 'no_role');
    assert.equal(done.who, null);
    assert.equal(account('bo@crew.example').user, undefined, 'no account is made for someone with no role');
  });

  test('just-in-time sign-up by domain needs a verified address in it', async () => {
    const outside = await signIn({ sub: 'u-eve', email: 'eve@elsewhere.example', email_verified: true, claims: { groups: ['dispatch'] } });
    assert.equal(outside.error, 'sign_up_closed');
    const unverified = await signIn({ sub: 'u-cy', email: 'cy@crew.example', email_verified: false, claims: { groups: ['dispatch'] } });
    assert.equal(unverified.error, 'sign_up_closed');
    assert.equal(account('cy@crew.example').user, undefined);
  });

  test('an unverified email claim never links to the account that has the address', async () => {
    // Dee has a password account an operator made: its address was never verified.
    await createNativeAccount(host.auth!, { email: 'dee@crew.example', name: 'Dee', password: 'dee-password-1' }, { by: 'maintenance' });
    const own = await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'dee@crew.example', password: 'dee-password-1' }),
    });
    assert.equal(own.status, 200, own.text);
    const held = jar(own.cookies);
    assert.equal((await call('/api/whoami', { cookie: held })).json.who, 'dee@crew.example');
    const refused = await signIn({ sub: 'u-dee', email: 'dee@crew.example', email_verified: false, claims: { groups: ['dispatch'] } });
    assert.equal(refused.error, 'account_not_linked');
    assert.deepEqual(
      account('dee@crew.example')
        .methods.map((m) => m.providerId)
        .filter((p) => p === 'workforce'),
      [],
    );
    const linked = await signIn({ sub: 'u-dee', email: 'dee@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
    assert.equal(linked.error, null, linked.back.location ?? '');
    const after = account('dee@crew.example');
    assert.deepEqual(
      after.methods.map((m) => m.providerId),
      ['workforce'],
      'what the unverified account held is gone',
    );
    assert.equal(after.user?.emailVerified, 1);
    // Its password no longer signs in, and the session it held is over.
    const password = await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'dee@crew.example', password: 'dee-password-1' }),
    });
    assert.equal(password.status, 401);
    assert.equal((await call('/api/whoami', { cookie: held })).json.who, null);
  });

  test("a role from claims is the provider's: a password session of the same account does not keep it", async () => {
    await createNativeAccount(host.auth!, { email: 'fay@crew.example', name: 'Fay', password: 'fay-password-1' }, { by: 'maintenance' });
    // A proven address: the provider's sign-in links to it and the password stays, so the account has two ways in.
    const file = new DatabaseSync(store);
    try {
      file.exec('PRAGMA busy_timeout = 5000');
      file.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run('fay@crew.example');
    } finally {
      file.close();
    }
    const sso = await signIn({ sub: 'u-fay', email: 'fay@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
    assert.equal(sso.error, null, sso.back.location ?? '');
    assert.deepEqual(
      account('fay@crew.example')
        .methods.map((m) => m.providerId)
        .sort(),
      ['credential', 'workforce'],
    );
    const roleOf = async (cookie: string) => (await host.auth!.session({ headers: { cookie } } as never))?.role;
    const held = account('fay@crew.example').user!.role;
    assert.match(held ?? '', /dispatcher/);
    assert.equal(await roleOf(sso.session), held, "the provider's own session holds what its claims gave");
    const password = await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'fay@crew.example', password: 'fay-password-1' }),
    });
    assert.equal(password.status, 200, password.text);
    const byPassword = await roleOf(jar(password.cookies));
    assert.doesNotMatch(byPassword ?? '', /dispatcher/, "a mapped role is never a password session's");
    assert.equal(await roleOf(sso.session), held);
  });

  test("Better Auth's admin endpoints take a mapped admin only through the provider's own session", async () => {
    await createNativeAccount(host.auth!, { email: 'gil@crew.example', name: 'Gil', password: 'gil-password-1' }, { by: 'maintenance' });
    const file = new DatabaseSync(store);
    try {
      file.exec('PRAGMA busy_timeout = 5000');
      file.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run('gil@crew.example');
    } finally {
      file.close();
    }
    const sso = await signIn({ sub: 'u-gil', email: 'gil@crew.example', email_verified: true, claims: { groups: ['crew-admins'] } });
    assert.equal(sso.error, null, sso.back.location ?? '');
    const gil = account('gil@crew.example').user!;
    assert.match(gil.role ?? '', /\badmin\b/);
    assert.equal(
      (await call('/api/auth/admin/list-users', { cookie: sso.session })).status,
      200,
      "the provider's session is the admin its claims made",
    );
    const password = await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'gil@crew.example', password: 'gil-password-1' }),
    });
    assert.equal(password.status, 200, password.text);
    const cookie = jar(password.cookies);
    // However the path is spelled, a password session of the same account is not that admin.
    for (const path of [
      '/api/auth/admin/list-users',
      '/api/auth/%61dmin/list-users',
      '/api/auth//admin/list-users',
      '/api/auth/ADMIN/list-users',
    ]) {
      assert.equal((await call(path, { cookie })).status, 403, path);
    }
    const promoted = await call('/api/auth/admin/set-role', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ userId: gil.id, role: 'dispatcher' }),
    });
    assert.equal(promoted.status, 403, promoted.text);
    assert.equal(account('gil@crew.example').user!.role, gil.role, 'no role was set by hand around the provider');
  });

  for (const [name, tamper, why] of [
    ['a foreign issuer', { issuer: 'https://evil.example' }, /issuer|iss/],
    ['another audience', { audience: 'someone-else' }, /aud/],
    ['a key the provider never published', { foreignKey: true }, /signature/],
    ['alg none', { alg: 'none' }, /alg|JWS|signature|Invalid/i],
    ['an expired token', { expired: true }, /exp|timestamp|age/],
    ['a nonce from another sign-in', { nonce: 'not-this-sign-ins-nonce' }, /nonce/],
  ] as const) {
    test(`an ID token with ${name} is refused`, async () => {
      errors.length = 0;
      const done = await signIn({
        sub: 'u-ada',
        email: 'ada@crew.example',
        email_verified: true,
        claims: { groups: ['dispatch'] },
        tamper,
      });
      assert.equal(done.error, 'unable_to_get_user_info');
      assert.equal(done.who, null);
      assert.ok(
        errors.some((line) => why.test(line)),
        errors.join('\n'),
      );
      // The refusal is the server's to log, and says nothing of the token.
      assert.equal(
        errors.some((line) => idp.issued.some((token) => line.includes(token))),
        false,
      );
    });
  }

  test('a replayed ID token is refused: its nonce belongs to the sign-in it was issued for', async () => {
    const first = await signIn({ sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
    assert.equal(first.error, null);
    const spent = first.authorize.searchParams.get('nonce')!;
    const replayed = await signIn({
      sub: 'u-ada',
      email: 'ada@crew.example',
      email_verified: true,
      claims: { groups: ['dispatch'] },
      tamper: { nonce: spent },
    });
    assert.equal(replayed.error, 'unable_to_get_user_info');
  });

  test('a step-up asks the provider to authenticate afresh, with the factors it demands; a browser adds nothing else', async () => {
    const started = await call('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'workforce',
        callbackURL: `${origin}/crew/`,
        additionalParams: { mistri_step_up: '1', prompt: 'none', acr_values: 'weak' },
      }),
    });
    const url = new URL(String(started.json.url));
    assert.equal(url.searchParams.get('prompt'), 'login');
    assert.equal(url.searchParams.get('max_age'), '0');
    assert.equal(url.searchParams.get('acr_values'), 'urn:crew:mfa');
    const plain = await call('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'workforce',
        callbackURL: `${origin}/crew/`,
        additionalParams: { prompt: 'none', acr_values: 'weak' },
      }),
    });
    const quiet = new URL(String(plain.json.url));
    assert.equal(quiet.searchParams.get('prompt'), null);
    assert.equal(quiet.searchParams.get('acr_values'), null);
  });

  test('a browser cannot sign in by handing over an ID token', async () => {
    const offered = await call('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({ provider: 'workforce', callbackURL: `${origin}/crew/`, idToken: { token: idp.issued[0] } }),
    });
    assert.notEqual(offered.status, 200);
    assert.equal(
      offered.cookies.some((cookie) => cookie.includes('session_token=') && !cookie.endsWith('=')),
      false,
    );
  });
});
