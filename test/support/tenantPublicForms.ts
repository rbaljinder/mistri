/**
 * A tenant App's public forms over the dedicated tenant host, with genuine native auth, on SQLite or on PostgreSQL
 * (a database the suite owns, beside TABLEWALK_TEST_PG): two dealers, north and south, each with an intake address
 * (`?via=`) and a public address, a stock form (`apply`), a form saved on each step (`draft`), and a form whose choice
 * reads a tenant-owned table (`quote`, its `make` field from `make`). Unplaced submissions land in the platform's
 * `intake_submission`.
 *
 * Options turn on what a suite is about: the App's human check (`auth.challenge`, a Turnstile verifier pointed at the
 * local stand-in) and public reads of `make` (`auth.public`), which the quote form's choices are read under.
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { LoadedApp } from '../../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { defineChallenges, type HumanCheck } from '../../packages/mistri/src/server/commands/challenges.js';
import { literal, shape, text } from '../../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../../packages/engine/src/server/http/rateLimit.js';
import { createTenantHostRouter } from '../../packages/mistri/src/server/http/tenantHosts.js';
import { defineAppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { parseTrustedProxies } from '../../packages/engine/src/server/http/trust.js';
import { provisionPostgresLiveChange } from '../../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { provisionSqliteLiveChange } from '../../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { parseTestApp } from './commandCatalog.js';
import { openTenantEngine, type TenantDialect, type TenantEngine } from './tenantDialects.js';

export const APP_ID = 'yard';
export const binding = { appId: APP_ID, source: { id: 'business', connection: 'yard-db' }, storeId: 'yard-public-forms' };
export const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-intake-CCCCCCCCCCCCCCCC',
  UNKNOWN = 'unknown-intake-FFFFFFFFFFFFFF',
  NORTH_PUBLIC = 'north-public-AAAAAAAAAAAAAAAA',
  SOUTH_PUBLIC = 'south-public-CCCCCCCCCCCCCCCC';
/** The mapped host the operator gives north (tenantHosts.ts). */
export const NORTH_HOST = 'north.example.test';
export const via = (address: string) => `?via=${encodeURIComponent(address)}`;

const draftColumns = 'more TEXT, status TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT';
const SQLITE = `PRAGMA foreign_keys = ON;
  CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT, public_address TEXT);
  CREATE TABLE make (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
  CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL,
    name TEXT NOT NULL, make_id TEXT, ${draftColumns});
  CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL, make_id TEXT, ${draftColumns});
  INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}', '${NORTH_PUBLIC}'), ('south', 'South Wheels', '${SOUTH}', '${SOUTH_PUBLIC}');
  INSERT INTO make VALUES ('n-ford', 'north', 'Ford'), ('n-kia', 'north', 'Kia'), ('s-fiat', 'south', 'Fiat');`;
const POSTGRES = `
  CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text, public_address text);
  CREATE TABLE public.make (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL);
  CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), reference text NOT NULL,
    name text NOT NULL, make_id text, ${draftColumns.replaceAll('TEXT', 'text')});
  CREATE TABLE public.intake_submission (id text PRIMARY KEY, reference text NOT NULL, name text NOT NULL, make_id text,
    ${draftColumns.replaceAll('TEXT', 'text')});
  INSERT INTO public.dealer VALUES ('north', 'North Motors', '${NORTH}', '${NORTH_PUBLIC}'), ('south', 'South Wheels', '${SOUTH}', '${SOUTH_PUBLIC}');
  INSERT INTO public.make VALUES ('n-ford', 'north', 'Ford'), ('n-kia', 'north', 'Kia'), ('s-fiat', 'south', 'Fiat');`;

const input = { name: { label: 'Name', type: 'text', max: 80 } } as const;
const quoteInput = {
  name: { label: 'Name', type: 'text', max: 80 },
  make: { label: 'Make', type: 'choice', from: 'make', labelColumn: 'name' },
} as const;

export interface TenantPublicFormOptions {
  /** The App names a human check: `auth.challenge` names this verifier (a Turnstile one at the stand-in). */
  readonly challenge?: HumanCheck;
  /** The App opens `make` to the public (`auth.public`), under each dealer's public address, and serves the quote form,
      whose choice reads it; live sync's change store is provisioned, so each dealer's choices are kept until a row of
      theirs changes. The App does not ask for live sync. */
  readonly publicReads?: true;
  /** `--trust-proxy`: the ranges whose X-Forwarded-For names a visitor on the public doors. */
  readonly trustedProxies?: readonly string[];
}

export interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly body: any;
}

