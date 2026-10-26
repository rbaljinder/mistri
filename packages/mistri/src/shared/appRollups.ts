/**
 * A resource's rollups (rollups.ts) as one catalog serves them: each judged
 * against that catalog — the child resource, the one reference it points
 * here through, the column it sums, the query that narrows its rows — and
 * served as `TableMeta.rollups` where every name resolves.
 *
 * The same rule answers two readers. At load, against the whole catalog,
 * what does not resolve is a problem naming the fix. Per request, against
 * the catalog this reader is served — pruned to their grants — a rollup whose
 * child, reference or column they cannot read is simply not served, so a
 * list showing it says the column is not there rather than counting rows
 * the reader may not see.
 */
import { grantsByRole, type AppDef, type AppRollup } from './appModel.js';
import { ANYONE, saidAt } from '@mistriwork/engine/shared/query.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import { columnKind, tableNamed, type DatabaseSchema, type MachineStates, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { machineStates } from './appMachine.js';
import { backrefsTo, hopName, tryResolvePath } from '@mistriwork/engine/shared/viewPaths.js';
import { LABEL_SEGMENT } from '@mistriwork/engine/shared/recordLabel.js';
import type { Rollup } from '@mistriwork/engine/shared/rollups.js';
import { shortList } from '@mistriwork/engine/shared/suggest.js';
import { appComputedRules, computedConstants, withComputed } from './appComputed.js';
import { withUnions } from './appUnions.js';
import { appZone, zonedNow } from './appZone.js';
import { servedSegments } from './appSegments.js';
import {
  computedColumnMeta,
  computedReads,
  foldConstants,
  readsMe,
  type ComputedColumn,
  type ComputedNode,
} from '@mistriwork/engine/shared/computed.js';
import { parseComputed } from '@mistriwork/engine/shared/computedParse.js';
import { appTagRules } from './appResourceRules.js';
import { TAGS_COLUMN } from '@mistriwork/engine/shared/tagLists.js';

