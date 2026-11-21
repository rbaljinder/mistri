/**
 * `mistri tenant grant` for several accounts and tenants: the rows a run would grant, read from the flags (every
 * account in every tenant) or from a CSV file, and every row checked before any is applied, so a bad row is said
 * in words with the others and nothing has been written. What needs the store (is the tenant active, is the
 * role this realm's) is checked by the command, over the rows this makes.
 */

export interface GrantRow {
  /** Where it came from, for a refusal: `row 3` of a file, or the account and tenant of a flag's pair. */
  readonly where: string;
  readonly account: string;
  /** The tenant's id, or null for the platform realm. */
  readonly tenant: string | null;
  readonly roles: readonly string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const COLUMNS = ['account', 'tenant', 'role'];

/** CSV as RFC 4180 reads it, enough for three plain columns: quoted cells, doubled quotes, CRLF, a BOM, blank lines skipped. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

const rolesOf = (text: string): string[] =>
  text
    .split(/[|,]/)
    .map((role) => role.trim())
    .filter(Boolean);

/** Rows from a CSV file: a header naming `account`, `tenant` and `role`, then one row each. An empty tenant is the platform realm; several roles are written `a|b`. */
export function rowsFromCsv(text: string): { rows: GrantRow[]; problems: string[] } {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], problems: ['the file is empty: it needs a header row account,tenant,role.'] };
  const header = table[0].map((name) => name.trim().toLowerCase());
  const missing = COLUMNS.filter((name) => !header.includes(name));
  if (missing.length) return { rows: [], problems: [`the header row has no ${missing.join(', ')} column: it is account,tenant,role.`] };
  const at = Object.fromEntries(COLUMNS.map((name) => [name, header.indexOf(name)]));
  const rows: GrantRow[] = [];
  const problems: string[] = [];
  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const account = (cells[at.account] ?? '').trim();
    const tenant = (cells[at.tenant] ?? '').trim();
    const roles = rolesOf(cells[at.role] ?? '');
    problems.push(...check(`row ${line}`, account, tenant || null, roles));
    rows.push({ where: `row ${line}`, account, tenant: tenant || null, roles });
  });
  if (!rows.length) problems.push('the file has a header and no rows.');
  return { rows, problems };
}

/** Rows from the flags: each account in each tenant (the platform realm when no tenant is named), with the same roles. */
export function rowsFromFlags(
  accounts: readonly string[],
  tenants: readonly string[],
  roles: readonly string[],
): { rows: GrantRow[]; problems: string[] } {
  const rows: GrantRow[] = [];
  const problems: string[] = [];
  for (const tenant of tenants.length ? tenants : [null])
    for (const account of accounts) {
      const where = `${account} in ${tenant ?? 'the platform realm'}`;
      problems.push(...check(where, account, tenant, roles));
      rows.push({ where, account, tenant, roles });
    }
  return { rows, problems };
}

function check(where: string, account: string, tenant: string | null, roles: readonly string[]): string[] {
  const problems: string[] = [];
  if (!EMAIL.test(account)) problems.push(`${where}: "${account}" is not an email address.`);
  if (tenant !== null && !TENANT_ID.test(tenant)) problems.push(`${where}: "${tenant}" is not a tenant id (a–z, 0–9, "_" and "-").`);
  if (!roles.length) problems.push(`${where}: no role.`);
  return problems;
}

/** The same account in the same realm twice collapses when the roles agree, and is a problem when they do not. */
export function collapse(rows: readonly GrantRow[]): { rows: GrantRow[]; problems: string[] } {
  const seen = new Map<string, GrantRow>();
  const problems: string[] = [];
  for (const row of rows) {
    const key = `${row.account.toLowerCase()}\u0000${row.tenant ?? ''}`;
    const first = seen.get(key);
    if (!first) seen.set(key, row);
    else if ([...first.roles].sort().join() !== [...row.roles].sort().join())
      problems.push(
        `${row.where}: ${row.account} is already given ${first.roles.join('|')} in ${row.tenant ?? 'the platform realm'} by ${first.where}.`,
      );
  }
  return { rows: [...seen.values()], problems };
}
