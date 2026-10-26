/**
 * The `ui` block: chrome and formatting, the one nested object of the
 * root. A record-backed theme normalizes into a static fallback plus a
 * server-only descriptor; catalog binding happens on the server.
 */
import {
  PLACEMENTS,
  SHELL_GUTTERS,
  SHELL_HEADER_WIDTHS,
  SHELL_WIDTHS,
  THEME_KEYS,
  type AppEditing,
  type AppLogoImage,
  type AppReaderZone,
  type AppShell,
  type AppShellNew,
  type AppSidebar,
  type AppTheme,
  type AppUi,
} from './appModel.js';
import { allowKeys, isRecord, keyHomesOf } from '@mistriwork/engine/shared/model.js';
import { THEME_BASES, type ThemeDefinition } from '@mistriwork/engine/shared/theme.js';
import type { ThemeAudiences } from '@mistriwork/engine/shared/themeResolve.js';
import { themePreset } from '@mistriwork/engine/shared/themePresets.js';
import { compileAppTheme } from './themeSpec.js';
import { parseFooter } from './appLanding.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';
import { unknownKey } from '@mistriwork/engine/shared/suggest.js';
import { zoneKnown } from './appZone.js';

/** Who the header's search is offered to; false hides it from everyone. */
const SHELL_SEARCH: readonly string[] = ['members', 'everyone'];
import { parseRecordBranding, parseRecordMessages, type RecordBrandingSpec, type RecordMessagesSpec } from './branding.js';
import { parseAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import type { AppSwitcher, StaticAppTarget } from '../../schema/app.js';
import type { SaidCaptions } from '@mistriwork/engine/shared/appMessages.js';

export const UI_KEYS = [
  'theme',
  'customThemes',
  'shell',
  'editing',
  'export',
  'locale',
  'messages',
  'timezone',
  'currency',
  'footer',
  'logo',
  'csp',
  'appSwitcher',
] as const;
export const SHELL_KEYS = [
  'menuSearch',
  'search',
  'breadcrumbs',
  'heading',
  'width',
  'headerWidth',
  'gutter',
  'placement',
  'rail',
  'counts',
  'sidebar',
  'new',
] as const;

/** The shells parseUi gave the placement its own theme suggested: what the App did not write itself. */
const SUGGESTED = new WeakSet<object>();

type Placement = NonNullable<AppShell['placement']>;

/**
 * Where the App puts its menu itself, and what says so: `ui.shell.placement`, or a rail (`ui.shell.rail`), which is
 * the side menu folded and keeps the side. Not a placement its own theme suggested; undefined when it says none.
 */
export function ownPlacement(ui: AppUi): { placement: Placement; by: 'ui.shell.placement' | 'ui.shell.rail' } | undefined {
  const shell = ui.shell;
  if (!shell || SUGGESTED.has(shell)) return undefined;
  if (shell.placement !== undefined) return { placement: shell.placement, by: 'ui.shell.placement' };
  return shell.rail ? { placement: 'side', by: 'ui.shell.rail' } : undefined;
}

/**
 * Where the menu stands when the App wears `theme` as its own: where the App puts it, else where the theme suggests
 * (defineTheme's `shell.placement`), else the side; `moved`, that place where it is not where the App draws it now
 * (its own theme's suggestion, else the side) — what shot and the theme bench tell the page; and, where the App's
 * word overrides the theme's, the one line that says so.
 */
export function placementIn(
  ui: AppUi,
  theme: Pick<ThemeDefinition, 'label' | 'shell'> | undefined,
): { placement: Placement; moved?: 'side' | 'top'; overridden?: string } {
  const own = ownPlacement(ui);
  const suggested = theme?.shell?.placement;
  const where = (placement: Placement) =>
    placement === 'top' ? 'on top' : placement === 'side' ? 'at the side' : `on top for ${placement.top.join(', ')}`;
  if (!own) {
    const placement = suggested ?? 'side';
    const drawn = typeof ui.shell?.placement === 'string' ? ui.shell.placement : 'side';
    return { placement, ...(placement !== drawn ? { moved: placement } : {}) };
  }
  const same = typeof own.placement === 'string' && own.placement === suggested;
  return {
    placement: own.placement,
    ...(suggested && !same
      ? {
          overridden: `${theme!.label} suggests the menu ${where(suggested)}; the App's ${own.by} puts it ${where(own.placement)}, which wins.`,
        }
      : {}),
  };
}

export function parseUi(raw: unknown, where: string): AppUi {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`${where}: "ui" is not an object.`);
  /* The origins a page may reach are grouped under `csp`, the policy they open (renamed before 1.0). */
  allowKeys(raw, UI_KEYS, `${where}: "ui"`, {
    connect: 'is now "csp.connect": ui: { csp: { connect: [...] } }',
    images: 'is now "csp.images": ui: { csp: { images: [...] } }',
  });
  if (raw.export !== undefined && typeof raw.export !== 'boolean') {
    throw new Error(`${where}: "ui.export" is not true or false.`);
  }
  const parsedShell = raw.shell === undefined ? undefined : parseShell(raw.shell, where);
  const editing = raw.editing === undefined ? undefined : parseEditing(raw.editing, where);
  const appSwitcher = raw.appSwitcher === undefined ? undefined : parseAppSwitcher(raw.appSwitcher, `${where}: ui.appSwitcher`);
  const locale = raw.locale === undefined ? undefined : parseLocale(raw.locale, where);
  let messages: RecordMessagesSpec | undefined;
  if (raw.messages !== undefined) {
    try {
      messages = parseRecordMessages(raw.messages);
    } catch (error) {
      throw new Error(`${where}: ui.messages fromRecord: ${(error as Error).message}`);
    }
  }
  const timezone = raw.timezone === undefined ? undefined : parseZone(raw.timezone, where);
  const csp = raw.csp === undefined ? undefined : parseCsp(raw.csp, where);
  if (raw.currency !== undefined && (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency))) {
    throw new Error(`${where} has a "ui.currency" that is not a three-letter code like "USD".`);
  }
  /* The App's footer, under every room. A landing already had one of its own
     and public-facing Apps kept wanting it on the pages people actually read
     — a marketplace whose listing pages end in nothing looks unfinished. Same
     shape, one parser (appLanding.parseFooter). */
  const footer = raw.footer === undefined ? undefined : parseFooter(raw.footer, `${where}: ui.footer`);
  const logo =
    raw.logo === undefined ? undefined : isRecord(raw.logo) ? parseLogoImage(raw.logo, where) : parseIcon(raw.logo, `${where}: ui`, 'logo');
  /* An App's own theme is `defineTheme(...)`, registered in ui.customThemes and compiled there over the built-in it
     extends; ui.theme names it with `preset`, as a built-in is named. One way: a theme given to ui.theme directly was
     the same register under a second spelling, and is refused with the first. */
  if (isRecord(raw.theme) && raw.theme.kind === 'theme') {
    const id = typeof raw.theme.id === 'string' ? raw.theme.id : '<its id>';
    throw new Error(
      `${where}: ui.theme is a theme written with defineTheme(...), which is now registered in ui.customThemes and named by ui.theme: customThemes: [theme], theme: { preset: '${id}' }.`,
    );
  }
  const customThemes = parseCustomThemes(raw.customThemes, where);
  let branding: RecordBrandingSpec | undefined;
  if (isRecord(raw.theme) && Object.hasOwn(raw.theme, 'kind')) {
    try {
      branding = parseRecordBranding(raw.theme);
    } catch (error) {
      throw new Error(`${where}: ui.theme fromRecord: ${(error as Error).message}`);
    }
  }
  const theme: AppTheme | undefined = branding ? Object.freeze({ preset: branding.fallback.preset }) : parseTheme(raw.theme, where);
  /* The App's own theme may suggest where the menu goes (defineTheme's shell.placement); ui.shell says it first, and a
     rail is the side menu folded, so an App that asks for one keeps the side. */
  const suggested = customThemes?.find((item) => item.id === theme?.preset)?.shell?.placement;
  const shell =
    suggested && parsedShell?.placement === undefined && !parsedShell?.rail ? { ...parsedShell, placement: suggested } : parsedShell;
  if (shell && shell !== parsedShell) SUGGESTED.add(shell);
  if (theme?.preset && ![...THEME_BASES, ...(customThemes ?? []).map((item) => item.id)].includes(theme.preset)) {
    throw new Error(`${where}: ui.theme.preset "${theme.preset}" is not a built-in theme or one of ui.customThemes.`);
  }
  /* Every theme an audience is dressed in is one the App offers, as the preset is. */
  const offered = [...THEME_BASES, ...(customThemes ?? []).map((item) => item.id)];
  for (const [path, id] of [
    ['public', theme?.for?.public],
    ...Object.entries(theme?.for?.roles ?? {}).map(([role, id]) => [`roles.${role}`, id]),
  ] as [string, string | undefined][])
    if (id !== undefined && !offered.includes(id))
      throw new Error(`${where}: ui.theme.for.${path} "${id}" is not a built-in theme or one of ui.customThemes.`);
  if (theme?.palette !== undefined) {
    // A built-in look's palettes are authorable too: Lumen's Violet, Teal,
    // Emerald, Rose and Amber. The reader's Preferences already offered them.
    const selected = customThemes?.find((item) => item.id === theme.preset) ?? themePreset(theme.preset);
    if (
      !theme.preset ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(theme.palette) ||
      (theme.palette !== 'default' && !selected?.palettes?.some((item) => item.id === theme.palette))
    ) {
      throw new Error(`${where}: ui.theme.palette must be "default" or a palette of ui.theme.preset; a preset is required.`);
    }
  }
  return {
    ...(appSwitcher === undefined ? {} : { appSwitcher }),
    ...(footer === undefined ? {} : { footer }),
    ...(logo === undefined ? {} : { logo }),
    ...(theme === undefined ? {} : { theme }),
    ...(branding === undefined ? {} : { branding }),
    ...(customThemes === undefined ? {} : { customThemes }),
    ...(shell === undefined || !Object.keys(shell).length ? {} : { shell }),
    ...(editing === undefined ? {} : { editing }),
    ...(raw.export === undefined ? {} : { export: raw.export as boolean }),
    ...(locale?.tag === undefined ? {} : { locale: locale.tag }),
    ...(locale?.column === undefined ? {} : { localeColumn: locale.column }),
    ...(messages === undefined ? {} : { messages }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(raw.currency === undefined ? {} : { currency: (raw.currency as string).toUpperCase() }),
    ...(csp === undefined ? {} : { csp }),
  };
}

