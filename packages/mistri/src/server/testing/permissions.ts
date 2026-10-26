/**
 * The two assertions a generated suite stands on (`mistri test init`): a
 * journey's step ran, and each role may do what authority.lock grants it and
 * is refused the rest. Both read results as values (appRequests.ts), and the
 * matrix runs every row before it reports, as assertAuthorizationMatrix does.
 */
import assert from 'node:assert/strict';
import type { TestClient } from './client.js';
import type { TestRecordKey, TestRefusal, TestResult } from './appRequests.js';

/** Said whole: a refusal's status, code and words, which a bare `ok: false` hides. */
const told = (result: TestRefusal) => `${result.status}${result.code ? ` ${result.code}` : ''}: ${result.message}`;

/**
 * That a step ran. With the test's context, a step that found no record in the state it leaves from is skipped
 * and said, rather than failed: what the database holds is the fixture's, not the App's fault.
 */
export function assertApplied<T>(
  result: TestResult<T>,
  t?: { skip(message?: string): void },
): asserts result is Extract<TestResult<T>, { ok: true }> {
  if (result.ok) return;
  /* Nothing to run it on, or a question only the test can answer (act's `input`): a step skipped and said. */
  if ((result.code === 'no_record' || result.code === 'no_input') && t) {
    t.skip(result.message);
    return;
  }
  assert.fail(`Expected it to apply; it was refused (${told(result)})`);
}

/** One line of the matrix: a role (null: signed out), what it asks, and whether the lock grants it. */
export type PermissionCase = { role: string | null; allowed: boolean } & (
  | { read: string }
  | { write: string; /** The column written back with its own value; the record's first plain column otherwise. */ column?: string }
  | { command: string; /** The table it runs on; none for a command that creates its record. */ on?: string }
);

/** A key no seeded record has: what a refused case names when no one here can read a record of its table. */
const UNSEEN: TestRecordKey = { id: -1 };

/** How many of a table's records an allowed command is offered before its refusal is the answer. */
const SAMPLED = 10;

interface Sessions {
  as(role: string): Promise<TestClient>;
  client(): TestClient;
}

/**
 * How the server refuses a case. A table a role may not read is not in its catalog at all, so a query naming it is
 * answered as one naming a table that does not exist ("No table called …"): a refusal that does not say the table is
 * there. A refused write or command answers 403; signed out, 401 says to sign in first.
 */
function refusedAsServerRefuses(row: PermissionCase, result: TestRefusal): string | undefined {
  if (row.role === null && result.status === 401) return undefined;
  if ('read' in row)
    return result.status === 403 || result.message.startsWith(`No table called "${row.read}"`)
      ? undefined
      : `refused with ${told(result)}, not as a table it cannot see (No table called "${row.read}") or 403`;
  return result.status === 403 ? undefined : `refused with ${told(result)}, not 403`;
}

/**
 * Every role × resource and command as the lock says: an allowed read answers rows, an allowed write saves a
 * record's own value back over it, an allowed command prepares (which changes nothing). A refused read is answered
 * as a table that is not there; a refused write or command answers 403 (signed out, 401).
 * A write or command needs a record: the first any role can read; an allowed command refused by its record (not in
 * the state it runs from) tries the next few. Every row runs; the failures are reported together.
 */
export async function assertPermissions(host: Sessions, cases: readonly PermissionCase[]): Promise<void> {
  if (!cases.length) throw new Error('A permissions matrix needs at least one case.');
  const sessions = new Map<string | null, Promise<TestClient>>();
  const session = (role: string | null) => {
    let found = sessions.get(role);
    if (!found) sessions.set(role, (found = role === null ? Promise.resolve(host.client()) : host.as(role)));
    return found;
  };
  const roles = [...new Set(cases.map((row) => row.role))];
  type Sample = { key: TestRecordKey; row: Record<string, unknown> };
  const samples = new Map<string, Promise<Sample[]>>();
  /* The first records of the table, read by whichever role can: a refused write or command is refused before its
     record is looked at, so any record of the table names it. */
  const sampled = (table: string) => {
    let found = samples.get(table);
    if (!found)
      samples.set(
        table,
        (found = (async () => {
          for (const role of roles) {
            const client = await session(role);
            const read = await client.rows(table, { limit: SAMPLED });
            if (read.ok && read.value.length)
              return Promise.all(read.value.map(async (row) => ({ key: await client.key(table, row), row })));
          }
          return [];
        })()),
      );
    return found;
  };
  const sample = async (table: string): Promise<Sample | undefined> => (await sampled(table))[0];
  const failures: Error[] = [];
  for (const row of cases) {
    const asked = 'read' in row ? `read ${row.read}` : 'write' in row ? `write ${row.write}` : `run ${row.command}`;
    const name = `${row.role ?? 'signed out'} ${row.allowed ? 'may' : 'may not'} ${asked}`;
    try {
      const client = await session(row.role);
      let result: TestResult<unknown>;
      if ('read' in row) result = await client.rows(row.read, { limit: 1 });
      else if ('write' in row) {
        const record = await sample(row.write);
        if (!record && !row.allowed) {
          /* No record anyone here can read: a refusal is the grant's, said before any record is looked at, so a
             record that is not there asks it as well as one that is. */
          result = await client.update(row.write, UNSEEN, { [row.column ?? 'id']: null });
        } else {
          if (!record) throw new Error(`no ${row.write} record to write: seed one`);
          const { schema, machine } = await client.columns(row.write);
          /* A role refused the table is not shown its columns: any of the record's is asked, as the refusal comes first. */
          const column =
            row.column ??
            Object.keys(record.row).find(
              (candidate) => schema.includes(candidate) && !(candidate in record.key) && candidate !== machine,
            ) ??
            (row.allowed ? undefined : Object.keys(record.row).find((candidate) => !(candidate in record.key)));
          if (!column) throw new Error(`no column of ${row.write} to write back`);
          result = await client.update(row.write, record.key, { [column]: record.row[column] as string | number | boolean | null });
        }
      } else {
        const records = row.on ? await sampled(row.on) : [{ key: {} }];
        if (!records.length && row.allowed) throw new Error(`no ${row.on} record to run ${row.command} on: seed one`);
        result = await client.prepare(row.command, records[0]?.key ?? UNSEEN);
        /* Allowed is the grant's word; a record outside the state the command runs from refuses for itself (its
           `when`, or a default it cannot fill), so the next is tried, as a person would pick another. */
        for (const record of records.slice(1)) {
          if (!row.allowed || result.ok || result.status === 401 || result.status === 403) break;
          result = await client.prepare(row.command, record.key);
        }
      }
      if (row.allowed) assert.ok(result.ok, `refused (${result.ok ? '' : told(result)})`);
      else {
        assert.ok(!result.ok, 'allowed');
        const wrong = refusedAsServerRefuses(row, result);
        if (wrong) assert.fail(wrong);
      }
    } catch (cause) {
      failures.push(new Error(`${name}: ${(cause as Error).message}`, { cause }));
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `${failures.length} of ${cases.length} permission case(s) failed:\n  ${failures.map((error) => error.message).join('\n  ')}`,
    );
}
