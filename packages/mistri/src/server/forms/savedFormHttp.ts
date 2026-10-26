/**
 * A saved form over HTTP: the paths under `/api/forms/<key>` a form saved on
 * every step adds, and how each is answered. The same on the ordinary host
 * and a tenant App's (tenantPublicHttp.ts); only the writer differs.
 *
 *   POST /api/forms/<key>/steps/<step>  save one step          → { saved: '<step>' }
 *   POST /api/forms/<key>               submit the application → { reference, receipt }
 *   POST /api/forms/<key>/resume        which steps are saved  → { saved: ['<step>', …] }
 *   POST /api/forms/<key>/status        the status check       → { status: { … } }
 *   POST /api/forms/<key>/claim         this browser's claim   → { claim } · { linked }   (formLinkHttp.ts)
 *   POST /api/forms/<key>/link          signed in, a status check, then the link → { linked, status }
 *   POST /api/forms/<key>/mine          signed in: the account's own applications → { applications }
 *   POST /api/forms/<key>/stepup        the status check and a code to the email on file → { sent } · { status, details }   (statusStepUp.ts)
 *   POST /api/forms/<key>/details       while a step-up's session lives → { status, details }
 *   POST /api/forms/<key>/found         signed in, a verified email: applications that captured it → { linked, found }
 *   POST /api/forms/<key>/verify-email  the applicant proves the address they typed → { sent } · { verified }
 *
 * Nothing here answers anything an applicant typed. A step's reply is the
 * step's id; the resume's the saved steps' ids; the status check's a state in
 * the author's words. The applicant's place is the cookie, set on the first
 * step and cleared on submit or on any answer that the draft is gone.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef, AppFormView } from '../../shared/app.js';
import { isSavedForm, platformColumns, type AppFormSave } from '../../shared/appSavedForms.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { bindHttpBusinessCommands } from '../commands/businessCommandLoader.js';
import { businessCommandHttpError, commandBody } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError, executeBusinessCommand, type BusinessCommandResult } from '../commands/businessCommandExecution.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { CaptureCommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { commandCatalog, type CommandCatalog } from '../commands/commandDb.js';
import { CommandInputError } from '../commands/commandPayload.js';
import { parseSubmission, publicPrincipal } from '../commands/formHttp.js';
import { logicalResource } from '../../shared/app.js';
import {
  DRAFT_GONE,
  draftCookie,
  draftTokenHash,
  isDraftGone,
  newDraftToken,
  readDraftProgress,
  readDraftToken,
  type SavedDraftRun,
} from './savedForms.js';
import { savedFormRoots } from './savedFormChecks.js';
import { checkApplicationStatus, parseStatusRequest, settle, statusNotFound, type StatusAnswer } from './statusCheck.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { burnClaim, claimCookie, newClaim, readClaim } from './formLink.js';
import { claimReply, foundReply, linkReply, mineReply, verifyEmailReply, type LinkAccount, type LinkedForm } from './formLinkHttp.js';
import { detailsReply, stepUpReply, type StepUpForm } from './statusStepUp.js';
import { emailOf } from '../serviceConnections.js';

export type SavedFormAction =
  | { kind: 'step'; step: string }
  | { kind: 'submit' }
  | { kind: 'resume' }
  | { kind: 'status' }
  | { kind: 'claim' }
  | { kind: 'link' }
  | { kind: 'mine' }
  | { kind: 'stepup' }
  | { kind: 'details' }
  | { kind: 'found' }
  | { kind: 'verify-email' };
export type SavedForm = AppFormView & { save: AppFormSave };
type SavedStep = { id: string; label: string; command: { id: string; version: number } };

/** The saved form's steps, in order, each with its command. */
export const savedSteps = (form: SavedForm): SavedStep[] => form.steps as unknown as SavedStep[];

/** What the route decided a request is, from the path and the form; undefined for a path the form does not serve. */
export function savedFormAction(form: AppFormView, sub: { action?: string; step?: string }): SavedFormAction | undefined {
  if (!isSavedForm(form)) return sub.action === undefined ? { kind: 'submit' } : undefined;
  if (sub.action === undefined) return { kind: 'submit' };
  if (sub.action === 'resume') return { kind: 'resume' };
  if (sub.action === 'status') return form.statusCheck ? { kind: 'status' } : undefined;
  if (sub.action === 'claim') return form.link?.sameDevice ? { kind: 'claim' } : undefined;
  if (sub.action === 'link') return form.link?.statusCheck ? { kind: 'link' } : undefined;
  if (sub.action === 'mine') return form.link ? { kind: 'mine' } : undefined;
  if (sub.action === 'stepup' || sub.action === 'details') return form.statusCheck?.stepUp ? { kind: sub.action } : undefined;
  if (sub.action === 'found') return form.link?.email ? { kind: 'found' } : undefined;
  if (sub.action === 'verify-email') return form.link?.email?.verified ? { kind: 'verify-email' } : undefined;
  if (sub.action === 'steps' && sub.step && savedSteps(form).some((step) => step.id === sub.step)) return { kind: 'step', step: sub.step };
  return undefined;
}