function switcherObject(raw: unknown, keys: readonly string[], at: string): Record<string, unknown> {
  if (!isRecord(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error(`${at} must be an object.`);
  for (const key of Reflect.ownKeys(raw)) {
    const property = Object.getOwnPropertyDescriptor(raw, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !property.enumerable || !('value' in property)) {
      throw new Error(`${at} has an unsupported field "${String(key)}".`);
    }
  }
  return raw;
}

function switcherLabel(raw: unknown, at: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 120 || /[\p{Cc}\p{Cs}]/u.test(raw)) {
    throw new Error(`${at} must be non-blank text of at most 120 characters.`);
  }
  return raw.trim();
}

function switcherList(raw: unknown, maximum: number, at: string): unknown[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > maximum) throw new Error(`${at} must have 1 to ${maximum} entries.`);
  return Array.from(raw);
}

function parseAppSwitcher(raw: unknown, at: string): SaidCaptions<AppSwitcher> {
  const input = switcherObject(raw, ['placement', 'label', 'apps', 'groups'], at);
  if (input.placement !== 'navbar' && input.placement !== 'account') throw new Error(`${at}.placement must be navbar or account.`);
  if (Object.hasOwn(input, 'apps') === Object.hasOwn(input, 'groups')) throw new Error(`${at} needs exactly one of apps or groups.`);
  const base: Pick<SaidCaptions<AppSwitcher>, 'placement' | 'label'> = {
    placement: input.placement,
    ...(input.label === undefined ? {} : { label: switcherLabel(input.label, `${at}.label`) }),
  };
  if (Object.hasOwn(input, 'apps')) {
    if (input.apps === 'authorized') return { ...base, apps: 'authorized' };
    const apps = switcherList(input.apps, 64, `${at}.apps`).map((id, index) => {
      if (typeof id !== 'string' || /[\p{Cc}\p{Cs}]/u.test(id) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
        throw new Error(`${at}.apps[${index}] must be an App id.`);
      }
      return id;
    });
    if (new Set(apps).size !== apps.length) throw new Error(`${at}.apps must name each App once.`);
    return { ...base, apps };
  }
  const labels = new Set<string>();
  const groups = switcherList(input.groups, 12, `${at}.groups`).map((rawGroup, index) => {
    const here = `${at}.groups[${index}]`,
      group = switcherObject(rawGroup, ['label', 'links'], here);
    const label = switcherLabel(group.label, `${here}.label`),
      identity = label.toLowerCase();
    if (labels.has(identity)) throw new Error(`${here}.label repeats a group label.`);
    labels.add(identity);
    const linkLabels = new Set<string>();
    const links = switcherList(group.links, 32, `${here}.links`).map((rawLink, i) => {
      const location = `${here}.links[${i}]`,
        link = switcherObject(rawLink, ['label', 'to'], location);
      const caption = switcherLabel(link.label, `${location}.label`),
        key = caption.toLowerCase();
      if (linkLabels.has(key)) throw new Error(`${location}.label repeats a link label in this group.`);
      linkLabels.add(key);
      return { label: caption, to: parseAppTarget(link.to, `${location}.to`, false) as StaticAppTarget };
    });
    return { label, links };
  });
  return { ...base, groups };
}

