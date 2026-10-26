/** Audience membership: one reading of an App's declared audiences, shared by
 * flag rules and experiment eligibility so the two can never disagree about
 * who "beta" is. Pure: no identity is created and nothing is recorded. */
import { createHash } from 'node:crypto';
import type { AudienceDefinition, FlagContext } from '../../shared/appFlags.js';

interface AudienceInput {
  readonly appId: string;
  readonly environment: string;
  /** The verified evaluation tenant, or null outside one. */
  readonly tenantId: string | null;
  readonly context: FlagContext;
}

/** A stable percentage in [0,100) for one identity in one audience. The salt is
 * the audience's name, not a flag's: every flag and experiment naming the
 * audience reaches the same people, and widening its rollout only adds people. */
export function audienceBucket(input: { appId: string; environment: string; audience: string; kind: string; id: string }): number {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['mistri.audience.v1', input.appId, input.environment, input.audience, input.kind, input.id]))
    .digest();
  // 48 bits fit exactly in a JS number, so the largest bucket stays below 100.
  return (bytes.readUIntBE(0, 6) / 281474976710656) * 100;
}

export function inAudience(name: string, audience: AudienceDefinition, input: AudienceInput): boolean {
  const identity = input.context.identity,
    account = identity?.kind === 'subject' ? identity.id : undefined;
  if (account !== undefined && audience.deny?.includes(account)) return false;
  if (account !== undefined && audience.allow?.includes(account)) return true;
  const conditions = audience.roles || audience.tenants || audience.attributes || audience.rollout !== undefined;
  // A list-only audience: deny alone excludes a few from everyone; allow names its members.
  if (!conditions) return !audience.allow;
  if (audience.roles && !audience.roles.some((role) => input.context.roles?.includes(role))) return false;
  if (audience.tenants && (input.tenantId === null || !audience.tenants.includes(input.tenantId))) return false;
  const domain = input.context.attributes?.emailDomain;
  if (audience.attributes?.emailDomain && (domain === undefined || !audience.attributes.emailDomain.includes(domain))) return false;
  if (audience.rollout !== undefined) {
    if (!identity) return false;
    const bucket = audienceBucket({
      appId: input.appId,
      environment: input.environment,
      audience: name,
      kind: identity.kind,
      id: identity.id,
    });
    if (bucket >= audience.rollout) return false;
  }
  return true;
}

/** Whether the context belongs to any of the named audiences. A name the
 * catalog does not declare matches nobody; the normalizers refuse it earlier. */
export function inAnyAudience(
  names: readonly string[],
  audiences: Readonly<Record<string, AudienceDefinition>>,
  input: AudienceInput,
): boolean {
  return names.some((name) => Object.hasOwn(audiences, name) && inAudience(name, audiences[name], input));
}

/** The domain of an address the account proved, lowercased; undefined for any
 * other, since an unproven address is one anybody could have typed. */
export function provenEmailDomain(identity: { readonly who?: string; readonly emailUnproven?: true }): string | undefined {
  if (identity.emailUnproven || typeof identity.who !== 'string') return undefined;
  const at = identity.who.lastIndexOf('@');
  const domain = at > 0 ? identity.who.slice(at + 1).toLowerCase() : '';
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) ? domain : undefined;
}
