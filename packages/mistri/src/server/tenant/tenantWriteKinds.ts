/**
 * The kinds of tenant writer transaction, and the source methods they make.
 * Each method takes its own realm's evidence: a value whose own `realm` data
 * property routes elsewhere is refused before the writer's queue, so none
 * crosses into another. A kind adds its tenantWriteKind*.ts module and one
 * line to the table; its methods join TenantWriteSource from it.
 */
import { isProxy } from 'node:util/types';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import {
  TenantWriteFailure,
  type TenantWriteEvidence,
  type TenantWriteKind,
  type TenantWriteOperation,
  type TenantWriteRun,
} from './tenantWriteKindContract.js';
import { intakeWriteKind } from './tenantWriteKindIntake.js';
import { memberWriteKind } from './tenantWriteKindMember.js';
import { platformWriteKind } from './tenantWriteKindPlatform.js';
import { platformTenantWriteKind } from './tenantWriteKindPlatformTenant.js';
import { serviceWriteKind } from './tenantWriteKindService.js';
import { supportWriteKind } from './tenantWriteKindSupport.js';

const TENANT_WRITE_KINDS = Object.freeze([
  memberWriteKind,
  platformWriteKind,
  platformTenantWriteKind,
  intakeWriteKind,
  serviceWriteKind,
  supportWriteKind,
] as const);

type MethodsOf<Kind> = Kind extends TenantWriteKind<infer _Evidence, infer Methods> ? Methods : never;
type Intersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer All) => void ? All : never;
/** Every kind's source methods, as one surface. */
export type TenantWriteMethods = Intersection<MethodsOf<(typeof TENANT_WRITE_KINDS)[number]>>;
/** The engine's one transaction, over any kind. */
type TenantWriteEngine = <Evidence extends TenantWriteEvidence, T>(
  kind: TenantWriteKind<Evidence, object>,
  command: boolean,
  evidence: Evidence,
  rows: RowScope,
  run: TenantWriteRun<T>,
  assertActive?: () => void,
  operation?: TenantWriteOperation,
  footprint?: readonly string[],
) => Promise<T>;

/** Whose evidence this is, by its own data property: a proxy or an accessor is
 * never the platform realm's, public intake's or any other kind's. */
const realmOf = (value: unknown): unknown => {
  const realm =
    !!value && typeof value === 'object' && !isProxy(value) ? Object.getOwnPropertyDescriptor(value, 'realm')?.value : undefined;
  return TENANT_WRITE_KINDS.some((kind) => kind.realm === realm) ? realm : 'tenant';
};
const refused = (): Promise<never> => Promise.reject(new TenantWriteFailure('not_applied'));

/** The source's methods over one engine: each kind's, gated on its realm. */
export function tenantWriteMethods(engine: TenantWriteEngine): TenantWriteMethods {
  const methods: Record<string, (evidence: unknown, ...rest: unknown[]) => Promise<unknown>> = {};
  for (const kind of TENANT_WRITE_KINDS as unknown as readonly TenantWriteKind<TenantWriteEvidence, object>[]) {
    const own = kind.methods((command, evidence, rows, run, active, operation, footprint) =>
      engine(kind, command, evidence, rows, run, active, operation, footprint),
    ) as Record<string, (evidence: unknown, ...rest: unknown[]) => Promise<unknown>>;
    for (const [name, method] of Object.entries(own)) {
      // Two kinds answering one method would make routing ambiguous: refuse to publish a writer.
      if (Object.hasOwn(methods, name)) denyTenant();
      methods[name] = (evidence, ...rest) => (realmOf(evidence) === kind.realm ? method(evidence, ...rest) : refused());
    }
  }
  return methods as unknown as TenantWriteMethods;
}
