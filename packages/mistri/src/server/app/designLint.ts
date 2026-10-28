/**
 * `mistri check --design`: the composition smells a design audit of
 * agent-built Apps found, read off the definition and the catalog.
 *
 * Dashboards and lists came out well from agents because their grammar makes
 * the layout decisions; record pages, forms and the shell came out basic
 * because nothing said what they were made of. Each rule here is one of those
 * decisions, said where it was missed: the smell, the fix — the DSL to write
 * where one line says it — and the docs topic. Warnings only: a page is the
 * author's to compose, and a rule that cannot see the rendering (how wide a
 * column's values are) judges by count, as the samples do.
 *
 * Pure over the loaded App, its compiled pages and one catalog.
 */
import type { AppDashSection, AppDef, AppDisplayRule, AppListView, ResourceDef } from '../../shared/appModel.js';
import { columnKind, tableNamed, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { declaredDisplayOf, effectiveDisplay, MONEY } from '@mistriwork/engine/shared/displayDefaults.js';
import type { PageDef, PageFields, PageList, PageSection } from '@mistriwork/engine/shared/pageModel.js';
import { tryResolvePath } from '@mistriwork/engine/shared/viewPaths.js';
import { navViewKeys } from '../../shared/appModel.js';
import { repeatedQueries } from '../../shared/appSegments.js';
import { areaBox, layoutGrid, type LayoutGrid } from '@mistriwork/engine/shared/dashLayout.js';
import { drawnLayout } from '@mistriwork/engine/shared/pageLayouts.js';

interface DesignFinding {
  /** The rule's code, as `mistri docs design` lists it. */
  code: string;
  /** Where: `page "order"`, `view "leads"`, `resource "lead"`, `the shell`. */
  at: string;
  /** The page it was found on, whose source file the check can name. */
  page?: string;
  /** The smell, then the fix. */
  text: string;
}

const DOCS = 'mistri docs design';
/* A related list beside an aside has about two thirds of the pane: shot at
   1280 in the top menu's shell (715px), a fifth column was left out as often
   as it was drawn (Payday's department list of five drew three), so four is
   the budget docs/design.md sets, and two in the aside. */
const BESIDE_ASIDE = 4;
const IN_ASIDE = 2;
/* The room, in CSS pixels at 1280 under the App's density zoom, a page's main
   column has beside the aside, the aside itself, and a dashboard's rows at
   half and a third of the page: measured, in the top menu's shell and the
   side menu's. The aside is a third of the record between 256px and 320px
   (page.css): the top menu's shell leaves it 320 and the main column 715;
   beside the side menu it is 269 and the main column 538 — three figures
   and four short columns, where at a fixed 320px it left 487, a pixel short
   of three figures and a column short of four. */
/* `filters`: a list's rows beside its filter rail (`filterBar: 'rail'`),
   measured the same way: the rail keeps 15rem, the rows the rest — 627px
   beside the side menu, 855 under the top menu. The dealer App's inventory
   of eight columns lost its price there. */
/* An article's column: --page-measure, 70ch of the body face (structure.css), about 640px at a desk in any shell. */
const MEASURE = 640;
const ROOM = {
  top: { aside: 715, rail: 320, half: 515, third: 330, 'two-thirds': 740, filters: 855 },
  side: { aside: 538, rail: 269, half: 400, third: 255, 'two-thirds': 600, filters: 627 },
} as const;
/* A dashboard's whole width at 1280 under the same two shells: what `third` (330, 255) and `half` (515, 400) are
   shares of, less the page's 32px column gap. A layout's areas are shares of it. */
const FULL = { top: 1060, side: 832 } as const;
const COLUMN_GAP = 32;
/* The cell a row's own menu sits in (gridSizing.ts GRID_TRAIL_WIDTH). */
const ROW_MENU = 44;
/* A metric card asks for 12rem and the strip's gap (features.css): at a
   desk three share a page's row, and beside a dashboard's aside the main
   column holds as many as fit its width — two beside the side menu. */
const METRIC = 192;
const METRIC_GAP = 24;
/* A summary's figure keeps 9rem and the looks' 28px gap (page.css): four in 660px, three in 488. */
const FIGURE = 144;
const FIGURE_GAP = 28;
/* The scaffold's field groups, named by the columns' types rather than what they mean. */
const SCAFFOLD_GROUPS = /^(details|links|dates|address)$/i;
const STATUS_NAME = /(^|_)(status|state|stage|phase|priority)$/i;
/* The value a new record plainly starts in: what a status's default is when the author forgot to say it. */
const INITIAL_STATE = /^(new|draft|open|pending|todo|to_do|planned|scheduled|onboarding|requested|backlog|active|proposed|submitted)$/i;
const YEAR_NAME = /(^|_)year$/i;
const DESTRUCTIVE_LABEL =
  /^(cancel|delete|deactivate|archive|close|reject|void|decline|deny|discard|suspend|ban|end|terminate|withdraw)\b/i;
const DESTRUCTIVE_VALUE =
  /^(cancell?ed|cancel|closed?|inactive|deactivated|archived?|rejected|void(ed)?|lost|deleted|removed|declined|denied|suspended|banned|ended|terminated|withdrawn)$/i;
/* A heading that names no content: a section, a form's group or step is titled by what it holds. */
const VAGUE_HEADING = /^(details|info|information|data|general|misc|miscellaneous|other|more|fields|properties)$/i;

const quote = (value: string) => JSON.stringify(value).replaceAll('"', "'");
const list = (values: readonly string[]) => `[${values.map(quote).join(', ')}]`;

const titled = (section: { title?: string }, fallback: string) => (section.title ? `"${section.title}"` : fallback);

function tableOf(schema: DatabaseSchema, name: string | undefined): TableMeta | undefined {
  if (!name) return undefined;
  return schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name);
}

