/**
 * The App model: the internal shape every server and client reader works
 * from (AppDef and its parts) and the enumerations the parsers and the JSON
 * schema share. The helpers every parse location uses are model.ts's, and a
 * list's presentations listPresentations.ts's: the page and list rules read
 * them too, and those rules are not the App's.
 *
 * The parse front in app.ts, with appResourceBlocks.ts, appAuthGrants.ts,
 * appViews.ts, appHome.ts, appPages.ts and appUi.ts, validates the authored
 * object and normalises it into AppDef. The data half speaks the authored
 * nouns — `sources` with their default, and one ResourceDef per declared
 * resource under its logical name, holding its New form, its actions and its
 * captions; list and dashboard views keyed by id, and the nav tree of
 * references to them. Nothing here imports another app module: they all
 * import this one.
 */
import type { SectionWidth } from '@mistriwork/engine/shared/page.js';
import type { FormRule, FormStep } from './formRules.js';
import type { FormStyle } from '@mistriwork/engine/shared/formValues.js';
import type { ThemeDefinition } from '@mistriwork/engine/shared/theme.js';
import type { RecordBrandingSpec } from './branding.js';
import type { TableSizing } from '@mistriwork/engine/shared/tableSizing.js';
import type { AppAction, AppFormCommandReference } from './command.js';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import type { SaidCaptions } from '@mistriwork/engine/shared/appMessages.js';
import { CHART_SHAPES, type AppNoun, type FigureFormat } from '@mistriwork/engine/shared/model.js';
import type { AppListEmpty, AppListPresentation, AppListTab, FilterBar } from '@mistriwork/engine/shared/listPresentations.js';
import type { FunnelStage } from '@mistriwork/engine/shared/funnel.js';
export type { FormScalar, FormCondition, FormRule, FormChildGroup, FormStep, AppFormField } from './formRules.js';
export type {
  AppAction,
  AppUpdateAction,
  AppCommandAction,
  AppCommandReference,
  AppCommandField,
  AppFormCommandReference,
} from './command.js';
import {
  isServedForm,
  type AppDisplayRule,
  type AppFileDef,
  type AppFirstRunStep,
  type AppForm,
  type AppLanding,
  type AppShell,
  type AppTagsDef,
  type LandingFooter,
  type LandingImage,
  type SeriesColor,
  type ServedDashboardView,
  type ServedFormView,
} from '@mistriwork/engine/shared/servedApp.js';
export type {
  AppAvatarPhoto,
  AppDisplayRule,
  AppFileBucket,
  AppFileDef,
  AppFirstRunStep,
  AppForm,
  AppLanding,
  AppShell,
  AppShellNew,
  AppSidebar,
  AppTagsDef,
  FormLines,
  LandingAction,
  LandingActionIntent,
  LandingFooter,
  LandingBadge,
  LandingHero,
  LandingHeroLayout,
  LandingPoint,
  LandingImage,
  LandingItem,
  LandingLink,
  LandingQuestion,
  LandingSearch,
  LandingSection,
  SeriesColor,
} from '@mistriwork/engine/shared/servedApp.js';
export { navViewKeys, PLACEMENTS, viewOrder } from '@mistriwork/engine/shared/servedApp.js';

/**
 * A list view: the rows of one resource — how they read (`show`, `tabs`,
 * `filters`), how they draw (`presentation`), how they open (`open`). Keyed
 * in `AppDef.views` by its id, which is also its address: the client keys a
 * room on the view it was opened from, and the address carries it before
 * the list's question (`/{app}/{id}:{query}`) — how a split beside a plain
 * list over one table is told apart. What a person may do with the rows —
 * the New form, the actions — is the resource's (`ResourceDef`).
 */
export interface AppListView {
  /** The table's id — qualified where the engine qualifies things. */
  table: string;
  /** What the list is called. Absent means the table's own name, humanised. */
  label?: string;
  /** Its address after the App's, when not its key (appAddress.ts). */
  path?: string;
  /** The menu's mark for it, one of the App icons (appIcons.ts). */
  icon?: AppIconName;
  /** With the platform realm, whose context the list serves; its menu group's by default. */
  realm?: AppRealm;
  /** The roles that may open it, beside its table grant (appViewRoles.ts). Absent is everyone's. */
  roles?: string[];
  /**
   * A module: conditions this view always stands on — "is_urgent = true"
   * makes the view "Urgent orders", a destination of its own beside the
   * plain "Work orders". Tabs refine on top of it. Conditions only; the
   * shown columns stay the view's `show`.
   */
  query?: string;
  /** Columns or label paths the list shows, in order. Absent means all of them. */
  show?: string[];
  /** A split's single keys, key → the id of an action of the picked record. */
  keys?: Record<string, string>;
  /** false draws the list without its title. */
  heading?: false;
  presentation?: AppListPresentation;
  /** Copy for an empty base list; tabs and filters retain their ordinary no-matches message. */
  empty?: AppListEmpty;
  /** Filter tabs across the top of the list. Absent means one unfiltered list. */
  tabs?: AppListTab[];
  /**
   * Served, never written: what the menu's count counts where it is not
   * `query`. A list over a saved form's root whose tab shows the drafts keeps
   * them out of every other tab, and out of its count too (savedFormLists.ts).
   */
  countQuery?: string;
  /** The menu's count (ui.shell.counts): true counts this list, false never does; absent, the rule
      decides (shared/menuCounts.ts). */
  count?: boolean;
  /**
   * Columns offered as quick filters above the list, in order. Absent means
   * the client derives them — enum-vocabulary columns and boolean flags.
   * An empty list means none, on purpose.
   */
  filters?: string[];
  /** 'none' hides this list's filter bar; tabs remain visible. 'rail' draws the
      filters as a rail of facets beside the rows instead (a sheet on a phone). Absent: 'bar'. */
  filterBar?: FilterBar;
  /** A text filter's suggestions as the reader types: the distinct values of these columns of the
      list's own resource, under the list's standing query and the reader's grants (SuggestBox.tsx). */
  suggest?: Record<string, string[]>;
  /** Opt in to the raw query editor and Advanced filter action. Hidden by default. */
  advancedFilters?: boolean;
  /** Inline the resource's New form, subject to the ordinary create gates. */
  quickAdd?: true;
  /** The list's own CSV import, or false for none where the resource offers one (appImport.ts). */
  import?: import('./appImportDeclaration.js').AppImportDef | false;
  /** Whether the view carries a Favorites star. Opt-in. */
  favorite?: true;
  /** Numeric columns summed in a footer row over the whole query, not the page. A grid only. */
  totals?: string[];
  /** Row height; 'comfortable' is the default. */
  density?: 'comfortable' | 'compact';
  /** A ⋯ menu at the end of each row with the record's own actions. A grid only. */
  rowActions?: true;
  /** Cells edited in place, and a selection's "Set field…": every shown
      column the reader may write (`true`), or the columns named. A grid only. */
  editable?: true | string[];
  /** How this list's rows open: the full page (default), a drawer over
      the list, or a modal, centred; both glanced and dismissed, the page
      one click away. */
  open?: (typeof OPEN_MODES)[number];
  /** A reference column whose record a row opens instead of the row: a join table's list opens what each row is about. A grid only. */
  opens?: string;
  sizing?: TableSizing;
  /**
   * A queue's or a board's selector: the ids of its resource's actions
   * it offers, in this order. Absent means every one of them. The actions
   * themselves are the resource's (`ResourceDef.actions`).
   */
  actions?: string[];
  /** The orders a reader may choose, in a Sort menu beside the filters: each a label and a sort
      written like the query bar ("price", "price desc", "year desc, mileage"). Absent: no menu. */
  sorts?: Array<{ label: string; sort: string }>;
  /** The order the list reads in when nothing else says one, written like the query bar: a tab's own sort
      wins over it, and the Sort menu over both. Kept out of the bar, as a hand order is. Not beside `order`. */
  sort?: string;
  /**
   * The numeric column holding each row's place: the list reads in it,
   * ascending, wherever nothing else sorts the question, and a reader who
   * may edit it puts rows in place — a drag, Alt+↑/↓, or the row's grip.
   * A grid, a checklist, a queue or cards; a board keeps its own in its
   * presentation.
   */
  order?: string;
}

/**
 * One node of nav, as authored: a reference to a view — with the menu's own
 * word for it when it has one — or a group of nodes. Nav only arranges; the
 * views it names are `AppDef.views`.
 */
export type AppNavNode =
  | { view: string; label?: string; color?: SeriesColor }
  | { label: string; to: import('../../schema/app.js').StaticAppTarget; color?: SeriesColor }
  | {
      group: string;
      label: string;
      icon?: AppIconName;
      realm?: AppRealm;
      placement?: 'footer';
      inline?: true;
      folded?: true;
      children: AppNavNode[];
    };

