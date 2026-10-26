import { isProxy } from 'node:util/types';
import { AppRowPolicyDefinitionError, loadAppPolicyModule } from './appRowPolicy.js';
import { recordRefusalCause, refusalCause } from '@mistriwork/engine/shared/refusal.js';
import {
  captureTenantData,
  TenantContextError,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import type { TenantDeletedRecordPolicy } from '../tenant/tenantInverseImages.js';
import type { TenantMembershipEvidence } from '../tenant/tenantMembership.js';
import type { PlatformMembershipEvidence } from '../tenant/tenantPlatform.js';
import type { TenantPublicEvidence } from '../tenant/tenantPublicRead.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { MAX_COMMAND_IDS } from '../commands/commandLimits.js';
import { ASSISTANT_RETENTION_DAYS } from '../../shared/appAssistant.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import { captureAdministrationPolicy, type AdministrationPolicy } from '../tenant/tenantAdministrationModel.js';
import { captureInvitationPolicy, type InvitationPolicy } from '../tenant/tenantInvitationModel.js';
import { captureSupportPolicy, type SupportPolicy } from '../tenant/tenantSupportChange.js';

export type TenantPolicyOwnership<S extends Record<string, string>> = {
  readonly [Table in keyof S]:
    | { readonly kind: 'tenant'; readonly column: S[Table] }
    | { readonly kind: 'global'; readonly access: 'read-only' }
    | { readonly kind: 'platform' };
};
/** Trusted server-only declaration. Account/session verification and membership
 * storage are supplied by the host, never overridable by policy callbacks. */
export interface AppTenantPolicy<S extends Record<string, string> = Record<string, string>> {
  readonly kind: 'tenant';
  readonly appId: string;
  readonly storeId: string;
  readonly ownership: TenantPolicyOwnership<S>;
  readonly resolveMembershipRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly resolveRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  /** The platform realm's rows (`auth.tenancy.platform`): every table a platform
   * context reads, across tenants. A table it does not name is denied. Present
   * exactly when the App declares the platform realm; required once any
   * resource is platform-owned. */
  readonly resolvePlatformRows?: (principal: PlatformMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly authorizeDeletedRecord?: TenantDeletedRecordPolicy;
  readonly resultReferences?: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
  readonly administration?: AdministrationPolicy;
  readonly invitations?: InvitationPolicy;
  /**
   * Audited support ("enter as dealer"): which platform roles may enter which
   * dealers (`'all'` is every active dealer), and which of that dealer's
   * roles a session may hold, one at a time. Needs the platform realm,
   * `writable: true`, the support audit store and `MISTRI_AUDIT_KEY`.
   */
  readonly support?: SupportPolicy;
  /**
   * Public intake, required exactly when the App has a public form: where its
   * submissions land. `address` names a text column of the platform's profile
   * table (`auth.tenancy.profile`) holding each tenant's public intake
   * address: an unguessable string the platform issues through its own
   * commands and the tenant publishes (`/{app}/form/{key}?via=`). The server
   * resolves it; a submission no address places goes to the platform, so the
   * App needs the platform realm.
   */
  readonly intake?: { readonly address: string };
  /**
   * Public reads, required exactly when the App says `auth.public`: where a
   * visitor's tenant is found. `address` names a text column of the
   * platform's profile table holding each tenant's public address, under the
   * same rules as `intake.address` (it may be the same column): an
   * unguessable string the platform issues through its own commands and the
   * tenant publishes (`?via=`). Anyone with it reads that one tenant's public
   * rows; nothing lists the addresses, so a tenant's page is unlisted unless
   * the tenant links to it.
   */
  readonly public?: { readonly address: string };
  /**
   * A visitor's rows, beside `public`: which of the placed tenant's rows of
   * each resource `auth.public` names are public (a status page that says it
   * is published, an article that is not a draft). A table it does not name
   * is denied; the tenant predicate is the runtime's, added to every group,
   * so the callback cannot reach another tenant's rows.
   */
  readonly resolvePublicRows?: (visitor: TenantPublicEvidence) => RowScope | Promise<RowScope>;
  /**
   * The in-App assistant, where the App declares one (docs/tenant-apps.md, "The assistant"): what the platform
   * owner allows each tenant beyond the App's own caps. `tokensPerTenantPerDay` is what one tenant's people may
   * spend together in a day; `retentionDays` is how long a conversation is kept after its last word (90 when
   * unset). Whether a tenant has the assistant at all is a switch held in the store, set in Manage tenants.
   */
  readonly assistant?: TenantAssistantPolicy;
  /**
   * The App's decisions (defineDecision), where its jobs declare some: what the platform owner allows each tenant.
   * `callsPerTenantPerDay` is how many provider calls one tenant's decisions may make in a day (UTC), refused as
   * `none (cap)` before the call; `retentionDays` is how long a decision row is kept (365 when unset). Whether a
   * tenant has decisions at all is a switch per provider held in the store, set in Manage tenants.
   */
  readonly decisions?: TenantDecisionPolicy;
}
export interface TenantDecisionPolicy {
  readonly callsPerTenantPerDay?: number;
  readonly retentionDays?: number;
}
export interface TenantAssistantPolicy {
  readonly tokensPerTenantPerDay?: number;
  readonly retentionDays?: number;
}
/** How long a tenant's conversation is kept when the policy does not say: an ordinary App's period. */
export const TENANT_ASSISTANT_RETENTION_DAYS = ASSISTANT_RETENTION_DAYS;
export class AppTenantPolicyDefinitionError extends Error {
  readonly code = 'invalid-app-tenant-policy-definition';
  constructor() {
    super('The App tenant policy definition could not be loaded or is invalid.');
    this.name = 'AppTenantPolicyDefinitionError';
  }
}
/* The sentence is fixed and the reason travels as the recorded cause, read
   only by the operator's console (`because:` at startup), as a row policy's
   does: "could not be loaded or is invalid" alone sent authors to the source. */
const invalid = (reason?: unknown): never => {
  throw recordRefusalCause(new AppTenantPolicyDefinitionError(), reason);
};
/** A nested declaration's own capture refuses without naming where it was. */
function section<T>(name: string, capture: () => T): T {
  try {
    return capture();
  } catch (error) {
    // The capture's own sentence is the tenant-context one, which says nothing here; keep only what it recorded.
    const because = error instanceof TenantContextError ? refusalCause(error) : error;
    return invalid(recordRefusalCause(new Error(`The tenant policy's ${name} is not a valid declaration.`), because));
  }
}
const simple = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const optionalCallbacks = new Set(['authorizeDeletedRecord', 'resolvePlatformRows', 'resolvePublicRows']);

export function defineAppTenantPolicy<S extends Record<string, string> = Record<string, string>>(
  input: AppTenantPolicy<S>,
): AppTenantPolicy<S> {
  try {
    const fields = [
      'kind',
      'appId',
      'storeId',
      'ownership',
      'resolveMembershipRows',
      'resolveRows',
      'resolvePlatformRows',
      'authorizeDeletedRecord',
      'resultReferences',
      'administration',
      'invitations',
      'support',
      'intake',
      'public',
      'resolvePublicRows',
      'assistant',
      'decisions',
    ];
    if (input && typeof input === 'object' && !isProxy(input)) {
      const unknown = Reflect.ownKeys(input).find((key) => typeof key !== 'string' || !fields.includes(key));
      if (unknown !== undefined)
        return invalid(`The tenant policy names "${String(unknown).slice(0, 64)}", which is not one of ${fields.join(', ')}.`);
    }
    const raw = section('definition', () => tenantOptions(input, fields));
    if (raw.kind !== 'tenant') return invalid("A tenant policy has kind: 'tenant'.");
    section('appId', () => tenantIdentifier(raw.appId));
    section('storeId', () => tenantIdentifier(raw.storeId));
    const ownership = section('ownership', () => {
      const value = captureTenantData(raw.ownership);
      tenantRecord(value);
      return value;
    });
    const entries = Object.entries(ownership);
    if (!entries.length || entries.length > 256) return invalid("The tenant policy's ownership names between 1 and 256 tables.");
    let tenant = false,
      platform = false;
    for (const [table, rule] of entries) {
      const named = `ownership["${table.slice(0, 64)}"]`;
      if (!simple.test(table) || reserved.has(table) || table.toLowerCase().startsWith('__mistri_')) {
        return invalid(`The tenant policy's ${named} is not a table name.`);
      }
      const shape = section(named, () => {
        tenantRecord(rule);
        return rule;
      });
      if (shape.kind === 'tenant') {
        section(named, () => {
          tenantRecord(shape, ['kind', 'column']);
          tenantIdentifier(shape.column);
        });
        tenant = true;
      } else if (shape.kind === 'global') {
        section(named, () => tenantRecord(shape, ['kind', 'access']));
        if (shape.access !== 'read-only')
          return invalid(`The tenant policy's ${named} is global, and a global table is access: 'read-only'.`);
      } else if (shape.kind === 'platform') {
        section(named, () => tenantRecord(shape, ['kind']));
        platform = true;
      } else return invalid(`The tenant policy's ${named} has kind ${JSON.stringify(shape.kind)}; it is 'tenant', 'global' or 'platform'.`);
    }
    if (!tenant) return invalid("The tenant policy's ownership has no table of kind 'tenant'.");
    for (const name of ['resolveMembershipRows', 'resolveRows', 'resolvePlatformRows', 'resolvePublicRows', 'authorizeDeletedRecord']) {
      if (optionalCallbacks.has(name) && !Object.hasOwn(raw, name)) continue;
      if (typeof raw[name] !== 'function' || isProxy(raw[name])) return invalid(`The tenant policy's ${name} must be a function.`);
    }
    // A platform-owned table no platform context could read is a declaration
    // mistake, not a quiet denial: the realm needs its row policy.
    if (platform && !Object.hasOwn(raw, 'resolvePlatformRows')) {
      return invalid('The tenant policy owns a platform table, so it needs resolvePlatformRows.');
    }
    let resultReferences: AppTenantPolicy['resultReferences'];
    if (Object.hasOwn(raw, 'resultReferences')) {
      const value = raw.resultReferences;
      if (!value || typeof value !== 'object' || isProxy(value))
        return invalid("The tenant policy's resultReferences is an object of functions.");
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_COMMAND_IDS || keys.some((key) => typeof key !== 'string'))
        return invalid(
          `The tenant policy's resultReferences names ${keys.length} command ids; it names at most ${MAX_COMMAND_IDS}, one per registered command.`,
        );
      const captured = section('resultReferences', () => tenantOptions(value, keys as string[]));
      for (const [id, callback] of Object.entries(captured)) {
        if (
          id.length > 256 ||
          !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) ||
          reserved.has(id) ||
          typeof callback !== 'function' ||
          isProxy(callback)
        ) {
          return invalid(`The tenant policy's resultReferences["${id.slice(0, 64)}"] must be a function under a command's id.`);
        }
      }
      resultReferences = Object.freeze(captured) as AppTenantPolicy['resultReferences'];
    }
    const administration = Object.hasOwn(raw, 'administration')
      ? section('administration', () => captureAdministrationPolicy(raw.administration))
      : undefined;
    const invitations = Object.hasOwn(raw, 'invitations')
      ? section('invitations', () => captureInvitationPolicy(raw.invitations))
      : undefined;
    const support = Object.hasOwn(raw, 'support') ? section('support', () => captureSupportPolicy(raw.support)) : undefined;
    let intake: AppTenantPolicy['intake'];
    if (Object.hasOwn(raw, 'intake')) {
      const value = section('intake', () => {
        const captured = captureTenantData(raw.intake);
        tenantRecord(captured, ['address']);
        tenantIdentifier(captured.address);
        return captured;
      });
      // The address lives on the platform's profile table, and triage is the platform's.
      if (!simple.test(value.address as string)) return invalid("The tenant policy's intake.address names a column of the profile table.");
      if (!platform) return invalid('The tenant policy has an intake, which the platform triages, but owns no platform table.');
      intake = Object.freeze({ address: value.address as string });
    }
    let publicReads: AppTenantPolicy['public'];
    if (Object.hasOwn(raw, 'public')) {
      const value = section('public', () => {
        const captured = captureTenantData(raw.public);
        tenantRecord(captured, ['address']);
        tenantIdentifier(captured.address);
        return captured;
      });
      // The address lives on the platform's profile table, as intake's does.
      if (!simple.test(value.address as string)) return invalid("The tenant policy's public.address names a column of the profile table.");
      if (!platform) return invalid('The tenant policy has public reads, whose addresses the profile holds, but owns no platform table.');
      publicReads = Object.freeze({ address: value.address as string });
    }
    // The address and the rows it opens: both or neither.
    if ((publicReads === undefined) !== !Object.hasOwn(raw, 'resolvePublicRows'))
      return invalid(
        "The tenant policy's public and resolvePublicRows come together: where a visitor's tenant is found, and its public rows.",
      );
    let assistant: TenantAssistantPolicy | undefined;
    if (Object.hasOwn(raw, 'assistant')) {
      const value = section('assistant', () => {
        const captured = captureTenantData(raw.assistant);
        tenantRecord(captured, ['tokensPerTenantPerDay', 'retentionDays']);
        return captured;
      });
      const whole = (name: string, most: number) => {
        const number = value[name];
        if (number === undefined) return undefined;
        if (!Number.isSafeInteger(number) || (number as number) < 1 || (number as number) > most)
          return invalid(`The tenant policy's assistant.${name} is a whole number from 1 to ${most}.`);
        return number as number;
      };
      const perDay = whole('tokensPerTenantPerDay', 1_000_000_000);
      const retention = whole('retentionDays', 3650);
      assistant = Object.freeze({
        ...(perDay === undefined ? {} : { tokensPerTenantPerDay: perDay }),
        ...(retention === undefined ? {} : { retentionDays: retention }),
      });
    }
    let decisions: TenantDecisionPolicy | undefined;
    if (Object.hasOwn(raw, 'decisions')) {
      const value = section('decisions', () => {
        const captured = captureTenantData(raw.decisions);
        tenantRecord(captured, ['callsPerTenantPerDay', 'retentionDays']);
        return captured;
      });
      const whole = (name: string, most: number) => {
        const number = value[name];
        if (number === undefined) return undefined;
        if (!Number.isSafeInteger(number) || (number as number) < 1 || (number as number) > most)
          return invalid(`The tenant policy's decisions.${name} is a whole number from 1 to ${most}.`);
        return number as number;
      };
      const perDay = whole('callsPerTenantPerDay', 100_000_000);
      const retention = whole('retentionDays', 3650);
      decisions = Object.freeze({
        ...(perDay === undefined ? {} : { callsPerTenantPerDay: perDay }),
        ...(retention === undefined ? {} : { retentionDays: retention }),
      });
    }
    return Object.freeze({
      kind: 'tenant',
      appId: raw.appId as string,
      storeId: raw.storeId as string,
      ownership: ownership as TenantPolicyOwnership<S>,
      resolveMembershipRows: raw.resolveMembershipRows as AppTenantPolicy<S>['resolveMembershipRows'],
      resolveRows: raw.resolveRows as AppTenantPolicy<S>['resolveRows'],
      ...(raw.resolvePlatformRows === undefined
        ? {}
        : { resolvePlatformRows: raw.resolvePlatformRows as NonNullable<AppTenantPolicy<S>['resolvePlatformRows']> }),
      ...(raw.authorizeDeletedRecord === undefined
        ? {}
        : { authorizeDeletedRecord: raw.authorizeDeletedRecord as TenantDeletedRecordPolicy }),
      ...(resultReferences === undefined ? {} : { resultReferences }),
      ...(administration === undefined ? {} : { administration }),
      ...(invitations === undefined ? {} : { invitations }),
      ...(support === undefined ? {} : { support }),
      ...(intake === undefined ? {} : { intake }),
      ...(publicReads === undefined
        ? {}
        : { public: publicReads, resolvePublicRows: raw.resolvePublicRows as NonNullable<AppTenantPolicy<S>['resolvePublicRows']> }),
      ...(assistant === undefined ? {} : { assistant }),
      ...(decisions === undefined ? {} : { decisions }),
    });
  } catch (error) {
    // Already this refusal, with its reason: wrapped again, the console read the fixed sentence twice.
    if (error instanceof AppTenantPolicyDefinitionError) throw error;
    return invalid(error);
  }
}

export async function loadAppTenantPolicy(file: string): Promise<AppTenantPolicy> {
  try {
    return await loadAppPolicyModule(file, (value) => defineAppTenantPolicy(value as AppTenantPolicy));
  }
  // The module loader is shared with row policies: its reason, not its row-policy sentence.
  catch (error) {
    let because = error;
    while (because instanceof AppRowPolicyDefinitionError) because = refusalCause(because);
    return invalid(because);
  }
}
