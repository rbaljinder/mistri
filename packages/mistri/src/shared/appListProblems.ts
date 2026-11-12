/**
 * What a list presentation may be drawn from, judged against the readable
 * catalog: one verdict per kind (checklist, cards, split, custom, tree, gantt,
 * calendar, queue, board). It lives apart from app.ts because it is a pure
 * function of a presentation, a table and a catalog, and that manifest parser
 * had outgrown a file a person can hold.
 */
import { cardsProblem } from '@mistriwork/engine/shared/appCards.js';
import type { AppCalendarBackdrop, AppChecklist, AppListPresentation } from '@mistriwork/engine/shared/listPresentations.js';
import {
  columnKind,
  columnOrRollup,
  primaryKey,
  tableNamed,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { resolvePath } from '@mistriwork/engine/shared/view.js';

/* A column that holds a moment, not only a day: Postgres's timestamp (with or without its zone), SQLite's declared
   TIMESTAMP or DATETIME. */
const TIMESTAMP_TYPE = /timestamp|datetime/i;

/** Validate against the readable catalog; callers must not publish these errors after field pruning. */
function checklistProblem(list: AppChecklist, table: TableMeta): string | undefined {
  if (!table.columns.some((column) => column.primaryKey)) return 'Checklist requires a complete readable primary key.';
  const names: Array<[string, string]> = [
    ['primary', list.primary],
    ['checked', list.checked],
    ...(list.lines ?? []).map((line, i): [string, string] => [`lines[${i}]`, line]),
  ];
  for (const [key, name] of names) {
    const column = table.columns.find((column) => column.name === name);
    if (!column || name.includes('.')) return `Checklist ${key}: "${name}" must be a local readable column.`;
    if (key === 'primary' && columnKind(column.type) !== 'text') return 'Checklist primary must be a text column.';
    if (key === 'checked' && columnKind(column.type) !== 'boolean')
      return 'Checklist checked must be a boolean column (declare BOOLEAN in SQLite).';
  }
  return undefined;
}

/**
 * A calendar's shaded span against the readable catalog: its resource is a table here, its ends are its date
 * columns, and its label is one of its columns. A reader's catalog that lacks any of them is not offered the span
 * (appFieldProjection.ts), and the calendar stands without it.
 */
export function backdropProblem(span: AppCalendarBackdrop, schema: DatabaseSchema): string | undefined {
  const table = tableNamed(schema, span.from);
  if (!table) return `Calendar backdrop: no table "${span.from}" is readable here.`;
  for (const [key, name] of [
    ['start', span.start],
    ['end', span.end],
  ] as const) {
    const column = table.columns.find((candidate) => candidate.name === name);
    if (!column) return `Calendar backdrop ${key}: "${name}" is not a column of "${table.name}" that is readable here.`;
    if (!/date|time/i.test(column.type ?? ''))
      return `Calendar backdrop ${key}: "${name}" is ${column.type || 'untyped'}; a span runs between date columns.`;
  }
  if (!table.columns.some((candidate) => candidate.name === span.labelColumn))
    return `Calendar backdrop labelColumn: "${span.labelColumn}" is not a column of "${table.name}" that is readable here.`;
  if (!primaryKey(table).length) return `Calendar backdrop: "${table.name}" needs a complete readable primary key.`;
  return undefined;
}

/** Every list presentation, judged against the readable catalog the same way. */
export function listProblem(
  list: AppListPresentation,
  table: TableMeta,
  schema?: DatabaseSchema,
  files?: ReadonlySet<string>,
  icons?: (column: string) => boolean,
): string | undefined {
  if (list.kind === 'checklist') return checklistProblem(list, table);
  if (list.kind === 'cards') return cardsProblem(list, table, schema, files, icons);
  /* A split's columns are label paths, judged by the path resolver where the
     entry's own show is; there is no local column of its own to check here. */
  if (list.kind === 'split') {
    if (!list.row) return undefined;
    /* Its rows are a queue's, judged as a queue's, the avatar being one more name. */
    const { avatar, ...queue } = list.row;
    const bad = listProblem({ kind: 'queue', ...queue }, table, schema, files);
    if (bad) return bad.replace(/^Queue/, 'Split row');
    if (avatar !== undefined && !avatar.includes('.') && !table.columns.some((column) => column.name === avatar))
      return `Split row avatar: "${avatar}" must be a readable column.`;
    return undefined;
  }
  /* A custom list reads its label paths as a split's are read: through the path resolver, against this catalog. */
  if (list.kind === 'custom') {
    if (!schema) return undefined;
    for (const path of list.show) {
      try {
        resolvePath(schema, table.id, path);
      } catch (err) {
        return `Custom list show: "${path}" (${(err as Error).message}).`;
      }
    }
    return undefined;
  }
  if (list.kind === 'tree' || list.kind === 'gantt') {
    const word = list.kind === 'tree' ? 'Tree' : 'Gantt';
    if (!table.columns.some((column) => column.primaryKey)) return `${word} requires a complete readable primary key.`;
    if (list.kind === 'tree') {
      const parent = table.columns.find((column) => column.name === list.parent);
      if (!parent) return `Tree parent: "${list.parent}" must be a local readable column.`;
      const self = schema?.foreignKeys.some(
        (fk) =>
          fk.from.table === table.id && fk.to.table === table.id && fk.from.columns.length === 1 && fk.from.columns[0] === list.parent,
      );
      if (schema && !self) return `Tree parent: "${list.parent}" must reference "${table.name}" itself, the record above each one.`;
    } else {
      for (const [key, name] of [
        ['start', list.start],
        ['end', list.end],
      ] as const) {
        const column = table.columns.find((candidate) => candidate.name === name);
        if (!column) return `Gantt ${key}: "${name}" must be a local readable column.`;
        if (!/date|time/i.test(column.type ?? ''))
          return `Gantt ${key}: "${name}" is ${column.type || 'untyped'}; a bar runs between date columns.`;
      }
      if (list.progress !== undefined) {
        const progress = table.columns.find((candidate) => candidate.name === list.progress);
        if (!progress || columnKind(progress.type) !== 'number')
          return `Gantt progress: "${list.progress}" must be a local numeric column (0–100).`;
      }
    }
    const named = [
      ['primary', list.primary],
      ...(list.kind === 'tree' ? (list.lines ?? []).map((line, i) => [`lines[${i}]`, line]) : []),
      ...(list.kind === 'gantt' && list.by !== undefined ? [['by', list.by]] : []),
    ] as Array<[string, string]>;
    for (const [key, name] of named) {
      let column = table.columns.find((candidate) => candidate.name === name);
      if (name.includes('.')) {
        if (!schema) continue;
        try {
          column = resolvePath(schema, table.id, name).column;
        } catch (error) {
          return `${word} ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
        }
      }
      if (!column) return `${word} ${key}: "${name}" must be a readable column.`;
    }
    return undefined;
  }
  if (list.kind === 'calendar') {
    if (!table.columns.some((column) => column.primaryKey)) return 'Calendar requires a complete readable primary key.';
    const date = table.columns.find((column) => column.name === list.date);
    if (!date || list.date.includes('.')) return `Calendar date: "${list.date}" must be a local readable column.`;
    if (!/date|time/i.test(date.type ?? ''))
      return `Calendar date: "${list.date}" is ${date.type || 'untyped'}; a calendar places records by a date column.`;
    if (list.end !== undefined) {
      const end = table.columns.find((column) => column.name === list.end);
      if (!end || list.end.includes('.')) return `Calendar end: "${list.end}" must be a local readable column.`;
      if (!/date|time/i.test(end.type ?? ''))
        return `Calendar end: "${list.end}" is ${end.type || 'untyped'}; a record's last day is a date column.`;
    }
    /* A week or a day places a record by its hour, which a column holding only a day does not have: the grid would
       stand every record at midnight. */
    if (list.span) {
      for (const [key, name] of [['date', list.date], ...(list.end === undefined ? [] : [['end', list.end]])] as const) {
        const type = table.columns.find((column) => column.name === name)?.type ?? '';
        if (!TIMESTAMP_TYPE.test(type))
          return `Calendar ${key}: "${name}" is ${type || 'untyped'}; a ${list.span} places records by their time, so it needs a timestamp column.`;
      }
    }
    const named = [
      ['primary', list.primary],
      ...(list.badge === undefined ? [] : [['badge', list.badge]]),
      ...(list.lines ?? []).map((line, i) => [`lines[${i}]`, line]),
    ] as Array<[string, string]>;
    for (const [key, name] of named) {
      let column = table.columns.find((candidate) => candidate.name === name);
      if (name.includes('.')) {
        // As a queue's: a caller with the catalog proves the one-hop path.
        if (!schema) continue;
        try {
          column = resolvePath(schema, table.id, name).column;
        } catch (error) {
          return `Calendar ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
        }
      }
      if (!column) return `Calendar ${key}: "${name}" must be a readable column.`;
      if (key === 'primary' && columnKind(column.type) !== 'text') return 'Calendar primary must be a text column.';
    }
    for (const span of schema ? (list.backdrop ?? []) : []) {
      const problem = backdropProblem(span, schema!);
      if (problem) return problem;
    }
    return undefined;
  }
  const word = list.kind === 'queue' ? 'Queue' : 'Board';
  if (!table.columns.some((column) => column.primaryKey)) return `${word} requires a complete readable primary key.`;
  const lines = (list.lines ?? []).map((line, i): [string, string] => [`lines[${i}]`, line]);
  if (list.kind === 'queue') {
    const named: Array<[string, string]> = [
      ['primary', list.primary],
      ...(list.badge === undefined ? [] : [['badge', list.badge] as [string, string]]),
      ...lines,
      ...(list.facts ?? []).map((fact, i): [string, string] => [`properties[${i}]`, fact]),
    ];
    for (const [key, name] of named) {
      let column = table.columns.find((candidate) => candidate.name === name);
      // A fact, a line or the badge may be a rollup of the row: a pick list's lines, a board's open threads.
      if (!column && key !== 'primary' && columnOrRollup(table, name)) continue;
      if (name.includes('.')) {
        /* Callers with a catalog prove the reference path; a local-only caller
           retains the old local validation without crashing on a path. */
        if (!schema) continue;
        try {
          column = resolvePath(schema, table.id, name).column;
        } catch (error) {
          return `Queue ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
        }
      }
      if (!column) return `Queue ${key}: "${name}" must be a readable column.`;
      /* A reference column titles the card by the record it names, as a board's does; a path reads one column of it. */
      if (key === 'primary' && columnKind(column.type) !== 'text' && !(column.references && !name.includes('.')))
        return `Queue primary must be a text column, a reference (which titles each card by the record it names), or a label path to a text column.`;
    }
    return undefined;
  }
  const names: Array<[string, string]> = [['by', list.by], ['primary', list.primary], ...lines];
  for (const [key, name] of names) {
    let column = table.columns.find((column) => column.name === name);
    /* A board's title may be read through one reference, as a queue's is: `patient_id.name`. A caller without the
       catalog cannot prove the path and keeps the local checks. */
    if (key === 'primary' && name.includes('.')) {
      if (!schema) continue;
      try {
        column = resolvePath(schema, table.id, name).column;
      } catch (error) {
        return `Board primary: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
      }
      if (columnKind(column.type) !== 'text')
        return 'Board primary must be a text column, or a reference, which titles each card by the record it names.';
      continue;
    }
    // A board's line or footer fact may say a referenced record's column, one hop, as a queue's line may.
    if (key.startsWith('lines[') && name.includes('.')) {
      if (!schema) continue;
      try {
        resolvePath(schema, table.id, name);
      } catch (error) {
        return `Board ${key}: "${name}" is not a readable one-hop reference label path (${(error as Error).message}).`;
      }
      continue;
    }
    // A board's line may be a rollup or a computed number of the row, as a queue's may: a problem's open tickets.
    if (!column && key.startsWith('lines[') && columnOrRollup(table, name)) continue;
    if (!column || name.includes('.')) return `${word} ${key}: "${name}" must be a local readable column.`;
    /* A reference titles a card by the record it names, as a cell does (listReferenceNames): a fulfillment is
       its order, `#1042 · Ana Ruiz`, with no copy of the order's name kept on the parcel. */
    if (key === 'primary' && columnKind(column.type) !== 'text' && !column.references)
      return `${word} primary must be a text column, or a reference, which titles each card by the record it names.`;
    if (key === 'by' && column.primaryKey) return 'Board by must not be a primary key column.';
  }
  if (schema) {
    for (const [i, fact] of (list.footer ?? []).entries()) {
      if (!fact.column.includes('.')) continue;
      try {
        resolvePath(schema, table.id, fact.column);
      } catch (error) {
        return `Board footer[${i}]: "${fact.column}" is not a readable one-hop reference label path (${(error as Error).message}).`;
      }
    }
  }
  if (list.kind === 'board' && list.lanes) {
    const allowed = table.columns.find((column) => column.name === list.by)?.allowed;
    const unknown = allowed && list.lanes.filter((lane) => !allowed.includes(lane));
    if (unknown?.length)
      return `Board lanes ${unknown.map((lane) => JSON.stringify(lane)).join(', ')} are not in the declared vocabulary of "${list.by}".`;
  }
  if (list.kind === 'board' && list.order !== undefined) {
    const order = table.columns.find((column) => column.name === list.order);
    if (!order || list.order.includes('.')) return `Board order: "${list.order}" must be a local readable column.`;
    if (columnKind(order.type) !== 'number')
      return `Board order: "${list.order}" is ${order.type || 'untyped'}; a card's place in its lane is a number.`;
    if (order.primaryKey) return 'Board order must not be a primary key column.';
    if (list.order === list.by) return 'Board order must be another column than by: one says the lane, the other the place in it.';
  }
  if (list.kind === 'board' && list.swimlanes !== undefined) {
    const rows = table.columns.find((column) => column.name === list.swimlanes);
    if (!rows || list.swimlanes.includes('.')) return `Board swimlanes: "${list.swimlanes}" must be a local readable column.`;
    if (rows.primaryKey) return 'Board swimlanes must not be a primary key column: a row per record is a list, not a board.';
  }
  if (list.kind === 'board' && list.sum !== undefined) {
    const sum = table.columns.find((column) => column.name === list.sum);
    if (!sum || list.sum.includes('.')) return `Board sum: "${list.sum}" must be a local readable column.`;
    if (columnKind(sum.type) !== 'number') return `Board sum: "${list.sum}" is ${sum.type || 'untyped'}; a lane's sum adds numbers.`;
  }
  if (list.kind === 'board' && list.folded && !list.lanes) {
    const allowed = table.columns.find((column) => column.name === list.by)?.allowed;
    const unknown = allowed && list.folded.filter((lane) => !allowed.includes(lane));
    if (unknown?.length)
      return `Board folded ${unknown.map((lane) => JSON.stringify(lane)).join(', ')} are not in the declared vocabulary of "${list.by}".`;
  }
  /* Authored lanes already bound the limits' keys (the parser checks them); otherwise a vocabulary does. */
  if (list.kind === 'board' && list.limits && !list.lanes) {
    const allowed = table.columns.find((column) => column.name === list.by)?.allowed;
    const unknown = allowed && Object.keys(list.limits).filter((lane) => !allowed.includes(lane));
    if (unknown?.length)
      return `Board limits ${unknown.map((lane) => JSON.stringify(lane)).join(', ')} are not in the declared vocabulary of "${list.by}".`;
  }
  return undefined;
}
