/**
 * Test-side edits of an AppDef's grants, in the model's own words: the
 * ceilings live on the resources (`access`, `fields`), the grants on
 * `auth.roles`. The tests that prove a mutated App fails closed reach for
 * these instead of rebuilding the object by hand.
 */
import {
  defaultSourceOf,
  type AppDef,
  type AppFieldAccess,
  type AppRoleGrant,
  type ResourceDef,
} from '../../packages/mistri/src/shared/app.js';

/** The role grants of an App that grants by role. */
export function roles(app: AppDef): Record<string, AppRoleGrant> {
  if (!app.auth?.roles) throw new Error('This App grants no roles.');
  return app.auth.roles;
}

/** A resource's block, created when absent: a dotted name lives in its source, a bare one in the default. */
export function resource(app: AppDef, name: string): ResourceDef {
  const resources = (app.resources ??= {});
  if (!Object.hasOwn(resources, name)) {
    const dot = name.indexOf('.');
    const source = dot < 0 ? defaultSourceOf(app) : name.slice(0, dot);
    resources[name] = source ? { source } : {};
  }
  return resources[name];
}

/** Replace the ceilings: each resource in `read` reads, those also in `write` write, and every other resource is no longer declared. */
export function setCeilings(app: AppDef, read: readonly string[], write: readonly string[] = []): void {
  for (const name of Object.keys(app.resources ?? {})) {
    if (read.includes(name)) continue;
    delete app.resources![name];
  }
  for (const name of read) {
    const block = resource(app, name);
    if (write.includes(name)) block.access = 'write';
    else delete block.access;
  }
}

/** Replace every column ceiling with `fields` (none, when undefined). */
export function setFieldCeilings(app: AppDef, fields: Record<string, AppFieldAccess> | undefined): void {
  for (const block of Object.values(app.resources ?? {})) delete block.fields;
  for (const [name, rule] of Object.entries(fields ?? {})) resource(app, name).fields = rule;
}
