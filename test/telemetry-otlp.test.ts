/*
 * OpenTelemetry with nothing but the standard variables: a local OTLP/HTTP
 * receiver stands in for the Collector, Datadog's Agent or Dynatrace, and a
 * command's round trip through the real HTTP server has to arrive there as
 * spans, logs and metrics that follow the semantic conventions — and carry
 * none of the secrets the round trip was seeded with: not a header's token,
 * a cookie, a parameter, a row value, an input, an email or a refusal's
 * reason. Both encodings OTLP/HTTP speaks are read back: JSON as JSON, and
 * protobuf through a wire decoder written here, independent of the encoder.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { startTelemetry } from '../packages/engine/src/adapters/telemetry/start.js';
import { summarizeStatement } from '../packages/engine/src/adapters/telemetry/statement.js';
import { parseTraceparent } from '../packages/engine/src/adapters/telemetry/trace.js';
import { parseTestApp } from './support/commandCatalog.js';

const SECRETS = [
  'SEKRET-TOKEN-123',
  'SEKRET-COOKIE-456',
  'SEKRET-PARAM-321',
  'SEKRET-ROW-789',
  'owner@secret.example',
  'SEKRET-REFUSAL-555',
  'SEKRET-IDEMPOTENCY-777',
];

interface Received {
  path: string;
  type: string;
  body: Buffer;
}

async function receiver() {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
      received.push({ path: req.url ?? '', type: String(req.headers['content-type']), body });
      // The configured header arrives: how Dynatrace's Api-Token and Datadog's API key are sent.
      assert.equal(req.headers['x-collector-key'], 'k=v');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { received, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function commandServer(run: (base: string, control: { fail?: string }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-otlp-'));
  const file = join(directory, 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, note TEXT, owner TEXT);
    INSERT INTO loan VALUES (1, 0, 'SEKRET-ROW-789', 'owner@secret.example');`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'db', name: 'db', url: file, writable: true, source: 'config' });
  const input = { note: { label: 'Note', type: 'text' } } as const;
  const app = parseTestApp(
    {
      id: 'loans',
      name: 'Loans',
      sources: { lending: { connection: 'db' } },
      resources: {
        loan: {
          access: 'write',
          actions: { annotate: { label: 'Annotate', command: { id: 'annotate', version: 1, target: 'loan', input } } },
        },
      },
      auth: { roles: { manager: { read: true, commands: ['annotate'] } } },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
    },
    'otlp fixture',
  );
  const control: { fail?: string } = {};
  const account: Identity = { id: 'account-a', who: 'owner@secret.example', role: 'manager' };
  const commands = defineCommands({
    annotate: defineCommand({
      source: 'lending',
      target: 'loan',
      input,
      validate(value): { note: string } {
        return { note: String(value.note) };
      },
      output: {
        parse(value: unknown) {
          return value as { version: number };
        },
      },
      async handle({ db: tx, record }, value) {
        if (control.fail) refuse(control.fail);
        // The App's own console line, inside the command: kept locally, never exported.
        console.log(`annotating with ${value.note}`);
        const { version } = await tx.loan.update(record, { note: value.note });
        return { version: Number(version) };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => account,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'loans', registry: commands }, ready: () => true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${bound.port}`, control);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const execute = (base: string, note: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/commands/execute`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer SEKRET-TOKEN-123',
      cookie: 'session=SEKRET-COOKIE-456',
      ...extra,
    },
    body: JSON.stringify({
      command: 'annotate',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'SEKRET-IDEMPOTENCY-777',
      input: { note: note },
    }),
  });

type Attr = { key: string; value: Record<string, unknown> };
const attr = (attributes: Attr[] | undefined, key: string) => {
  const value = attributes?.find((each) => each.key === key)?.value;
  return value ? Object.values(value)[0] : undefined;
};

test(
  'a command round trip arrives as conventional spans, logs and metrics over OTLP/HTTP JSON, with nothing private in them',
  { timeout: 20_000 },
  async () => {
    const collector = await receiver();
    const telemetry = await startTelemetry(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=k%3Dv',
        OTEL_SERVICE_NAME: 'loans-test',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=test',
        OTEL_METRIC_EXPORT_INTERVAL: '600000',
      },
      '9.9.9',
      () => {},
    );
    try {
      const parent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      await commandServer(async (base, control) => {
        const applied = await execute(base, 'SEKRET-PARAM-321', { traceparent: parent });
        assert.equal(applied.status, 200, await applied.clone().text());
        // The response carries no trace id outside dev: the header is the observer's.
        assert.equal(applied.headers.get('x-mistri-trace'), null);
        control.fail = 'SEKRET-REFUSAL-555';
        const refused = await execute(base, 'another note');
        assert.equal(refused.status >= 400, true);
        // The probes answer, and are not traced.
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { status: 'ok', deploy: null, build: null });
      });
      await telemetry.flush();
    } finally {
      await telemetry.shutdown();
      await collector.close();
    }
    const everything = collector.received.map((each) => each.body.toString('utf8')).join('\n');
    for (const secret of SECRETS) assert.ok(!everything.includes(secret), `${secret} reached the collector`);
    // No SQL text either: only its kind and table.
    assert.doesNotMatch(everything, /UPDATE\s+"?loan"?\s+SET/i);

    const traces = collector.received.filter((each) => each.path === '/v1/traces').map((each) => JSON.parse(each.body.toString()));
    assert.ok(traces.length, 'no traces arrived');
    assert.ok(collector.received.every((each) => each.type === 'application/json'));
    const resource = traces[0].resourceSpans[0].resource.attributes as Attr[];
    assert.equal(attr(resource, 'service.name'), 'loans-test');
    assert.equal(attr(resource, 'service.version'), '9.9.9');
    assert.equal(attr(resource, 'deployment.environment.name'), 'test');
    const spans = traces.flatMap((t) => t.resourceSpans[0].scopeSpans[0].spans) as Array<{
      name: string;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      kind: number;
      attributes: Attr[];
      status: { code?: number; message?: string };
    }>;

    const server = spans.filter((span) => span.name === 'POST /api/commands/execute');
    assert.equal(server.length, 2);
    // W3C trace context in: the first request continues its caller's trace.
    assert.equal(server[0].traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(server[0].parentSpanId, 'b7ad6b7169203331');
    assert.equal(server[0].kind, 2);
    assert.equal(attr(server[0].attributes, 'http.route'), '/api/commands/execute');
    assert.equal(attr(server[0].attributes, 'http.request.method'), 'POST');
    assert.equal(attr(server[0].attributes, 'http.response.status_code'), '200');

    const commands = spans.filter((span) => attr(span.attributes, 'mistri.command.id') === 'annotate');
    assert.equal(commands.length, 2);
    assert.equal(attr(commands[0].attributes, 'mistri.command.outcome'), 'applied');
    assert.equal(commands[0].parentSpanId, server[0].spanId);
    const refusedCommand = commands[1];
    assert.equal(refusedCommand.status.code, 2);
    assert.equal(attr(refusedCommand.attributes, 'mistri.command.outcome'), 'not_applied');
    assert.ok(typeof attr(refusedCommand.attributes, 'mistri.refusal.code') === 'string');

    const statements = spans.filter((span) => attr(span.attributes, 'db.system.name') === 'sqlite');
    assert.ok(
      statements.some(
        (span) =>
          span.name === 'UPDATE loan' &&
          attr(span.attributes, 'db.operation.name') === 'UPDATE' &&
          attr(span.attributes, 'db.collection.name') === 'loan',
      ),
      `no UPDATE loan span in ${statements.map((span) => span.name).join(', ')}`,
    );
    assert.ok(statements.every((span) => span.traceId === server[0].traceId || span.traceId === server[1].traceId));
    assert.ok(statements.every((span) => !span.attributes.some((each) => each.key === 'db.query.text')));

    // Logs: structured, correlated, and only the travelling kind — the App's own console line is local only.
    const logs = collector.received
      .filter((each) => each.path === '/v1/logs')
      .flatMap((each) => JSON.parse(each.body.toString()).resourceLogs[0].scopeLogs[0].logRecords) as Array<{
      body: { stringValue: string };
      traceId?: string;
      spanId?: string;
      severityText: string;
      attributes: Attr[];
    }>;
    const refusal = logs.find((line) => attr(line.attributes, 'log.source') === 'refusal');
    assert.ok(refusal, 'the refusal was not logged');
    assert.equal(refusal!.traceId, server[1].traceId);
    assert.ok(!logs.some((line) => /annotating/.test(line.body.stringValue)), 'an App console line was exported');

    // Metrics, read from the same spans on flush.
    const metrics = collector.received
      .filter((each) => each.path === '/v1/metrics')
      .flatMap((each) => JSON.parse(each.body.toString()).resourceMetrics[0].scopeMetrics[0].metrics) as Array<{ name: string }>;
    for (const name of ['http.server.request.duration', 'mistri.command.executions', 'db.client.operation.duration']) {
      assert.ok(
        metrics.some((metric) => metric.name === name),
        `no ${name} metric`,
      );
    }
  },
);

/* ---------- protobuf, read with a decoder of its own ---------- */