/** The most origins one egress list names: a few services, never a crawl. */
const MAX_ORIGINS = 16;
/* An origin as a policy can say it and nothing more: https, a host and an
   optional port. No path, no wildcard, no quote or space that could close
   the policy's source list and open another directive. Plain http only to
   the machine itself, for a local service in development. */
const ORIGIN =
  /^(?:https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|http:\/\/(?:localhost|127\.0\.0\.1))(?::\d{1,5})?$/;

/**
 * `ui.csp`: the origins beside its own an App's custom components may send
 * requests to (`connect`) and load pictures from (`images`). The page's policy
 * opens exactly these (clientHttp.ts shellPolicy), and authority.lock records
 * each, because opening a way out of the page is authority: a reader's rows
 * could leave by it.
 */
function parseCsp(raw: unknown, where: string): NonNullable<AppUi['csp']> {
  if (!isRecord(raw)) throw new Error(`${where}: "ui.csp" is not an object: { connect?: [...origins], images?: [...origins] }.`);
  allowKeys(raw, ['connect', 'images'], `${where}: "ui.csp"`);
  return { ...egress(raw, 'connect', where), ...egress(raw, 'images', where) };
}

function egress(raw: Record<string, unknown>, key: 'connect' | 'images', where: string): { connect?: string[]; images?: string[] } {
  const value = raw[key];
  if (value === undefined) return {};
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_ORIGINS ||
    value.some((origin) => typeof origin !== 'string' || !ORIGIN.test(origin.trim().replace(/\/$/, '').toLowerCase()))
  ) {
    throw new Error(
      `${where}: "ui.csp.${key}" is not a list of up to ${MAX_ORIGINS} origins like "https://api.example.com" — https, a host and a port at most; ` +
        'no path and no wildcard.',
    );
  }
  return { [key]: [...new Set(value.map((origin) => (origin as string).trim().replace(/\/$/, '').toLowerCase()))].sort() };
}

