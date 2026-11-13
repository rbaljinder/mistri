/**
 * A public form's submission over HTTP: the one write a signed-out person
 * may make, and what a signed-in person makes too on a public form — it is
 * always a public submission. The route has already found the form and rate
 * limited the address; this builds the command envelope the applicant never
 * sees — the command the form names, its pinned version, no key, revision
 * zero, the submission key as the idempotency key — and runs it under a
 * public principal through the same executor, journal and audit every
 * signed-in command uses.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef, AppFormView } from '../../shared/app.js';
import { servedFormDress } from '../../shared/appForms.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { askedLocale, requestLocale } from '../app/readerLocale.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { bindHttpBusinessCommands } from './businessCommandLoader.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { CommandBodyTooLarge, commandBody } from './businessCommandHttp.js';
import { CommandInputError } from './commandPayload.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from './businessCommands.js';
import { BusinessCommandExecutionError, executeBusinessCommand, type BusinessCommandResult } from './businessCommandExecution.js';
import { forbiddenBy } from './commandErrors.js';
import type { CaptureCommandFlags } from './commandFlags.js';
import { commandFlagsOnce } from './commandFlagCapture.js';
import { describeShape } from './commandShapes.js';
import { servesLinks, withLinkUrls } from '../links/linkLookup.js';
import { withAppPublicUrls } from '../links/publicLink.js';
import { LINK_REF_PREFIX, LINK_TOKEN_PREFIX, decoyLinkUrl } from '../links/linkToken.js';

import { componentHrefs, type CompiledComponents } from '../app/appComponents.js';
import { componentMessages, frameworkWords } from '../app/appMessages.js';
import { publicFormInputIds } from '../../shared/appComponentPlaces.js';
import { publicActorId } from '../../shared/publicActor.js';
const SUBMISSION_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * What the page draws: the form under its key, its inputs and its steps,
 * less the command's id and version, which an applicant never sees.
 */
export function presentForm(key: string, form: AppFormView) {
  /* A form saved on every step asks each step's command's inputs on its step,
     and the submit's own (a confirmation, say) on the review before it. */
  const saved = form.save
    ? {
        save: {
          submit: form.command.input.map((field) => field.name),
          ...(form.statusCheck
            ? {
                statusCheck: {
                  confirm: form.statusCheck.confirm.map((item) => ({ name: item.column, label: item.label })),
                  ...(form.statusCheck.stepUp ? { stepUp: form.statusCheck.stepUp.channel ?? 'email' } : {}),
                },
              }
            : {}),
          // Which ways an application may be added to an account: the page offers only those, never a column —
          // but for the input whose address the applicant may prove, which the page already asks by that name.
          ...(form.link
            ? {
                link: {
                  ...(form.link.sameDevice ? { sameDevice: true } : {}),
                  ...(form.link.statusCheck ? { statusCheck: true } : {}),
                  ...(form.link.email ? { email: form.link.email.verified ? { prove: form.link.email.column } : {} } : {}),
                },
              }
            : {}),
        },
      }
    : {};
  return {
    id: key,
    label: form.label,
    ...(form.description === undefined ? {} : { description: form.description }),
    input: form.save ? [...(form.steps ?? []).flatMap((step) => step.command?.input ?? []), ...form.command.input] : form.command.input,
    ...saved,
    // Its steps as the intake style draws them, its style, its note and whether it reviews (appForms.ts).
    ...servedFormDress(form),
    // The command's rules over the draft, which the page checks step by step and the run again.
    ...(form.command.rules?.length ? { rules: form.command.rules } : {}),
    ...(form.submitLabel === undefined ? {} : { submitLabel: form.submitLabel }),
    ...(form.prefillable?.length ? { prefillable: form.prefillable } : {}),
    // The App's own input components standing in its inputs, by id alone: where each is served is the route's to add.
    ...(form.inputs ? { inputs: Object.fromEntries(Object.entries(form.inputs).map(([name, decl]) => [name, { id: decl.id }])) } : {}),
    ...(form.done === undefined ? {} : { done: form.done }),
  };
}