/** The request's plan: which command runs, and how it finds its application. */
interface SavedFormPlan {
  readonly command: { id: string; version: number };
  readonly phase: SavedDraftRun['phase'];
  readonly step: string;
  /** The token hash the executor finds or creates the root by. */
  readonly token: string;
  /** Set on the first step without a live cookie: the new token the reply's cookie carries. */
  readonly issued?: string;
  /** Set on a submit that leaves a claim in this browser (formLink.ts). */
  readonly claim?: { token: string; hash: string; until: string };
}

/**
 * Plan a step or the submit from the cookie. The first step without a cookie
 * starts an application; with one it saves into it (a "Change" from review).
 * Every other step and the submit need the cookie, and are the one uniform
 * refusal without it.
 */
function planSavedForm(
  req: Pick<IncomingMessage, 'headers'>,
  key: string,
  form: SavedForm,
  action: { kind: 'step'; step: string } | { kind: 'submit' },
): SavedFormPlan {
  const steps = savedSteps(form);
  const cookie = readDraftToken(req, key);
  if (action.kind === 'submit') {
    if (!cookie) throw goneError();
    return {
      command: form.command,
      phase: 'submit',
      step: 'submit',
      token: draftTokenHash(cookie),
      ...(form.link?.sameDevice ? { claim: newClaim(new Date()) } : {}),
    };
  }
  const index = steps.findIndex((step) => step.id === action.step);
  const step = steps[index];
  if (!cookie) {
    if (index !== 0) throw goneError();
    const fresh = newDraftToken();
    return { command: step.command, phase: 'start', step: step.id, token: fresh.hash, issued: fresh.token };
  }
  return { command: step.command, phase: 'step', step: step.id, token: draftTokenHash(cookie) };
}

function goneError(): BusinessCommandExecutionError {
  return new BusinessCommandExecutionError('not_found', 'not_applied', undefined, undefined, DRAFT_GONE);
}

/** The executor's draft, once the host knows the tables a root may be in where this request lands. */
function draftRun(form: SavedForm, plan: SavedFormPlan, roots: readonly string[]): SavedDraftRun {
  const same = form.link?.sameDevice;
  return Object.freeze({
    phase: plan.phase,
    step: plan.step,
    token: plan.token,
    save: form.save,
    order: Object.freeze(savedSteps(form).map((step) => step.id)),
    roots: Object.freeze([...roots]),
    owned: Object.freeze(platformColumns(form)),
    ...(plan.claim && same ? { claim: Object.freeze({ columns: same, hash: plan.claim.hash, until: plan.claim.until }) } : {}),
  });
}

/** A reply's body and the cookies it sets, for the host to send. */
export interface SavedFormReply {
  status: number;
  body: unknown;
  cookies?: string[];
}

/** The answer to a step or the submit, from its result or its refusal. */
function savedFormReply(
  key: string,
  form: SavedForm,
  plan: SavedFormPlan,
  outcome: { result: BusinessCommandResult } | { error: unknown },
  secure: boolean,
): SavedFormReply {
  const days = form.save.resume.days;
  if ('error' in outcome) {
    const error =
      outcome.error instanceof CommandInputError
        ? new BusinessCommandExecutionError('invalid_input', 'not_applied', outcome.error.field)
        : outcome.error instanceof AppAccessDenied
          ? new BusinessCommandExecutionError('forbidden')
          : outcome.error;
    const failure = businessCommandHttpError(error);
    const { outcome: _outcome, ...body } = failure.body;
    // A draft that is gone is gone for this browser too: the next first step starts afresh.
    return { status: failure.status, body, ...(isDraftGone(error) ? { cookies: [draftCookie(key, null, days, secure)] } : {}) };
  }
  const { result } = outcome;
  if (plan.phase === 'submit') {
    const reference = (result.result as { reference?: unknown } | null)?.reference;
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 64) {
      return savedFormReply(key, form, plan, { error: new BusinessCommandExecutionError('invalid_result', 'unknown') }, secure);
    }
    // The claim rides beside the receipt: this browser may add the application to an account for a while (formLink.ts).
    const claim = plan.claim && !result.replayed ? [claimCookie(key, plan.claim.token, secure)] : [];
    return {
      status: 200,
      body: { reference, receipt: { id: result.receiptId, status: result.status } },
      cookies: [draftCookie(key, null, days, secure), ...claim],
    };
  }
  // A replayed first step made no new root: the cookie the first answer set is the one that names it.
  return {
    status: 200,
    body: { saved: plan.step },
    ...(plan.issued && !result.replayed ? { cookies: [draftCookie(key, plan.issued, days, secure)] } : {}),
  };
}