/** What the lint reads the App through: its resources by table, and a path's column and dress. */
class Catalog {
  readonly byTable = new Map<string, { name: string; resource: ResourceDef }>();
  constructor(
    readonly app: AppDef,
    readonly schema: DatabaseSchema,
  ) {
    const declared = declaredDisplayOf(app, schema);
    for (const [name, resource] of Object.entries(app.resources ?? {})) {
      const table = tableOf(schema, resource.physical ?? name);
      /* Read as drawn: a convention the platform applies (displayDefaults.ts) dresses the column as a written rule would. */
      if (table && !this.byTable.has(table.id))
        this.byTable.set(table.id, {
          name,
          resource: { ...resource, display: effectiveDisplay(resource.display, table, { machine: resource.machine, schema, declared }) },
        });
    }
  }
  table(name: string | undefined) {
    return tableOf(this.schema, name);
  }
  resolve(tableId: string, path: string): { table: TableMeta; column: ColumnMeta; rollup: boolean } | undefined {
    const { resolved } = tryResolvePath(this.schema, tableId, path);
    return resolved ? { table: resolved.table, column: resolved.column, rollup: Boolean(resolved.rollup) } : undefined;
  }
  /** The display rule a path wears: the base resource's own for the path, else the column's resource's. */
  dress(tableId: string, path: string): AppDisplayRule | undefined {
    const own = this.byTable.get(tableId)?.resource.display?.[path];
    if (own) return own;
    const landed = this.resolve(tableId, path);
    return landed ? this.byTable.get(landed.table.id)?.resource.display?.[landed.column.name] : undefined;
  }
  resourceName(tableId: string) {
    return this.byTable.get(tableId)?.name ?? tableId;
  }
}

/* A served view says what it is by its keys: a list names its table, a dashboard has sections, a form a command. */
const asList = (view: unknown): AppListView | undefined =>
  view && typeof view === 'object' && Object.hasOwn(view, 'table') && !Object.hasOwn(view, 'command') ? (view as AppListView) : undefined;
const asDashboard = (view: unknown): { sections: AppDashSection[]; areas?: string[] } | undefined =>
  view && typeof view === 'object' && Object.hasOwn(view, 'sections')
    ? (view as { sections: AppDashSection[]; areas?: string[] })
    : undefined;

const visible = (section: PageSection) => !section.hidden;
const inAside = (section: PageSection) => section.region === 'aside';
const isCards = (section: PageList) => section.presentation !== undefined;

/** A list section's columns: its own, or, for an embed, its view's. */
function listColumns(app: AppDef, section: PageList): string[] {
  if (section.columns?.length) return section.columns;
  const view = section.view ? asList(app.views[section.view]) : undefined;
  return [...(view?.show ?? [])];
}

/**
 * About how wide a column must be to be drawn, by what it holds — the grid's
 * own floors (gridSizing.ts), read off the catalog rather than the values: a
 * yes or no 64px, a day 112, a moment 176, a number 88, a chip its word and
 * its dot, a text 120 (the name gives way to that before any column is left
 * out), and never narrower than its heading. Where a table's columns add up
 * past the room, the grid leaves the last ones out.
 */
function columnWidth(catalog: Catalog, tableId: string | undefined, path: string): number {
  const last = path.split('.').pop() ?? path;
  const head = Math.min(last.replace(/_id$/, '').length, 22) * 7 + 28;
  const landed = tableId ? catalog.resolve(tableId, path) : undefined;
  if (!landed) return Math.max(head, 120);
  const { column } = landed;
  const rule = catalog.dress(tableId!, path);
  const kind = columnKind(column.type);
  if (column.flag || kind === 'boolean') return Math.max(head, 64);
  if (column.allowed?.length && !column.references) {
    const word = Math.max(...column.allowed.map((value) => value.length));
    return Math.max(head, rule?.tone ? Math.min(216, (word + 4) * 8 + 24) : Math.max(80, word * 8 + 24));
  }
  if (kind === 'date') return Math.max(head, /time/i.test(column.type) ? 176 : 112);
  if (kind === 'number' && !column.references) return Math.max(head, rule?.format === 'money' ? 104 : 88);
  return Math.max(head, 120);
}

/** The columns a table keeps in `room`: the first, the name and the status always, then the rest in order while they fit. */
function keptColumns(catalog: Catalog, tableId: string | undefined, columns: readonly string[], room: number): string[] {
  const widths = columns.map((path) => columnWidth(catalog, tableId, path));
  if (widths.reduce((sum, width) => sum + width, 0) <= room) return [...columns];
  const table = tableId ? catalog.table(tableId) : undefined;
  const kept = columns.map(
    (path, index) =>
      index === 0 ||
      (!path.includes('.') && Boolean(table?.columns.find((column) => column.name === path)?.allowed?.length) && STATUS_NAME.test(path)),
  );
  let left = room - widths.reduce((sum, width, index) => sum + (kept[index] ? width : 0), 0);
  let full = false;
  widths.forEach((width, index) => {
    if (kept[index] || full) return;
    if (width > left) {
      full = true;
      return;
    }
    kept[index] = true;
    left -= width;
  });
  return columns.filter((_, index) => kept[index]);
}

/** A few of the table's own columns that say what a record is at a glance: its vocabularies, references and dates. */
function glanceColumns(table: TableMeta): string[] {
  const named = /^(name|title|label)$/i;
  const wanted = table.columns.filter(
    (column) =>
      !column.primaryKey && !named.test(column.name) && (column.allowed?.length || column.references || /date|time/i.test(column.type)),
  );
  return wanted.slice(0, 4).map((column) => column.name);
}

/** The menu the App is drawn in, which sets how wide a page's main column is at a desk. */
function shellOf(app: AppDef): 'top' | 'side' {
  const shell = app.ui?.shell;
  return shell?.placement === 'top' || !app.nav?.length ? 'top' : 'side';
}

