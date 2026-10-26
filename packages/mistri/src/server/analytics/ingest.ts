/**
 * What may become an analytics event, decided before the store is called.
 *
 * Nothing here trusts the browser for identity or time: the unit comes from
 * the session or the visitor cookie (beaconHttp.ts), the clock is the
 * server's, and a name, a step or a field is kept only when the App's
 * declaration names it. A field value is a scalar of at most 200 characters,
 * and a value that looks like an email address, an IP address or a URL query
 * is dropped and counted (`counters`), never stored. A view is recorded by
 * its declared id and a route template with parameters, never by the URL.
 */
import { ANALYTICS_LIMITS, type AnalyticsCatalog, type AnalyticsDeclaration, type AnalyticsKind } from '../../shared/appAnalytics.js';
import type { AnalyticsEventInput, AnalyticsStore } from './store.js';

/** Who an event is about, taken from a verified session or visitor cookie. */
export interface AnalyticsUnit {
  readonly kind: 'subject' | 'visitor';
  /** Opaque: a suite subject id or an AN2 visitor id. */
  readonly id: string;
  /** A tenant App's tenant, for a subject. */
  readonly tenantId?: string | null;
}

interface AnalyticsCounters {
  accepted: number;
  /** A name, a step, a field or a kind the declaration does not list. */
  droppedUndeclared: number;
  /** A value that looked like an email address, an IP address or a URL query. */
  droppedPersonal: number;
  /** Not a scalar, too long, or not an event at all. */
  droppedInvalid: number;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const IPV4 = /(?:^|[^\d.])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^\d.])/;