export function appRollupRules(
  app: AppDef,
  given: DatabaseSchema,
  now?: Date,
  zone?: string,
): { rules: Map<string, Record<string, Rollup>>; problems: string[] } {
  /* A rollup's query names a segment of the rows it counts as any query does (`count('report', { query: 'open' })`),
     so it is read against the catalog that carries them, whichever caller asks. */
  const schema = withMachineStates(app, given);
  const rules = new Map<string, Record<string, Rollup>>();
  const problems: string[] = [];
  const exact = grantsByRole(app);
  const named = (name: string): TableMeta | undefined =>
    exact ? schema.tables.find((table) => table.id === name) : tableNamed(schema, name);
  const declaredRollup = (tableId: string, key: string) =>
    Object.entries(app.resources ?? {}).some(
      ([name, resource]) => named(name)?.id === tableId && Boolean(resource.rollups && Object.hasOwn(resource.rollups, key)),
    );
  /* A rollup of a rollup waits for the plain ones; `nested` is every such
     one, so a third level is refused by name rather than by order. */
  const deferred: Array<() => void> = [];
  const nested = new Set<string>();
  /* Which child rows count: the rollup's query, over the child's own columns and paths through its
     references (`sales_order_id.status != cancelled`: a product's units sold, not counting cancelled
     orders). False when it does not parse, the problem said. */
  let readable: DatabaseSchema | undefined;
  const rowsQuery = (rollup: AppRollup, child: TableMeta, here: string): Pick<Rollup, 'filter' | 'reach' | 'computed'> | false => {
    if (rollup.query === undefined) return {};
    /* A computed column the query names is judged first, by the rule a summed one is: one that cannot be read
       here (it reads a rollup, a reference or the reader) is said by name, not as an unknown word. */
    const declared = Object.entries(app.resources ?? {}).find(([resource]) => named(resource)?.id === child.id)?.[1].computed ?? {};
    for (const name of Object.keys(declared))
      if (new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(rollup.query) && computedRead(child, name, `${here} query`) === false)
        return false;
    // Parsed where the child's computed columns are names, so `breached = true` reads as the list's own filter would.
    readable ??= withComputed(app, schema, now ?? new Date(), null, zone);
    /* `now` is the request's instant; a date phrase reads the App's wall clock (zonedNow), as a list's does. Read
       as given, `today` was the server's day, and a rollup counted Tokyo's tasks for a team in Chicago. */
    // `me` is read as anyone's here, so the rule below says why a rollup cannot ask it.
    const parsed = parseViewQuery(readable, child.id, rollup.query, now && zonedNow(appZone(app.ui, zone), now), { me: ANYONE });
    if (parsed.errors.length) {
      problems.push(`${here} query: ${saidAt(parsed.errors[0], rollup.query)}`);
      return false;
    }
    if (parsed.columns?.length || parsed.orderBy.length || parsed.limit !== undefined) {
      problems.push(`${here} query: a rollup's query only says which rows count — no show, sort or limit.`);
      return false;
    }
    const asked = parsed.filter.groups.flat().find((c) => c.any);
    if (asked) {
      problems.push(
        `${here} query: "${asked.path}" asks about the rows of its rows; a rollup's query reads its rows' own values and references.`,
      );
      return false;
    }
    const filter: Filter = {
      groups: parsed.filter.groups.map((group) =>
        group.map((c): Condition =>
          c.other === undefined ? { column: c.path, op: c.op, value: c.value } : { column: c.path, op: c.op, other: c.other },
        ),
      ),
    };
    /* A rollup is one figure for every reader, read without a session, so
       `me` was bound as the two letters: no match on SQLite, and on
       PostgreSQL a refused statement served as a bare data_unavailable. */
    const meant = filter.groups.some((group) => group.some((condition) => 'value' in condition && condition.value === 'me'));
    if (meant && /(?:^|[^"'\w])me(?![\w"'])/i.test(rollup.query)) {
      problems.push(
        `${here} query: a rollup is the same figure for every reader, so its query cannot say "me". Count every row, and narrow by the reader in a view or tab.`,
      );
      return false;
    }
    /* A path is read as the column it lands on, one scalar subquery per hop inside the rows' relation
       (rowScope.ts): forward references to a stored column only, so the figure is still one subquery
       and never reads another rollup, a computed column or a label. */
    const reach = new Map<string, Set<string>>();
    /* A computed column of the row (`breached`, from `due_on < today`) is its expression, written over the
       row in the narrowed relation: held to what a summed one is (computedRead), so it reads the row's own
       columns, never a rollup, a reference or the reader. */
    const computed: NonNullable<Rollup['computed']> = {};
    for (const name of filter.groups.flatMap((group) => group.flatMap((c) => [c.column, ...(c.other === undefined ? [] : [c.other])]))) {
      if (!name.includes('.')) {
        if (child.columns.some((column) => column.name === name) || Object.hasOwn(computed, name)) continue;
        const read = computedRead(child, name, `${here} query`);
        if (read === false) return false;
        if (read) {
          computed[name] = read.expression!;
          continue;
        }
        problems.push(
          `${here} query: "${name}" is not a column or a computed column on ${child.name}; a rollup's query reads its rows' own columns and paths through their references.`,
        );
        return false;
      }
      const { resolved } = tryResolvePath(schema, child.id, name);
      if (!resolved || resolved.rollup || resolved.computed || resolved.tags || resolved.jsonKey || !resolved.hops.length) {
        problems.push(
          `${here} query: "${name}" does not land on a stored column; a rollup's query follows references to a column of the row they name.`,
        );
        return false;
      }
      for (const hop of resolved.hops) {
        const at = reach.get(hop.to.table) ?? new Set<string>();
        hop.to.columns.forEach((column) => at.add(column));
        reach.set(hop.to.table, at);
      }
      resolved.hops.slice(1).forEach((hop) => hop.from.columns.forEach((column) => reach.get(hop.from.table)!.add(column)));
      reach.get(resolved.table.id)!.add(resolved.column.name);
    }
    return {
      ...(filter.groups.length ? { filter } : {}),
      ...(reach.size ? { reach: [...reach].map(([table, fields]) => ({ table, fields: [...fields] })) } : {}),
      ...(Object.keys(computed).length ? { computed } : {}),
    };
  };
  /* A computed column of the child a rollup reads (`sum('order_line', 'line_total')`, where line_total is
     `qty * price`): its expression, folded and written inline over the child's row. Undefined where the child
     declares none of that name; false where it does but cannot be read here — the problem said when the
     rollup is why, or the computed column not served in this catalog, its own check saying why at load. */
  let computedRules: Map<string, Record<string, ComputedColumn>> | undefined;
  const computedRead = (
    child: TableMeta,
    name: string,
    here: string,
  ): { type: string; expression: Rollup['expression'] } | false | undefined => {
    const declared = Object.entries(app.resources ?? {}).find(
      ([resource, block]) => named(resource)?.id === child.id && block.computed && Object.hasOwn(block.computed, name),
    )?.[1].computed![name];
    if (!declared) return undefined;
    const said = `"${child.name}.${name}"`;
    let parsed: ComputedNode | undefined;
    const isName = (path: string) =>
      path.includes('.') || child.columns.some((column) => column.name === path) || declaredRollup(child.id, path);
    try {
      parsed = parseComputed(declared.value, isName);
    } catch {
      /* its own check names the fault */
    }
    const reads = parsed ? computedReads(parsed) : [];
    /* One subquery over the child's own row: a rollup inside it would be a rollup of a rollup by another door, and
       one that reads back through the record could read the rollup being made. */
    const rolled = reads.find((read) => !read.includes('.') && declaredRollup(child.id, read));
    if (rolled) {
      problems.push(
        `${here}: ${said} is computed from the rollup "${rolled}", and a rollup reads a computed column only when it reads the row's own columns. ` +
          `Sum the column under it instead, or roll up "${rolled}" itself (a rollup of a rollup).`,
      );
      return false;
    }
    const through = reads.find((read) => read.includes('.'));
    if (through) {
      problems.push(
        `${here}: ${said} reads "${through}" through a reference, and a rollup reads a computed column only when it reads the row's own columns.`,
      );
      return false;
    }
    if (parsed && readsMe(parsed)) {
      problems.push(
        `${here}: ${said} says "me", and a rollup is the same figure for every reader. Roll up a computed column that does not.`,
      );
      return false;
    }
    computedRules ??= appComputedRules(app, schema).rules;
    const computed = computedRules.get(child.id)?.[name];
    if (!computed) return false;
    const expr = foldConstants(computed.expr, computedConstants(app, now ?? new Date(), null, zone));
    return { type: computedColumnMeta(name, computed).type, expression: { type: computed.type, expr, reads: computed.reads } };
  };
  /* The one reference named `name` from `from` to `to`, or the problem that says why there is none. */
  const hop = (from: TableMeta, to: TableMeta, name: string, here: string) => {
    const matched = backrefsTo(schema, to.id).filter(
      (backref) => backref.child === from.id && (hopName(backref.fk) === name || backref.fk.name === name),
    );
    if (matched.length !== 1) {
      const forward = schema.foreignKeys.filter((fk) => fk.from.table === from.id).map((fk) => hopName(fk));
      problems.push(
        `${here}: "${name}" is not a reference from "${from.name}"${to.id === from.id ? '' : ` to "${to.name}"`}.${forward.length ? ` Its references: ${shortList(forward)}.` : ''}`,
      );
      return undefined;
    }
    /* A rollup is a subquery in the parent's statement; rows in another source are in another database. */
    if (matched[0].fk.stitched) {
      problems.push(
        `${here}: "${from.name}" is in another source than "${to.name}", on another connection. A rollup counts rows in the same database; show the rows as a related list instead.`,
      );
      return undefined;
    }
    return matched[0].fk;
  };
  /* A latest is a word about the rows (a payment's status), read off the newest of them: a stored column of
     any type, ordered by its `sort` (a number or a date; kept as `by`) or by an integer key, which counts up as
     rows are made. Judged alike through one reference or two. */
  const latestOf = (
    rollup: AppRollup,
    child: TableMeta,
    here: string,
  ): { type: string; latest: Pick<Rollup, 'by' | 'allowed' | 'references'> } | undefined => {
    const column = child.columns.find((candidate) => candidate.name === rollup.column);
    if (!column) {
      problems.push(
        declaredRollup(child.id, rollup.column!) ||
          Object.entries(app.resources ?? {}).some(
            ([resource, block]) =>
              named(resource)?.id === child.id && Boolean(block.computed && Object.hasOwn(block.computed, rollup.column!)),
          )
          ? `${here}: "${child.name}.${rollup.column}" is not a stored column; a latest reads a column of the newest row as it was written.`
          : `${here}: "${child.name}" has no column "${rollup.column}".`,
      );
      return undefined;
    }
    const key = child.columns.filter((candidate) => candidate.primaryKey);
    const by = rollup.by === undefined ? (key.length === 1 ? key[0] : undefined) : child.columns.find((c) => c.name === rollup.by);
    if (!by) {
      problems.push(
        rollup.by === undefined
          ? `${here}: "${child.name}" has no single key to say which row is newest. Say which column with "sort", a date or a number.`
          : `${here}: "${child.name}" has no column "${rollup.by}" to order by.`,
      );
      return undefined;
    }
    const kind = columnKind(by.type);
    if (kind !== 'number' && kind !== 'date') {
      problems.push(
        `${here}: "${child.name}.${by.name}" is ${by.type || 'untyped'}, so it does not say which row is newest. ${rollup.by === undefined ? 'Name a date or a number with "sort".' : 'Order by a date or a number.'}`,
      );
      return undefined;
    }
    return {
      type: column.type,
      latest: {
        by: by.name,
        ...(column.allowed?.length ? { allowed: [...column.allowed] } : {}),
        // The newest row's reference is the record it points at: drawn as that record's name, not its key.
        ...(column.references ? { references: { ...column.references } } : {}),
      },
    };
  };
  /* Two references from the child to this table (`task_id.project_id`): the
     middle table is the first hop's, and each hop is found in this catalog,
     so a reader who cannot read the middle table, or either reference, is
     served no rollup — the same rule one hop keeps. Served as a rollup whose
     inner level reads the declared rows (rollups.ts `of`). */
  const twoHops = (rollup: AppRollup, child: TableMeta, table: TableMeta, here: string): Rollup | undefined => {
    const [first, second] = rollup.whose!.split('.');
    const out = schema.foreignKeys.filter((fk) => fk.from.table === child.id && (hopName(fk) === first || fk.name === first));
    const middle = out.length === 1 ? schema.tables.find((candidate) => candidate.id === out[0].to.table) : undefined;
    if (!middle) {
      hop(child, child, first, here);
      return undefined;
    }
    const inward = hop(child, middle, first, here);
    const outward = inward && hop(middle, table, second, here);
    if (!inward || !outward) return undefined;
    let type = 'integer';
    let expression: Rollup['expression'];
    let latest: Pick<Rollup, 'by' | 'allowed' | 'references'> | undefined;
    if (rollup.fn === 'latest') {
      const judged = latestOf(rollup, child, here);
      if (!judged) return undefined;
      ({ type, latest } = judged);
    } else if (rollup.fn !== 'count') {
      const column = child.columns.find((candidate) => candidate.name === rollup.column);
      const computed = column ? undefined : computedRead(child, rollup.column!, here);
      if (computed === false) return undefined;
      if (!column && !computed) {
        problems.push(
          `${here}: "${child.name}" has no column "${rollup.column}". A rollup through two references reads a column of its rows, not a rollup of them.`,
        );
        return undefined;
      }
      const read = column?.type ?? computed!.type;
      const kind = columnKind(read);
      if (rollup.fn === 'sum' ? kind !== 'number' : kind !== 'number' && kind !== 'date') {
        problems.push(
          `${here}: "${child.name}.${rollup.column}" is ${read || 'untyped'}; a ${rollup.fn} reads ${rollup.fn === 'sum' ? 'numbers' : 'numbers or dates'}.`,
        );
        return undefined;
      }
      type = read;
      expression = computed ? computed.expression : undefined;
    }
    const rows = rowsQuery(rollup, child, here);
    if (rows === false) return undefined;
    const inner: Rollup = {
      fn: rollup.fn,
      via: `${child.id}.${inward.from.columns.join('+')}`,
      ...(rollup.column === undefined ? {} : { column: rollup.column }),
      ...(expression ? { expression } : {}),
      ...latest,
      ...rows,
      type,
    };
    /* A latest through two references is the newest row of all the middle records' rows, not the newest of each
       middle's newest: one ordered read over the rows joined to their middle record (viewLabels.ts). Its vocabulary
       is the outer level's too, since that is the column a list reads. */
    return {
      fn: rollup.fn,
      via: `${middle.id}.${outward.from.columns.join('+')}`,
      type,
      ...(latest?.allowed ? { allowed: latest.allowed } : {}),
      ...(latest?.references ? { references: latest.references } : {}),
      of: inner,
    };
  };
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.rollups) continue;
    const table = named(name);
    if (!table) continue;
    const at = `resources "${name}", rollups`;
    /* An API source reads by its documented parameters and computes
       nothing, so there is no statement a rollup could ride in. */
    if (schema.dialect === 'http') {
      problems.push(
        `${at}: "${table.name}" is read from an API, which cannot count the rows that point at it. Rollups need a database source.`,
      );
      continue;
    }
    const served: Record<string, Rollup> = {};
    for (const [key, rollup] of Object.entries(resource.rollups)) {
      const here = `${at} "${key}"`;
      if (key === LABEL_SEGMENT || table.columns.some((column) => column.name === key)) {
        problems.push(
          `${here}: "${table.name}" already has a column "${key}". A rollup reads like a column, so it needs a name of its own.`,
        );
        continue;
      }
      const child = named(rollup.from);
      if (!child) {
        problems.push(`${here}: no resource "${rollup.from}" here to read rows from.`);
        continue;
      }
      if (rollup.whose?.includes('.')) {
        const made = twoHops(rollup, child, table, here);
        if (made) {
          served[key] = made;
          /* Already two levels deep: nothing reads it as the inner of another. */
          nested.add(`${table.id}.${key}`);
        }
        continue;
      }
      /* Through one reference from the child to this table: the one there
         is, or the one `whose` names when there are several. */
      const pointing = backrefsTo(schema, table.id).filter((backref) => backref.child === child.id);
      const through =
        rollup.whose === undefined
          ? pointing
          : pointing.filter((backref) => hopName(backref.fk) === rollup.whose || backref.fk.name === rollup.whose);
      if (!through.length) {
        problems.push(
          rollup.whose === undefined || !pointing.length
            ? `${here}: nothing on "${child.name}" points at "${table.name}", so it has no rows to ${rollup.fn === 'count' ? 'count' : 'read'} here.`
            : `${here}: "${rollup.whose}" is not a reference from "${child.name}" to "${table.name}". Its references here: ${shortList(pointing.map((backref) => hopName(backref.fk)))}.`,
        );
        continue;
      }
      if (through.length > 1) {
        problems.push(
          `${here}: "${child.name}" points at "${table.name}" through ${shortList(through.map((backref) => hopName(backref.fk)))}. Say which with "whose".`,
        );
        continue;
      }
      /* A rollup is a subquery in the parent's statement; rows in another source are in another database. */
      if (through[0].fk.stitched) {
        problems.push(
          `${here}: "${child.name}" is in another source than "${table.name}", on another connection. A rollup counts rows in the same database; ` +
            'show the rows as a related list instead.',
        );
        continue;
      }
      /* What a sum reads must be a number, a min or a max a number or a
         date: said the same of a column and of an inner rollup. */
      const reads = (type: string, what: string): boolean => {
        const kind = columnKind(type);
        if (rollup.fn === 'sum' ? kind === 'number' : kind === 'number' || kind === 'date') return true;
        problems.push(
          `${here}: ${what} is ${type || 'untyped'}; a ${rollup.fn} reads ${rollup.fn === 'sum' ? 'numbers' : 'numbers or dates'}.`,
        );
        return false;
      };
      let type = 'integer';
      /* Not a column of the child but one of its rollups: a rollup of a
         rollup (rollups.ts `of`), judged once the child's own are. */
      let inner = false;
      let expression: Rollup['expression'];
      let latest: Pick<Rollup, 'by' | 'allowed' | 'references'> | undefined;
      if (rollup.fn === 'latest') {
        const judged = latestOf(rollup, child, here);
        if (!judged) continue;
        ({ type, latest } = judged);
      } else if (rollup.fn !== 'count') {
        const column = child.columns.find((candidate) => candidate.name === rollup.column);
        inner = !column && declaredRollup(child.id, rollup.column!);
        const computed = column || inner ? undefined : computedRead(child, rollup.column!, here);
        if (computed === false) continue;
        if (!column && !inner && !computed) {
          problems.push(`${here}: "${child.name}" has no column "${rollup.column}".`);
          continue;
        }
        if (column && !reads(column.type, `"${child.name}.${column.name}"`)) continue;
        if (computed && !reads(computed.type, `the computed column "${child.name}.${rollup.column}"`)) continue;
        if (column) type = column.type;
        if (computed) ({ type, expression } = computed);
      }
      const rows = rowsQuery(rollup, child, here);
      if (rows === false) continue;
      const fk = through[0].fk;
      const made: Rollup = {
        fn: rollup.fn,
        via: `${child.id}.${fk.from.columns.join('+')}`,
        ...(rollup.column === undefined ? {} : { column: rollup.column }),
        ...(expression ? { expression } : {}),
        ...latest,
        ...rows,
        type,
      };
      if (!inner) {
        served[key] = made;
        continue;
      }
      nested.add(`${table.id}.${key}`);
      deferred.push(() => {
        const name = `"${child.name}.${rollup.column}"`;
        if (nested.has(`${child.id}.${rollup.column}`)) {
          problems.push(`${here}: ${name} is itself a rollup of a rollup. A rollup reads a column, or a rollup that reads one.`);
          return;
        }
        /* The inner rollup did not resolve: at load its own problem says
           why; in a reader's catalog it was not served, so neither is this. */
        const of = rules.get(child.id)?.[rollup.column!];
        if (of?.fn === 'latest') {
          problems.push(`${here}: ${name} is a latest, a word about one row; a rollup of a rollup reads a figure.`);
          return;
        }
        if (!of || !reads(of.type, `the rollup ${name}`)) return;
        rules.set(table.id, { ...rules.get(table.id), [key]: { ...made, type: of.type, of } });
      });
    }
    if (Object.keys(served).length) rules.set(table.id, served);
  }
  /* After every table's plain rollups are served, so an inner one is found
     whichever order the resources were declared in. */
  for (const judge of deferred) judge();
  // Served in the order they were declared, a rollup of a rollup where it was written.
  for (const [id, served] of rules) {
    const order = Object.keys(Object.entries(app.resources ?? {}).find(([name]) => named(name)?.id === id)?.[1].rollups ?? {});
    rules.set(id, Object.fromEntries(order.filter((key) => Object.hasOwn(served, key)).map((key) => [key, served[key]])));
  }
  return { rules, problems };
}