export const AUTH_PROVIDERS = ['email', 'github', 'google'] as const;
/** An identity provider the deployment's config names (`oidc('workforce')` is `'oidc:workforce'`, `saml('corp')`
    `'saml:corp'`), or `'oidc:*'` / `'saml:*'`: each tenant's own provider of that kind, found by the email's
    domain, in a tenant App. */
type OidcProvider = `oidc:${string}`;
type SamlProvider = `saml:${string}`;
export type AppProvider = (typeof AUTH_PROVIDERS)[number] | OidcProvider | SamlProvider;
/** The name after `oidc:`: a config entry's name, lower-case, never one of the built-in providers'. */
export const OIDC_PROVIDER = /^oidc:([a-z][a-z0-9-]{0,39})$/;
export const TENANT_OIDC = 'oidc:*';
/** The name after `saml:`, as for `oidc:`. One namespace: an oidc and a saml entry never share a name. */
export const SAML_PROVIDER = /^saml:([a-z][a-z0-9-]{0,39})$/;
export const TENANT_SAML = 'saml:*';
/** A provider the config file names, either kind: the name after the colon. */
export const NAMED_PROVIDER = /^(?:oidc|saml):([a-z][a-z0-9-]{0,39})$/;
/** Each tenant's own providers, either kind. */
export const TENANT_PROVIDERS: readonly string[] = [TENANT_OIDC, TENANT_SAML];
export const SIGN_UP_MODES = ['open', 'invite'] as const;
/** Just-in-time sign-up: an account is made at its first sign-in through one of these providers, or with a
    verified email in one of these domains, or both when both are said. */
interface AppJustInTime {
  providers?: AppProvider[];
  domains?: string[];
}
export type AppSignUp = (typeof SIGN_UP_MODES)[number] | AppJustInTime;
/** A role an identity provider's claims give: a claim (a name, or a dotted path into one) and the values that
    mean the role, in `match`. Any listed value of any listed claim gives it. With `provider` (authored
    `claims: { provider: oidc('workforce'), … }`), only a sign-in through that provider reads it; without, any
    of the App's named providers does. */
export interface AppClaimRule {
  provider?: AppProvider;
  match: Record<string, string[]>;
}
/** Row scoping within the role grants: every row, a server-defined row policy, or tenant membership. */
export const ROW_SCOPES = ['all', 'policy', 'tenant'] as const;
export type AppRows = (typeof ROW_SCOPES)[number];

/** Whose context something belongs to in a tenant App with the platform realm
    (`auth.tenancy.platform`): a tenant's own, or the platform realm's, which
    reads across tenants. Absent means the App's own realm, `tenant`. */
const REALMS = ['tenant', 'platform'] as const;
export type AppRealm = (typeof REALMS)[number];
export function parseRealm(value: unknown, at: string): AppRealm {
  if (value !== 'tenant' && value !== 'platform') throw new Error(`${at} has a "realm" of "${String(value)}". Use "tenant" or "platform".`);
  return value;
}
/** Whose rows a tenant App's resource holds (`auth.rows: 'tenant'`): one
    tenant's, every tenant's read-only (`global`), or the platform realm's. */
const RESOURCE_OWNERS = ['tenant', 'global', 'platform'] as const;
type ResourceOwner = (typeof RESOURCE_OWNERS)[number];
/** What a tenant clone copies of a tenant-owned resource (`clone`): its rows
    always (`config`), or only when the clone asks for samples (`sample`). */
export const RESOURCE_CLONES = ['config', 'sample'] as const;
export type ResourceClone = (typeof RESOURCE_CLONES)[number];
/** `auth.tenancy`: what a tenant is called, the platform's table of tenants,
    and the platform realm. */
export interface AppTenancy {
  /** What one tenant is called in the UI ("Dealer"). Default "Tenant". */
  label?: string;
  /** The platform-owned resource with one row per tenant: the one platform
      resource a tenant row may reference, and only by its ownership column. */
  profile?: string;
  /** Declares the platform realm; its label names the platform context ("Lender"). `me` is who the word is there,
      as `auth.me` says it in a tenant's: a row of the platform's table of its staff, by the column holding their
      account id. Absent, `me` in the platform realm is nobody's row. */
  platform?: { label: string; me?: { from: string; column: string } };
}

/** How people sign in: what the auth runtime captures at startup, so changing it needs a restart. */
export interface AppSignIn {
  /** How people sign in: email + password, and the social providers whose
      client id and secret the environment holds. Default: email. */
  providers: AppProvider[];
  /** `invite`: an admin creates accounts; `open`: anyone may sign up; `{ providers, domains }`: an account
      is made at its first sign-in through an identity provider, within those. Default: invite. */
  signUp: AppSignUp;
  /** The SQLite file sessions and accounts live in. Default: the mistri
      config directory, named for the app — never the app's own database and
      never the app directory, which is committed. */
  store?: string;
  /** The role a new account gets. Default: user. */
  defaultRole: string;
}

/**
 * `auth`: sign-in, and who may do what once signed in. Its grants are made
 * within the resource ceilings (`ResourceDef.access` and `fields`): one
 * ceiling model, with or without sign-in.
 */
export interface AppAuth extends AppSignIn {
  /** Row scoping within the grants. Default: all. */
  rows: AppRows;
  /** Default-deny grants within the resource ceilings, by role. Absent: a
      signed-in App with no grants, which scopes nothing. */
  roles?: Record<string, AppRoleGrant>;
  /** What a signed-out visitor reads (`auth.public`): these resources, read-only,
      narrowed by `fields`. Absent: a signed-out visitor opens only the landing
      and public forms. */
  public?: AppPublicGrant;
  /** The human check every public door asks first (`auth.challenge`): a verifier the commands module's `challenges`
      names (commands/challenges.ts). Absent: the doors rely on their ticket, honeypot and budgets. */
  challenge?: string;
  /** Tenancy (`auth.rows: 'tenant'`): what a tenant is called, its profile, and
      the platform realm. Absent: tenants only, no platform realm. */
  tenancy?: AppTenancy;
  /** Who `me` is as a row (appMe.ts): the table people are rows of, and its
      column holding their sign-in email — in a tenant App, their account's id, one row per membership.
      Absent, `me` is the email alone. */
  me?: { from: string; column: string; create?: { name?: string } };
}

/** A signed-out visitor's reads: every resource named, never `true`, and nothing written. */
export interface AppPublicGrant {
  read: string[];
  /** A narrowing of the column ceiling for signed-out visitors; reads only. */
  fields?: Record<string, AppFieldAccess>;
}

export interface AppRoleGrant {
  /** The role's name as people read it, wherever a screen names the role (accounts, grants, invitations); the id otherwise. */
  label?: string;
  /** The role whose grants it holds too. Its grants below already include them (appAuthGrants.ts inheritedGrants); the
      name says where they came from. */
  extends?: string;
  flags?: readonly import('./appFlagCapabilities.js').FlagCapability[];
  experiments?: readonly import('./appFlagCapabilities.js').ExperimentCapability[];
  /** true grants the App's ceiling, never every database resource. */
  read: boolean | string[];
  write: boolean | string[];
  /** Of what it writes, what the role makes new rows in: absent, all of it;
      false, none (it edits and never creates); a list, those. */
  create?: false | string[];
  /** Tables the role may export (a CSV/JSON file of every matching row) beyond those it writes, which it may always
      export. Of what it reads. Absent: only what it writes. */
  export?: string[];
  /** Explicit server command IDs only. Absent denies; never grants generic CRUD. */
  commands?: string[];
  /** Fixed actions this role may run on a resource it reads and does not
      write, by id (`{ pay_run: ['submit'] }`). The action's own
      `set`, `when` and reason are the whole of the write; never generic CRUD. */
  actions?: Record<string, string[]>;
  /** Operator reads this role may make: readiness, the support bundle and/or the durable workflows room. Absent denies. */
  operations?: OperationsGrantAction[];
  /** A narrowing of the column ceiling for this role. */
  fields?: Record<string, AppRoleFieldAccess>;
  /** With the platform realm, whose context the role holds: a tenant's or the
      platform's. Required on every role then; roles of the two realms never
      combine. A platform role edits only the platform's own writable rows
      (appTenancy.ts) and changes a tenant's through commands. */
  realm?: AppRealm;
  /** Authored as `operations: ['support']` on a tenant role: it may read its own dealer's support sessions: who
      entered, why, when, how it ended, and the field changes this role's own
      grants already let it read. Never the operator's email, the native
      session, a version or a MAC. Declared, never defaulted. */
  supportLog?: true;
  /** Authored as `operations: ['support']` on a platform role: it may read every dealer's support sessions, the one
      view where the operator's email appears. Declared, never defaulted. */
  supportAudit?: true;
  /** The identity provider's claims that give this role, re-read at every sign-in through an `oidc:` provider
      (auth/identityRoles.ts). A role with it is the provider's to give and take away. */
  claims?: AppClaimRule;
  /** A role only a service principal holds — a jobs module's principal, an App API token — never a person: a
      free-form page is offered to it only where the page names it, and it is never the default role or a
      claim's. Declared, never inferred: the jobs module is read after the App. */
  service?: true;
}

