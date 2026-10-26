/**
 * Where an App places its custom components (appComponents.ts declares
 * them): every placement collected by id, held to one module per id, and
 * the ones a signed-out visitor may meet held to the public grant. Reads the
 * whole App definition, so it is the App's; the declarations it collects
 * are read by the page rules as well.
 */
import { isPublicForm, type AppDef, type AppFormView } from './appModel.js';
import { formCommands } from './appSavedForms.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import type { ComponentDecl } from '@mistriwork/engine/shared/appComponents.js';

/** Where one declaration was met, for a refusal that names both places. */
interface Met {
  decl: ComponentDecl;
  at: string;
}

/**
 * Every component the App declares, by id, from wherever it is placed.
 * One id is one module: the same id naming two modules (or two kinds) is
 * refused with both places named, since whichever compiled last would win.
 */
function collectComponents(places: Iterable<{ decl: ComponentDecl; at: string }>): Map<string, ComponentDecl> {
  const seen = new Map<string, Met>();
  for (const place of places) {
    const earlier = seen.get(place.decl.id);
    if (!earlier) {
      seen.set(place.decl.id, place);
      continue;
    }
    const a = earlier.decl,
      b = place.decl;
    if (a.module !== b.module || a.kind !== b.kind || JSON.stringify(a.props ?? {}) !== JSON.stringify(b.props ?? {})) {
      throw new Error(
        `${place.at} declares the component "${b.id}" differently from ${earlier.at}. One id is one component: ` +
          'declare it once with component() and import it where it is placed.',
      );
    }
  }
  return new Map([...seen].map(([id, met]) => [id, met.decl]));
}

/** The column of the resource itself a label path starts from. */
const firstHop = (path: string) => path.split('.')[0];

/**
 * What a signed-out visitor may read, as the App says it: the resources
 * `auth.public` opens and, where it narrows one, that resource's columns.
 */
function publicReach(app: AppDef): { reads(resource: string): boolean; column(resource: string, path: string): boolean } | undefined {
  const grant = app.auth?.public;
  if (!grant) return undefined;
  const open = new Set(grant.read);
  return {
    reads: (resource) => open.has(resource),
    column: (resource, path) => {
      const narrowed = grant.fields?.[resource]?.read;
      /* A rollup is served to whoever can read the rows it counts (appRollups.ts), not by the column list. */
      const rollup = Object.hasOwn(app.resources?.[resource]?.rollups ?? {}, firstHop(path));
      return !narrowed || rollup || narrowed.includes(firstHop(path));
    },
  };
}

/**
 * Every component an App places, by id: a page's or a dashboard's custom
 * sections, a list view's custom presentation, a free-form page, the resources' value
 * renderers and inputs, and the inputs of an action or a form, a public
 * one's too. On a tenant App its host serves a component's
 * code to a signed-in reader, and to a visitor only the ones their public
 * pages draw (publicComponentIds below); every read the component makes is an
 * ordinary request inside that reader's tenant (tenant/tenantHttp.ts), or the
 * visitor's placed one.
 *
 * Where a signed-out visitor meets one — a page or a list over a resource
 * `auth.public` opens — what it declares it reads is held to the public
 * grant: each read from a resource the grant opens, each column among the
 * ones it leaves in. The server refuses anything else to a visitor anyway
 * (their every read is the public grant's); saying so as the App loads
 * keeps a public page from drawing a broken section for every visitor. A
 * label path's later hops are the server's to judge: this reads the
 * definition alone, before any catalog.
 */
