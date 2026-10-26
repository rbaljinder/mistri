/** Explicit control deployment configuration; never infer a database or powers
 * from App connections, administrator roles, or ambient PostgreSQL variables. */
import { flagStoreIdentifier, flagStoreRecord } from '../flags/store.js';

export interface SuiteFlagConfiguration {
  readonly store: string;
  readonly environment: string;
  readonly deploymentId: string;
}
export interface SuiteExperimentSource {
  readonly appId: string;
  readonly flagId: string;
  readonly tenantId: string | null;
  readonly controlTenantId?: string | null;
  readonly sourceId: string;
  readonly storeId: string;
  readonly commandIds: readonly string[];
  readonly maxClockSkewMs: number;
}
export interface SuiteExperimentConfiguration {
  readonly store: string;
  readonly deploymentId: string;
  /** Private startup-only canonical base64url key. Non-enumerable so ordinary
   * configuration serialization/spreads do not copy key material. The receipt
   * provider captures Buffer.from(assignmentKey, 'base64url') once at startup. */
  readonly assignmentKey?: string;
  readonly sources?: readonly SuiteExperimentSource[];
}
interface SuiteAssignmentKeyCapture {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  /** Actual captured suite/App identity and all retained placement key values,
   * not their environment aliases. Other dedicated keys can be included too. */
  readonly forbiddenSecrets: readonly string[];
}

function assignmentKey(name: unknown, captured: SuiteAssignmentKeyCapture | undefined): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === 'BETTER_AUTH_SECRET' || !captured) throw new Error();
  const secret = captured.environment[name];
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error();
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) throw new Error();
  for (const other of [...captured.forbiddenSecrets, captured.environment.BETTER_AUTH_SECRET]) {
    if (other === undefined) continue;
    // Native auth secrets may be literal UTF-8; placement keys are base64url.
    // Compare actual material as well as identical text under different aliases.
    const decoded = Buffer.from(other, 'base64url');
    if (
      other === secret ||
      Buffer.from(other, 'utf8').equals(bytes) ||
      ((decoded.toString('base64url') === other || decoded.toString('base64') === other) && decoded.equals(bytes))
    )
      throw new Error();
  }
  return secret;
}

export function suiteControlConfiguration(
  input: { flags?: unknown; console?: unknown; experiments?: unknown },
  hasIdentity: boolean,
  keys?: SuiteAssignmentKeyCapture,
): {
  flags?: SuiteFlagConfiguration;
  console?: { readonly enabled: boolean };
  experiments?: SuiteExperimentConfiguration;
} {
  try {
    let flags: SuiteFlagConfiguration | undefined, console: { readonly enabled: boolean } | undefined;
    let experiments: SuiteExperimentConfiguration | undefined;
    if (input.flags !== undefined) {
      if (!hasIdentity) throw new Error();
      const value = flagStoreRecord(input.flags, ['store', 'environment', 'deploymentId']);
      if (typeof value.store !== 'string' || value.store !== value.store.trim() || value.store.length > 8192) throw new Error();
      const url = new URL(value.store);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash || !url.pathname || url.pathname === '/')
        throw new Error();
      const environment = flagStoreIdentifier(value.environment),
        deploymentId = flagStoreIdentifier(value.deploymentId);
      flags = Object.freeze({ store: value.store, environment, deploymentId });
    }
    if (input.console !== undefined) {
      const value = flagStoreRecord(input.console, ['enabled']);
      if (typeof value.enabled !== 'boolean' || (value.enabled && (!hasIdentity || !flags))) throw new Error();
      console = Object.freeze({ enabled: value.enabled });
    }
    if (input.experiments !== undefined) {
      if (!flags) throw new Error();
      const value = flagStoreRecord(input.experiments, ['store', 'deploymentId', 'assignmentKeyEnv', 'sources']);
      if (typeof value.store !== 'string' || value.store !== value.store.trim() || value.store.length > 8192) throw new Error();
      const url = new URL(value.store),
        flagUrl = new URL(flags.store);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname ||
        url.hash ||
        url.pathname.length < 2 ||
        (url.hostname === flagUrl.hostname && (url.port || '5432') === (flagUrl.port || '5432') && url.pathname === flagUrl.pathname)
      )
        throw new Error();
      const sources =
        value.sources === undefined
          ? undefined
          : (() => {
              if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 256) throw new Error();
              const entries = value.sources.map((input) => {
                const entry = flagStoreRecord(input, [
                  'appId',
                  'flagId',
                  'tenantId',
                  'controlTenantId',
                  'sourceId',
                  'storeId',
                  'commandIds',
                  'maxClockSkewMs',
                ]);
                if (
                  !Array.isArray(entry.commandIds) ||
                  !entry.commandIds.length ||
                  entry.commandIds.length > 64 ||
                  !Number.isSafeInteger(entry.maxClockSkewMs) ||
                  (entry.maxClockSkewMs as number) < 0 ||
                  (entry.maxClockSkewMs as number) > 120_000
                )
                  throw new Error();
                const commandIds = entry.commandIds.map(flagStoreIdentifier);
                const controlTenantId = entry.controlTenantId === undefined ? entry.tenantId : entry.controlTenantId;
                if (controlTenantId !== null && controlTenantId !== entry.tenantId) throw new Error();
                if (new Set(commandIds).size !== commandIds.length) throw new Error();
                return Object.freeze({
                  appId: flagStoreIdentifier(entry.appId),
                  flagId: flagStoreIdentifier(entry.flagId),
                  tenantId: entry.tenantId === null ? null : flagStoreIdentifier(entry.tenantId),
                  ...(entry.controlTenantId === undefined
                    ? {}
                    : { controlTenantId: controlTenantId === null ? null : flagStoreIdentifier(controlTenantId) }),
                  sourceId: flagStoreIdentifier(entry.sourceId),
                  storeId: (() => {
                    if (typeof entry.storeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(entry.storeId)) throw new Error();
                    return entry.storeId;
                  })(),
                  commandIds: Object.freeze(commandIds),
                  maxClockSkewMs: entry.maxClockSkewMs as number,
                });
              });
              if (new Set(entries.map((entry) => JSON.stringify([entry.appId, entry.flagId, entry.tenantId]))).size !== entries.length)
                throw new Error();
              return Object.freeze(entries);
            })();
      const configured: SuiteExperimentConfiguration = {
        store: value.store,
        deploymentId: flagStoreIdentifier(value.deploymentId),
        ...(sources ? { sources } : {}),
      };
      if (Object.hasOwn(value, 'assignmentKeyEnv'))
        Object.defineProperty(configured, 'assignmentKey', {
          value: assignmentKey(value.assignmentKeyEnv, keys),
          enumerable: false,
          writable: false,
          configurable: false,
        });
      experiments = Object.freeze(configured);
    }
    return { ...(flags ? { flags } : {}), ...(console ? { console } : {}), ...(experiments ? { experiments } : {}) };
  } catch {
    throw new Error(
      'Suite controls require explicit valid configuration: shared identity, PostgreSQL store, environment and deploymentId; enabled Console also requires flags. Assignment receipts require an explicit dedicated canonical 32-byte assignmentKeyEnv key.',
    );
  }
}