export interface AppFieldAccess {
  /** Local column names, not reference paths. Complete primary keys stay readable. */
  read: string[];
  write?: string[];
}
/** A role's narrowing: `read` absent is the resource's own read ceiling, so the role narrows only `write`. */
export type AppRoleFieldAccess = Omit<AppFieldAccess, 'read'> & { read?: string[] };

export const OPERATIONS_GRANT_ACTIONS = ['readiness', 'support', 'workflows', 'jobs', 'deliveries', 'stores', 'analytics'] as const;
export type OperationsGrantAction = (typeof OPERATIONS_GRANT_ACTIONS)[number];

/** The sign-in half of `auth`, without its grants: what the auth runtime
    captures, and so what a reload may not change. Comparisons normalise
    both sides with it, so a runtime's captured settings and the App's
    `auth` are judged on the same four facts. */
export function signInOf(auth: AppSignIn): AppSignIn;
export function signInOf(auth: AppSignIn | undefined): AppSignIn | undefined;
export function signInOf(auth: AppSignIn | undefined): AppSignIn | undefined {
  if (!auth) return undefined;
  return {
    providers: auth.providers,
    signUp: auth.signUp,
    ...(auth.store === undefined ? {} : { store: auth.store }),
    defaultRole: auth.defaultRole,
  };
}

/**
 * A command form view: one form running one command that creates records,
 * keyed in `views` like every view. With steps, every command input
 * belongs to exactly one; without, the form is one page. Presentation only
 * — the handler, registered through `--commands`, owns validation and
 * every write.
 *
 * Signed in unless `public` is set: a room of the App, run through the
 * signed-in grant and served only to a role granted its command. Public: a
 * page at `/{app}/form/{key}` for anyone, run as one public command under
 * a public principal, even for someone signed in.
 */
export interface AppFormView<Field extends string = string> extends ServedFormView {
  /** The form's heading. */
  label: string;
  /** A signed-in form's address after the App's, when not its key. */
  path?: string;
  /** The menu's mark for a signed-in form; a public form is in no menu. */
  icon?: AppIconName;
  /** With the platform realm, whose context the signed-in form serves. */
  realm?: AppRealm;
  /** A signed-in form's: the roles that may open it, beside its command grant (appViewRoles.ts). */
  roles?: string[];
  /** Shown under the heading. */
  description?: string;
  /** The command the form runs: on a form saved each step (`save`), the final submit. */
  command: AppFormCommandReference;
  /** On a saved form, each step runs its own command and asks that command's inputs. */
  steps?: Array<FormStep<Field> & { command?: AppFormCommandReference }>;
  submitLabel?: string;
  /** How the steps are drawn: the stepper (default) or the intake style (a progress bar, one question at a time, a
      sticky bar of actions and an editable review). */
  style?: FormStyle;
  /** Intake: a quiet line over the progress bar. */
  note?: { icon?: AppIconName; text: string };
  /** Intake: whether the last page reviews every answer. Present only as `false`; absent, an intake form reviews. */
  review?: false;
  /** The screen after the receipt, beside the reference the handler returned when it returned one. */
  done?: { title?: string; description?: string };
  public?: true;
  /** The inputs a link's address may start filled (`?stock_ref=FC-1049`): shown, editable, checked like anything typed. */
  prefillable?: string[];
  /** Command input → the App's own input component, drawn in place of the platform's control. Never on a public form. */
  inputs?: Record<string, import('@mistriwork/engine/shared/appComponents.js').ComponentDecl>;
  /** Saved on every step into the App's real tables (appSavedForms.ts): a public form only. */
  save?: import('./appSavedForms.js').AppFormSave;
  /** A saved form's status check: a receipt confirmed by what only the applicant knows, answering a state. */
  statusCheck?: import('./appSavedForms.js').AppStatusCheck;
  /** Linking a submitted application to an account on proven control (appSavedForms.ts, forms/formLink.ts). */
  link?: import('./appSavedForms.js').AppFormLink;
}

/** A form view as served, carrying its reason when its reference inputs do not fit this catalog. */
export type ResolvedFormView = AppFormView & { error?: string };

/** Whether a view is a command form: the one kind of view that runs a command. */
export const isFormView: (view: object) => view is AppFormView = isServedForm as (view: object) => view is AppFormView;

/** Whether a view is a public form: a form that says so, and nothing else. */
export const isPublicForm = (view: object | undefined): view is AppFormView & { public: true } =>
  view !== undefined && isFormView(view) && view.public === true;

/** Whether a view is a public free-form page that runs public commands: a door a signed-out visitor submits through, as a
    public form is one (http/pageCommandRoutes.ts). */
export const isPublicCommandPage = (view: object | undefined): view is { page: { public: true; commands: readonly string[] } } => {
  const page = (view as { page?: { public?: unknown; commands?: unknown } } | undefined)?.page;
  return page?.public === true && Array.isArray(page.commands) && page.commands.length > 0;
};

export const LANDING_SECTION_KINDS = ['features', 'steps', 'faq', 'text', 'callToAction', 'contact', 'view', 'search'] as const;
export const LANDING_ACTION_INTENTS = ['primary', 'secondary'] as const;
export const LANDING_HERO_LAYOUTS = ['split', 'overlay'] as const;
/** Every ceiling the landing parser holds a string or a list to, in one place. */
export const LANDING_LIMITS = {
  title: 120,
  heading: 120,
  text: 600,
  prose: 2000,
  label: 60,
  question: 200,
  answer: 1200,
  href: 2048,
  actions: 3,
  sections: 12,
  items: 6,
  questions: 12,
  links: 8,
  shown: 12,
  filters: 6,
  highlights: 4,
  highlight: 60,
  alt: 200,
  badge: 40,
  tiles: 4,
  points: 4,
} as const;

/**
 * The app's look, as overrides of the design tokens the UI already runs
 * on — a whitelist, not a stylesheet: an app may say what its accent is,
 * how round its corners are, and what face its data wears; it may not
 * supply a registered preset for broader visual roles. The legacy tokens
 * remain supported without requiring a full definition. The soft tint is
 * derived from `accent`, so one colour — or one for each ground,
 * `{ light, dark }` — is a complete theme.
 * `font` is the *data* face and the reader's typography preference
 * still wins over it — a brand is not a reason to overrule someone's eyes.
 */
export interface AppTheme {
  preset?: string;
  palette?: string;
  accent?: import('@mistriwork/engine/shared/themePresets.js').AppAccent;
  /** Corner radius for the whole UI, a CSS length: "0", "10px". */
  radius?: string;
  /** The data face, a CSS font stack. Code surfaces keep the code face. */
  font?: string;
  /** A theme per audience (themeResolve.ts): `public` for a signed-out visitor's pages, and one per role. */
  for?: import('@mistriwork/engine/shared/themeResolve.js').ThemeAudiences;
  /** Never authored: the server marks the look it tells a signed-out visitor (appLook), which the reader's pick does
      not move, so a public page is the same for everyone. */
  audience?: 'public';
}

export const THEME_KEYS = ['preset', 'palette', 'accent', 'radius', 'font', 'for'] as const;

/**
 * One section of a dashboard: a rootless metric, breakdown or rows of a table, narrowed by a
 * query, laid out with the page sections' widths. What a page composes
 * about one record, a dashboard composes about the whole table.
 */
/** A metric's goal read from data: a measure over a table and a query, the metric's own three words.
    Resolved: `table` is the table id (the metric's when unwritten), `measure` the metric's when unwritten. */
export interface DashTarget {
  table: string;
  query?: string;
  measure: string;
  /** A breakdown's: the target table's column whose value matches each group's key (G76). */
  by?: string;
  /** A breakdown's: the target table's date column the reader's window narrows, as the section's `over`. */
  over?: string;
  /** A whole (`targetWhole`): the goal's query without the author's own window phrase, so the reader's window replaces
      it as it does the metric's (dashboardAsks.ts, windowed). */
  windowBase?: string;
}

