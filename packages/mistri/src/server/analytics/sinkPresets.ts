/**
 * Sink presets: the analytics stream delivered straight to a vendor's HTTP
 * intake — Segment, PostHog, Amplitude, GA4's Measurement Protocol — or to
 * a warehouse endpoint that takes the rows as they are. No vendor SDK: each
 * preset is a payload mapping, an address and where its key goes, sent
 * through the one egress path (address checks, no redirects, a deadline) and
 * delivered by the same position-and-retry loop as a webhook sink.
 *
 * What a vendor is sent is what the store holds, and the store holds only
 * what the declaration allowed and the request's consent let in (a Sec-GPC
 * request drops its visitor, beaconHttp.ts). Nothing here adds an address, an
 * IP or a device: an event without a unit goes as the deployment itself, and
 * the vendors' own IP geolocation is turned off where their intake says how.
 *
 * `presetRequests` is pure, so each mapping is held by a golden test.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_POLICY, request, type EgressPolicy } from '@mistriwork/engine/adapters/http/egress.js';
import type { AnalyticsSinkPreset } from './config.js';
import { ANALYTICS_BATCH_FORMAT, wire, type AnalyticsSink } from './sinkHttp.js';
import type { AnalyticsEventRow } from './store.js';

export interface PresetSinkOptions {
  readonly id: string;
  readonly batch: number;
  readonly preset: AnalyticsSinkPreset;
  /** The key itself, already read from the environment. */
  readonly key?: string;
  readonly endpoint?: string;
  readonly measurementId?: string;
  readonly format?: 'ndjson' | 'json';
  /** The deployment's name for itself (`{app}.{deployment}`): the stand-in unit, and the prefix of every message id. */
  readonly source: string;
}

interface PresetRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly text?: { readonly type: string; readonly body: string };
}

const DEFAULT_ENDPOINT: Readonly<Record<Exclude<AnalyticsSinkPreset, 'warehouse'>, string>> = {
  segment: 'https://api.segment.io/v1/batch',
  posthog: 'https://us.i.posthog.com/batch/',
  amplitude: 'https://api2.amplitude.com/batch',
  ga4: 'https://www.google-analytics.com/mp/collect',
};

/* A view, an action and a form share a name space with nothing else in a
   vendor's event list, so they carry their kind; an `event` or a `business`
   event is already the name the App gave it. */
const eventName = (row: AnalyticsEventRow): string =>
  row.kind === 'event' || row.kind === 'business' ? row.name : `${row.kind}:${row.name}`;

/* What the row says beyond its name, beside the declared fields. Prefixed, so
   a declared field called `kind` or `step` is never overwritten. */
const properties = (row: AnalyticsEventRow): Record<string, string | number | boolean> => ({
  ...row.fields,
  mistri_kind: row.kind,
  ...(row.step === null ? {} : { mistri_step: row.step }),
  mistri_environment: row.environment,
  ...(row.tenantId === null ? {} : { mistri_tenant: row.tenantId }),
});

const messageId = (source: string, row: AnalyticsEventRow): string => `${source}:${row.id}`;

/** A UUID that is the same for the same row every time, so a resent batch is the same events (PostHog dedupes on it). */
function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '8'; // version 8: a custom, name-derived UUID
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // the RFC 9562 variant
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/* GA4's names are letters, digits and underscores, start with a letter, and
   run to 40 characters; its parameter values to 100. */
const ga4Name = (value: string): string => {
  const name = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return (name || 'event').slice(0, 40);
};
const ga4Params = (values: Record<string, string | number | boolean>): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values).slice(0, 25))
    params[ga4Name(key)] = typeof value === 'string' ? value.slice(0, 100) : typeof value === 'boolean' ? String(value) : value;
  return params;
};

