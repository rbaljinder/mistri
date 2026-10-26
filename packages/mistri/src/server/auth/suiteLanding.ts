/** Where a signed-in suite account may be sent: the operator's landing rules,
 * a deep link carried through sign-in, and the one grant test both share.
 * Sharing one identity grants nothing: every destination here is an App the
 * account's current grant already opens, and that App checks again on arrival. */
import { isFormView, isPublicForm } from '../../shared/app.js';
import { publicHome } from '../../shared/appHome.js';
import { SERVER_SEGMENTS } from '@mistriwork/engine/shared/mount.js';
import type { LoadedApp } from '../app/apps.js';
import { suiteAppRoles } from './suiteAppRoles.js';

/** One rule of `identity.landing`: the first that holds for the signed-in account names its App. */
export interface SuiteLandingRule {
  readonly app: string;
  /** Any one of these roles in the App's current grant; omitted, any grant. */
  readonly roles?: readonly string[];
  /** At least one active membership in the tenant App, read from the App's own tenant owner. */
  readonly member?: true;
}

/** Whether a grant opens the App. Array.from visits sparse slots: never admit
 * the valid subset of a malformed grant, nor the native account's own role. */
export function grantAdmits(app: LoadedApp['app'], grant: Readonly<{ revision: unknown; roles: unknown }>): boolean {
  const allowed = suiteAppRoles(app),
    roles = grant.roles;
  return (
    typeof grant.revision === 'number' &&
    Number.isSafeInteger(grant.revision) &&
    grant.revision > 0 &&
    Array.isArray(roles) &&
    roles.length > 0 &&
    roles.length <= allowed.length &&
    new Set(roles).size === roles.length &&
    Array.from(roles).every((role) => allowed.includes(role))
  );
}

/** An App every page of which needs App access: no public read, public form,
 * landing or signed-out home. Only such an App's pages turn a signed-in
 * account without a grant to the chooser; a public App answers for itself. */
export function privateSuiteApp(app: LoadedApp['app']): boolean {
  return (
    Boolean(app.auth) &&
    !app.auth!.public &&
    !app.landing &&
    !Object.values(app.views).filter(isFormView).some(isPublicForm) &&
    publicHome(app) === undefined
  );
}

/** A deep link worth carrying through sign-in: a same-origin path, written
 * exactly as a browser would send it, into one deployed App's pages — never
 * its API, assets or the suite's own routes. Anything else is not a
 * destination at all, so no caller can be turned into an open redirect. */
export function suiteDeepLink<T extends { app: LoadedApp; basePath: string }>(
  value: unknown,
  deployments: readonly T[],
  suiteBase: string,
): { deployment: T; href: string } | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\p{Cc}\s#]/u.test(value)) return undefined;
  const [path] = value.split('?');
  // Encoded separators and dot segments would mean another path once decoded or normalized.
  if (/%2f|%5c|%2e/i.test(path) || path.split('/').some((part) => part === '.' || part === '..')) return undefined;
  let url: URL;
  try {
    url = new URL(value, 'http://suite.invalid');
    decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (url.origin !== 'http://suite.invalid' || `${url.pathname}${url.search}` !== value) return undefined;
  if (path !== suiteBase && !path.startsWith(`${suiteBase}/`)) return undefined;
  const owner = deployments
    .filter((item) => path === item.basePath || path.startsWith(`${item.basePath}/`))
    .sort((a, b) => b.basePath.length - a.basePath.length)[0];
  if (!owner) return undefined;
  const first = path.slice(owner.basePath.length).split('/')[1] ?? '';
  if (SERVER_SEGMENTS.includes(first)) return undefined;
  return { deployment: owner, href: value };
}

type Grant = Readonly<{ revision: unknown; roles: unknown }>;

/** The App the operator's rules choose, or undefined when none holds. `grant`
 * reads the account's current grant in an App; `memberships` asks a tenant
 * App's own owner how many active memberships the account holds there. */
export async function landingFor<T extends { app: LoadedApp }>(
  rules: readonly SuiteLandingRule[],
  deployments: readonly T[],
  grant: (app: LoadedApp['app']) => Grant | Promise<Grant>,
  memberships: ((appId: string) => Promise<number>) | undefined,
): Promise<T | undefined> {
  for (const rule of rules) {
    const item = deployments.find((candidate) => candidate.app.app.id === rule.app);
    if (!item) continue;
    const value = await grant(item.app.app);
    if (!grantAdmits(item.app.app, value)) continue;
    if (rule.roles && !rule.roles.some((role) => (value.roles as readonly string[]).includes(role))) continue;
    if (rule.member && !((await memberships?.(rule.app)) ?? 0)) continue;
    return item;
  }
  return undefined;
}
