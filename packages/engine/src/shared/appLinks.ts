/** Checked cross-App destinations are navigation intent, never authority. */
import type { AppTarget, AppLinkValue } from '../../schema/model.js';
export type { AppTarget, AppLinkValue, AppTenantIntent } from '../../schema/model.js';

export type BoundAppTarget = AppTarget<string | number>;
/** A view of this App by key, and for a list the tab it opens on (`?tab=`): `to: 'leads'` or `to: { view: 'leads', tab: 'working' }`. */
export type ViewTo = { view: string; tab?: string };
export type AppLinkAction = { label: string; to: AppTarget } | ({ label: string } & ViewTo);

function object(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error(`${at} must be a plain object.`);
  const raw = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(raw)) {
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !Object.getOwnPropertyDescriptor(raw, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, 'value')
    )
      throw new Error(`${at}: unsupported field "${String(key)}".`);
  }
  return raw;
}

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(value))
    throw new Error(`${at} needs non-empty text.`);
  return value;
}

function value(raw: unknown, at: string, record: boolean): AppLinkValue {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) throw new Error(`${at} needs a safe integer; use text for opaque or large keys.`);
    return raw;
  }
  if (typeof raw === 'string') return text(raw, at);
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'from'))
    throw new Error(`${at} has "from", which is now "column": the field of this record the value is read from.`);
  const bound = object(raw, ['column'], at);
  if (!record) throw new Error(`${at}: "column" bindings require a record surface.`);
  const field = text(bound.column, `${at}.column`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`${at}.column must name one visible field of this record.`);
  return { column: field };
}

/** Parse closed authoring data. Record bindings are opt-in at the source surface. */
export function parseAppTarget(raw: unknown, at = 'App link', record = false): AppTarget {
  const o = object(raw, ['app', 'kind', 'view', 'resource', 'key', 'tenant'], at);
  const app = text(o.app, `${at}.app`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(app)) throw new Error(`${at}.app is not an App id.`);
  const kind = o.kind;
  if (kind !== 'home' && kind !== 'view' && kind !== 'record') throw new Error(`${at}.kind must be home, view or record.`);
  object(raw, ['app', 'kind', 'tenant', ...(kind === 'view' ? ['view'] : kind === 'record' ? ['resource', 'key'] : [])], at);
  let tenant: AppTarget['tenant'];
  if (Object.hasOwn(o, 'tenant')) {
    const t = object(o.tenant, ['kind', 'id'], `${at}.tenant`);
    if (t.kind === 'choose' || t.kind === 'platform') {
      object(t, ['kind'], `${at}.tenant`);
      tenant = { kind: t.kind };
    } else if (t.kind === 'tenant') {
      const id = value(t.id, `${at}.tenant.id`, record);
      if (typeof id !== 'object' && (String(id).trim() !== String(id) || id === '@platform'))
        throw new Error(`${at}.tenant.id is not a tenant selector.`);
      tenant = { kind: 'tenant', id };
    } else throw new Error(`${at}.tenant.kind must be choose, tenant or platform.`);
  }
  const base = { app, ...(tenant ? { tenant } : {}) };
  if (kind === 'home') return { ...base, kind };
  if (kind === 'view') {
    const view = text(o.view, `${at}.view`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(view)) throw new Error(`${at}.view is not a view key.`);
    return { ...base, kind, view };
  }
  const resource = text(o.resource, `${at}.resource`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(resource)) throw new Error(`${at}.resource is not a resource name.`);
  const keys = o.key && typeof o.key === 'object' ? Object.keys(o.key) : [];
  const key = object(o.key, keys, `${at}.key`);
  if (!keys.length || keys.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)))
    throw new Error(`${at}.key needs primary-key columns.`);
  return {
    ...base,
    kind,
    resource,
    key: Object.fromEntries(keys.map((column) => [column, value(key[column], `${at}.key.${column}`, record)])),
  };
}

/**
 * `to` is a view's key, `{ view, tab }` for a list opened on one of its tabs, or an App link (`appLink({ … })`): one
 * key says where a link goes. An App link says its App and kind; `{ view, tab }` says neither. Whether the view is a
 * room and the tab one of its tabs is judged where the App is whole (appDestinations.ts).
 */
export function parseLinkTo(to: unknown, at: string, record = false): ViewTo | { to: AppTarget } {
  if (typeof to === 'string') return { view: viewKey(to, at) };
  if (to && typeof to === 'object' && !Array.isArray(to) && !Object.hasOwn(to, 'app') && !Object.hasOwn(to, 'kind')) {
    const o = object(to, ['view', 'tab'], at);
    if (typeof o.view !== 'string') throw new Error(`${at} needs a "view": the key of one of the App's views.`);
    const tab = o.tab;
    if (tab === undefined) return { view: viewKey(o.view, at) };
    if (typeof tab !== 'string' || !tab.trim()) throw new Error(`${at} has a "tab" that is not a tab's address word, like 'working'.`);
    return { view: viewKey(o.view, at), tab: tab.trim() };
  }
  return { to: parseAppTarget(to, at, record) };
}

function viewKey(raw: string, at: string): string {
  const view = raw.trim();
  if (!view || view.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(view)) throw new Error(`${at} needs the key of a view, or an appLink().`);
  return view;
}

export function parseAppLinkAction(raw: unknown, at: string, record = false): AppLinkAction {
  const o = object(raw, ['label', 'to'], at);
  if (typeof o.label !== 'string' || !o.label.trim()) throw new Error(`${at}.label needs non-empty text.`);
  return { label: o.label.trim(), ...parseLinkTo(o.to, `${at}.to`, record) } as AppLinkAction;
}

export function appTargetFields(target: AppTarget): string[] {
  const values = [
    ...(target.kind === 'record' ? Object.values(target.key) : []),
    ...(target.tenant?.kind === 'tenant' ? [target.tenant.id] : []),
  ];
  return [...new Set(values.flatMap((v) => (typeof v === 'object' ? [v.column] : [])))];
}

/** Only bind values already served to this reader. Missing/hidden values refuse. */
export function bindAppTarget(target: AppTarget, row: Readonly<Record<string, unknown>>, visibleFields: readonly string[]): BoundAppTarget {
  const parsed = parseAppTarget(target, 'App link', true);
  const bind = (v: AppLinkValue): string | number => {
    if (typeof v !== 'object') return v;
    if (!visibleFields.includes(v.column) || !Object.hasOwn(row, v.column))
      throw new Error(`App link: unavailable source field "${v.column}".`);
    return value(row[v.column], `App link source "${v.column}"`, false) as string | number;
  };
  return parseAppTarget({
    ...parsed,
    ...(parsed.kind === 'record' ? { key: Object.fromEntries(Object.entries(parsed.key).map(([k, v]) => [k, bind(v)])) } : {}),
    ...(parsed.tenant?.kind === 'tenant' ? { tenant: { kind: 'tenant', id: bind(parsed.tenant.id) } } : {}),
  }) as BoundAppTarget;
}