/** The resume's answer: the saved steps' ids, or none — the same for no cookie, a forged one and a finished one. */
async function resumeReply(
  req: Pick<IncomingMessage, 'headers'>,
  key: string,
  read: (token: string) => Promise<string[]>,
): Promise<SavedFormReply> {
  const cookie = readDraftToken(req, key);
  const saved = cookie ? await read(draftTokenHash(cookie)) : [];
  return { status: 200, body: { saved } };
}

/** The status check's answer, held to its floor of time whatever it found. `read` opens the reads where this request lands. */
async function statusReply(
  key: string,
  form: SavedForm,
  body: unknown,
  roots: readonly string[],
  catalog: CommandCatalog,
  account: string | undefined,
  read: (run: (records: WriteTransaction) => Promise<StatusAnswer>) => Promise<StatusAnswer>,
  appId: string,
): Promise<SavedFormReply> {
  const started = Date.now();
  const check = form.statusCheck!;
  const request = parseStatusRequest(body, check);
  try {
    if (!request)
      return {
        status: 400,
        body: {
          code: 'invalid_input',
          message: 'Give the reference and each detail asked.',
          error: 'Give the reference and each detail asked.',
        },
      };
    const answer = await read((records) =>
      checkApplicationStatus({
        check,
        save: form.save,
        roots,
        records,
        request,
        form: key,
        catalog,
        appId,
        ...(form.link ? { link: form.link } : {}),
        ...(account ? { account } : {}),
      }),
    );
    if (!answer.found) return { status: 404, body: statusNotFound(Boolean(form.link)) };
    return { status: 200, body: { status: answer.status } };
  } finally {
    await settle(started);
  }
}

/* ---------- the ordinary host ---------- */

/** The start command's catalog and the root tables in it, from the App's own resources. */
function rootsOf(
  app: AppDef,
  commands: BusinessCommandRegistry,
  form: SavedForm,
  schema: Parameters<typeof commandCatalog>[0],
): { roots: string[]; catalog: CommandCatalog } {
  const start = commands[savedSteps(form)[0].command.id];
  const catalog = start && commandCatalog(schema, start.read, (local) => logicalResource(app, start.source, local));
  if (!start || !catalog) throw new BusinessCommandExecutionError('temporarily_unavailable');
  return { roots: savedFormRoots(form, start, catalog), catalog };
}

