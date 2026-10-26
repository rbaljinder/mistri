/** The suite's one sign-in owner and separate grant ledger. Each child gets a
 * revocable projection, never ownership of the native identity database. */
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isTenantApp, parseAppConfig, signInOf } from '../../shared/app.js';
import { suiteAppRoles } from './suiteAppRoles.js';
import { mappedRoles, roleClaimsOf, type FederatedSignIn } from './identityRoles.js';
import type { LoadedApp } from '../app/apps.js';
import type { SuiteConfiguration } from '../cli/suiteConfig.js';
import { Registry, type ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { sqliteAuthExclusions } from './sqliteStoreIdentity.js';
import {
  createAppAuth,
  createSuiteAppAuth,
  captureAppAuthRuntime,
  captureNativeStepUpProvider,
  type VerifiedSessionInstance,
} from './auth.js';
import {
  assertAuthStoreSeparation,
  assertPostgresAuthStoreSeparation,
  assertPostgresAuthStoreServerSeparation,
  captureAuthStoreExclusion,
  type AuthStoreExclusion,
} from './authStoreSeparation.js';
import {
  openPostgresSuiteStores,
  postgresSuiteStoresPresent,
  POSTGRES_SUITE_PREFIXES,
  provisionPostgresSuiteStores,
} from './suiteStoresPostgres.js';
import type { SuiteAuthority, SuiteGrants, SuitePreferences } from './suiteStores.js';
import { expandEnv } from '@mistriwork/engine/server/auth/credentials.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from './suiteGrantStore.js';
import { doorRefusal } from '@mistriwork/engine/server/http/trust.js';
import { randomBytes } from 'node:crypto';
import { suiteChooserPage } from './suiteChooser.js';
import { suiteGrantHttp } from './suiteGrantHttp.js';
import { openSuitePreferencesStore, provisionSuitePreferencesStore } from './suitePreferences.js';
import { openSuiteAuthorityStore, provisionSuiteAuthorityStore } from './suiteAuthority.js';
import { suitePreferencesHttp } from './suitePreferencesHttp.js';
import { suiteRootDestination } from './suiteRootEntry.js';
import { grantAdmits, privateSuiteApp, suiteDeepLink } from './suiteLanding.js';
import { openEmailTransport } from '../email/email.js';
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import { APP_ICON_GLYPHS } from '@mistriwork/engine/shared/iconGlyphs.js';

/** The App's authored accent, for its mark in the chooser: a plain hex only,
 * since it reaches a style property; a look's own accent is left to the App. */
function appAccent(app: LoadedApp['app']): { accent?: { light: string; dark: string } } {
  const accent = app.ui?.theme?.accent;
  const hex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  if (hex(accent)) return { accent: { light: accent, dark: accent } };
  if (accent && typeof accent === 'object' && hex(accent.light) && hex(accent.dark))
    return { accent: { light: accent.light, dark: accent.dark } };
  return {};
}

/** The App's logo, for the chooser: the regular drawing as path data, which
 * the page draws small and quiet beside the name. Only a curated icon name
 * has a drawing, so nothing authored reaches the page as markup. */
function appMark(app: LoadedApp['app']): { icon?: readonly string[] } {
  const logo = app.ui?.logo;
  return isAppIcon(logo) ? { icon: APP_ICON_GLYPHS[logo][0] } : {};
}

export async function openSuiteIdentity(
  config: SuiteConfiguration,
  deployments: ReadonlyArray<{
    app: LoadedApp;
    basePath: string;
    environment: NodeJS.ProcessEnv;
    connections: readonly Omit<ConnectionConfig, 'id' | 'source'>[];
  }>,
) {
  const identity = config.identity;
  if (!identity) throw new Error('The suite has no shared identity configuration.');
  for (const rule of identity.landing ?? []) {
    const target = deployments.find((item) => item.app.app.id === rule.app)?.app.app;
    if (!target) throw new Error(`Suite identity landing: "${rule.app}" is not one of the suite's Apps.`);
    const unknown = rule.roles?.find((role) => !suiteAppRoles(target).includes(role));
    if (unknown) throw new Error(`Suite identity landing: "${rule.app}" declares no role "${unknown}".`);
    if (rule.member && !isTenantApp(target))
      throw new Error(`Suite identity landing: "member" needs a tenant App, and "${rule.app}" has no tenants.`);
  }
  if (config.email && !config.publicOrigin) throw new Error('Suite email requires an explicit publicOrigin.');
  const exclusions: AuthStoreExclusion[] = [];
  const connections: Array<{ name: string; url: string }> = [];
  for (const item of deployments) {
    const registry = new Registry({ environment: item.environment });
    try {
      for (const connection of item.connections) {
        registry.add({ ...connection, source: 'config' });
        connections.push({ name: connection.name, url: expandEnv(connection.url, item.environment) });
      }
      exclusions.push(...sqliteAuthExclusions(registry));
    } finally {
      await registry.closeAll();
    }
  }
  const ledger = POSTGRES_URL.test(identity.grants)
    ? await postgresLedger(identity, deployments, connections)
    : sqliteLedger(identity, exclusions);
  const { grants, preferences, authority } = ledger;
  let source: Awaited<ReturnType<typeof createAppAuth>> | undefined;
  try {
    // The identity manifest is never a business App or a grant source. Its
    // native default role has no authority in any mounted App.
    const manifest: LoadedApp = {
      path: identity.store,
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: identity.id,
          name: identity.name,
          resources: { identity: {} },
          auth: {
            store: identity.store,
            providers: identity.providers ?? ['email'],
            signUp: identity.signUp ?? 'open',
            roles: { user: { read: true } },
          },
          views: { identity: { kind: 'list', from: 'identity' } },
          home: 'identity',
          nav: ['identity'],
        },
        'Suite identity',
      ),
    };
    const publicURL = config.publicOrigin ?? `http://127.0.0.1:${config.port}`;
    const bound = {
      host: '127.0.0.1',
      port: config.port,
      allowedHosts: config.publicOrigin ? [new URL(config.publicOrigin).hostname] : [],
    };
    const mail = config.email ? openEmailTransport(config.email, { environment: config.email.environment }) : undefined;
    /* ID2 across a suite: an App whose roles map from claims (`auth.roles.<role>.claims`) has its grant
       derived at each sign-in through a provider, before the session exists. The grant store keeps the
       rules: a hand-set grant is never touched, a derived one follows the claims and is revoked when
       they give nothing, each change audited with the provider as its actor. */
    const mappings = deployments.flatMap((item) => {
      const mapping = roleClaimsOf(item.app.app.auth?.roles);
      return Object.keys(mapping).length ? [{ appId: item.app.app.id, mapping, declared: suiteAppRoles(item.app.app) }] : [];
    });
    const federatedSignIn = mappings.length
      ? async ({ userId, provider, token, claims }: Parameters<FederatedSignIn>[0]) => {
          for (const { appId, mapping, declared } of mappings) {
            await grants.deriveFromClaims({
              appId,
              subjectId: userId,
              provider,
              declaredRoles: declared,
              roles: mappedRoles(mapping, claims, token).filter((role) => declared.includes(role)),
            });
          }
        }
      : undefined;
    source = await createAppAuth(manifest, {
      baseURL: `${publicURL}${config.basePath}`,
      trustedOrigins: config.publicOrigin ? [publicURL] : [publicURL, `http://localhost:${config.port}`],
      listenHost: bound.host,
      mail,
      environment: identity.environment,
      excludeStores: [...exclusions, ...ledger.files.map((path) => captureAuthStoreExclusion(path))],
      // On PostgreSQL the ledger's database is one more the identity store is kept apart from, URL and server.
      excludeConnections: [...connections, ...ledger.databases],
      identity: identity.services ?? [],
      ...(federatedSignIn ? { federatedSignIn } : {}),
    });
    ledger.separate();
    const native = source;
    const children = new Map<string, ReturnType<typeof createSuiteAppAuth>>();
    const forApp = (app: LoadedApp, basePath: string) => {
      if (children.has(app.app.id)) throw new Error('An App identity projection already exists.');
      const auth = createSuiteAppAuth(native, {
        appId: app.app.id,
        spec: signInOf(app.app.auth)!,
        roles: suiteAppRoles(app.app),
        basePath,
        suiteBase: config.basePath,
        ...(ledger.synchronous
          ? {
              grant: (subjectId: string, appId: string, via: Parameters<typeof grants.readForSession>[2] | 'account') => {
                const value = via === 'account' ? grants.read(subjectId, appId) : grants.readForSession(subjectId, appId, via);
                if (value instanceof Promise) throw new Error('A SQLite grant store answered later.');
                return value;
              },
            }
          : {
              grantCurrent: async (subjectId: string, appId: string, via: Parameters<typeof grants.readForSession>[2] | 'account') =>
                via === 'account' ? grants.read(subjectId, appId) : grants.readForSession(subjectId, appId, via),
            }),
      });
      children.set(app.app.id, auth);
      return auth;
    };
    const entry = createSuiteAppAuth(native, {
      appId: identity.id,
      spec: signInOf(manifest.app.auth)!,
      roles: [],
      basePath: config.basePath,
      suiteBase: config.basePath,
      grant: () => ({ roles: [], revision: 0 }),
    });
    const send = (res: ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    };
    let closed = false;
    /* A native session's authority in each App: a grant derived from claims
       counts only for a session its provider opened (readForSession). */
    const sessionProvider = captureNativeStepUpProvider(native);
    const sessionGrant = (proof: VerifiedSessionInstance, appId: string) =>
      grants.readForSession(proof.identity.id, appId, { provider: sessionProvider.provider(proof) });
    const admits = (item: (typeof deployments)[number], value: Readonly<{ roles: readonly string[] }>) => {
      const allowed = suiteAppRoles(item.app.app);
      return value.roles.length > 0 && value.roles.every((role) => allowed.includes(role));
    };
    /* The Apps a session may enter. Read in this turn where the grants are SQLite's, so a preference is
       written on what was just read, as before; awaited where they are PostgreSQL's. */
    const authorized = (proof: VerifiedSessionInstance): string[] | Promise<string[]> => {
      const reads = deployments.map((item) => sessionGrant(proof, item.app.app.id));
      const allowed = (values: readonly Readonly<{ roles: readonly string[] }>[]) =>
        deployments.filter((item, index) => admits(item, values[index])).map((item) => item.app.app.id);
      return reads.some((value) => value instanceof Promise)
        ? Promise.all(reads).then(allowed)
        : allowed(reads as Awaited<(typeof reads)[number]>[]);
    };
    return {
      forApp,
      grants,
      native,
      preferences,
      /** Each App's authority.lock, start by start, for the Console's Governance room. */
      authority,
      /** `memberships` asks a mounted tenant App's own owner, for landing rules that say `member`. */
      entry(
        req: IncomingMessage,
        memberships?: (appId: string, accountId: string) => Promise<number>,
      ): Promise<string | undefined> | undefined {
        if (
          !['GET', 'HEAD'].includes(req.method ?? '') ||
          ![config.basePath, `${config.basePath}/`].includes(req.url?.split('?')[0] ?? '/')
        )
          return undefined;
        return (async () => {
          if (closed || doorRefusal(req, bound, { writing: false })) throw new Error('Suite entry is unavailable.');
          return suiteRootDestination(req, {
            native,
            grants,
            preferences,
            basePath: config.basePath,
            rootApp: deployments.find((item) => item.basePath === config.basePath)?.app,
            deployments: deployments.map((item) => ({ app: item.app, href: `${item.basePath}/` })),
            ...(identity.landing ? { landing: identity.landing } : {}),
            ...(memberships ? { memberships } : {}),
          });
        })();
      },
      /* A page of a private App, opened by a signed-in account the App does not
         admit, would only draw the App's sign-in door again: that account is
         already signed in. Send it to the chooser instead, carrying the address,
         so it can pick another App or sign in as an account that has this one.
         Only document navigations are turned; the App's API keeps answering 401
         itself, a signed-out visitor keeps the App's own door, and nothing here
         admits anyone — the App's own gate runs on every request it does serve. */
      gate(req: IncomingMessage, appId: string): Promise<string | undefined> | undefined {
        if (closed || (req.method !== 'GET' && req.method !== 'HEAD')) return undefined;
        const dest = req.headers['sec-fetch-dest'];
        if (dest === undefined ? !/\btext\/html\b/.test(req.headers.accept ?? '') : dest !== 'document') return undefined;
        const item = deployments.find((candidate) => candidate.app.app.id === appId);
        if (!item || !privateSuiteApp(item.app.app)) return undefined;
        // A password reset comes back to the App's own door, which must read it.
        if (new URLSearchParams(req.url?.split('?').slice(1).join('?') ?? '').has('reset')) return undefined;
        const link = suiteDeepLink(req.url, [item], config.basePath);
        if (!link) return undefined;
        return (async () => {
          if (doorRefusal(req, bound, { writing: false })) return undefined;
          const auth = captureAppAuthRuntime(native);
          const proof = await auth.sessionInstance(req);
          if (!proof) return undefined;
          await auth.observeSession(proof);
          auth.assertSessionCurrent(proof);
          const admitted = grantAdmits(item.app.app, await sessionGrant(proof, appId));
          auth.assertSessionCurrent(proof);
          return admitted ? undefined : `${config.basePath}/_mistri/apps?next=${encodeURIComponent(link.href)}`;
        })();
      },
      route(req: IncomingMessage, res: ServerResponse): Promise<void> | undefined {
        let path: string;
        try {
          path = new URL(req.url ?? '/', publicURL).pathname;
        } catch {
          return undefined;
        }
        const authRoute = path.startsWith(`${config.basePath}/api/auth/`);
        const chooser = path === `${config.basePath}/_mistri/apps`;
        const accept = path === `${config.basePath}/api/suite/invitations/accept`;
        const preferenceRoute = path === `${config.basePath}/api/suite/preferences`;
        const administration = deployments.find((item) =>
          ['grants', 'grants/read', 'invitations/list', 'invitations/issue', 'invitations/revoke'].some(
            (route) => path === `${item.basePath}/api/suite/${route}`,
          ),
        );
        if (!authRoute && !administration && !accept && !chooser && !preferenceRoute && path !== `${config.basePath}/api/suite/apps`)
          return undefined;
        return (async () => {
          if (closed) return send(res, 503, { error: 'The suite is stopping.' });
          /* The Host, for every route here. A write's Origin and body are each route's own below: Better Auth's
             origin line (`trustedOrigins`), the preferences' and the grants' doors; the rest are GETs. */
          if (doorRefusal(req, bound, { writing: false })) return send(res, 403, { error: 'Invalid host.' });
          if (chooser) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET.' });
            /* A carried deep link is followed only for an account its App admits
               (or a public App, which answers for itself); for any other signed-in
               account the chooser says which App it cannot open. */
            const nexts = new URL(req.url ?? '/', publicURL).searchParams.getAll('next');
            const link = nexts.length === 1 ? suiteDeepLink(nexts[0], deployments, config.basePath) : undefined;
            let denied: string | undefined;
            if (link) {
              const auth = captureAppAuthRuntime(native);
              const proof = await auth.sessionInstance(req);
              if (proof) {
                await auth.observeSession(proof);
                auth.assertSessionCurrent(proof);
                const target = link.deployment.app.app;
                const open = !privateSuiteApp(target) || grantAdmits(target, await sessionGrant(proof, target.id));
                auth.assertSessionCurrent(proof);
                if (open) {
                  res.writeHead(302, { location: link.href, 'cache-control': 'no-store' }).end();
                  return;
                }
                denied = target.name;
              }
            }
            const nonce = randomBytes(18).toString('base64');
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'same-origin',
            });
            res.end(
              req.method === 'HEAD'
                ? undefined
                : suiteChooserPage(
                    identity.name,
                    config.basePath,
                    nonce,
                    deployments.find((item) => item.basePath === config.basePath)?.app.app.id,
                    denied,
                  ),
            );
            return;
          }
          if (authRoute) {
            if (path.endsWith('/sign-out') && req.headers['x-mistri-account'] !== undefined) {
              const proof = await captureAppAuthRuntime(native).sessionInstance(req);
              if (proof && proof.identity.id !== req.headers['x-mistri-account'])
                return send(res, 409, { error: 'The signed-in account changed.' });
            }
            return entry.handler(req, res);
          }
          if (preferenceRoute)
            return suitePreferencesHttp(req, res, {
              native,
              preferences,
              bound,
              basePath: config.basePath,
              current: () => !closed,
              allowedApps: authorized,
            });
          if (administration || accept)
            return suiteGrantHttp(req, res, {
              native,
              grants,
              deployments,
              mail,
              publicOrigin: config.publicOrigin,
              bound,
              basePath: config.basePath,
              target: administration,
              action: accept
                ? 'accept'
                : path.endsWith('/read')
                  ? 'read'
                  : path.endsWith('/list')
                    ? 'list'
                    : path.endsWith('/issue')
                      ? 'issue'
                      : path.endsWith('/revoke')
                        ? 'revoke'
                        : 'grant',
              current: () => !closed,
            });
          if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
          const proof = await captureAppAuthRuntime(native).sessionInstance(req);
          if (!proof) return send(res, 401, { error: 'Sign in to continue.' });
          await captureAppAuthRuntime(native).observeSession(proof);
          captureAppAuthRuntime(native).assertSessionCurrent(proof);
          const apps = [];
          for (const item of deployments) {
            const value = await sessionGrant(proof, item.app.app.id);
            if (!admits(item, value)) continue;
            apps.push({
              id: item.app.app.id,
              name: item.app.app.name,
              ...appAccent(item.app.app),
              ...appMark(item.app.app),
              href: `${item.basePath}/${item.basePath === config.basePath ? `?app=${encodeURIComponent(item.app.app.id)}` : ''}`,
              ...(value.roles.includes('admin')
                ? { manageHref: `${config.basePath}/_mistri/apps#manage=${encodeURIComponent(item.app.app.id)}` }
                : {}),
            });
          }
          send(res, 200, {
            accountId: proof.identity.id,
            apps,
            preference: await preferences.read(proof.identity.id),
            emailAvailable: Boolean(mail),
          });
        })();
      },
      close() {
        if (closed) return;
        closed = true;
        for (const child of children.values()) child.close();
        entry.close();
        native.close();
        ledger.close();
      },
    };
  } catch (error) {
    source?.close();
    ledger.close();
    throw error;
  }
}