/**
 * The catalog an App serves, each table carrying the rollups that resolve in
 * it (appRollupRules) and then its computed columns (appComputed.ts), which
 * may read them. `me` is the reader a computed column's `me` means.
 */
export function withRollups(app: AppDef, given: DatabaseSchema, now?: Date, me: string | null = null, zone?: string): DatabaseSchema {
  return servedSegments(appCatalog(app, given, now, me, zone));
}

/**
 * withRollups before a segment that does not read is left out
 * (appSegments.ts servedSegments): what loading judges every segment against,
 * so a mistyped one is named rather than quietly not served.
 */
export function appCatalog(app: AppDef, given: DatabaseSchema, now?: Date, me: string | null = null, zone?: string): DatabaseSchema {
  const schema = withMachineStates(app, given);
  const { rules } = appRollupRules(app, schema, now, zone);
  const rolled = rules.size
    ? { ...schema, tables: schema.tables.map((table) => (rules.has(table.id) ? { ...table, rollups: rules.get(table.id)! } : table)) }
    : schema;
  /* A record's tags read as `tags` (tagLists.ts), where this catalog reads the
     link table, the tags and their names: a reader who cannot is served none. */
  const tagged = Object.values(app.resources ?? {}).some((resource) => resource.tags) ? appTagRules(app, rolled).rules : undefined;
  const withTags = tagged?.size
    ? {
        ...rolled,
        tables: rolled.tables.map((table) => {
          const rule = tagged.get(table.id);
          if (!rule || table.columns.some((column) => column.name === TAGS_COLUMN)) return table;
          const { through, to, from, key, via, tagKey, label, tone } = rule;
          return { ...table, tags: { through, to, from, key, via, tagKey, label, ...(tone ? { tone } : {}) } };
        }),
      }
    : rolled;
  return withUnions(app, withComputed(app, withTags, now, me, zone));
}