export interface AppDashSection {
  sizing?: TableSizing;
  /** A rows section's guidance when it has no row: what belongs there, and where to start. */
  empty?: AppListEmpty;
  /** Authored `empty: 'hide'` (a metric takes none): the section is left out of the dashboard while it has nothing. */
  emptyMode?: 'hide';
  kind:
    | 'metric'
    | 'breakdown'
    | 'rows'
    | 'chart'
    | 'note'
    | 'matrix'
    | 'funnel'
    | 'board'
    | 'firstRun'
    | 'custom'
    | 'activity'
    | 'find'
    | 'branding'
    | 'integrations';
  /** find: the resources one box searches by their records' names (config `resources`), served as table ids. */
  searched?: string[];
  /** find: the box's words before anything is typed. */
  placeholder?: string;
  /** activity: the resources whose record history the feed reads, each with its mark and, where the
      resource's noun is not what the feed should call it, its word. Each keeps a history, as a page's
      `history()` makes its resource keep one. */
  resources?: Record<string, AppActivityResource>;
  /** custom: the author's component (appComponents.ts). */
  component?: import('@mistriwork/engine/shared/appComponents.js').ComponentDecl;
  /** custom: its named reads of rows (config `rows`), each a rows section's words. */
  reads?: Record<string, import('@mistriwork/engine/shared/appComponents.js').DashCustomRead>;
  /** custom: its named aggregate reads (config `totals`), each a metric or breakdown in all but drawing. */
  aggregates?: Record<string, import('@mistriwork/engine/shared/appComponents.js').DashCustomTotal>;
  /** custom: its props, checked against the declaration, defaults filled. */
  props?: Record<string, unknown>;
  title?: string;
  /** firstRun: what a new App asks of its first reader, in order — each a list view to add the first
      record to. Served with each view's table, which says whether the step is done (it has a row). */
  steps?: AppFirstRunStep[];
  /** Every kind but a note is about a table. */
  table?: string;
  /** note: the words. Plain text; blank lines separate paragraphs. */
  text?: string;
  /** A curated mark: above a note's guidance, or in any other section's
      heading row, beside its title (a metric's label, a chart's, a list's). */
  icon?: AppIconName;
  /** note: one link to an already-served list or dashboard. */
  action?: import('@mistriwork/engine/shared/appLinks.js').AppLinkAction;
  /** note: 'banner', the dashboard's introduction, dressed by the look's `banner` recipe. */
  variant?: 'banner';
  /** note, a banner: its short tag over the title. */
  eyebrow?: string;
  /** note, a banner: its picture, one row of a file resource. */
  image?: LandingImage;
  /** The query language, without the leading table name. */
  query?: string;
  /** metric: the breakdown grammar's words — "count", "sum amount as pipeline". */
  measure?: string;
  /** metric: a second query for the same measure; the card shows the delta. Unsaid with an `over`, the period before
      the window (app.ts, `followsClock`). */
  compare?: string;
  /** metric: which way is good news, so the delta can say so — a fall in
      "won" is bad, a fall in "overdue" is good, and the card cannot know
      without being told. Absent means the delta stays neutral. */
  better?: 'up' | 'down';
  /** metric: draw the measure's last twelve months inside the card while no window stands. Needs `over`. A windowed
      metric draws its trend across the window unless this is false (dashboardTrend.ts, sparkText). */
  spark?: boolean;
  /** metric, breakdown, chart and matrix: how its figures are said where the measure is not one column's (a computed
      or averaged one has no display rule): percent — the figure is 0–100, said with % — number, money in the
      App's currency, or duration — the figure is seconds, said as "10h 2m". */
  format?: FigureFormat;
  /** metric, breakdown, chart and matrix: a word said after each figure ("days", "/mo"). */
  unit?: string;
  /** metric and chart: a goal — a meter and the share reached on a card, a
      rule in the ink on a line or stacked bars. Never on a donut, which has
      no scale to rule. A metric's goal may be read from data: a second
      measure, said in the metric's own words (DashTarget). */
  target?: number | DashTarget;
  /** A metric whose data `target` counts the same measure over the same table with no more conditions: the target is
      the whole this figure is a share of, said "118 of 159 (74%)" rather than as a goal (resolveDashboard). */
  targetWhole?: true;
  /** breakdown/chart: what to group by — "status", "month opened_on". A chart may say "auto created_at": the unit then
      follows the window and the data (autoBucket.ts). */
  by?: string;
  /** funnel: the stages a row passes in order, 2 to 8 (funnel.ts). */
  stages?: FunnelStage[];
  /** board: ordered subset of exact lane values (1..8). Omit to discover lanes. */
  lanes?: string[];
  /** chart: how it draws. A line wants a bucketed by; bars, a bucketed by or
      categories, one series with the current bar marked; a donut, categories;
      stacked bars, a two-key by — a bar per group of the first, divided by the second.
      scatter: a dot per group of a one-key by, placed by `x` across and `measure` up; heatmap: a two-key by
      as a grid of cells shaded by the measure; waterfall: a one-key by's values as rises and falls from zero to
      a total; treemap: a one-key by's groups as tiles sized by the measure.
      breakdown: "bars" (the default), or "steps": a card per value of the column, in its order, joined by arrows. */
  shape?: 'line' | 'bar' | 'donut' | 'stacked' | 'scatter' | 'heatmap' | 'waterfall' | 'treemap' | 'bars' | 'steps';
  /** chart, a scatter: the measure that places each dot across, in the breakdown grammar's words ("count"). */
  x?: string;
  /** breakdown, steps: a line under a step, by the value it counts. */
  notes?: Record<string, string>;
  /** chart, a line: "smooth" draws a monotone curve through the points (it never overshoots one). */
  curve?: 'smooth' | 'straight';
  /** chart, a donut: what the figure in its middle counts — "Total visitors" — said under it. */
  total?: string;
  /** chart: the drawing's height in CSS pixels (120 or more). Absent means
      a third of the width, capped — a sparse series on a wide screen is
      better short. */
  height?: number;
  /** The date column the dashboard's time window narrows this section by.
      Absent means the window passes this section over. */
  over?: string;
  /** The section's own windows, in the query grammar's words: the reader picks this section's period in
      its heading, apart from the dashboard's, and the first is where it starts. Needs `over`. */
  windows?: string[];
  /** Served, never authored: the section's name in the address when it has its own windows —
      `?period.lines-moved-by-day=last-7-days` — the slug of its title, one per dashboard. */
  windowKey?: string;
  /** An embed: the list works as its room does — its search, its filters and, for a reader offered one,
      its selection and bulk actions — rather than drawing read-only. */
  interactive?: true;
  /**
   * Served, never authored: the query with its own `over = last N …` phrase
   * removed, for the reader's window to stand in its place. A reader picking
   * "last 12 months" on a metric authored `close_date = last 90 days` means
   * twelve months, not the ninety days the two windows have in common.
   */
  windowBase?: string;
  /**
   * Served, never authored: the compare was derived from "previous period",
   * so the client may re-derive it against the reader's window — `last 30
   * days` picked means `previous 30 days` compared — instead of comparing the
   * reader's window with the author's.
   */
  comparePeriod?: boolean;
  /** rows: columns, label paths welcome. */
  show?: string[];
  /** rows: column path → the app's word for it, for the show entries that
      carried a label. Served beside `show`, which stays the bare paths the
      query is built from. */
  labels?: Record<string, string>;
  /** rows: query-bar text. */
  sort?: string;
  limit?: number;
  width?: SectionWidth;
  /** The area of the dashboard's `layout` this section stands in. Absent without a layout; every section names one with it. */
  area?: string;
  /** An embed (`{ kind: 'view' }`): the key of the list view this section
      draws, whose room its "open →" opens. A metric: the key of the list view
      over its own table that the card opens, narrowed by the metric's query. A breakdown, chart, matrix or funnel: the list its
      groups (a funnel's stages) open (`to`); absent, the one list over its table that the reader is served. Absent on every other section. */
  view?: string;
  /** A metric, breakdown, chart, matrix or funnel whose authored `to` is false: its card or its groups are text, not doorways. */
  noDrill?: true;
}

/** A view that is a screen, not a table: a named set of sections, keyed in
    `AppDef.views` by its view key. Its address is `dash-<key>`, the page
    token it rides. The payload serves the same shape resolved against a
    catalog (resolveViews): sections with resolved table ids, or a reason. */
