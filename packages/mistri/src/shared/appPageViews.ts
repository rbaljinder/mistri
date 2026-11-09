/**
 * A free-form page as a view: the keys the App loader writes from a
 * `pages/*.page.tsx` file (packages/mistri/src/server/app/appPages.ts), the
 * roles it is offered to, the forms it opens, and the dashboard of one custom
 * section it is served as. Split from appViews.ts, which parses every other
 * kind of view and calls parsePageView for this one; the head and the star are
 * a dashboard's too, so they live here and appViews imports them back.
 */
import type { AppPageRecord, AppRoleGrant } from './appModel.js';
import { allowKeys, isRecord, optionalText } from '@mistriwork/engine/shared/model.js';
import { checkDeclaredResource, checkResourceSlot } from './appResourceBlocks.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';
import { parsePage } from '@mistriwork/engine/shared/appComponents.js';
import { parseOpenRoles } from './appViewRoles.js';
import { isRegisteredCommand, registeredCommand } from './command.js';
import type { ContentContext, DashboardView, FormView, ParsedView } from './appViews.js';

/** A view's Favorites star is opt-in: true, or false, which is the same as leaving it out. */
export function favoriteFlag(value: unknown, at: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${at}: "favorite" must be true (a star on the view) or false.`);
  return value;
}

/**
 * The keys of a free-form page as the App loader writes it from a
 * `pages/*.page.tsx` file (packages/mistri/src/server/app/appPages.ts) — never authored in
 * `views`, which refuses the kind. `heading` and `props` are the internal
 * Console's, whose pages are written as data.
 */
const PAGE_VIEW_KEYS = [
  'kind',
  'label',
  'icon',
  'description',
  'heading',
  'head',
  'layout',
  'favorite',
  'component',
  'reads',
  'commands',
  'actions',
  'params',
  'loader',
  'forms',
  'props',
  'roles',
  'public',
  'record',
] as const;

/**
 * `head`: the form a dashboard's or a page's head takes. `'compact'` is the title alone on one line with its verbs,
 * with no intro; `false` is a page that draws its own head, its title kept for a screen reader so the room keeps its
 * one h1, and the label still the document title, the crumb and the palette's word. Absent is the full head.
 */
export function parseHead(value: unknown, at: string): { head?: 'compact' | 'own'; headingHidden?: true } {
  if (value === undefined) return {};
  if (value === false) return { head: 'own', headingHidden: true };
  if (value === 'compact') return { head: 'compact' };
  throw new Error(`${at}: "head" is 'compact' (the title on one line with its verbs, no intro) or false (the page draws its own head).`);
}

/**
 * A free-form page: the whole page drawn by the author's component. It is
 * served as a dashboard of one full-width custom section — so its menu
 * entry, its home rule, its address and its favorite star are a
 * dashboard's, with nothing to learn twice — which says `page`: the
 * resources it reads, which gate it like a section's table gates a
 * dashboard (a reader who cannot read one is not served the page), the
 * commands it runs, the address parameters it keeps its place in and the
 * loader that reads for it on the server.
 *
 * Who is offered it is said once, here, by what it reads: every role a page
 * names must be granted every read, or the page is a mistake some role would
 * meet broken; one that names none is offered to the people's roles that
 * are — never a service role, which no person holds — and never to a
 * signed-out visitor unless it says `public: true`, when every read must be
 * one `auth.public` opens. A command is not a door: a reader the page is
 * offered to who may not run one of its commands meets the page without it
 * (the command's handle says `granted: false`, and the server refuses it as
 * it refuses any command not granted). A command no role offered the page
 * may run is a mistake, as an unreadable read is.
 */
export function parsePageView(
  v: Record<string, unknown>,
  key: string,
  at: string,
  ctx: ContentContext,
  views: ReadonlyMap<string, ParsedView>,
): DashboardView {
  allowKeys(v, PAGE_VIEW_KEYS, `${at} (a free-form page)`);
  if (typeof v.label !== 'string' || !v.label.trim()) throw new Error(`[page-file] ${at} is a free-form page and has no "title".`);
  const page = parsePage(v, at);
  const forms = pageForms(v, at, views);
  for (const resource of page.reads) {
    checkResourceSlot(resource, `${at}, "reads"`, ctx.data);
    checkDeclaredResource(resource, `${at}, "reads"`, ctx.data);
  }
  for (const command of page.commands) {
    if (!isRegisteredCommand(command)) {
      throw new Error(`[page-commands] ${at} runs the command "${command}", which the commands module does not register.`);
    }
  }
  if (v.public !== undefined && v.public !== true) throw new Error(`[page-public] ${at} has a "public" that is not true.`);
  if (v.public === true && page.actions.length)
    throw new Error(`[page-public] ${at}: a public page runs public commands, not actions: a signed-out visitor holds no role to run one.`);
  /* A fixed action (a machine's verb, `action(label, { set })`) is the resource's own, run by the reader the way its record page
     runs it, so it is found on a resource the page reads; a command is not one and is named in "commands". */
  for (const id of page.actions) {
    const offered = page.reads.flatMap((resource) => ctx.data.resources?.[resource]?.actions ?? []);
    const found = offered.find((action) => action.id === id);
    if (found?.command || (!found && offered.some((action) => action.command?.id === id)))
      throw new Error(`[page-action] ${at}: "${id}" is a command; name it in commands.`);
    if (!found) {
      const fixed = offered.filter((action) => !action.command).map((action) => `"${action.id}"`);
      throw new Error(
        `[page-action] ${at}: "${id}" is not a fixed action of ${page.reads.map((resource) => `"${resource}"`).join(', ')}, the resources it reads. Their fixed actions: ${fixed.join(', ') || 'none'}.`,
      );
    }
  }
  /* A public page's commands are run by a signed-out visitor through the page's own door (http/pageCommandRoutes.ts),
     as the public principal: only a command that is itself public, and one that makes its record rather than naming
     one, the way a public form's is. A signed-in page's need roles to be granted to. */
  if (v.public === true) {
    for (const command of page.commands) {
      const entry = registeredCommand(command);
      if (entry?.public !== true)
        throw new Error(
          `[page-commands] ${at} is public and runs "${command}", which is not public: a public page runs only commands that say public: true.`,
        );
      if (entry.targets !== 'none')
        throw new Error(`[page-commands] ${at} is public and runs "${command}", which names a record; a public command makes its own.`);
    }
    if (page.commands.length && !ctx.auth)
      throw new Error(`[page-commands] ${at} runs public commands, and a public command needs "auth" (with "auth.public").`);
  } else if (page.commands.length && !ctx.auth?.roles)
    throw new Error(`[page-commands] ${at} runs commands, and commands need "auth" and "auth.roles".`);
  const record = pageRecord(v, page.reads, at, views);
  const roles = pageRoles(v, page, at, ctx);
  pageFormCoverage(forms, roles, at, ctx);
  const description = optionalText(v, 'description', at);
  if (v.heading !== undefined && v.heading !== false) throw new Error(`${at}: a page's "heading" is false, to draw it without its title.`);
  /* A bare page owns the window, so it has no head to shape: its title stays for a screen reader, as `head: false` keeps it. */
  if (v.layout !== undefined && v.layout !== 'bare')
    throw new Error(
      `[page-layout] ${at}: a free-form page's "layout" is 'bare' (no sidebar and no top bar); leave it out for the App's own frame.`,
    );
  if (v.layout === 'bare' && v.head !== undefined)
    throw new Error(
      `[page-layout] ${at} is bare and names "head": a bare page draws no head of the platform's (its title stays for a screen reader). Remove "head".`,
    );
  return {
    kind: 'dashboard',
    key,
    at,
    embeds: [],
    tables: page.reads,
    view: {
      ...(v.heading === false ? { headingHidden: true as const } : {}),
      ...(v.layout === 'bare' ? { ...parseHead(false, at), layout: 'bare' as const } : parseHead(v.head, at)),
      label: v.label.trim(),
      ...(description === undefined ? {} : { description }),
      sections: [
        {
          kind: 'custom',
          component: page.component,
          props: page.props,
          width: 'full',
        },
      ],
      page: {
        reads: page.reads,
        commands: page.commands,
        ...(page.actions.length ? { actions: page.actions } : {}),
        params: page.params,
        ...(page.loader ? { loader: page.loader } : {}),
        ...(forms.length ? { forms: forms.map((form) => form.key) } : {}),
        ...(v.public === true ? { public: true as const } : {}),
        ...(record ? { record } : {}),
      },
      ...(v.icon === undefined ? {} : { icon: parseIcon(v.icon, at) }),
      ...(favoriteFlag(v.favorite, at) ? { favorite: true as const } : {}),
      ...(roles ? { roles } : {}),
    },
  };
}

/* The tab words a record's page says itself after a record's address: a page tab named one would never be reached. */
const RECORD_WORDS = new Set(['new', 'edit']);
const TAB_WORD = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A page that is a record's tab (`pages/accounts/[id]/map.page.tsx`, placed by appPages.ts): under a list view the App
 * declares, reading that view's resource, so the record the tab is drawn on is one the page may read.
 */
function pageRecord(
  v: Record<string, unknown>,
  reads: readonly string[],
  at: string,
  views: ReadonlyMap<string, ParsedView>,
): AppPageRecord | undefined {
  if (v.record === undefined) return undefined;
  const record = v.record;
  if (!isRecord(record) || typeof record.view !== 'string' || typeof record.tab !== 'string')
    throw new Error(`[page-file] ${at}: "record" is where a record's tab is drawn, { view, tab }, and comes from its file's place.`);
  const list = views.get(record.view);
  if (list?.kind !== 'list') {
    const lists = [...views.values()].filter((each) => each.kind === 'list').map((each) => each.key);
    throw new Error(
      `[page-file] ${at} is a record's tab under "${record.view}", which is not a list view this App declares. A record's tab lives at pages/<list view>/[id]/<tab>.page.tsx; the list views: ${lists.join(', ') || 'none'}.`,
    );
  }
  if (!TAB_WORD.test(record.tab) || RECORD_WORDS.has(record.tab))
    throw new Error(
      `[page-file] ${at}: "${record.tab}" is not a record's tab word — lowercase letters, digits and hyphens, and not ${[...RECORD_WORDS].join(' or ')}.`,
    );
  for (const name of ['params', 'loader', 'public', 'favorite', 'head', 'layout'] as const)
    if (v[name] !== undefined)
      throw new Error(
        `[page-file] ${at} is a record's tab and has "${name}": a tab is drawn on its record's page, at its record's address, so it takes none.`,
      );
  const table = list.view.table;
  if (!reads.includes(table))
    throw new Error(
      `[page-file] ${at} is a tab of a "${table}" record and does not read "${table}": add it to reads, so the record it is drawn on is one it may read.`,
    );
  return { view: record.view, table, tab: record.tab };
}

/**
 * `forms: ['apply']`: the App's form views a page opens (`page.useForm('apply')`). Each is a form view the App
 * declares. A public page may name a signed-in one too, for the members who read it: a visitor is not served that
 * form's view, so `useForm` reads it as not granted and the page draws no door, and the server checks the grant on
 * every submit. A signed-in form a page names is reached from that page, so it needs no menu entry of its own.
 */
function pageForms(v: Record<string, unknown>, at: string, views: ReadonlyMap<string, ParsedView>): FormView[] {
  if (v.forms === undefined) return [];
  if (!Array.isArray(v.forms) || v.forms.some((name) => typeof name !== 'string' || !name.trim()))
    throw new Error(`[page-forms] ${at} has "forms" that are not a list of form view keys: forms: ['apply'].`);
  return [...new Set((v.forms as string[]).map((name) => name.trim()))].map((name) => {
    const view = views.get(name);
    if (view?.kind !== 'form') {
      const declared = [...views.values()].filter((each) => each.kind === 'form').map((each) => `"${each.key}"`);
      throw new Error(
        `[page-forms] ${at} opens the form "${name}", which is not a form view this App declares. Its form views: ${declared.join(', ') || 'none'}.`,
      );
    }
    return view;
  });
}

/* A signed-in form a page opens is some offered role's to submit, or the page offers a door no reader could use: the
   same mistake as a command no offered role is granted. The server still checks the grant on every submit. */
function pageFormCoverage(forms: readonly FormView[], roles: readonly string[] | undefined, at: string, ctx: ContentContext): void {
  const grants = ctx.auth?.roles;
  if (!grants || !roles) return;
  for (const { key, form } of forms) {
    if (form.public) continue;
    const offered = form.roles ? roles.filter((role) => form.roles!.includes(role)) : roles;
    if (!offered.some((role) => (grants[role]?.commands ?? []).includes(form.command.id)))
      throw new Error(
        `[page-coverage] ${at} opens the form "${key}", whose command "${form.command.id}" no role the page is offered to is granted. Grant it to one, or leave the form out of "forms".`,
      );
  }
}

/**
 * The roles a free-form page is offered to. Named, each must be granted
 * what the page reads (`page-coverage`); unnamed, the roles that are, but
 * a service role. Either way each command it runs must be some offered
 * role's. A public page names none: it is everyone's, a signed-out
 * visitor's too, and reads only what `auth.public` opens.
 */
function pageRoles(
  v: Record<string, unknown>,
  page: { reads: string[]; commands: string[] },
  at: string,
  ctx: ContentContext,
): string[] | undefined {
  const grants = ctx.auth?.roles;
  if (v.public === true) {
    if (v.roles !== undefined) throw new Error(`[page-public] ${at} is public and names "roles": a public page is everyone's.`);
    const open = new Set(ctx.auth?.public?.read ?? []);
    if (!ctx.auth?.public)
      throw new Error(`[page-public] ${at} is public, and the App opens nothing to signed-out visitors (auth.public).`);
    const closed = page.reads.find((resource) => !open.has(resource));
    if (closed) throw new Error(`[page-public] ${at} is public and reads "${closed}", which "auth.public" does not open.`);
    return undefined;
  }
  if (!grants) return parseOpenRoles(v.roles, at, ctx.auth);
  const reads = (grant: AppRoleGrant, resource: string) =>
    grant.read === true || (Array.isArray(grant.read) && grant.read.includes(resource));
  const unread = (grant: AppRoleGrant): string | undefined => page.reads.find((resource) => !reads(grant, resource));
  /* Each command is some offered role's to run, or no one could: a mistake, as an unreadable read is. */
  const runnable = (offered: readonly string[]) => {
    const stray = page.commands.find((command) => !offered.some((role) => (grants[role].commands ?? []).includes(command)));
    if (stray !== undefined) {
      throw new Error(
        `[page-coverage] ${at} runs "${stray}", which no role it is offered to is granted. Grant it to one, or leave it out of "commands".`,
      );
    }
  };
  const named = parseOpenRoles(v.roles, at, ctx.auth);
  if (named) {
    for (const role of named) {
      const missing = unread(grants[role]);
      if (missing !== undefined) {
        throw new Error(
          `[page-coverage] ${at} is offered to the role "${role}", which is not granted "${missing}". ` +
            'Every role a page names reads all it reads: grant it, or leave the role out.',
        );
      }
    }
    runnable(named);
    return named;
  }
  const able = Object.keys(grants).filter((role) => !grants[role].service && unread(grants[role]) === undefined);
  if (!able.length) {
    throw new Error(
      `[page-coverage] ${at} reads what no person's role is granted all of, so no one could open it. Grant a role, or narrow the page.`,
    );
  }
  runnable(able);
  return able;
}