/**
 * The catalog with each machine's column carrying its states (appMachine.ts
 * machineStates), so every condition the App's catalog parses — a view, a tab,
 * a metric, a rollup's rows — reads `status is open` and `status is onBench`.
 * Idempotent: a column that already carries them is left as it is.
 */
const statedCatalogs = new WeakMap<DatabaseSchema, WeakMap<AppDef, DatabaseSchema>>();
export function withMachineStates(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  /* Kept per catalog and App, so the parse cache (query.ts), keyed by the catalog object, still hits per request. */
  let kept = statedCatalogs.get(schema);
  if (!kept) statedCatalogs.set(schema, (kept = new WeakMap()));
  const found = kept.get(app);
  if (found) return found;
  const made = statedCatalog(app, schema);
  kept.set(app, made);
  return made;
}

function statedCatalog(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  const exact = grantsByRole(app);
  const byTable = new Map<string, { column: string; states: MachineStates }>();
  /* A resource's segments ride here too (appSegments.ts): every condition this catalog parses reads their names. */
  const segmentsOf = new Map<string, Record<string, string>>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.machine && !resource.segments) continue;
    const table = exact ? schema.tables.find((candidate) => candidate.id === name) : tableNamed(schema, name);
    if (!table) continue;
    if (resource.machine) byTable.set(table.id, { column: resource.machine.column, states: machineStates(resource.machine) });
    if (resource.segments)
      segmentsOf.set(table.id, Object.fromEntries(Object.entries(resource.segments).map(([key, segment]) => [key, segment.query])));
  }
  if (!byTable.size && !segmentsOf.size) return schema;
  let changed = false;
  const tables = schema.tables.map((table) => {
    const machine = byTable.get(table.id);
    const segments = table.segments ? undefined : segmentsOf.get(table.id);
    const at = machine ? table.columns.findIndex((column) => column.name === machine.column) : -1;
    const states = machine && at >= 0 && !table.columns[at].states;
    if (!states && !segments) return table;
    changed = true;
    const columns = [...table.columns];
    if (states) columns[at] = { ...columns[at], states: machine!.states };
    return { ...table, columns, ...(segments ? { segments } : {}) };
  });
  return changed ? { ...schema, tables } : schema;
}