export interface AppDashboardView extends ServedDashboardView {
  label: string;
  /** Its address after the App's, when not its key. */
  path?: string;
  /** The words over the sections, when not its label (which the menu and the tab keep): "Hello, {me.name}".
      `{me.name}` is the signed-in reader's name, said by the server (appGreeting.ts). */
  heading?: string;
  /** `heading: false`: the title is not drawn, and stays for a screen reader. */
  headingHidden?: true;
  /** A short plain-text introduction shown under the dashboard heading; it may greet `{me.name}` too. */
  description?: string;
  /** The menu's mark for it, one of the App icons (appIcons.ts). */
  icon?: AppIconName;
  /** With the platform realm, whose context the dashboard serves; its menu group's by default. */
  realm?: AppRealm;
  /** The roles that may open it (a room's too), beside its tables' grants (appViewRoles.ts). */
  roles?: string[];
  sections: AppDashSection[];
  /** An independent right-hand flow on wide screens; stacks below the main flow when narrow. */
  aside?: AppDashSection[];
  /** The sections placed on a grid: one string per row, each the same 1 to 4 space-separated cells, a cell an area's
      name (a section's `area`) or `.` for none. An area covering cells in two rows spans them; sections in one area stack
      in source order. Never with an `aside`. */
  areas?: string[];
  /** The time windows offered when any section declares `over`, in the
      query grammar's own words. Default: last 30 days / 90 days / 12 months,
      served filled in whenever any section has `over`, so the client never
      re-declares the default list. */
  windows?: string[];
  /** The window the dashboard opens on, one of `windows`; unsaid, it opens on all time. An address's `?period=` wins. */
  window?: string;
  /** How the window is picked: "segmented", a button per window (the default), or "button", one date-range button —
      the calendar, the dates the window covers, a menu of the windows — where the control row is tight. */
  windowControl?: 'segmented' | 'button';
  /**
   * Pick-filters: column names offered as selectors in the control row.
   * A pick narrows every section whose table has the column — a
   * vocabulary column becomes its values, a whole single-column
   * reference becomes the records it points at, said by name.
   */
  filters?: string[];
  /** Whether the view carries a Favorites star. Opt-in. */
  favorite?: true;
  /**
   * A free-form page (`definePage` in `pages/*.page.tsx`): the one custom
   * section drawing the whole page, the resources it reads — a reader who
   * cannot read one is not served the page — the commands it runs, the
   * address parameters it keeps its place in and the loader that reads for
   * it on the server.
   */
  page?: AppPageManifest;
  /** Served, never authored: the first problem, for the screen; `errors` has all of them. */
  error?: string;
  errors?: string[];
}

/** What a free-form page declares it reads, runs, keeps in its address and loads: its manifest, held to on both sides. */
interface AppPageManifest {
  reads: string[];
  commands: string[];
  params: string[];
  loader?: string;
  public?: true;
}

/** One resource an activity section reads: its mark, and its word in the feed where not its noun. */
export interface AppActivityResource {
  icon?: AppIconName;
  label?: string;
}

export const DISPLAY_FORMATS = [
  'money',
  'percent',
  'number',
  'relative',
  'items',
  'duration',
  'email',
  'phone',
  'url',
  'richText',
  'avatars',
  'rating',
  'color',
  'time',
  'month',
  'year',
  'json',
  'qr',
] as const;

/** The roles an App names for people (`auth.roles.<id>.label`), for the sign-in answer: absent where none is labeled. */
export function roleLabelsOf(auth: { roles?: Record<string, { label?: string }> } | undefined): { roleLabels?: Record<string, string> } {
  const labeled = Object.entries(auth?.roles ?? {}).flatMap(([role, grant]) =>
    typeof grant?.label === 'string' ? [[role, grant.label] as const] : [],
  );
  return labeled.length ? { roleLabels: Object.fromEntries(labeled) } : {};
}

/** Whether the App names roles at all: a refusal says "your role" only where one could be the reason. */
export function keepsRoles(auth: { roles?: Record<string, unknown> } | undefined): { hasRoles?: true } {
  return Object.keys(auth?.roles ?? {}).length ? { hasRoles: true } : {};
}

/**
 * What an App's source says that the platform would say without it, found
 * where the raw root is still in hand (the parsed App cannot tell a stated
 * default from an implied one). Read by `check` (appWarnings.ts).
 */
const restatements = new WeakMap<object, readonly string[]>();
export const noteRestated = (app: object, notes: readonly string[]): void => {
  if (notes.length) restatements.set(app, notes);
};
export const restatedOf = (app: object): readonly string[] => restatements.get(app) ?? [];

export interface AppSourceBinding {
  /** A server-configured connection ID or name, never a connection URL. */
  connection: string;
  /** The source whose resources stay bare. Beside others, at most one says
      so, and none has to; a source that stands alone is it unless it says
      `default: false`, which keeps its `source.name` names as others go. */
  default: boolean;
  /** `'platform'`: a platform-only source, read by a tenant App's platform
      realm alone, never the default and never written (appTenancy.ts). */
  realm?: 'platform';
  /** The one engine schema (a PostgreSQL schema) this source
      sees of its connection. Several sources may share a connection this way;
      each sees its own schema's tables and nothing else. */
  schema?: string;
  /** The tables this source brings into the App without a block each:
      `'all'`, or their local names. Each is an implicit `{}` block, which
      grants nothing a block would not. */
  resources?: 'all' | readonly string[];
}

/**
 * One logical resource, as its block declares it: where its rows live and
 * what the App says about its values. Keyed in `AppDef.resources` by the
 * logical name — bare for the default source (or the single connection),
 * `source.name` for a secondary source — exactly as authored.
 */
/**
 * A resource searched through a search provider (server/app/searchProvider.ts):
 * the columns the index holds, and the provider's connection by its name. The
 * index answers keys; rows are always re-read under the reader's own grants.
 */
export interface AppSearchDef {
  connection: string;
  fields: string[];
}

/**
 * What the durable support write trail keeps of a resource's rows. Under a
 * support session ("enter as dealer") every Save, New, Delete, Undo and
 * command appends one audit entry in the business write's own transaction; a
 * column named here is recorded as a keyed hash instead of its value, in the
 * change and in a delete's before image alike, and every other column keeps
 * its value. `'values'` marks every column of the resource.
 */
export interface AppAuditDef {
  redact: 'values' | string[];
}

