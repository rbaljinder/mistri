import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isProxy } from 'node:util/types';
import { captureRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { recordRefusalCause, refusalCause } from '@mistriwork/engine/server/evidence.js';
import { moduleFailure } from '../moduleFailure.js';
import type { PolicyPrincipal } from './appPolicyContext.js';
import { MAX_COMMAND_IDS } from '../commands/commandLimits.js';
import type { ScopedCommandOptions } from '../commands/scopedBusinessCommandAccess.js';
import type { PolicyReadContext } from './policyDb.js';

/** Detached complete logical image; provenance belongs to the private history owner. */
export type DeletedPolicyRecord = {
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly row: Readonly<Record<string, string | number | null>>;
};

/** A captured operator destination. The policy must independently admit its rows. */
export interface PublicPlacementIntent {
  readonly appId: string;
  readonly tenant: string;
}

/** Positive, exact-row eligibility, rechecked under the intake writer's locks. */
export interface PublicEligibilityAnchor {
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly expected: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PublicFormAdmission {
  readonly rows: RowScope;
  readonly anchors: readonly PublicEligibilityAnchor[];
}

export interface FixedPublicForm {
  readonly rows: RowScope;
  readonly resultReferences: ScopedCommandOptions['resultReferences'][string];
}

export interface PlacedPublicForm<Rows = unknown> {
  readonly kind: 'placement';
  readonly source: string;
  resolvePlacement(intent: PublicPlacementIntent, context: PolicyReadContext<Rows>): PublicFormAdmission | Promise<PublicFormAdmission>;
  readonly resultReferences: ScopedCommandOptions['resultReferences'][string];
}

/** Private server declaration; loading it does not install HTTP policy enforcement.
 * `Rows` is the App's generated row types (mistri-schema.d.ts), which type
 * the `db` the policy reads through. */
export interface AppRowPolicy<Rows = unknown> {
  readonly appId: string;
  /** The principal's rows. `db` reads every declared resource, read-only,
   * through the App's own pooled and traced connections. A method, so a
   * policy typed by its App's rows is still a row policy. */
  resolveRows(principal: PolicyPrincipal, context: PolicyReadContext<Rows>): RowScope | Promise<RowScope>;
  /** Optional public narrowing; an absent intent must never imply a default tenant. */
  resolvePublicRows?(intent: PublicPlacementIntent | null, context: PolicyReadContext<Rows>): RowScope | Promise<RowScope>;
  readonly resultReferences?: ScopedCommandOptions['resultReferences'];
  /** Explicit insert-only public intake, independent of public read grants and
   * session roles. Placed forms additionally require resolvePublicRows. */
  readonly publicForms?: Readonly<Record<string, FixedPublicForm | PlacedPublicForm<Rows>>>;
  /** Synchronous exact boolean; historical authorization does not grant a restore. */
  readonly authorizeDeletedRecord?: (principal: PolicyPrincipal, record: DeletedPolicyRecord) => boolean;
  /** The jobs module's principals this policy admits, by name: each attempt of a
   * job, timer, workflow, inbound endpoint or integration webhook that runs as one
   * asks resolveRows for `{ id: 'service:<name>', kind: 'service' }` and runs its
   * command in those rows. A principal not named here runs nothing. */
  readonly services?: readonly string[];
}

export class AppRowPolicyDefinitionError extends Error {
  readonly code: string = 'invalid-app-row-policy-definition';
  constructor(message = 'The App row policy definition could not be loaded or is invalid.') {
    super(message);
    this.name = 'AppRowPolicyDefinitionError';
  }
}

/**
 * A row-policy App that did not start for a reason that is not its policy
 * module's: the App's own definition against the database (a field no table
 * has), its sources and the server's connections. Said as such, because
 * "the row policy definition could not be loaded or is invalid" sent its
 * author to a policy module that was fine (field report S1). Still a
 * definition error to every caller that asks; the cause is recorded beneath.
 */
export class AppUnderPolicyStartupError extends AppRowPolicyDefinitionError {
  override readonly code: string = 'app-under-row-policy-invalid';
  constructor() {
    super('The App could not start under its row policy: the App or its connections refused, not the policy module.');
    this.name = 'AppUnderPolicyStartupError';
  }
}

/** A startup failure as its own part of the App says it: the policy module's refusal as it is, anything else the App's. */
export const policyStartupFailure = (error: unknown): AppRowPolicyDefinitionError =>
  error instanceof AppRowPolicyDefinitionError ? error : recordRefusalCause(new AppUnderPolicyStartupError(), error);

const fields = new Set([
  'appId',
  'resolveRows',
  'resolvePublicRows',
  'resultReferences',
  'authorizeDeletedRecord',
  'publicForms',
  'services',
]);
/* A jobs module's principal name (jobModule.ts PRINCIPAL), so a service named here is one a module can declare. */
const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
// Same command spelling as businessCommands; declarations additionally bound IDs.
const commandIdentifier = /^[A-Za-z][A-Za-z0-9_-]*$/;
/* The reason, when there is one, is recorded for the operator (evidence.ts)
   and never becomes the message: startup says one sentence to everyone. */
const invalid = (reason?: unknown): never => {
  throw recordRefusalCause(new AppRowPolicyDefinitionError(), reason);
};

function ownData(value: unknown, maximum: number, what = 'The row policy'): Map<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return invalid(`${what} is a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid(`${what} is a plain object literal, not a class instance.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) return invalid(`${what} has ${keys.length} fields; it has at most ${maximum}.`);
  const result = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== 'string' || reserved.has(key)) return invalid(`${what} cannot name "${String(key).slice(0, 64)}".`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      return invalid(`${what}'s "${key.slice(0, 64)}" is a getter or hidden; it is a plain value.`);
    result.set(key, descriptor.value);
  }
  return result;
}