function parseEditing(raw: unknown, where: string): AppEditing {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    throw new Error(`${where}: "ui.editing" must be an object.`);
  }
  const input = raw as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'save') throw new Error(`${where}: ui.editing ${unknownKey(String(key), ['save'], keyHomesOf(String(key)))}.`);
  }
  if (!Object.hasOwn(input, 'save') || (input.save !== 'explicit' && input.save !== 'blur')) {
    throw new Error(`${where}: ui.editing.save is required and must be "explicit" or "blur".`);
  }
  return { save: input.save };
}

function parseShell(raw: unknown, where: string): AppShell {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    throw new Error(`${where}: "ui.shell" must be an object.`);
  }
  const input = raw as Record<string, unknown>;
  /* One way to have no menu: an App without `nav` (removed before 1.0). */
  if (input.menu !== undefined)
    throw new Error(`${where}: ui.shell has "menu", which is gone: an App with no "nav" has no menu, and one with a nav draws it.`);
  /* Said as what it replaces, not as a typo: an App 0.8 gave a way into the database browser from its menu. */
  if (input.workbench !== undefined)
    throw new Error(
      `${where}: ui.shell has "workbench", which is gone: an App serves only the resources it declares and no Workbench at all. ` +
        'To browse the database itself, run the standalone browser, `npx tablewalk <database>`; to give people a room onto a table, declare a resource and a list view for it.',
    );
  if (input.title !== undefined) throw new Error(`${where}: ui.shell has "title", which is now "heading", as a view's own heading is.`);
  for (const key of Object.keys(input)) {
    if (!(SHELL_KEYS as readonly string[]).includes(key))
      throw new Error(`${where}: ui.shell ${unknownKey(key, SHELL_KEYS, keyHomesOf(key))}.`);
  }
  const shell: AppShell = {};
  if (isRecord(input.placement)) {
    /* The roles are judged against auth.roles where both are parsed (app.ts). */
    allowKeys(input.placement, ['top'], `${where}: ui.shell.placement`);
    if (!Array.isArray(input.placement.top))
      throw new Error(`${where}: ui.shell.placement.top must be a list of the roles drawn the top bar.`);
    shell.placement = { top: input.placement.top as string[] };
  } else if (input.placement !== undefined) {
    if (!(PLACEMENTS as readonly string[]).includes(String(input.placement))) {
      throw new Error(`${where}: ui.shell.placement must be one of: ${PLACEMENTS.join(', ')}, or { top: [roles] }.`);
    }
    shell.placement = input.placement as AppShell['placement'];
  }
  /* A member's by default; a signed-out visitor is offered it only where the App says its public pages are worth
     searching. */
  if (input.search !== undefined) {
    if (input.search === true) {
      throw new Error(`${where}: ui.shell.search true is now 'members' (the default); it is 'members', 'everyone' or false.`);
    }
    if (isRecord(input.search) && input.search.signedOut === true) {
      throw new Error(`${where}: ui.shell.search { signedOut: true } is now 'everyone'.`);
    }
    if (input.search !== false && !SHELL_SEARCH.includes(input.search as 'members')) {
      throw new Error(`${where}: ui.shell.search must be 'members', 'everyone' or false.`);
    }
    shell.search = input.search as AppShell['search'];
  }
  for (const key of ['menuSearch', 'breadcrumbs', 'heading', 'counts'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error(`${where}: ui.shell.${key} must be true or false.`);
    shell[key] = value;
  }
  for (const key of ['width', 'headerWidth', 'gutter'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const values: readonly string[] = key === 'width' ? SHELL_WIDTHS : key === 'headerWidth' ? SHELL_HEADER_WIDTHS : SHELL_GUTTERS;
    if (typeof value !== 'string' || !values.includes(value)) {
      throw new Error(`${where}: ui.shell.${key} must be one of: ${values.join(', ')}.`);
    }
    if (key === 'width') shell.width = value as AppShell['width'];
    else if (key === 'headerWidth') shell.headerWidth = value as AppShell['headerWidth'];
    else shell.gutter = value as AppShell['gutter'];
  }
  if (input.rail !== undefined) {
    if (typeof input.rail !== 'boolean') throw new Error(`${where}: ui.shell.rail must be true or false.`);
    /* The rail is the side menu folded to its icons: beside a top bar
       there is nothing to fold, and a setting that quietly does nothing is
       the one worth refusing. */
    if (input.rail && shell.placement === 'top') {
      throw new Error(
        `${where}: ui.shell.rail folds the side menu to its icons, so it needs the side placement; this shell has placement "top".`,
      );
    }
    shell.rail = input.rail;
  }
  if (input.sidebar !== undefined) shell.sidebar = parseSidebar(input.sidebar, where);
  if (input.new !== undefined) shell.new = parseShellNew(input.new, where);
  return shell;
}

/* The header's New menu. Which view or form each entry names, and whether it
   is one a New can open, is judged where the views are parsed (app.ts). A
   group (`{ label, children }`, a nav group's shape) is a heading over a run
   of entries: parsed flat, each entry carrying its group's heading, so everything after this
   reads one list. */
function parseShellNew(raw: unknown, where: string): AppShellNew[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`${where}: ui.shell.new must be a list of what the New menu makes: [{ view: 'tickets' }, { command: 'raiseTicket' }].`);
  }
  const seen = new Set<string>();
  const headings = new Set<string>();
  const entry = (item: unknown, at: string, group?: string): AppShellNew => {
    if (!isRecord(item)) throw new Error(`${at} must be an object: { view: 'tickets' } or { command: 'raiseTicket' }.`);
    allowKeys(item, ['view', 'command', 'label', 'icon'], at);
    const named = (['view', 'command'] as const).filter((key) => item[key] !== undefined);
    if (named.length !== 1) {
      throw new Error(
        `${at} names ${named.length ? 'both a view and a command' : 'nothing'}; an entry opens one view, or one command's form.`,
      );
    }
    const key = named[0];
    const name = item[key];
    if (typeof name !== 'string' || !name.trim()) throw new Error(`${at}.${key} must be a ${key}'s name.`);
    if (seen.has(`${key}:${name}`))
      throw new Error(`${at} names ${key} "${name}" a second time; each way to make something is listed once.`);
    seen.add(`${key}:${name}`);
    if (item.label !== undefined && (typeof item.label !== 'string' || !item.label.trim())) {
      throw new Error(`${at}.label must be non-blank words.`);
    }
    return {
      ...(key === 'view' ? { view: name } : { command: name }),
      ...(item.label === undefined ? {} : { label: item.label as string }),
      ...(item.icon === undefined ? {} : { icon: parseIcon(item.icon, at) }),
      ...(group === undefined ? {} : { group }),
    } as AppShellNew;
  };
  return raw.flatMap((item, i) => {
    const at = `${where}: ui.shell.new[${i}]`;
    if (!isRecord(item) || item.children === undefined) return [entry(item, at)];
    allowKeys(item, ['label', 'children'], at);
    if (typeof item.label !== 'string' || !item.label.trim())
      throw new Error(`${at} is a group: its label is the heading over its entries, { label: 'Service desk', children: [...] }.`);
    const heading = item.label.trim();
    if (headings.has(heading)) throw new Error(`${at} is a second group headed "${heading}"; put its entries in the first.`);
    headings.add(heading);
    if (!Array.isArray(item.children) || !item.children.length)
      throw new Error(`${at}.children is a non-empty list of what the group makes; a group holds entries, not other groups.`);
    return item.children.map((inner, j) => {
      if (isRecord(inner) && inner.children !== undefined) throw new Error(`${at}.children[${j}] is a group; groups do not nest.`);
      return entry(inner, `${at}.children[${j}]`, heading);
    });
  });
}

