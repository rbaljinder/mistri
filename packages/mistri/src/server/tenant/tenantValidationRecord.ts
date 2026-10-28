/**
 * The validation record: how a production build's start knows it has already
 * checked this App against this database, so a restart does not do it again.
 *
 * A start checks a tenant App three ways (tenantStartup.ts): its declarations
 * against each other, the declarations against the database catalog, and the
 * stores and journals enrollment will open. A production build (`mistri build`)
 * has frozen the first, and the other two are a function of the build and the
 * catalog: the same build on the same catalog passes or fails the same way.
 * So the start that passes them on PostgreSQL writes down what it checked
 * (adapters/validation/postgresValidationRecord.ts), and the next start reads
 * that one row with the catalog digest before deciding how much to check:
 *
 * - the same build and the same catalog: the catalog checks are skipped;
 * - another build of the same declarations (its look, its client): the same;
 * - another build whose declarations moved, on the same catalog: the catalog
 *   is read once, not twice, and checked whole — a declaration reaches across
 *   tables (a reference, a related list, a command's footprint), so the record
 *   names the tables whose own declarations changed but the checks still read
 *   the App whole — and the stores are attested again before serving only
 *   when the set of stores the deployment needs has changed;
 * - another catalog, a new deployment, or a record that cannot be read: the
 *   full check, as every start made it before.
 *
 * What every start still does whatever the record says: the declaration
 * checks that read no catalog (they read the deployment's own connection and
 * environment, which no record holds), and enrollment's attestation of the
 * catalog and stores it serves from (tenantEnrollment.ts): the record decides
 * what is checked before serving, never what a source attests before reading.
 *
 * Only a production build reads it — a source App, `mistri dev` and `mistri
 * check` always check in full — and only on PostgreSQL. Nothing about it can
 * stop a start: a record that cannot be read is a full check, and one that
 * cannot be written is said once and the start goes on.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import type { LoadedApp } from '../app/apps.js';
import { BUILD_MANIFEST } from '../app/appBuild.js';
import type { StoredValidation } from '../../adapters/validation/postgresValidationRecord.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What a production start knows of its build before it reads the database. */
export interface BuildFingerprints {
  /** Every file of the build (its manifest's hashes), the mistri serving it, and the deployment's connection shape. */
  readonly build: string;
  /** Only what the catalog checks read: the build less its look, its locations and its client. */
  readonly declarations: string;
}

/** How much a start checks, and why: what it says, and what it writes once it serves. */
export interface ValidationPlan {
  readonly mode: 'full' | 'selective' | 'skip';
  /** One clause for the start's line: why this mode. */
  readonly reason: string;
  readonly fingerprints: BuildFingerprints;
  /** The App database's catalog digest and each platform-only source's, read before anything else the start reads. */
  readonly schema?: string;
  readonly stored?: StoredValidation;
  /** The store could not be read: nothing is written back. */
  readonly unreadable?: boolean;
}

/** A start whose record let it skip the catalog met a check that reads it: it starts again, checking in full. */
export class ValidationRecordFallback extends Error {
  constructor(readonly check: string) {
    super(`A startup check read the catalog in a start the validation record let skip it (${check}).`);
    this.name = 'ValidationRecordFallback';
  }
}

/* The parts of a loaded App that are where it was put, or how it looks, never what it grants or reads:
   its paths, and the look a running host takes in place (tenantLook.ts). Code is hashed as the build's files. */
const LOCATION_KEYS = new Set(['path', 'dir', 'build', 'entry', 'env', 'sources', 'pageFiles', 'messageFiles', 'modules', 'fonts']);
const CODE_KEYS = new Set(['commands', 'loaders', 'challenges']);

function declarationText(loaded: LoadedApp): string {
  const { theme: _theme, customThemes: _custom, ...ui } = loaded.app.ui;
  const kept = Object.fromEntries(
    Object.entries({ ...loaded, app: { ...loaded.app, ui } }).filter(([key]) => !LOCATION_KEYS.has(key) && !CODE_KEYS.has(key)),
  );
  // A function riding in a load is compared by its source, as tenantLook.ts compares it: any doubt is a check.
  return JSON.stringify(kept, (_key, value) => (typeof value === 'function' ? `fn:${String(value)}` : value));
}

/* What a check reads of the deployment's own configuration, and no secret: which connections there are and how each may be used. */
function connectionShape(connections: readonly ConnectionConfig[]): unknown {
  return connections.map((each) => ({
    name: each.name,
    id: each.id ?? null,
    writable: each.writable === true,
    rows: each.rows ?? null,
    schemas: each.schemas?.length ?? 0,
    replicas: each.replicas?.length ?? 0,
    listen: each.listen !== undefined,
  }));
}

/**
 * The fingerprints of a production build, or undefined when this start is not
 * one: an App served from source, `mistri dev` or `mistri check` (each checks in
 * full, whatever it serves), or a build started with a policy, commands or jobs
 * module that is not the build's own (then nothing the build hashed vouches for
 * the code the checks run).
 */
