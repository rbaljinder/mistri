/**
 * What a test host asks of the server it started, outside the App's own doors:
 * rows inserted as a test's setup, a job at times run now, in a tenant App
 * an account with a membership of a tenant or of the platform, a command run
 * as one of its service roles in one tenant, and the read audit's rows, which
 * no route of the App reads. `startTestApp`
 * (testing/host.ts) is the one caller. It starts the server with
 * NODE_ENV=test and a random MISTRI_TEST_CONTROL token, and sends that
 * token with each request; without both, or from beyond loopback, these
 * routes do not exist and the path falls through to the App as any unknown
 * one does. A deployment never sets either, so nothing here is reachable in
 * production, whatever its config says.
 *
 * Setup is not a person's write: it bypasses grants and the row policy, as a
 * seed script does, and it is named as setup everywhere it surfaces
 * (`host.seed`). What a test asserts still goes through the App's doors. A
 * service actor is not setup: its command is bound, granted and fenced as a
 * job's principal's is (tenant/tenantServiceActor.ts), and its answer is the
 * command door's own status and body, passed through as they are.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import type { JobHost } from '../jobs/jobHost.js';
import { homeSourceOf, isTenantApp } from '../../shared/appModel.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { TEST_CONTROL_HEADER, TEST_CONTROL_PATHS } from '../testing/control.js';
import type { ReadAuditQuery, StoredReadAudit } from '../../adapters/readAudit/readAudit.js';
import type { TenantServiceAnswer, TenantServiceRequest } from '../tenant/tenantServiceActor.js';

export interface TestControl {
  /** True when the request was one of these routes, answered here. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

type Value = string | number | boolean | null;

const loopback = (address: string | undefined) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** The control a test host's server answers, or none: only under NODE_ENV=test with a token a test host set. */
export function testControlFrom(
  env: NodeJS.ProcessEnv,
  serving: {
    registry: Registry;
    apps: () => readonly AppHost[];
    jobs?: Pick<JobHost, 'runNow'>;
    policy?: string;
    /** A tenant App's read audit, read for one tenant at a time (tenantDeployment.ts `readAudit`). */
    tenantReadAudit?: (tenant: string, query: Omit<ReadAuditQuery, 'tenant'>) => Promise<StoredReadAudit[]>;
    /** A tenant App's service actor, when it was started with its jobs (tenant/tenantServiceActor.ts). */
    service?: (request: TenantServiceRequest) => Promise<TenantServiceAnswer>;
  },
): TestControl | undefined {
  const token = env.MISTRI_TEST_CONTROL;
  if (env.NODE_ENV !== 'test' || !token || token.length < 32) return undefined;
  const expected = Buffer.from(token);
  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(String(req.headers[TEST_CONTROL_HEADER] ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected) && loopback(req.socket.remoteAddress);
  };

  async function seed(body: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const { table, rows } = body;
    if (typeof table !== 'string' || !table) throw new HttpError(400, 'seed names a table.');
    if (!Array.isArray(rows) || !rows.length || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row)))
      throw new HttpError(400, 'seed takes one or more rows, each an object of column to value.');
    const apps = serving.apps();
    if (apps.length !== 1) throw new HttpError(400, 'seed inserts into the one App this server serves.');
    const app = apps[0].app.app;
    const bound = app.connection ?? (app.sources ? app.sources[homeSourceOf(app)!]?.connection : undefined);
    const connection = serving.registry.list().find((each) => each.id === bound || each.name === bound) ?? serving.registry.list()[0];
    if (!connection) throw new HttpError(400, 'This server has no database to seed.');
    const { adapter, schema } = await serving.registry.open(connection.id);
    const found = tableNamed(schema, table);
    if (!found) throw new HttpError(400, `No table called "${table}" in the App's database.`);
    if (!adapter.transaction)
      throw new HttpError(400, `The App's database is served read-only, so a test cannot seed it: name a "writable": true connection.`);
    /* One transaction: a fixture that fails at its third row leaves none of it. */
    return adapter.transaction(async (tx) => {
      const inserted: Record<string, unknown>[] = [];
      for (const row of rows as Array<Record<string, Value>>) {
        const result = await tx.insert({ table: found.id, values: row });
        inserted.push(result.row ?? { ...result.applied, ...result.key });
      }
      return inserted;
    });
  }

  async function job(body: Record<string, unknown>) {
    const { job: name, timeoutMs, tenant } = body;
    if (typeof name !== 'string' || !name) throw new HttpError(400, 'Name the job to run.');
    if (tenant !== undefined && (typeof tenant !== 'string' || !tenant)) throw new HttpError(400, 'A run per tenant names its tenant.');
    if (!serving.jobs) throw new HttpError(400, `This server runs no jobs: start the App with --jobs to run "${name}".`);
    return serving.jobs.runNow(name, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined, tenant);
  }

  /**
   * A tenant App's member, made as an operator makes one: a native account in the App's auth store, the tenant (or
   * `@platform`) made active if it is not there, and one membership with these roles (tenant/tenantLocalAccess.ts).
   * The roles are held to the realm's ceiling by the maintenance step, as for any operator. The password comes back
   * once, for the test's sign-in.
   */
  async function membership(body: Record<string, unknown>) {
    const { tenant, roles } = body;
    if (typeof tenant !== 'string' || !tenant) throw new HttpError(400, 'A membership names its tenant, or @platform.');
    if (!Array.isArray(roles) || !roles.length || roles.some((role) => typeof role !== 'string'))
      throw new HttpError(400, 'A membership names one or more roles.');
    const apps = serving.apps();
    if (apps.length !== 1 || !isTenantApp(apps[0].app.app))
      throw new HttpError(400, 'A membership is made in the one tenant App this server serves.');
    const host = apps[0];
    if (!serving.policy || !host.auth) throw new HttpError(400, 'This tenant App was started without its --policy or its sign-in.');
    const { tenantLocalAccess, ensureLocalTenant, grantLocalMembership } = await import('../tenant/tenantLocalAccess.js');
    const { createNativeAccount } = await import('../auth/authAccounts.js');
    const access = await tenantLocalAccess(host.app, serving.registry, serving.policy);
    const word = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'member';
    const email =
      typeof body.email === 'string' && body.email
        ? body.email
        : `${word(String(roles[0]))}.${word(tenant)}.${randomBytes(4).toString('hex')}@example.test`;
    const password = randomBytes(18).toString('base64url');
    const name = typeof body.name === 'string' && body.name ? body.name : `Test ${roles[0]} of ${tenant}`;
    const accountId = await createNativeAccount(host.auth, { email, name, password }, { by: 'maintenance' });
    await ensureLocalTenant(access, tenant, 'test-host');
    await grantLocalMembership(access, { tenantId: tenant, accountId, roles: roles as string[], days: 1, operator: 'test-host' });
    return { appId: host.app.app.id, accountId, email, password };
  }

  /** The read audit's rows, newest first: a tenant App's for the one tenant named, any other App's from its own databases. */
  async function readAudit(body: Record<string, unknown>) {
    const { tenant, resource, record, actor, since, limit } = body;
    const query = {
      ...(typeof resource === 'string' ? { resource } : {}),
      ...(typeof record === 'string' ? { record } : {}),
      ...(typeof actor === 'string' ? { actor } : {}),
      ...(typeof since === 'string' ? { since } : {}),
      limit: typeof limit === 'number' ? limit : 1000,
    };
    const apps = serving.apps();
    if (apps.length !== 1) throw new HttpError(400, 'The read audit is read for the one App this server serves.');
    if (isTenantApp(apps[0].app.app)) {
      if (typeof tenant !== 'string' || !tenant)
        throw new HttpError(400, "A tenant App's read audit is read one tenant at a time: name it.");
      if (!serving.tenantReadAudit) throw new HttpError(400, 'This tenant App audits the reads of no resource.');
      return serving.tenantReadAudit(tenant, query);
    }
    const { readAppReadAudit } = await import('../readAuditStore.js');
    return readAppReadAudit(serving.registry, apps[0], query);
  }

  /** A command as one service role in one tenant: what the command door would answer, status and body. */
  async function service(body: Record<string, unknown>): Promise<TenantServiceAnswer> {
    const { tenant, role, command, input, key, version, idempotencyKey } = body;
    if (typeof tenant !== 'string' || !tenant) throw new HttpError(400, 'A service actor acts in one tenant: name it.');
    if (typeof role !== 'string' || !role) throw new HttpError(400, 'A service actor names its role.');
    if (typeof command !== 'string' || !command) throw new HttpError(400, 'Name the command to run.');
    if (key !== undefined && (!key || typeof key !== 'object' || Array.isArray(key)))
      throw new HttpError(400, "A command's key is an object of column to value.");
    if (version !== undefined && !Number.isSafeInteger(version)) throw new HttpError(400, "A command's version is a whole number.");
    if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') throw new HttpError(400, 'An idempotency key is text.');
    if (!serving.service) throw new HttpError(400, 'This server runs no jobs: start the App with --jobs to act as a service.');
    return serving.service({
      tenant,
      role,
      command,
      input: input ?? {},
      ...(key !== undefined ? { key: key as Record<string, string | number> } : {}),
      ...(version !== undefined ? { version: version as number } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }

  return {
    async handle(req, res, url) {
      if (url.pathname === TEST_CONTROL_PATHS.service && authorized(req)) {
        if (req.method !== 'POST') send(res, 405, { error: 'POST' });
        else
          try {
            const answer = await service(await readJson(req));
            send(res, answer.status, answer.body);
          } catch (error) {
            send(res, error instanceof HttpError ? error.status : 400, { error: (error as Error).message });
          }
        return true;
      }
      const route =
        url.pathname === TEST_CONTROL_PATHS.seed
          ? seed
          : url.pathname === TEST_CONTROL_PATHS.job
            ? job
            : url.pathname === TEST_CONTROL_PATHS.membership
              ? membership
              : url.pathname === TEST_CONTROL_PATHS.readAudit
                ? readAudit
                : undefined;
      if (!route || !authorized(req)) return false;
      if (req.method !== 'POST') {
        send(res, 405, { error: 'POST' });
        return true;
      }
      try {
        send(res, 200, { ok: true, value: await route(await readJson(req)) });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        send(res, status, { error: (error as Error).message });
      }
      return true;
    },
  };
}