export interface ResourceDef {
  /** The physical table in its source's catalog, when the name alone does not find it. */
  physical?: string;
  /** The named source the resource lives in; absent for an App without `sources`. */
  source?: string;
  /** The App's ceiling for this resource. A declared resource reads; `'write'`
      is the one that is written. With role grants, roles grant within it. An
      App serves nothing it does not declare. */
  access?: 'write';
  /** In a tenant App (`auth.rows: 'tenant'`), whose rows these are: one
      tenant's, every tenant's read-only, or the platform realm's. Required on
      every resource there; refused anywhere else. */
  owner?: ResourceOwner;
  /** In a tenant App, what a clone of a tenant into a sandbox copies of this
      tenant-owned resource: `config` rows always, `sample` rows only when the
      clone asks for samples. Unmarked, nothing (tenantClone.ts). */
  clone?: ResourceClone;
  /** `false`: on an App with `live: true`, a write to this resource's table is not announced and no page follows
      it (a hot or log-like table); its pages refresh on focus and after their own saves. Absent: the App's choice. */
  live?: false;
  /** Whether the App deletes this resource's records. Opt-in: absent, the
      server refuses a delete and no Delete is drawn (appDeletable). */
  delete?: true;
  /** Whether the resource's records carry a Favorites star. Opt-in. */
  favorite?: true;
  /** A settings record: the resource's one row, opened from the reader's
      settings (the account menu) under these words. */
  settings?: string;
  /** What one record is called and several: the New button, a split's detail heading, a page's
      label and a list's when they say none. Absent, the table's own name. */
  noun?: AppNoun;
  /** The column ceiling within `access`. Complete primary keys stay readable. */
  fields?: AppFieldAccess;
  /** Columns no reader of the App is ever served, signed in or not: cut from the catalog
      the server answers with, so every read path refuses them as columns that are not
      there. Intersects every role's field grant; never the primary key. */
  hidden?: string[];
  /** Soft keys: column → the resource it names and the column it is looked up by (absent: the target's
      primary key). Joined like a foreign key within one connection (declaredReferences.ts), read in two steps into
      another (appStitchedReads.ts); never authority for a write. */
  references?: Record<string, { to: string; column?: string }>;
  /** Column → how its values dress, everywhere they appear. */
  display?: Record<string, AppDisplayRule>;
  /** Column → the kind of value a TEXT column holds, where its declared type cannot say: `{ due_on: 'date' }`
      for ISO dates, so windows, timelines, calendars, date presets and date filters take it. SQLite only; the
      served catalog says the column is a date, and the database still holds text (declaredDates). */
  types?: Record<string, DeclaredDateKind>;
  /** Column → the App's own input component, drawn in its edit and New forms in place of the platform's control. */
  inputs?: Record<string, import('@mistriwork/engine/shared/appComponents.js').ComponentDecl>;
  /** Resource invariants, whichever form, action or command submits the write.
      Runtime activation requires authoritative writer enforcement. */
  validation?: FormRule[];
  /** Column → how long its text may be and what form it takes (textRules.ts): judged as the form is typed and on
      every write, over what the database already says (`ColumnMeta.text`). */
  text?: Record<string, import('@mistriwork/engine/shared/textRules.js').TextRule>;
  /** JSON column → the resource whose rows define its fields (definedFields.ts): drawn, edited, filtered and judged as fields. */
  defined?: Record<string, import('@mistriwork/engine/shared/definedFields.js').DefinedBinding>;
  /** Flows whose steps are rows (appFlows.ts): the tables they are kept in, and what their steps may do to a record. */
  flows?: import('./appFlows.js').FlowBinding;
  /** Column or label path → the App's caption for it, wherever the column is shown. */
  labels?: Record<string, string>;
  /** The path that names one record. Unlike a caption, it may follow a reference.
      `false` is an internal restricted-catalog sentinel; authors can only write a string. */
  recordLabel?: string | false;
  /**
   * The curated "New" form: which columns to ask for (the rest are left to
   * the database or to `defaults`), and values filled in before anyone
   * types. Absent means the form the schema writes — every column.
   */
  form?: AppForm;
  /**
   * Buttons on this resource's record page: an update the App has decided
   * in advance ("Mark working" sets `status` to `working`), or a server
   * command. Shown only when `when` matches the record, confirmed first
   * when `confirm` says so. A fixed update goes through the same route,
   * gate and row lock as any edit, so it is scoped like one.
   * Keyed by id where authored and served in that order, each carrying its
   * `id`: a header, a queue and a role name an action by it. Absent when the
   * resource declares none.
   */
  actions?: AppAction[];
  /** The rows are files (appFileRules): the bytes, the name, and where an upload's type and size go. */
  file?: AppFileDef;
  /** Rows from a CSV file (appImport.ts): new records through the ordinary insert, or one command per row. */
  import?: import('./appImportDeclaration.js').AppImportDef;
  /** The records carry tags, rows of `to` linked through `through` (appTagRules). */
  tags?: AppTagsDef;
  /** Search through a search provider's connection: the columns the index holds. */
  search?: AppSearchDef;
  /** The record's states and verbs (appMachine.ts): its column moves only along the graph, on every door, and its
      verbs lead the resource's `actions`. */
  machine?: import('./appMachine.js').AppMachineDef;
  /** Timers at an instant a column holds (appAt.ts): a command run through the jobs once its time has come and `when` holds. */
  at?: import('./appAt.js').AppAtTimer[];
  /** The page this resource's records open through when two pages share its
      base. The loader also orders that page first among its base's pages
      (orderAppPages), for the readers that take the first. */
  page?: string;
  /** The list view its records are addressed through (appAddress.ts). */
  view?: string;
  /** The natural key column its records are addressed by, instead of the primary key. */
  address?: string;
  /** A slug after a numeric id on public pages. */
  slug?: true;
  /** What the support write trail keeps of these rows: which columns are
      recorded as a keyed hash rather than their value. */
  audit?: AppAuditDef;
  /** Numbers about the rows that point at each record, read like columns
      (appRollups.ts): `line_total` → the sum of its lines' amounts. */
  rollups?: Record<string, AppRollup>;
  /** Virtual columns, each a typed expression over the record's own columns, read like columns and never
      written (computed.ts, appComputed.ts): `is_overdue` → `due_on < today and not completed`. */
  computed?: Record<string, AppComputed>;
  /** Which writes tell which people, kept in each person's inbox (appNotify.ts). */
  notify?: import('./appNotify.js').AppNotifyRule[];
  /** Named queries over the resource's rows (appSegments.ts): a tab, a metric, a related list or a rollup names
      one, and the query language reads one as a word (`overdue and mine`). */
  segments?: Record<string, AppSegment>;
  /** The parent balances a row of this resource uses up (appConsumes.ts): a write of the row moves them in its
      own transaction, and refuses one that would take a balance below zero. */
  consumes?: AppConsumes[];
  /** The parent balances a row of this resource adds to (a receipt's line, a return): `consumes` the other way round. */
  restocks?: AppConsumes[];
}

/** A segment as authored: its conditions in the query language, and what a tab over it is called. */
export interface AppSegment {
  query: string;
  /** Its caption: the authored `label`, else its key said as words (`on_bench` → "On bench"). */
  label: string;
}

/**
 * One `consumes` rule, on the line that uses the stock: `column` is one reference of the line and a number
 * column of the record it names (`part_id.on_hand`); `by` a number column of the line, or one per line where
 * absent. `message` is what a refused write says, its `{placeholders}` read from the parent as it stands.
 */
export interface AppConsumes {
  /** The line's reference column (`part_id`). */
  reference: string;
  /** The parent's balance column (`on_hand`). */
  balance: string;
  by?: string;
  message?: string;
  /** false: the balance may go below zero (a backorder). */
  floor?: false;
}

/**
 * A rollup as authored: `count('task', { whose: 'account_id', query: 'status = open' })`,
 * `sum('order_line', 'amount')`. `from` is a resource whose rows point at
 * this one through one reference (`whose`, needed only when there are two),
 * or through two (`whose: 'task_id.project_id'`, appRollups.ts);
 * `query` narrows which of them count, over their own columns.
 */
export interface AppRollup {
  fn: import('@mistriwork/engine/shared/rollups.js').RollupFn;
  from: string;
  column?: string;
  whose?: string;
  query?: string;
  /** A `latest`'s order: the column of `from` whose greatest value is the latest row; its key when absent. */
  by?: string;
}

/** A computed column as authored: what it is, and its expression in the query language's words. */
export interface AppComputed {
  type: import('@mistriwork/engine/shared/computed.js').ComputedType;
  value: string;
}

/** Existing-record save preference; grants no write capability. */
export interface AppEditing {
  save: 'explicit' | 'blur';
}

/** Normalized chrome and formatting. The server-only branding descriptor is
    separated from its static fallback theme during parsing. */
/** `ui.timezone` read per reader: a text column of a resource, `resource.column`, and the App's own zone. */
export interface AppReaderZone {
  column: string;
  default?: string;
}

/**
 * An App's own logo picture (`ui.logo: { src, dark, mark }`): files in its directory, and, once the load has read
 * them, where each is served (`href`, `darkHref`, `markHref`; server/app/appBrand.ts).
 */
export interface AppLogoImage {
  src: string;
  dark?: string;
  mark?: string;
  href?: string;
  darkHref?: string;
  markHref?: string;
}

export interface AppUi {
  /** Explicit authored choices; omission never infers an App menu. */
  /* Served said: every caption is the reader's words by now (server/app/appMessages.ts). */
  appSwitcher?: SaidCaptions<import('../../schema/app.js').AppSwitcher>;
  /** The App's footer, drawn under every room: a line of small print and a
      row of links. The landing wears it too. */
  footer?: LandingFooter;
  /** Decorative brand mark drawn beside the App name: an icon, or the App's own picture. The name remains its
      accessible label. */
  logo?: AppIconName | AppLogoImage;
  theme?: AppTheme;
  /** Internal only: authored as ui.theme: fromRecord(...), never as ui.branding.
      Bind against the logical catalog before reading an authorized row. */
  branding?: RecordBrandingSpec;
  /** Registered themes, offered in the reader's theme picker. */
  customThemes?: ThemeDefinition[];
  /** false hides the Export menu everywhere the app curates, and the server refuses the file as well, over any role's export grant. Default true. */
  export?: boolean;
  /** true makes the App an installable PWA (app/appPwa.ts): its pages carry its manifest and worker registration, and it serves its worker, icons and offline page. Preview: the shape may change in any 1.x release. Absent or false, it serves none of those. */
  pwa?: boolean;
  /** App shell visibility and spacing; omitted settings keep the existing UI. */
  shell?: AppShell;
  /** Omission keeps explicit Save. Workbench always uses explicit review/apply. */
  editing?: AppEditing;
  /** BCP 47 tag every figure the app writes is in — numbers, money, dates, counts ("en-AU",
      "de-DE") — and the language its captions are said in (messages/<locale>.ts). Absent means
      the reader's browser decides the figures and the source catalog the words. Authored as
      `{ column, default }`, this is `default`, and served it is the reader's own (appLocale.ts). */
  locale?: string;
  /** `ui.locale: { column: 'person.locale' }`: the text column each reader's own tag is read from
      (`resource.column`, their first visible row). Never served. */
  localeColumn?: string;
  /** `ui.messages: fromRecord(...)`: a tenant's own words over the App's catalogs. Never served. */
  messages?: import('./branding.js').RecordMessagesSpec;
  /** IANA zone the app's "today" is reckoned in ("Australia/Sydney"). Date
      phrases — last 30 days, this month — are windows on this calendar.
      Absent means the server's own clock. A TIMESTAMP or DATETIME that carries
      no zone holds the wall clock in this zone (UTC when the App names none) — whatever
      writes it: an action's `now`, a machine's `since`, a `Date` a command
      writes, a New form's `now`. A column with a zone (timestamptz) holds the instant.
      `{ column: 'desk_setting.timezone', default }` reads each reader's days in the
      zone their first visible row of that column names (a tenant's, an account's);
      writes keep `default`, which stands in where the row names none. Read it
      through `appZone` (appUi.ts), never directly. */
  timezone?: string | AppReaderZone;
  /** ISO 4217 default for every money rule that names none. Defaults to USD. */
  currency?: string;
  /** The origins the page opens beside its own for the App's custom components. Opening egress is authority, so
      authority.lock records each. */
  csp?: {
    /** Origins they may send requests to (`https://api.example.com`): the page's `connect-src`. */
    connect?: string[];
    /** Origins they may load pictures from: the page's `img-src`. */
    images?: string[];
  };
}