/** Where the input components a public form draws are served (`/{app}/_components/…`, componentRoutes.ts), for its
    page to load the first time it draws one; undefined where it draws none the App compiled. */
export function publicFormComponents(appId: string, compiled: CompiledComponents | undefined, form: AppFormView) {
  const wanted = publicFormInputIds(form);
  const served = wanted.size ? componentHrefs(appId, compiled) : undefined;
  const entries = Object.entries(served ?? {}).filter(([id, entry]) => wanted.has(id) && entry.kind === 'input');
  return entries.length
    ? Object.fromEntries(entries.map(([id, entry]) => [id, { href: entry.href, ...(entry.css ? { css: entry.css } : {}) }]))
    : undefined;
}

/** A public form's input components and, beside them, the App's catalog in the visitor's words: no App payload reaches
    a public form's page, so `useMessage` in a component there says from this. Neither where the form draws no
    component; no catalog for an App without one. With them, or alone, the App's words for the platform's own
    (`mistri.*`: Step 1 of 3, Back) in the same language. `app` is the loaded definition, which holds the catalogs. */
export function publicFormParts(app: AppDef, compiled: CompiledComponents | undefined, form: AppFormView, locale: string | undefined) {
  const words = frameworkWords(app, locale ?? app.ui.locale);
  const said = words ? { words } : {};
  const components = publicFormComponents(app.id, compiled, form);
  if (!components) return said;
  const messages = componentMessages(app, locale ?? app.ui.locale);
  return { components, ...(messages ? { messages } : {}), ...said };
}

/** The members a door's submission may carry beside its input and key: the stock form's decoy, which a person never
    sees and so never fills. A ticket and a challenge's token travel as headers, read before the body is. */
type SubmissionExtra = 'trap';

/** The submission body: exactly the input and the client's submission key, and the extra members this door reads. */
export function parseSubmission(
  body: unknown,
  extra: readonly SubmissionExtra[] = [],
): { input: unknown; submission: string; extra: Partial<Record<SubmissionExtra, unknown>> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandInputError();
  const keys = Object.keys(body);
  // Only the member this body was missing, which is a name of ours; an extra
  // one the sender invented is refused without being repeated.
  const missing = ['input', 'submission'].find((name) => !keys.includes(name));
  if (missing || keys.some((key) => key !== 'input' && key !== 'submission' && !(extra as readonly string[]).includes(key))) {
    throw new CommandInputError(missing);
  }
  const { input, submission } = body as { input: unknown; submission: unknown };
  if (typeof submission !== 'string' || !SUBMISSION_KEY.test(submission)) throw new CommandInputError('submission');
  const members = body as Record<string, unknown>;
  return {
    input,
    submission,
    extra: Object.fromEntries(extra.filter((name) => Object.hasOwn(members, name)).map((name) => [name, members[name]])),
  };
}

/** The public principal a public door runs under: no session, no roles, one door — a public form or a public page. */
export function publicPrincipal(appId: string, form: string): BusinessCommandActor {
  return Object.freeze({ id: publicActorId(form), appId, roles: Object.freeze([]), kind: 'public' as const, form });
}

/** What a public door answers a submission with: the reference the applicant quotes, and the receipt; a link to the
    record the command made, where its handler minted one (context.link). */
type PublicSubmissionReply = { reference: string; receipt: { id: string; status: 'applied' }; message?: string; link?: string };

/** A public command's link for its visitor, as a reply member: a rendered URL on the first answer alone. A replay
    answers without it: the URL is said once, and the receipt keeps only its reference. */
