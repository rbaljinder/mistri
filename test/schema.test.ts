/**
 * The JSON Schemas under schema/ against the parsers they describe.
 *
 * The schemas are the authoring aid — editor squiggles, agent guidance —
 * and the parsers are the truth. Nothing imports the schemas at run time,
 * which is exactly how they would drift: a new config key, a widened enum,
 * a renamed word, and the schema quietly teaches the old format. These
 * tests pin the parts that change: every enum in the schema is the
 * parser's own constant, every key the shipped examples use is a key some
 * schema declares, and the example configs themselves stay valid against
 * the constraints the schema states.
 *
 * This walker checks declared keys and enum values. The bounded independent
 * draft-validator corpus lives in schema-feature-contract.test.ts.
 */
import { DOCUMENT_KEYS } from '../packages/engine/src/shared/appDocuments.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COMPONENT_ID,
  COMPONENT_KINDS,
  COMPONENT_PROP_TYPES,
  DASH_READ_KEYS,
  MAX_CUSTOM_READS,
  MAX_CUSTOM_FIGURES,
  PAGE_READ_KEYS,
} from '../packages/engine/src/shared/appComponents.js';
import {
  FIELD_COLUMNS,
  MAX_PAGE_SECTIONS,
  OFFSETS,
  PAGE_KEYS,
  PAGE_SECTION_KEYS,
  SECTION_REGIONS,
  STREAM_KEYS,
  WIDTHS,
} from '../packages/engine/src/shared/page.js';
import { PAGE_LAYOUT_WORDS } from '../packages/engine/src/shared/pageLayouts.js';
import { TABLE_SIZINGS } from '../packages/engine/src/shared/tableSizing.js';
import {
  AUTH_PROVIDERS,
  BETTER,
  DASH_CHART_SHAPES,
  DASH_KINDS,
  DISPLAY_FORMATS,
  LANDING_ACTION_INTENTS,
  LANDING_HERO_LAYOUTS,
  LANDING_SECTION_KINDS,
  PLACEMENTS,
  OPEN_MODES,
  OIDC_PROVIDER,
  ROOT_KEYS,
  ROW_SCOPES,
  SECTION_KEYS,
  SIGN_UP_MODES,
  THEME_KEYS,
  VIEW_SECTION_KEYS,
} from '../packages/mistri/src/shared/app.js';
import { DISPLAY_TONES } from '../packages/engine/src/shared/model.js';
import { RESOURCE_BLOCK_KEYS } from '../packages/mistri/src/shared/appResourceBlocks.js';
import { RESOURCE_CLONES } from '../packages/mistri/src/shared/appModel.js';
import { ASSISTANT_BLOCKS, ASSISTANT_EFFORTS, ASSISTANT_PLACEMENTS, ASSISTANT_TOOLS } from '../packages/mistri/src/shared/appAssistant.js';
import { FEATURE_KEYS } from '../packages/mistri/src/shared/appFeatures.js';
import { AUTHORED_OPERATIONS } from '../packages/mistri/src/shared/appAuthGrants.js';
import { DASHBOARD_VIEW_KEYS, LIST_VIEW_KEYS, PRESENTATION_KEYS } from '../packages/mistri/src/shared/appViews.js';
import { FORM_VIEW_KEYS } from '../packages/mistri/src/shared/appForms.js';
import { AUTHORED_FORM_KEYS, FORM_FIELD_KEYS, FORM_OPEN, MAX_FORM_WHERE } from '../packages/mistri/src/shared/formRules.js';
import { UI_KEYS } from '../packages/mistri/src/shared/appUi.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appDirectory, EXAMPLES, publicExamples, walkedApps } from './support/exampleApps.js';

const SCHEMA_DIR = new URL('../packages/mistri/schema/', import.meta.url).pathname;
const appSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'app.schema.json'), 'utf8'));
const a = appSchema.$defs;
/** The dashboard section schema is one object per kind; this is the object for one. */
const dashKind = (kind: string) =>
  a.dashSection.oneOf.find((option: { properties: { kind: { const: string } } }) => option.properties.kind.const === kind);
const presentationKind = (kind: string) =>
  a.presentation.oneOf
    .map((option: { $ref?: string }) => (option.$ref ? a[option.$ref.split('/').pop()!] : option))
    .find((option: { properties: { kind: { const: string } } }) => option.properties.kind.const === kind);
const pageSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'page.schema.json'), 'utf8'));
const themeSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'theme.schema.json'), 'utf8'));
const props = (node: { properties?: object }) =>
  Object.keys(node.properties ?? {})
    .filter((key) => key !== '$schema')
    .sort();
const sorted = (list: readonly string[]) => [...list].sort();

/** Every property name declared anywhere in a schema document. */
function declaredKeys(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) declaredKeys(n, into);
    return into;
  }
  if (!node || typeof node !== 'object') return into;
  const o = node as Record<string, unknown>;
  if (o.properties && typeof o.properties === 'object') {
    for (const key of Object.keys(o.properties)) into.add(key);
  }
  for (const value of Object.values(o)) declaredKeys(value, into);
  return into;
}

/** Every key used anywhere in a config document, stepping over the maps
    whose own keys are the author's names — resources and sources, views and
    pages, roles, a command's input and a group's fields (keyed by field
    name), a block's display and labels, a message's `translations` (locale → text), an
    action's `set`, a form's `defaults`, a form's `when` (column → condition) and a notification's `when` (column → value), a tone map
    (value → tone), a value's `icons` (value → icon), a board's `limits` (lane → number) — while still walking
    the format inside them. */
