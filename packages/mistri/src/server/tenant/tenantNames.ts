/**
 * What a person calls a tenant: its profile row's record name (`auth.tenancy.profile`,
 * named as the App names that resource's records), never the id it is addressed by.
 *
 * The chooser, the bar's control and the enter-a-tenant dialog stand before any
 * context is open, so no scoped read can say the name there: the tenant read
 * source reads it directly, for the ids the caller already holds (an account's
 * own memberships, or the tenants a support grant offers). It reads the profile's
 * key and the columns the name is made of and nothing else, and it admits nobody.
 *
 * A name is only what the App's template says in the profile's own columns. One
 * that walks a reference, masks a column, or reads nothing but the key (the
 * noun-and-key a table without a name is given, "Branch #north") says no
 * more than the id, so there is no name and the caller shows the id.
 */
import { withLabelTemplates, type AppDef } from '../../shared/app.js';
import { LABEL_SEGMENT, parseLabelTemplate } from '@mistriwork/engine/shared/recordLabel.js';
import { labelPath, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { intakeProfileKey } from './tenantIntakeModel.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';

/** At most this many tenants are named in one read: a support choice list is two hundred. */
export const TENANT_NAMES_MAX = 256;

type Part = { readonly text: string } | { readonly column: string; readonly words?: Readonly<Record<string, string>> };
interface TenantNamePlan {
  readonly key: string;
  readonly parts: readonly Part[];
  readonly columns: readonly string[];
}

/** The profile's record name as a template, the way a grid names one of its
 * records (labelPath): the App's template, or the column a name is read from
 * — the resource's `recordLabel`, else the one the catalog would pick. */
export function profileNameTemplate(app: AppDef, schema: DatabaseSchema, profile: string | undefined): string | undefined {
  if (profile === undefined) return undefined;
  const table = withLabelTemplates(app, schema).tables.find((candidate) => candidate.id === profile);
  if (!table) return undefined;
  const authored = app.resources?.[profile]?.recordLabel;
  const path = labelPath(schema, table, typeof authored === 'string' || authored === false ? authored : undefined);
  return path === LABEL_SEGMENT ? table.labelTemplate : path === undefined ? undefined : `{${path}}`;
}

/** The plan for a profile's names, or undefined when its template names nothing an id does not. */
export function tenantNamePlan(owned: TenantOwnershipSnapshot, template: string | undefined): TenantNamePlan | undefined {
  if (owned.profile === undefined || template === undefined) return undefined;
  const parsed = parseLabelTemplate(template);
  if ('problem' in parsed) return undefined;
  const table = owned.schema.tables.find((candidate) => candidate.id === owned.profile);
  let key: string;
  try {
    key = intakeProfileKey(owned);
  } catch {
    return undefined;
  }
  const parts: Part[] = [];
  for (const part of parsed.parts) {
    if ('text' in part) {
      parts.push({ text: part.text });
      continue;
    }
    if (part.mask || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part.path) || !table?.columns.some((column) => column.name === part.path))
      return undefined;
    parts.push({ column: part.path, ...(part.words ? { words: part.words } : {}) });
  }
  const columns = [...new Set(parts.flatMap((part) => ('column' in part ? [part.column] : [])))];
  if (!columns.length || columns.every((column) => column === key)) return undefined;
  return Object.freeze({ key, parts: Object.freeze(parts), columns: Object.freeze(columns) });
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** The profile rows of `count` tenants, in the engine's spelling: the key as
 * `tenant` and each column the name reads as `c0`, `c1`…; one parameter per
 * tenant on SQLite, one array on PostgreSQL. */
export function tenantNamesQuery(owned: TenantOwnershipSnapshot, plan: TenantNamePlan, count: number): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > TENANT_NAMES_MAX) return denyTenant();
  const physical = owned.resources[owned.profile ?? denyTenant()] ?? denyTenant();
  const select = plan.columns.map((column, index) => `${quoted(column)} AS c${index}`).join(', ');
  if (owned.schema.dialect !== 'postgres') {
    return `SELECT ${quoted(plan.key)} AS tenant, ${select} FROM main.${quoted(physical)}
      WHERE ${quoted(plan.key)} IN (${Array.from({ length: count }, () => '?').join(', ')})`;
  }
  const dot = physical.indexOf('.');
  if (dot < 1) return denyTenant();
  return `SELECT ${quoted(plan.key)}::text AS tenant, ${select} FROM ${quoted(physical.slice(0, dot))}.${quoted(physical.slice(dot + 1))}
    WHERE ${quoted(plan.key)}::text = ANY($1::text[])`;
}

/** Each asked tenant's name from its row, said as the template says it; a
 * tenant with no row, or a name that comes out blank, has none. */
export function tenantNamesOf(
  plan: TenantNamePlan,
  rows: readonly Record<string, unknown>[],
  asked: readonly string[],
): Readonly<Record<string, string>> {
  const wanted = new Set(asked);
  const names: Record<string, string> = Object.create(null);
  for (const row of rows) {
    if (typeof row.tenant !== 'string' || !wanted.has(row.tenant)) continue;
    const name = plan.parts
      .map((part) => {
        if ('text' in part) return part.text;
        const value = row[`c${plan.columns.indexOf(part.column)}`];
        const text = value === null || value === undefined ? '' : String(value);
        return part.words && Object.hasOwn(part.words, text) ? part.words[text] : text;
      })
      .join('')
      .trim();
    if (name && name.length <= 200) names[row.tenant] = name;
  }
  return Object.freeze(names);
}

/** What each tenant is called, for the ids the caller already holds (an enrollment's `names`). */
export type TenantNames = (tenants: readonly string[]) => Promise<Readonly<Record<string, string>>>;

/** Each item with its tenant's name where it has one. A name is words for a
 * person, never authority: every request still sends the id, and a lookup
 * that fails leaves the ids to speak for themselves. */
export async function namedTenants<T extends { readonly tenantId: string }>(
  items: readonly T[],
  names?: TenantNames,
): Promise<readonly (T & { readonly name?: string })[]> {
  if (!names || !items.length) return items;
  let found: Readonly<Record<string, string>>;
  try {
    found = await names(items.map((item) => item.tenantId));
  } catch {
    return items;
  }
  return items.map((item) => (Object.hasOwn(found, item.tenantId) ? { ...item, name: found[item.tenantId] } : item));
}
