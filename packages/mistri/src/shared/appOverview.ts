/**
 * The overview an App starts on when it names no `home`: a glance at its main
 * table, drawn from what the table already says. The main table is the one a
 * machine moves, else the one the most tables point at (listInference.ts
 * mainTable); its list is the first that shows it whole. On it, as many of
 * these as the table can answer, and nothing it cannot:
 *
 * - its rows by state, one strip of figures, each opening the list there;
 * - the open rows overdue or due today, soonest first, left out while there are none;
 * - the open rows assigned to the reader, where the main table points at the
 *   table `auth.me` reads people from, said empty when nothing is theirs;
 * - the newest rows.
 *
 * At most four sections, so four statements, all read in the first document
 * (firstPaintRooms.ts reads a dashboard's sections as one batch): each list
 * reads its rows and no total, and the reader's own rows are found through
 * the email they signed in with (`technician_id.email = me`), so no lookup
 * of who they are runs before them (appMe.ts emailOnly). The words
 * are the table's and the columns'; nothing is written about the App that
 * the App did not say. Each reader's overview is drawn from their own catalog,
 * so a reader who cannot read the main table is shown the next one they can.
 */
import { isFormView, type AppDashSection, type AppDef, type AppDashboardView, type AppListView } from './appModel.js';
import {
  createdDate,
  dueDate,
  leadColumn,
  mainTable,
  oneDate,
  openQuery,
  stateColumn,
  type InferenceResource,
} from '@mistriwork/engine/shared/listInference.js';
import { tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';

/** The overview's view key, and so its address. */
export const OVERVIEW = 'overview';

/** How many rows each list on the overview shows: a glance, with the list a click away. */
const ROWS = 6;

/** The overview's sections for this reader's catalog: none where no list shows a table they read. */
export function overviewSections(
  app: Pick<AppDef, 'views' | 'auth'>,
  schema: DatabaseSchema,
  resourceOf: (table: string) => InferenceResource,
): AppDashSection[] {
  /* The tables a list shows whole, each with the first such list: where a figure or a row opens. */
  const lists = new Map<string, { key: string; view: AppListView; table: TableMeta }>();
  for (const [key, view] of Object.entries(app.views)) {
    if (isFormView(view) || 'sections' in view || view.query) continue;
    const table = tableNamed(schema, view.table);
    if (table && !lists.has(table.id)) lists.set(table.id, { key, view, table });
  }
  const main = mainTable(
    schema,
    [...lists.values()].map(({ view, table }) => ({ table, machine: Boolean(resourceOf(view.table).machine) })),
  );
  if (!main) return [];
  const { key: list, view } = lists.get(main.id)!;
  const resource = resourceOf(view.table);
  const state = stateColumn(main, resource);
  const open = openQuery(main, resource);
  const lead = leadColumn(schema, main, resource);
  /* The first reference the record is known by: a job's customer, a visit's job. */
  const named = main.columns.find((column) => column.references && column.name !== lead && !column.nullable)?.name;
  const due = dueDate(main);
  const created = createdDate(main);
  const show = (...columns: Array<string | undefined>) => [...new Set(columns.filter((column): column is string => Boolean(column)))];
  const rows = (
    title: string,
    query: string | undefined,
    sort: string | undefined,
    columns: string[],
    hide: boolean,
    empty?: string,
  ): AppDashSection =>
    ({
      kind: 'rows',
      title,
      table: view.table,
      view: list,
      ...(query ? { query } : {}),
      ...(sort ? { sort } : {}),
      show: columns,
      limit: ROWS,
      counted: false,
      ...(hide
        ? { emptyMode: 'hide' as const }
        : { empty: { title: empty ?? `No ${(view.label ?? humanName(main.name)).toLowerCase()} yet` } }),
    }) as AppDashSection;
  const sections: AppDashSection[] = [];
  if (state)
    sections.push({
      kind: 'breakdown',
      title: view.label ?? humanName(main.name),
      table: view.table,
      by: state,
      shape: 'steps',
      view: list,
    } as AppDashSection);
  if (due && open) sections.push(rows('Overdue or due today', `${open} and ${due} <= today`, due, show(lead, state, named, due), true));
  /* Mine: the main table points at the table people sign in from. Shown whenever it does, and said empty when nothing
     is the reader's: a section that came and went with the data would say nothing about whether there is a "mine". */
  const people = app.auth?.me ? tableNamed(schema, app.auth.me.from) : undefined;
  const mine = people ? main.columns.find((column) => column.references?.table === people.id)?.name : undefined;
  /* Through the person's email where this reader may read it: the rows and who the reader is in one statement. */
  const email =
    people &&
    app.auth?.me?.by !== 'account' &&
    app.auth?.me?.column &&
    people.columns.some((column) => column.name === app.auth!.me!.column);
  const theirs = mine && (email ? `${mine}.${app.auth!.me!.column} = me` : `${mine} = me`);
  if (theirs)
    sections.push(
      rows(
        'Mine',
        open ? `${theirs} and ${open}` : theirs,
        due ? `${due} nulls last` : created ? `${created} desc` : undefined,
        show(lead, state, named, due ?? oneDate(main)),
        false,
        `Nothing of yours is ${open ? 'open' : 'here'}`,
      ),
    );
  if (created) sections.push(rows('Recent', undefined, `${created} desc`, show(lead, state, named, created), false));
  return sections;
}

/** The overview as served: its sections drawn for this catalog, the view otherwise as parsed. */
export const servedOverview = (
  view: AppDashboardView,
  app: Pick<AppDef, 'views' | 'auth'>,
  schema: DatabaseSchema,
  resourceOf: (table: string) => InferenceResource,
): AppDashboardView => ({ ...view, sections: overviewSections(app, schema, resourceOf) });