/** Rules 1–3, 5–10 and 12: one record page's composition. */
function pageFindings(catalog: Catalog, page: PageDef): DesignFinding[] {
  const found: DesignFinding[] = [];
  const at = `page "${page.id}"`;
  const say = (code: string, text: string) => found.push({ code, at, page: page.id, text });
  const base = catalog.table(page.base);
  const sections = (page.sections ?? []).filter(visible);
  const main = sections.filter((section) => !inAside(section));
  const aside = sections.filter(inAside);
  const lists = (from: PageSection[]) => from.filter((section): section is PageList => section.kind === 'list');
  const fieldsOf = (from: PageSection[]) => from.filter((section): section is PageFields => section.kind === 'fields');

  // 1. Too many columns beside an aside, at the width the shell leaves.
  const shell = shellOf(catalog.app);
  const menu = shell === 'side' ? ' and the side menu' : '';
  const toTop = shell === 'side' ? ", or draw the menu on top: ui: { shell: { placement: 'top' } }" : '';
  /* What stands beside the aside: a showcase's body is under its showcase band at full width, so only the photos
     stand beside its panel (pageLayouts.ts). */
  const layout = drawnLayout(page);
  const beside = layout === 'showcase' ? [] : main;
  /* An article's column is the reading measure wherever the shell is: its lists are judged at that width. */
  const article = layout === 'article';
  if (aside.length || article) {
    /* One finding for the page: a sample with a strip of tabbed lists would otherwise say it once a tab. */
    const over = lists(beside)
      .map((section) => {
        const narrow = section.width === 'half' || section.width === 'third';
        const room = article ? (narrow ? MEASURE / 2 : MEASURE) : ROOM[shell][narrow ? 'third' : 'aside'];
        const columns = listColumns(catalog.app, section);
        const from = catalog.table(section.from || (section.view ? asList(catalog.app.views[section.view])?.table : undefined))?.id;
        const kept = keptColumns(catalog, from, columns.slice(0, narrow ? 3 : BESIDE_ASIDE), room);
        return {
          section,
          columns,
          kept,
          room,
          over: !isCards(section) && (columns.length > (narrow ? 3 : BESIDE_ASIDE) || kept.length < columns.length),
        };
      })
      .filter((entry) => entry.over);
    if (over.length) {
      say(
        'aside-columns',
        `${over.map(({ section, columns, kept }) => `${titled(section, 'a related list')} (${columns.length} columns, ${kept.length} drawn)`).join(', ')} ${over.length === 1 ? 'stands' : 'stand'} ${article ? "in the article's reading column" : `beside the aside${menu}`}, ` +
          `where a desk has room for about ${over[0].room}px of columns: the rest are left out, keeping the first, the name and the status ` +
          `→ show the ones that matter most: ${over.map(({ section, kept }) => `${over.length > 1 ? `${titled(section, 'the list')} ` : ''}show: ${list(kept)}`).join('; ')}; ${article ? "or leave out layout: 'article', and the list has the page's width" : `or move the aside's sections into the main column${toTop}`}.`,
      );
    }
  }
  if (aside.length) {
    // 3b. A summary that wraps beside the aside.
    const figures = Math.floor((ROOM[shell].aside + FIGURE_GAP) / (FIGURE + FIGURE_GAP));
    for (const section of fieldsOf(beside)) {
      const paths = section.paths ?? [];
      if ((section.presentation && section.presentation !== 'summary') || section.columns || paths.length <= figures) continue;
      say(
        'aside-summary',
        `the summary's ${paths.length} figures stand beside the aside${menu}, where ${figures} share a row at a desk: the rest wrap onto a second row ` +
          `→ keep the ${figures} that matter most: fields(${list(paths.slice(0, figures))})${toTop}.`,
      );
    }
    // 2. A wide table in the aside.
    for (const section of lists(aside)) {
      const columns = listColumns(catalog.app, section);
      if (isCards(section) || columns.length <= IN_ASIDE) continue;
      say(
        'aside-table',
        `${titled(section, 'a list')} in the aside shows ${columns.length} columns in about ${ROOM[shell].rail}px → show ${IN_ASIDE}: show: ${list(columns.slice(0, IN_ASIDE))}, ` +
          'or draw it as cards: presentation: cards(...).',
      );
    }
    // 3. Metric cards beside an aside.
    const metrics = beside.filter((section) => section.kind === 'metric');
    if (metrics.length >= 3) {
      say(
        'aside-metrics',
        `${metrics.length} metric cards beside the aside wrap onto a second row → name them as rollups on the resource ` +
          `(rollups: { open: count('…', { query: 'status = open' }) }) and show them as fields([...], { presentation: 'summary' }), or drop the aside.`,
      );
    }
  }

  // 5. Stacked related lists, unless the page says so on purpose (listTabs: false) or is a document: paper has no
  //    tabs (appDocuments.ts), so its lists are every line, one under another, by design.
  if (page.listTabs === undefined && page.document === undefined) {
    let run: PageList[] = [];
    const flush = () => {
      /* A list of the one row that matters — the current lease, the latest visit — is a card, not a tab. */
      const one = run.find((section) => section.limit === 1 || /^(current|latest|active|next|last)\b/i.test(section.title ?? ''));
      if (run.length >= 2)
        say(
          'stacked-lists',
          `${run.length} related lists stand one under another (${run.map((section) => titled(section, 'untitled')).join(', ')}), a scroll away from the record ` +
            '→ draw them as one tab strip: page(…, [...], { listTabs: true })' +
            (one
              ? `; and ${titled(one, 'the one-row list')} is one row, a card: current(${quote(one.title ?? '…')}, ${quote(one.from)}, ${quote(one.path)}, { query: '…', sort: '… desc' }).`
              : '.'),
        );
      run = [];
    };
    for (const section of main) {
      /* A gallery, cards or a file's attachments draw as themselves, not as one more table. */
      const table =
        section.kind === 'list' &&
        !section.width &&
        !section.tab &&
        !section.presentation &&
        !catalog.byTable.get(catalog.table(section.from)?.id ?? '')?.resource.file;
      if (table) run.push(section as PageList);
      else flush();
    }
    flush();
  }

  // 6. A title and nothing else: a page of some size that opens on a block of plain fields or a table, with no header.
  /* A header is drawn in the record's head wherever it is written, so it opens the page from anywhere. */
  const header = fieldsOf(sections).find((section) => section.presentation === 'header');
  const main0 = main.filter((section) => !(section.kind === 'fields' && section.presentation === 'header'));
  const first = main0[0];
  /* One field under a heading is a text the page opens with (a board's "About"), not a block. */
  const plain =
    first &&
    ((first.kind === 'fields' && !first.workflow && (first.paths?.length ?? 0) >= 2 && !first.presentation) ||
      (first.kind === 'list' && !first.presentation));
  if (plain && !header && base && sections.length >= 3) {
    const glance = glanceColumns(base);
    const status = base.columns.find((column) => column.allowed?.length && STATUS_NAME.test(column.name))?.name;
    const facts = glance.filter((name) => name !== status).slice(0, 3);
    say(
      'bare-title',
      `the record's title stands alone: the page opens with ${first.kind === 'fields' ? 'a block of fields' : 'a table'} → give it a head: ` +
        `header({ ${status ? `status: ${quote(status)}, ` : ''}facts: ${facts.length ? list(facts) : '[...]'} }), then its figures as fields([...]).`,
    );
  }

  /* A header's primary that names none of the record's verbs is a problem the validation step names (apps.ts): an id is checked, not advised on. */

  // 7. Fields grouped by type.
  const scaffolded = fieldsOf(sections).filter((section) => !section.presentation && SCAFFOLD_GROUPS.test(section.title ?? ''));
  if (scaffolded.length >= 2) {
    say(
      'fields-by-type',
      `fields are grouped by their type (${scaffolded.map((section) => `"${section.title}"`).join(', ')}), not by what they mean → a summary of the 3–4 that matter (fields([...])), ` +
        "the rest as a properties rail in the aside (fields([...], { region: 'aside' })), and long attribute lists as a sheet (presentation: 'table', columns: 2).",
    );
  }

  /* The default is the same call: the aside's fields are a properties rail, the main column's a summary. */
  for (const section of fieldsOf(sections)) {
    const aside = section.region === 'aside';
    if ((aside && section.presentation === 'properties') || (!aside && section.presentation === 'summary')) {
      say(
        'default-presentation',
        `${section.title ? `"${section.title}"` : 'a fields section'} says presentation: '${section.presentation}', which is what fields() ${aside ? 'in the aside' : 'in the main column'} already draws → leave it out.`,
      );
    }
  }

  for (const section of sections) {
    const title = (section as { title?: unknown }).title;
    if (typeof title === 'string' && VAGUE_HEADING.test(title.trim())) {
      say(
        'vague-heading',
        `"${title}" names no content → title the section by what it holds: the record's noun for its own fields ('Patient'), 'Contact', 'Terms', 'Care'.`,
      );
    }
  }

  for (const section of fieldsOf(sections)) {
    const paths = section.paths ?? [];
    // 8. A card with no facts.
    if (section.presentation === 'card' && paths.length === 1) {
      say(
        'thin-card',
        `the card for "${paths[0]}" shows its record's name only → add two or three of its fields: card(title, ${quote(paths[0])}, ['…', '…']).`,
      );
    }
    // 9. Unlabeled facts: a facts line's, or a header's without its `{ column, after }` word.
    if ((section.presentation === 'facts' || section.presentation === 'header') && base) {
      for (const path of paths) {
        const unit = section.factLabels?.[path] ? undefined : unitless(catalog, base.id, path);
        if (unit)
          say(
            'unitless-fact',
            `the ${section.presentation === 'header' ? 'header' : 'facts line'}'s "${path}" is a bare number, so "3 · 1" reads as a code → give it a unit, display: { ${unit}: { unit: '…' } }, ` +
              `or a word after it: { column: ${quote(path)}, after: '…' }.`,
          );
      }
    }
    // 10. A headline's figure said again under it.
    if (section.presentation === 'headline' && section.subfigure && paths.includes(section.subfigure)) {
      say('shown-twice', `the headline shows "${section.subfigure}" and again as its subfigure → drop one of them.`);
    }
    // 12. A thin workflow.
    const flow = section.workflow;
    if (flow && base) {
      const allowed = catalog.resolve(base.id, flow.field)?.column.allowed ?? [];
      const outside = allowed.filter((value) => !flow.steps.some((step) => step.value === value));
      if (flow.steps.length <= 2 || (allowed.length && outside.length > allowed.length / 2)) {
        say(
          'thin-workflow',
          `the workflow over "${flow.field}" has ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}${outside.length ? ` and leaves ${outside.length} of its ${allowed.length} values outside` : ''}: ` +
            'a strip needs an ordered pipeline → keep it for 3–6 steps in order, and let side exits (cancelled, no-show) wear tones: display: { …: { tone: { … } } }.',
        );
      }
    }
  }

  /* Not a figure in the summary and again in the properties rail: the rail is
     where a value is edited in place, so Depot's reorder point stands in both on
     purpose — the stock figures it is read against, and the field that sets it. */
  return found;
}

