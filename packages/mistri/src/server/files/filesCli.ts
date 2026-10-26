/**
 * `mistri migrate files status | up | sweep`: an App's files moved to
 * where each file resource's `storage` says — into its bucket, or back into
 * its `content` column — and the bucket's unnamed objects removed.
 *
 * `up` moves one row at a time, each a transaction of its own: into a bucket,
 * the object is stored first and the row then made to name it; back, the row
 * takes the bytes and the object is deleted after. A row is moved only while
 * it is still where it was read, so the server may keep serving and writing
 * throughout, and a run that stops — a crash, ^C, a bucket that went away —
 * is resumed by running it again: only what has not moved is looked at. An
 * object stored for a row that then did not take it is deleted; one left by
 * a crash is the sweep's.
 *
 * `sweep` lists the App's objects in each bucket and deletes those no row
 * names and no one has written in the last hour (an upload whose row is not
 * yet committed is younger). It is how a deleted record's object goes, by
 * whatever door the record went, and how a write that never committed is
 * cleaned up; run it from cron.
 *
 * The database is the App's, opened as `migrate` opens it, with the server's
 * bucket credentials (MISTRI_S3_*). A tenant App's keys are filed under
 * each row's tenant, which its policy's `ownership` names: `--policy`.
 */
import { createHash } from 'node:crypto';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { LoadedApp } from '../app/apps.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { appFileRules, isTenantApp, type AppDef, type AppFileRule } from '../../shared/app.js';
import { primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Condition } from '@mistriwork/engine/shared/filter.js';
import { appPrefix, bucketOf, newObjectKey, objectBelongs, resourcePrefix, type FileScope } from './fileStorage.js';
import { resolveTarget } from '@mistriwork/engine/server/migrate/target.js';
import { appBinding } from '../cli/appBinding.js';
import { imageHashOfHex, variantHash, variantsPrefix } from '../http/imageVariants.js';
import { sharedVariantsOf } from '../http/fileRows.js';

export const FILES_USAGE =
  'mistri migrate files <status | up | sweep> --app <dir> [<db> | --db <target> | --config <path>] [--connection <name>] [--policy <file>] [--dry-run]';

const EXIT = { ok: 0, couldNot: 1, failed: 3 } as const;
/** Rows read per page while moving: enough to keep a bucket busy, few enough that 25 MB files stay in hand. */
const PAGE = 16;
/** An object younger than this may belong to an upload whose row is still being written. */
const SWEEP_GRACE_MS = 60 * 60 * 1000;

