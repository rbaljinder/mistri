/**
 * mistri-components.d.ts: a props type for each custom component an App declares, generated from its
 * declarations. A component's module used to type its own props by hand from the section that places it
 * (`SectionProps<typeof warehouseBins, Rows, 'warehouse'>`), importing the section from the page's file; now it
 * imports `BinMapProps` and the declaration is read where it is made. The type is the same `SectionProps`,
 * `ValueProps`, `InputProps`, `ListProps` or `PageProps` the SDK declares (packages/mistri/schema/ui.d.ts), given a declaration
 * written as a type: the record's fields, each read's resource and columns, each total's measure, the props with
 * their defaults. A component placed more than once with different reads is the union of its placements.
 *
 * Generated beside mistri-schema.d.ts (typegen.ts) by `mistri check`, which keeps it current as a
 * declaration changes; the file says so, and is the tool's own to rewrite.
 */
import type { AppDef } from '../shared/appModel.js';
import type { ComponentDecl, ComponentPropDecl } from '@mistriwork/engine/shared/appComponents.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';

const quote = (text: string) => JSON.stringify(text);
const tuple = (items: readonly string[]) => `readonly [${items.map(quote).join(', ')}]`;
/** A property key, quoted only when it must be. */
const key = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name));

/** `sales-summary` is `SalesSummaryProps`. */
export function propsTypeName(id: string): string {
  const words = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `${words.map((word) => word[0].toUpperCase() + word.slice(1)).join('')}Props`;
}

function propDecl(prop: ComponentPropDecl): string {
  const fields = [`type: ${quote(prop.type)}`];
  if (prop.type === 'choice') fields.push(`options: ${tuple(prop.options)}`);
  if (prop.default !== undefined) fields.push(`default: ${JSON.stringify(prop.default)}`);
  return `{ ${fields.join('; ')} }`;
}

/** The part of a declaration a component's `props` come from: `{ component: { props: { months: { type: 'number'; default: 3 } } } }`. */
function componentPart(decl: ComponentDecl): string {
  const props = Object.entries(decl.props ?? {});
  return `component: { props: { ${props.map(([name, prop]) => `${key(name)}: ${propDecl(prop)}`).join('; ')} } }`;
}

interface Placement {
  /** The declaration written as a type, in SectionProps' own words. */
  declaration: string;
  /** The page's resource, on a record page; a section on a dashboard has none. */
  base?: string;
}

interface Found {
  decl: ComponentDecl;
  /** Every distinct way it is placed, in the order met. */
  placements: Map<string, Placement>;
  /** The loader a free-form page names, for `PageProps<'loader'>`. */
  loader?: string;
}

/**
 * Every component the App declares, with each placement as a type. Walks the places `appComponents` does
 * (shared/appComponents.ts); a place that only names the component, as a display rule does, is a placement of its
 * resource's column.
 */
function found(app: AppDef, pages: readonly PageDef[]): Map<string, Found> {
  const components = new Map<string, Found>();
  const place = (decl: ComponentDecl, placement: Placement, loader?: string) => {
    const at = components.get(decl.id) ?? { decl, placements: new Map<string, Placement>() };
    at.placements.set(`${placement.base ?? ''}\n${placement.declaration}`, placement);
    if (loader !== undefined) at.loader = loader;
    components.set(decl.id, at);
  };
  const sectionType = (
    decl: ComponentDecl,
    parts: {
      record?: readonly string[];
      reads?: Record<string, { from: string; columns: readonly string[] }>;
      table?: (read: { table: string; show: string[] }) => unknown;
      figures?: Record<string, { from: string; measure: string; by?: string }>;
    },
  ) => {
    const fields = [componentPart(decl)];
    if (parts.record?.length) fields.push(`record: ${tuple(parts.record)}`);
    const rows = Object.entries(parts.reads ?? {});
    if (rows.length)
      fields.push(
        `rows: { ${rows.map(([name, read]) => `${key(name)}: { from: ${quote(read.from)}; show: ${tuple(read.columns)} }`).join('; ')} }`,
      );
    const figures = Object.entries(parts.figures ?? {});
    if (figures.length)
      fields.push(
        `figures: { ${figures
          .map(
            ([name, total]) =>
              `${key(name)}: { measure: ${quote(total.measure)}${total.by === undefined ? '' : `; by: ${quote(total.by)}`} }`,
          )
          .join('; ')} }`,
      );
    return `{ ${fields.join('; ')} }`;
  };
  for (const page of pages) {
    for (const section of page.sections) {
      if (section.kind !== 'custom') continue;
      place(section.component, {
        base: page.base,
        declaration: sectionType(section.component, {
          record: section.record,
          reads:
            section.reads &&
            Object.fromEntries(Object.entries(section.reads).map(([name, read]) => [name, { from: read.from, columns: read.columns }])),
          figures:
            section.aggregates &&
            Object.fromEntries(
              Object.entries(section.aggregates).map(([name, total]) => [
                name,
                { from: total.from, measure: total.column === undefined ? total.fn : `${total.fn} ${total.column}`, by: total.by },
              ]),
            ),
        }),
      });
    }
  }
  for (const view of Object.values(app.views)) {
    if ('sections' in view) {
      for (const section of [...view.sections, ...(view.aside ?? [])]) {
        if (section.kind !== 'custom' || !section.component) continue;
        /* A free-form page is drawn whole by its one component, handed its loader's result. */
        if (view.page) {
          place(section.component, { declaration: '' }, view.page.loader);
          continue;
        }
        place(section.component, {
          declaration: sectionType(section.component, {
            reads:
              section.reads &&
              Object.fromEntries(Object.entries(section.reads).map(([name, read]) => [name, { from: read.table, columns: read.show }])),
            figures:
              section.aggregates &&
              Object.fromEntries(
                Object.entries(section.aggregates).map(([name, total]) => [
                  name,
                  { from: total.table, measure: total.measure, by: total.by },
                ]),
              ),
          }),
        });
      }
      continue;
    }
    if ('presentation' in view && view.presentation?.kind === 'custom') {
      const { component, show } = view.presentation;
      place(component, {
        declaration: `{ from: ${quote(view.table)}; presentation: { show: ${tuple(show)}; ${componentPart(component)} } }`,
      });
    }
  }
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    for (const [column, rule] of Object.entries(block.display ?? {})) {
      if (rule.component) place(rule.component, { declaration: `${resource}.${column}` });
    }
    for (const [column, decl] of Object.entries(block.inputs ?? {})) place(decl, { declaration: `${resource}.${column}` });
  }
  return components;
}