export interface TenantPublicForms {
  readonly engine: TenantEngine;
  readonly origin: string;
  readonly port: number;
  /** A request to the host, as a browser on `host` makes it (its Origin that host's). */
  /** `chunked` sends the body with no length; `trickle` sends it so, a byte every half second, until it is answered. */
  call(
    path: string,
    init?: { body?: unknown; headers?: Record<string, string>; host?: string; chunked?: true; trickle?: true },
  ): Promise<Answer>;
  /** Rows on the control connection, never the host's. */
  rows(sql: string): Promise<Record<string, unknown>[]>;
}

/** The suite's own PostgreSQL database: a suffix ending in a UUID, dropped by the suite when it ends. */
export const publicFormsDatabase = () => `tenant_public_forms_${randomUUID().replaceAll('-', '')}`;

async function portFor() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function openTenantPublicForms(
  t: TestContext,
  dialect: TenantDialect,
  database: string,
  options: TenantPublicFormOptions = {},
): Promise<TenantPublicForms> {
  resetPublicFormLimits();
  const engine = await openTenantEngine(dialect, { sqlite: SQLITE, postgres: POSTGRES, tables: ['make'], database });
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-public-forms-'));
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  const front = createServer();
  t.after(async () => {
    try {
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      owner?.server.closeAllConnections();
      await owner?.retire();
    } finally {
      auth?.close();
      await engine.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  if (options.publicReads) {
    if (engine.dialect === 'sqlite') provisionSqliteLiveChange(engine.path);
    else await provisionPostgresLiveChange(engine.url);
  }
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  const port = await portFor(),
    origin = `http://127.0.0.1:${port}`;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseTestApp(
      {
        id: APP_ID,
        name: 'Yard',
        sources: { business: { connection: binding.source.connection } },
        resources: {
          dealer: { owner: 'platform' },
          make: { owner: 'tenant', access: 'write' },
          lead: { access: 'write', owner: 'tenant' },
          intake_submission: { access: 'write', owner: 'platform' },
        },
        auth: {
          store: join(directory, 'auth.db'),
          signUp: 'open',
          rows: 'tenant',
          tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
          roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
          ...(options.challenge ? { challenge: 'verifyHuman' } : {}),
          ...(options.publicReads ? { public: { read: ['make'] } } : {}),
        },
        views: {
          leads: { kind: 'list', from: 'lead' },
          triage: { kind: 'list', from: 'intake_submission' },
          apply: { kind: 'form', label: 'Apply for financing', public: true, command: { id: 'apply', version: 1, input } },
          // Its choices are read signed out, so it needs `make` open to the public.
          ...(options.publicReads
            ? {
                quote: { kind: 'form', label: 'Ask for a quote', public: true, command: { id: 'quote', version: 1, input: quoteInput } },
                // A visitor names a make the dealer lacks: a write to a choice table through the deployment's writer.
                suggest: { kind: 'form', label: 'Suggest a make', public: true, command: { id: 'suggest', version: 1, input } },
              }
            : {}),
          draft: {
            kind: 'form',
            label: 'Apply in steps',
            public: true,
            resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
            draft: { status: 'draft' },
            steps: [{ id: 'name', label: 'Name', command: { id: 'draftName', version: 1, input } }],
            command: { id: 'draftSubmit', version: 1, input: { note: { label: 'Note', type: 'text', max: 80, optional: true } } },
          },
        },
        nav: [
          { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
          { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
        ],
        home: [{ view: 'apply', signedOut: true }, { view: 'leads' }],
      },
      'tenant public forms fixture',
    ),
    ...(options.challenge ? { challenges: defineChallenges({ verifyHuman: options.challenge }) } : {}),
  };
  const places = ['lead', 'intake_submission'];
  const root = (intake: unknown) => (intake === 'tenant' ? 'lead' : 'intake_submission');
  const received = shape({ reference: text(), message: literal('Application received.') });
  const registry = defineCommands({
    apply: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      public: true,
      input,
      output: received,
      async handle({ db, intake }, value) {
        const reference = `YRD-${value.name}`;
        if (intake === 'tenant') await db.lead.insert({ id: randomUUID(), reference, name: value.name });
        else await db.intake_submission.insert({ id: randomUUID(), reference, name: value.name });
        return { reference, message: 'Application received.' as const };
      },
    }),
    quote: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      read: ['make'],
      public: true,
      input: quoteInput,
      output: received,
      async handle({ db, intake }, value) {
        const reference = `YRD-Q-${value.name}`;
        const row = { id: randomUUID(), reference, name: value.name, make_id: String(value.make) };
        if (intake === 'tenant') await db.lead.insert(row);
        else await db.intake_submission.insert(row);
        return { reference, message: 'Application received.' as const };
      },
    }),
    suggest: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'make',
      write: ['make'],
      public: true,
      input,
      output: received,
      async handle({ db, intake }, value) {
        if (intake === 'tenant') await db.make.insert({ id: `x-${value.name.toLowerCase()}`, name: value.name });
        return { reference: `YRD-S-${value.name}`, message: 'Application received.' as const };
      },
    }),
    draftName: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      read: places,
      public: true,
      input,
      output: shape({ message: literal('Saved.') }),
      async handle({ tx, draft, intake }, value) {
        if (draft!.root) await tx.update({ table: root(intake), key: { ...draft!.root }, values: { name: value.name } });
        else
          await tx.insert({
            table: root(intake),
            values: { id: randomUUID(), reference: `YRD-D-${randomUUID().slice(0, 8)}`, name: value.name, ...draft!.start },
          });
        return { message: 'Saved.' as const };
      },
    }),
    draftSubmit: defineCommand({
      targets: 'none',
      source: 'business',
      target: 'lead',
      write: places,
      read: places,
      public: true,
      input: { note: { label: 'Note', type: 'text', max: 80, optional: true } },
      output: received,
      async handle({ tx, draft, intake }) {
        const [row] = (await tx.query({ table: root(intake), columns: ['reference'], limit: 1, offset: 0 })).rows;
        await tx.update({ table: root(intake), key: { ...draft!.root! }, values: { status: 'submitted' } });
        return { reference: String(row.reference), message: 'Application received.' as const };
      },
    }),
  });
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.BETTER_AUTH_SECRET = 'synthetic-public-forms-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin, `http://${NORTH_HOST}:${port}`] });
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
  const everything = { dealer: true, make: true, lead: true, intake_submission: true };
  owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port, allowedHosts: [NORTH_HOST] },
    ...(options.trustedProxies ? { trustedProxies: parseTrustedProxies(options.trustedProxies).ranges } : {}),
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId: APP_ID,
        storeId: binding.storeId,
        ownership: {
          dealer: { kind: 'platform' },
          make: { kind: 'tenant', column: 'tenant_id' },
          lead: { kind: 'tenant', column: 'tenant_id' },
          intake_submission: { kind: 'platform' },
        },
        resolveMembershipRows: () => everything,
        resolveRows: () => everything,
        resolvePlatformRows: () => everything,
        resultReferences: { apply: () => [], quote: () => [], suggest: () => [], draftName: () => [], draftSubmit: () => [] },
        intake: { address: 'intake_address' },
        ...(options.publicReads ? { public: { address: 'public_address' }, resolvePublicRows: () => ({ make: true }) } : {}),
      }),
      source: engine.dialect === 'sqlite' ? { ...binding.source, existingPath: engine.path } : { ...binding.source, url: engine.url },
      deployment: 'public-forms-generation',
      roles: ['staff', 'manager'],
      maxLifetimeMs: 60000,
      commands: { registry },
    },
  });
  // The operator's mapped host, routed as the suite listener routes it (tenantHosts.ts).
  const router = createTenantHostRouter([{ host: NORTH_HOST, app: APP_ID, tenant: 'north' }]);
  front.on('request', (req, res) => {
    if (!router.accept(req)) {
      res.writeHead(403).end();
      return;
    }
    owner!.server.emit('request', req, res);
  });
  front.listen(port, '127.0.0.1');
  await once(front, 'listening');
  const call: TenantPublicForms['call'] = (path, init = {}) =>
    new Promise((resolve, reject) => {
      const host = init.host ?? `127.0.0.1:${port}`;
      const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: payload === undefined ? 'GET' : 'POST',
          headers: {
            host,
            origin: `http://${host}`,
            ...(payload
              ? {
                  'content-type': 'application/json',
                  ...(init.chunked || init.trickle ? {} : { 'content-length': String(Buffer.byteLength(payload)) }),
                }
              : {}),
            ...init.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
          });
        },
      );
      req.setTimeout(init.trickle ? 20_000 : 10_000, () => req.destroy(new Error('timed out')));
      let answered = false;
      req.on('response', () => (answered = true));
      // A server that answers a chunked body before it ends closes the connection under the rest: not a failure.
      req.on('error', (error) => (answered ? undefined : reject(error)));
      if (init.trickle && payload !== undefined) {
        // Never more than a byte at a time, so the body is still arriving long after a person's would have.
        let sent = 0;
        const drip = setInterval(() => {
          if (answered || req.destroyed) clearInterval(drip);
          else if (sent < payload.length) req.write(payload[sent++]);
          else {
            clearInterval(drip);
            req.end();
          }
        }, 500);
        req.write(payload[sent++]);
      } else if (init.chunked && payload !== undefined) {
        // No length: the body goes as chunks, and the server learns its size only by reading it.
        req.write(payload.slice(0, 1024));
        setTimeout(() => {
          if (!answered && !req.destroyed) req.end(payload.slice(1024));
        }, 20);
      } else req.end(payload);
    });
  return { engine, origin, port, call, rows: (sql) => engine.all(sql) };
}
