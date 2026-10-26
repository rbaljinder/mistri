/** Presentation reads borrow an already authorized resource reader. They never
 * open a database, issue tenant evidence or mutate a shared App definition. */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { isPublicForm, isRowPolicyApp, type AppDef, type AppUi } from '../../shared/app.js';
import type { AppLanding } from '../../shared/appModel.js';
import { columnKind, isFlagColumn, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  fallbackBranding,
  type BrandingCatalog,
  type BrandingColumnKind,
  type BrandingSelection,
  type RecordBrandingSpec,
  type ResolvedBranding,
} from '../../shared/branding.js';
import { createRecordBrandingReader, type RecordBrandingReader } from '../app/recordBranding.js';
import { brandingTenant, recordBrandingSpec } from './brandingTenant.js';
import { resolveSource } from './source.js';
import type { RequestContext, ResolvedSource } from '@mistriwork/engine/server/http/context.js';

type BrandingUi = AppUi & { branding?: RecordBrandingSpec };
export { brandingTenant, recordBrandingSpec };
export interface BrandingPresentation {
  readonly value: ResolvedBranding;
  readonly private: boolean;
  /** Public surfaces keep the published look; private Apps retain their reader picker. */
  readonly readerPicker: boolean;
}
/** Staff visiting an authored public page see the same publication as visitors. */
export function publicBrandingSurface(app: AppDef | undefined, path: string): boolean {
  if (!app) return false;
  let parts: string[];
  try {
    parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return false;
  }
  if (parts[0] !== app.id) return false;
  const view = parts[1] === 'form' ? parts[2] : parts[1];
  return Boolean(view && (view === app.landing?.view || isPublicForm(app.views[view])));
}
const hash = (input: string) => createHash('sha256').update(input).digest('hex').slice(0, 24);
const owners = new WeakMap<object, Map<string, RecordBrandingReader>>();
const deployments = new WeakMap<object, string>();
const watching = new WeakMap<Server, Set<object>>();

/** Hosts may call this at retirement. Normal HTTP owners also attach it to
 * server close; weak owner keys and the bounded map retain no database handle. */
export function closeRecordBranding(owner: object): void {
  for (const reader of owners.get(owner)?.values() ?? []) reader.close();
  owners.delete(owner);
}
function watch(req: IncomingMessage, owner: object): void {
  const server = (req.socket as typeof req.socket & { server?: Server })?.server;
  if (!server) return;
  let held = watching.get(server);
  if (!held) {
    watching.set(server, (held = new Set()));
    server.once('close', () => {
      for (const item of held!) closeRecordBranding(item);
      held!.clear();
      watching.delete(server);
    });
  }
  held.add(owner);
}
function catalogOf(app: AppDef, schema: DatabaseSchema): BrandingCatalog {
  return {
    resources: Object.fromEntries(
      schema.tables
        .filter((table) => Object.hasOwn(app.resources ?? {}, table.id))
        .map((table) => {
          const columns: Record<string, BrandingColumnKind> = {};
          for (const column of table.columns) {
            const kind = columnKind(column.type);
            if (isFlagColumn(column)) columns[column.name] = 'boolean';
            else if (/int|serial/i.test(column.type)) columns[column.name] = 'integer';
            else if (kind === 'text' && !/json/i.test(column.type)) columns[column.name] = 'text';
            else if (kind === 'number') columns[column.name] = 'number';
          }
          return [table.id, { columns, primaryKey: primaryKey(table), file: Boolean(app.resources?.[table.id]?.file) }];
        }),
    ),
  };
}
function selection(app: AppDef, source: string, tenant: string | null, revision = 'unavailable'): BrandingSelection {
  return {
    deployment: app.id,
    app: app.id,
    source: hash(source),
    bindingRevision: hash(JSON.stringify(recordBrandingSpec(app))),
    catalogRevision: revision,
    tenant,
  };
}
export function baseRecordBranding(app: AppDef, tenant: string | null = null, privately = false): BrandingPresentation | undefined {
  const spec = recordBrandingSpec(app);
  if (!spec) return undefined;
  return Object.freeze({
    value: fallbackBranding({ spec, columns: [], columnKinds: {}, primaryKey: [] }, selection(app, app.id, tenant)),
    private: privately,
    readerPicker: privately,
  });
}