export interface AppDef {
  /** The words a value component's `label` gave its column's vocabulary, by "resource.column" (server/app/valueLabels.ts):
      learned against the catalog the App is served on, never authored, and shared by reference with the definition
      said in a reader's other words so one learning serves every reader. */
  valueLabels?: Record<string, Record<string, string>>;
  /** Private control declarations; browser payloads serve decisions separately. */
  flags?: import('./appFlags.js').FlagCatalog['flags'];
  /** Named audiences that flag rules and experiment eligibility reach by name (appFlags.ts AudienceDefinition). */
  audiences?: import('./appFlags.js').FlagCatalog['audiences'];
  experiments?: Readonly<Record<string, import('./appExperiments.js').ExperimentDeclaration>>;
  /** What the App's behavior analytics collect, emit and funnel; off when absent (appAnalytics.ts). */
  analytics?: import('./appAnalytics.js').AnalyticsDeclaration;
  /** The in-App assistant, offered to signed-in people under their own grants (appAssistant.ts, docs/assistant.md). */
  assistant?: import('./appAssistant.js').AppAssistant;
  /** How long the runtime keeps its history, command and attempt rows; absent windows are their defaults (appRetention.ts). */
  retention?: import('./appRetention.js').AppRetention;
  /** Explicit integration exposure; checked against the logical catalog before loading. */
  api?: import('./appApi.js').AppApiDef;
  /**
   * What the App's commands keep, unless a command says otherwise: `none`,
   * `receipts` (a durable receipt, so a retried request is answered once) or
   * `audit` (the receipt and every change a command made). Whatever is
   * declared, a command reached by a door that retries — the App API, MCP, a
   * job — keeps at least receipts. Absent: none for the browser's own
   * requests.
   */
  track?: 'none' | 'receipts' | 'audit';
  /**
   * Whether the App's open pages follow other people's changes (live sync):
   * on only when it says so. The operator's `--no-live` turns it off whatever
   * the App says. A resource leaves it with its own `live: false`.
   */
  live?: true;
  id: string;
  name: string;
  /** Connection this app is for, by id or name. Absent means every connection. */
  connection?: string;
  /** Every resource the App declares, by logical name. A physical binding
      is optional: an undeclared binding is inferred from a unique name. */
  resources?: Record<string, ResourceDef>;
  /** Read-only resources over tables that share a shape, each read in one order and one page (appUnions.ts). */
  unions?: readonly import('./appUnions.js').AppUnion[];
  /** Named server-side bindings; connection is normalized to the default binding. */
  sources?: Record<string, AppSourceBinding>;
  /**
   * The App's views by key: the rooms a signed-in visitor opens — every
   * list, dashboard and signed-in form view nav references, every one a
   * home rule names (the one room of an App without nav), and every list
   * view a dashboard embeds, which its "open →" opens though no menu lists
   * it — and every public form, served at its own address.
   */
  views: Record<string, AppListView | AppDashboardView | AppFormView>;
  /** The menu as authored: references to `views`, and groups of them. Empty
      for an App without nav, which draws no menu. */
  nav: AppNavNode[];
  /** Where each visitor starts, as authored: rules read in order, the first
      that matches wins, and the last matches everyone. The server evaluates
      them per request (appHome.ts resolveHome); a view id is one rule. */
  home: AppHomeRule[];
  /** Chrome and formatting, as authored under `ui`. Always present; empty
      when the App sets none of it. */
  ui: AppUi;
  /**
   * Sign-in for this app, through Better Auth, and its role grants. Absent
   * means the server's own trust model (loopback, or a proxy header).
   * Present, every request to the app needs a session, and every write is
   * journaled with who made it.
   */
  auth?: AppAuth;
  /** The front page, under its view key: content only, no data, served
      signed out. Requires auth. */
  landing?: { view: string; content: AppLanding };
  /** What each tenant may change about how the App looks to its people, and who may change it (tenantBranding.ts). */
  branding?: import('./tenantBranding.js').BrandingDeclaration;
}

/** One home rule: `signedOut` matches a visitor with no session, `roles` a
    signed-in one holding any of them, and a rule with neither everyone. */
export interface AppHomeRule {
  view: string;
  signedOut?: true;
  roles?: string[];
  realm?: AppRealm;
}

/* The enumerations the parsers check against, exported so the JSON schema is
   pinned to them (test/schema.test.ts) instead of repeating them by hand. */
export const DASH_KINDS = [
  'metric',
  'breakdown',
  'rows',
  'chart',
  'note',
  'matrix',
  'funnel',
  'board',
  'firstRun',
  'custom',
  'activity',
  'find',
  'branding',
  'integrations',
] as const;
/** How many changes an activity section draws before "Show more", at most, and how many one read answers. */
export const ACTIVITY_MAX = 50;
/** How many steps a first run asks: a start, not a manual. */
export const FIRST_RUN_MAX_STEPS = 6;
export const OPEN_MODES = ['page', 'drawer', 'modal'] as const;
export { FILTER_BARS, type FilterBar } from '@mistriwork/engine/shared/listPresentations.js';
export const SHELL_WIDTHS = ['full', 'wide', 'narrow'] as const;
export const SHELL_HEADER_WIDTHS = ['full', 'content'] as const;
export const SHELL_GUTTERS = ['none', 'compact', 'normal', 'comfortable'] as const;
/** A dashboard's charts draw these as well; a record page's chart keeps to CHART_SHAPES. */
export const DASH_CHART_SHAPES = [...CHART_SHAPES, 'scatter', 'heatmap', 'waterfall', 'treemap'] as const;
export const BETTER = ['up', 'down'] as const;

/** The windows offered when a dashboard declares none of its own. */
export const DEFAULT_WINDOWS = ['last 30 days', 'last 90 days', 'last 12 months'];

/**
 * A list view as served: the table re-addressed to its resolved id, the
 * label always filled in, and a view whose table or columns this connection
 * does not have carries its reason instead of vanishing.
 */
export interface ResolvedListView extends Omit<AppListView, 'label'> {
  label: string;
  error?: string;
}

/** The source whose resources stay bare: the one that says `default: true`, if one does. */
export function defaultSourceOf(app: Pick<AppDef, 'sources'>): string | undefined {
  for (const [name, source] of Object.entries(app.sources ?? {})) if (source.default) return name;
  return undefined;
}

/**
 * The App's own source: the connection it is served under, where its
 * accounts, command journal and editing history live. Its default source,
 * or, when none is the default, the first of its own sources. Separate from
 * naming, so an App whose sources all keep `source.name` still has a home.
 * Undefined for an App without named sources.
 */
export function homeSourceOf(app: Pick<AppDef, 'sources'>): string | undefined {
  return defaultSourceOf(app) ?? ownSourceNames(app)[0];
}

/** The platform-only sources (`realm: 'platform'`), in declaration order: none for most Apps. */
export function platformSourceNames(app: Pick<AppDef, 'sources'>): string[] {
  return Object.entries(app.sources ?? {})
    .filter(([, source]) => source.realm === 'platform')
    .map(([name]) => name);
}

/** The App's own sources: every source but its platform-only ones. What has
 * one catalog counts these — the API's, and a tenant App's one source — since
 * a platform-only source is read by the platform realm's reads alone. */
export function ownSourceNames(app: Pick<AppDef, 'sources'>): string[] {
  return Object.keys(app.sources ?? {}).filter((name) => app.sources![name].realm !== 'platform');
}

/** A source's table under its logical name: bare in the default source, `source.name` in any other. */
export function qualifyResource(defaultSource: string | undefined, source: string, local: string): string {
  return source === defaultSource ? local : `${source}.${local}`;
}