interface FilesInput {
  readonly registry: Registry;
  readonly config: StartupConfig;
  readonly appDir?: string;
  readonly loaded?: LoadedApp;
  readonly connection?: string;
  readonly argument?: string;
  readonly schemas: readonly string[];
  readonly policy?: string;
  readonly dryRun: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Where each tenant-owned resource keeps its tenant, from the policy's `ownership`. */
export async function tenantColumns(policyFile: string): Promise<Map<string, string>> {
  const [{ loadAppPolicyModule }, { defineAppTenantPolicy }] = await Promise.all([
    import('../policy/appRowPolicy.js'),
    import('../policy/appTenantPolicy.js'),
  ]);
  const policy = await loadAppPolicyModule(policyFile, (value) =>
    defineAppTenantPolicy(value as Parameters<typeof defineAppTenantPolicy>[0]),
  );
  const columns = new Map<string, string>();
  for (const [resource, rule] of Object.entries(policy.ownership)) if (rule.kind === 'tenant') columns.set(resource, rule.column);
  return columns;
}

/** A file resource as this run sees it: its rule, table and key, and the scope of each row. */
interface Holding {
  readonly rule: AppFileRule;
  readonly table: TableMeta;
  readonly key: string[];
  /** The row's scope, or why it cannot be filed (a tenant App's row without a tenant). */
  scopeOf(row: Record<string, unknown>): FileScope | string;
  /** Columns read beside the key to know the row's scope. */
  readonly scopeColumns: string[];
}

export async function runFiles(sub: string, input: FilesInput, write: (line: string) => void): Promise<number> {
  const fail = (why: string, code: number = EXIT.couldNot) => {
    console.error(`mistri migrate files: ${why}`);
    return code;
  };
  if (sub !== 'status' && sub !== 'up' && sub !== 'sweep') return fail(`"${sub}" is not a files command. ${FILES_USAGE}`);
  if (input.dryRun && sub === 'status') return fail('--dry-run is for up and sweep; status changes nothing.');
  const app = input.loaded?.app;
  if (!app || input.appDir === undefined) return fail(`files reads an App's file resources: name it with --app <dir>. ${FILES_USAGE}`);
  const tenant = isTenantApp(app);
  if (input.policy !== undefined && !tenant) return fail('--policy is for a tenant App, whose files are filed by tenant.');
  let columns: Map<string, string> | undefined;
  if (tenant) {
    if (input.policy === undefined) return fail("a tenant App's files are filed under each row's tenant: name its --policy <file>.");
    try {
      columns = await tenantColumns(input.policy);
    } catch (error) {
      return fail((error as Error).message);
    }
  }
  let adapter: Adapter;
  let schema: DatabaseSchema;
  let label: string;
  try {
    const target = await resolveTarget(
      input.registry,
      input.config,
      { connection: input.connection, argument: input.argument, schemas: [...input.schemas] },
      input.appDir,
      input.loaded && appBinding(input.loaded.app),
    );
    label = target.connection.name;
    // Every adapter is loaded only for a run that opens one: the usage line is read by any `migrate`.
    const { connect } = await import('@mistriwork/engine/adapters/connect.js');
    adapter = connect(target.url, { schemas: [...target.schemas] });
    schema = await adapter.introspect();
  } catch (error) {
    return fail((error as Error).message);
  }
  try {
    const { rules, problems } = appFileRules(app, schema, { strict: true });
    if (problems.length) return fail(problems.join('\n'));
    const holdings: Holding[] = [];
    for (const rule of rules.values()) {
      const table = schema.tables.find((candidate) => candidate.id === rule.table)!;
      const owner = columns?.get(rule.resource);
      if (tenant && !owner) {
        write(`${rule.resource}: not owned by a tenant in the policy; its files stay where they are.`);
        continue;
      }
      holdings.push({
        rule,
        table,
        key: primaryKey(table) as string[],
        scopeColumns: owner ? [owner] : [],
        scopeOf: (row) => {
          if (!owner) return { app: app.id };
          const id = row[owner];
          return typeof id === 'string' && id ? { app: app.id, tenant: id } : `its ${owner} names no tenant`;
        },
      });
    }
    if (!holdings.length) {
      write(`${app.id} keeps no files${tenant ? ' its tenants own' : ''}.`);
      return EXIT.ok;
    }
    write(`Files of ${app.id} in ${label} (${schema.dialect})${input.dryRun ? ', dry run' : ''}`);
    if (sub === 'status') return await status(adapter, holdings, write);
    if (sub === 'up') return await up(adapter, holdings, input.dryRun, write);
    return await sweep(() => adapter, app.id, holdings, input.dryRun, write);
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    await adapter.close().catch(() => {});
  }
}

const inDatabase = (rule: AppFileRule): Condition[] => [
  { column: rule.content, op: 'isNotNull' },
  ...(rule.object ? [{ column: rule.object, op: 'isNull' as const }] : []),
];
const inBucket = (rule: AppFileRule): Condition[] => (rule.object ? [{ column: rule.object, op: 'isNotNull' }] : []);
const destination = (rule: AppFileRule) => (rule.storage === 'bucket' ? `the bucket ${rule.bucket!.name}` : 'the database');

async function status(adapter: Adapter, holdings: readonly Holding[], write: (line: string) => void): Promise<number> {
  let misplaced = 0;
  for (const { rule } of holdings) {
    const database = await adapter.count(rule.table, { groups: [inDatabase(rule)] });
    const bucket = rule.object ? await adapter.count(rule.table, { groups: [inBucket(rule)] }) : 0;
    const away = rule.storage === 'bucket' ? database : bucket;
    misplaced += away;
    write(
      `  ${rule.resource}: ${plural(database, 'file')} in the database, ${bucket} in ${rule.bucket ? `the bucket ${rule.bucket.name}` : 'no bucket'}; ` +
        `new files go to ${destination(rule)}${away ? `, ${away} to move` : ''}.`,
    );
  }
  write(misplaced ? `${plural(misplaced, 'file')} to move: mistri migrate files up.` : 'Every file is where its storage says.');
  return EXIT.ok;
}

async function up(adapter: Adapter, holdings: readonly Holding[], dryRun: boolean, write: (line: string) => void): Promise<number> {
  if (!adapter.transaction) throw new Error(`${adapter.constructor.name} cannot write in this build.`);
  let code: number = EXIT.ok;
  for (const holding of holdings) {
    const { rule, table, key } = holding;
    const toBucket = rule.storage === 'bucket';
    if (!toBucket && !rule.object) continue;
    const where = toBucket ? inDatabase(rule) : inBucket(rule);
    const bucket = toBucket || rule.bucket ? bucketOf(rule) : undefined;
    if (!bucket) {
      write(`  ${rule.resource}: rows name objects, and it names no bucket to read them from; they stay.`);
      continue;
    }
    let moved = 0;
    let skipped = 0;
    let bytes = 0;
    for (;;) {
      /* Moved rows leave the filter, so the next page starts after the ones that stayed (by key, they come first). */
      const page = await adapter.query({
        table: table.id,
        columns: [...key, ...holding.scopeColumns, ...(toBucket ? [rule.content] : [rule.object!])],
        filter: { groups: [where] },
        orderBy: key.map((column) => ({ column, direction: 'asc' as const })),
        limit: PAGE,
        offset: dryRun ? moved + skipped : skipped,
        binary: true,
      });
      if (!page.rows.length) break;
      for (const row of page.rows) {
        const id = Object.fromEntries(key.map((column) => [column, row[column] as string | number]));
        const said = JSON.stringify(Object.values(id));
        const scope = holding.scopeOf(row);
        if (typeof scope === 'string') {
          write(`  ${rule.resource} ${said}: ${scope}; left in the database.`);
          skipped++;
          continue;
        }
        if (dryRun) {
          const content = row[rule.content];
          if (content instanceof Uint8Array) bytes += content.byteLength;
          moved++;
          continue;
        }
        try {
          const done = toBucket
            ? await intoBucket(adapter, holding, id, row[rule.content] as Uint8Array, scope)
            : await outOfBucket(adapter, holding, id, String(row[rule.object!]));
          if (done) {
            moved++;
            bytes += done;
          } else skipped++;
        } catch (error) {
          write(`  ${rule.resource} ${said}: ${(error as Error).message}`);
          skipped++;
          code = EXIT.failed;
        }
      }
    }
    const size = bytes ? ` (${Math.ceil((bytes / 1024 / 1024) * 10) / 10} MB)` : '';
    write(
      `  ${rule.resource}: ${dryRun ? 'would move' : 'moved'} ${plural(moved, 'file')}${size} to ${destination(rule)}` +
        `${skipped ? `; ${skipped} left where ${skipped === 1 ? 'it is' : 'they are'}` : ''}.`,
    );
  }
  return code;
}

/** Whether a row still holds what it was read with: the object it named, or bytes and no object. */
async function stillThere(
  tx: Parameters<Parameters<NonNullable<Adapter['transaction']>>[0]>[0],
  holding: Holding,
  id: Record<string, string | number>,
): Promise<{ object: unknown; content: unknown } | undefined> {
  const { rule, table } = holding;
  await tx.lockRecord?.({ table: table.id, key: id });
  const read = await tx.query({
    table: table.id,
    columns: [rule.content, ...(rule.object ? [rule.object] : [])],
    filter: { groups: [Object.entries(id).map(([column, value]) => ({ column, op: '=' as const, value }))] },
    limit: 1,
    offset: 0,
    binary: true,
  });
  const row = read.rows[0];
  return row ? { object: rule.object ? row[rule.object] : null, content: row[rule.content] } : undefined;
}

/** Store a row's bytes as an object and make the row name it; the object goes again if the row has moved meanwhile. */
async function intoBucket(
  adapter: Adapter,
  holding: Holding,
  id: Record<string, string | number>,
  bytes: Uint8Array,
  scope: FileScope,
): Promise<number> {
  const { rule, table } = holding;
  const bucket = bucketOf(rule);
  const object = newObjectKey({ ...rule, bucket: rule.bucket! }, scope);
  await bucket.put(object, bytes);
  let taken = false;
  try {
    taken = await adapter.transaction!(async (tx) => {
      const now = await stillThere(tx, holding, id);
      if (!now || now.object !== null || !(now.content instanceof Uint8Array)) return false;
      await tx.update({
        table: table.id,
        key: id,
        values: {
          [rule.content]: null,
          [rule.object!]: object,
          ...(rule.hash ? { [rule.hash]: createHash('sha256').update(now.content).digest('hex') } : {}),
        },
      });
      return true;
    });
  } finally {
    if (!taken) await bucket.delete(object).catch(() => {});
  }
  return taken ? bytes.byteLength : 0;
}

/** Bring an object's bytes into its row, then delete the object; a row that moved meanwhile keeps what it has. */
async function outOfBucket(adapter: Adapter, holding: Holding, id: Record<string, string | number>, object: string): Promise<number> {
  const { rule, table } = holding;
  const bucket = bucketOf(rule);
  const bytes = await bucket.bytes(object);
  if (!bytes) throw new Error(`names the object ${object}, which the bucket does not hold; left as it is.`);
  const taken = await adapter.transaction!(async (tx) => {
    const now = await stillThere(tx, holding, id);
    if (!now || now.object !== object) return false;
    await tx.update({
      table: table.id,
      key: id,
      // Bytes bind as BLOB or bytea on every adapter, as an upload's do.
      values: { [rule.content]: bytes as unknown as string, [rule.object!]: null },
    });
    return true;
  });
  if (taken) await bucket.delete(object);
  return taken ? bytes.byteLength : 0;
}

/**
 * The pre-made copies of public pictures (http/imageVariants.ts) live in the bucket under
 * `<prefix>_variants/<app>/<hash>-<width>.<format>` and `<hash>.json`, named by the picture's hash, so a deleted
 * or replaced file leaves them behind. They go the way an unnamed object does: when no row's hash names them and
 * they are older than the grace. A hash the sweep cannot read from every row (no hash column, or a row that
 * predates it) means it cannot tell which copies are live, so it deletes none and says so.
 */
async function sweepVariants(
  readerFor: (table: string) => Pick<Adapter, 'query'>,
  appId: string,
  sharing: readonly Pick<Holding, 'rule' | 'table' | 'key'>[],
  before: number,
  dryRun: boolean,
  write: (line: string) => void,
): Promise<number> {
  const publics = sharing.filter(({ rule }) => rule.public && rule.bucket);
  if (!publics.length) return EXIT.ok;
  const shared = sharedVariantsOf({ ...publics[0].rule, app: publics[0].rule.app ?? appId });
  if (!shared) return EXIT.ok;
  const listed: { key: string; lastModified: Date }[] = [];
  let next: string | undefined;
  const prefix = variantsPrefix(shared);
  do {
    const page = await shared.bucket.list(prefix, next);
    listed.push(...page.objects);
    next = page.next;
  } while (next);
  if (!listed.length) return EXIT.ok;
  const live = new Set<string>();
  for (const { rule, table, key } of publics) {
    if (!rule.hash) {
      write(`  ${prefix}: ${table.id} keeps no hash column, so its pre-made copies are left as they are.`);
      return EXIT.ok;
    }
    for (let offset = 0; ; offset += 1000) {
      const page = await readerFor(table.id).query({
        table: table.id,
        columns: [rule.hash],
        orderBy: key.map((column) => ({ column, direction: 'asc' as const })),
        limit: 1000,
        offset,
      });
      for (const row of page.rows) {
        const hash = imageHashOfHex(row[rule.hash]);
        if (!hash) {
          write(`  ${prefix}: a row of ${table.id} has no hash yet, so its pre-made copies are left as they are.`);
          return EXIT.ok;
        }
        live.add(hash);
      }
      if (page.rows.length < 1000) break;
    }
  }
  let removed = 0;
  let code: number = EXIT.ok;
  for (const object of listed) {
    const hash = variantHash(object.key);
    if (!hash || live.has(hash) || object.lastModified.getTime() > before) continue;
    if (dryRun) {
      write(`  would delete ${object.key}`);
      removed++;
      continue;
    }
    try {
      await shared.bucket.delete(object.key);
      removed++;
    } catch (error) {
      write(`  ${object.key}: ${(error as Error).message}`);
      code = EXIT.failed;
    }
  }
  write(
    `  ${prefix}: ${listed.length} pre-made ${listed.length === 1 ? 'copy' : 'copies'}; ${dryRun ? 'would delete' : 'deleted'} ${removed}.`,
  );
  return code;
}

/**
 * Delete the objects under the App's prefix that no row names and no one
 * wrote in the last hour, in each bucket its file resources name.
 */
async function sweep(
  readerFor: (table: string) => Pick<Adapter, 'query'>,
  appId: string,
  holdings: readonly Pick<Holding, 'rule' | 'table' | 'key'>[],
  dryRun: boolean,
  write: (line: string) => void,
  /* One tenant's sweep: each resource's own prefix under that tenant is
     listed, and only that tenant's rows (its `owners` column) are read. An
     object of another tenant is never listed, so never deleted. */
  tenant?: Readonly<{ id: string; owners: ReadonlyMap<string, string> }>,
): Promise<number> {
  /* One pass per distinct place: resources sharing a bucket and prefix share
     its keys, so every row of every one of them is a reference. */
  const places = new Map<string, Pick<Holding, 'rule' | 'table' | 'key'>[]>();
  for (const holding of holdings) {
    const { bucket } = holding.rule;
    if (!bucket || !holding.rule.object) continue;
    if (tenant && !tenant.owners.has(holding.rule.resource)) continue;
    const prefix = tenant ? resourcePrefix({ ...holding.rule, bucket }, { app: appId, tenant: tenant.id }) : appPrefix(bucket, appId);
    const id = JSON.stringify([bucket.endpoint ?? '', bucket.name, prefix]);
    places.set(id, [...(places.get(id) ?? []), holding]);
  }
  if (!places.size) {
    write('  no file resource names a bucket: nothing to sweep.');
    return EXIT.ok;
  }
  let code: number = EXIT.ok;
  const before = Date.now() - SWEEP_GRACE_MS;
  for (const sharing of places.values()) {
    const first = sharing[0].rule;
    const bucket = bucketOf(first);
    const prefix = tenant
      ? resourcePrefix({ ...first, bucket: first.bucket! }, { app: appId, tenant: tenant.id })
      : appPrefix(first.bucket!, appId);
    /* Listed first, read second: an object written after the list is not in
       it, and one whose row commits after the read is younger than the grace. */
    const listed: { key: string; lastModified: Date }[] = [];
    let next: string | undefined;
    do {
      const page = await bucket.list(prefix, next);
      listed.push(...page.objects);
      next = page.next;
    } while (next);
    const named = new Set<string>();
    for (const { rule, table, key } of sharing) {
      for (let offset = 0; ; offset += 1000) {
        const page = await readerFor(table.id).query({
          table: table.id,
          columns: [rule.object!],
          filter: {
            groups: [
              [...inBucket(rule), ...(tenant ? [{ column: tenant.owners.get(rule.resource)!, op: '=' as const, value: tenant.id }] : [])],
            ],
          },
          orderBy: key.map((column) => ({ column, direction: 'asc' as const })),
          limit: 1000,
          offset,
        });
        for (const row of page.rows) named.add(String(row[rule.object!]));
        if (page.rows.length < 1000) break;
      }
    }
    let removed = 0;
    let young = 0;
    for (const object of listed) {
      if (named.has(object.key)) continue;
      // Listed under the tenant's prefix already; a key that is not its file's shape is left alone all the same.
      if (tenant && !objectBelongs(first, { app: appId, tenant: tenant.id }, object.key)) continue;
      if (object.lastModified.getTime() > before) {
        young++;
        continue;
      }
      if (dryRun) {
        write(`  would delete ${object.key}`);
        removed++;
        continue;
      }
      try {
        await bucket.delete(object.key);
        removed++;
      } catch (error) {
        write(`  ${object.key}: ${(error as Error).message}`);
        code = EXIT.failed;
      }
    }
    write(
      `  ${first.bucket!.name}/${prefix}: ${plural(listed.length, 'object')}, ${named.size} named by a row; ` +
        `${dryRun ? 'would delete' : 'deleted'} ${removed}${young ? `, kept ${young} written in the last hour` : ''}.`,
    );
    // Tenant files are never public, so only an App's own place has copies to sweep.
    if (!tenant) code = Math.max(code, await sweepVariants(readerFor, appId, sharing, before, dryRun, write));
  }
  return code;
}

/** The built-in job that sweeps an App's buckets (jobs/jobHost.ts `builtIn`): its id, in no App's namespace. */
export const FILES_SWEEP_JOB = 'mistri-files-sweep';

/**
 * When an App's sweep runs: once a day, at a minute of the day its id picks,
 * so Apps sharing a bucket or a database do not all sweep at midnight.
 */
export function filesSweepEvery(appId: string): string {
  const minute = createHash('sha256').update(appId).digest().readUInt16BE(0) % (24 * 60);
  return `${minute % 60} ${Math.floor(minute / 60)} * * *`;
}

/**
 * The sweep of an App without tenants over the server's own catalog, as the
 * jobs host runs it daily: `readerFor` is the App's reader for a table's
 * source. A tenant App's are swept one tenant at a time (sweepTenantFiles).
 */
export async function sweepAppFiles(
  app: AppDef,
  schema: DatabaseSchema,
  readerFor: (table: string) => Pick<Adapter, 'query'>,
  write: (line: string) => void,
): Promise<number> {
  if (isTenantApp(app)) return EXIT.ok;
  const holdings = [...appFileRules(app, schema).rules.values()].flatMap((rule) => {
    const table = schema.tables.find((candidate) => candidate.id === rule.table);
    return table ? [{ rule, table, key: primaryKey(table) as string[] }] : [];
  });
  return sweep(readerFor, app.id, holdings, false, write);
}

/**
 * One tenant's sweep, as a tenant App's job host runs it daily for each
 * active tenant: each file resource its tenants own is listed under that
 * tenant's prefix alone and checked against that tenant's rows alone
 * (`owners`: each resource's tenant column), so one tenant's run can delete
 * nothing of another's — a row it cannot see only ever keeps an object.
 */
export async function sweepTenantFiles(
  app: AppDef,
  schema: DatabaseSchema,
  reader: Pick<Adapter, 'query'>,
  owners: ReadonlyMap<string, string>,
  tenantId: string,
  write: (line: string) => void,
): Promise<number> {
  if (!isTenantApp(app) || !tenantId) return EXIT.couldNot;
  const holdings = [...appFileRules(app, schema).rules.values()].flatMap((rule) => {
    const table = schema.tables.find((candidate) => candidate.id === rule.table);
    return table && owners.has(rule.resource) ? [{ rule, table, key: primaryKey(table) as string[] }] : [];
  });
  return sweep(() => reader, app.id, holdings, false, write, { id: tenantId, owners });
}
