/**
 * A tenant App's public surface on its dedicated host: the landing and the
 * public forms, served signed out and signed in alike, and the one submission
 * route, which runs public intake (tenantIntake.ts). The same paths, bodies
 * and limits as the ordinary host's (formRoutes.ts, landingRoutes.ts), so the
 * same client page draws them.
 *
 * What the tenant host adds is the intake address: `?via=` on the submission,
 * copied from the page the tenant published, or, on this App's mapped host,
 * the address its tenant holds (an address beside the host is refused). One
 * rule places a form's read, its submission and every saved step. The address
 * is the only thing a submission's URL may say, and nothing in an answer
 * depends on it: every
 * placement answers with the same status, the same headers and a body of the
 * same shape. No tenant header is read or written here; a request carrying
 * one names a member's context, which the public has none of, and is refused
 * before anything is counted or read.
 *
 * A form saved on every step is served here as on the ordinary host
 * (forms/savedFormHttp.ts): its steps, its submit and its resume, each
 * carrying the address on to the intake, which resolves it every time.
 *
 * A public command page (`definePage({ public: true, commands })`) is a door
 * of the same kind: its ticket and its commands at the ordinary host's paths
 * and under its rules (http/pageCommandRoutes.ts), placed by the same address
 * and taken by the same intake (tenantIntakePages.ts says what it can take).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef, AppFormView } from '../../shared/app.js';
import type { AppCommandField } from '../../../schema/command.js';
import { wearing, type TenantLook } from './tenantLook.js';
import { cookieUnder } from '@mistriwork/engine/shared/mount.js';
import { TENANT_HTTP_HEADERS as headers } from '../../shared/tenantContext.js';
import { MAX_COMMAND_BYTES } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { businessCommandHttpError, CommandBodyTooLarge, commandBody, holdCommandBody } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { CommandInputError } from '../commands/commandPayload.js';
import { decoyReply, parseSubmission, presentForm, publicFormComponents, publicMessage } from '../commands/formHttp.js';
import type { HumanCheck } from '../commands/challenges.js';
import type { CompiledComponents } from '../app/appComponents.js';
import {
  CHALLENGE_REFUSAL,
  challengeAnsweredBy,
  countDecoy,
  publicFormBudget,
  publicFormPath,
  publicForms,
  rateLimited,
} from '../http/formRoutes.js';
import { isSavedForm } from '../../shared/appSavedForms.js';
import { dispatchIntakeSavedFormHttp, savedFormAction, type SavedForm, type SavedFormIntake } from '../forms/savedFormHttp.js';
import { secureRequest } from '../forms/savedForms.js';
import { attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import { answerLanding, LANDING_PATH } from '../http/landingRoutes.js';
import { clientAddress } from '@mistriwork/engine/server/http/rateLimit.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { newVisitorToken, PUBLIC_STAGED_FILE_MOST, readVisitorToken, StageRefusal, visitorCookie } from '../commands/stagedFiles.js';
import { publicFileBytesRefused } from '../commands/stagedFileHttp.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import type { TenantIntake } from './tenantIntake.js';
import {
  baseRecordBranding,
  brandingTenant,
  recordBrandingSpec,
  withRecordBranding,
  type BrandingPresentation,
} from '../http/recordBranding.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import { tenantPublicPlacement } from './tenantPublicPlacement.js';
import { pageCommandPath, TICKET_HEADER } from '../http/pageCommandRoutes.js';
import { issueTicket, ticketMessage, ticketRefusal } from '../forms/publicTicket.js';
import { tenantPublicPages } from './tenantIntakePages.js';

/** A public file's body: base64 of the largest file a public form holds, and room for the rest (commands/stagedFileHttp.ts). */
const PUBLIC_FILE_BODY = Math.ceil(PUBLIC_STAGED_FILE_MOST / 3) * 4 + 64 * 1024;

/** The paths this module answers: the landing, the public forms and the public command pages' doors. */
export function isTenantPublicPath(path: string): boolean {
  return path === LANDING_PATH || publicFormPath(path) !== undefined || pageCommandPath(path) !== undefined;
}

