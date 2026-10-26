import { ANSI_STYLE } from '@mistriwork/engine/adapters/adapter.js';
import { pageAbouts } from '@mistriwork/engine/shared/pageModel.js';
import { assertNever } from '@mistriwork/engine/shared/model.js';
import { backdropProblem, isFormView, labelTemplateProblem, listProblem, type AppDef, type AppForm } from '../../shared/app.js';
import { isLabelTemplate } from '@mistriwork/engine/shared/recordLabel.js';
import { compileBreakdown } from '@mistriwork/engine/shared/breakdown.js';
import { cardsReadable } from '@mistriwork/engine/shared/appCards.js';
import { commandReferenceProblem } from '../../shared/command.js';
import { autoKey, formShownFields } from '@mistriwork/engine/shared/form.js';
import {
  breakdownPlan,
  chartPlan,
  customReadView,
  customTotalPlan,
  listView,
  metricView,
  resolveOf,
  timelineMarkColumns,
  validatePage,
  type OfKeys,
  type PageDef,
  type PageList,
} from '@mistriwork/engine/shared/page.js';
import { ANYONE, parseQuery } from '@mistriwork/engine/shared/query.js';
import { relatedCreatePlan } from '@mistriwork/engine/shared/relatedCreate.js';
import { findTable, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { compileView, resolvePath } from '@mistriwork/engine/shared/view.js';

const writable = (table: TableMeta | undefined, name: string): boolean =>
  Boolean(table?.columns.some((column) => column.name === name && column.writable !== false));

/** Call only for field-controlled requests, with their already-pruned schema.
 * Definitions are public data too: hidden sections and inactive predicates must
 * pass the same checks as visible sections. Never repair a forbidden filter. */
export function fieldAccessiblePage(schema: DatabaseSchema, page: PageDef): boolean {
  try {
    if (page.error) return false;
    const checked = validatePage(schema, page);
    if (checked.error) return false;
    const base = tableNamed(schema, checked.base);
    if (!base) return false;
    // Only compile; no record is read. Non-null keys prevent an empty `of`
    // relationship from short-circuiting validation of its child definition.
    // A child may target a visible alternate unique key, not the root's PK.
    // These are compiler placeholders, never row data or a published key.
    const key = Object.fromEntries(base.columns.map((column) => [column.name, 0]));
    const now = new Date('2000-01-01T00:00:00Z');
    const ofKeys: OfKeys = {};
    for (const about of pageAbouts(checked)) {
      const of = resolveOf(schema, checked.base, about);
      if (of.error || !of.fk) return false;
      if (!of.table) return false;
      ofKeys[about] = Object.fromEntries(of.table.columns.map((column) => [column.name, 0]));
    }
    // A similar list's values are placeholders too: compiled, never read.
    const rootValues = Object.fromEntries(base.columns.map((column) => [column.name, 1]));
    const listAccessible = (section: PageList, index: number): boolean => {
      const built = listView(schema, checked, section, key, index, now, ofKeys, rootValues);
      if (built.error || !built.view) return false;
      compileView(schema, built.view, ANSI_STYLE);
      return true;
    };
    for (const [index, section] of checked.sections.entries()) {
      switch (section.kind) {
        case 'fields':
          for (const path of [...(section.paths ?? []), ...(section.was === undefined ? [] : [section.was])])
            resolvePath(schema, checked.base, path);
          break;
        case 'list': {
          if (!listAccessible(section, index)) return false;
          if (section.create) {
            const plan = relatedCreatePlan(schema, checked.base, section.from, section.path, section.create, {
              filter: section.filter,
            });
            const table = tableNamed(schema, section.from);
            if (plan.error || !table || !plan.bindings || !plan.show) return false;
            if (plan.bindings.some((binding) => !writable(table, binding.column))) return false;
            // What the create fills in for the reader is written by the reader, so they must write it.
            if ([...Object.keys(plan.defaults ?? {}), ...Object.keys(plan.fill ?? {})].some((column) => !writable(table, column)))
              return false;
            const assigned = autoKey(table);
            // Generated identities are displayed in some authored show lists,
            // but the existing New form never submits them as editable inputs.
            // With no authored show list the form derives its editable fields
            // from this schema, which already marks read-only columns.
            if (
              section.create.show &&
              plan.show.some((name) => {
                const column = table.columns.find((item) => item.name === name);
                return name !== assigned && !column?.identity && !writable(table, name);
              })
            )
              return false;
          }
          break;
        }
        case 'metric': {
          const built = metricView(schema, checked, section, key, index, now, ofKeys);
          if (built.error || !built.view) return false;
          compileView(schema, built.view, ANSI_STYLE);
          if (built.breakdown) compileBreakdown(schema, built.breakdown, ANSI_STYLE);
          break;
        }
        case 'breakdown': {
          const built = breakdownPlan(schema, checked, section, key, index, now, ofKeys);
          if (built.error || !built.def) return false;
          compileBreakdown(schema, built.def, ANSI_STYLE);
          break;
        }
        case 'chart': {
          const built = chartPlan(schema, checked, section, key, index, now, ofKeys);
          if (built.error || !built.def) return false;
          compileBreakdown(schema, built.def, ANSI_STYLE);
          break;
        }
        // A note reads nothing; its action's view is judged with the rooms the reader has.
        case 'note':
          break;
        case 'timeline':
          for (const stream of section.streams) {
            if (
              !listAccessible(
                {
                  kind: 'list',
                  from: stream.from,
                  path: stream.path,
                  columns: [
                    stream.at,
                    stream.show,
                    ...(stream.detail ? [stream.detail] : []),
                    ...timelineMarkColumns(section, stream, findTable(schema, stream.from)),
                  ],
                  filter: stream.filter,
                  orderBy: [{ column: stream.at, direction: 'desc' }],
                  limit: section.limit,
                  ...(stream.of ? { of: stream.of } : {}),
                },
                index,
              )
            )
              return false;
          }
          break;
        /* The record's own history is answered per field for its reader
           (server/recordHistory.ts): nothing here to compile. */
        case 'history':
          break;
        /* Flow runs are the record's own, answered by their own route (server/recordFlows.ts). */
        case 'flows':
          break;
        /* A diagram's steps are read as the reader's rows, through the ordinary reads. */
        case 'diagram':
          break;
        case 'custom':
          // The record's fields as a fields section reads them, and every declared read compiled as it will run.
          for (const path of section.record ?? []) resolvePath(schema, checked.base, path);
          for (const [name, read] of Object.entries(section.reads ?? {})) {
            const built = customReadView(schema, checked, name, read, key, index, now);
            if (built.error || !built.view) return false;
            compileView(schema, built.view, ANSI_STYLE);
          }
          for (const [name, total] of Object.entries(section.aggregates ?? {})) {
            const built = customTotalPlan(schema, checked, name, total, key, index, now);
            if (built.error || !built.def) return false;
            compileBreakdown(schema, built.def, ANSI_STYLE);
          }
          break;
        default:
          return assertNever(section, 'page section kind');
      }
    }
    return true;
  } catch {
    // Validation errors may carry forbidden names or literals. Only return the
    // eligibility decision; callers must not serialize those diagnostics.
    return false;
  }
}

/**
 * A section without the parts a reader may go without: a related list's
 * create (its New is for the roles that write the table; the rest read the
 * list) and a headline's earlier figure (`was`). Undefined when the section
 * has neither, so there is nothing to fall back to.
 */
function withoutOptional(section: PageDef['sections'][number]): PageDef['sections'][number] | undefined {
  if (section.kind === 'list' && section.create) {
    const { create: _create, ...list } = section;
    return list;
  }
  if (section.kind === 'fields' && section.was !== undefined) {
    const { was: _was, ...fields } = section;
    return fields;
  }
  return undefined;
}

/**
 * A fields section with only the fields this reader reads: a header's facts,
 * a properties panel. A requester's request reads as theirs, in the page's
 * own layout, without the team and the due time their role was never
 * granted; before, the section went, and with the header the page lost its
 * head. Undefined when none of its fields reads, or it names none (the
 * schema's own suggestion, which is already this reader's).
 */
function readableFields(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageDef['sections'][number],
): PageDef['sections'][number] | undefined {
  if (section.kind !== 'fields' || !section.paths?.length) return undefined;
  const { was: _was, ...plain } = section;
  const paths = plain.paths!.filter((path) => fieldAccessiblePage(schema, { ...page, sections: [{ ...plain, paths: [path] }] }));
  if (!paths.length) return undefined;
  // A headline's earlier figure stays while the reader reads it too.
  for (const narrowed of [
    { ...section, paths },
    { ...plain, paths },
  ])
    if (fieldAccessiblePage(schema, { ...page, sections: [narrowed] })) return narrowed;
  return undefined;
}

/**
 * One section as this reader's catalog can draw it: as written, else without
 * its optional parts (withoutOptional), else with only the fields it reads
 * (readableFields), else not at all.
 */
export function readableSection(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageDef['sections'][number],
): PageDef['sections'][number] | undefined {
  if (fieldAccessiblePage(schema, { ...page, sections: [section] })) return section;
  const plain = withoutOptional(section);
  if (plain && fieldAccessiblePage(schema, { ...page, sections: [plain] })) return plain;
  return readableFields(schema, page, section);
}

/**
 * The page as this reader's catalog can draw it: whole when every section
 * reads, else without the sections that cannot — an Email list or a tags
 * strip a requester has no grant to, on a ticket page that is otherwise
 * theirs. A page that drew nothing for one section fell back to the raw
 * record, every column and no conversation, which said far more than the
 * section it lost. A section that reads but whose New the reader may not
 * use stays, without its New (readableSection). Undefined when nothing of it
 * is left, or its base is not read. Sections carry their own tab, so leaving
 * one out moves no other.
 */
export function readablePage(schema: DatabaseSchema, page: PageDef): PageDef | undefined {
  if (fieldAccessiblePage(schema, page)) return page;
  if (page.error || !tableNamed(schema, page.base)) return undefined;
  const sections = page.sections.flatMap((section) => readableSection(schema, page, section) ?? []);
  if (!sections.length) return undefined;
  const kept = { ...page, sections };
  return fieldAccessiblePage(schema, kept) ? kept : undefined;
}

/** Keep an author-selected record name only while it resolves against this
 * already-pruned catalog. The false value is intentionally opaque: callers
 * may distinguish an unavailable explicit name from an omitted declaration
 * without learning its path. */
function fieldAccessibleRecordLabels(app: AppDef, schema: DatabaseSchema): AppDef {
  const resources =
    app.resources &&
    Object.fromEntries(
      Object.entries(app.resources).map(([name, resource]) => {
        const recordLabel = resource.recordLabel;
        if (recordLabel === undefined || recordLabel === false) return [name, resource];
        try {
          const table = tableNamed(schema, name);
          if (!table) throw new Error('resource is unavailable');
          // A template names its row only where every column in it is readable.
          if (isLabelTemplate(recordLabel)) {
            if (labelTemplateProblem(schema, table, recordLabel)) throw new Error('unavailable');
          } else resolvePath(schema, table.id, recordLabel);
          return [name, resource];
        } catch {
          const { recordLabel: _recordLabel, ...rest } = resource;
          return [name, { ...rest, recordLabel: false as const }];
        }
      }),
    );
  return { ...app, ...(resources ? { resources } : {}) };
}

/** Project write presentation before view resolution, only for field-controlled
 * requests: the resources' actions and forms, and the lists' presentations.
 * Omitting an unsafe form keeps its owning list readable and restores the
 * existing schema-derived form; partial default sets would change intent.
 * `granted` is this reader's fixed actions without write (`roles.<role>.actions`)
 * by table id: kept although their columns are not the reader's to write,
 * since the grant, judged inside the write, is what lets them run. */
export function fieldAccessibleApp(
  app: AppDef,
  schema: DatabaseSchema,
  granted?: ReadonlyMap<string, readonly { label: string }[]>,
): AppDef {
  const labelled = fieldAccessibleRecordLabels(app, schema);
  const safeForm = (resource: string, form: AppForm): boolean => {
    const table = tableNamed(schema, resource);
    return [...(formShownFields(form) ?? []), ...Object.keys(form.defaults ?? {})].every((name) => writable(table, name));
  };
  const resources =
    labelled.resources &&
    Object.fromEntries(
      Object.entries(labelled.resources).map(([name, resource]) => {
        const table = tableNamed(schema, name);
        const { actions, form, segments: declared, ...rest } = resource;
        /* A segment whose conditions read a column this reader is not granted is not served to them
           (appSegments.ts servedSegments), and its text, which names that column, is not sent either. */
        const segments = declared && Object.fromEntries(Object.entries(declared).filter(([key]) => Boolean(table?.segments?.[key])));
        const visibleActions = actions?.filter((action) => {
          if (!table) return false;
          // Whether the condition reads here at all; whose `me` it is, the request judges (appTransitions.ts).
          if (action.when && parseQuery(`${table.id} ${action.when}`, { schema, me: ANYONE }).errors.length) return false;
          if (action.command) return !commandReferenceProblem(action.command, table.id, schema);
          if (granted?.get(table.id)?.some((grant) => grant.label === action.label)) return true;
          return Object.keys(action.set).every((column) => writable(table, column));
        });
        return [
          name,
          {
            ...rest,
            ...(visibleActions === undefined ? {} : { actions: visibleActions }),
            ...(form && safeForm(name, form) ? { form } : {}),
            ...(segments && Object.keys(segments).length ? { segments } : {}),
          },
        ];
      }),
    );
  /* A role's grant names actions by id; one this projection left out is
     not the reader's to see, and the grant must still name only actions the
     resource declares, or the projected definition would no longer load. */
  const kept = (resource: string, id: string) => Boolean(resources?.[resource]?.actions?.some((action) => action.id === id));
  const roles =
    labelled.auth?.roles &&
    Object.fromEntries(
      Object.entries(labelled.auth.roles).map(([role, grant]) => {
        if (!grant.actions) return [role, grant];
        const { actions, ...rest } = grant;
        const remaining = Object.fromEntries(
          Object.entries(actions)
            .map(([resource, labels]) => [resource, labels.filter((label) => kept(resource, label))] as const)
            .filter(([, labels]) => labels.length),
        );
        return [role, { ...rest, ...(Object.keys(remaining).length ? { actions: remaining } : {}) }];
      }),
    );
  const views = Object.fromEntries(
    Object.entries(labelled.views).map(([key, view]) => {
      if ('sections' in view || isFormView(view)) return [key, view];
      const table = tableNamed(schema, view.table);
      const form = labelled.resources && Object.hasOwn(labelled.resources, view.table) ? labelled.resources[view.table].form : undefined;
      const { presentation: shown, quickAdd, suggest: suggesting, tabs: every, ...rest } = view;
      // A tab is its segment: one not served to this reader is no tab of theirs.
      const tabs = every?.filter((tab) => !tab.segment || Boolean(table?.segments?.[tab.segment]));
      /* A calendar's span this reader cannot read is left out, and the calendar stands without it: the spans are
         another resource's rows, read through this reader's own grants. */
      const spans = shown?.kind === 'calendar' ? shown.backdrop?.filter((span) => !backdropProblem(span, schema)) : undefined;
      /* So is a card's figure, picture, line or fact read through a reference to what this reader may not read:
         the card stands without it (cardsReadable). */
      const presentation =
        shown?.kind === 'calendar' && shown.backdrop
          ? { ...shown, backdrop: spans?.length ? spans : undefined }
          : shown?.kind === 'cards' && table
            ? cardsReadable(shown, table, schema)
            : shown;
      // Drop the entire presentation: even validation errors could name hidden fields.
      const safeList = presentation && table && !listProblem(presentation, table, schema);
      const safeQuickAdd =
        quickAdd &&
        table &&
        !table.isView &&
        table.insertable !== false &&
        table.columns.some((column) => column.writable !== false) &&
        (!form || safeForm(view.table, form));
      /* A suggestion reads a column's values: one this reader cannot read is not offered, and a box left with none
         searches as it always did. */
      const readable = (name: string) => Boolean(table?.columns.some((column) => column.name === name));
      const suggest = Object.fromEntries(
        Object.entries(suggesting ?? {})
          .filter(([filter]) => readable(filter))
          .map(([filter, columns]) => [filter, columns.filter(readable)] as const)
          .filter(([, columns]) => columns.length),
      );
      return [
        key,
        {
          ...rest,
          ...(safeList ? { presentation } : {}),
          ...(safeQuickAdd ? { quickAdd } : {}),
          ...(Object.keys(suggest).length ? { suggest } : {}),
          ...(tabs ? { tabs } : {}),
        },
      ];
    }),
  );
  return { ...labelled, ...(resources ? { resources } : {}), views, ...(roles ? { auth: { ...labelled.auth!, roles } } : {}) };
}