/** The logical name of a source's table in this App, which a command, a catalog and a grant all speak. */
export function logicalResource(app: Pick<AppDef, 'sources'>, source: string, local: string): string {
  return qualifyResource(defaultSourceOf(app), source, local);
}

/**
 * One catalog's declared physical bindings, local name → physical table id:
 * those of `source`, or, without one, those of an App without named sources.
 * An undeclared binding is the catalog's to infer from a unique name.
 */
export function physicalBindings(app: Pick<AppDef, 'resources'>, source?: string): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (resource.physical === undefined || resource.source !== source) continue;
    bindings[name.slice(name.indexOf('.') + 1)] = resource.physical;
  }
  return bindings;
}

/** The source a reference's target belongs to: its resource block's, as parsing recorded it. */
const targetSource = (app: Pick<AppDef, 'resources'>, to: string): string | undefined => app.resources?.[to]?.source;

/** The App's declared references within one source (the whole App, without sources), in that source's local names. */
export function declaredReferences(
  app: Pick<AppDef, 'resources'>,
  source?: string,
): import('@mistriwork/engine/shared/declaredReferences.js').DeclaredReference[] {
  const local = (name: string) => name.slice(name.indexOf('.') + 1);
  return Object.entries(app.resources ?? {}).flatMap(([name, resource]) =>
    resource.source !== source
      ? []
      : Object.entries(resource.references ?? {})
          .filter(([, reference]) => targetSource(app, reference.to) === source)
          .map(([column, reference]) => ({
            table: local(name),
            column,
            to: local(reference.to),
            ...(reference.column ? { toColumn: reference.column } : {}),
          })),
  );
}

/**
 * The App's declared references from one source to another, in the App's
 * resource names (`stock_move` → `catalog.product`). Joined in SQL where the
 * two sources share a connection, read in two steps where they do not
 * (appSourceCatalog.ts).
 */
export function crossSourceReferences(
  app: Pick<AppDef, 'resources'>,
): import('@mistriwork/engine/shared/declaredReferences.js').DeclaredReference[] {
  return Object.entries(app.resources ?? {}).flatMap(([name, resource]) =>
    Object.entries(resource.references ?? {})
      .filter(([, reference]) => targetSource(app, reference.to) !== resource.source)
      .map(([column, reference]) => ({
        table: name,
        column,
        to: reference.to,
        ...(reference.column ? { toColumn: reference.column } : {}),
      })),
  );
}

/** What a declared type says a TEXT column holds: ISO dates (`2026-09-24`) or date-times (`2026-09-24 14:30:00`). */
type DeclaredDateKind = 'date' | 'datetime';
/** A text column an App declares a date, in its source's local names. */
export interface DeclaredDate {
  table: string;
  column: string;
  as: DeclaredDateKind;
}

/** The App's `types` declarations within one source (`undefined`: the App's only source), in local names. */
export function declaredDates(app: Pick<AppDef, 'resources'>, source?: string): DeclaredDate[] {
  const local = (name: string) => name.slice(name.indexOf('.') + 1);
  return Object.entries(app.resources ?? {}).flatMap(([name, resource]) =>
    resource.source !== source ? [] : Object.entries(resource.types ?? {}).map(([column, as]) => ({ table: local(name), column, as })),
  );
}

/** The App grants by role: sign-in with default-deny role grants within the resource ceilings. */
export function grantsByRole(app: Pick<AppDef, 'auth'>): boolean {
  return app.auth?.roles !== undefined;
}

/** Rows scoped by a server-defined row policy (`auth.rows: 'policy'`). */
export function isRowPolicyApp(app: Pick<AppDef, 'auth'>): boolean {
  return app.auth?.rows === 'policy';
}

/** Rows scoped by tenant membership (`auth.rows: 'tenant'`). */
export function isTenantApp(app: Pick<AppDef, 'auth'>): boolean {
  return app.auth?.rows === 'tenant';
}

export { FILE_MAX_BYTES_CEILING, FILE_MAX_BYTES_DEFAULT } from '@mistriwork/engine/shared/fileBounds.js';

/**
 * The resource ceilings by logical name, in declaration order: `read` is
 * every declared resource (a resource reads unless it says otherwise),
 * `write` those whose access is 'write',
 * `fields` the column ceilings. What the resources say, unchecked; the
 * resolver re-checks it (checkedGrants) before any grant is judged.
 */
export function resourceCeiling(app: Pick<AppDef, 'resources'>): {
  read: string[];
  write: string[];
  fields?: Record<string, AppFieldAccess>;
} {
  const declared = Object.entries(app.resources ?? {});
  const fielded = declared.filter(([, resource]) => resource.fields);
  return {
    read: declared.map(([name]) => name),
    write: declared.filter(([, resource]) => resource.access === 'write').map(([name]) => name),
    ...(fielded.length ? { fields: Object.fromEntries(fielded.map(([name, resource]) => [name, resource.fields!])) } : {}),
  };
}

/** Every resource's invariants by logical name, or undefined when none declares any. */
export function resourceValidation(app: Pick<AppDef, 'resources'>): Record<string, FormRule[]> | undefined {
  const declared = Object.entries(app.resources ?? {}).filter(([, resource]) => resource.validation);
  return declared.length ? Object.fromEntries(declared.map(([name, resource]) => [name, resource.validation!])) : undefined;
}

/**
 * Why a key the types declare ahead of its feature is refused. Each such
 * key is parsed and refused with one of these, so an author learns the
 * feature is not built yet rather than that the key is a typo. The keys
 * are the work that turns each one on; the texts never name it.
 */
export const LATER = {
  T8: 'is not supported yet: it needs support sessions',
} as const;

/** The keys each authored section kind takes. Anything else is refused by
    name. Exported so the JSON schema's per-kind objects are pinned to it. A
    board's card is `primary` plus `lines` (the one card vocabulary); it is
    read into the section's `show`. A board takes no `width`: its lanes
    always have the dashboard's whole width. A `segment` is read before the
    section is (appSegments.ts unfoldSegments), as its word in `query`. */
export const SECTION_KEYS: Record<AppDashSection['kind'], readonly string[]> = {
  metric: [
    'kind',
    'area',
    'title',
    'icon',
    'from',
    'query',
    'segment',
    'measure',
    'compare',
    'better',
    'spark',
    'over',
    'windows',
    'width',
    'target',
    'to',
    'format',
    'unit',
  ],
  breakdown: [
    'kind',
    'area',
    'title',
    'icon',
    'from',
    'query',
    'segment',
    'measure',
    'by',
    'shape',
    'notes',
    'over',
    'windows',
    'limit',
    'width',
    'format',
    'unit',
    'target',
    'to',
    'empty',
  ],
  chart: [
    'kind',
    'area',
    'title',
    'icon',
    'from',
    'query',
    'segment',
    'measure',
    'x',
    'by',
    'shape',
    'curve',
    'total',
    'over',
    'windows',
    'limit',
    'width',
    'height',
    'target',
    'format',
    'unit',
    'to',
    'empty',
  ],
  funnel: ['kind', 'area', 'title', 'icon', 'from', 'query', 'segment', 'stages', 'over', 'windows', 'width', 'to', 'empty'],
  matrix: [
    'kind',
    'area',
    'title',
    'icon',
    'from',
    'query',
    'segment',
    'measure',
    'by',
    'over',
    'windows',
    'width',
    'format',
    'unit',
    'to',
    'empty',
  ],
  rows: [
    'kind',
    'area',
    'title',
    'icon',
    'from',
    'query',
    'segment',
    'show',
    'sort',
    'limit',
    'over',
    'windows',
    'width',
    'sizing',
    'empty',
  ],
  board: ['kind', 'area', 'title', 'icon', 'from', 'query', 'segment', 'by', 'lanes', 'primary', 'lines', 'sort', 'limit', 'over', 'empty'],
  note: ['kind', 'area', 'title', 'text', 'icon', 'action', 'width', 'variant', 'eyebrow', 'image'],
  firstRun: ['kind', 'area', 'title', 'description', 'steps'],
  custom: ['kind', 'area', 'title', 'width', 'component', 'rows', 'figures', 'props'],
  activity: ['kind', 'area', 'title', 'icon', 'resources', 'limit', 'width'],
  find: ['kind', 'area', 'title', 'icon', 'resources', 'placeholder', 'width'],
  branding: ['kind', 'area', 'title', 'icon', 'width'],
  integrations: ['kind', 'area', 'title', 'icon', 'width'],
};

/** The keys a dashboard's embed of a list view takes (`{ kind: 'view', view }`). */
export const VIEW_SECTION_KEYS = [
  'kind',
  'view',
  'area',
  'title',
  'icon',
  'width',
  'tab',
  'limit',
  'over',
  'windows',
  'interactive',
] as const;