function usedKeys(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) usedKeys(n, into);
    return into;
  }
  if (!node || typeof node !== 'object') return into;
  for (const [key, value] of Object.entries(node)) {
    const map = value && typeof value === 'object' && !Array.isArray(value);
    into.add(key);
    // `actions` is keyed by action id on a resource and by resource in a role grant; `computed` by the column it makes.
    if (
      map &&
      [
        'resources',
        'sources',
        'views',
        'pages',
        'roles',
        'fields',
        'input',
        'display',
        'translations',
        'rollups',
        // A resource's segments, by the name a tab and a query say.
        'segments',
        'computed',
        'defined',
        // A resource's flows: `kinds` by the step kind's name.
        'kinds',
        'props',
        'rows',
        'actions',
        'states',
        'on',
        // A resource's timers: `at` is keyed by the date column each one waits for.
        'at',
      ].includes(key)
    ) {
      for (const inner of Object.values(value)) usedKeys(inner, into);
      // `shortcuts` on a split is { <key>: <action id> }; `tone` and `compact` on a timeline are { <column>: … } maps. `draft` on a form saved on every step is { <root column>: <value> }, a column name the author picks; so are a form
      // field's `where` and a related create's `fill`; a display rule's `values` is keyed by the stored value.
    } else if (
      map &&
      [
        'labels',
        'set',
        // A resource's flows: `events` is { <event name>: <payload field> }.
        'events',
        'defaults',
        'when',
        'tone',
        'icons',
        'transitions',
        'limits',
        'prefill',
        'near',
        'draft',
        'where',
        'values',
        'shortcuts',
        'compact',
        // A steps breakdown's `notes` and a display rule's `colors` are keyed by the stored value.
        'notes',
        'colors',
        // A machine's `groups` names a set of its states: { <group name>: [<state>, …] }.
        'groups',
      ].includes(key)
    ) {
      continue;
    } else usedKeys(value, into);
  }
  return into;
}