/** A path that lands on a bare number in a line of facts: no unit, no money, no words. Its column name, or undefined. */
function unitless(catalog: Catalog, tableId: string, path: string): string | undefined {
  const landed = catalog.resolve(tableId, path);
  if (!landed || landed.column.primaryKey || landed.column.references || landed.column.flag || landed.column.allowed?.length)
    return undefined;
  if (!/int|numeric|decimal|real|double|float/i.test(landed.column.type) && !landed.rollup) return undefined;
  if (YEAR_NAME.test(landed.column.name)) return undefined;
  const rule = catalog.dress(tableId, path);
  if (rule && (rule.unit || rule.values || rule.component || (rule.format && rule.format !== 'number'))) return undefined;
  return path;
}

/** Every path the App shows over a table: list views' columns and cards, pages' fields and lists. */
function shownPaths(catalog: Catalog, pages: readonly PageDef[]): Map<string, Set<string>> {
  const shown = new Map<string, Set<string>>();
  const add = (tableName: string | undefined, paths: readonly unknown[]) => {
    const table = catalog.table(tableName);
    if (!table) return;
    const set = shown.get(table.id) ?? new Set<string>();
    for (const path of paths) {
      const text = typeof path === 'string' ? path : (path as { column?: unknown })?.column;
      if (typeof text === 'string') set.add(text);
    }
    shown.set(table.id, set);
  };
  for (const view of Object.values(catalog.app.views).map(asList)) {
    if (!view) continue;
    const shape = view.presentation as Record<string, unknown> | undefined;
    add(view.table, [
      ...(view.show ?? []),
      ...['primary', 'value', 'badge'].map((key) => shape?.[key]),
      ...(Array.isArray(shape?.lines) ? shape.lines : []),
      ...(Array.isArray(shape?.facts) ? shape.facts : []),
    ]);
  }
  for (const page of pages) {
    for (const section of page.sections ?? []) {
      if (section.hidden) continue;
      if (section.kind === 'fields') add(page.base, section.paths ?? []);
      if (section.kind === 'list')
        add(section.from || (section.view ? asList(catalog.app.views[section.view])?.table : undefined), listColumns(catalog.app, section));
    }
  }
  return shown;
}

