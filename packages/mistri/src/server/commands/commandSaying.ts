/**
 * A column said the way the App shows it, for the words a refusal tells a person: its caption where the App gives
 * one, its value as its display rule draws it (an amount kept in cents as money). Built beside the catalog a command
 * is bound to (businessCommandAuthorization.ts), and read only when a `when` fails, so a running command pays nothing.
 *
 * It says what the App's own screens say and no more: a column with no rule is its stored value, a caption-less one
 * is its name. Whether the person may read the column is the caller's to decide (commandActorColumns.ts).
 */
import { effectiveDisplay, declaredDisplayOf } from '@mistriwork/engine/shared/displayDefaults.js';
import type { AppDef } from '../../shared/appModel.js';
import { minorToMajor, rowCurrency } from '@mistriwork/engine/shared/money.js';
import { findTable, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Condition } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandCatalog } from './commandDb.js';

export interface ColumnSaying {
  /** The App's caption for the column, else its name. */
  label(column: string): string;
  /** A stored value as the App shows it. */
  value(column: string, value: unknown, row: Readonly<Record<string, unknown>>): string;
}

/** The catalog with how each table's columns are said; unchanged for a table the schema does not hold. */
export function withSaying(
  catalog: CommandCatalog,
  app: AppDef,
  schema: DatabaseSchema,
  logical: (local: string) => string,
): CommandCatalog {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(catalog).map(([name, table]) => {
        // Named once, not once per table the catalog holds: `logical` reads the App's sources each time.
        const id = logical(name);
        const meta = findTable(schema, id);
        if (!meta) return [name, table];
        const resource = app.resources?.[meta.id] ?? (tableNamed(schema, meta.name) ? app.resources?.[meta.name] : undefined);
        let display: ReturnType<typeof effectiveDisplay> | undefined;
        const rules = () =>
          (display ??= effectiveDisplay(resource?.display, meta, { schema, declared: declaredDisplayOf(app, schema), served: true }));
        const locale = app.ui?.locale ?? 'en-US';
        const fallback = app.ui?.currency ?? 'USD';
        const saying: ColumnSaying = {
          label: (column) => resource?.labels?.[column] ?? column,
          value(column, value, row) {
            if (value === null || value === undefined || value === '') return 'empty';
            const rule = rules()[column];
            if (rule?.format === 'money') {
              const currency = rowCurrency(rule, row, fallback);
              const figure = rule.minor === true ? (minorToMajor(value, currency) ?? value) : value;
              const amount = Number(figure);
              if (Number.isFinite(amount))
                try {
                  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
                } catch {
                  return String(figure);
                }
            }
            return typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
          },
        };
        return [name, Object.freeze({ ...table, saying })];
      }),
    ),
  );
}

const NEEDS: Readonly<Record<string, string>> = { '=': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥' };

/**
 * Why a record failed a command's declarative `when`, in one sentence about its first failing part:
 * `balance_cents is $108.99; needs ≤ $0.00`. Only a column the person may read is named with its value
 * (`mayRead`); otherwise undefined, and the refusal keeps its generic sentence.
 */
export function whenRefusalSentence(
  saying: ColumnSaying | undefined,
  condition: Condition | undefined,
  row: Readonly<Record<string, unknown>>,
  mayRead: (column: string) => boolean,
): string | undefined {
  if (!saying || !condition || !mayRead(condition.column)) return undefined;
  const name = saying.label(condition.column);
  const is = `${name} is ${saying.value(condition.column, row[condition.column], row)}`;
  const say = (value: unknown) => saying.value(condition.column, value, row);
  switch (condition.op) {
    case 'isNull':
      return `${is}; needs to be empty`;
    case 'isNotNull':
      return `${is}; needs a value`;
    case 'in': {
      const list = Array.isArray(condition.value) ? condition.value : [condition.value];
      return `${is}; needs one of ${list.map(say).join(', ')}`;
    }
    default:
      return Object.hasOwn(NEEDS, condition.op) && condition.value !== undefined
        ? `${is}; needs ${NEEDS[condition.op]} ${say(condition.value)}`
        : undefined;
  }
}
