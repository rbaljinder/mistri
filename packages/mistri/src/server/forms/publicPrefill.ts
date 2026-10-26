/**
 * Where a public form's link may start it filled from. A headline's call to
 * action carries some of the record's fields into the form's address
 * (`prefill: { stock_ref: 'stock_ref' }`), and an address is kept in history,
 * sent as a referrer and shared by hand. So a public form is prefilled only
 * from what the public grant already opens to everyone — a car's stock
 * number, a post's id — and only into the inputs the form names
 * `prefillable`; anything else is refused at load, by name. The form still
 * treats what it is given as typed: seen, changeable, checked by the command.
 *
 * A custom component's `openForm(view, prefill)` is runtime and escapes this
 * check, and needs none: the SDK always draws a public form in a dialog over
 * the page (sdk/commands.tsx), so its values never reach an address, and the
 * form fills only its `prefillable` inputs (FormSurface's startingValues).
 * Nor could the server hold it: a submission does not say which inputs were
 * prefilled, a prefilled value is indistinguishable from one typed, and the
 * visitor could type it anyway — so the command checks every input alike.
 */
import { isPublicForm, type AppDef, type AppFormView } from '../../shared/app.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

/** Every refusal of the App's pages' prefilled links to public forms, one line each. */
export function publicPrefillProblems(
  app: AppDef,
  pages: readonly PageDef[],
  schema: DatabaseSchema,
): Array<{ page: PageDef; problem: string }> {
  const found: Array<{ page: PageDef; problem: string }> = [];
  const grant = app.auth?.public;
  const opened = (table: string, column: string): boolean => {
    const meta = tableNamed(schema, table);
    if (!meta || !grant?.read.some((name) => tableNamed(schema, name)?.id === meta.id)) return false;
    const narrowed = Object.entries(grant.fields ?? {}).find(([name]) => tableNamed(schema, name)?.id === meta.id)?.[1];
    return !narrowed?.read || narrowed.read.includes(column);
  };
  for (const page of pages) {
    for (const section of page.sections) {
      if (section.kind !== 'fields') continue;
      for (const action of section.actions ?? []) {
        // Checked App targets belong to the link owner, not local form prefill.
        if (!('view' in action)) continue;
        const view = Object.hasOwn(app.views, action.view) ? app.views[action.view] : undefined;
        if (!view || !isPublicForm(view) || !action.prefill) continue;
        const form = view as AppFormView;
        for (const [input, path] of Object.entries(action.prefill)) {
          const said = `the headline's "${action.label}" fills "${input}" of the public form "${action.view}"`;
          if (!form.prefillable?.includes(input)) {
            found.push({ page, problem: `${said}, which the form does not name prefillable.` });
            continue;
          }
          // Each hop of the path, from the page's table: every column read must be one the public reads.
          let table = page.base,
            ok = true;
          for (const [index, column] of path.trim().split('.').entries()) {
            if (!opened(table, column)) {
              ok = false;
              break;
            }
            const next = tableNamed(schema, table)?.columns.find((candidate) => candidate.name === column)?.references?.table;
            if (index < path.split('.').length - 1) {
              if (!next) {
                ok = false;
                break;
              }
              table = next;
            }
          }
          if (!ok)
            found.push({
              page,
              problem: `${said} from "${path}", which the public grant does not open. A public form's link carries only what everyone may already read.`,
            });
        }
      }
    }
  }
  return found;
}