/** Capture trusted functions without executing them. Scope validation belongs to
 * the verified issuer, after it resolves a principal for each invocation. */
export function defineAppRowPolicy<Rows = unknown>(input: AppRowPolicy<Rows>): AppRowPolicy<Rows> {
  try {
    const value = ownData(input, fields.size);
    for (const key of value.keys()) {
      if (!fields.has(key)) return invalid(`The row policy names "${key}", which is not one of ${[...fields].join(', ')}.`);
    }
    const appId = value.get('appId');
    const resolveRows = value.get('resolveRows');
    // App IDs are authored nonempty strings, not necessarily command identifiers.
    if (typeof appId !== 'string' || !appId.length || appId.length > 256 || appId !== appId.trim() || /\p{Cc}/u.test(appId))
      return invalid("The row policy's appId must be the App's id.");
    if (typeof resolveRows !== 'function') return invalid('The row policy has no resolveRows function.');
    const resolvePublicRows = value.get('resolvePublicRows');
    if (value.has('resolvePublicRows') && typeof resolvePublicRows !== 'function')
      return invalid("The row policy's resolvePublicRows must be a function.");
    const authorizeDeletedRecord = value.get('authorizeDeletedRecord');
    if (value.has('authorizeDeletedRecord') && typeof authorizeDeletedRecord !== 'function')
      return invalid("The row policy's authorizeDeletedRecord must be a function.");
    let resultReferences: ScopedCommandOptions['resultReferences'] | undefined;
    if (value.has('resultReferences')) {
      const entries = ownData(value.get('resultReferences'), MAX_COMMAND_IDS, "The row policy's resultReferences");
      const snapshot: Record<string, ScopedCommandOptions['resultReferences'][string]> = Object.create(null);
      for (const [id, extractor] of entries) {
        if (id.length > 256 || !commandIdentifier.test(id) || typeof extractor !== 'function') {
          return invalid(`The row policy's resultReferences["${id.slice(0, 64)}"] must be a function under a command's id.`);
        }
        snapshot[id] = extractor as ScopedCommandOptions['resultReferences'][string];
      }
      resultReferences = Object.freeze(snapshot);
    }
    let publicForms: AppRowPolicy<Rows>['publicForms'];
    if (value.has('publicForms')) {
      const forms: Record<string, FixedPublicForm | PlacedPublicForm<Rows>> = Object.create(null);
      for (const [key, definition] of ownData(value.get('publicForms'), 64, "The row policy's publicForms")) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key))
          return invalid(`The row policy's publicForms key "${key.slice(0, 64)}" is not a form id.`);
        const entry = ownData(definition, 4, `The row policy's publicForms["${key.slice(0, 64)}"]`);
        const extractor = entry.get('resultReferences');
        if (entry.get('kind') === 'placement') {
          const source = entry.get('source'),
            resolver = entry.get('resolvePlacement');
          if (
            entry.size !== 4 ||
            typeof source !== 'string' ||
            !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(source) ||
            typeof resolver !== 'function' ||
            isProxy(resolver) ||
            typeof extractor !== 'function' ||
            isProxy(extractor) ||
            typeof resolvePublicRows !== 'function' ||
            isProxy(resolvePublicRows)
          ) {
            return invalid(
              `The row policy's placed publicForms["${key}"] requires source, resolvePlacement, resultReferences and resolvePublicRows.`,
            );
          }
          forms[key] = Object.freeze({
            kind: 'placement',
            source,
            resolvePlacement: resolver as PlacedPublicForm<Rows>['resolvePlacement'],
            resultReferences: extractor as PlacedPublicForm<Rows>['resultReferences'],
          });
          continue;
        }
        if (entry.size !== 2 || !entry.has('rows') || typeof extractor !== 'function') {
          return invalid(`The row policy's publicForms["${key}"] must be { rows, resultReferences } and nothing else.`);
        }
        forms[key] = Object.freeze({
          rows: captureRowScope(entry.get('rows') as RowScope),
          resultReferences: extractor as ScopedCommandOptions['resultReferences'][string],
        });
      }
      publicForms = Object.freeze(forms);
    }
    let services: readonly string[] | undefined;
    if (value.has('services')) {
      const listed: unknown = value.get('services');
      if (!Array.isArray(listed) || isProxy(listed) || Object.getPrototypeOf(listed) !== Array.prototype)
        return invalid("The row policy's services is a list of the jobs module's principal names.");
      if (listed.length > 64) return invalid(`The row policy's services names ${listed.length} principals; it names at most 64.`);
      const seen = new Set<string>();
      for (let index = 0; index < listed.length; index++) {
        const name: unknown = listed[index];
        if (typeof name !== 'string' || !SERVICE.test(name))
          return invalid(`The row policy's services[${index}] is not a principal name: lowercase letters, digits and hyphens.`);
        if (seen.has(name)) return invalid(`The row policy's services names "${name}" twice.`);
        seen.add(name);
      }
      services = Object.freeze([...seen]);
    }
    return Object.freeze({
      appId,
      resolveRows: resolveRows as AppRowPolicy<Rows>['resolveRows'],
      ...(resolvePublicRows === undefined ? {} : { resolvePublicRows: resolvePublicRows as AppRowPolicy<Rows>['resolvePublicRows'] }),
      ...(publicForms === undefined ? {} : { publicForms }),
      ...(authorizeDeletedRecord === undefined
        ? {}
        : { authorizeDeletedRecord: authorizeDeletedRecord as AppRowPolicy<Rows>['authorizeDeletedRecord'] }),
      ...(resultReferences === undefined ? {} : { resultReferences }),
      ...(services === undefined ? {} : { services }),
    });
  } catch (error) {
    // Even malformed trusted definitions must not expose private error details
    // to a caller; the operator reads the reason recorded under it.
    return invalid(error);
  }
}