/** Use inside the read owner's callback; do not release a result until its
 * normal membership/session/revocation fence has completed. */
export async function scopedRecordBranding(options: {
  app: AppDef;
  schema: DatabaseSchema;
  data: Pick<ScopedReads, 'query'>;
  owner: object;
  source: string;
  tenant: string | null;
  publicly: boolean;
  req?: IncomingMessage;
}): Promise<BrandingPresentation | undefined> {
  const { app, schema, data, owner, source, tenant, publicly, req } = options;
  const spec = recordBrandingSpec(app);
  if (!spec) return undefined;
  const fallback = () => baseRecordBranding(app, tenant, !publicly);
  if (!tenant) return fallback();
  try {
    const catalog = catalogOf(app, schema);
    let deployment = deployments.get(owner);
    if (!deployment) deployments.set(owner, (deployment = randomUUID()));
    const stamp = hash(JSON.stringify([deployment, app.id, source, spec, catalog]));
    let entries = owners.get(owner);
    if (!entries) owners.set(owner, (entries = new Map()));
    let reader = entries.get(stamp);
    if (!reader) {
      reader = createRecordBrandingReader({
        spec,
        catalog,
        identity: { ...selection(app, source, tenant, hash(JSON.stringify(catalog))), deployment },
      });
      entries.set(stamp, reader);
      if (entries.size > 16) {
        const oldest = entries.keys().next().value!;
        entries.get(oldest)!.close();
        entries.delete(oldest);
      }
    }
    if (req) watch(req, owner);
    const value = await reader.resolve({
      tenant,
      public: publicly,
      read: async (query) => {
        const answer = await data.query({
          table: query.resource,
          columns: [...query.columns],
          filter: { groups: [[{ column: query.where.column, op: '=', value: query.where.value }]] },
          limit: 2,
          offset: 0,
        });
        // SQLite flags are returned as 0/1 by its adapter. Only declared flag
        // columns get this normalization; arbitrary truthy strings never publish.
        return answer.rows.map((row) =>
          Object.fromEntries(
            query.columns
              .filter((column) => Object.hasOwn(row, column))
              .map((column) => {
                const value = row[column];
                return [
                  column,
                  catalog.resources[query.resource].columns[column] === 'boolean' && (value === 0 || value === 1) ? value === 1 : value,
                ];
              }),
          ),
        );
      },
    });
    return Object.freeze({ value, private: !publicly, readerPicker: !publicly });
  } catch {
    return fallback();
  }
}

/** One result per actual request/App/read mode. Public landing/forms always
 * use the public grant, including when a signed-in account visits them. */