/** A vocabulary's tones written out: its first values named, the rest neutral. */
const toneSketch = (values: readonly string[]) =>
  `{ tone: { ${[...values.slice(0, 3).map((value) => `${quote(value)}: '…'`), "'*': 'neutral'"].join(', ')} } }`;

/** Rules 11, 13–15 and 17: what one resource says about its values, its name, its form and its verbs. */
function resourceFindings(catalog: Catalog, shown: Map<string, Set<string>>, pages: readonly PageDef[]): DesignFinding[] {
  const found: DesignFinding[] = [];
  for (const [tableId, { name, resource }] of catalog.byTable) {
    const table = catalog.table(tableId)!;
    const at = `resource "${name}"`;
    const say = (code: string, text: string) => found.push({ code, at, text });
    const paths = shown.get(tableId) ?? new Set<string>();
    const own = (column: string) => paths.has(column) || [...paths].some((path) => path === column);

    // 13. A status shown as plain words. (Money and a 0/1 flag are dressed by convention: displayDefaults.ts.)
    for (const column of table.columns) {
      if (!own(column.name) || column.primaryKey || column.references) continue;
      const rule = resource.display?.[column.name];
      if (column.allowed?.length && !column.flag && STATUS_NAME.test(column.name) && !rule?.tone && !rule?.icons && !rule?.component) {
        say(
          'undressed-vocabulary',
          `"${column.name}" (${column.allowed.slice(0, 4).join(', ')}${column.allowed.length > 4 ? ', …' : ''}) draws as plain words, so a state reads as body text ` +
            `→ give it tones: display: { ${column.name}: ${toneSketch(column.allowed)} }.`,
        );
      }
    }

    // 15. A template that prints a timestamp or a decimal raw.
    if (typeof resource.recordLabel === 'string' && resource.recordLabel.includes('{')) {
      const fields = [...resource.recordLabel.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      /* A day beside the parent it tells apart is a name: a monthly charge is
         "Cole Moreau · rent due 2026-08-31", and refused it became "Cole Moreau ·
         rent", six times on one screen. A date alone, a time or an amount is not. */
      const parented = fields.some((path) => path.includes('.') || catalog.resolve(tableId, path)?.column.references);
      const raw = fields.filter((path) => {
        const landed = catalog.resolve(tableId, path);
        if (!landed || landed.column.references) return false;
        const type = landed.column.type;
        const day = /date/i.test(type) && !/time/i.test(type);
        return day ? !parented : /time/i.test(type) || MONEY.test(landed.column.name) || Boolean(resource.types?.[path]);
      });
      if (raw.length)
        say(
          'raw-label',
          `recordLabel ${quote(resource.recordLabel)} names ${list(raw)}, which a template prints raw (2026-08-31 14:03:00, 1450.5) ` +
            "→ name the record by words and references: '{…_id} · {kind}'; a day may tell siblings apart beside its parent: '{lease_id} · rent due {due_on}'.",
        );
    }

    // 17. A New form that cannot be saved, or whose status starts unset.
    const form = resource.form;
    const asked = form ? (form.show ?? form.steps?.flatMap((step) => step.fields ?? []) ?? []) : [];
    if (form && asked.length) {
      const given = (field: string) => form.defaults?.[field] !== undefined;
      const left = table.columns
        .filter((column) => required(column) && !column.primaryKey && !asked.includes(column.name) && !given(column.name))
        .map((column) => column.name);
      if (left.length)
        say(
          'required-unfilled',
          `the New form does not ask for ${list(left)}, which ${table.name} requires and nothing fills, so it can never be saved → add ${left.length === 1 ? 'it' : 'them'} to form.show, or give ${left.length === 1 ? 'it' : 'each'} a default: form: { defaults: { ${left[0]}: … } }.`,
        );
      for (const field of asked) {
        const column = table.columns.find((candidate) => candidate.name === field);
        const start = column?.allowed?.find((value) => INITIAL_STATE.test(value));
        if (!column || !start || !STATUS_NAME.test(column.name) || !required(column) || given(field)) continue;
        say(
          'required-unfilled',
          `the New form asks for "${field}" with nothing chosen, though a new record plainly starts ${quote(start)} → form: { defaults: { ${field}: ${quote(start)} } }.`,
        );
      }
    }

    // 11b. A page whose only verbs end the record: nothing is filled, so nothing says what to do next.
    const destructive = (action: NonNullable<ResourceDef['actions']>[number]) =>
      DESTRUCTIVE_LABEL.test(action.label) ||
      ('set' in action && action.set ? Object.values(action.set).some((value) => DESTRUCTIVE_VALUE.test(String(value))) : false);
    const heads = pages
      .filter((page) => catalog.table(page.base)?.id === tableId)
      .map((page) =>
        (page.sections ?? []).find((section): section is PageFields => section.kind === 'fields' && section.presentation === 'header'),
      );
    if (heads.length && resource.actions?.length && resource.actions.every(destructive)) {
      const labels = resource.actions.map((action) => action.label);
      const ids = resource.actions.map((action) => action.id);
      /* A header that already names every one of them as destructive says the
         record is meant to have no step forward: a closing verb alone is the design. */
      const named = heads.every((head) => head && ids.every((id) => head.destructive?.includes(id)));
      // A header names a verb by its action's id, the key it has in the resource's `actions`.
      if (!named)
        say(
          'no-forward-verb',
          `its only action${labels.length === 1 ? '' : 's'}, ${labels.map((label) => `"${label}"`).join(', ')}, end${labels.length === 1 ? 's' : ''} the record, so its page offers no step forward ` +
            "→ add the verb the work moves on by, first: actions: { start: action('…', { set: { status: '…' } }), … }, or a related list's create (create: { label: 'Book visit', … }); " +
            `or, if ending it is the whole of the work, name the ending in the header by its id: header({ destructive: ${list(ids)} }).`,
        );
    }
    // Vague headings in the New form: a group or a step is named by what it holds.
    for (const part of [...(resource.form?.groups ?? []), ...(resource.form?.steps ?? [])]) {
      if (VAGUE_HEADING.test(part.label?.trim() ?? ''))
        say(
          'vague-heading',
          `the New form's "${part.label}" names no content → name it by what it holds: the record's noun, 'Contact', 'Terms', 'Schedule'.`,
        );
    }

    // 11. A destructive verb first, where nothing puts it last.
    const first = resource.actions?.[0];
    if (first && resource.actions!.length > 1 && !resource.actions!.every(destructive)) {
      const sets = 'set' in first && first.set ? Object.entries(first.set).map(([column, value]) => [column, String(value)] as const) : [];
      const ends = DESTRUCTIVE_LABEL.test(first.label) || sets.some(([, value]) => DESTRUCTIVE_VALUE.test(value));
      /* A record's head draws last what asks for a confirmation and what sets a value toned bad, header or not
         (actionOrder.ts); what a header names in `destructive`, only on that header's page. */
      const readAsDestructive =
        ('confirm' in first && first.confirm) || sets.some(([column, value]) => resource.display?.[column]?.tone?.[value] === 'bad');
      const quiet = (header: PageFields) => header.destructive?.includes(first.id);
      const headers = pages
        .filter((page) => catalog.table(page.base)?.id === tableId)
        .map((page) =>
          (page.sections ?? []).find((section): section is PageFields => section.kind === 'fields' && section.presentation === 'header'),
        );
      if (ends && !readAsDestructive && !(headers.length && headers.every((header) => header && quiet(header)))) {
        say(
          'destructive-first',
          `its first action, "${first.label}", ends or undoes the record, and the first action is the filled button → put the forward verb first ` +
            `(actions: { ${resource.actions!.find((action) => action !== first)!.id}: …, …, ${first.id}: … }), or name it in its page's header({ destructive: [${quote(first.id)}] }), which draws it last and quiet.`,
        );
      }
    }
  }
  // 17. A related create that cannot be saved.
  for (const page of pages) {
    for (const section of page.sections ?? []) {
      if (section.kind !== 'list' || !section.create?.show || !section.from) continue;
      const child = catalog.table(section.from);
      if (!child) continue;
      const childForm = catalog.byTable.get(child.id)?.resource.form;
      const bound = new Set([
        section.path.split('.')[0],
        ...section.create.show,
        ...Object.keys(section.create.prefill ?? {}),
        ...Object.keys(section.create.defaults ?? {}),
        ...Object.keys(childForm?.defaults ?? {}),
        ...[...(section.filter ?? '').matchAll(/(\w+)\s*(?:=|\bin\b)/gi)].map((match) => match[1]),
      ]);
      const missing = child.columns
        .filter((column) => required(column) && !column.primaryKey && !bound.has(column.name))
        .map((column) => column.name);
      if (missing.length)
        found.push({
          code: 'required-unfilled',
          at: `page "${page.id}"`,
          page: page.id,
          text: `${titled(section, 'a related list')}'s "${section.create.label}" asks for ${list(section.create.show)} but not ${list(missing)}, which "${child.name}" requires, so the new row is refused → add them to show, or fill them: create: { …, defaults: { ${missing[0]}: … } } or prefill: { ${missing[0]}: '…' }.`,
        });
    }
  }
  return found;
}

/** A column a new row must be given: not null, and nothing fills it on its own. */
const required = (column: ColumnMeta) => !column.nullable && column.default === undefined && !column.hasDefault && !column.identity;

/** Rule 4: a dashboard whose last metric wraps onto a row of its own. Metrics sit three to a row unless widths say otherwise.
    Rule 20: a dashboard's rows in part of a row with more columns than it has room for, judged by what they hold. */
function dashboardFindings(catalog: Catalog): DesignFinding[] {
  const found: DesignFinding[] = [];
  for (const [key, view] of Object.entries(catalog.app.views)) {
    const dashboard = asDashboard(view);
    const sections = dashboard?.sections;
    if (!sections) continue;
    const shell = shellOf(catalog.app);
    const grid = dashboard.areas ? layoutGrid(dashboard.areas) : undefined;
    /* On a layout a section is as wide as its area (columns it spans of the equal tracks), not what a width word says. */
    const roomOf = (section: AppDashSection): { room: number; said: string } | undefined => {
      if (grid && section.area !== undefined) {
        const room = areaRoom(grid, section.area, FULL[shell]);
        return room === undefined ? undefined : { room: room.width, said: `${room.columns} of ${grid[0]?.length} columns wide` };
      }
      const width = 'width' in section ? section.width : undefined;
      return width === 'half' || width === 'third' || width === 'two-thirds'
        ? { room: ROOM[shell][width], said: `${width} width` }
        : undefined;
    };
    const crowded = sections.flatMap((section) => {
      const placed = roomOf(section);
      if (section.kind !== 'rows' || !placed || !section.show?.length) return [];
      const kept = keptColumns(catalog, catalog.table(section.table)?.id, section.show, placed.room);
      return kept.length < section.show.length ? [{ section, show: section.show, kept, width: placed.said }] : [];
    });
    if (crowded.length) {
      found.push({
        code: 'dashboard-columns',
        at: `view "${key}"`,
        text:
          `${crowded.map(({ section, show, kept, width }) => `${titled(section, 'a rows section')} (${show.length} columns at ${width}, ${kept.length} drawn)`).join(', ')} ` +
          `${crowded.length === 1 ? 'has' : 'have'} no room for the rest at a desk: they are left out, keeping the first, the name and the status ` +
          `→ show the ones that fit: ${crowded.map(({ section, kept }) => `${crowded.length > 1 ? `${titled(section, 'the rows')} ` : ''}show: ${list(kept)}`).join('; ')}; or ${grid ? 'give it an area of more columns' : "give it width: 'full'"}.`,
      });
    }
    if (grid) {
      narrowFindings(sections, grid, key, found);
      stripFindings(key, sections, grid, FULL[shell], found);
      continue;
    }
    /* Consecutive metrics are one strip (Dashboard.tsx), each strip wrapping
       on its own; beside an aside a row holds what the main column's width does. */
    const aside = Boolean((view as { aside?: unknown[] }).aside?.length);
    const perRow = aside ? Math.max(1, Math.floor((ROOM[shellOf(catalog.app)].aside + METRIC_GAP) / (METRIC + METRIC_GAP))) : 3;
    const strips: AppDashSection[][] = [];
    sections.forEach((section, index) => {
      if (section.kind !== 'metric') return;
      if (index > 0 && sections[index - 1].kind === 'metric') strips[strips.length - 1].push(section);
      else strips.push([section]);
    });
    for (const metrics of strips) {
      const count = metrics.length;
      /* A strip at a third of the row asks three cards of the main column: beside the side menu and an aside it holds two. */
      if (aside && perRow < 3 && count % perRow === 1 && metrics.every((section) => 'width' in section && section.width === 'third')) {
        found.push({
          code: 'lone-metric',
          at: `view "${key}"`,
          text:
            `its ${count} metrics at width 'third' sit ${perRow === 1 ? 'one' : 'two'} to a row beside the aside, so the last one wraps alone and stretches across the page ` +
            `→ leave the aside out of this dashboard, or make the strip ${Math.floor(count / perRow) * perRow || perRow} or ${Math.ceil(count / perRow) * perRow} with no width.`,
        });
        continue;
      }
      if (count <= perRow || metrics.some((section) => 'width' in section && section.width) || count % perRow === 0) continue;
      const alone = count % perRow === 1;
      const lower = Math.floor(count / perRow) * perRow || perRow;
      found.push({
        code: 'lone-metric',
        at: `view "${key}"`,
        text:
          `its ${count} metrics sit ${perRow === 2 ? 'two' : 'three'} to a row${aside ? ' beside the aside' : ''}, ` +
          `so the last ${alone ? 'one wraps alone and stretches across the page' : `${count % perRow} wrap and stretch`} ` +
          `→ ${count === 4 && perRow === 3 ? "give the four width: 'half' (two rows of two), or " : ''}make it ${lower} or ${Math.ceil(count / perRow) * perRow}.`,
      });
    }
  }
  return found;
}

/** The room an area has at a desk: the columns it spans of the template's equal tracks, and the width they come to. */
function areaRoom(grid: LayoutGrid, area: string, full: number): { columns: number; width: number } | undefined {
  const box = areaBox(grid, area);
  if (!box) return undefined;
  const count = grid[0]?.length ?? 1;
  const track = (full - COLUMN_GAP * (count - 1)) / count;
  return { columns: box.columns, width: Math.round(box.columns * track + COLUMN_GAP * (box.columns - 1)) };
}

/** Rule 24: a table-shaped section in a one-column area of a template three or four columns wide. At that width a list is
    names, not a table, and a matrix has no room for its columns. */
function narrowFindings(sections: AppDashSection[], grid: LayoutGrid, key: string, found: DesignFinding[]): void {
  if ((grid[0]?.length ?? 0) < 3) return;
  const narrow = sections.filter(
    (section) =>
      (section.kind === 'rows' || section.kind === 'matrix') && section.area !== undefined && areaBox(grid, section.area)?.columns === 1,
  );
  for (const section of narrow) {
    const what = section.kind === 'matrix' ? 'a matrix' : section.view ? 'an embedded list' : 'a list';
    found.push({
      code: 'area-too-narrow',
      at: `view "${key}"`,
      text:
        `${titled(section, what)} stands in "${section.area}", one column of ${grid[0]?.length}: at that width ${what} is names, not a table ` +
        `→ give "${section.area}" two columns of the template, or put a breakdown or a metric there and the table in a wider area.`,
    });
  }
}

/** Rule 4 on a layout: the metrics stacked in one area are a strip of their own, as many to a row as that area holds. */
function stripFindings(key: string, sections: AppDashSection[], grid: LayoutGrid, full: number, found: DesignFinding[]): void {
  const areas = new Set(sections.map((section) => section.area));
  for (const area of areas) {
    const room = area === undefined ? undefined : areaRoom(grid, area, full);
    if (!room) continue;
    const perRow = Math.min(3, Math.max(1, Math.floor((room.width + METRIC_GAP) / (METRIC + METRIC_GAP))));
    const strips: AppDashSection[][] = [];
    const inArea = sections.filter((section) => section.area === area);
    inArea.forEach((section, index) => {
      if (section.kind !== 'metric') return;
      if (index > 0 && inArea[index - 1].kind === 'metric') strips[strips.length - 1].push(section);
      else strips.push([section]);
    });
    for (const metrics of strips) {
      const count = metrics.length;
      if (count <= perRow || count % perRow === 0) continue;
      const alone = count % perRow === 1;
      const lower = Math.floor(count / perRow) * perRow || perRow;
      found.push({
        code: 'lone-metric',
        at: `view "${key}"`,
        text:
          `its ${count} metrics in "${area}" sit ${perRow === 2 ? 'two' : 'three'} to a row, ` +
          `so the last ${alone ? 'one wraps alone and stretches across the area' : `${count % perRow} wrap and stretch`} ` +
          `→ make it ${lower} or ${Math.ceil(count / perRow) * perRow}.`,
      });
    }
  }
}

/** Rule 22: a list whose columns do not fit beside its filter rail, at a desk 1280 wide: the last ones are left out. */
function railFindings(catalog: Catalog): DesignFinding[] {
  const found: DesignFinding[] = [];
  const shell = shellOf(catalog.app);
  for (const [key, raw] of Object.entries(catalog.app.views)) {
    const view = asList(raw);
    if (!view || (view as { filterBar?: unknown }).filterBar !== 'rail' || view.presentation || !view.show?.length) continue;
    const room = ROOM[shell].filters - ((view as { rowActions?: unknown }).rowActions ? ROW_MENU : 0);
    const tableId = catalog.table(view.table)?.id;
    const kept = keptColumns(catalog, tableId, view.show, room);
    if (kept.length === view.show.length) continue;
    const dropped = view.show.filter((column) => !kept.includes(column));
    found.push({
      code: 'rail-columns',
      at: `view "${key}"`,
      text:
        `its ${view.show.length} columns stand beside the filter rail${shell === 'side' ? ' and the side menu' : ''}, ` +
        `where a desk has room for about ${room}px of columns: ${kept.length} are drawn and ${list(dropped)} ${dropped.length === 1 ? 'is' : 'are'} left out, ` +
        `keeping the first, the name and the status → show the ones that matter most, first: show: ${list(kept)}; ` +
        `or put the filters above the rows: drop filterBar: 'rail'.`,
    });
  }
  return found;
}

/** Rule 23: a list board's card category naming a reference. A card's lines and footer say a reference by the name it
    points at (listReferenceNames, BoardList's namedCell); its category is a tag colored by the stored value, so a
    reference there is drawn as its key (a site's "8") where the record page says the referenced name. */
function boardFindings(catalog: Catalog): DesignFinding[] {
  const found: DesignFinding[] = [];
  for (const [key, raw] of Object.entries(catalog.app.views)) {
    const board = asList(raw)?.presentation as { kind?: string; category?: string } | undefined;
    if (board?.kind !== 'board' || !board.category) continue;
    const table = catalog.table(asList(raw)!.table);
    if (!table?.columns.find((column) => column.name === board.category)?.references) continue;
    found.push({
      code: 'board-reference',
      at: `view "${key}"`,
      text:
        `its cards' category is ${board.category}, a reference a card tags with the stored key (a bare number), not the name it points at ` +
        `→ a category of the record's own (a type, a priority, a toned status), and the reference among the card's lines, which say its name.`,
    });
  }
  return found;
}

/** Rule 18: records addressed under a calendar or a board, because it is their first list in the menu. */
function addressFindings(catalog: Catalog): DesignFinding[] {
  const found: DesignFinding[] = [];
  const order = navViewKeys(catalog.app.nav);
  const firstList = new Map<string, string>();
  for (const key of [...order, ...Object.keys(catalog.app.views)]) {
    const view = asList(catalog.app.views[key]);
    if (!view || view.query) continue;
    const table = catalog.table(view.table);
    if (table && !firstList.has(table.id)) firstList.set(table.id, key);
  }
  for (const [tableId, key] of firstList) {
    const entry = catalog.byTable.get(tableId);
    const shape = (catalog.app.views[key] as AppListView).presentation as { kind?: string } | undefined;
    if (!entry || entry.resource.view || (shape?.kind !== 'calendar' && shape?.kind !== 'board')) continue;
    /* Only where a grid lists them too: a calendar that is their one list is where they belong. */
    const grid = Object.entries(catalog.app.views).find(
      ([other, view]) =>
        other !== key &&
        asList(view) &&
        catalog.table(asList(view)!.table)?.id === tableId &&
        !(asList(view)!.presentation as { kind?: string } | undefined)?.kind,
    );
    if (!grid) continue;
    found.push({
      code: 'calendar-address',
      at: `resource "${entry.name}"`,
      text:
        `its records are addressed under the ${shape.kind} "${key}", its first list in the menu, so a link to one opens over the ${shape.kind} ` +
        `→ name the list they belong to: view: ${quote(grid[0])}.`,
    });
  }
  return found;
}

/** A query written word for word in two places or more over one resource: a segment names it once (appSegments.ts). */
function repeatedQueryFindings(app: AppDef, schema: DatabaseSchema): DesignFinding[] {
  return repeatedQueries(app, schema).map((repeated) => ({
    code: 'repeated-query',
    at: `resource "${repeated.resource}"`,
    text:
      `the query ${quote(repeated.query)} is written in ${repeated.places.length} places (${repeated.places.join('; ')}), and an edit to one leaves the others behind → ` +
      (repeated.declared
        ? `it is the segment ${quote(repeated.name!)}: say ${quote(repeated.name!)} in each place.`
        : `name it once, segments: { ${repeated.name ?? 'name'}: ${quote(repeated.query)} }, and say ${quote(repeated.name ?? 'name')} in each place.`),
  }));
}

/** Rule 19: the shell as the scaffold leaves it: no look, no logo, a flat menu, a table icon on every room. */
function shellFindings(app: AppDef): DesignFinding[] {
  const missing: string[] = [];
  const fixes: string[] = [];
  if (!app.ui.theme) {
    missing.push('no look');
    fixes.push("ui: { theme: { preset: 'workshop' } } (or lumen, mono, sage; mistri docs looks)");
  }
  if (!app.ui.logo) {
    missing.push('no logo');
    fixes.push("ui: { logo: '…' }, an App icon");
  }
  const flat = app.nav.filter((node) => !('group' in node)).length;
  if (flat > 6 && !app.nav.some((node) => 'group' in node)) {
    missing.push(`a flat menu of ${flat} rooms`);
    fixes.push("navGroup('work', 'Work', [...]) around the rooms that belong together");
  }
  const rooms = navViewKeys(app.nav)
    .map((key) => app.views[key])
    .filter(Boolean);
  const plain = rooms.filter((view) => !(view as { icon?: string }).icon || (view as { icon?: string }).icon === 'table').length;
  if (rooms.length >= 3 && plain > rooms.length / 2) {
    missing.push(`${plain} of ${rooms.length} rooms with the table icon`);
    fixes.push("an icon: on each view ('users', 'package', 'calendar'…)");
  }
  if (missing.length < 2) return [];
  return [{ code: 'default-shell', at: 'the shell', text: `${missing.join(', ')}: the App will read as unstyled → ${fixes.join('; ')}.` }];
}

/**
 * Every design finding for one App, in a stable order: the shell, then each
 * page, resource and view by its key. A rule that cannot tell (a path the
 * catalog does not resolve) says nothing: mistri check is where that is wrong.
 */
export function designLint(app: AppDef, pages: readonly PageDef[], schema: DatabaseSchema): DesignFinding[] {
  const catalog = new Catalog(app, schema);
  return [
    ...shellFindings(app),
    ...pages.flatMap((page) => pageFindings(catalog, page)),
    ...resourceFindings(catalog, shownPaths(catalog, pages), pages),
    ...dashboardFindings(catalog),
    ...railFindings(catalog),
    ...boardFindings(catalog),
    ...addressFindings(catalog),
    ...repeatedQueryFindings(app, schema),
  ];
}

/** One finding as `mistri check` prints it: where, the smell → the fix, and the docs topic. */
export function sayDesignFinding(finding: DesignFinding): string {
  return `${finding.at} [${finding.code}]: ${finding.text} See \`${DOCS}\`.`;
}
