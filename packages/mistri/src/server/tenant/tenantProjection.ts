/**
 * The projection of the App and its pages a tenant server answers `/api/app` and `/api/pages` from, split from
 * tenantHttp.ts: bound to the App, its pages, the schema its ownership came from, the realm asked for and the
 * look a save may have changed in place.
 */
import type { AppDef } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { localizedApp } from '../app/apps.js';
import { menuFor } from '../app/appTenantProfile.js';
import type { readTenantMessages } from '../app/recordMessages.js';
import { wearing, type TenantLook } from './tenantLook.js';
import { projectTenantMetadata } from './tenantMetadata.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import type { tenantServedSchema } from './tenantServedSchema.js';

/** What a projection needs from a context, a tenant's or the platform realm's (tenantHttp.ts's ReadContext, narrowed). */
type ProjectedContext = {
  readonly capabilities?: TenantReadContext['capabilities'];
  readonly principal: { readonly roles: readonly string[] };
  readonly zone?: string;
  /** A member's context: the columns of the tenant's profile `auth.tenancy.shared` lists, read for this request. */
  readonly tenant?: TenantReadContext['tenant'];
};

/* The App and pages in another language or a tenant's own words, captured once per localization. localizedApp keeps
   each (locale, words) localization as the same two objects, built from the App's definition and nobody's request,
   so they are this process's as the App itself is; their capture was a deep copy of the whole App on every request
   that answered its payload, and then hashed whole again by the projection (tenantMetadata.ts), since a new copy is
   a new object: a field report put a tenant's enter at up to a second of CPU. Nothing about the person, tenant or
   lease is in it: those decide what the projection keeps of it, afterwards, on every request. */
const localizations = new WeakMap<object, { readonly pages: unknown; readonly said: { app: AppDef; pages: readonly PageDef[] } }>();
export function capturedLocalization(local: { app: AppDef; pages: readonly PageDef[] }) {
  const held = localizations.get(local.app);
  if (held && held.pages === local.pages) return held.said;
  const said = captureTenantData({ app: local.app, pages: local.pages });
  localizations.set(local.app, { pages: local.pages, said });
  return said;
}

export function tenantProjection({
  app,
  pages,
  schema: source,
  platform,
  look,
}: {
  app: AppDef;
  pages: readonly PageDef[];
  schema: DatabaseSchema;
  platform: boolean;
  look: (() => TenantLook | undefined) | undefined;
}) {
  /* The App and its pages as this context is offered them, in `locale` with the tenant's own `words`: what
     `/api/app` and `/api/pages` answer from, and what the page's boot plans its room from. Projected once per
     served schema, look, locale and words: the boot asks both routes together, and it was projected for each.
     A menu with `when`s is remembered by which of them the profile meets, not by the profile's values, so every
     tenant shown the same menu shares one; the per-schema entries are bounded all the same, oldest out first,
     and a look saved in place starts them over. */
  const PROJECTIONS_PER_SCHEMA = 64;
  const projections = new WeakMap<object, { look: unknown; byKey: Map<string, ReturnType<typeof projectTenantMetadata>> }>();
  /* The menu's `when`s, judged after the roles' arrangement on each tenant's profile (appTenantProfile.ts). */
  const menu = menuFor(app, source);
  /* The tenant's catalog folder (`ui.catalog`), read with its profile; the platform realm says the App's words. */
  const variantOf = (context: ProjectedContext): string | undefined => {
    const value = app.ui.catalog === undefined || platform ? undefined : context.tenant?.[app.ui.catalog];
    return typeof value === 'string' ? value : undefined;
  };
  const projected = (
    context: ProjectedContext,
    schema: ReturnType<typeof tenantServedSchema>,
    locale: string | undefined,
    words: Awaited<ReturnType<typeof readTenantMessages>>,
  ) => {
    /* The payload wears the look a save changed in place; every check above read the App it started with. */
    const wearingNow = look?.();
    /* A menu with `when`s is this tenant's by the ones its profile meets, and the platform realm meets none. */
    const profile = menu && !platform ? context.tenant : undefined;
    const variant = variantOf(context);
    const key = JSON.stringify([
      locale ?? null,
      variant ?? null,
      words?.words.size ? words.stamp : null,
      menu ? menu.met(profile) : null,
      context.principal.roles,
    ]);
    let held = projections.get(schema);
    if (!held || held.look !== wearingNow) projections.set(schema, (held = { look: wearingNow, byKey: new Map() }));
    const found = held.byKey.get(key);
    if (found) return found;
    const worn = wearing(app, wearingNow);
    const local = localizedApp({ app: worn, pages: [...pages] }, locale, words, variant);
    const said = local.app === worn ? { app: worn, pages } : capturedLocalization(local);
    /* The lease's realm, not the schema's shape, decides which
       surface this context is offered. A support session reads as
       the dealer it entered, so it is offered the dealer's realm. */
    /* Pruned on the definition in the reader's words: the payload's menu carries no `when` (appPayload.ts
       servedNav), and a localized definition is parsed again from the source, so only now is it final. */
    const value = projectTenantMetadata(
      menu ? menu.shown(said.app, profile) : said.app,
      said.pages,
      schema,
      context.capabilities,
      context.principal.roles,
      platform ? 'platform' : 'tenant',
      context.zone,
      locale,
    );
    if (held.byKey.size >= PROJECTIONS_PER_SCHEMA) held.byKey.delete(held.byKey.keys().next().value!);
    held.byKey.set(key, value);
    return value;
  };

  return { projected, variantOf };
}
