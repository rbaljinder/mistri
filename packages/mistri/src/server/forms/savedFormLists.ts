/**
 * Staff lists over a saved form's root table leave unfinished applications
 * out by default. A draft is a row in the App's real table from the first
 * step (savedForms.ts), and a person working the list should meet
 * applications, not the half-typed ones an applicant may never finish.
 *
 * The default is a condition on the list's own query, so it reads like any
 * other: `status != in_progress and …`. An author who wants the drafts seen
 * says so with a tab whose segment names the draft value (a segment
 * `in_progress: 'status = in_progress'`, its tab `'in_progress'`): then the condition goes on each other
 * tab instead of the list, and on the menu's count of it (`countQuery`), and
 * that tab shows them. Hiding is presentation,
 * not access — grants and row policy decide who may read a draft, as for any
 * row.
 */
import { isFormView, logicalResource, type AppDef, type AppFormView } from '../../shared/app.js';
import { isSavedForm } from '../../shared/appSavedForms.js';
import { withDeclaredSegments } from '../../shared/appSegments.js';
import { expandSegments } from '@mistriwork/engine/shared/query.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';

interface DraftState {
  column: string;
  value: string;
}

/**
 * Every saved form's root tables (logical ids), each with the draft state its
 * rows hold until submit. `commands` says which tables the first step writes;
 * a tenant App's host has no registry beside its metadata (`'catalog'`), and
 * there a root is any table of the reader's catalog that keeps the form's
 * three resume columns, which is what makes one a root.
 */
function savedFormDrafts(
  app: AppDef,
  commands: BusinessCommandRegistry | 'catalog' | undefined,
  schema: DatabaseSchema,
): Map<string, DraftState> {
  const drafts = new Map<string, DraftState>();
  if (!commands) return drafts;
  for (const view of Object.values(app.views)) {
    if (!isFormView(view) || !isSavedForm(view)) continue;
    const form = view as AppFormView & { save: NonNullable<AppFormView['save']> };
    const first = (form.steps?.[0] as { command?: { id: string } } | undefined)?.command;
    const start = commands === 'catalog' ? undefined : first && commands[first.id];
    if (commands !== 'catalog' && !start) continue;
    const { token, expires, progress } = form.save.resume;
    const tables = start ? start.write.map((local) => tableNamed(schema, logicalResource(app, start.source, local))) : schema.tables;
    for (const table of tables) {
      const names = new Set(table?.columns.map((column) => column.name) ?? []);
      if (table && names.has(token) && names.has(expires) && names.has(progress)) drafts.set(table.id, form.save.draft);
    }
  }
  return drafts;
}

const literal = (value: string) => (/^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value));

/** `condition and query`, on every alternative of the query and before its sort. */
export function withCondition(query: string | undefined, condition: string): string {
  const text = (query ?? '').trim();
  if (!text) return condition;
  const sortAt = text.search(/(^|\s)sort\s/i);
  const conditions = (sortAt < 0 ? text : text.slice(0, sortAt)).trim();
  const sort = sortAt < 0 ? '' : text.slice(sortAt).trim();
  const alternatives = conditions ? conditions.split(/\s+or\s+/i).map((part) => `${condition} and ${part}`) : [condition];
  return [alternatives.join(' or '), sort].filter(Boolean).join(' ');
}

/** The App with its lists over a saved form's root leaving the drafts out, unless a tab asks for them. */
export function withDraftsHidden(app: AppDef, commands: BusinessCommandRegistry | 'catalog' | undefined, schema: DatabaseSchema): AppDef {
  const drafts = savedFormDrafts(app, commands, schema);
  if (!drafts.size) return app;
  let changed = false;
  const views = Object.fromEntries(
    Object.entries(app.views).map(([key, view]) => {
      if (isFormView(view) || !('table' in view) || typeof view.table !== 'string') return [key, view];
      const table = tableNamed(schema, view.table);
      const draft = table && drafts.get(table.id);
      if (!draft) return [key, view];
      changed = true;
      const hide = `${draft.column} != ${literal(draft.value)}`;
      /* A tab says a segment's name, so the draft value is read in the segment's own words. */
      const segments = tableNamed(withDeclaredSegments(app, schema), view.table)?.segments;
      const names = (query: string | undefined) =>
        new RegExp(`\\b${draft.column}\\b[^]*\\b${draft.value.replace(/[^A-Za-z0-9_]/g, '\\$&')}\\b`).test(
          expandSegments(query ?? '', segments).text,
        );
      const list = view as { query?: string; tabs?: Array<{ label: string; query?: string }> };
      if (list.tabs?.some((tab) => names(tab.query))) {
        /* The menu counts the list's own condition, which the drafts' tab
         cannot carry the hiding on: it counts the condition with it. */
        return [
          key,
          {
            ...view,
            countQuery: withCondition(list.query, hide),
            tabs: list.tabs.map((tab) => (names(tab.query) ? tab : { ...tab, query: withCondition(tab.query, hide) })),
          },
        ];
      }
      return [key, { ...view, query: withCondition(list.query, hide) }];
    }),
  );
  return changed ? ({ ...app, views } as AppDef) : app;
}