const POSTGRES_URL = /^postgres(ql)?:\/\//i;
type SuiteIdentityConfiguration = NonNullable<SuiteConfiguration['identity']>;

interface Ledger {
  readonly grants: SuiteGrants;
  readonly preferences: SuitePreferences;
  readonly authority: SuiteAuthority;
  /** Whether every read answers in the caller's turn: the SQLite files', never PostgreSQL's. */
  readonly synchronous: boolean;
  /** The files the identity store must not be, and the databases it must not share. */
  readonly files: readonly string[];
  readonly databases: readonly { readonly url: string; readonly name: string }[];
  /** Checked again once the identity store is open. */
  separate(): void;
  close(): void;
}

/** The grants, preferences and authority history in three SQLite files beside the identity store, as they always were. */
function sqliteLedger(identity: SuiteIdentityConfiguration, exclusions: readonly AuthStoreExclusion[]): Ledger {
  const preferencePath = `${identity.store}.preferences`;
  const authorityPath = `${identity.store}.authority`;
  const stores = [identity.store, identity.grants, preferencePath, authorityPath];
  const separate = () => {
    for (const path of stores) {
      for (const file of exclusions) {
        assertAuthStoreSeparation(path, file);
        if (existsSync(path)) assertAuthStoreSeparation(file.path, captureAuthStoreExclusion(path));
      }
      if (existsSync(path))
        for (const other of stores) {
          if (other !== path) assertAuthStoreSeparation(other, captureAuthStoreExclusion(path));
        }
    }
    if (new Set(stores).size !== stores.length)
      throw new Error('Suite identity, grants, preferences and authority history must remain separate.');
  };
  separate();
  const freshFile = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return false;
    }
  };
  const fresh = freshFile(identity.grants),
    freshPreferences = freshFile(preferencePath),
    freshAuthority = freshFile(authorityPath);
  separate();
  const db = new DatabaseSync(identity.grants);
  let preferencesDb: DatabaseSync | undefined;
  let authorityDb: DatabaseSync | undefined;
  const close = () => {
    preferencesDb?.close();
    authorityDb?.close();
    db.close();
  };
  try {
    if (fresh) provisionSuiteGrantStore(db, identity.id);
    const grants = openSuiteGrantStore(db, identity.id);
    preferencesDb = new DatabaseSync(preferencePath);
    if (freshPreferences) provisionSuitePreferencesStore(preferencesDb, identity.id);
    const preferences = openSuitePreferencesStore(preferencesDb, identity.id);
    authorityDb = new DatabaseSync(authorityPath);
    if (freshAuthority) provisionSuiteAuthorityStore(authorityDb, identity.id);
    const authority = openSuiteAuthorityStore(authorityDb, identity.id);
    let closed = false;
    return {
      grants,
      preferences,
      authority,
      synchronous: true,
      files: [identity.grants, preferencePath, authorityPath],
      databases: [],
      separate,
      close: () => {
        if (closed) return;
        closed = true;
        close();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * The three stores as schemas of one PostgreSQL database (suiteStoresPostgres.ts), for a suite that keeps nothing
 * on its own disk. Every App's business connection must be PostgreSQL too: a SQLite owner fences its commands on
 * grant reads answered in the same turn, which PostgreSQL's cannot be, so such a suite is refused here rather than
 * denying each command later. The database is kept apart from the identity store and every business connection
 * by URL, then by asking each server who it is, and no business role may reach its schemas.
 */
async function postgresLedger(
  identity: SuiteIdentityConfiguration,
  deployments: Parameters<typeof openSuiteIdentity>[1],
  connections: readonly { readonly name: string; readonly url: string }[],
): Promise<Ledger> {
  for (const item of deployments)
    for (const connection of item.connections) {
      if (connection.http) continue;
      if (!POSTGRES_URL.test(expandEnv(connection.url, item.environment)))
        throw new Error(
          `The suite keeps its identity and grants on PostgreSQL, so every App's business database must be PostgreSQL too: ` +
            `connection "${connection.name}" of App "${item.app.app.id}" is not. Keep identity.store and identity.grants as SQLite files, or move the App to PostgreSQL.`,
        );
    }
  const others = [...connections, { name: 'the suite identity store', url: identity.store }];
  assertPostgresAuthStoreSeparation(identity.grants, others);
  if (!(await postgresSuiteStoresPresent(identity.grants))) await provisionPostgresSuiteStores(identity.grants, identity.id);
  const stores = await openPostgresSuiteStores(identity.grants, identity.id);
  try {
    await assertPostgresAuthStoreServerSeparation(stores.database, others, process.env, POSTGRES_SUITE_PREFIXES);
  } catch (error) {
    await stores.close();
    throw error;
  }
  return {
    grants: stores.grants,
    preferences: stores.preferences,
    authority: stores.authority,
    synchronous: false,
    files: [],
    databases: [{ name: 'the suite grant store', url: identity.grants }],
    separate: () => {},
    close: () => void stores.close(),
  };
}
