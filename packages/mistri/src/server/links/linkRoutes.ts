/**
 * A capability link's door (shared/appLinks.ts): one record, its declared columns and commands, to whoever holds
 * the link, signed in or not.
 *
 *   GET  /<app>/l/<token>             the link itself: spends a use, sets the session cookie, 303 to the page
 *   GET  /<app>/l/<id>                the page: its gate, or the record and its commands (linkPage.ts)
 *   POST /<app>/l/<id>/prepare        {}                     → { commands: { <id>: { expectedVersion } } }
 *   POST /<app>/l/<id>/run            { command, expectedVersion, idempotencyKey, input }
 *   POST /<app>/l/<id>/confirm        { confirm: { <column>: typed } }
 *   POST /<app>/l/<id>/stepup         { send: true } or { code }
 *
 * The token travels once: the address it came in is answered with a cookie and a redirect, so the secret leaves
 * the address bar, the history and any Referer before the page draws. The cookie is the link's session for five
 * minutes, under its own path and SameSite=Lax, so a link opened from mail lands. A POST carries the session in a
 * header the page's script holds (`x-mistri-link`) and passes the same-origin door: the cookie alone would ride on
 * any same-site request.
 *
 * Whatever does not open — an unknown id, a wrong MAC, a link revoked, expired or spent, a session that is not
 * this link's — is one answer, word for word, held to the same floor (statusCheck.ts `settle`), so a holder of
 * nothing learns nothing from the reply or its timing.
 *
 * A run is the link's own principal (`kind: 'link'`), through the same executor, journal and audit as any command:
 * the authorizer admits only the link's declared commands on its one record, and the executor reads the link again
 * in the transaction that runs it.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRowPolicyApp, isTenantApp, type AppDef } from '../../shared/app.js';
import { fieldLabel } from '../../shared/command.js';
import type { AppLinkDef } from '../../shared/appLinks.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { keyFilter } from '../commands/commandDb.js';
import type { BusinessCommandActor } from '../commands/businessCommands.js';
import {
  businessCommandHttpError,
  CommandBodyTooLarge,
  commandBody,
  dispatchBusinessCommandHttp,
} from '../commands/businessCommandHttp.js';
import type { CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import { LINK_ID } from '../../adapters/commands/commandLinks.js';
import { clientAddress, publicFormLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal } from '@mistriwork/engine/server/http/trust.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { outward } from '@mistriwork/engine/shared/mount.js';
import { equalText, settle } from '../forms/statusCheck.js';
import { oneTimeCodes, CODE_MINUTES } from '../forms/oneTimeCode.js';
import { signInState } from '../auth/signInState.js';
import { secureRequest } from '../forms/savedForms.js';
import { emailOf } from '../serviceConnections.js';
import {
  GATE_CONFIRMED,
  GATE_STEPPED_UP,
  LINK_SESSION_SECONDS,
  LINK_TOKEN_PREFIX,
  linkSession,
  linkTokenId,
  linkTokenMatches,
  readLinkSession,
} from './linkToken.js';
import { lookUpLink, servesLinks } from './linkLookup.js';
import { LINK_MISS, LINK_SESSION_HEADER, linkPage, linkPagePolicy, type LinkPageCommand } from './linkPage.js';

const PATH = /^\/([^/]+)\/l\/([^/]+)(?:\/(prepare|run|confirm|stepup))?$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/* Five wrong confirmations in an hour lock the link's confirmation for the rest of it: the columns it asks are
   things a holder knows, often short (a ZIP code, a birth date), and the floor alone would let them be walked. */
const CONFIRM_TRIES = 5;
const CONFIRM_WINDOW_MS = 3_600_000;
const COOKIE_MAX = 8192;

type Step = 'prepare' | 'run' | 'confirm' | 'stepup';
type Host = NonNullable<RequestContext['appHosts']>[number] & { app: { app: AppDef } };