type Field = { field: number; wire: number; value: bigint | Buffer };
function decode(buffer: Buffer): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = () => {
    let result = 0n,
      shift = 0n;
    for (;;) {
      const byte = buffer[at++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  while (at < buffer.length) {
    const tag = Number(varint());
    const field = tag >> 3,
      wire = tag & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 1) {
      out.push({ field, wire, value: buffer.subarray(at, at + 8) });
      at += 8;
    } else if (wire === 5) {
      out.push({ field, wire, value: buffer.subarray(at, at + 4) });
      at += 4;
    } else if (wire === 2) {
      const length = Number(varint());
      out.push({ field, wire, value: buffer.subarray(at, at + length) });
      at += length;
    } else throw new Error(`wire type ${wire}`);
  }
  return out;
}
const sub = (fields: Field[], n: number) => fields.filter((each) => each.field === n).map((each) => decode(each.value as Buffer));
const text = (fields: Field[], n: number) => (fields.find((each) => each.field === n)?.value as Buffer | undefined)?.toString('utf8');

test(
  'the default encoding is OTLP protobuf, gzip when asked, and decodes to the same conventional spans',
  { timeout: 20_000 },
  async () => {
    const collector = await receiver();
    const telemetry = await startTelemetry(
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/custom/traces`,
        OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=k%3Dv',
        OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_METRICS_EXPORTER: 'none',
      },
      '9.9.9',
      () => {},
    );
    try {
      await commandServer(async (base) => {
        assert.equal((await execute(base, 'SEKRET-PARAM-321')).status, 200);
      });
      await telemetry.flush();
    } finally {
      await telemetry.shutdown();
      await collector.close();
    }
    // A signal's own endpoint is used as given; the others were switched off.
    assert.ok(collector.received.length > 0);
    assert.ok(collector.received.every((each) => each.path === '/custom/traces' && each.type === 'application/x-protobuf'));
    const names: string[] = [];
    for (const each of collector.received) {
      for (const secret of SECRETS) assert.ok(!each.body.includes(secret), `${secret} reached the collector`);
      for (const resourceSpans of sub(decode(each.body), 1)) {
        const resource = sub(resourceSpans, 1)[0];
        const service = sub(resource, 1).find((kv) => text(kv, 1) === 'service.name');
        assert.equal(text(sub(service!, 2)[0], 1), 'mistri');
        for (const scope of sub(resourceSpans, 2))
          for (const span of sub(scope, 2)) {
            assert.equal((span.find((f) => f.field === 1)!.value as Buffer).length, 16, 'trace id is 16 bytes');
            assert.equal((span.find((f) => f.field === 2)!.value as Buffer).length, 8, 'span id is 8 bytes');
            names.push(text(span, 5)!);
          }
      }
    }
    assert.ok(names.includes('POST /api/commands/execute'), names.join(', '));
    assert.ok(names.includes('command annotate'));
    assert.ok(names.includes('UPDATE loan'));
  },
);

test('nothing is started or said when OTEL_* is unset or the SDK is disabled', async () => {
  const none = await startTelemetry({}, '1', () => assert.fail('said something with nothing set'));
  await none.flush();
  const disabled = await startTelemetry({ OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' }, '1', () =>
    assert.fail('disabled SDK spoke'),
  );
  await disabled.shutdown();
});

test('statements are summarized by kind and table, and trace context is read strictly', () => {
  assert.deepEqual(summarizeStatement('SELECT "a"."x" FROM "public"."orders" o WHERE o.id = $1'), {
    operation: 'SELECT',
    table: 'orders',
    summary: 'SELECT orders',
  });
  assert.deepEqual(summarizeStatement("insert into `lead` (name) values ('FROM secret')"), {
    operation: 'INSERT',
    table: 'lead',
    summary: 'INSERT lead',
  });
  assert.deepEqual(summarizeStatement('UPDATE loan SET note = ? WHERE id = ?'), {
    operation: 'UPDATE',
    table: 'loan',
    summary: 'UPDATE loan',
  });
  assert.deepEqual(summarizeStatement('WITH x AS (SELECT 1) SELECT * FROM y'), { operation: 'SELECT', table: 'y', summary: 'SELECT y' });
  assert.deepEqual(summarizeStatement('BEGIN IMMEDIATE'), { operation: 'BEGIN', summary: 'BEGIN' });
  assert.equal(summarizeStatement('-- a comment\nSELECT 1').operation, 'SELECT');
  assert.equal(summarizeStatement('frobnicate everything').summary, 'OTHER');
  assert.deepEqual(parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'vendor=1'), {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    sampled: true,
    traceState: 'vendor=1',
  });
  for (const bad of [
    '',
    'garbage',
    '00-00000000000000000000000000000000-b7ad6b7169203331-01',
    'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  ]) {
    assert.equal(parseTraceparent(bad), undefined, bad);
  }
});