function publicLink(result: BusinessCommandResult): { link?: string } {
  const link = (result.result as { link?: unknown } | null)?.link;
  return !result.replayed && typeof link === 'string' && !link.startsWith(LINK_REF_PREFIX) && link.includes(`/l/${LINK_TOKEN_PREFIX}`)
    ? { link }
    : {};
}

/** Whether a command's declared output carries a `link`: its door's decoy then answers with one too. */
function answersLink(output: unknown): boolean {
  const described = describeShape(output);
  return described.kind === 'object' && Object.hasOwn(described.fields, 'link');
}

/** The longest thank-you a handler may return for its visitor: a sentence, not a page. */
const PUBLIC_MESSAGE_MOST = 280;

/** A public command's thank-you for its visitor, as a reply member: a literal its output declares (savedFormChecks.ts),
    so the author's fixed words, never input echoed back. Nothing when it returned none or one past a sentence. A door
    with an admission check passes `declared`, the literals the command declares: it echoes only one of those, so a
    templated sentence is never said on a door whose decoy could not have said it. */
export function publicMessage(result: unknown, declared?: readonly string[]): { message?: string } {
  const message = (result as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || !message.trim() || message.length > PUBLIC_MESSAGE_MOST) return {};
  return declared === undefined || declared.includes(message.trim()) ? { message: message.trim() } : {};
}

/** The thank-yous a command's output declares, as literals: the only words a door with a decoy says for it, so its
    filled honeypot is answered in words a real submission could have had. Empty when the output declares none. */
export function declaredMessages(output: unknown): string[] {
  const described = describeShape(output);
  if (described.kind !== 'object') return [];
  const member = described.fields.message;
  const inner = member?.kind === 'optional' ? member.item : member;
  if (inner?.kind !== 'literal') return [];
  return inner.values.flatMap((value) => {
    const said = typeof value === 'string' ? publicMessage({ message: value }).message : undefined;
    return said === undefined ? [] : [said];
  });
}

/**
 * What a door asks of a submission before it runs, with its extra members: undefined to go on, `'decoy'` to answer it
 * as accepted and write nothing (a filled honeypot), or a thrown refusal.
 */
type SubmissionAdmission = (extra: Partial<Record<SubmissionExtra, unknown>>) => Promise<'decoy' | undefined> | 'decoy' | undefined;