/** The requests one batch is, for one preset. GA4 takes one client per request, so its batch may be several. */
export function presetRequests(options: PresetSinkOptions, events: readonly AnalyticsEventRow[], idempotencyKey: string): PresetRequest[] {
  const url = new URL(options.endpoint ?? (options.preset === 'warehouse' ? '' : DEFAULT_ENDPOINT[options.preset]));
  const keyed = { 'idempotency-key': idempotencyKey };
  const at = (row: AnalyticsEventRow) => new Date(row.occurredAt).toISOString();
  switch (options.preset) {
    case 'segment':
      return [
        {
          url,
          headers: { ...keyed, authorization: `Basic ${Buffer.from(`${options.key ?? ''}:`).toString('base64')}` },
          body: {
            batch: events.map((row) => ({
              type: row.kind === 'view' ? 'page' : 'track',
              ...(row.kind === 'view' ? { name: row.name } : { event: eventName(row) }),
              ...(row.unitKind === 'subject' && row.unitId ? { userId: row.unitId } : { anonymousId: row.unitId ?? options.source }),
              messageId: messageId(options.source, row),
              timestamp: at(row),
              properties: properties(row),
              // Segment fills an IP from the request when none is given: this one is the server's, so none is sent.
              context: { library: { name: 'mistri' }, ip: '0.0.0.0' },
            })),
          },
        },
      ];
    case 'posthog':
      return [
        {
          url,
          headers: keyed,
          body: {
            api_key: options.key,
            batch: events.map((row) => ({
              event: row.kind === 'view' ? '$pageview' : eventName(row),
              distinct_id: row.unitId ?? options.source,
              timestamp: at(row),
              uuid: stableUuid(messageId(options.source, row)),
              properties: {
                ...properties(row),
                ...(row.kind === 'view' ? { $screen_name: row.name } : {}),
                $geoip_disable: true,
                // No unit is no person: PostHog would otherwise make one profile for the whole deployment.
                ...(row.unitId ? {} : { $process_person_profile: false }),
              },
            })),
          },
        },
      ];
    case 'amplitude':
      return [
        {
          url,
          headers: keyed,
          body: {
            api_key: options.key,
            events: events.map((row) => ({
              event_type: eventName(row),
              ...(row.unitKind === 'subject' && row.unitId ? { user_id: row.unitId } : { device_id: row.unitId ?? options.source }),
              time: row.occurredAt,
              insert_id: messageId(options.source, row),
              event_properties: properties(row),
            })),
            // Amplitude refuses ids under five characters by default; ours are opaque and may be short.
            options: { min_id_length: 1 },
          },
        },
      ];
    case 'ga4': {
      url.searchParams.set('measurement_id', options.measurementId ?? '');
      url.searchParams.set('api_secret', options.key ?? '');
      const clients = new Map<string, AnalyticsEventRow[]>();
      for (const row of events) {
        const client = row.unitId ?? options.source;
        clients.set(client, [...(clients.get(client) ?? []), row]);
      }
      return [...clients].map(([client, rows]) => ({
        url,
        headers: keyed,
        body: {
          client_id: client,
          ...(rows[0].unitKind === 'subject' && rows[0].unitId ? { user_id: rows[0].unitId } : {}),
          events: rows.map((row) => ({
            name: row.kind === 'view' ? 'page_view' : ga4Name(eventName(row)),
            timestamp_micros: row.occurredAt * 1000,
            params: { ...ga4Params(properties(row)), ...(row.kind === 'view' ? { page_title: row.name.slice(0, 100) } : {}) },
          })),
        },
      }));
    }
    case 'warehouse': {
      const headers = { ...keyed, ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) };
      return options.format === 'json'
        ? [{ url, headers, body: { format: ANALYTICS_BATCH_FORMAT, events: events.map(wire) } }]
        : [{ url, headers, text: { type: 'application/x-ndjson', body: events.map((row) => `${JSON.stringify(wire(row))}\n`).join('') } }];
    }
  }
}

/** A preset sink: every request of the batch 2xx is accepted, any final 4xx is rejected, anything else is asked again. */
export function createPresetAnalyticsSink(options: PresetSinkOptions & { resolver?: EgressPolicy['resolver'] }): AnalyticsSink {
  const endpoint = new URL(options.endpoint ?? (options.preset === 'warehouse' ? '' : DEFAULT_ENDPOINT[options.preset]));
  // The webhook's policy: plain http only where the config's own check let it through (this machine), never link-local.
  const policy: EgressPolicy = {
    ...DEFAULT_POLICY,
    insecure: endpoint.protocol === 'http:',
    allowLinkLocal: false,
    timeoutMs: 10_000,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  };
  return Object.freeze({
    id: options.id,
    batch: options.batch,
    async send(events: readonly AnalyticsEventRow[], { idempotencyKey }: { readonly idempotencyKey: string }) {
      let rejected = false;
      for (const each of presetRequests(options, events, idempotencyKey)) {
        const reply = await request(
          each.url,
          {
            method: 'POST',
            headers: { ...each.headers },
            ...(each.text ? { text: each.text } : { body: each.body }),
            discard: true,
            kind: 'analytics',
          },
          policy,
        );
        if (reply.status >= 200 && reply.status < 300) continue;
        if (reply.status >= 400 && reply.status < 500 && reply.status !== 408 && reply.status !== 429) rejected = true;
        else throw new Error(`The analytics sink "${options.id}" (${options.preset}) answered ${reply.status}.`);
      }
      return rejected ? 'rejected' : 'accepted';
    },
  });
}