const requests = new WeakMap<IncomingMessage, Map<string, Promise<BrandingPresentation | undefined>>>();
export function requestRecordBranding(
  ctx: RequestContext,
  source?: ResolvedSource,
  publicOnly = false,
): Promise<BrandingPresentation | undefined> {
  const app = source?.selectedHost?.app.app ?? ctx.signedIn?.app.app ?? (ctx.appHosts?.length === 1 ? ctx.appHosts[0].app.app : undefined);
  if (!app || !recordBrandingSpec(app)) return Promise.resolve(undefined);
  const publicly = publicOnly || !ctx.identity.id;
  const key = `${app.id}:${publicly ? 'public' : 'private'}`;
  let kept = requests.get(ctx.req);
  if (!kept) requests.set(ctx.req, (kept = new Map()));
  const hit = kept.get(key);
  if (hit) return hit;
  const work = async () => {
    const tenant = brandingTenant(ctx.req, app, ctx.url, undefined, !publicly);
    const fallback = () => baseRecordBranding(app, tenant, !publicly);
    if (!tenant || (publicly && !app.auth?.public) || ctx.policyUnavailable) return fallback();
    const resolve = async (context: RequestContext, available?: ResolvedSource) => {
      const scoped = available ?? (await resolveSource(context, app.id));
      return scopedRecordBranding({
        app,
        schema: scoped.schema,
        data: scoped.adapter,
        owner: ctx.registry,
        source: scoped.connectionId,
        tenant,
        publicly,
        req: ctx.req,
      });
    };
    try {
      if (isRowPolicyApp(app)) {
        if (!ctx.policy || !ctx.policy.matches(app)) return fallback();
        if (ctx.policyContext && publicly === (ctx.policyContext.principal.kind === 'public')) return await resolve(ctx, source);
        const withContext = publicly ? ctx.policy.withPublicContext : ctx.policy.withContext;
        return await withContext(ctx.req, async (policyContext) => {
          const principal = policyContext.principal;
          if (publicly !== (principal.kind === 'public') || principal.appId !== app.id) return fallback();
          if (
            principal.kind !== 'public' &&
            (principal.id !== ctx.identity.id ||
              JSON.stringify([...principal.roles].sort()) !==
                JSON.stringify(
                  [
                    ...new Set(
                      (ctx.identity.role ?? '')
                        .split(',')
                        .map((role) => role.trim())
                        .filter(Boolean),
                    ),
                  ].sort(),
                ))
          )
            return fallback();
          return resolve({ ...ctx, ...(publicly ? { identity: {} } : {}), policyContext });
        });
      }
      return await resolve(publicOnly ? { ...ctx, identity: {}, policyContext: undefined } : ctx, publicOnly ? undefined : source);
    } catch {
      return fallback();
    }
  };
  const pending = work();
  kept.set(key, pending);
  return pending;
}

/** A payload-only copy, after metadata caches. Carry the resolution inside
 * theme so existing public look adapters preserve it with their theme object. */
export function withRecordBranding<T extends { name: string; ui: AppUi }>(app: T, presentation: BrandingPresentation | undefined): T {
  if (!presentation) return app;
  const { value, readerPicker } = presentation;
  const { branding: _binding, ...ui } = app.ui as BrandingUi;
  const theme = structuredClone(value.theme);
  return {
    ...app,
    name: value.content.name ?? app.name,
    ui: { ...ui, theme: { preset: theme.id, branding: value, readerPicker }, customThemes: [theme] },
  } as T;
}

/** Only text slots and a declared hero image change. Structure, actions,
 * links, forms, search and embedded views are always the authored ones. */
export function withBrandingLanding(landing: AppLanding, presentation: BrandingPresentation | undefined): AppLanding {
  if (!presentation || presentation.value.status !== 'resolved') return landing;
  const { content, images } = presentation.value;
  const slot = (value: string) =>
    value.replace(/\{(name|heading|tagline|hours|about)\}/g, (whole, key: keyof typeof content) => content[key] ?? whole);
  const photo = images.hero;
  const key = photo && Object.values(photo.key);
  // LandingImage currently supports a single-column record key. Composite
  // file references stay in the branding payload for a capable consumer.
  const image = photo && key?.length === 1 ? { from: photo.from, key: key[0], alt: photo.alt ?? landing.hero.image?.alt ?? '' } : undefined;
  return {
    ...landing,
    ...(landing.label ? { label: slot(landing.label) } : {}),
    hero: {
      ...landing.hero,
      heading: content.heading ?? slot(landing.hero.heading),
      ...(content.tagline !== undefined
        ? { text: content.tagline }
        : landing.hero.description
          ? { text: slot(landing.hero.description) }
          : {}),
      ...(landing.hero.highlights ? { highlights: landing.hero.highlights.map(slot) } : {}),
      ...(image && landing.hero.image ? { image } : {}),
    },
    ...(landing.sections
      ? { sections: landing.sections.map((section) => (section.kind === 'text' ? { ...section, text: slot(section.text) } : section)) }
      : {}),
  };
}