interface TenantPublicHttpOptions {
  readonly app: AppDef;
  /** The look a save changed in place (tenantLook.ts): what the landing and a form's page wear. */
  readonly look?: () => TenantLook | undefined;
  /** The App's compiled components: where a public form's input components are served, for its page. */
  readonly components?: CompiledComponents;
  /** The human check `auth.challenge` names (commands/challenges.ts): the App's, one for every tenant, its secret held in
      the verifier and never in an answer. Its widget — the script, the global and the public site key — is all a page
      is told. Absent: the App names none. */
  readonly challenge?: HumanCheck;
  /** A form's choices from a table, read for the tenant the request's intake address places (tenantPublicChoices.ts). */
  readonly choices?: (address: string | undefined, key: string, form: AppFormView, input: AppCommandField[]) => Promise<AppCommandField[]>;
  /** A tenant's own intake address, as its profile row holds it now (tenantEnrollment.ts `addresses`): how this App's
      mapped host places a request, through the same resolution and fence as a link's `?via=`. */
  readonly hostAddress?: (tenant: string) => Promise<string | undefined>;
  /** The intake address of the tenant a visitor's public address (`?via=`, `public.address`) places, or nothing when it
      places none. A public page's visitor carries the address its reads are placed by, which is not the tenant's intake
      address, so a page's run is placed through this. Absent (no public reads): a carried address places nobody. */
  readonly pageAddress?: (carried: string) => Promise<string | undefined>;
  /** The deployment's public intake; absent when the App has no public form or public command page. */
  readonly submit?: TenantIntake['submit'];
  /** A saved form's resume on the same intake. */
  readonly resume?: TenantIntake['resume'];
  /** A file held for a stock form's command, in the place its address resolves to. */
  readonly hold?: TenantIntake['hold'];
  readonly bound: Bound;
  readonly basePath: string;
  readonly assertActive: () => void;
  /** Optional explicitly PUBLIC read owner. Native tenant membership is never
   * manufactured to serve a public page. Absent, the static base is served. */
  readonly branding?: (req: IncomingMessage, url: URL) => Promise<BrandingPresentation | undefined>;
  /** The published look of the tenant a form link's intake address (`?via=`) places, for that form's read: a public
      form reached through a tenant's own link wears that tenant's name, as one on its mapped host does. Absent, or
      for an address that places no tenant, the App's own. */
  readonly placedBranding?: (address: string, form: string) => Promise<BrandingPresentation | undefined>;
}