function parseSidebar(raw: unknown, where: string): AppSidebar {
  if (!isRecord(raw)) throw new Error(`${where}: "ui.shell.sidebar" must be an object.`);
  allowKeys(raw, ['density', 'footer'], `${where}: ui.shell.sidebar`);
  const sidebar: AppSidebar = {};
  if (raw.density !== undefined) {
    if (raw.density !== 'compact' && raw.density !== 'comfortable') {
      throw new Error(`${where}: ui.shell.sidebar.density must be "compact" or "comfortable".`);
    }
    sidebar.density = raw.density;
  }
  if (raw.footer !== undefined) {
    if (!isRecord(raw.footer)) throw new Error(`${where}: "ui.shell.sidebar.footer" must be an object.`);
    allowKeys(raw.footer, ['title', 'description'], `${where}: ui.shell.sidebar.footer`);
    if (typeof raw.footer.title !== 'string' || !raw.footer.title.trim()) {
      throw new Error(`${where}: ui.shell.sidebar.footer.title must be a non-blank string.`);
    }
    if (raw.footer.description !== undefined && (typeof raw.footer.description !== 'string' || !raw.footer.description.trim())) {
      throw new Error(`${where}: ui.shell.sidebar.footer.description must be a non-blank string when supplied.`);
    }
    sidebar.footer = {
      title: raw.footer.title.trim(),
      ...(raw.footer.description === undefined ? {} : { description: (raw.footer.description as string).trim() }),
    };
  }
  return sidebar;
}

