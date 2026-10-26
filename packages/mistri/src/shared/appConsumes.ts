/**
 * `consumes`: a line that uses stock moves the balance it uses.
 *
 *   work_order_part: { consumes: { column: 'part_id.on_hand', by: 'quantity', refuse: 'Only {part_id.on_hand} of {part_id.name} left' } }
 *
 * The rule is declared on the line, and the App's write layer holds it on
 * every write of the line (server/app/appConsumes.ts): a new line takes `by`
 * from the record its reference names, a removed one gives it back, an edit
 * moves the difference or, when the reference changes, gives back to one and
 * takes from the other. A take that would leave the balance below zero
 * refuses the whole write, unless the rule says `floor: false`.
 *
 * `restocks` is the same rule the other way round, on a line that brings
 * stock in (a receipt's line, a return to stock): a new line adds to the
 * balance, a removed one takes it back out, and that take is what is held to
 * the floor, so a receipt whose parts were used since cannot be undone.
 * Receiving stock is then a New form on the receipt, with no command.
 *
 * A balance that is stored and must refuse an oversell is `consumes`; a figure
 * that is only read is a rollup (`sum('work_order_part', 'quantity')`).
 *
 * This module is the catalog's half: what a rule names, resolved once, and the
 * problems that keep an App from loading — a reference the line does not
 * have, a balance or `by` that is not a number, a whole-number balance moved
 * by a decimal. A path of more than one reference is refused where the block
 * is read (appResourceBlocks.ts).
 */
import type { AppDef } from './appModel.js';
import { columnKind, tableNamed, type ColumnMeta, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

/** One rule against the catalog: the line's table and columns, the parent's table, key and balance. */
export interface ConsumesRule {
  /** The line's table id. */
  table: string;
  reference: string;
  /** The parent's table id, and the column of it the reference holds. */
  parent: string;
  parentKey: string;
  balance: string;
  /** The line's amount column; absent, one per line. */
  by?: string;
  message?: string;
  /** The parent's columns the balance and the `message` sentence read (`{part_id.name}`): what a refusal fetches. */
  mentions: string[];
  /** False when `floor: false` lets the balance go below zero. */
  floor: boolean;
  /** A `restocks` rule: the line adds to the balance rather than taking from it. */
  gives?: true;
}

/* A whole-number column: one a decimal amount cannot be taken from without
   the database rounding it, differently on each engine. */
const whole = (column: ColumnMeta) => /int|serial/i.test(column.type ?? '') && !/point|interval/i.test(column.type ?? '');

/** Every resource's `consumes` against the catalog, by the line's table id, with what keeps a rule from holding. */
export function appConsumesRules(app: AppDef, schema: DatabaseSchema): { rules: Map<string, ConsumesRule[]>; problems: string[] } {
  const rules = new Map<string, ConsumesRule[]>();
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const declared = [
      ...(resource.consumes ?? []).map((rule, i, all) => ({ rule, key: 'consumes', i, all })),
      ...(resource.restocks ?? []).map((rule, i, all) => ({ rule, key: 'restocks', i, all })),
    ];
    if (!declared.length) continue;
    const table = tableNamed(schema, name);
    // A resource the catalog lacks is said once, by the resource check.
    if (!table) continue;
    declared.forEach(({ rule, key, i, all }) => {
      const at = `resources "${name}", ${key}${all.length > 1 ? ` rule ${i + 1}` : ''}`;
      const path = `"${rule.reference}.${rule.balance}"`;
      const via = table.columns.find((column) => column.name === rule.reference);
      if (!via?.references) {
        problems.push(
          `${at}: ${path} starts with "${rule.reference}", which is not a reference of "${name}" [consumes-path]: ` +
            `name one of its references, then a number column of the record it names (${referenceHint(table.columns)}).`,
        );
        return;
      }
      const parent = schema.tables.find((candidate) => candidate.id === via.references!.table);
      const balance = parent?.columns.find((column) => column.name === rule.balance);
      if (!parent || !balance || balance.primaryKey || columnKind(balance.type) !== 'number') {
        problems.push(
          `${at}: ${path} is not a number column of "${parent?.name ?? via.references.table}" [consumes-balance]: ` +
            `the balance a line moves is a number the record keeps, like "on_hand".`,
        );
        return;
      }
      const by = rule.by === undefined ? undefined : table.columns.find((column) => column.name === rule.by);
      if (rule.by !== undefined && (!by || columnKind(by.type) !== 'number')) {
        problems.push(
          `${at}: "by" names "${rule.by}", which is not a number column of "${name}" [consumes-by]: ` +
            `name the line's amount, like "quantity", or leave "by" out for one per line.`,
        );
        return;
      }
      if (by && whole(balance) && !whole(by)) {
        problems.push(
          `${at}: "${rule.balance}" holds whole numbers and "${rule.by}" may be a fraction [consumes-decimal]: ` +
            `give both columns the same numeric type, so a move is never rounded.`,
        );
        return;
      }
      const resolved: ConsumesRule = {
        table: table.id,
        reference: rule.reference,
        parent: parent.id,
        parentKey: via.references.column,
        balance: rule.balance,
        ...(rule.by !== undefined ? { by: rule.by } : {}),
        ...(rule.message !== undefined ? { message: rule.message } : {}),
        mentions: [
          ...new Set([
            rule.balance,
            ...[...(rule.message ?? '').matchAll(/\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}/g)]
              .filter(([, hop, column]) => hop === rule.reference && parent.columns.some((item) => item.name === column))
              .map(([, , column]) => column),
          ]),
        ],
        floor: rule.floor !== false,
        ...(key === 'restocks' ? { gives: true as const } : {}),
      };
      rules.set(table.id, [...(rules.get(table.id) ?? []), resolved]);
    });
  }
  return { rules, problems };
}

function referenceHint(columns: readonly ColumnMeta[]): string {
  const references = columns.filter((column) => column.references).map((column) => `"${column.name}"`);
  return references.length ? `its references: ${references.slice(0, 6).join(', ')}` : 'it has none';
}
