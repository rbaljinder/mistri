/** Resolve explicitly enrolled conversion sources through captured App connections. */
import { resolve } from 'node:path';
import { isTenantApp, type AppDef } from '../../shared/app.js';
import { slug } from '@mistriwork/engine/shared/slug.js';
import { expandEnv } from '@mistriwork/engine/server/auth/credentials.js';
import type { SuiteExperimentSource } from '../cli/suiteControlConfig.js';
import type { ExperimentSourceConfiguration } from './producerHost.js';
import { ensure } from './contracts.js';
/** Resolve only an explicit App source through its captured deployment config. */
export function resolveExperimentSource(
  source: SuiteExperimentSource,
  owner: {
    readonly app: AppDef;
    readonly connections: readonly { readonly id?: string; readonly name: string; readonly url: string }[];
    readonly environment: NodeJS.ProcessEnv;
  },
): ExperimentSourceConfiguration {
  ensure(source.appId === owner.app.id && Object.hasOwn(owner.app.experiments ?? {}, source.flagId));
  const declared = owner.app.sources?.[source.sourceId];
  ensure(declared);
  const connection = owner.connections.find((connection) => (connection.id ?? slug(connection.name, 'connection')) === declared.connection);
  ensure(connection, 'Experiment source has no deployed connection.');
  if (!isTenantApp(owner.app))
    ensure(source.tenantId === null && source.storeId === `app:${owner.app.id}`, 'Ordinary Apps use their canonical App event store.');
  const url = expandEnv(connection.url, owner.environment).replace(/^sqlite:(\/\/)?/i, '');
  ensure(
    typeof url === 'string' && url.length > 0 && (!url.includes('://') || /^postgres(ql)?:\/\//.test(url)),
    'Experiment source must be SQLite or PostgreSQL.',
  );
  // Registry and SQLite drivers resolve relative database URLs against the
  // serving process cwd, not the configuration file. Capture that same path.
  return Object.freeze({ ...source, url: /^postgres(ql)?:\/\//.test(url) ? url : resolve(url) });
}