function parseCustomThemes(raw: unknown, where: string): ThemeDefinition[] | undefined {
  if (raw === undefined) return undefined;
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 20))
    throw new Error(`${where}: ui.customThemes must be at most 20 themes.`);
  const specs = (raw as unknown[]).map((spec, index) => [spec, `${where}: ui.customThemes[${index}]`] as [unknown, string]);
  const taken = new Set<string>();
  return specs.map(([spec, at]) => {
    if (!isRecord(spec) || spec.kind !== 'theme') throw new Error(`${at} must be a theme written with defineTheme(...).`);
    // An App's own theme may ship font files: the server reads them from its directory (appFonts.ts).
    const theme = compileAppTheme(spec, at, taken, { faces: true });
    taken.add(theme.id);
    return theme;
  });
}

function parseTheme(raw: unknown, where: string): AppTheme | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: "ui.theme" is not an object.`);
  }
  const theme: AppTheme = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(THEME_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${where}: "ui.theme" ${unknownKey(key, THEME_KEYS, keyHomesOf(key))}.`);
    }
    /* An accent for each ground: the one colour is mixed toward white on the
       dark one, which a brand whose dark accent is its own colour cannot say. */
    if (key === 'accent' && isRecord(value)) {
      allowKeys(value, ['light', 'dark'], `${where}: "ui.theme.accent"`);
      for (const mode of ['light', 'dark'] as const) {
        if (typeof value[mode] !== 'string' || !(value[mode] as string).trim())
          throw new Error(`${where}: "ui.theme.accent" is { light, dark }, a colour for each ground; its "${mode}" is not a colour.`);
      }
      theme.accent = { light: (value.light as string).trim(), dark: (value.dark as string).trim() };
      continue;
    }
    if (key === 'for') {
      theme.for = parseAudiences(value, where);
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      const wants = key === 'radius' ? 'a CSS length like "10px"' : key === 'font' ? 'a CSS font stack' : 'a colour';
      throw new Error(`${where}: "ui.theme.${key}" is not ${wants}.`);
    }
    (theme as Record<string, string>)[key] = value.trim();
  }
  return theme;
}

