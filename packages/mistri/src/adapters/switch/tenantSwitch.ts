/**
 * The tenant switch, the engine-neutral half: one table for every feature the
 * platform owner turns on per tenant, with the consent reference they wrote
 * when they did. The assistant and each decision provider used to keep a
 * table of this one shape apiece; a feature is a row now, not a table.
 *
 * It is a store of its own (a version row beside the table) because two
 * stores read and write it and neither may attest the other's layout. The
 * assistant and the decision stores each provision it with their own and
 * require it ready before they open, so a switch is never read from a
 * database that does not hold it.
 *
 * The prefix is not `__mistri_tenant_`: that one is the tenant store's, and
 * a table under it would read there as a foreign relation.
 */
export const TENANT_SWITCH_VERSION = 1;
export const TENANT_SWITCH_PREFIX = '__mistri_switch_';
export const TENANT_SWITCH_TABLES = Object.freeze({
  meta: `${TENANT_SWITCH_PREFIX}meta`,
  /** The proposal's `tenant_switch`: (app, tenant, feature, enabled, consent, changed_at). */
  tenant: `${TENANT_SWITCH_PREFIX}tenant`,
});

/** Bounds, the same on every engine. A feature is `assistant` or `decide:<provider>`. */
export const TENANT_SWITCH_LIMITS = Object.freeze({ app: 128, tenant: 128, feature: 64, consent: 2000 });

/** The assistant's one switch per tenant. */
export const ASSISTANT_FEATURE = 'assistant';
/** A decision provider's switch (a provider is a short lowercase name, decisionStore.ts). */
export const decideFeature = (provider: string): string => `decide:${provider}`;
/** What `LIKE` takes to find every decision provider's switch: `decide:` has no wildcard in it. */
export const DECIDE_FEATURES = 'decide:%';
/** The provider a decision feature names. */
export const providerOf = (feature: string): string => feature.slice('decide:'.length);
