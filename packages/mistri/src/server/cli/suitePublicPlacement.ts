/** One drained suite activation owns one fresh placement epoch. Stable issuer
 * keys and physical source identities come only from explicit operator config. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppDef } from '../../shared/app.js';
import { createPublicPlacementBindingIssuer } from '../forms/publicPlacementBinding.js';
import type { HttpPublicPlacementOptions } from '../http/publicPlacement.js';
import type { SuiteConfiguration } from './suiteConfig.js';
import { loadAppRowPolicy } from '../policy/appRowPolicy.js';

// Node caches policy modules by filename. Keep their first accepted digest too,
// so an in-process restart cannot hash new bytes and execute the old module.
const loadedRevisions = new Map<string, string>();
export async function captureSuitePlacementPolicy(file: string, revision: string): Promise<void> {
  const path = resolve(file);
  const digest = async () =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  if ((loadedRevisions.has(path) && loadedRevisions.get(path) !== revision) || (await digest()) !== revision) {
    throw new Error('Placement policy changed during startup; restart with an immutable policy module.');
  }
  // Preload through the same loader used by the child. Its subsequent import
  // consumes this exact cached module, even if the file is replaced afterward.
  await loadAppRowPolicy(path);
  loadedRevisions.set(path, revision);
  if ((await digest()) !== revision) throw new Error('Placement policy changed while loading.');
}

export function createSuitePublicPlacement(config: SuiteConfiguration) {
  const placement = config.publicPlacement;
  if (!placement) return undefined;
  if (!config.publicOrigin) throw new Error('Public placement needs a canonical suite origin.');
  const issuer = createPublicPlacementBindingIssuer(placement.issuer),
    epoch = randomUUID();
  const publicOrigin = config.publicOrigin,
    canonical = new URL(publicOrigin);
  const sources = placement.sources.map((source) => Object.freeze({ ...source }));
  const retainedOrigins = (placement.recoveryOrigins ?? []).map((origin) => Object.freeze({ ...origin }));
  const hosts = (config.hosts ?? []).map((host) => Object.freeze({ ...host }));
  return Object.freeze({
    async forApp(app: AppDef, policyFile: string | undefined, basePath: string): Promise<HttpPublicPlacementOptions | undefined> {
      const enrolled = sources.filter((source) => source.app === app.id);
      if (!enrolled.length) return undefined;
      if (!policyFile || app.auth?.rows !== 'policy') throw new Error('Public placement enrollment requires an ordinary row-policy App.');
      const sourceIdentities = new Map<string, string>();
      for (const source of enrolled) {
        if (!Object.hasOwn(app.sources ?? {}, source.source)) throw new Error('Public placement names an undeclared App source.');
        sourceIdentities.set(source.source, source.identity);
      }
      const policyRevision = createHash('sha256')
        .update(await readFile(policyFile))
        .digest('hex');
      const origins = hosts
        .filter((host) => host.app === app.id)
        .map((host) => {
          const origin = new URL(canonical.origin);
          origin.hostname = host.host;
          return origin.origin;
        });
      const recoveryOrigins = retainedOrigins
        .filter((origin) => origin.app === app.id)
        .map(({ origin, recoverUntil }) => Object.freeze({ origin, recoverUntil }));
      return Object.freeze({
        issuer,
        sourceIdentities,
        epoch,
        policyRevision,
        publicOrigin,
        basePath,
        origins: Object.freeze(origins),
        recoveryOrigins: Object.freeze(recoveryOrigins),
      });
    },
  });
}