export function createTenantPublicHttp(options: TenantPublicHttpOptions) {
  /** One file, held for the visitor in the place the intake address resolves to: charged to the client's day of bytes,
      the cookie set here where they have none, and the answer the ordinary host's (commands/stagedFileHttp.ts), a
      refusal said as it says it. */
  const holdFile = async (req: IncomingMessage, res: ServerResponse, key: string, client: string, address: string | undefined) => {
    const length = Number(req.headers['content-length']);
    const refuse = (status: number, code: string, error: string) => send(res, status, { code, error });
    if (Number.isFinite(length) && length > PUBLIC_FILE_BODY) {
      // The rest of the body is left unread, so the connection carries nothing after the answer.
      res.setHeader('connection', 'close');
      return refuse(413, 'too_large', 'This file is too large.');
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, PUBLIC_FILE_BODY);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 413) res.setHeader('connection', 'close');
      return refuse(error.status, error.status === 413 ? 'too_large' : 'invalid_input', error.message);
    }
    if (await publicFileBytesRefused(res, client, body)) return;
    let visitor = readVisitorToken(req, key);
    const fresh = !visitor;
    visitor ??= newVisitorToken();
    try {
      const held = await options.hold!({ form: key, address, body, visitor });
      assertActive();
      if (fresh) res.setHeader('set-cookie', cookieUnder(basePath, visitorCookie(key, visitor, secureRequest(req, bound.trustedProxies))));
      send(res, 200, held);
    } catch (error) {
      if (error instanceof StageRefusal) return refuse(error.status, error.code, error.message);
      // Never what failed or where the file would have landed.
      refuse(503, 'temporarily_unavailable', 'Files cannot be held just now.');
    }
  };
  const { app: base, submit, resume, hold, bound, basePath, assertActive } = options;
  const forms = publicForms(base);
  const pages = tenantPublicPages(base);
  const invalid = (res: ServerResponse) => send(res, 400, { code: 'invalid_input', error: 'This request is not valid.' });
  /** A public command page's ticket or submission, in the ordinary host's order (http/pageCommandRoutes.ts), each guard
      before anything later is read; what is added is the intake address, placed as a form's submission is. */
  const answerPage = async (req: IncomingMessage, res: ServerResponse, url: URL, match: { page: string; command?: string }) => {
    const refuse = (status: number, code: string, error: string) => send(res, status, { code, error });
    const named = pages.get(match.page);
    // A page that is not a public door, or a command it does not name, reads from outside as one that does not exist.
    if (!named || (match.command !== undefined && !named.includes(match.command))) return refuse(404, 'not_found', 'No such page.');
    const reading = match.command === undefined;
    if (reading ? req.method !== 'GET' && req.method !== 'HEAD' : req.method !== 'POST') {
      res.setHeader('allow', reading ? 'GET, HEAD' : 'POST');
      return refuse(405, 'method_not_allowed', reading ? 'A ticket is read with GET.' : 'A page runs a command with POST.');
    }
    // A ticket's URL says nothing; a submission's says at most its address, once.
    const keys = [...url.searchParams.keys()];
    if ((reading ? keys.length > 0 : keys.some((key) => key !== 'via')) || url.searchParams.getAll('via').length > 1) return invalid(res);
    const carried = url.searchParams.get('via') ?? undefined;
    const placement = tenantPublicPlacement(req, base.id, carried, options.hostAddress);
    if (placement.conflict) return invalid(res);
    const address = clientAddress(req, bound.trustedProxies);
    /* The budget a public form spends, shared rather than a second allowance: this client's part first, the ceiling
       every visitor shares only once the ticket and the check have passed. */
    const budgets = [reading ? 'read' : 'submit'] as Array<'read' | 'submit'>;
    if (await rateLimited(res, budgets, address, 'client')) return;
    if (reading) {
      if (await rateLimited(res, budgets, address, 'all')) return;
      return send(res, 200, { ticket: issueTicket(base.id, match.page) });
    }
    // The page's own origin only, as on the ordinary host: a write door open to the public stands for no embed host.
    if (doorRefusal(req, bound, { writing: true, origin: 'always', sameSite: true }))
      return refuse(403, 'cross_origin', 'This page takes submissions from its own page only.');
    const refused = ticketRefusal(req.headers[TICKET_HEADER], base.id, match.page);
    if (refused) return refuse(refused === 'early' ? 425 : 403, 'ticket_refused', ticketMessage(refused));
    const tooLarge = () => {
      /* The rest of the body is left unread, so the connection carries nothing after the answer. */
      res.setHeader('connection', 'close');
      refuse(413, 'too_large', 'This submission is too large.');
    };
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_COMMAND_BYTES) return tooLarge();
    try {
      const held = await holdCommandBody(req);
      if (held === 'too_large') return tooLarge();
      if (held === 'too_slow') {
        res.setHeader('connection', 'close');
        return refuse(408, 'too_slow', 'This submission took too long to arrive.');
      }
    } catch {
      return; // The visitor went away before the body arrived; there is no one to answer.
    }
    if (!(await challengeAnsweredBy(options.challenge, req, address))) return refuse(403, 'challenge_failed', CHALLENGE_REFUSAL);
    if (await rateLimited(res, budgets, address, 'all')) return;
    assertActive();
    if (!submit) return refuse(403, 'forbidden', 'This page is not accepting submissions.');
    const controller = new AbortController(),
      abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      if (req.aborted || res.destroyed) abort();
      const { input, submission } = parseSubmission(await commandBody(req));
      /* A mapped host places the run with its tenant's intake address, as a form's; an address the visitor carries is
         the public one its page was read under, turned into that tenant's intake address. Either way the intake
         resolves and fences it, and one that places nobody lands in triage. */
      const placed = carried === undefined ? await placement.address() : await options.pageAddress?.(carried);
      assertActive();
      // A public submission's writes are the page's, as a form's are: the record history says so.
      const result = await attributeWrites({ via: 'form' }, () =>
        submit({ form: match.page, command: match.command, address: placed, input, submission }, { signal: controller.signal }),
      );
      const reference = (result.result as { reference?: unknown } | null)?.reference;
      if (typeof reference !== 'string' || !reference.trim() || reference.length > 64)
        throw new BusinessCommandExecutionError('invalid_result', 'unknown');
      send(res, 200, { reference, receipt: { id: result.receiptId, status: result.status }, ...publicMessage(result.result) });
    } catch (error) {
      if (error instanceof CommandBodyTooLarge) return tooLarge();
      // Fixed public messages and the field they are about; never the input, never where it landed.
      const failure = businessCommandHttpError(
        error instanceof CommandInputError ? new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field) : error,
      );
      const { outcome: _outcome, ...body } = failure.body;
      send(res, failure.status, body);
    } finally {
      req.off('aborted', abort);
      res.off('close', abort);
    }
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    assertActive();
    const app = wearing(base, options.look?.());
    // rawHeaders, so a duplicate the convenience map folds still counts.
    const tenantHeaders = new Set(Object.values(headers) as string[]);
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (tenantHeaders.has(req.rawHeaders[index].toLowerCase())) {
        res.setHeader('cache-control', 'no-store');
        invalid(res);
        return;
      }
    }
    const page = pageCommandPath(url.pathname);
    if (page) {
      res.setHeader('cache-control', 'no-store');
      await answerPage(req, res, url, page);
      return;
    }
    let branding = baseRecordBranding(app);
    let hostDressed = false;
    if ((req.method === 'GET' || req.method === 'HEAD') && options.branding) {
      try {
        const resolved = await options.branding(req, url);
        if (
          resolved &&
          !resolved.private &&
          resolved.value.identity.app === app.id &&
          resolved.value.identity.tenant ===
            (recordBrandingSpec(app) ? brandingTenant(req, app, url) : (getTenantHostIntent(req)?.tenant ?? null))
        ) {
          branding = resolved;
          hostDressed = true;
        }
      } catch {
        /* A public read that fails supplies only the base. */
      }
      /* No host named a tenant, but the link carries its intake address: the form wears that tenant's published look.
         Only the form's own read — the sign-in page and the landing are dressed only when the host names the tenant. */
      const via = url.searchParams.get('via');
      const formId = publicFormPath(url.pathname)?.id;
      if (!hostDressed && via && formId !== undefined && options.placedBranding) {
        try {
          const placed = await options.placedBranding(via, formId);
          if (placed && !placed.private && placed.value.identity.app === app.id) branding = placed;
        } catch {
          /* An address that cannot be placed leaves the App's own name. */
        }
      }
      assertActive();
    }
    /* A tenant's saved look dresses the page and never decides whether it is served: a presentation that cannot be
       worn leaves the App's own, as a read that failed does above (a field report: a saved name closed every form). */
    let visible: typeof app;
    try {
      visible = withRecordBranding(app, branding);
    } catch {
      branding = baseRecordBranding(app);
      visible = withRecordBranding(app, branding);
    }
    const presentation = {
      app: {
        id: visible.id,
        name: visible.name,
        ...(visible.ui.theme ? { theme: visible.ui.theme } : {}),
        ...(visible.ui.customThemes ? { customThemes: visible.ui.customThemes } : {}),
      },
    };
    if (url.pathname === LANDING_PATH) {
      answerLanding(req, res, app, false, branding);
      return;
    }
    const match = publicFormPath(url.pathname)!;
    res.setHeader('cache-control', 'no-store');
    // A wrong key and a missing feature read the same from outside.
    if (!forms.length) {
      send(res, 404, { error: `No such endpoint: ${url.pathname}` });
      return;
    }
    const reading = req.method === 'GET' || req.method === 'HEAD';
    const named = match.id === undefined ? undefined : forms.find(([key]) => key === match.id);
    const files = match.action === 'files';
    const action = named && !files ? savedFormAction(named[1], match) : undefined;
    // A saved form's paths are served only on a form that has them.
    if (match.action !== undefined && !files && !action) {
      send(res, 404, { code: 'no_such_form', error: 'No such form.' });
      return;
    }
    // Before any budget is taken, as on the ordinary host.
    if ((!reading || match.action !== undefined) && (req.method !== 'POST' || match.id === undefined)) {
      res.setHeader('allow', match.id === undefined ? 'GET, HEAD' : match.action !== undefined ? 'POST' : 'GET, HEAD, POST');
      send(res, 405, { error: files ? 'A file is held with POST.' : 'A public form takes GET to read it and POST to submit it.' });
      return;
    }
    // The list of forms says nothing in its URL; a form's read and a submission say at most its address, once: the
    // read's places its choices from a table (tenantPublicChoices.ts), the submission's places the submission.
    const keys = [...url.searchParams.keys()];
    if (
      (reading && match.id === undefined ? keys.length > 0 : keys.some((key) => key !== 'via')) ||
      url.searchParams.getAll('via').length > 1
    ) {
      invalid(res);
      return;
    }
    /* Where this request lands: the read's choices, the submission and every saved step are placed by this one rule
       (tenantPublicPlacement.ts). This App's mapped host names its tenant, and an address there would name a second:
       refused for the read, the submission and every saved step alike, as a visitor's read and a page's flags are. */
    const placement = tenantPublicPlacement(req, base.id, url.searchParams.get('via') ?? undefined, options.hostAddress);
    if (placement.conflict) {
      invalid(res);
      return;
    }
    if (doorRefusal(req, bound, { writing: !reading })) {
      send(res, 403, { code: 'forbidden', error: 'This form accepts submissions from its own page only.' });
      return;
    }
    const address = clientAddress(req, bound.trustedProxies);
    const budgets = files ? (['file'] as const) : publicFormBudget(reading, named?.[1], action, req, match.id);
    /* In the ordinary host's order (formRoutes.ts): this client's budgets first, then — on a door that writes — the
       App's human check, and the ceiling every visitor shares only once the request has proved what it can, so a
       tokenless flood from many addresses never spends what a person's submission needs. */
    if (await rateLimited(res, [...budgets], address, 'client')) return;
    /* A key that names no form is answered from this visitor's own budget, before the check and the ceiling every
       visitor shares: a flood of mistyped or invented keys never spends what a person's submission needs. */
    if (match.id !== undefined && !named) {
      send(res, 404, { code: 'no_such_form', error: 'No such form.' });
      return;
    }
    if (!reading && named && (action?.kind === 'submit' || action?.kind === 'step')) {
      /* Said from the length before anything leaves this server: a body the run would refuse never costs a provider's call. */
      const length = Number(req.headers['content-length']);
      const tooLarge = () => {
        /* The rest of the body is left unread, so the connection carries nothing after the answer. */
        res.setHeader('connection', 'close');
        send(res, 413, { code: 'too_large', error: 'This submission is too large.' });
      };
      if (Number.isFinite(length) && length > MAX_COMMAND_BYTES) {
        tooLarge();
        return;
      }
      /* And by reading it: a chunked body says no length, so the envelope is held while it arrives, before the check, and
         for no longer than the hold allows. */
      try {
        const held = await holdCommandBody(req);
        if (held === 'too_large') {
          tooLarge();
          return;
        }
        if (held === 'too_slow') {
          /* A body still arriving at the hold's deadline (BODY_HOLD_MS) is abandoned unread, as one past the envelope is. */
          res.setHeader('connection', 'close');
          send(res, 408, { code: 'too_slow', error: 'This submission took too long to arrive.' });
          return;
        }
      } catch {
        return; // The visitor went away before the body arrived; there is no one to answer.
      }
      /* Asked before the body is parsed or run, on every door that writes: a stock form's submission, a saved form's steps
         and its submit. The same refusal for a missing, wrong, spent or late token, wherever the address points. */
      if (!(await challengeAnsweredBy(options.challenge, req, address))) {
        send(res, 403, { code: 'challenge_failed', error: CHALLENGE_REFUSAL });
        return;
      }
    }
    /* A file held for a form writes too, so it asks the same check, from its header before the body is read: unasked, it
       was the one door a script could fill without answering. A provider's token answers one request: one per file. */
    if (files && named && !(await challengeAnsweredBy(options.challenge, req, address))) {
      send(res, 403, { code: 'challenge_failed', error: CHALLENGE_REFUSAL });
      return;
    }
    if (await rateLimited(res, [...budgets], address, 'all')) return;
    assertActive();
    /* A placement that names no tenant sends the submission to triage. */
    const placing = () => placement.address();
    if (reading && match.id === undefined) {
      send(res, 200, { ...presentation, forms: forms.map(([key, form]) => presentForm(key, form)) });
      return;
    }
    const found = forms.find(([key]) => key === match.id);
    if (!found) {
      send(res, 404, { code: 'no_such_form', error: 'No such form.' });
      return;
    }
    const [key, form] = found;
    /* A file held for the form's command (commands/stagedFiles.ts), for this visitor by their cookie. A form saved on
       every step, or one this host cannot take, holds none: closed for good, as its submission is. */
    if (files) {
      if (!hold || !submit || isSavedForm(form)) {
        send(res, 403, { code: 'forbidden', error: 'This form is not accepting submissions.' });
        return;
      }
      await holdFile(req, res, key, address, await placing());
      return;
    }
    if (reading) {
      const components = publicFormComponents(app.id, options.components, form);
      /* The provider's widget the stock form draws: what the browser may be told, and nothing of the verifier's. */
      const widget = options.challenge?.widget;
      const served = presentForm(key, form);
      const input = options.choices ? await options.choices(await placing(), key, form, served.input) : served.input;
      assertActive();
      send(res, 200, {
        ...presentation,
        form: { ...served, input, ...(components ? { components } : {}), ...(widget ? { challenge: widget } : {}) },
      });
      return;
    }
    // A form this host has no way to take is closed for good, not for a while (formRoutes.ts says the same).
    if (!submit || (isSavedForm(form) && !resume)) {
      send(res, 403, { code: 'forbidden', error: 'This form is not accepting submissions.' });
      return;
    }
    const controller = new AbortController(),
      abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    if (isSavedForm(form)) {
      try {
        if (req.aborted || res.destroyed) abort();
        // A public submission's writes are the form's, as on the ordinary host: the record history says so.
        const intake: SavedFormIntake = {
          submit: (request, execution) => attributeWrites({ via: 'form' }, () => submit(request, execution)),
          resume: (request) => resume!(request),
        };
        const reply = await dispatchIntakeSavedFormHttp({
          req,
          key,
          form: form as SavedForm,
          action: action!,
          intake,
          signal: controller.signal,
          address: await placing(),
          secure: secureRequest(req, bound.trustedProxies),
        });
        assertActive();
        if (reply.cookies?.length)
          res.setHeader(
            'set-cookie',
            reply.cookies.map((cookie) => cookieUnder(basePath, cookie)),
          );
        send(res, reply.status, reply.body);
      } finally {
        req.off('aborted', abort);
        res.off('close', abort);
      }
      return;
    }
    try {
      if (req.aborted || res.destroyed) abort();
      const { input, submission, extra } = parseSubmission(await commandBody(req), ['trap']);
      /* The stock form's decoy, filled: answered as an accepted submission is, and written nowhere (formRoutes.ts). */
      if (typeof extra.trap === 'string' && extra.trap.trim()) {
        countDecoy(form.command.id);
        send(res, 200, decoyReply());
        return;
      }
      const placed = await placing();
      assertActive();
      const result = await attributeWrites({ via: 'form' }, () =>
        submit(
          {
            form: key,
            address: placed,
            input,
            submission,
            // Whose held files the submission may take: this visitor's, by their own cookie.
            ...(readVisitorToken(req, key) ? { visitor: readVisitorToken(req, key) } : {}),
          },
          { signal: controller.signal },
        ),
      );
      const reference = (result.result as { reference?: unknown } | null)?.reference;
      // The receipt is durable either way; a handler that returned no
      // reference has left the applicant nothing to quote, which is its bug.
      if (typeof reference !== 'string' || !reference.trim() || reference.length > 64)
        throw new BusinessCommandExecutionError('invalid_result', 'unknown');
      send(res, 200, { reference, receipt: { id: result.receiptId, status: result.status } });
    } catch (error) {
      // Fixed public messages and the field they are about; never the input, never where it landed.
      const failure = businessCommandHttpError(
        error instanceof CommandInputError ? new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field) : error,
      );
      const { outcome: _outcome, ...body } = failure.body;
      send(res, failure.status, body);
    } finally {
      req.off('aborted', abort);
      res.off('close', abort);
    }
  };
}
