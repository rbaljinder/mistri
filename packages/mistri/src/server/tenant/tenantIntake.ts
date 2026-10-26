/**
 * Public intake on a tenant App, the runtime: the one write a signed-out
 * visitor makes there, attributed to exactly one tenant or to none
 * (tenantIntakeModel.ts says what an address is).
 *
 * The server resolves the address, and only the server. An address that
 * names one active tenant places the submission in that tenant, with the
 * ownership column injected as for a member's write. Anything else — no
 * address, a malformed or unknown one, one two rows share, a suspended or
 * closed tenant — places it with the platform, for its triage. Both answer
 * alike: the same status, headers and body shape, so a visitor learns nothing
 * about which addresses or tenants exist. The handler is told which of the two
 * it writes (`intake`), and the transaction lets it write only that place's
 * tables, by insert only.
 *
 * There is no membership. The submission is admitted under what resolution
 * read — the tenant's row or `@platform`, the platform's row, and the profile
 * row holding the address — and the writer checks all of it again before the
 * handler runs, fenced as a membership is (BEGIN IMMEDIATE on SQLite, FOR
 * SHARE on PostgreSQL). When any of it moved first, nothing was applied and
 * the submission is resolved once more: a rotated address or a suspended
 * tenant then lands it with the platform, a suspended platform refuses it as
 * every submission is refused. It never reaches a tenant that no longer holds
 * its address. Its receipt names the public principal `public:<form>` in the
 * membership's place.
 *
 * A form saved on every step (forms/savedForms.ts) runs each step and its
 * submit here too, one submission each, resolved each time. Its draft lives in
 * the place the step resolved to, and the applicant's token is bound to that
 * place as well as to its root: the hash the root keeps is taken over the
 * token and the tenant it was issued in, and it is looked for only among that
 * place's rows. A step that arrives under another address — another tenant's,
 * a rotated one, none — finds no draft and is answered as a forged token is.
 */