/**
 * mistri-components.d.ts as the App's declarations say it now, or undefined for an App with no components.
 * `rows` says whether the App has generated schema types to import `Rows` from; without them a props type reads
 * its rows as the SDK's loose default.
 */
export function componentTypes(app: AppDef, pages: readonly PageDef[], appName: string, rows: boolean): string | undefined {
  const components = found(app, pages);
  if (!components.size) return undefined;
  const names = new Set<string>();
  const imports = { ui: new Set<string>(), page: new Set<string>() };
  const R = rows ? ', Rows' : '';
  /* A value's or an input's type is its column's in the generated rows, where there are any. */
  const cell = (placement: Placement) => {
    const [resource, column] = placement.declaration.split('.');
    return { resource: quote(resource), column: quote(column) };
  };
  const body: string[] = [];
  for (const [id, at] of [...components].sort(([a], [b]) => a.localeCompare(b))) {
    let name = propsTypeName(id);
    for (let n = 2; names.has(name); n++) name = `${propsTypeName(id).slice(0, -5)}${n}Props`;
    names.add(name);
    const placements = [...at.placements.values()];
    const union = (each: (placement: Placement) => string) => placements.map(each).join('\n  | ');
    let alias: string;
    switch (at.decl.kind) {
      case 'section':
        imports.ui.add('SectionProps');
        alias = union(
          (p) =>
            `SectionProps<${p.declaration}${R}${p.base === undefined ? '' : `${rows ? '' : ', Record<string, Record<string, unknown>>'}, ${quote(p.base)}`}>`,
        );
        break;
      case 'list':
        imports.ui.add('ListProps');
        alias = union((p) => `ListProps<${p.declaration}${R}>`);
        break;
      case 'value':
        imports.ui.add('ValueProps');
        alias = rows ? union((p) => `ValueProps<Cell<${cell(p).resource}, ${cell(p).column}>, Rows[${cell(p).resource}]>`) : 'ValueProps';
        break;
      case 'input':
        imports.ui.add('InputProps');
        alias = rows ? union((p) => `InputProps<NonNullable<Cell<${cell(p).resource}, ${cell(p).column}>>>`) : 'InputProps';
        break;
      default:
        imports.page.add('PageProps');
        alias = at.loader ? `PageProps<${quote(at.loader)}>` : 'PageProps';
    }
    body.push(
      `/** The props of the ${at.decl.kind === 'page' ? 'page' : `${at.decl.kind} component`} "${id}". */`,
      `export type ${name} = ${alias};`,
      '',
    );
  }
  const importLine = (from: string, set: Set<string>) =>
    set.size ? [`import type { ${[...set].sort().join(', ')} } from '${from}';`] : [];
  return [
    `// Generated by \`mistri check --app <app>\` from the ${quote(appName)} app's component declarations.`,
    '// mistri check regenerates it when a declaration changes; do not edit by hand.',
    '',
    ...importLine('@mistriwork/mistri/ui', imports.ui),
    ...importLine('@mistriwork/mistri/page', imports.page),
    ...(rows ? ["import type { Rows } from './mistri-schema.d.ts';"] : []),
    '',
    ...(rows && (imports.ui.has('ValueProps') || imports.ui.has('InputProps'))
      ? ['type Cell<T extends keyof Rows, C extends string> = C extends keyof Rows[T] ? Rows[T][C] : unknown;', '']
      : []),
    ...body,
  ].join('\n');
}