/** `ui.theme.for`: `{ public, roles }`, each a theme's id; that each is offered, and each role declared, is checked
    where the App's themes and roles are known (parseUi, app.ts). */
function parseAudiences(raw: unknown, where: string): ThemeAudiences {
  const at = `${where}: ui.theme.for`;
  if (!isRecord(raw)) throw new Error(`${at} must be { public, roles }: a theme for signed-out visitors and one per role.`);
  for (const key of Object.keys(raw))
    if (key !== 'public' && key !== 'roles') throw new Error(`${at} has no "${key}". It takes: public, roles.`);
  const id = (value: unknown, path: string) => {
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${where}: ${path} must be a theme's id: a built-in look or one of ui.customThemes.`);
    return value.trim();
  };
  const out: { public?: string; roles?: Record<string, string> } = {};
  if (raw.public !== undefined) out.public = id(raw.public, 'ui.theme.for.public');
  if (raw.roles !== undefined) {
    if (!isRecord(raw.roles)) throw new Error(`${at}.roles must map each role to a theme's id: { rider: 'cadence' }.`);
    out.roles = Object.fromEntries(Object.entries(raw.roles).map(([role, value]) => [role, id(value, `ui.theme.for.roles.${role}`)]));
  }
  if (!out.public && !Object.keys(out.roles ?? {}).length) throw new Error(`${at} names no audience: give it public, roles, or both.`);
  return out;
}

function localeKnown(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag.trim()).length === 1;
  } catch {
    return false;
  }
}

/* As `ui.timezone`'s: `{ column, default }` reads each reader's own tag from their row (appLocale.ts),
   and `default` is the App's, which a string names alone. */
function parseLocale(raw: unknown, where: string): { tag?: string; column?: string } {
  if (isRecord(raw)) {
    allowKeys(raw, ['column', 'default'], `${where}: "ui.locale"`);
    if (typeof raw.column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(raw.column.trim())) {
      throw new Error(`${where} has a "ui.locale" column that is not "resource.column", like "person.locale".`);
    }
    const fallback = raw.default === undefined ? undefined : parseLocale(raw.default, where);
    if (fallback?.column) throw new Error(`${where} has a "ui.locale" default that is not a language tag like "en-AU".`);
    return { column: raw.column.trim(), ...(fallback?.tag ? { tag: fallback.tag } : {}) };
  }
  if (typeof raw !== 'string' || !localeKnown(raw)) {
    throw new Error(`${where} has a "ui.locale" of "${String(raw)}", which is not a language tag like "en-AU".`);
  }
  return { tag: raw.trim() };
}