/** One request to a saved form on the ordinary host, under the public principal, through the same executor as every command. */
export async function dispatchSavedFormHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  connection: string;
  key: string;
  form: SavedForm;
  action: SavedFormAction;
  secure: boolean;
  events?: CommandJournalAppScope;
  captureFlags?: CaptureCommandFlags;
  /** The verified session's account, when there is one: the one a link names, never a request's. */
  account?: LinkAccount;
}): Promise<SavedFormReply> {
  const { req, res, registry, app, commands, connection, key, form, action, secure, events, account } = options;
  const captureFlags = options.captureFlags;
  const releases: Array<() => void> = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    const body = await commandBody(req);
    const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
    const { binding } = bindHttpBusinessCommands(app, commands, resources, (owner) => registry.configOf(owner)?.writable === true, events);
    const principal = publicPrincipal(app.id, key);
    const { roots } = rootsOf(app, commands, form, resources.schema);
    const startId = savedSteps(form)[0].command.id;
    // A read through the first step's own transaction: its footprint names every root.
    const reading = <T>(run: (records: WriteTransaction) => Promise<T>) => binding.authorize(startId, principal).transaction!(run);
    const catalog = binding.authorize(startId, principal).catalog;
    if (
      action.kind === 'claim' ||
      action.kind === 'link' ||
      action.kind === 'mine' ||
      action.kind === 'found' ||
      action.kind === 'verify-email'
    ) {
      const mail = emailOf(registry);
      const linking = {
        req,
        key,
        form: form as LinkedForm,
        body,
        roots,
        catalog,
        secure,
        reading,
        appName: app.name,
        appId: app.id,
        ...(mail ? { mail } : {}),
        ...(account ? { account } : {}),
      };
      return action.kind === 'claim'
        ? await claimReply(linking)
        : action.kind === 'link'
          ? await linkReply(linking)
          : action.kind === 'found'
            ? await foundReply(linking)
            : action.kind === 'verify-email'
              ? await verifyEmailReply(linking)
              : await mineReply(linking);
    }
    if (action.kind === 'stepup' || action.kind === 'details') {
      const stepping = {
        req,
        key,
        form: form as unknown as StepUpForm,
        body,
        roots,
        catalog,
        secure,
        reading,
        appName: app.name,
        appId: app.id,
        mail: emailOf(registry),
        ...(account ? { account: account.id } : {}),
      };
      return action.kind === 'stepup' ? await stepUpReply(stepping) : await detailsReply(stepping);
    }
    if (action.kind === 'resume') {
      return await resumeReply(req, key, (token) =>
        reading((records) =>
          readDraftProgress(
            records,
            catalog,
            roots,
            form.save,
            token,
            savedSteps(form).map((step) => step.id),
            new Date(),
          ),
        ),
      );
    }
    if (action.kind === 'status') return await statusReply(key, form, body, roots, catalog, account?.id, (run) => reading(run), app.id);
    let plan: SavedFormPlan;
    try {
      plan = planSavedForm(req, key, form, action);
    } catch (error) {
      return savedFormReply(key, form, { command: form.command, phase: 'step', step: '', token: '' }, { error }, secure);
    }
    try {
      const { input, submission } = parseSubmission(body);
      if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
      const authorized = binding.authorize(plan.command.id, principal);
      const flags = await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
      const result = await executeBusinessCommand(
        binding,
        principal,
        {
          command: plan.command.id,
          commandVersion: plan.command.version,
          key: {},
          expectedVersion: 0,
          idempotencyKey: submission,
          input,
        },
        {
          signal: controller.signal,
          flags,
          draft: draftRun(form, plan, roots),
          ...(typeof res.getHeader('x-request-id') === 'string' ? { requestId: String(res.getHeader('x-request-id')) } : {}),
        },
      );
      const reply = savedFormReply(key, form, plan, { result }, secure);
      // Another application submitted from this browser burns the claim the last one left.
      const earlier = plan.phase === 'submit' && reply.status === 200 ? readClaim(req, key) : undefined;
      if (earlier && form.statusCheck && form.link)
        await reading((records) => burnClaim(records, catalog, roots, form as LinkedForm, earlier));
      return reply;
    } catch (error) {
      return savedFormReply(key, form, plan, { error }, secure);
    }
  } catch (error) {
    const failure = businessCommandHttpError(
      error instanceof CommandInputError ? new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field) : error,
    );
    const { outcome: _outcome, ...body } = failure.body;
    return { status: failure.status, body };
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
    for (const release of releases.reverse()) release();
  }
}

/* ---------- a tenant App's host ---------- */

/** What a tenant App's public intake does for a saved form (tenant/tenantIntake.ts). Each call resolves the address itself. */
export interface SavedFormIntake {
  submit(
    request: {
      form: string;
      address: unknown;
      input: unknown;
      submission: string;
      draft: { phase: SavedDraftRun['phase']; step: string; token: string };
    },
    execution: { signal: AbortSignal },
  ): Promise<BusinessCommandResult>;
  resume(request: { form: string; address: unknown; token: string }): Promise<string[]>;
}

/**
 * One request to a saved form on a tenant App's host: the same plan and the
 * same answers as the ordinary host's, with the intake address carried to the
 * intake, which decides where the draft is and binds the token to it. The
 * status check and the link are not served there (savedFormChecks.ts).
 */
export async function dispatchIntakeSavedFormHttp(options: {
  req: IncomingMessage;
  key: string;
  form: SavedForm;
  action: SavedFormAction;
  secure: boolean;
  /** The request's `?via=`, unchecked: only the intake reads it. */
  address: unknown;
  intake: SavedFormIntake;
  signal: AbortSignal;
}): Promise<SavedFormReply> {
  const { req, key, form, action, secure, address, intake, signal } = options;
  try {
    if (action.kind === 'resume') return await resumeReply(req, key, (token) => intake.resume({ form: key, address, token }));
    if (action.kind !== 'step' && action.kind !== 'submit') return { status: 404, body: { code: 'no_such_form', error: 'No such form.' } };
    const body = await commandBody(req);
    let plan: SavedFormPlan;
    try {
      plan = planSavedForm(req, key, form, action);
    } catch (error) {
      return savedFormReply(key, form, { command: form.command, phase: 'step', step: '', token: '' }, { error }, secure);
    }
    try {
      const { input, submission } = parseSubmission(body);
      if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
      const result = await intake.submit(
        { form: key, address, input, submission, draft: { phase: plan.phase, step: plan.step, token: plan.token } },
        { signal },
      );
      return savedFormReply(key, form, plan, { result }, secure);
    } catch (error) {
      return savedFormReply(key, form, plan, { error }, secure);
    }
  } catch (error) {
    const failure = businessCommandHttpError(
      error instanceof CommandInputError ? new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field) : error,
    );
    const { outcome: _outcome, ...body } = failure.body;
    return { status: failure.status, body };
  }
}
