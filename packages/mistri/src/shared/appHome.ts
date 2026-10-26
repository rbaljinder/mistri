/**
 * `home`: where a visitor starts, and every App says it. A view id names
 * one view for every visitor; a list of rules `{ view, signedOut?, roles? }`
 * is read in order and the first match wins — `signedOut` matches a visitor
 * with no session, `roles` a signed-in visitor holding any of them, and a
 * rule with neither matches everyone. A list ends with that catch-all, so
 * no visitor is left without a home. Nothing is inferred from nav, which
 * is optional: an App without it has no menu, and its home is still open.
 *
 * Checked at load: every view exists and every role is declared; a
 * signed-out rule's view is public and names no `roles`; a roles rule's view
 * is one those roles can open (its table, every table a dashboard reads, or
 * the command a signed-in form runs, which each of them must be granted, and
 * the view's own `roles`, which must include each of them); nothing follows a
 * rule without a condition, and a list ends with one; `signedOut` needs
 * `auth`. `realm` rules wait for the platform realm.
 *
 * Evaluated by the server on every request, never by the client: against
 * the verified session's roles, or in a tenant App the current membership's
 * — so one person can start differently in each tenant. `/api/app` carries
 * the answer as `home`; the signed-out who-am-I carries a signed-out
 * visitor's home only when it is public.
 */