describe('the schemas repeat the parser, and the tests keep them honest', () => {
  const defs = pageSchema.$defs;

  test('author-keyed maps are walked for their format, never listed as keys', () => {
    assert.deepEqual(
      [
        ...usedKeys({
          machine: {
            field: 'stage',
            states: { prospecting: { on: { qualify: { to: 'qualified', typo: true } } }, qualified: { final: true } },
          },
        }),
      ].sort(),
      ['field', 'final', 'machine', 'on', 'states', 'to', 'typo'],
    );
    assert.deepEqual([...usedKeys({ sources: { lending: { connection: 'loans', typo: true } } })].sort(), [
      'connection',
      'sources',
      'typo',
    ]);
    assert.deepEqual(
      [
        ...usedKeys({
          resources: {
            'applicants.applicant': { display: { verification_status: { tone: { verified: 'good' } } }, labels: { name: 'Name' } },
          },
        }),
      ].sort(),
      ['display', 'labels', 'resources', 'tone'],
    );
    assert.deepEqual(
      [...usedKeys({ auth: { roles: { viewer: { read: true, fields: { 'applicants.applicant': { read: ['id'] } } } } } })].sort(),
      ['auth', 'fields', 'read', 'roles'],
    );
    assert.deepEqual(
      [...usedKeys({ command: { input: { applicant_name: { type: 'group', fields: { email: { type: 'text', max: 254 } } } } } })].sort(),
      ['command', 'fields', 'input', 'max', 'type'],
    );
    assert.deepEqual(
      [...usedKeys({ copy: { message: 'people.greeting', fallback: 'Hello', translations: { es: 'Hola' }, typo: true } })].sort(),
      ['copy', 'fallback', 'message', 'translations', 'typo'],
    );
  });

  test('every enum in the page schema is the parser constant, not a copy that was right once', () => {
    assert.deepEqual(defs.width.enum, [...WIDTHS]);
    assert.deepEqual(defs.region.enum, [...SECTION_REGIONS]);
    assert.deepEqual(defs.list.properties.sizing.enum, [...TABLE_SIZINGS]);
    assert.deepEqual(a.listView.properties.sizing.enum, [...TABLE_SIZINGS]);
    assert.deepEqual(dashKind('rows').properties.sizing.enum, [...TABLE_SIZINGS]);
    for (const kind of ['fields', 'metric', 'list', 'breakdown', 'chart', 'note', 'view', 'timeline', 'history', 'custom']) {
      assert.deepEqual(defs[kind].properties.region, { $ref: '#/$defs/region' });
    }
    assert.deepEqual(defs.offset.enum, [...OFFSETS]);
    assert.deepEqual(defs.fields.properties.columns.enum, [...FIELD_COLUMNS]);
    assert.equal(defs.page.properties.sections.maxItems, MAX_PAGE_SECTIONS);
    // A page metric says `measure`, as a dashboard's does; the planner's fn and column are not authored.
    assert.ok(!('fn' in defs.metric.properties) && !('column' in defs.metric.properties));
  });

  test('the theme whitelist is THEME_KEYS, exactly', () => {
    assert.deepEqual(Object.keys(a.appTheme.properties), [...THEME_KEYS]);
  });

  test('the public DSL key sets are the one vocabulary: a new key is a deliberate release decision', () => {
    /* One root, grouped as identity / data / auth / content / ui; only `ui`
       nests. Every other key is refused with the keys its place takes
       (test/app-dsl-refusals.test.ts), so a key listed here is a promise:
       adding one means editing this
       test in the same change, with the site marking it stable or preview. */
    assert.deepEqual(props(appSchema), sorted(ROOT_KEYS));
    assert.deepEqual(sorted(ROOT_KEYS), [
      'analytics',
      'api',
      'assistant',
      /* `audiences` (1.0) replaced `flagSegments`: one definition of who, named by flag rules and experiments. */
      'audiences',
      'auth',
      'branding',
      'connection',
      'experiments',
      'features',
      'flags',
      'home',
      'id',
      /* `live` (0.9.9): live sync is an App's choice, off unless asked. */
      'live',
      'name',
      'nav',
      'pages',
      'resources',
      'retention',
      'sources',
      'track',
      'ui',
      'unions',
      'views',
    ]);
    /* chrome and formatting under `ui`; `customThemes` was root `themes`. */
    assert.deepEqual(props(a.ui), sorted(UI_KEYS));
    /* `rail` (0.4.0): the side menu folds to a rail of its entries' icons. */
    assert.deepEqual(props(a.ui.properties.shell), [
      'breadcrumbs',
      'counts',
      'gutter',
      'headerWidth',
      /* `heading` (0.9.9): was `title`, the word a view's own switch uses. */
      'heading',
      'menuSearch',
      /* `new` (0.8.14, Preview): the header's New menu — a list's view or a command's form per line. */
      'new',
      'placement',
      'rail',
      'search',
      'sidebar',
      'width',
    ]);
    /* a source says whether it is the default (was root `defaultSource`), and
       `realm: 'platform'` (0.5.0) makes it a tenant App's platform-only source. */
    assert.deepEqual(props(a.source), ['connection', 'default', 'realm', 'resources', 'schema']);
    /* one block per resource — binding, ceiling, columns,
       display, validation, captions, the New form, the actions, the default
       page and what the support write trail keeps (`audit`). `owner` is
       declared for tenancy. `live` (0.9.9) only leaves live sync, with false. */
    assert.deepEqual(props(a.resource), sorted([...RESOURCE_BLOCK_KEYS, 'owner', 'clone', 'live']));
    /* access folded into auth; `rows` is the enrollment in
       one word; `tenancy` is declared and refused until T5; `me` (0.8.0)
       says which table's row the signed-in person is, for `owner_id = me`. */
    assert.deepEqual(props(a.auth), [
      'challenge',
      'defaultRole',
      'me',
      'providers',
      'public',
      'roles',
      'rows',
      'signUp',
      'store',
      'tenancy',
    ]);
    /* `supportLog` and `supportAudit` (0.5.0), the grant keys that let a role
       read a support session's record, folded into `operations: ['support']`
       in 1.0, the realm saying whose. `actions` (0.8.0): fixed actions a role runs
       by label on a resource it does not write. `members`, declared ahead of
       delegated administration and only ever refused, went in 0.8.2, and
       `create` (0.8.2) came: of what a role writes, what it makes new rows in,
       and `claims` (`from` until 1.0): the identity provider's claims that give the role.
       `service` (1.0): a role only a service principal holds (a jobs module's
       principal, an App API token), which a free-form page is offered to only
       where it names it. `extends` (0.9.2): another role whose grants it holds too. */
    assert.deepEqual(props(a.roleGrant), [
      'actions',
      'claims',
      'commands',
      'create',
      'experiments',
      'export',
      'extends',
      'fields',
      'flags',
      'label',
      'operations',
      'read',
      'realm',
      'service',
      'write',
    ]);
    /* tenancy says what a tenant is called, its profile table and the platform realm. */
    assert.deepEqual(props(a.tenancy), ['label', 'platform', 'profile']);
    assert.equal(a.tenancy.additionalProperties, false);
    assert.deepEqual(props(a.tenancy.properties.platform), ['label', 'me']);
    assert.deepEqual(a.auth.properties.tenancy, { $ref: '#/$defs/tenancy' });
    /* views, keyed and discriminated by kind; nav holds references. */
    assert.deepEqual(props(a.listView), sorted([...LIST_VIEW_KEYS, 'realm']));
    assert.deepEqual(props(a.dashboardView), sorted([...DASHBOARD_VIEW_KEYS, 'realm']));
    assert.deepEqual(props(a.viewSection), sorted(VIEW_SECTION_KEYS));
    assert.deepEqual(props(a.landingView), ['hero', 'kind', 'label', 'sections']);
    /* `inputs` (0.8.0): a signed-in form's input drawn by the App's own component. */
    /* A form saved on every step says so by its steps (each runs a command), not by a `save` key (0.8.2). */
    /* `roles` (0.8.7): a signed-in form's narrower audience, as on every other room. */
    assert.deepEqual(props(a.formView), sorted([...FORM_VIEW_KEYS, 'inputs', 'realm', 'roles']));
    assert.deepEqual(
      a.view.oneOf.map((option: { $ref: string }) => option.$ref.split('/').pop()),
      ['listView', 'dashboardView', 'landingView', 'formView'],
    );
    /* A free-form page is a file of its own (pages/<path>.page.tsx), not a view an App writes: the schema has none. */
    assert.equal(a.roomView, undefined);
    assert.deepEqual(props(a.homeRule), ['realm', 'roles', 'signedOut', 'view']);
    assert.deepEqual(
      props(a.navGroup),
      [
        'children',
        'folded',
        'icon',
        'id',
        'inline',
        'label',
        'placement',
        'realm',
      ] /* `icon` (0.4.0): the group's mark in a top bar; `placement`: the foot of the sidebar; `inline` (0.8.8): its items straight in the top bar;
           `folded` (0.8.9): a rarely used section starts as its heading. */,
    );
    /* composition: a feature is content and the grants it needs; the App
       keeps its identity, sources, sign-in, roles and ui. A feature grants
       by name only, and a placement names one feature. */
    assert.deepEqual(props(a.feature), sorted(FEATURE_KEYS));
    assert.deepEqual(props(a.feature.properties.auth), ['roles']);
    assert.deepEqual(props(a.featureGrant), [
      'actions',
      'commands',
      'experiments',
      'fields',
      'flags',
      'operations',
      'read',
      'realm',
      'write',
    ]);
    assert.deepEqual(a.featureGrant.properties.realm.enum, ['tenant', 'platform']);
    assert.equal(a.featureGrant.additionalProperties, false);
    assert.deepEqual(props(a.navPlacement), ['feature']);
    /* the card is `primary` plus `lines`, on every host. */
    for (const kind of ['checklist', 'queue', 'cards'] as const) {
      assert.deepEqual(props(presentationKind(kind)), sorted(PRESENTATION_KEYS[kind]), kind);
    }
    /* a board and a split are keys of the list view, so their options are theirs and the kind is the key. */
    for (const [kind, def] of [
      ['board', a.boardList],
      ['split', a.splitListDetail],
    ] as const) {
      assert.deepEqual(props(def), sorted(PRESENTATION_KEYS[kind].filter((key) => key !== 'kind')), kind);
      assert.deepEqual(a.listView.properties[kind], { $ref: def === a.boardList ? '#/$defs/boardList' : '#/$defs/splitListDetail' }, kind);
    }
    assert.deepEqual(props(a.landingAction), ['intent', 'label', 'signIn', 'to']);
    assert.equal(a.formView.properties.command.$ref, '#/$defs/commandName');
    assert.deepEqual(props(a.landingView.properties.hero), [
      'actions',
      /* rc.1: a short badge over the heading, two to four photo tiles, up to four icon rows. */
      'badge',
      'description',
      'heading',
      'highlights',
      'image',
      'layout',
      'points',
      'search',
      'tiles',
    ]);
    assert.deepEqual(a.landingView.properties.hero.properties.layout.enum, [...LANDING_HERO_LAYOUTS]);
    /* One footer: `ui.footer` draws under every room, the landing's included. */
    assert.deepEqual(props(a.appFooter), ['links', 'text']);
    assert.equal(a.landingView.properties.footer, undefined);
    assert.equal(a.ui.properties.footer.$ref, '#/$defs/appFooter');
    assert.deepEqual(props(a.landingLink), ['href', 'label']);
    assert.deepEqual(
      a.landingSection.oneOf.map((option: { properties: { kind: { const: string } } }) => option.properties.kind.const),
      [...LANDING_SECTION_KINDS],
    );
    assert.deepEqual(a.landingAction.properties.intent.enum, [...LANDING_ACTION_INTENTS]);
    /* Commands are names; their inputs and targets come from the server registry. */
    assert.equal(a.actions.additionalProperties.properties.command.$ref, '#/$defs/commandName');
    assert.deepEqual(props(a.actions.additionalProperties), [
      'bulk',
      'command',
      'confirm',
      'header',
      'inputs',
      'label',
      'reason',
      'set',
      'when',
    ]);
    /* `children` (repeatable child collections) stays off the public form. */
    assert.deepEqual(props(a.form), sorted(AUTHORED_FORM_KEYS));
    assert.deepEqual(a.form.properties.open.enum, [...FORM_OPEN]);
    assert.deepEqual(props(a.formFieldDress), sorted(FORM_FIELD_KEYS));
    assert.equal(a.formFieldDress.properties.where.maxProperties, MAX_FORM_WHERE);
    assert.deepEqual(a.formVisibility.additionalProperties, { $ref: '#/$defs/formCondition' });
    assert.deepEqual(props(a.formRule), ['message', 'must', 'when']);
    /* Every section kind takes exactly the keys the parser reads for it. */
    for (const kind of DASH_KINDS) {
      const object = dashKind(kind);
      assert.equal(object.additionalProperties, false, kind);
      assert.deepEqual(Object.keys(object.properties).sort(), [...SECTION_KEYS[kind]].sort(), kind);
    }
    /* pages. An App's are keyed (no `id`); a mistri.json
       page keeps its `id` and its `connection`, and `filter` is `query`
       on both, and the parser now refuses unknown keys at every level. */
    /* `aside` and `layout` (0.9.5) are an App page's: a config file's page draws the record's one skeleton. */
    assert.deepEqual(props(pageSchema.$defs.page), sorted([...PAGE_KEYS.filter((key) => key !== 'aside' && key !== 'layout'), 'id']));
    /* An App's page has no label (the record's noun names it); a mistri.json page keeps one. `path` (0.8.0): an App page's own address segment, when it has one (shared/appAddress.ts). */
    /* `roles` (0.8.7): the roles that may open it, as a view names them. */
    /* `document` (1.0): the record on paper, its own keys DOCUMENT_KEYS (shared/appDocuments.ts). */
    assert.deepEqual(
      props(pageSchema.$defs.appPage),
      sorted([...PAGE_KEYS.filter((key) => key !== 'connection' && key !== 'label'), 'path', 'realm', 'roles', 'document']),
    );
    assert.deepEqual(props(pageSchema.$defs.appPage.properties.document), sorted([...DOCUMENT_KEYS]));
    /* `header` and `current` (0.8.2): the record's head and its current card are kinds of their own, not presentations. */
    for (const kind of [
      'fields',
      'header',
      'current',
      'metric',
      'list',
      'breakdown',
      'chart',
      'note',
      'view',
      'timeline',
      'history',
      'custom',
    ] as const) {
      assert.deepEqual(props(pageSchema.$defs[kind]), sorted(PAGE_SECTION_KEYS[kind]), kind);
    }
    assert.deepEqual(props(pageSchema.$defs.timelineStream), sorted(STREAM_KEYS));
  });

  test('the vocabulary is counted: every key an object declares, and the distinct names among them', () => {
    /* The key budget. Each object in the three schemas contributes its keys
       ($schema included), so a key two places take counts twice and a name
       counts once. 0.8.2 began at 980 entries and 330 names. The display
       rule became one object (no `max`, no `humanize`, no `format: 'masked'`),
       a list's named orders moved into its `sort`, a tab's order into its
       query, a saved form says so by its steps (no `save`), `ui.theme` lost
       `accentSoft` to a derived tint, and the keys that were only ever refused
       went (`fromUrl`, a role's `members`, the `screen` view): 330 names
       became 326. The record's head and its current card became section
       kinds of their own, which adds their placement keys as entries (989);
       the names they use were all there already. Sign-in through an identity
       provider added three entries and one name: a role's `from` (the claims
       that give it), and just-in-time sign-up's `providers` and `domains`,
       the one new word; the providers themselves are strings (`oidc:…`).
       Computed columns add a resource's `computed` and each one's `type` and
       `value` (three entries, one name: `type` and `value` were names
       already); keying actions by id added none.
       A change to either number is a release decision: say it here. */
    let entries = 0;
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      const declared = o.properties && typeof o.properties === 'object' && !Array.isArray(o.properties) ? o.properties : undefined;
      /* Each declared key's own schema is walked, never the map as a schema: a key named `properties` is a key. */
      for (const [key, value] of Object.entries(declared ?? {})) {
        entries++;
        names.add(key);
        walk(value);
      }
      for (const [key, value] of Object.entries(o)) if (!(declared && key === 'properties')) walk(value);
    };
    [appSchema, pageSchema, themeSchema].forEach(walk);
    // 0.8.2: `track`, what an App's commands keep (docs: commands, "What a command keeps").
    // 0.8.2: `computed`, a resource's computed columns (docs: app-dsl, "Computed columns").
    // 0.8.2: machines replace workflow/transition metadata and command names replace inline references.
    // 0.8.3: approved App links/branding/navigation bring the baseline to 1007/329;
    // flags, scoped capabilities and immutable experiment declarations add 61 entries and 23 names.
    // 0.8.5: one word per idea — a form's `visibleIf` and a rule's `if` are `when`, a status check's `shows` is `show`,
    // a hero's `headline` is `heading`; an App page has no `onlyOn` (its App names the connection): 1067/348.
    // 0.8.5: `analytics`, behavior events and funnels (the root key and its feature mirror, with collect, events, funnels and their steps: 14 entries, 6 names): 1081/354.
    // 0.8.5: a role's `label`, the name the screens that name it to people say: 1082/354 (the name was already counted).
    // 0.8.5: a fixed `set` value may be an expression ({ type, value }: 2 entries), a metric's target may be read from data
    // (table, query, measure: 3); a headline action's `presets` is `defaults` and a related create's `fill` is `prefill` (one name fewer);
    // an API resource's create/update/delete and the event feeds (5 entries): 1092/353.
    // 0.8.5: a role's field grant may omit `read`, its own def (`roleFieldGrant`: read, write, 2 entries, no new name),
    // and a look's `focus` colour (1 entry, 1 name): 1095/354.
    // 0.8.5 DSL compaction: one link key (`to`), `from` for a section's table, one duration spelling and conditions for
    // validation took keys out: 1081/353.
    // 0.8.5: `excludeSelf` went, its siblings being a `similar` list: 1080/352.
    // 0.8.5: a list's `board` and `split` are keys of the view (their options are the presentations', minus the kind),
    // `versionField` went from record branding, and a notify rule's `when` is a string: 1079/353.
    // 0.8.7: a resource's `text` and its rules (min, max, pattern, message: 5 entries, one new name) and
    // `me.create` with its `name` (2): 1086/354.
    // 0.8.7: an action's `header: false`, kept out of the record's action bar (1 entry, 1 name): 1111/368.
    // 0.8.7: `roles` on a list, a dashboard, a room, a signed-in form and an App page — who may open it (5 entries, no new name): 1116/368.
    // 0.8.7: a card's `description` (cards and a related list's cards), a dashboard's `find` box (kind, title, icon,
    // resources, placeholder, width) and the shell's placement `{ top: roles }` (9 entries, 1 name): 1125/369.
    // 0.8.8 wave 2c: a machine's `entry`, a stream's `about`, a composer's `templates` (from, label, text)
    // and a tags field's `add`/`remove` commands (8 entries, 4 names): 1147/374.
    // 0.8.8 wave 3: a resource's `defined` and a binding's `from` and `per` (3 entries, 2 names): 1150/376.
    // 0.8.8 wave 4: a resource's `flows` (from, steps, set, events, kinds) and a kind's command, input and waitFor
    // (9 entries, 4 names), and the page's `flows` section (history's keys but its limit: 11 entries): 1170/380.
    // 0.8.9: a nav group's `folded` (1 entry, 1 name) and a page metric's `format` and `unit` (2 entries): 1173/381.
    // 0.8.9: the theme file is `defineTheme`'s input, by purpose (palette, shape, type, density, recipes and their
    // parts, the color names): 54 more entries, two fewer names (text, subtle, border... went; ground, ink, line... came): 1227/379.
    // A tenant's branding (allow, editors, themes) and its dashboard section (kind, title, icon, width): 8 more
    // entries, four new names (branding, allow, editors, themes): 1235/383.
    // 0.8.9 wave 3: a lead column's `icon` (mark, tone), a board's `colors`, `category` and `footer` (column, icon),
    // a breakdown's `shape` and `notes`, a chart's `curve` and `total`, a note's banner (variant, eyebrow, image:
    // from, key, alt), a dashboard's `windowControl`, a nav entry's `color` and the recipe menu's `banner` and
    // `steps`: 1260/393.
    // A display rule's `outOf` (a rating's stars), `ring` (a percent's circle) and `slider` (min, max, step): 1266/396.
    // 0.8.9 wave 6: the assistant (instructions, model, effort, roles, tools, exclude, blocks, placement, confirm,
    // limits: tokensPerTurn, tokensPerPersonPerDay, tokensPerDay) and its root key: 1293/411.
    // 0.8.9 wave 6b: the assistant's `starters` (1 entry, 1 name): 1294/412.
    // 0.8.12: a board's `sum` (1 entry, 1 name) and `folded` (1 entry; the nav group's name): 1296/413.
    // 0.8.13: a timeline's `side` (1 entry, 1 name) and a calendar's `backdrop`, one span or a list of them (resource,
    // from, to, label, tone, each written twice: 11 entries, 1 name): 1308/415.
    // 0.8.14: a list's `suggest` and a headline's `was` (1 entry, 1 name each), and a card image's `about` (2 entries:
    // a view's cards and a page list's; the name is a section's already): 1312/417.
    // 0.8.14: the shell's `new` (1 entry, 1 name) and its line's view, command, label and icon (4 entries; the names
    // are a nav entry's already): 1317/418.
    // 0.8.14: a timeline stream's own `side` (1 entry; the name is the section's already): 1318/418.
    // A starter's place (text, views, records: 3 entries, `records` a new name) and a New menu group (label, children:
    // 2 entries, the names a nav group's already): 1323/419.
    // 1.0: a fact's `position` in a page's related cards and its header, as the parser took it (2 entries; the name is
    // a view's cards' already): 1325/419.
    // 1.0: a page's related cards take a list card's `icon` and `media` (2 entries; the names are a view's cards'
    // already): 1327/419.
    // 1.0: the assistant's `confirm`, which could only say 'writes', goes (1 entry; the name is an action's still):
    // 1326/419.
    // 1.0: room() went, for definePage in pages/*.page.tsx, which the App's JSON does not carry: its view's kind, label,
    // path, icon, description, heading, realm, roles, favorite, component (its kind), reads, params and props: 14 entries,
    // 2 names no other object declares: 1312/417.
    // 1.0: a form's `lines` (each line's title, from, whose, show, order, min, max) and `live`, a money rule's `minor` and
    // `currency: { column }`, and a related list's `edit` and `order` (13 entries; `lines` and `live` are new names): 1325/419.
    // 1.0: a role's `service` (1 entry, 1 name): 1326/420.
    // 1.0: `audiences` replaced `flagSegments` at the root and in a feature, and an experiment's eligibility names
    // them; an audience's roles, tenants, attributes (emailDomain), rollout, allow and deny (7 entries; `attributes`,
    // `emailDomain`, `deny` and `audiences` are new names, `flagSegments` and `segments` went): 1333/422.
    // 1.0: an experiment's eligibility says who only through audiences: its own `roles` and `tenants` went (the
    // names stay an audience's; one entry, as the counter reads the pair): 1332/422.
    // 1.0: the integrations settings section (`integrationsForm()`) declares its own kind, title, icon and the rest
    // a dashboard section takes (4 entries, no new names): 1336/422.
    // 1.0: an App's API says it may answer beyond loopback (`api.network`, a new name): 1337/423.
    // 1.0: a `latest()` rollup orders its children by a column (`by`, an existing name): 1338/423.
    // 1.0: a `notify` rule tells on an integration's channel (`send` with `channel`, `to`, `consent`, `timezone`): 1343/425.
    // 1.0: a file resource keeps its bytes in an S3-compatible bucket (`object`, `hash`, `storage`, `bucket` with `name`, `region`, `endpoint`, `pathStyle`, `prefix`, `presign`): 1353/432.
    // 1.0 (blocks): `format`/`unit` on a breakdown, chart and matrix (6), a template's `query` (1), a stream's
    // `tint`/`compact` (2), and a card's `footer` with its fact shape in both schemas (12); no new names: 1374/432.
    // 1.0 (workflows): a machine state's `at` timer and `by` service-only moves (existing names), and a flow
    // kind's `remind` (a new name): 1377/433.
    // 1.0 (blocks 2): a record page's breakdown and chart take `format`/`unit` (4), a breakdown's `target`
    // with its table, by, measure, query and over (6), `ui.timezone`'s `{ column, default }` (2), and root `unions`
    // with a union's name, branches and each branch's from and as (5); `unions`, `branches`, `as` are new: 1391/435;
    // with the workflows keys beside them: 1394/436.
    // 1.0 (workflows 2): a notify rule told by a flow's notify step (`on: { flow }`, a new name): 1395/437;
    // and a `diagram` page section, the common section keys under a new kind (no new name): 1406/437.
    // 1.0 (languages): a caption's message reference is `{ message, args? }` in one `messageRef`, and the old
    // `fallback`/`translations` length rules beside each caption go with `translations`; `ui.locale` takes
    // `{ column, default }`, and `ui.messages: fromRecord` its binding (kind, from, by, tenantField, fields: key, locale,
    // text); `args` and `messages` are new names. Net −18 entries: 1388/438.
    // 1.0 (DSL freeze): one word per idea, renamed with the old spelling refused (CHANGELOG "Upgrading from 0.8 to 0.9");
    // `supportLog`/`supportAudit` fold into `operations`, `ui.shell.menu` goes, and the first-run, empty and done
    // sentences are each `description`: 1385/437.
    // 1.0 (documents): a page's `document` with its `label`, `number`, `size` and `description` (5 entries);
    // `document` and `size` are new names, the record on paper and its sheet: 1390/439.
    // 1.0: a timer at an instant is the resource's `at` (with a timer's `command` and `when`), no longer
    // a machine state's (no new name): +2, 1393/440.
    // 1.0: `ui.shell.search` may be `{ signedOut: true }`, the header's search offered to a visitor
    // (an existing name): 1394/440.
    // 1.0: a related list's `actions`, the record's verbs drawn in its head (an existing name): 1395/440.
    // 1.0: a dashboard's `window`, the one it opens on (a new name): 1396/441.
    // 1.0 page DSL: card and headline are sections of their own, a list's match is `same`/`near`, a fact says `before`/`after`, and the accordion, `collapsed`, `about`/`similar`/`editable`/`order` on a list and a page's `path` are gone: 1412/440.
    // 1.0 conventions: a machine's `groups` (one name the vocabulary already had, in each place a machine is declared): 1419/440.
    // 1.0 conventions: a form default `{ from }`, a value from the record a reference names (an existing name): 1420/440.
    // 0.9.1: a list `opens` the record its join row names, a new name: 1421/441.
    // 1.0 (Lumen): a list's own `count`, whether the menu counts it (a new name): 1422/442.
    // 0.9.1: a resource's `segments` (a name, or `{ query, label }`) and `consumes` (`column`, `by`, `refuse`, `floor`, one
    // or a list); a `segment` on a rollup, a list view and every sourced dashboard and page section; a tab is a segment's
    // name, `{ segment, sort }` or `{ label, sort }` (its `query` went). `segments`, `segment`, `consumes`, `refuse` and
    // `floor` are new names: 1443/447.
    // 0.9.1: a list filter may be `{ has, filter | segment, via }`, the rows that point at the record; `has` and `via`
    // are new names: 1447/449.
    // 0.9.2: a theme's `type.faces`, each `{ family, src, weight, style }`: font files from the App's directory;
    // `faces`, `family`, `src` and `weight` are new names: 1452/453.
    // 0.9.2: a role `extends` another (the word a theme already says): 1453/453.
    // 0.9.2: a resource's `restocks`, `consumes` the other way round (a new name): 1454/454.
    // 0.9.2: a theme may suggest `shell: { placement }`, the menu's side; `ui.shell` still wins (existing names): 1454/453.
    // 0.9.2: a theme's `recipes.headings` and `recipes.lanes`, `shape.radius.pill` and `rules.control` in each mode;
    // `headings` and `pill` are new names (`lanes` and `control` were names already): 1459/455.
    // 0.9.2: a theme's face may say `subset: false`, shipped whole rather than cut to Latin (a new name): 1460/456.
    // 0.9.2: an App page's `aside: false`, leaving the default aside out (`aside` was a name already): 1463/457.
    // 0.9.4: a role grant's `export` (a new name): 1464/458.
    // 0.9.4: a theme's `shape.radius.panel` and `shape.border` (`rule`, `control`, `panel`, `focus`), the widths moved
    // out of each mode's `rules`; `border`, `rule` and `focus` are new names: 1466/461.
    // 0.9.4: `ui.logo` may be the App's own picture, `{ src, dark, mark }` (existing names): 1469/461.
    // 0.9.4: a theme's `motion`, its pace (a new name): 1470/462.
    // 0.9.4: a theme's `shadow` in each mode's colors and `shape.elevation: { card, float }`; `shadow`, `card` and
    // `float` are new names: 1474/465.
    // 0.9.4: `ui.theme.for`, `{ public, roles }`, a theme per audience; `for` is a new name: 1477/466.
    // 0.9.4: a theme's `type.base` and `type.roles`, nine roles each with the properties it takes, where
    // `type.scale`, `type.headingWeight` and `recipes.labels`, `.headings` and `.figures` were (a clean break):
    // 1526/468.
    // 0.9.4: past the recipe menu, a mode's `band`, `type.icons`, `surface` with a pattern for its `ground` and `nav`
    // (`kind`, `strength`), and `parts`, each part's style (ground, ink, edge, radius, lift, face, weight, case) said
    // once as a map of the published names: 17 entries; band, strength, parts, edge and lift are new names: 1543/473.
    // 0.9.4: a published look's `stylesheet`, `contract` and `from`, and `extends` naming a theme by its `kind`;
    // `contract` and `from` are new names: 1547/475.
    // 0.9.5: a theme's `onAccent` and `accentInk` in each mode's colors (the words on an accent fill, the accent as
    // text; both new names): 1551/477.
    // 0.9.5: a theme's `scheme`, `dark` or `dark-only` (a new name): 1552/478; a display rule's `face` (not new): 1553/478.
    // 0.9.5: a breakdown's, a chart's and a matrix's `to`, the list their groups open (3 entries, no new name): 1550/475.
    // 0.9.5: the `funnel` dashboard section and its `stages` (title, query, optional; the section's own 12 keys,
    // `stages` and `optional` are new names); the chart's `funnel` shape is an enum value, not a key: 1577/480.
    // 0.9.5: a list's `group` (by, show, sort, limit; one new name, `by` is old): 1567/479.
    // 0.9.5: a dashboard's `layout` and every section kind's `area` (14 kinds and an embed; `area` is a new name,
    // `layout` was a name already): 1593/481.
    // 0.9.5: a theme's `rhythm`, how far apart things stand (a new name): 1614/483.
    // 0.9.5: a page's `layout`, its archetype (a name already, the dashboard's grid and the landing hero's): 1615/483.
    // 0.9.6: a theme's `type.data.reach`, where its data face reaches (1 entry, 1 name): 1616/484.
    // 0.9.6: a dashboard's grid is `areas`, not `layout` (one name more: `layout` stays a page's and a hero's): 1616/485.
    // 0.9.6: a custom section's aggregate reads are `figures`, not `totals` (one name more: `totals` stays a list's footer): 1616/486.
    // 0.9.7: the platform realm's `me` (from, column: three entries, no new name): 1619/486.
    // 0.9.9: notify `opens`, shell `heading`, stock `message` (renames to names the vocabulary had; `refuse` goes): 1619/485.
    // 0.9.9: a role's `claims.provider`, whose claims a rule reads (0.8.5 I1; one entry, one name): 1620/486.
    // 0.9.9: a dashboard takes no `refresh`, it follows changes (one entry less; the name stays a list's and a view's): 1619/486.
    // 0.9.9: live sync is an App's choice, `live: true` at the root and `live: false` on a resource (two entries; `live` is a form's name already): 1621/486.
    // 1.0.0-rc.1: a chart's `sort`, a group's `empty` and `sum` (three entries, no new name: `sort`, `empty` and `sum` are others' already): 1624/486.
    // 1.0.0-rc.1 forms wave 2 (theme reach): colors.field, shape.height.control and four recipe parts; other rc.1 work counts in the same figure: 1645/494.
    // 1.0.0-rc.1 forms wave 3a (public doors): auth.challenge, a hero's badge, tiles and points (and their keys).
    // 1.0.0-rc.1 forms wave 3b: a palette's `primary` and `onPrimary` (light and dark), and a New form field's `as` (five entries; `onPrimary` is the one new name): 1661/498.
    // 1.0.0-rc.1 retention: the App's `retention` and its `history`, `commands` and `attempts` windows (four entries; `retention`, `history` and `attempts` are new names): 1665/501.
    // PR #12: `ui.pwa`, the PWA opt-in (one entry, one new name): 1666/502.
    assert.deepEqual({ entries, names: names.size }, { entries: 1666, names: 502 });
  });

  test('every enumeration in the app schema is the parser constant', () => {
    /* Five descriptions of the authored surface exist — the parsers, this
       schema, the .d.ts, the client typedefs, the scaffolder — and only
       the parsers are the truth. Pinned here so a kind or a tone added to
       one cannot be missing from the other. */
    assert.deepEqual(
      a.dashSection.oneOf.map((option: { properties: { kind: { const: string } } }) => option.properties.kind.const),
      [...DASH_KINDS],
    );
    assert.deepEqual(dashKind('chart').properties.shape.enum, [...DASH_CHART_SHAPES]);
    assert.deepEqual(a.assistant.properties.tools.items.enum, [...ASSISTANT_TOOLS]);
    assert.deepEqual(a.assistant.properties.blocks.items.enum, [...ASSISTANT_BLOCKS]);
    assert.deepEqual(a.assistant.properties.placement.items.enum, [...ASSISTANT_PLACEMENTS]);
    assert.deepEqual(a.assistant.properties.effort.enum, [...ASSISTANT_EFFORTS]);
    assert.deepEqual(dashKind('metric').properties.better.enum, [...BETTER]);
    assert.deepEqual(a.listView.properties.open.enum, [...OPEN_MODES]);
    assert.deepEqual(a.ui.properties.shell.properties.placement.oneOf[0].enum, [...PLACEMENTS]);
    assert.deepEqual(a.auth.properties.rows.enum, [...ROW_SCOPES]);
    assert.deepEqual(a.roleGrant.properties.operations.items.enum, [...AUTHORED_OPERATIONS]);
    assert.deepEqual(a.auth.properties.providers.items.anyOf[0].enum, [...AUTH_PROVIDERS]);
    // The parser's name rule, or the tenants' `*`.
    assert.equal(a.auth.properties.providers.items.anyOf[1].pattern, OIDC_PROVIDER.source.replace(/\)\$$/, '|\\*)$'));
    assert.deepEqual(a.auth.properties.signUp.anyOf[0].enum, [...SIGN_UP_MODES]);
    assert.deepEqual(a.displayRule.properties.format.enum, [...DISPLAY_FORMATS]);
    assert.deepEqual(a.displayRule.properties.tone.additionalProperties.enum, [...DISPLAY_TONES]);
    assert.deepEqual(a.resource.properties.access.enum, ['write']);
    assert.deepEqual(a.resource.properties.clone.enum, [...RESOURCE_CLONES]);
    /* A custom component: its kinds, its prop types and the keys a read takes, on a page and on a dashboard. */
    assert.deepEqual(a.component.properties.kind.enum, [...COMPONENT_KINDS]);
    assert.equal(a.component.properties.id.pattern, COMPONENT_ID.source);
    assert.deepEqual(
      a.componentProp.oneOf.map((option: { properties: { type: { const: string } } }) => option.properties.type.const),
      [...COMPONENT_PROP_TYPES],
    );
    assert.deepEqual(Object.keys(dashKind('custom').properties.rows.additionalProperties.properties).sort(), [...DASH_READ_KEYS].sort());
    assert.deepEqual(
      Object.keys(pageSchema.$defs.custom.properties.rows.additionalProperties.properties).sort(),
      [...PAGE_READ_KEYS].sort(),
    );
    assert.equal(pageSchema.$defs.custom.properties.rows.maxProperties, MAX_CUSTOM_READS);
    assert.equal(pageSchema.$defs.custom.properties.figures.maxProperties, MAX_CUSTOM_FIGURES);
    // A page's archetypes: the written `record` is accepted and told to be left out, so it is no schema word.
    assert.deepEqual(pageSchema.$defs.appPage.properties.layout.enum, [...PAGE_LAYOUT_WORDS]);
  });

  test('the authored split workspace is declared as a bounded data-only list presentation', () => {
    assert.deepEqual(a.listView.properties.split, { $ref: '#/$defs/splitListDetail' }, 'split is a key of the list view');
    assert.ok(
      !a.presentation.oneOf.some((option: { $ref?: string }) => option.$ref === '#/$defs/splitListDetail'),
      'and not a presentation of its own',
    );
    const split = a.splitListDetail;
    assert.equal(split.additionalProperties, false);
    assert.equal(split.required, undefined);
    assert.equal(split.properties.kind, undefined, 'the key says it');
    assert.equal(split.properties.limit.maximum, 200);
    assert.deepEqual(split.properties.detail, { $ref: '#/$defs/splitShow' });
    assert.equal(split.properties.list, undefined, "the list beside the record is the view's own");
    assert.equal(a.splitShow.maxItems, 64);
    assert.deepEqual(a.splitShow.items, { type: 'string', minLength: 1 }, "a view shows strings; captions are the resource's");
  });

  test('the public examples use the TypeScript DSL', async () => {
    assert.deepEqual(publicExamples(), ['ladle', 'lintel', 'tick']);
    assert.deepEqual(readdirSync(join(EXAMPLES, 'tick')).sort(), ['README.md', 'app.ts'], 'Tick keeps one DSL file and a README');
    for (const app of walkedApps()) {
      const loaded = await loadApp(appDirectory(app));
      assert.ok(loaded.app.name, `${app} names itself`);
      assert.ok(loaded.path.endsWith('/app.ts'), `${app} teaches TypeScript authoring`);
      assert.equal(existsSync(join(appDirectory(app), 'app.json')), false);
      assert.ok(existsSync(join(appDirectory(app), 'README.md')), `${app} has a user/LLM entry point`);
      assert.equal(existsSync(join(appDirectory(app), 'seed.mjs')), false, 'Database setup stays outside App authoring');
    }
  });

  test('the section kinds cover the parser and nothing else', () => {
    const kinds = defs.section.oneOf.map((ref: { $ref: string }) => ref.$ref.split('/').pop());
    assert.deepEqual(kinds, [
      'fields',
      'card',
      'headline',
      'header',
      'current',
      'metric',
      'list',
      'breakdown',
      'chart',
      'note',
      'view',
      'timeline',
      'history',
      'flows',
      'diagram',
      'custom',
    ]);
  });

  test('the renamed spellings do not survive in the schema', () => {
    /* The parser refuses path/of/paths/columns-on-lists/orderBy, a page's
       `onlyOn` and a section's `filter`. A schema still
       declaring one would teach the format the parser now refuses. `columns`
       is legal only where it means the fields layout count. */
    const pages = declaredKeys(pageSchema);
    /* `onlyOn` (1.0) is `connection` again, as the root says it: a page's own connection. */
    for (const gone of ['of', 'paths', 'orderBy', 'filter', 'onlyOn']) {
      assert.ok(!pages.has(gone), `page schema still declares "${gone}"`);
    }
    /* `path` came back as something else: an App page's address, on the page alone, never a section's. */
    const { appPage: _appPage, ...rest } = pageSchema.$defs;
    assert.ok(!declaredKeys(rest).has('path'), 'a page section still declares "path"');
    /* Keys removed outright. `access`, `list` and `detail` live on as other
       things (a resource's ceiling, a split's panes); `menu` is gone everywhere. */
    /* `themes` came back as something else: the themes a tenant's branding picks from, under `branding` alone. */
    const { branding, ...roots } = appSchema.properties;
    assert.ok(branding.properties.themes, 'branding offers its themes');
    const app = declaredKeys({ ...appSchema, properties: roots });
    for (const gone of [
      'writable',
      'defaultSource',
      'themes',
      'visibleWhen',
      'intake',
      'landing',
      'group',
      'meta',
      'mode',
      'rowPolicy',
      'menu',
      'supportLog',
      'supportAudit',
    ]) {
      assert.ok(!app.has(gone), `app schema still declares "${gone}"`);
    }
    // `tenant` returned only as a checked link's explicit destination intent.
    // It is not an App/auth/role grant or private membership evidence.
    const { appTarget, appTargetStatic, ...withoutTargets } = a;
    assert.deepEqual(appTarget.properties.tenant, { $ref: '#/$defs/appTenantIntent' });
    assert.deepEqual(appTargetStatic.allOf[1].properties.tenant.properties.id, { $ref: '#/$defs/appLinkScalar' });
    assert.ok(
      !declaredKeys({ ...appSchema, $defs: withoutTargets }).has('tenant'),
      'tenant intent must remain confined to checked link targets',
    );
    for (const intent of a.appTenantIntent.oneOf) {
      assert.equal(intent.additionalProperties, false);
      assert.ok(
        props(intent).every((key) => key === 'kind' || key === 'id'),
        'tenant intent never carries membership or role evidence',
      );
    }
    assert.ok(!('list' in a.listView.properties), 'a view says presentation');
    for (const [kind, def] of [
      ['checklist', presentationKind('checklist')],
      ['queue', presentationKind('queue')],
      ['board', a.boardList],
    ] as const) {
      assert.ok(!('title' in def.properties) && !('detail' in def.properties), `a ${kind} card is primary and lines`);
    }
    assert.ok(!declaredKeys(a.listView).has('columns'), 'a list view still declares "columns"');
  });

  test('every key the shipped example apps use is a key some schema declares', async () => {
    /* The drift that actually happens: a new config key lands in the
       parser and the examples, and the schema quietly stops describing
       the format. The union is coarse — it does not place keys in
       context — but a missing key is exactly the failure worth catching. */
    const declared = new Set([...declaredKeys(appSchema), ...declaredKeys(pageSchema), ...declaredKeys(themeSchema)]);
    for (const app of walkedApps()) {
      const dir = appDirectory(app);
      const loaded = await loadApp(dir);
      // Inspect authored data, not the parser's normalized/internal fields.
      const manifest = loaded.path.endsWith('.json')
        ? JSON.parse(readFileSync(loaded.path, 'utf8'))
        : (await import(pathToFileURL(loaded.path).href)).default;
      const docs: [string, unknown][] = [[loaded.path, manifest]];
      if (existsSync(join(dir, 'pages'))) {
        for (const f of readdirSync(join(dir, 'pages')).filter((f) => f.endsWith('.json'))) {
          const file = join(dir, 'pages', f);
          docs.push([file, JSON.parse(readFileSync(file, 'utf8'))]);
        }
      }
      for (const [file, doc] of docs) {
        for (const key of usedKeys(doc)) {
          assert.ok(declared.has(key), `${file} uses "${key}", which no schema declares`);
        }
      }
    }
  });
});
