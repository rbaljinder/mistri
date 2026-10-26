/**
 * What a tenant feature hooks into. prepareTenantStartup runs each feature's
 * startup checks and createTenantEnrollment its attestations, one feature per
 * module (tenantFeature*.ts), in the single explicit order tenantFeatures.ts
 * gives. A hook refuses by throwing. It sees declarations and the attestation
 * snapshot only: never a session, a request or a business row.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { AppDef } from '../../shared/app.js';
import type { LoadedApp } from '../app/apps.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import type { JobDeployment } from '../jobs/jobLoader.js';
import type { CapturedJobModule } from '../jobs/jobModule.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { TenantStoreBinding } from './tenantStoreContract.js';
import type { SupportAuditKey } from './tenantSupportAuditContract.js';

/** What startup holds once the server-only policy has loaded. */
export interface TenantStartupPolicy {
  readonly loaded: LoadedApp;
  /** The App as its own source sees it (tenantBusinessApp): no platform-only
   * source, resource or grant naming one. `loaded.app` is the whole App. */
  readonly app: AppDef;
  readonly connection: ConnectionConfig;
  /** The engine the configured connection resolved to. */
  readonly engine: 'sqlite' | 'postgres';
  readonly policy: AppTenantPolicy;
  /** The host's captured environment; direct standalone checks default to process.env. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** The platform-only sources (`realm: 'platform'`) and the connections startup
   * matched to them, in the App's order: none for most Apps. */
  readonly platformSources: readonly { readonly name: string; readonly connection: ConnectionConfig }[];
}
/** What startup holds once the command registry has loaded, before enrollment. */
export interface TenantStartupCommands extends TenantStartupPolicy {
  /** The connection the App's source names. */
  readonly configured: string;
  readonly owned: TenantOwnershipSnapshot;
  readonly registry: BusinessCommandRegistry | undefined;
  /** The --jobs module, when one was loaded. */
  readonly jobs: CapturedJobModule | undefined;
}
/** One startup check. A failure that says nothing of its own is reported as
 * the stage it could not validate: its `stage`, or the stage before it when it
 * names none. Only a TenantCommandStartupError or a CommandLookupRefusal
 * reaches the operator in its own words. */
export type TenantStartupCheck = { readonly stage?: string } & (
  | { readonly phase: 'policy'; run(startup: TenantStartupPolicy): void | Promise<void> }
  | { readonly phase: 'commands'; run(startup: TenantStartupCommands): void | Promise<void> }
);

/** What enrollment has captured before it opens any source. */
export interface TenantEnrollmentDeclaration {
  /** The App as its own source sees it (tenantBusinessApp). */
  readonly app: AppDef;
  readonly policy: AppTenantPolicy;
  /** Genuine opaque handle shared by attestation and every support audit owner. */
  readonly supportAuditKey?: SupportAuditKey;
  readonly registry: BusinessCommandRegistry | undefined;
  /** The jobs module and the deployment it implies, derived as provisioning derives it. */
  readonly jobs?: Readonly<{ module: CapturedJobModule; deployment: JobDeployment }>;
  /** The platform-only sources' names, in the App's order. */
  readonly platformSources: readonly string[];
}
/** The declaration and the store binding the attestation snapshot reads under. */
export interface TenantEnrollmentAttestation extends TenantEnrollmentDeclaration {
  readonly binding: TenantStoreBinding;
}
/** One feature's enrollment hooks. Any refusal is enrollment's opaque denial.
 * `declare` runs before a source opens; `sqlite` and `postgres` run inside the
 * one attestation read snapshot, after the tenant store and before ownership
 * is captured, on that snapshot's own handle. */
export interface TenantEnrollmentHook {
  declare?(enrollment: TenantEnrollmentDeclaration): void;
  sqlite?(db: DatabaseSync, enrollment: TenantEnrollmentAttestation): void;
  postgres?(client: PgQuery, enrollment: TenantEnrollmentAttestation): Promise<void>;
}