export async function buildFingerprints(
  loaded: LoadedApp,
  files: { readonly policy: string; readonly commands?: string; readonly jobs?: string },
  connections: readonly ConnectionConfig[],
  serving: { readonly dev?: boolean; readonly check?: boolean } = {},
): Promise<BuildFingerprints | undefined> {
  const build = loaded.build;
  if (!build || serving.dev || serving.check) return undefined;
  for (const kind of ['policy', 'commands', 'jobs'] as const) {
    const given = files[kind];
    const own = build.entries[kind];
    if ((given === undefined) !== (own === undefined)) return undefined;
    if (given !== undefined && resolve(given) !== resolve(own!)) return undefined;
  }
  let manifest: string;
  try {
    manifest = await readFile(join(build.dir, BUILD_MANIFEST), 'utf8');
  } catch {
    return undefined;
  }
  const hashes = (JSON.parse(manifest) as { sha256?: Record<string, string>; entries?: Record<string, string> }) ?? {};
  const code = Object.fromEntries(
    Object.entries(hashes.entries ?? {})
      .map(([kind, file]) => [kind, hashes.sha256?.[file] ?? null] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const shape = JSON.stringify(connectionShape(connections));
  const mistri = runtimeVersion();
  return Object.freeze({
    build: sha256(['mistri-validation/1', mistri, shape, manifest].join('\n')),
    declarations: sha256(['mistri-validation/1', mistri, shape, JSON.stringify(code), declarationText(loaded)].join('\n')),
  });
}

/** Each resource's own declaration, by its id: the per-table checked set a record keeps. */
function tableDeclarations(loaded: LoadedApp, ownership: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const resources = loaded.app.resources ?? {};
  const ids = [...new Set([...Object.keys(ownership), ...Object.keys(resources)])].sort();
  return Object.freeze(
    Object.fromEntries(
      ids.map((id) => [
        id,
        sha256(JSON.stringify({ resource: (resources as Record<string, unknown>)[id] ?? null, owner: ownership[id] ?? null })),
      ]),
    ),
  );
}

/** The resources whose own declaration differs from the record's, added or gone, in id order. */
export function changedTables(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((id) => before[id] !== after[id]).sort();
}

/**
 * Decide from the record and the live fingerprints. `read` is the one statement
 * on the App database (with the platform-only sources' digests beside it); its
 * failure is a full check that writes nothing back.
 */
export async function planValidation(
  fingerprints: BuildFingerprints,
  read: () => Promise<{ schema: string; stored?: StoredValidation }>,
): Promise<ValidationPlan> {
  let found: { schema: string; stored?: StoredValidation };
  try {
    found = await read();
  } catch (error) {
    return Object.freeze({ mode: 'full', reason: unreadableReason(error), fingerprints, unreadable: true });
  }
  const { schema, stored } = found;
  const at = { fingerprints, schema, ...(stored ? { stored } : {}) };
  if (!stored) return Object.freeze({ ...at, mode: 'full', reason: 'none yet for this App and database; checked in full' });
  if (stored.schema !== schema)
    return Object.freeze({ ...at, mode: 'full', reason: `the catalog changed since ${stored.checkedAt}; checked in full` });
  if (stored.build === fingerprints.build)
    return Object.freeze({
      ...at,
      mode: 'skip',
      reason: `this build and catalog were checked at ${stored.checkedAt}; the catalog checks were skipped`,
    });
  if (stored.declarations === fingerprints.declarations)
    return Object.freeze({
      ...at,
      mode: 'skip',
      reason: `this build's declarations and catalog were checked at ${stored.checkedAt} (only its look or client changed); the catalog checks were skipped`,
    });
  return Object.freeze({ ...at, mode: 'selective', reason: 'the build changed on the same catalog' });
}

/* A store that is not there says how to make it; anything else says it could not be read. Never a URL or a secret. */
function unreadableReason(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === '42P01' || code === '3F000')
    return 'not provisioned in this database (`mistri migrate stores up --app … --policy …` makes it); checked in full';
  return `could not be read (${typeof code === 'string' ? `PostgreSQL ${code}` : 'no answer'}); checked in full`;
}

/** What a start that read its record says, and what it keeps once it serves. */
export interface ValidationOutcome {
  readonly plan: ValidationPlan;
  /** The start's one line: the mode and why. */
  readonly say: string;
  /** Write what this start validated, where there is something new to keep; the caller logs a failure once and serves on. */
  commit(): Promise<void>;
}

export function validationOutcome(
  plan: ValidationPlan,
  done: {
    readonly loaded: LoadedApp;
    readonly ownership: Readonly<Record<string, unknown>>;
    readonly stores: readonly string[];
    /** The stores were attested before serving, not only by the host's own enrollment. */
    readonly attestedAgain: boolean;
    /** A read-only connection is never written through, a record included: such a start always checks in full. */
    readonly writable: boolean;
    readonly url: string;
    readonly key: { readonly app: string; readonly source: string };
  },
): ValidationOutcome {
  const tables = tableDeclarations(done.loaded, done.ownership);
  let say = plan.reason;
  if (plan.mode === 'selective') {
    const changed = changedTables(plan.stored!.tables, tables);
    const named = changed.length > 8 ? `${changed.slice(0, 8).join(', ')} and ${changed.length - 8} more` : changed.join(', ');
    say +=
      `: ${changed.length ? `${changed.length === 1 ? 'one resource is' : `${changed.length} resources are`} declared anew (${named})` : 'no resource is declared anew'}` +
      '; the catalog was read once and checked whole' +
      (done.attestedAgain ? ', and the stores attested again (the deployment needs another set)' : '');
  }
  // Nothing new to keep where this build was the one the record already names, or where the record could not be read.
  const keep = plan.schema !== undefined && !plan.unreadable && !(plan.mode === 'skip' && plan.stored?.build === plan.fingerprints.build);
  if (keep && !done.writable) say += '; not kept, since the connection is read only';
  return Object.freeze({
    plan,
    say,
    commit: async () => {
      if (!keep || !done.writable) return;
      const { writePostgresValidationRecord } = await import('../../adapters/validation/postgresValidationRecord.js');
      await writePostgresValidationRecord(done.url, done.key, {
        build: plan.fingerprints.build,
        declarations: plan.fingerprints.declarations,
        schema: plan.schema!,
        tables,
        stores: [...done.stores],
        mistri: runtimeVersion(),
      });
    },
  });
}
