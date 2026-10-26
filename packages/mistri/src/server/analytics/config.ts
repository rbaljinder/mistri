/**
 * The analytics binding, which is configuration and never part of an App:
 * `"analytics": { "store": "<postgres url | sqlite path>", "sinks": [...] }`
 * beside the connections of a config file, or in `suite.json`. The App's own
 * `analytics` declaration names what to collect; this says where it goes.
 */
import { dirname, isAbsolute, resolve } from 'node:path';

/** A vendor the sink speaks to directly, its payload mapped in sinkPresets.ts; `warehouse` is any endpoint taking the rows as they are. */
export type AnalyticsSinkPreset = 'segment' | 'posthog' | 'amplitude' | 'ga4' | 'warehouse';
const ANALYTICS_SINK_PRESETS: readonly AnalyticsSinkPreset[] = ['segment', 'posthog', 'amplitude', 'ga4', 'warehouse'];

interface AnalyticsSinkConfig {
  readonly id: string;
  readonly kind: 'http';
  /** An existing `kind: "webhook"` connection: its https, auth and address rules are the sink's. Never beside a preset. */
  readonly connection?: string;
  readonly batch: number;
  readonly preset?: AnalyticsSinkPreset;
  /** A preset's key, always a `${VARIABLE}` reference: the secret is the environment's, never the file's. */
  readonly key?: string;
  /** A preset's address in place of the vendor's own (a region, a proxy); the warehouse's, which has none. */
  readonly endpoint?: string;
  /** GA4's measurement id (`G-…`), which is not a secret. */
  readonly measurementId?: string;
  /** The warehouse's body: one row per line (`ndjson`, the default) or the batch as one JSON document. */
  readonly format?: 'ndjson' | 'json';
}
export interface AnalyticsConfiguration {
  readonly store: string;
  /** Which App the store belongs to; omitted, the only App of the suite. */
  readonly app?: string;
  readonly deploymentId: string;
  readonly sinks: readonly AnalyticsSinkConfig[];
}

const ANALYTICS_SINK_BATCH = Object.freeze({ default: 500, max: 1000 });
/* What one request may carry at each vendor: GA4's Measurement Protocol takes 25
   events, Segment's batch 500 KB (an event here is at most a few KB). */
const PRESET_BATCH: Readonly<Record<AnalyticsSinkPreset, number>> = {
  segment: 100,
  posthog: 1000,
  amplitude: 1000,
  ga4: 25,
  warehouse: 1000,
};
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VARIABLE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const MEASUREMENT = /^G-[A-Z0-9]{4,20}$/;