import { createHash } from 'node:crypto';
import { isPromise, isProxy } from 'node:util/types';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { declaredReferences, physicalBindings, tenantAppShape, type AppDef } from '../../shared/app.js';
import { assertScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { AppAccessDenied, type ResourceAccess } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { createBusinessCommandAuthorizer, type BusinessCommandAuthorization } from '../commands/businessCommandAuthorization.js';
import { BusinessCommandExecutionError, executeBusinessCommand, type BusinessCommandResult } from '../commands/businessCommandExecution.js';
import {
  defineCommands,
  getCommandEvents,
  type AnyBusinessCommand,
  type BusinessCommandActor,
  type BusinessCommandRegistry,
} from '../commands/businessCommands.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { formCommands, isSavedForm, platformColumns, type AppFormSave } from '../../shared/appSavedForms.js';
import type { AppFormView } from '../../shared/app.js';
import { savedFormRoots } from '../forms/savedFormChecks.js';
import { readDraftProgress, type SavedDraftRun } from '../forms/savedForms.js';
import { publicPrincipal } from '../commands/formHttp.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import { captureTenantCommandExecution, tenantCommandDomain, type TenantCommandExecutionOptions } from './tenantCommands.js';
import { runTenantCommandTransaction } from './tenantCommandTransaction.js';
import {
  captureTenantData,
  denyTenant,
  tenantIdentifier,
  tenantOptions,
  refusalCause,
  recordRefusalCause,
} from '@mistriwork/engine/server/evidence.js';
import { assertIntakeColumn, captureIntakeEvidence, intakeAddress, intakePlace, tenantPublicForms } from './tenantIntakeModel.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';
import { captureTenantWriteSource, TenantIntakeMoved, TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';

interface TenantIntakeOptions {
  /** Placement is admitted by this owner. The public form id is not a visitor identity. */
  readonly captureFlags?: (
    actor: BusinessCommandActor,
    placement: Readonly<{ tenantId: string | null; realm: 'tenant' | 'platform' }>,
    assertCurrent: () => void,
  ) => CommandFlags | undefined | Promise<CommandFlags | undefined>;
  readonly app: AppDef;
  readonly reader: TenantReadSource;
  readonly writer: TenantWriteSource;
  readonly deployment: string;
  readonly maxLifetimeMs: number;
  /** The policy's `intake.address`: the profile column resolution reads. */
  readonly column: string;
  readonly registry: BusinessCommandRegistry;
  readonly resultReferences: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
  readonly now?: () => number;
}
/** A saved form's step or submit, as the route planned it from the cookie (forms/savedFormHttp.ts). */
interface TenantIntakeDraft {
  readonly phase: SavedDraftRun['phase'];
  /** The step's id; the submit's is `submit`. */
  readonly step: string;
  /** The SHA-256 (hex) of the applicant's token, before it is bound to a place here. */
  readonly token: string;
}
export interface TenantIntakeSubmission {
  /** The public form's view key, from the route, never the body. */
  readonly form: string;
  /** The address the request carried, unchecked; anything not an address is none. */
  readonly address: unknown;
  readonly input: unknown;
  /** The client's submission key: the receipt's idempotency key. */
  readonly submission: string;
  /** Present on a saved form's step and submit; the command it runs is the form's, never the request's. */
  readonly draft?: TenantIntakeDraft;
}
/** A saved form's resume: which steps of the applicant's draft, in the place this address resolves to, are saved. */
export interface TenantIntakeResume {
  readonly form: string;
  readonly address: unknown;
  readonly token: string;
}
type SavedIntakeForm = AppFormView & { save: AppFormSave; steps: Array<{ id: string; command: { id: string; version: number } }> };
const HASH = /^[0-9a-f]{64}$/;
/**
 * The hash a draft's root keeps: the applicant's token bound to the App, the
 * form and the place it was issued in. The same cookie read under another
 * tenant's address hashes to a value no row there holds.
 */
function placedToken(appId: string, form: string, tenantId: string, token: string): string {
  if (!HASH.test(token)) return denyTenant();
  return createHash('sha256').update(`mistri-intake-draft\u0000${appId}\u0000${form}\u0000${tenantId}\u0000${token}`, 'utf8').digest('hex');
}
export type TenantIntake = ReturnType<typeof bindTenantIntake>;
const deny = (): never => {
  throw new AppAccessDenied();
};

/**
 * The public intake owner over the deployment's genuine sources: resolution
 * on the reader, then one fenced writer transaction per submission, through
 * the same executor, journal and audit as every command. Only the App's public
 * forms' commands run here, each only as its form's public principal.
 */
export function bindTenantIntake(options: TenantIntakeOptions) {
  const raw = tenantOptions(options, [
    'app',
    'reader',
    'writer',
    'deployment',
    'maxLifetimeMs',
    'column',
    'registry',
    'resultReferences',
    'now',
    'captureFlags',
  ]);
  if (raw.captureFlags !== undefined && (typeof raw.captureFlags !== 'function' || isProxy(raw.captureFlags))) return denyTenant();
  const captureFlags = raw.captureFlags as TenantIntakeOptions['captureFlags'];
  const reader = captureTenantReadSource(raw.reader as TenantReadSource),
    writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
  const identity = assertTenantSourcePair(reader, writer),
    ownership = writer.ownership;
  const app = captureTenantData(raw.app as AppDef);
  // Triage is the platform's: without the realm there is nowhere to put a
  // submission no address places, and refusing it would say the address was wrong.
  if (!app || !tenantAppShape(app, ownership) || !app.auth?.tenancy?.platform) return denyTenant();
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  const column = raw.column as string;
  assertIntakeColumn(ownership, column);
  const deployment = raw.deployment as string,
    maxLifetimeMs = raw.maxLifetimeMs as number;
  tenantIdentifier(deployment);
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 300_000) return denyTenant();
  if (raw.now !== undefined && typeof raw.now !== 'function') return denyTenant();
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  if (!raw.registry || typeof raw.registry !== 'object' || isProxy(raw.registry)) return denyTenant();
  const registry = defineCommands(
    tenantOptions(raw.registry, Object.keys(Object.getOwnPropertyDescriptors(raw.registry))) as BusinessCommandRegistry,
  );
  const forms = tenantPublicForms(app);
  if (!forms.size) return denyTenant();
  const ownerFields = Object.fromEntries(
    Object.entries(ownership.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])),
  );
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema: ownership.schema,
    connectionFor: (resource) => (Object.hasOwn(ownership.resources, resource) ? identity.source.connection : deny()),
    writableConnection: (connection) => connection === identity.source.connection,
    transactionalConnection: (connection) => connection === identity.source.connection,
    managedOwnership: ownerFields,
  });
  const declarations = tenantOptions(raw.resultReferences, Object.keys(registry));
  const extractors = new Map<string, (result: unknown) => readonly CommandResultReference[]>();
  /* A public intake command inserts into a tenant's tables or the platform's,
     never a global one; it runs no lookup, emits no event or effect, and
     belongs to no realm of its own: where it lands is decided per submission. */
  for (const form of forms.values()) {
    // A saved form's steps are public commands of the same kind as its submit.
    for (const { id } of formCommands(form)) {
      const command = registry[id];
      if (
        !command ||
        command.public !== true ||
        command.realm !== undefined ||
        command.source !== identity.source.id ||
        getCommandEvents(command) !== undefined ||
        typeof command.lookup === 'function' ||
        command.sources !== undefined ||
        command.write.some((table) => !['tenant', 'platform'].includes(ownership.ownership[table]?.kind ?? ''))
      )
        return denyTenant();
      const extractor = declarations[id];
      if (typeof extractor !== 'function' || isProxy(extractor)) return denyTenant();
      extractors.set(id, extractor as (result: unknown) => readonly CommandResultReference[]);
    }
  }
  const validation = compileAppDefinitionValidation(ownership.schema, app);
  // No role: the footprint bounds a public handler, and its place bounds the footprint.
  const grants: ResourceAccess = { readable: new Set(), writable: new Set(), ...(validation ? { validation } : {}) };
  /* Where a saved form's draft may be, in each place: the first step's
     written tables that keep the resume columns (savedFormChecks.ts), a
     tenant's among its own tables and the platform's among its own. Each
     place holds one, or a step placed there would be refused where the other
     is saved, and the answer would say where it landed. */
  const drafts = new Map<string, { start: string; roots: Readonly<Record<'tenant' | 'platform', readonly string[]>> }>();
  for (const [key, form] of forms) {
    if (!isSavedForm(form)) continue;
    const saved = form as SavedIntakeForm,
      start = saved.steps[0]?.command.id;
    const startCommand: AnyBusinessCommand | undefined = start ? registry[start] : undefined;
    if (!start || !startCommand) return denyTenant();
    // Said for the operator who starts the deployment (tenantStartup.ts prints the reason under its refusal).
    if (saved.statusCheck || saved.link)
      throw new Error(
        `Form "${key}" declares ${saved.statusCheck ? 'statusCheck' : 'link'}, which a tenant App's saved form does not serve.`,
      );
    const roots = savedFormRoots(saved, startCommand, authorizer.authorize(start, publicPrincipal(app.id, key)).catalog);
    const placed = (kind: 'tenant' | 'platform') => Object.freeze(roots.filter((table) => ownership.ownership[table]?.kind === kind));
    const byPlace = Object.freeze({ tenant: placed('tenant'), platform: placed('platform') });
    if (!byPlace.tenant.length || !byPlace.platform.length) {
      throw new Error(
        `Form "${key}" is saved on every step, and its first step "${start}" writes no ${byPlace.tenant.length ? 'platform' : 'tenant'}-owned ` +
          "table with the resume columns: a step may land in a tenant or in the platform's triage, and each place keeps its own draft.",
      );
    }
    drafts.set(key, Object.freeze({ start, roots: byPlace }));
  }
  let retired = false,
    retirement: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();

  /** One resolution: where a submission to this form lands now, the
   * evidence it is admitted under, and its lifetime. */
  const admit = async (form: string, raw: unknown, drafting: boolean) => {
    const started = now();
    // One read snapshot: the address's tenant when it names one active
    // tenant, else the platform. A platform that is not active refuses
    // every submission alike, whatever address it carried.
    const address = intakeAddress(raw) ?? null;
    const resolved = captureTenantData(await reader.resolveIntake({ appId: app.id, source: identity.source, deployment, column, address }));
    if (retired) throw new BusinessCommandExecutionError('temporarily_unavailable');
    const evidence = captureIntakeEvidence(
      {
        realm: 'intake',
        appId: app.id,
        source: identity.source,
        deployment,
        form,
        tenantId: resolved.tenantId,
        tenantVersion: resolved.tenantVersion,
        platformVersion: resolved.platformVersion,
        column,
        address: intakePlace(resolved) === 'tenant' ? address : null,
        verifiedAt: started,
        validUntil: started + maxLifetimeMs,
        drafting,
      },
      ownership,
    );
    let lastTime = started;
    const active = () => {
      if (retired) return denyTenant();
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < lastTime || instant >= evidence.validUntil) return denyTenant();
      lastTime = instant;
    };
    const scope = Object.freeze({ principal: evidence, grants, session: async () => active() });
    return { evidence, place: intakePlace(evidence), active, scope };
  };
  type Admitted = Awaited<ReturnType<typeof admit>>;

  /** The command's footprint as a scope of trues: the writer composes the place's scope over it. */
  const footprintOf = (authorization: BusinessCommandAuthorization) =>
    Object.freeze(Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, authorization.read.includes(table)])));

  /** One fenced writer transaction in the admitted place, under the command's authorization. `moved` is set
   * when the writer found what was resolved changed before the work ran, with nothing applied. */
  const inPlace = async <T>(
    admitted: Admitted,
    authorization: BusinessCommandAuthorization,
    extractor: (result: unknown) => readonly CommandResultReference[],
    state: { moved: boolean },
    work: (records: WriteTransaction, journal: CommandJournal | undefined) => Promise<T>,
  ): Promise<T> => {
    let workFailure: { error: unknown } | undefined;
    try {
      return await writer.intakeCommandTransaction(
        admitted.evidence,
        footprintOf(authorization),
        (records, journal) =>
          runTenantCommandTransaction(ownership, admitted.scope, authorization, records, journal, extractor, async (tx) => {
            try {
              return await work(tx.records, tx.journal);
            } catch (error) {
              workFailure = { error };
              throw error;
            }
          }),
        admitted.active,
      );
    } catch (error) {
      if (error instanceof TenantIntakeMoved) state.moved = true;
      // The source's confirmed or unknown outcome, around the work's own refusal.
      throw new CommandTransactionFailure(workFailure?.error ?? error, error instanceof TenantWriteFailure ? error.outcome : 'unknown');
    }
  };

  /** One resolution and one fenced attempt. `moved` says the writer found what
   * was resolved changed before the handler ran, with nothing applied. */
  const attempt = async (
    request: TenantIntakeSubmission,
    options: TenantCommandExecutionOptions,
    state: { moved: boolean },
    flagsFor: (actor: BusinessCommandActor, admitted: Admitted) => Promise<CommandFlags | undefined>,
  ): Promise<BusinessCommandResult> => {
    const form = forms.get(request.form)!,
      draft = request.draft;
    // Which command runs is the form's: its submit, or the named step's own.
    const reference =
      !draft || draft.phase === 'submit'
        ? form.command
        : ((form as SavedIntakeForm).steps.find((step) => step.id === draft.step)?.command ?? denyTenant());
    const id = reference.id,
      command = registry[id],
      extractor = extractors.get(id)!;
    const admitted = await admit(request.form, request.address, draft !== undefined);
    const { evidence, place } = admitted;
    const principal = publicPrincipal(app.id, request.form);
    authorizer.authorize(id, principal);
    const flags = await flagsFor(principal, admitted);
    admitted.active();
    let run: SavedDraftRun | undefined;
    if (draft) {
      const saved = form as SavedIntakeForm,
        where = drafts.get(request.form) ?? denyTenant();
      run = Object.freeze({
        phase: draft.phase,
        step: draft.step,
        token: placedToken(app.id, request.form, evidence.tenantId, draft.token),
        save: saved.save,
        order: Object.freeze(saved.steps.map((step) => step.id)),
        roots: where.roots[place],
        owned: Object.freeze(platformColumns(saved)),
      });
    }
    let transacted = false;
    const binding = Object.freeze<BusinessCommandBinding>({
      scoped: true,
      authorize: (commandId, actor) => {
        if (actor !== principal || commandId !== id) return deny();
        const authorization = authorizer.authorize(commandId, actor);
        return Object.freeze<AuthorizedBusinessCommand>({
          ...authorization,
          transaction: deny,
          intake: place,
          ...(place === 'tenant'
            ? { receiptOwner: captureTenantData({ storeId: identity.storeId, sourceId: identity.source.id, tenantId: evidence.tenantId }) }
            : {}),
          // A public command names no record: an empty key, and nothing to see.
          assertTarget: async (_records: WriteTransaction, key: Readonly<Record<string, string | number>>) => {
            // Said to the operator's log, never the visitor: a removal of its target's row lands here first.
            if (Object.keys(key).length)
              throw recordRefusalCause(
                new AppAccessDenied(),
                'a public submission names no record: it removes no row of its target, and reads none by key',
              );
          },
          // Its result names no record either: the public reads nothing back through it.
          assertResult: async (_records: WriteTransaction, key: Readonly<Record<string, string | number>>, result: unknown) => {
            if (Object.keys(key).length) deny();
            const returned: unknown = extractor(result);
            if (isPromise(returned)) {
              void Promise.prototype.then.call(returned, undefined, () => {});
              return deny();
            }
            const references = captureTenantData(returned);
            if (!Array.isArray(references) || references.length) deny();
          },
          commandTransaction: async (work) => {
            if (transacted) return deny();
            transacted = true;
            return inPlace(admitted, authorization, extractor, state, async (records, journal) => work(records, journal!));
          },
        });
      },
    });
    return executeBusinessCommand(
      binding,
      principal,
      {
        command: id,
        commandVersion: command.version,
        key: {},
        expectedVersion: 0,
        idempotencyKey: request.submission,
        input: request.input,
      },
      { ...options, flags, ...(run ? { draft: run } : {}) },
    );
  };

  /** A saved form's resume, in the place the address resolves to now: the saved steps' ids, never a value. */
  const resume = async (input: TenantIntakeResume): Promise<string[]> => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    try {
      return await resumeOnce(input);
    } finally {
      pending.delete(held);
      finish();
    }
  };
  const resumeOnce = async (input: TenantIntakeResume): Promise<string[]> => {
    if (retired) throw new BusinessCommandExecutionError('temporarily_unavailable');
    let request: TenantIntakeResume;
    try {
      request = captureTenantData(tenantOptions(input, ['form', 'address', 'token'])) as unknown as TenantIntakeResume;
    } catch {
      throw new BusinessCommandExecutionError('invalid_input');
    }
    const where = typeof request.form === 'string' ? drafts.get(request.form) : undefined;
    if (!where) throw new BusinessCommandExecutionError('forbidden');
    if (typeof request.token !== 'string' || !HASH.test(request.token)) return [];
    const saved = forms.get(request.form) as SavedIntakeForm,
      principal = publicPrincipal(app.id, request.form);
    const authorization = authorizer.authorize(where.start, principal),
      extractor = extractors.get(where.start)!;
    const read = async (state: { moved: boolean }) => {
      const admitted = await admit(request.form, request.address, false);
      const token = placedToken(app.id, request.form, admitted.evidence.tenantId, request.token);
      return inPlace(admitted, authorization, extractor, state, (records) =>
        readDraftProgress(
          records,
          authorization.catalog,
          where.roots[admitted.place],
          saved.save,
          token,
          saved.steps.map((step) => step.id),
          new Date(now()),
        ),
      );
    };
    const first = { moved: false };
    try {
      try {
        return await read(first);
      } catch (error) {
        if (!first.moved || retired) throw error;
      }
      return await read({ moved: false });
    } catch (error) {
      if (error instanceof BusinessCommandExecutionError) throw error;
      throw recordRefusalCause(new BusinessCommandExecutionError('temporarily_unavailable'), refusalCause(error) ?? error);
    }
  };

  const submit = async (input: TenantIntakeSubmission, execution: TenantCommandExecutionOptions = {}): Promise<BusinessCommandResult> => {
    let context: ReturnType<typeof captureTenantCommandExecution> | undefined, finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    try {
      if (retired) throw new BusinessCommandExecutionError('temporarily_unavailable');
      let request: TenantIntakeSubmission;
      try {
        request = captureTenantData(
          tenantOptions(input, ['form', 'address', 'input', 'submission', 'draft']),
        ) as unknown as TenantIntakeSubmission;
        if (request.draft !== undefined) {
          const draft = tenantOptions(request.draft, ['phase', 'step', 'token']);
          if (
            !['start', 'step', 'submit'].includes(draft.phase as string) ||
            typeof draft.step !== 'string' ||
            typeof draft.token !== 'string' ||
            !HASH.test(draft.token)
          )
            throw new Error();
        }
        context = captureTenantCommandExecution(execution);
      } catch {
        throw new BusinessCommandExecutionError('invalid_input');
      }
      if (typeof request.form !== 'string' || !forms.has(request.form)) throw new BusinessCommandExecutionError('forbidden');
      // A saved form runs only as its steps and its submit, each with its draft; any other form never with one.
      const saved = drafts.has(request.form),
        draft = request.draft;
      if (
        saved !== (draft !== undefined) ||
        (draft && (draft.phase === 'submit') !== (draft.step === 'submit')) ||
        (draft && draft.phase !== 'submit' && !(forms.get(request.form) as SavedIntakeForm).steps.some((step) => step.id === draft.step)) ||
        (draft?.phase === 'start' && (forms.get(request.form) as SavedIntakeForm).steps[0].id !== draft.step)
      ) {
        throw new BusinessCommandExecutionError('forbidden');
      }
      if (context.options.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
      let capturedPlace: string | undefined, capturedFlags: (() => Promise<CommandFlags>) | undefined;
      const flagsFor = (actor: BusinessCommandActor, admitted: Admitted) => {
        if (!captureFlags) return Promise.resolve(undefined);
        const placement = Object.freeze({
          tenantId: admitted.place === 'tenant' ? admitted.evidence.tenantId : null,
          realm: admitted.place,
        });
        const place = JSON.stringify(placement);
        // One HTTP request cannot transfer tenant decisions into a different
        // destination if admission moves. A fresh request captures that place.
        if (capturedPlace !== undefined && capturedPlace !== place) throw new BusinessCommandExecutionError('temporarily_unavailable');
        capturedFlags ??= commandFlagsOnce(async () => {
          const reader = await captureFlags(actor, placement, () => {
            if (retired || context!.options.signal.aborted) return denyTenant();
          });
          // The HTTP bridge is installed even without a flag runtime. Only
          // undefined means no snapshot: retain legacy rerouting in that case.
          // Any supplied reader pins the place; structural fakes still fail
          // the core's issuer check and cannot opt into this bypass.
          if (reader !== undefined) capturedPlace = place;
          return reader;
        });
        return capturedFlags();
      };
      /* Once more, and only once, when the writer found what was resolved had
         moved before the handler ran: resolved again it lands where it now
         belongs, and answers as any submission there does. A second move is
         a busy server's answer, the same for every address. */
      const first = { moved: false };
      try {
        return await attempt(request, context.options, first, flagsFor);
      } catch (error) {
        if (!first.moved || retired || context.options.signal.aborted) throw error;
      }
      return await attempt(request, context.options, { moved: false }, flagsFor);
    } catch (error) {
      if (error instanceof BusinessCommandExecutionError) throw error;
      const known = tenantCommandDomain(error);
      // As the tenant realm's: the answer is unchanged, the reason is kept for
      // an owner that has to diagnose it rather than dropped at the boundary.
      // As the tenant realm's: the refusal keeps what it objected to, and a
      // cancellation carries neither field nor key.
      const cancelled = !!context?.options.signal.aborted;
      throw recordRefusalCause(
        new BusinessCommandExecutionError(
          cancelled ? 'cancelled' : (known?.code ?? 'temporarily_unavailable'),
          known?.outcome === 'unknown' || (error instanceof TenantWriteFailure && error.outcome === 'unknown') ? 'unknown' : 'not_applied',
          cancelled ? undefined : known?.field,
          cancelled ? undefined : known?.key,
          cancelled ? undefined : known?.reason,
        ),
        refusalCause(known) ?? refusalCause(error) ?? error,
      );
    } finally {
      context?.close();
      pending.delete(held);
      finish();
    }
  };
  return Object.freeze({
    submit,
    resume,
    /** Read-only experiment admission uses exactly the intake resolver. No
     * selector becomes a tenant membership and no placement is disclosed. */
    async withPublicFlags<T>(
      form: string,
      address: unknown,
      use: (owner: { readonly tenantId: string | null; current(): Promise<void>; assertCurrent(): void }) => Promise<T>,
    ): Promise<T> {
      if (!forms.has(form) || retired) return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held);
      let active = true;
      try {
        const admitted = await admit(form, address, false);
        const assertCurrent = () => {
          if (!active) return denyTenant();
          admitted.active();
        };
        const current = async () => {
          assertCurrent();
          const fresh = await admit(form, address, false);
          assertCurrent();
          for (const key of ['tenantId', 'tenantVersion', 'platformVersion', 'address'] as const) {
            if (fresh.evidence[key] !== admitted.evidence[key]) return denyTenant();
          }
        };
        await current();
        const value = await use({ tenantId: admitted.place === 'tenant' ? admitted.evidence.tenantId : null, current, assertCurrent });
        await current();
        return value;
      } finally {
        active = false;
        pending.delete(held);
        finish();
      }
    },
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = Promise.allSettled([...pending]).then(() => {});
      return retirement;
    },
  });
}