/** Explicit local deployment module, evaluated through Node's ordinary cache. */
export async function loadAppRowPolicy(file: string): Promise<AppRowPolicy> {
  try {
    return await loadAppPolicyModule(file, (value) => defineAppRowPolicy(value as AppRowPolicy));
  } catch (error) {
    // Import failures can contain filenames, environment values or policy data.
    return invalid(error);
  }
}

/** Shared local import seam. Capture the selected kind before returning across
 * an await; a raw module default must never be assimilated as a thenable. */
export async function loadAppPolicyModule<T>(file: string, capture: (value: unknown) => T): Promise<T> {
  try {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0') || !['.ts', '.mjs', '.js'].includes(extname(file)))
      return invalid('A policy module is a .ts, .mjs or .js file.');
    let module: { default?: unknown };
    try {
      module = await import(pathToFileURL(resolve(file)).href);
    } catch (error) {
      /* Said with its own error and where it happened: "run it on its own"
         sent the author off to learn what the loader already knew — a
         package missing beside the module, a line that threw. The reason is
         recorded for the operator's console alone (evidence.ts), and a
         credential in a URL is masked on the way. */
      /* A definition that threw while the module ran (defineAppTenantPolicy) recorded why: keep it beneath, or its
         fixed sentence ("could not be loaded or is invalid") is all the operator reads. */
      return invalid(
        recordRefusalCause(
          new Error(`The policy module "${basename(file)}" did not load: ${moduleFailure(resolve(file), error)}`),
          refusalCause(error),
        ),
      );
    }
    if (module.default === undefined) return invalid(`The policy module "${basename(file)}" has no default export.`);
    return capture(module.default);
  } catch (error) {
    return invalid(error);
  }
}