const IPV6 = /(?:^|[^\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:$|[^\w:])/i;
const QUERY = /[?&][^=\s&]+=/;
const TEMPLATE = /^\/(?:(?::[A-Za-z_][A-Za-z0-9_]*|[a-z][a-z0-9_-]*)(?:\/(?::[A-Za-z_][A-Za-z0-9_]*|[a-z][a-z0-9_-]*))*)?$/;

/** Whether a value reads as personal data the store must never hold. */
function looksPersonal(value: string): boolean {
  if (EMAIL.test(value) || IPV4.test(value) || QUERY.test(value)) return true;
  const six = IPV6.exec(value)?.[0];
  return !!six && (six.includes('::') || (six.match(/:/g) ?? []).length >= 7);
}

interface AnalyticsIngestOptions {
  readonly store: AnalyticsStore;
  readonly declaration: AnalyticsDeclaration;
  /** What the declaration's steps name: the views, forms and commands the App has. */
  readonly catalog: Pick<AnalyticsCatalog, 'views' | 'commands' | 'forms'>;
  readonly environment: string;
  readonly clock?: () => number;
}

/** One request's events at most. */
const ANALYTICS_BEACON_EVENTS = 20;

export function createAnalyticsIngest(options: AnalyticsIngestOptions) {
  const { store, declaration, catalog, environment } = options,
    clock = options.clock ?? Date.now;
  const collects = (kind: AnalyticsKind) => declaration.collect?.includes(kind) === true;
  const counters: AnalyticsCounters = { accepted: 0, droppedUndeclared: 0, droppedPersonal: 0, droppedInvalid: 0 };

  /** The declared fields of an event, each a short scalar that is not personal. */
  function fieldsOf(allowed: readonly string[], input: unknown): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    if (input === undefined || input === null) return out;
    if (typeof input !== 'object' || Array.isArray(input)) {
      counters.droppedInvalid++;
      return out;
    }
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (!allowed.includes(name)) {
        counters.droppedUndeclared++;
        continue;
      }
      if (typeof value === 'string') {
        if (value.length > ANALYTICS_LIMITS.valueLength) {
          counters.droppedInvalid++;
          continue;
        }
        if (looksPersonal(value)) {
          counters.droppedPersonal++;
          continue;
        }
        out[name] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
      else if (typeof value === 'boolean') out[name] = value;
      else counters.droppedInvalid++;
    }
    return out;
  }

  const base = (unit: AnalyticsUnit | null, occurredAt: number) => ({
    occurredAt,
    environment,
    tenantId: unit?.kind === 'subject' ? (unit.tenantId ?? null) : null,
    unitKind: unit?.kind ?? null,
    unitId: unit?.id ?? null,
  });

  /** One browser event, or nothing: the kind, name and step must be declared and collected. */
  function fromBrowser(raw: unknown, unit: AnalyticsUnit | null, now: number): AnalyticsEventInput | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      counters.droppedInvalid++;
      return undefined;
    }
    const entry = raw as Record<string, unknown>;
    const age = typeof entry.age === 'number' && Number.isFinite(entry.age) ? Math.min(Math.max(Math.trunc(entry.age), 0), 60_000) : 0;
    const when = base(unit, now - age);
    const { kind, name } = entry;
    if (typeof name !== 'string') {
      counters.droppedInvalid++;
      return undefined;
    }
    if (kind === 'view') {
      if (!collects('views') || !catalog.views.has(name)) {
        counters.droppedUndeclared++;
        return undefined;
      }
      const route = typeof entry.route === 'string' && entry.route.length <= ANALYTICS_LIMITS.valueLength ? entry.route : undefined;
      if (entry.route !== undefined && !route) counters.droppedInvalid++;
      if (route && !TEMPLATE.test(route)) {
        counters.droppedPersonal++;
        return { ...when, kind: 'view', name };
      }
      return { ...when, kind: 'view', name, fields: route ? { route } : {} };
    }
    if (kind === 'form') {
      const steps = catalog.forms.get(name);
      const step = typeof entry.step === 'string' ? entry.step : 'submit';
      if (!collects('forms') || !steps || (step !== 'submit' && !steps.includes(step))) {
        counters.droppedUndeclared++;
        return undefined;
      }
      return { ...when, kind: 'form', name, step };
    }
    if (kind === 'event') {
      const declared = declaration.events && Object.hasOwn(declaration.events, name) ? declaration.events[name] : undefined;
      if (!declared) {
        counters.droppedUndeclared++;
        return undefined;
      }
      return { ...when, kind: 'event', name, fields: fieldsOf(declared.fields ?? [], entry.fields) };
    }
    // An action or a business event is written by the server, never by a browser.
    counters.droppedUndeclared++;
    return undefined;
  }

  return Object.freeze({
    counters: (): Readonly<AnalyticsCounters> => Object.freeze({ ...counters }),

    /** A beacon's body: `{ events: [...] }`. Returns how many were stored. The unit is the caller's, from the cookie. */
    async recordBeacon(body: unknown, unit: AnalyticsUnit | null): Promise<number> {
      const list = body && typeof body === 'object' ? (body as { events?: unknown }).events : undefined;
      if (!Array.isArray(list) || list.length > ANALYTICS_BEACON_EVENTS) {
        counters.droppedInvalid++;
        return 0;
      }
      const now = clock(),
        events: AnalyticsEventInput[] = [];
      for (const raw of list) {
        const event = fromBrowser(raw, unit, now);
        if (event) events.push(event);
      }
      if (!events.length) return 0;
      const stored = await store.append(events, now);
      counters.accepted += stored;
      return stored;
    },

    /** A command's admission, from the server: the command id and whether it ran or was refused. */
    async recordAction(input: { command: string; outcome: 'ran' | 'refused'; unit: AnalyticsUnit | null }): Promise<number> {
      if (!collects('commands') || !catalog.commands.has(input.command)) return 0;
      const stored = await store.append([{ ...base(input.unit, clock()), kind: 'action', name: input.command, step: input.outcome }]);
      counters.accepted += stored;
      return stored;
    },
  });
}
export type AnalyticsIngest = ReturnType<typeof createAnalyticsIngest>;