const cookieName = (id: string) => `mstl_${id}`;

/* The one cookie this link's page set; two of the name (one planted under a wider path) are none. */
function sessionCookie(req: IncomingMessage, id: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > COOKIE_MAX) return undefined;
  const name = `${cookieName(id)}=`;
  const found = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name));
  return found.length === 1 ? found[0].slice(name.length) : undefined;
}

const ROW_KEY = (rowKey: string): Record<string, string> | undefined => {
  try {
    const pairs = JSON.parse(rowKey) as unknown;
    if (!Array.isArray(pairs) || !pairs.length) return undefined;
    return Object.fromEntries(pairs.map((pair) => [String((pair as unknown[])[0]), String((pair as unknown[])[1])]));
  } catch {
    return undefined;
  }
};

const gatesNeeded = (def: AppLinkDef) => (def.confirm?.length ? GATE_CONFIRMED : 0) | (def.stepUp ? GATE_STEPPED_UP : 0);

export async function linkRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, registry, bound, mount } = ctx;
  const match = PATH.exec(path);
  if (!match) return false;
  let appId: string;
  try {
    appId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const host = (ctx.appHosts as Host[] | undefined)?.find((each) => each.app.app.id === appId);
  const app = host?.app.app;
  if (!host || !app || !servesLinks(app)) return false;
  const started = Date.now();
  const segment = match[2];
  const step = match[3] as Step | undefined;
  const token = segment.startsWith(LINK_TOKEN_PREFIX) ? segment : undefined;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-robots-tag', 'noindex, nofollow');

  const posting = step !== undefined;
  if (
    token ? step !== undefined || req.method !== 'GET' : posting ? req.method !== 'POST' : req.method !== 'GET' && req.method !== 'HEAD'
  ) {
    res.setHeader('allow', posting ? 'POST' : token ? 'GET' : 'GET, HEAD');
    send(res, 405, { code: 'method_not_allowed', error: 'Not here.' });
    return true;
  }

  const miss = async (): Promise<true> => {
    await settle(started);
    if (res.headersSent) return true;
    if (posting) send(res, 404, { code: 'not_found', error: LINK_MISS });
    else page(res, 404, req.method === 'HEAD', (nonce) => linkPage({ app: app.name ?? app.id, nonce, state: 'miss' }));
    return true;
  };

  const id = token ? linkTokenId(token) : LINK_ID.test(segment) ? segment : undefined;
  if (!id) return miss();

  const client = clientAddress(req, bound.trustedProxies);
  const limited = async (kind: Parameters<typeof publicFormLimiter>[0]) => {
    const limiter = publicFormLimiter(kind);
    for (const scope of ['client', 'all'] as const) {
      const decision = await limiter.take(client, scope);
      if (!decision.ok) {
        res.setHeader('retry-after', String(decision.retryAfterSeconds));
        send(res, 429, {
          code: 'rate_limited',
          error: `Too many requests. Try again in ${decision.retryAfterSeconds} seconds.`,
          retryAfter: decision.retryAfterSeconds,
        });
        return true;
      }
    }
    return false;
  };

  /* A link is served only where its principal is the whole story: no row policy, no tenant, a writable entry point
     and a command host for this App. Anywhere else it opens nothing, as a link that does not exist. */
  const commands = ctx.commands;
  const connection = appEntrypoint(host as never, registry);
  if (
    ctx.policy ||
    ctx.policyUnavailable ||
    isTenantApp(app) ||
    isRowPolicyApp(app) ||
    !commands ||
    commands.appId !== appId ||
    !connection ||
    registry.configOf(connection)?.writable !== true
  )
    return (await limited(token ? 'link' : 'read')) || miss();

  if (posting) {
    if (doorRefusal(req, bound, { writing: true, origin: 'always', sameSite: true })) {
      send(res, 403, { code: 'cross_origin', error: 'This link takes requests from its own page only.' });
      return true;
    }
  }
  /* A gate's answer is a guess, counted as a status check is; asking for a code also spends the mail budget, below. */
  const budget = token ? 'link' : step === 'run' ? 'submit' : step === 'stepup' || step === 'confirm' ? 'status' : 'read';
  if (await limited(budget)) return true;

  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
    const now = Date.now();
    const found = await lookUpLink(app, resources, id, now);

    /* ---------- the link itself: spend a use, hand over a session ---------- */
    if (token) {
      const matches = linkTokenMatches(appId, token, found?.row);
      const opened =
        matches && found ? await found.journal((journal) => journal.openLink?.(appId, id, now) ?? Promise.resolve(undefined)) : undefined;
      if (!opened) return await miss();
      await settle(started);
      setSession(req, res, ctx, appId, id, linkSession(appId, '', id, 0, now));
      res.writeHead(303, { location: outward(mount, `/${encodeURIComponent(appId)}/l/${id}`), 'content-length': '0' });
      res.end();
      return true;
    }

    const presented = posting ? headerOf(req, LINK_SESSION_HEADER) : sessionCookie(req, id);
    const session = readLinkSession(appId, '', id, presented, now);
    const def = found && session ? linkDef(app, found.row) : undefined;
    const key = found ? ROW_KEY(found.row.rowKey) : undefined;
    if (!found || !session || !def || !key) return await miss();
    const row = found.row;
    const reader = resources.forConnection(resources.connectionFor(row.resource));
    const readRecord = async (columns: readonly string[]): Promise<Record<string, unknown> | undefined> => {
      const read = await reader.query({ table: row.resource, columns: [...columns], filter: keyFilter(key), limit: 2, offset: 0 });
      return read.rows.length === 1 ? (read.rows[0] as Record<string, unknown>) : undefined;
    };
    const needed = gatesNeeded(def);
    const passed = (gate: number) => (session.gates & gate) === gate;
    const renewed = (gates: number) => {
      const next = linkSession(appId, '', id, gates, now, session.opened);
      setSession(req, res, ctx, appId, id, next);
      return next;
    };
    const actor: BusinessCommandActor = {
      id: `link:${id}`,
      appId,
      roles: [],
      kind: 'link',
      link: { id, name: row.name, resource: row.resource, key: row.rowKey },
    };

    /* ---------- the page ---------- */
    if (!posting) {
      const base = outward(mount, `/${encodeURIComponent(appId)}/l/${id}`);
      const next = renewed(session.gates);
      const appName = app.name ?? app.id;
      const title = fieldLabel(row.name);
      const label = (col: string) => app.resources?.[row.resource]?.labels?.[col] ?? fieldLabel(col);
      if (def.confirm?.length && !passed(GATE_CONFIRMED)) {
        page(res, 200, req.method === 'HEAD', (nonce) =>
          linkPage({ app: appName, nonce, state: 'confirm', base, session: next, title, confirm: def.confirm }),
        );
        return true;
      }
      if (def.stepUp && !passed(GATE_STEPPED_UP)) {
        page(res, 200, req.method === 'HEAD', (nonce) => linkPage({ app: appName, nonce, state: 'stepUp', base, session: next, title }));
        return true;
      }
      const record = await readRecord(def.show);
      if (!record) return await miss();
      const shown = def.show.map((col) => ({ label: label(col), value: shownValue(def, col, record[col]) }));
      const pageCommands: LinkPageCommand[] = (def.commands ?? []).flatMap((command) => {
        const registered = commands.registry[command];
        if (!registered) return [];
        return [{ id: command, label: registered.label ?? fieldLabel(command), fields: registered.fields }];
      });
      page(res, 200, req.method === 'HEAD', (nonce) =>
        linkPage({ app: appName, nonce, state: 'record', base, session: next, title, shown, commands: pageCommands }),
      );
      return true;
    }

    /* ---------- the gates ---------- */
    if (step === 'confirm') {
      if (!def.confirm?.length) return await miss();
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, 4096);
      } catch {
        return await refusedAfterFloor(started, res, 400, 'invalid_input', 'Type each detail asked.');
      }
      const lock = `link-confirm:${appId}:${id}`;
      /*
       * Charged before the answer is judged, and judged on the count the charge
       * returns: a read-then-fail check lets a burst of concurrent tries all see
       * a count under the limit, which is many guesses at a low-entropy detail.
       */
      if ((await signInState.failures(lock)) >= CONFIRM_TRIES || (await signInState.fail(lock, CONFIRM_WINDOW_MS)) > CONFIRM_TRIES)
        return await refusedAfterFloor(started, res, 429, 'locked', 'Too many tries. Try again in an hour.');
      const typed = body.confirm;
      const stored = await readRecord(def.confirm.map((item) => item.column));
      const right =
        !!stored &&
        typeof typed === 'object' &&
        typed !== null &&
        def.confirm
          .map((item) => {
            const value = (typed as Record<string, unknown>)[item.column];
            return typeof value === 'string' && value.length <= 200 && equalText(value.trim(), stored[item.column]);
          })
          .every(Boolean);
      if (!right) {
        return await refusedAfterFloor(started, res, 403, 'not_confirmed', 'That does not match our records.');
      }
      await signInState.clearFailures(lock);
      const next = renewed(session.gates | GATE_CONFIRMED);
      await settle(started);
      send(res, 200, { ok: true, session: next });
      return true;
    }
    if (step === 'stepup') {
      if (!def.stepUp || (def.confirm?.length && !passed(GATE_CONFIRMED))) return await miss();
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, 4096);
      } catch {
        return await refusedAfterFloor(started, res, 400, 'invalid_input', 'Ask for a code, or type the one you were sent.');
      }
      const stored = await readRecord([def.stepUp]);
      const address = typeof stored?.[def.stepUp] === 'string' ? (stored[def.stepUp] as string).trim() : '';
      const deliverable = EMAIL.test(address);
      const subject = `link\u0000${appId}\u0000${id}`;
      const bound = address.toLowerCase();
      const codes = oneTimeCodes();
      if (body.send === true) {
        if (await limited('code')) return true;
        /* The same answer whether or not a code went: what is on file is not this page's to say. */
        if (deliverable) {
          const issued = await codes.issue(subject, now, bound);
          if ('code' in issued) sendCode(registry, address, issued.code, app.name ?? app.id, appId);
        }
        await settle(started);
        send(res, 200, { sent: true, session: presented });
        return true;
      }
      const ok = deliverable && typeof body.code === 'string' && (await codes.spend(subject, body.code.trim(), now, bound));
      if (!ok)
        return await refusedAfterFloor(started, res, 403, 'not_confirmed', 'That code is not right, or it has run out. Ask for a new one.');
      const next = renewed(session.gates | GATE_STEPPED_UP);
      await settle(started);
      send(res, 200, { ok: true, session: next });
      return true;
    }

    /* ---------- the commands, once every gate is passed ---------- */
    if (!passed(needed)) return await miss();
    const run = (route: 'prepare' | 'execute', envelope: Record<string, unknown>) =>
      dispatchBusinessCommandHttp({
        req,
        res,
        path: `/api/commands/${route}`,
        registry,
        app,
        commands: commands.registry,
        connection,
        actor,
        body: envelope,
        ...(commands.events ? { events: commands.events } : {}),
      });
    if (step === 'prepare') {
      const prepared: Record<string, { expectedVersion: unknown }> = {};
      const refused: Record<string, string> = {};
      for (const command of def.commands ?? []) {
        const registered = commands.registry[command];
        if (!registered) continue;
        try {
          const answer = (await run('prepare', { command, commandVersion: registered.version, key })) as { expectedVersion?: unknown };
          prepared[command] = { expectedVersion: answer.expectedVersion };
        } catch (error) {
          refused[command] = businessCommandHttpError(error).body.message;
        }
      }
      send(res, 200, { commands: prepared, refused, session: presented });
      return true;
    }
    /* run */
    let body: unknown;
    try {
      body = await commandBody(req);
    } catch (error) {
      if (error instanceof CommandBodyTooLarge) {
        send(res, 413, { code: 'too_large', error: 'This request is too large.' });
        return true;
      }
      send(res, 400, { code: 'invalid_input', error: 'This request is not one this page sends.' });
      return true;
    }
    const asked = body as Record<string, unknown> | null;
    const command = asked && typeof asked === 'object' ? asked.command : undefined;
    const registered = typeof command === 'string' && def.commands?.includes(command) ? commands.registry[command] : undefined;
    if (!asked || !registered) {
      send(res, 403, { code: 'forbidden', error: 'This link does not run that.' });
      return true;
    }
    try {
      await run('execute', {
        command,
        commandVersion: registered.version,
        key,
        expectedVersion: asked.expectedVersion,
        idempotencyKey: asked.idempotencyKey,
        input: asked.input ?? {},
      });
      send(res, 200, { ok: true, session: presented });
    } catch (error) {
      const failure = businessCommandHttpError(error);
      const { outcome: _outcome, ...answer } = failure.body;
      reportRefusal(req, failure.status, failure.body.code, failure.body.message, error);
      send(res, failure.status, answer);
    }
    return true;
  } catch (error) {
    /* A store that cannot answer opens nothing, and says so the way a missing link does. */
    reportRefusal(req, 404, 'not_found', 'link lookup failed', error);
    return await miss();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/* The declaration the row was minted under, as the App says it now: one dropped since opens nothing. */
function linkDef(app: AppDef, row: CommandLinkRow): AppLinkDef | undefined {
  const links = app.resources?.[row.resource]?.links;
  return links && Object.hasOwn(links, row.name) ? links[row.name] : undefined;
}

/* A shown value in the author's words where they gave some, else as stored. */
function shownValue(def: AppLinkDef, column: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const said = def.says?.[column]?.[String(value)];
  if (said) return said;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

function setSession(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, appId: string, id: string, session: string): void {
  const path = outward(ctx.mount, `/${encodeURIComponent(appId)}/l/`);
  const secure = secureRequest(req, ctx.bound.trustedProxies);
  res.setHeader(
    'set-cookie',
    `${cookieName(id)}=${session}; Path=${path}; Max-Age=${LINK_SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  );
}

/* Drawn with a fresh nonce under a policy that allows nothing else; HEAD answers the same headers and no body. */
function page(res: ServerResponse, status: number, head: boolean, draw: (nonce: string) => string): void {
  const nonce = randomBytes(16).toString('base64');
  const html = draw(nonce);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': linkPagePolicy(nonce),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'content-length': String(Buffer.byteLength(html)),
  });
  res.end(head ? undefined : html);
}

async function refusedAfterFloor(started: number, res: ServerResponse, status: number, code: string, error: string): Promise<true> {
  await settle(started);
  send(res, status, { code, error });
  return true;
}

function sendCode(registry: RequestContext['registry'], to: string, code: string, appName: string, appId: string): void {
  const mail = emailOf(registry);
  if (!mail) {
    process.stderr.write(`${JSON.stringify({ event: 'link.step_up', app: appId, outcome: 'undeliverable' })}\n`);
    return;
  }
  void mail
    .send({
      to,
      subject: `${appName}: your code is ${code}`,
      text:
        `Your code is ${code}.\n\nIt opens the link you were sent from ${appName}, once, for ${CODE_MINUTES} minutes.\n\n` +
        'If you did not ask for it, you can ignore this email: nothing opens without it.',
      sensitive: true,
    })
    .catch(() => process.stderr.write(`${JSON.stringify({ event: 'link.step_up', app: appId, outcome: 'send_failed' })}\n`));
}