export function appComponents(app: AppDef, pages: readonly PageDef[], where: string): Map<string, ComponentDecl> {
  const places: Array<{ decl: ComponentDecl; at: string }> = [];
  for (const page of pages) {
    page.sections.forEach((section, i) => {
      if (section.kind === 'custom') places.push({ decl: section.component, at: `${where}: page "${page.id}", section ${i + 1}` });
    });
  }
  for (const [key, view] of Object.entries(app.views)) {
    if ('sections' in view) {
      [...view.sections, ...(view.aside ?? [])].forEach((section, i) => {
        if (section.kind === 'custom' && section.component) {
          places.push({ decl: section.component, at: `${where}: views "${key}"${view.page ? '' : `, section ${i + 1}`}` });
        }
      });
      continue;
    }
    if ('presentation' in view && view.presentation?.kind === 'custom') {
      places.push({ decl: view.presentation.component, at: `${where}: views "${key}", presentation` });
    }
    if ('command' in view && view.inputs) {
      for (const [name, decl] of Object.entries(view.inputs)) places.push({ decl, at: `${where}: views "${key}", inputs "${name}"` });
    }
  }
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    for (const [column, rule] of Object.entries(block.display ?? {})) {
      if (rule.component) places.push({ decl: rule.component, at: `${where}: resources "${resource}", display "${column}"` });
    }
    for (const [column, decl] of Object.entries(block.inputs ?? {}))
      places.push({ decl, at: `${where}: resources "${resource}", inputs "${column}"` });
    (block.actions ?? []).forEach((action, i) => {
      for (const [name, decl] of Object.entries(('inputs' in action ? action.inputs : undefined) ?? {}) as Array<[string, ComponentDecl]>) {
        places.push({ decl, at: `${where}: resources "${resource}", action ${i + 1}, inputs "${name}"` });
      }
    });
  }
  if (!places.length) return new Map();
  const reach = publicReach(app);
  if (reach) {
    for (const page of pages) {
      if (!reach.reads(page.base)) continue;
      page.sections.forEach((section, i) => {
        if (section.kind !== 'custom') return;
        const at = `${where}: page "${page.id}", section ${i + 1}`;
        const closed = (section.record ?? []).find((path) => !reach.column(page.base, path));
        if (closed) {
          throw new Error(
            `${at} reads "${closed}" of the record, and "auth.public" opens "${page.base}" to signed-out visitors without it. ` +
              "A public page's component reads what the public grant opens: drop the field, or open it in auth.public.fields.",
          );
        }
        for (const [name, read] of Object.entries(section.reads ?? {})) {
          if (!reach.reads(read.from)) {
            throw new Error(
              `${at}, rows "${name}" reads "${read.from}", which "auth.public" does not open, on a page signed-out visitors read. ` +
                "A public page's component reads what the public grant opens.",
            );
          }
          const hidden = read.columns.find((path) => !reach.column(read.from, path));
          if (hidden) throw new Error(`${at}, rows "${name}" shows "${hidden}", which "auth.public" leaves out of "${read.from}".`);
        }
        for (const [name, total] of Object.entries(section.aggregates ?? {})) {
          if (!reach.reads(total.from)) {
            throw new Error(
              `${at}, figures "${name}" measures "${total.from}", which "auth.public" does not open, on a page signed-out visitors read. ` +
                "A public page's component reads what the public grant opens.",
            );
          }
          const hidden = [total.column, total.by?.split(/\s+/).pop()].find((path) => path && !reach.column(total.from, path));
          if (hidden) throw new Error(`${at}, figures "${name}" reads "${hidden}", which "auth.public" leaves out of "${total.from}".`);
        }
      });
    }
    for (const [key, view] of Object.entries(app.views)) {
      if (!('presentation' in view) || view.presentation?.kind !== 'custom' || !reach.reads(view.table)) continue;
      const hidden = view.presentation.show.find((path) => !reach.column(view.table, path));
      if (hidden)
        throw new Error(`${where}: views "${key}", presentation shows "${hidden}", which "auth.public" leaves out of "${view.table}".`);
    }
  }
  return collectComponents(places);
}

/**
 * The components a signed-out visitor may meet, by id: where `auth.public`
 * opens what they stand on — a record page over a resource it opens, a
 * free-form page whose every read it opens, a custom section whose every read
 * it opens, a custom list over a resource it opens, a value renderer on one,
 * and the input components a public form draws (publicFormInputIds below),
 * whatever it reads. Empty where the App opens nothing and has no public form.
 *
 * Read off the definition alone, so a host can judge a component's file before
 * it knows any tenant: the code is the deployment's, never a row, and every
 * read it makes is still the public grant's (appComponents above).
 */
export function publicComponentIds(app: AppDef, pages: readonly PageDef[]): Set<string> {
  const ids = new Set<string>();
  for (const view of Object.values(app.views)) if (isPublicForm(view)) for (const id of publicFormInputIds(view)) ids.add(id);
  const reach = publicReach(app);
  if (!reach) return ids;
  for (const page of pages) {
    if (!reach.reads(page.base)) continue;
    for (const section of page.sections) if (section.kind === 'custom') ids.add(section.component.id);
  }
  for (const view of Object.values(app.views)) {
    if ('sections' in view) {
      if (view.page && !view.page.reads.every((resource) => reach.reads(resource))) continue;
      for (const section of [...view.sections, ...(view.aside ?? [])]) {
        if (section.kind !== 'custom' || !section.component) continue;
        if (
          Object.values(section.reads ?? {}).every((read) => reach.reads(read.table)) &&
          Object.values(section.aggregates ?? {}).every((total) => reach.reads(total.table))
        )
          ids.add(section.component.id);
      }
      continue;
    }
    if ('presentation' in view && view.presentation?.kind === 'custom' && reach.reads(view.table)) ids.add(view.presentation.component.id);
  }
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    if (!reach.reads(resource)) continue;
    for (const rule of Object.values(block.display ?? {})) if (rule.component) ids.add(rule.component.id);
  }
  return ids;
}

type NamedInput = { input?: string; fields?: readonly NamedInput[] };

/**
 * The input components a public form's page draws: the form's own (`inputs`) and each field's (`input: 'swatch'`),
 * in its steps' commands and its own. Code a visitor's page loads, as a public page's sections are; the value each
 * hands back is still the field's kind's to judge on the server.
 */
export function publicFormInputIds(form: Pick<AppFormView, 'command' | 'steps' | 'inputs'>): Set<string> {
  const ids = new Set<string>(Object.values(form.inputs ?? {}).map((decl) => decl.id));
  const walk = (fields: readonly NamedInput[]) => {
    for (const field of fields) {
      if (typeof field.input === 'string') ids.add(field.input);
      if (Array.isArray(field.fields)) walk(field.fields);
    }
  };
  for (const reference of formCommands(form)) walk(reference.input as readonly NamedInput[]);
  return ids;
}
