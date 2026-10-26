/** Operator-owned placement keys and stable source identities. Serving reads
 * dedicated persisted keys; it never generates a secret or discovers a source. */
import { createPublicPlacementBindingIssuer } from '../forms/publicPlacementBinding.js';
import { flagStoreIdentifier, flagStoreRecord } from '../flags/store.js';
import { normalizeSuitePublicOrigin } from '../http/tenantHosts.js';

export interface SuitePlacementConfiguration {
  readonly issuer: Parameters<typeof createPublicPlacementBindingIssuer>[0];
  readonly sources: readonly { readonly app: string; readonly source: string; readonly identity: string }[];
  readonly recoveryOrigins?: readonly { readonly app: string; readonly origin: string; readonly recoverUntil: number }[];
}

export function suitePlacementConfiguration(
  input: unknown,
  environment: NodeJS.ProcessEnv,
  apps: readonly string[],
  publicOrigin: string | undefined,
  identitySecrets: readonly string[] = [],
): SuitePlacementConfiguration | undefined {
  if (input === undefined) return undefined;
  try {
    if (!publicOrigin) throw new Error();
    const value = flagStoreRecord(input, ['issuerId', 'activeKey', 'keys', 'sources', 'recoveryOrigins']);
    const issuerId = flagStoreIdentifier(value.issuerId),
      activeKey = flagStoreIdentifier(value.activeKey);
    if (
      !Array.isArray(value.keys) ||
      !value.keys.length ||
      value.keys.length > 2 ||
      !Array.isArray(value.sources) ||
      !value.sources.length ||
      value.sources.length > 128
    )
      throw new Error();
    const keys = value.keys.map((raw) => {
      const key = flagStoreRecord(raw, ['id', 'secretEnv', 'issueFrom', 'issueUntil']);
      const id = flagStoreIdentifier(key.id);
      if (
        typeof key.secretEnv !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.secretEnv) ||
        !Number.isSafeInteger(key.issueFrom) ||
        (key.issueFrom as number) < 0 ||
        (key.issueUntil !== undefined && (!Number.isSafeInteger(key.issueUntil) || (key.issueUntil as number) < (key.issueFrom as number)))
      )
        throw new Error();
      const secret = environment[key.secretEnv];
      if (
        !secret ||
        key.secretEnv === 'BETTER_AUTH_SECRET' ||
        identitySecrets.includes(secret) ||
        secret === environment.BETTER_AUTH_SECRET
      )
        throw new Error();
      return Object.freeze({
        id,
        secret,
        issueFrom: key.issueFrom as number,
        ...(key.issueUntil === undefined ? {} : { issueUntil: key.issueUntil as number }),
      });
    });
    const seen = new Set<string>();
    const sources = value.sources.map((raw) => {
      const item = flagStoreRecord(raw, ['app', 'source', 'identity']);
      const app = flagStoreIdentifier(item.app),
        source = flagStoreIdentifier(item.source),
        identity = flagStoreIdentifier(item.identity);
      const key = JSON.stringify([app, source]);
      if (!apps.includes(app) || seen.has(key)) throw new Error();
      seen.add(key);
      return Object.freeze({ app, source, identity });
    });
    const issuer = Object.freeze({ issuerId, activeKey, keys: Object.freeze(keys) });
    createPublicPlacementBindingIssuer(issuer); // Validate the captured keyring without issuing anything.
    const retained = value.recoveryOrigins ?? [];
    if (!Array.isArray(retained) || retained.length > 128) throw new Error();
    const now = Date.now(),
      seenOrigins = new Set<string>();
    const recoveryOrigins = retained.map((raw) => {
      const item = flagStoreRecord(raw, ['app', 'origin', 'recoverUntil']);
      const app = flagStoreIdentifier(item.app),
        origin = normalizeSuitePublicOrigin(item.origin);
      const key = JSON.stringify([app, origin]);
      if (
        !apps.includes(app) ||
        origin !== item.origin ||
        origin === publicOrigin ||
        seenOrigins.has(key) ||
        !Number.isSafeInteger(item.recoverUntil) ||
        (item.recoverUntil as number) < 0 ||
        (item.recoverUntil as number) > now + 24 * 60 * 60 * 1000 + 120_000
      )
        throw new Error();
      seenOrigins.add(key);
      return Object.freeze({ app, origin, recoverUntil: item.recoverUntil as number });
    });
    return Object.freeze({ issuer, sources: Object.freeze(sources), recoveryOrigins: Object.freeze(recoveryOrigins) });
  } catch {
    throw new Error(
      'Public placement requires an explicit canonical publicOrigin, dedicated persisted keyring, and enrolled App/source identities.',
    );
  }
}