/** The operation owns every lease until the transaction completes, even after socket loss. */
export async function dispatchPublicFormHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  connection: string;
  key: string;
  /** The command the door runs, at the version it pins. */
  command: { id: string; version: number };
  captureFlags?: CaptureCommandFlags;
  /** The App-scope event source startup issued, when a command declares events. */
  events?: CommandJournalAppScope;
  /** The extra members this door reads, and what it asks of them first. */
  extra?: readonly SubmissionExtra[];
  admit?: SubmissionAdmission;
  /** `'thrown'`: a body past the envelope is thrown as itself (CommandBodyTooLarge), for a door that answers it 413. */
  tooLarge?: 'thrown';
  /** The visitor's token from their own cookie: the files held for them (stagedFiles.ts) are the ones the run may take. */
  visitor?: string;
}): Promise<PublicSubmissionReply> {
  const { req, res, registry, app, commands, connection, key, command, events } = options;
  const captureFlags = options.captureFlags;
  const releases: Array<() => void> = [];
  try {
    return await dispatchPublicFormSubmissionHttp({
      req,
      res,
      locale: requestLocale(app, { visitor: true, req, asked: askedLocale(req) }),
      ...(options.extra ? { extra: options.extra } : {}),
      ...(options.admit ? { admit: options.admit } : {}),
      ...(options.tooLarge ? { tooLarge: options.tooLarge } : {}),
      submit: async ({ input, submission }, execution) => {
        const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
        const { binding } = bindHttpBusinessCommands(
          app,
          commands,
          resources,
          (owner) => registry.configOf(owner)?.writable === true,
          events,
        );
        if (execution.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        const actor = publicPrincipal(app.id, key);
        const authorized = binding.authorize(command.id, actor);
        const flags = await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
        const result = await executeBusinessCommand(
          binding,
          actor,
          {
            command: command.id,
            commandVersion: command.version,
            key: {},
            expectedVersion: 0,
            idempotencyKey: submission,
            input,
          },
          { ...execution, flags, ...(options.visitor ? { visitor: options.visitor } : {}) },
        );
        // A link the handler minted on the row it made is said to its visitor as a URL, in this answer alone.
        const linked = servesLinks(app) && !result.replayed ? await withLinkUrls(app, resources, result) : result;
        // A public link (context.publicLink) is no secret: a replay says it too.
        return await withAppPublicUrls(app, linked);
      },
      ...(options.admit && servesLinks(app) && answersLink(commands[command.id]?.output) ? { decoyLink: () => decoyLinkUrl(app.id) } : {}),
      ...(options.admit ? { declaredMessages: () => declaredMessages(commands[command.id]?.output) } : {}),
    });
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/* A decoy's answer: shaped as an accepted submission's, its reference and receipt random, so a script that filled the
   honeypot learns nothing — and nothing was written, journalled or counted as a receipt. */
export function decoyReply(link?: string, message?: string): PublicSubmissionReply {
  return {
    reference: randomBytes(6).toString('hex').toUpperCase(),
    receipt: { id: randomUUID(), status: 'applied' },
    ...(message ? { message } : {}),
    ...(link ? { link } : {}),
  };
}

/** Shared transport, with the writer supplied by its deployment. The policy
 * path never loads resources or falls back to an ordinary command binding. */
export async function dispatchPublicFormSubmissionHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  submit: (
    submission: { input: unknown; submission: string },
    execution: { signal: AbortSignal; requestId?: string; locale?: string },
  ) => Promise<BusinessCommandResult>;
  /** The visitor's locale, as their door resolved it (readerLocale.ts `requestLocale`): the command's `ctx.locale`. */
  locale?: string | undefined;
  extra?: readonly SubmissionExtra[];
  admit?: SubmissionAdmission;
  tooLarge?: 'thrown';
  /** A link-shaped URL for a decoy, where the door's command answers with a link: it opens to the one miss. */
  decoyLink?: () => string | undefined;
  /** The `message` literals the door's command declares, where the door has an admission check: the reply says the
      handler's message only if it is one of them, and a decoy says the first, so the two keep the same keys. */
  declaredMessages?: () => readonly string[];
}): Promise<PublicSubmissionReply> {
  const { req, res, submit } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    if (req.aborted || res.destroyed) abort();
    const { input, submission, extra } = parseSubmission(await commandBody(req), options.extra);
    if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    const declared = options.declaredMessages?.();
    if ((await options.admit?.(extra)) === 'decoy') return decoyReply(options.decoyLink?.(), declared?.[0]);
    const execution = {
      signal: controller.signal,
      ...(typeof res.getHeader('x-request-id') === 'string' ? { requestId: String(res.getHeader('x-request-id')) } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
    };
    const result = await submit({ input, submission }, execution);
    const reference = (result.result as { reference?: unknown } | null)?.reference;
    // The receipt is durable either way; a handler that returned no
    // reference has left the applicant nothing to quote, which is its bug.
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 64)
      throw new BusinessCommandExecutionError('invalid_result', 'unknown');
    /* The visitor is told a public command's `message`. Where a honeypot's decoy guards the door, only a declared
       literal is said, as the decoy says one: a templated sentence would tell a script which answer was real. */
    return {
      reference,
      receipt: { id: result.receiptId, status: result.status },
      ...publicMessage(result.result, declared),
      ...publicLink(result),
    };
  } catch (error) {
    if (error instanceof CommandBodyTooLarge && options.tooLarge === 'thrown') throw error;
    if (error instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
    if (error instanceof AppAccessDenied) throw forbiddenBy(error);
    throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
}