/* `{ column }` is the second spelling of the same key, not a key of its own:
   a customer in Chicago reads its windows on Chicago's clock while the App's
   writes keep one zone for every reader. */
function parseZone(raw: unknown, where: string): string | AppReaderZone {
  if (isRecord(raw)) {
    allowKeys(raw, ['column', 'default'], `${where}: "ui.timezone"`);
    if (typeof raw.column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(raw.column.trim())) {
      throw new Error(`${where} has a "ui.timezone" column that is not "resource.column", like "desk_setting.timezone".`);
    }
    const fallback = raw.default === undefined ? undefined : parseZone(raw.default, where);
    if (typeof fallback === 'object')
      throw new Error(`${where} has a "ui.timezone" default that is not an IANA zone like "Australia/Sydney".`);
    return { column: raw.column.trim(), ...(fallback === undefined ? {} : { default: fallback }) };
  }
  if (typeof raw !== 'string' || !zoneKnown(raw)) {
    throw new Error(`${where} has a "ui.timezone" of "${String(raw)}", which is not an IANA zone like "Australia/Sydney".`);
  }
  return raw.trim();
}

/** What a signed-out visitor is told about an App's look: its name and the
    look it registered, so the sign-in screen, a landing and a public form are
    drawn in the App's own colours rather than the database browser's. It says
    nothing about the App's content — a look is the one thing a visitor sees
    before the door, and seeing mistri's green where the App's own belongs
    reads as the wrong site. */
export const appLook = (app: { id: string; name: string; ui: AppUi }) => ({
  id: app.id,
  name: app.name,
  ...(app.ui.logo ? { logo: app.ui.logo } : {}),
  /* A theme named for the public is the look every visitor is told, and the reader's own pick does not move it, so a
     public page is one page for everyone (themeResolve.ts); the App's accent, corner and face stay over it. */
  ...(app.ui.theme?.for?.public ? { theme: publicTheme(app.ui.theme) } : app.ui.theme ? { theme: app.ui.theme } : {}),
  ...(app.ui.customThemes ? { customThemes: app.ui.customThemes } : {}),
});

/** The App's theme as a signed-out visitor wears it: `for.public` as its preset, marked as the public's own. */
function publicTheme(theme: AppTheme): AppTheme {
  const { for: audiences, preset, palette, audience: _audience, ...own } = theme;
  return { ...own, preset: audiences!.public!, ...(palette && preset === audiences!.public ? { palette } : {}), audience: 'public' };
}

export { appZone, zoneColumn, readerZone } from './appZone.js';

/** The kinds of picture a logo may be, by the file's own name; the load reads its first bytes too (brandImage.ts). */
const LOGO_FILE = /\.(?:png|jpe?g|webp|gif|svg)$/i;

/**
 * `ui.logo` as the App's own picture: `src`, a file in its directory; `dark`, the one drawn on a dark bar; `mark`, a
 * square one for the tab and a narrow bar. Paths only: a URL is another site's to change, and the load serves the
 * file from the App's own origin.
 */
function parseLogoImage(raw: Record<string, unknown>, where: string): AppLogoImage {
  const out: AppLogoImage = { src: '' };
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'src' && key !== 'dark' && key !== 'mark')
      throw new Error(`${where}: ui.logo has no "${key}". It takes: src, dark, mark (or is an App icon's name).`);
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
      throw new Error(`${where}: ui.logo.${key} must be a path to a picture in the App's directory.`);
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value.trim()))
      throw new Error(`${where}: ui.logo.${key} "${value}" is a URL; a logo is a file in the App's directory, served from its own origin.`);
    if (!LOGO_FILE.test(value.trim())) throw new Error(`${where}: ui.logo.${key} "${value}" is not a PNG, JPEG, WebP, GIF or SVG file.`);
    out[key] = value.trim();
  }
  if (!out.src) throw new Error(`${where}: ui.logo.src is required: the picture the bar draws.`);
  return out;
}