/** Checked configuration, or a sentence naming `where`. A relative SQLite path is read against the file that holds it. */
export function parseAnalyticsConfiguration(input: unknown, where: string, file?: string): AnalyticsConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${where} must be an object.`);
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!['store', 'app', 'deploymentId', 'sinks'].includes(key)) throw new Error(`${where}: unsupported field "${key}".`);
  if (typeof raw.store !== 'string' || !raw.store.trim() || raw.store !== raw.store.trim() || raw.store.length > 8192) {
    throw new Error(`${where} needs a "store": a PostgreSQL URL or a SQLite file path.`);
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.store);
  if (url && !/^postgres(ql)?:\/\//i.test(raw.store)) throw new Error(`${where}: "store" is a PostgreSQL URL or a SQLite file path.`);
  const store = url || isAbsolute(raw.store) || !file ? raw.store : resolve(dirname(resolve(file)), raw.store);
  const named = (value: unknown, label: string) => {
    if (typeof value !== 'string' || !ID.test(value))
      throw new Error(`${where}: "${label}" is a name of letters, digits, "_", "." and "-".`);
    return value;
  };
  const app = raw.app === undefined ? undefined : named(raw.app, 'app');
  const deploymentId = raw.deploymentId === undefined ? 'default' : named(raw.deploymentId, 'deploymentId');
  const sinks: AnalyticsSinkConfig[] = [];
  if (raw.sinks !== undefined) {
    if (!Array.isArray(raw.sinks) || raw.sinks.length > 8) throw new Error(`${where}: "sinks" is a list of at most 8 sinks.`);
    for (const [index, entry] of raw.sinks.entries()) {
      const here = `${where}: sink ${index + 1}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${here} must be an object.`);
      for (const key of Object.keys(entry))
        if (!['id', 'kind', 'connection', 'batch', 'preset', 'key', 'endpoint', 'measurementId', 'format'].includes(key))
          throw new Error(`${here}: unsupported field "${key}".`);
      const sink = entry as Record<string, unknown>;
      if (sink.kind !== 'http') throw new Error(`${here}: "kind" is "http".`);
      const preset = sink.preset;
      if (preset !== undefined && !(ANALYTICS_SINK_PRESETS as readonly unknown[]).includes(preset))
        throw new Error(`${here}: "preset" is one of ${ANALYTICS_SINK_PRESETS.map((name) => `"${name}"`).join(', ')}.`);
      const most = preset === undefined ? ANALYTICS_SINK_BATCH.max : PRESET_BATCH[preset as AnalyticsSinkPreset];
      const batch = sink.batch === undefined ? Math.min(ANALYTICS_SINK_BATCH.default, most) : sink.batch;
      if (typeof batch !== 'number' || !Number.isInteger(batch) || batch < 1 || batch > most) {
        throw new Error(`${here}: "batch" is a whole number from 1 to ${most}${preset === undefined ? '' : ` for ${preset as string}`}.`);
      }
      const id = named(sink.id, 'id');
      if (sinks.some((each) => each.id === id)) throw new Error(`${here}: sink id "${id}" is used twice.`);
      if (preset === undefined) {
        for (const key of ['key', 'endpoint', 'measurementId', 'format'])
          if (sink[key] !== undefined) throw new Error(`${here}: "${key}" belongs to a "preset".`);
        sinks.push(Object.freeze({ id, kind: 'http', connection: named(sink.connection, 'connection'), batch }));
        continue;
      }
      // A preset is its own transport: the vendor's address and the key's place in the request are the preset's.
      if (sink.connection !== undefined) throw new Error(`${here}: a "preset" sink posts to its vendor itself; drop "connection".`);
      if (sink.key !== undefined && (typeof sink.key !== 'string' || !VARIABLE.test(sink.key)))
        throw new Error(`${here}: "key" is a \${VARIABLE} reference, never the key itself.`);
      if (sink.key === undefined && preset !== 'warehouse')
        throw new Error(`${here}: "${preset as string}" needs a "key", as a \${VARIABLE} reference.`);
      if (sink.endpoint !== undefined) presetEndpoint(sink.endpoint, here);
      if (sink.endpoint === undefined && preset === 'warehouse') throw new Error(`${here}: "warehouse" needs an "endpoint".`);
      if (
        (sink.measurementId !== undefined) !== (preset === 'ga4') ||
        (preset === 'ga4' && (typeof sink.measurementId !== 'string' || !MEASUREMENT.test(sink.measurementId)))
      )
        throw new Error(`${here}: "measurementId" is GA4's own, a "G-…" id, and only GA4's.`);
      if (sink.format !== undefined && (preset !== 'warehouse' || (sink.format !== 'ndjson' && sink.format !== 'json')))
        throw new Error(`${here}: "format" is the warehouse's, "ndjson" or "json".`);
      sinks.push(
        Object.freeze({
          id,
          kind: 'http' as const,
          batch,
          preset: preset as AnalyticsSinkPreset,
          ...(sink.key === undefined ? {} : { key: sink.key as string }),
          ...(sink.endpoint === undefined ? {} : { endpoint: sink.endpoint as string }),
          ...(preset === 'ga4' ? { measurementId: sink.measurementId as string } : {}),
          ...(preset === 'warehouse' ? { format: (sink.format ?? 'ndjson') as 'ndjson' | 'json' } : {}),
        }),
      );
    }
  }
  return Object.freeze({ store, ...(app ? { app } : {}), deploymentId, sinks: Object.freeze(sinks) });
}

/** A preset's address: https, or http to this machine (a local receiver, a test); no credential, query or fragment, which the preset adds itself. */
function presetEndpoint(value: unknown, where: string): URL {
  let url: URL | undefined;
  try {
    url = typeof value === 'string' && value.length <= 2048 ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  const loopback =
    url && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname));
  if (
    !url ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${where}: "endpoint" is an https URL with no credential, query or fragment (plain http reaches only this machine).`);
  return url;
}
