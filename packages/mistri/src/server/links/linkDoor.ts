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
 *
 * The door is the same for every App. Where the link and its record are kept, and how a command reaches them, is a
 * `LinkBackend`'s: an App without tenants reads the journal beside its records (linkRoutes.ts), a tenant App reads
 * the tenant the link was minted in (tenant/tenantLinks.ts). The session is bound to that tenant, so a cookie or an
 * id carried to another tenant's link is a session that is not this link's.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef } from '../../shared/app.js';
import { fieldLabel } from '../../shared/command.js';
import { linkRowKey, type AppLinkDef } from '../../shared/appLinks.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from '../commands/businessCommands.js';
import { businessCommandHttpError, CommandBodyTooLarge, commandBody } from '../commands/businessCommandHttp.js';
import type { CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import { LINK_ID } from '../../adapters/commands/commandLinks.js';
import { clientAddress, publicFormLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { outward, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { EmailTransport } from '../email/email.js';
import { equalText, settle } from '../forms/statusCheck.js';
import { oneTimeCodes, CODE_MINUTES } from '../forms/oneTimeCode.js';
import { signInState } from '../auth/signInState.js';
import { secureRequest } from '../forms/savedForms.js';
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
import { LINK_MISS, LINK_SESSION_HEADER, linkPage, linkPagePolicy, type LinkPageCommand } from './linkPage.js';

export const LINK_PATH = /^\/([^/]+)\/l\/([^/]+)(?:\/(prepare|run|confirm|stepup))?$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/* Five wrong confirmations in an hour lock the link's confirmation for the rest of it: the columns it asks are
   things a holder knows, often short (a ZIP code, a birth date), and the floor alone would let them be walked. */
const CONFIRM_TRIES = 5;
const CONFIRM_WINDOW_MS = 3_600_000;
const COOKIE_MAX = 8192;

export type LinkStep = 'prepare' | 'run' | 'confirm' | 'stepup';

/** A link a backend found by id: its row, and the tenant it was minted in (`''` in an App without tenants). */
export interface FoundLink {
  readonly row: CommandLinkRow;
  readonly tenant: string;
}

/** Where a link and its record are kept, and how its commands reach them. One per request. */
export interface LinkBackend<F extends FoundLink = FoundLink> {
  /** The App's commands: the page labels a link's commands, and prepares them, by these. */
  readonly commands: BusinessCommandRegistry;
  /** The link by id, or undefined — the one miss. Spends nothing. */
  lookUp(id: string, now: number): Promise<F | undefined>;
  /** Spends one use: the row as opened, or undefined where it does not open (revoked, expired, spent). */
  open(found: F, now: number): Promise<CommandLinkRow | undefined>;
  /** The link's record by its key, these columns only, at most two rows (two is not one record). */
  readRecord(
    found: F,
    key: Readonly<Record<string, string | number>>,
    columns: readonly string[],
  ): Promise<readonly Record<string, unknown>[]>;
  /** Revokes every link on the found link's row, which is gone. */
  revoke(found: F, now: number): Promise<unknown>;
  /** One command route as the link's principal, through the executor that reads the link again. */
  run(found: F, actor: BusinessCommandActor, route: 'prepare' | 'execute', envelope: Record<string, unknown>): Promise<unknown>;
  /** Where a step-up code is mailed from, when anywhere. */
  mail(): EmailTransport | undefined;
  /** Lets go of what the request held. */
  close(): void;
}

/** What the door reads of the request, whoever serves it. */
interface LinkDoorRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly bound: Bound;
  readonly mount: AddressMount;
  readonly app: AppDef;
  /** The link's address segment: a token, or an id. */
  readonly segment: string;
  readonly step?: LinkStep;
}

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

const gatesNeeded = (def: AppLinkDef) => (def.confirm?.length ? GATE_CONFIRMED : 0) | (def.stepUp ? GATE_STEPPED_UP : 0);

/**
 * One request at a link's door. `backend` is undefined where this App serves no link now (a policy that did not
 * load, a store that cannot write): that opens nothing, as a link that does not exist.
 */
export async function linkDoor<F extends FoundLink>(door: LinkDoorRequest, backend: LinkBackend<F> | undefined): Promise<true> {
  const { req, res, bound, mount, app, segment, step } = door;
  const appId = app.id;
  const started = Date.now();
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

  if (!backend) return (await limited(token ? 'link' : 'read')) || miss();

  if (posting) {
    if (doorRefusal(req, bound, { writing: true, origin: 'always', sameSite: true })) {
      send(res, 403, { code: 'cross_origin', error: 'This link takes requests from its own page only.' });
      return true;
    }
  }
  /* A gate's answer is a guess, counted as a status check is; asking for a code also spends the mail budget, below. */
  const budget = token ? 'link' : step === 'run' ? 'submit' : step === 'stepup' || step === 'confirm' ? 'status' : 'read';
  if (await limited(budget)) return true;

  const commands = backend.commands;
  /** Whether the link no longer opens: asked again after a run failed, and a store that cannot answer says no. */
  const gone = async (linkId: string): Promise<boolean> => {
    try {
      return (await backend.lookUp(linkId, Date.now())) === undefined;
    } catch {
      return false;
    }
  };
  try {
    const now = Date.now();
    const found = await backend.lookUp(id, now);

    /* ---------- the link itself: spend a use, hand over a session ---------- */
    if (token) {
      const matches = linkTokenMatches(appId, token, found?.row);
      const opened = matches && found ? await backend.open(found, now) : undefined;
      if (!opened || !found) return await miss();
      await settle(started);
      setSession(req, res, door, id, linkSession(appId, found.tenant, id, 0, now));
      res.writeHead(303, { location: outward(mount, `/${encodeURIComponent(appId)}/l/${id}`), 'content-length': '0' });
      res.end();
      return true;
    }

    const presented = posting ? headerOf(req, LINK_SESSION_HEADER) : sessionCookie(req, id);
    const session = found ? readLinkSession(appId, found.tenant, id, presented, now) : undefined;
    const def = found && session ? linkDef(app, found.row) : undefined;
    const key = found ? linkRowKey(found.row.rowKey) : undefined;
    if (!found || !session || !def || !key) return await miss();
    const row = found.row;
    const readRecord = async (columns: readonly string[]): Promise<Record<string, unknown> | undefined> => {
      const rows = await backend.readRecord(found, key, columns);
      /* The row is gone: removed outside a command (a cascade, plain SQL), since a command's delete revokes in its own
         transaction. Its links are revoked now, before its key can name another row. */
      if (rows.length === 0) await backend.revoke(found, Date.now());
      return rows.length === 1 ? rows[0] : undefined;
    };
    const needed = gatesNeeded(def);
    const passed = (gate: number) => (session.gates & gate) === gate;
    const renewed = (gates: number) => {
      const next = linkSession(appId, found.tenant, id, gates, now, session.opened);
      setSession(req, res, door, id, next);
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
        const registered = commands[command];
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
          if ('code' in issued) sendCode(backend.mail(), address, issued.code, app.name ?? app.id, appId);
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
    if (step === 'prepare') {
      const prepared: Record<string, { expectedVersion: unknown }> = {};
      const refused: Record<string, string> = {};
      for (const command of def.commands ?? []) {
        const registered = commands[command];
        if (!registered) continue;
        try {
          const answer = (await backend.run(found, actor, 'prepare', { command, commandVersion: registered.version, key })) as {
            expectedVersion?: unknown;
          };
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
    const registered = typeof command === 'string' && def.commands?.includes(command) ? commands[command] : undefined;
    if (!asked || !registered) {
      send(res, 403, { code: 'forbidden', error: 'This link does not run that.' });
      return true;
    }
    try {
      await backend.run(found, actor, 'execute', {
        command,
        commandVersion: registered.version,
        key,
        expectedVersion: asked.expectedVersion,
        idempotencyKey: asked.idempotencyKey,
        input: asked.input ?? {},
      });
      send(res, 200, { ok: true, session: presented });
    } catch (error) {
      /* A link revoked (or its row removed) while this run was in flight is refused by the transaction that reads it
         again, as a forbidden command or, in a tenant App, a fence that cannot answer. Its holder's next request is the
         miss, so this one is too: the same answer, whichever side of the revoke the run fell on. A link still live is
         the command's own refusal, answered as it is. */
      if (await gone(id)) {
        reportRefusal(req, 404, 'not_found', 'link revoked while its run was in flight', error);
        return await miss();
      }
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
    backend.close();
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

function setSession(req: IncomingMessage, res: ServerResponse, door: LinkDoorRequest, id: string, session: string): void {
  const path = outward(door.mount, `/${encodeURIComponent(door.app.id)}/l/`);
  const secure = secureRequest(req, door.bound.trustedProxies);
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

function sendCode(mail: EmailTransport | undefined, to: string, code: string, appName: string, appId: string): void {
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