import { isPublicForm, parseRealm, type AppAuth, type AppDef, type AppHomeRule } from './appModel.js';
import { allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';

/** A view as a home rule sees it: what its visitors must read, and for a form the command they must hold. */
export interface HomeView {
  kind: 'list' | 'dashboard' | 'landing' | 'form';
  tables: string[];
  command?: string;
  public?: true;
  roles?: readonly string[];
}
interface HomeRule extends AppHomeRule {
  at: string;
}

/** `ceiling` is every declared resource: what a role's `read: true` reads. */
export function parseHome(
  raw: unknown,
  where: string,
  views: ReadonlyMap<string, HomeView>,
  auth: AppAuth | undefined,
  ceiling: readonly string[],
  name: string,
): HomeRule[] {
  const declared = views.size ? `It declares: ${[...views.keys()].join(', ')}.` : 'It declares no views yet.';
  if (raw === undefined) {
    throw new Error(
      `${where}: the App "${name}" has no "home", so nothing says where a visitor starts. Write home: '<view id>', ` +
        `or a list of rules that ends with a rule with no condition, { view: '<view id>' }. ${declared}`,
    );
  }
  const at = `${where}: "home"`;
  const known = (view: unknown, here: string): string => {
    if (typeof view !== 'string' || !views.has(view)) {
      throw new Error(`${here} names the view "${String(view)}", which this App does not declare. ${declared}`);
    }
    return view;
  };
  if (typeof raw === 'string') return [{ view: known(raw, at), at }];
  if (!Array.isArray(raw) || !raw.length)
    throw new Error(`${at} is not a view id or a non-empty list of rules { view, signedOut?, roles? }.`);
  const rules: HomeRule[] = [];
  let catchAll: string | undefined;
  let signedOutAt: string | undefined;
  raw.forEach((entry, i) => {
    const here = `${at}, rule ${i + 1}`;
    if (!isRecord(entry)) throw new Error(`${here} is not an object { view, signedOut?, roles? }.`);
    allowKeys(entry, ['view', 'signedOut', 'roles', 'realm'], here);
    // Which context the rule is for; that it agrees with its view's realm is judged once the App is whole (appTenancy.ts).
    const realm = entry.realm === undefined ? undefined : parseRealm(entry.realm, here);
    const view = known(entry.view, here);
    if (catchAll) throw new Error(`${here} can never match: ${catchAll} has no condition and matches every visitor first.`);
    if (entry.signedOut === true && signedOutAt)
      throw new Error(`${here} can never match: ${signedOutAt} already sends every signed-out visitor to its view.`);
    if (entry.signedOut !== undefined && entry.signedOut !== true) throw new Error(`${here} has a "signedOut" that is not true.`);
    if (entry.signedOut && !auth)
      throw new Error(`${here} says "signedOut", and the App has no "auth": nobody signs in to it, so nobody is signed out.`);
    if (entry.signedOut && entry.roles !== undefined)
      throw new Error(`${here} says "signedOut" and "roles": a signed-out visitor holds no roles.`);
    const { kind, command, public: open } = views.get(view)!;
    /* With `auth.public`, a view whose every table the public reads opens to a signed-out visitor too. */
    const publicReads = new Set(auth?.public?.read ?? []);
    const visitorsRead =
      kind !== 'form' && views.get(view)!.tables.length > 0 && views.get(view)!.tables.every((table) => publicReads.has(table));
    const opensTo = views.get(view)!.roles;
    if (entry.signedOut && opensTo) {
      throw new Error(
        `${here} sends signed-out visitors to "${view}", which names "roles"; a signed-out visitor holds none, so could not open it.`,
      );
    }
    if (entry.signedOut && kind !== 'landing' && !open && !visitorsRead) {
      throw new Error(
        `${here} sends signed-out visitors to "${view}", a ${kind === 'form' ? 'signed-in form' : kind} view; a signed-out visitor can open only a public view (a landing or a public form${auth?.public ? ', or a view whose every table "auth.public" reads' : ''}).`,
      );
    }
    let roles: string[] | undefined;
    if (entry.roles !== undefined) {
      const declaredRoles = Object.keys(auth?.roles ?? {});
      if (!Array.isArray(entry.roles) || !entry.roles.length || entry.roles.some((role) => typeof role !== 'string')) {
        throw new Error(`${here} has "roles" that are not a non-empty list of role names.`);
      }
      roles = entry.roles as string[];
      for (const role of roles) {
        if (!declaredRoles.includes(role)) {
          throw new Error(
            `${here} names the role "${role}", which auth.roles does not declare. ${declaredRoles.length ? `It declares: ${declaredRoles.join(', ')}.` : 'The App declares no roles.'}`,
          );
        }
        if (opensTo && !opensTo.includes(role)) {
          throw new Error(
            `${here}: the role "${role}" is not among the roles "${view}" names (${opensTo.join(', ')}). A home must be a view its visitors can open.`,
          );
        }
        const grant = auth!.roles![role];
        const reads = new Set(grant.read === true ? ceiling : grant.read === false ? [] : grant.read);
        for (const table of views.get(view)!.tables) {
          if (!reads.has(table)) {
            throw new Error(
              `${here}: the role "${role}" does not read "${table}", which the view "${view}" shows. A home must be a view its visitors can open.`,
            );
          }
        }
        /* A signed-in form opens to the roles granted its command, and to no one else. */
        if (command !== undefined && !open && !grant.commands?.includes(command)) {
          throw new Error(
            `${here}: the role "${role}" is not granted the command "${command}", which the form "${view}" runs. A home must be a view its visitors can open.`,
          );
        }
      }
    }
    if (!entry.signedOut && !roles) catchAll = `rule ${i + 1}`;
    if (entry.signedOut) signedOutAt = `rule ${i + 1}`;
    rules.push({
      view,
      ...(entry.signedOut ? { signedOut: true as const } : {}),
      ...(roles ? { roles } : {}),
      ...(realm === undefined ? {} : { realm }),
      at: here,
    });
  });
  if (!catchAll) {
    throw new Error(
      `${rules.at(-1)!.at} has a condition and is the last rule, so a visitor it does not match has no home. ` +
        "End the list with a rule with no condition: { view: '<view id>' }.",
    );
  }
  return rules;
}

/**
 * Who is asking, as the server verified it: nobody signed in, or a session
 * holding these roles — in a tenant App, the current membership's. Nothing
 * else a request says has a say in where it starts.
 */
export type HomePrincipal = { signedIn: false } | { signedIn: true; roles: readonly string[] };

/** Whether a rule's condition holds for the principal. */
export function homeRuleMatches(rule: AppHomeRule, principal: HomePrincipal): boolean {
  if (rule.signedOut) return !principal.signedIn;
  if (rule.roles) return principal.signedIn && rule.roles.some((role) => principal.roles.includes(role));
  return true;
}

/**
 * The view this principal starts on: the first rule that matches it and
 * names a view it can open, or undefined when none does. `opens` says which
 * views those are; for a signed-in principal, what its payload still holds
 * once field filtering and the views that cannot be drawn have gone, and
 * the public views. A rule whose view was pruned for this principal gives
 * way to the next rule that matches, never to a room that is not there.
 */
export function resolveHome(
  app: Pick<AppDef, 'home'>,
  principal: HomePrincipal,
  opens: (view: string) => boolean = () => true,
): string | undefined {
  return app.home.find((rule) => homeRuleMatches(rule, principal) && opens(rule.view))?.view;
}

/** The public view a view id names, if any: the landing, or a form that says `public: true`. */
export function publicView(app: Pick<AppDef, 'landing' | 'views'>, view: string): 'landing' | 'form' | undefined {
  if (app.landing?.view === view) return 'landing';
  return Object.hasOwn(app.views, view) && isPublicForm(app.views[view]) ? 'form' : undefined;
}

/**
 * Where a signed-out visitor starts, when that is a public view: the
 * landing or a public form. A signed-out visitor whose rule names any other
 * view meets the sign-in screen first, and this says nothing of the view.
 */
export function publicHome(app: Pick<AppDef, 'home' | 'landing' | 'views'> & { auth?: Pick<AppAuth, 'public'> }): string | undefined {
  const view = resolveHome(app, { signedIn: false });
  if (view === undefined) return undefined;
  if (publicView(app, view)) return view;
  /* A signed-out rule's own view, which parseHome allowed only where the public reads all it shows. */
  const rule = app.home.find((candidate) => homeRuleMatches(candidate, { signedIn: false }));
  return app.auth?.public && rule?.signedOut ? view : undefined;
}

/** Every view a home rule names: the rooms a signed-in visitor may start on, served though nav may not list them. */
export const homeViews = (app: Pick<AppDef, 'home'>): string[] => [...new Set(app.home.map((rule) => rule.view))];
