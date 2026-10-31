import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef } from '../../shared/app.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from './businessCommands.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { bindHttpBusinessCommands, bulkCommandWhen } from './businessCommandLoader.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { CommandInputError, parseCommandPrepareTargets, parseCommandAvailability } from './commandPayload.js';
import { forbiddenBy } from './commandErrors.js';
import { collectCommandAvailability, readCommandAvailability } from './commandAvailability.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  type CommandDoor,
} from './businessCommandExecution.js';
import { COMMAND_ROUTE_PATHS } from '../../shared/commandRoutes.js';
import { checkCommandStep, checkedNames } from './commandCheck.js';
import { ROW_LOCKED_RETRY_AFTER_SECONDS } from '@mistriwork/engine/adapters/writeLanes.js';
import { prepareCommandTargets } from './commandTargets.js';
import { whenPerson } from './commandWhen.js';
import { readPreparedRecord, readPreparedTargetAvailability, withPreparedAhead } from './commandPrepare.js';
import { preparesInitial } from './commandPrepareNeeds.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { attributeAction } from '@mistriwork/engine/adapters/writeAttribution.js';
import { MAX_COMMAND_BYTES, snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { CaptureCommandFlags, CommandFlags } from './commandFlags.js';
import { authorizedCommandFlags, commandFlagsOnce } from './commandFlagCapture.js';

export const isBusinessCommandPath = (path: string): boolean => path.startsWith('/api/commands/');

/** The browser's own command request: it keeps a receipt only when it asks
 * for one with an Idempotency-Key header, as a caller that retries does. */
const browserDoor = (req: IncomingMessage): CommandDoor => (req.headers['idempotency-key'] === undefined ? 'ui' : 'ui-idempotent');

export function businessCommandHttpError(error: unknown, statusOnly = false) {
  const safe =
    error instanceof BusinessCommandExecutionError
      ? error
      : error instanceof AppAccessDenied
        ? forbiddenBy(error, 'unknown')
        : new BusinessCommandExecutionError(
            error instanceof CommandInputError ? 'invalid_input' : 'temporarily_unavailable',
            'unknown',
            error instanceof CommandInputError ? error.field : undefined,
          );
  const status =
    safe.code === 'unauthenticated'
      ? 401
      : safe.code === 'forbidden'
        ? 403
        : safe.code === 'not_found'
          ? 404
          : safe.code === 'invalid_input'
            ? 400
            : safe.code === 'consumes_refused'
              ? 422
              : [
                    'stale_account',
                    'stale_record',
                    'command_version_mismatch',
                    'idempotency_conflict',
                    'ineligible_state',
                    'reviewer_unavailable',
                    'duplicate_record',
                  ].includes(safe.code)
                ? 409
                : 503;
  return {
    status,
    ...(safe.code === 'row_locked' ? { retryAfter: ROW_LOCKED_RETRY_AFTER_SECONDS } : {}),
    body: {
      code: safe.code,
      message: safe.message,
      error: safe.message,
      outcome: statusOnly ? ('unknown' as const) : safe.outcome,
      ...(safe.field ? { field: safe.field } : {}),
      ...(safe.key ? { key: safe.key } : {}),
    },
  };
}

/* A resource route names its App in the body (`{ app, table, … }`); a command route takes it in the query string
   (`/api/commands/execute?app=<id>`), and its envelope holds exactly the command's own members. An `app` member is
   the one stray name that is not the caller's text to echo but a known mistake, so it is the one the refusal says.
   Its outcome is the route's own for an invalid envelope: a scoped route says unknown of every refusal. */
function assertEnvelopeHasNoApp(body: unknown, outcome: 'unknown' | 'not_applied'): void {
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'app'))
    throw new BusinessCommandExecutionError(
      'invalid_input',
      outcome,
      undefined,
      undefined,
      'A command route takes app in the query string (/api/commands/execute?app=<id>), not in the body.',
    );
}

/** At most 64 KiB of JSON; anything else is an invalid input, not a parse detail. */
/** A body past the 64 KB envelope: an invalid input to every caller that already reads it so, and a 413 to a public
    door that says which (http/pageCommandRoutes.ts). */
export class CommandBodyTooLarge extends CommandInputError {}

/* A body a public door read before its human check (holdCommandBody), kept for the one read that follows. */
const heldBodies = new WeakMap<IncomingMessage, Buffer>();

/**
 * How long a public door waits for a body it holds before its human check. The hold is the one read a visitor with no
 * token can make the server do, so without its own deadline a body trickled a byte at a time keeps the socket for the
 * server's whole request timeout (600 s). Every form's body is a few kilobytes and arrives in one round trip; ten
 * seconds is a slow phone on a poor network many times over, and short enough that a trickle costs its sender more
 * than it costs this server.
 */
export const BODY_HOLD_MS = 10_000;

/**
 * Read a public door's body now, under the 64 KB envelope and the hold's deadline, before anything leaves this server:
 * a length header says nothing of a chunked body, and one past the envelope must never cost a provider's call.
 * `too_large` when it is past the envelope and `too_slow` when it has not ended by the deadline; either way the rest
 * is left unread (the door answers 413 or 408 and closes the connection). Otherwise `held`, and the body is kept for
 * `commandBody`. A body that stops arriving because its visitor went away rejects, as reading it later would.
 */
export function holdCommandBody(req: IncomingMessage): Promise<'held' | 'too_large' | 'too_slow'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', failed);
      req.off('aborted', aborted);
      req.off('close', closed);
      settle();
    };
    const data = (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 65_536) {
        req.pause();
        finish(() => resolve('too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const end = () =>
      finish(() => {
        heldBodies.set(req, Buffer.concat(chunks));
        resolve('held');
      });
    const failed = (error: unknown) => finish(() => reject(error));
    const aborted = () => finish(() => reject(new Error('The request was aborted.')));
    /* The backstop: a socket that closes without an error or an abort still settles the hold and clears its timer. */
    const closed = () => finish(() => reject(new Error('The request closed before its body ended.')));
    const timer = setTimeout(() => {
      req.pause();
      finish(() => resolve('too_slow'));
    }, BODY_HOLD_MS);
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    req.once('aborted', aborted);
    req.once('close', closed);
  });
}

export async function commandBody(req: IncomingMessage): Promise<unknown> {
  const held = heldBodies.get(req);
  if (held) heldBodies.delete(req);
  const chunks: Buffer[] = held ? [held] : [];
  let bytes = held?.length ?? 0;
  if (!held)
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 65_536) throw new CommandBodyTooLarge(); // The body as a whole, so no member is named.
      chunks.push(chunk);
    }
  // Preserve the original byte meaning: replacement decoding could turn a
  // malformed string into valid, fingerprinted command input. Keep BOMs in
  // the decoded text so JSON.parse retains its existing BOM refusal.
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new CommandInputError();
  }
}

/** Verified context owns all source/transaction lifetimes. This dispatcher has
 * no registry or raw adapter with which to fall back to unscoped execution. */
export async function dispatchScopedBusinessCommandHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  commands: NonNullable<AppPolicyContext['commands']>;
  /** What an executed command's writes are called in the record history. */
  label?: (body: unknown) => string | undefined;
  /** The body, where it was read already: availability asked inside a record page's composed read (recordCompose.ts). */
  body?: unknown;
}): Promise<unknown> {
  const { req, res, path, commands } = options;
  if (req.method !== 'POST' || !COMMAND_ROUTE_PATHS.includes(path)) {
    throw new BusinessCommandExecutionError('invalid_input', 'unknown');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    if (req.aborted || res.destroyed) abort();
    const body = options.body !== undefined ? options.body : await commandBody(req);
    assertEnvelopeHasNoApp(body, 'unknown');
    if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled', 'unknown');
    const execution = {
      signal: controller.signal,
      ...(typeof res.getHeader('x-request-id') === 'string' ? { requestId: String(res.getHeader('x-request-id')) } : {}),
    };
    // A step's check is the ordinary host's; a scoped deployment's forms are judged when they are sent.
    if (path === '/api/commands/check') throw new BusinessCommandExecutionError('forbidden', 'not_applied');
    if (path === '/api/commands/availability') {
      if (!commands.availability) throw new BusinessCommandExecutionError('temporarily_unavailable');
      return await commands.availability(body, execution);
    }
    return path === '/api/commands/prepare'
      ? await commands.prepare(body, execution)
      : path === '/api/commands/status'
        ? await commands.status(body, execution)
        : await attributeAction(options.label?.(body), () => commands.execute(body, { ...execution, door: browserDoor(req) }));
  } catch (error) {
    if (error instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', 'unknown', error.field);
    if (error instanceof AppAccessDenied) throw forbiddenBy(error, 'unknown');
    throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
}

/** The operation owns every lease until transaction completion, even after socket loss. */
export async function dispatchBusinessCommandHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  connection: string;
  actor: BusinessCommandActor;
  captureFlags?: CaptureCommandFlags;
  /** The App-scope event source startup issued, when a command declares events. */
  events?: CommandJournalAppScope;
  /** What an executed command's writes are called in the record history. */
  label?: (body: unknown) => string | undefined;
  /** The body, where it was read already (as above). */
  body?: unknown;
}): Promise<unknown> {
  const { req, res, path, registry, app, commands, connection, actor, events } = options;
  const captureFlags = options.captureFlags;
  let admittedActor = actor;
  const flags = commandFlagsOnce(() => captureFlags?.(admittedActor));
  const admittedFlags = (actor: BusinessCommandActor) => {
    admittedActor = actor;
    return flags();
  };
  if (req.method !== 'POST' || !COMMAND_ROUTE_PATHS.includes(path)) {
    throw new BusinessCommandExecutionError('invalid_input');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  const releases: Array<() => void> = [];
  try {
    if (req.aborted || res.destroyed) abort();
    const body = snapshot(options.body !== undefined ? options.body : await commandBody(req), MAX_COMMAND_BYTES).value;
    assertEnvelopeHasNoApp(body, 'not_applied');
    if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
    const { binding, references } = bindHttpBusinessCommands(
      app,
      commands,
      resources,
      (owner) => registry.configOf(owner)?.writable === true,
      events,
    );
    if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    const execution = {
      signal: controller.signal,
      ...(typeof res.getHeader('x-request-id') === 'string' ? { requestId: String(res.getHeader('x-request-id')) } : {}),
    };
    /* Advice, asked again by the command in its own transaction: read through
       the source's readers, every check at once, not one writer transaction
       after another (a record with five verbs was five, queued behind every
       write, at several round trips each). */
    if (path === '/api/commands/availability')
      return await collectCommandAvailability(
        parseCommandAvailability(body),
        async (check) => {
          const authorized = binding.authorize(check.command, actor);
          if (!references.has(check.command)) throw new AppAccessDenied();
          const flags = await admittedFlags(authorized.actor);
          const ask = (reader: Parameters<Parameters<typeof authorized.transaction>[0]>[0]) =>
            readCommandAvailability({
              check,
              command: authorized.command,
              actor: authorized.actor,
              catalog: authorized.catalog,
              ...(authorized.people ? { people: authorized.people } : {}),
              machine: authorized.machine,
              reader,
              ...execution,
              flags,
            });
          return await (authorized.advise ? authorized.advise(ask) : authorized.transaction(ask));
        },
        controller.signal,
        { concurrent: true },
      );
    if (path === '/api/commands/check') {
      // Asked of a command this reader may run, at the version the form was drawn from; nothing runs.
      const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (typeof request.command !== 'string') throw new CommandInputError('command');
      const authorized = binding.authorize(request.command, actor);
      if (!references.has(request.command)) throw new AppAccessDenied();
      if (request.commandVersion !== authorized.command.version)
        throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
      const asked = checkedNames(authorized.command, request.fields);
      if (!asked) throw new CommandInputError('fields');
      return { problems: checkCommandStep(authorized.command, request.input, asked) };
    }
    if (path === '/api/commands/prepare')
      return await prepareBusinessCommand({ body, app, binding, references, resources, actor, execution, captureFlags: admittedFlags });
    const captured = await authorizedCommandFlags(binding, actor, body, admittedFlags, path === '/api/commands/status');
    return path === '/api/commands/status'
      ? await lookupBusinessCommandStatus(binding, actor, body, { ...execution, flags: captured })
      : await attributeAction(options.label?.(body), () =>
          executeBusinessCommand(binding, actor, body, { ...execution, flags: captured, door: browserDoor(req) }),
        );
  } catch (error) {
    if (error instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
    if (error instanceof AppAccessDenied) throw forbiddenBy(error);
    throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
    for (const release of releases.reverse()) release();
  }
}

type CommandBinding = ReturnType<typeof bindHttpBusinessCommands>;

/** One prepare, as the route answers it: a target's revision (and starting
 * values), or a selection's eligibility. Also what an import asks before it
 * runs a command on each row's record (appImport.ts). */
async function prepareBusinessCommand(options: {
  body: unknown;
  app: AppDef;
  binding: CommandBinding['binding'];
  references: CommandBinding['references'];
  resources: Awaited<ReturnType<typeof loadAppRuntimeResources>>;
  actor: BusinessCommandActor;
  execution: { signal: AbortSignal; requestId?: string };
  captureFlags: (actor: BusinessCommandActor) => Promise<CommandFlags>;
}): Promise<unknown> {
  const { body, app, binding, references, resources, actor } = options;
  // A signed-in form's command prepares over no record: its key is empty, as its submission's is.
  const request = parseCommandPrepareTargets(body, { creating: (id) => binding.creates?.(id) === true });
  const authorized = binding.authorize(request.command, actor);
  if (request.commandVersion !== authorized.command.version) throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
  const reference = references.get(request.command);
  if (!reference) throw new BusinessCommandExecutionError('forbidden');
  // A command that names one record refuses a list, as execution does.
  if (request.multi && authorized.command.targets !== 'many') throw new CommandInputError('keys');
  for (const key of request.keys) {
    // The member, never its columns: an ownership column belongs to the
    // platform, not the caller. See the same check in the executor.
    if (authorized.keyColumns.length !== Object.keys(key).length || authorized.keyColumns.some((column) => !Object.hasOwn(key, column)))
      throw new CommandInputError('key');
  }
  const command = authorized.command;
  const execution = { ...options.execution, flags: await options.captureFlags(authorized.actor) };
  if (request.multi) {
    /* Revisions are read as execution reads the target, through the command's
       own reader, so a digest of the row is taken over the same columns. */
    const prepared = await authorized.transaction((records) =>
      prepareCommandTargets({
        query: (query) => records.query({ ...query, table: command.target }),
        schema: resources.schema,
        table: authorized.resource,
        keyColumns: authorized.keyColumns,
        ...(authorized.versionField ? { versionField: authorized.versionField } : {}),
        keys: request.keys,
        when: bulkCommandWhen(app, request.command),
        ...(authorized.timezone ? { zone: authorized.timezone } : {}),
        me: () => whenPerson(records, authorized.actor, authorized.people, [bulkCommandWhen(app, request.command)]),
        checkCancelled: () => {
          if (execution.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        },
      }),
    );
    if (!preparesInitial(authorized.command)) return prepared;
    return {
      targets: await authorized.transaction((records) =>
        readPreparedTargetAvailability(records, {
          command: authorized.command,
          commandId: request.command,
          actor: authorized.actor,
          targets: prepared.targets,
          catalog: authorized.catalog,
          ...(authorized.people ? { people: authorized.people } : {}),
          ...execution,
        }),
      ),
    };
  }
  const [key] = request.keys;
  // The revision, and starting values with it, in one transaction through the command's footprint.
  return await withPreparedAhead(authorized.command, authorized.catalog, key, () =>
    authorized.transaction((records) =>
      readPreparedRecord(records, {
        command: authorized.command,
        commandId: request.command,
        actor: authorized.actor,
        key,
        catalog: authorized.catalog!,
        ...(authorized.people ? { people: authorized.people } : {}),
        ...execution,
      }),
    ),
  );
}

/**
 * The prepare and execute a route runs, held open for a caller that runs a
 * command many times in one request — an import, once per row. Each call is
 * authorized and journaled exactly as a request to /api/commands/* would be;
 * `release` gives back the leases.
 */
export async function openBusinessCommandCalls(options: {
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  connection: string;
  actor: BusinessCommandActor;
  events?: CommandJournalAppScope;
  signal: AbortSignal;
  requestId?: string;
  captureFlags?: CaptureCommandFlags;
}): Promise<{ prepare(body: unknown): Promise<unknown>; execute(body: unknown): Promise<unknown>; release(): void }> {
  const { registry, app, commands, connection, actor, events, signal } = options;
  const captureFlags = options.captureFlags;
  let admittedActor = actor;
  const flags = commandFlagsOnce(() => captureFlags?.(admittedActor));
  const admittedFlags = (actor: BusinessCommandActor) => {
    admittedActor = actor;
    return flags();
  };
  const releases: Array<() => void> = [];
  const release = () => {
    for (const give of releases.splice(0).reverse()) give();
  };
  try {
    const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
    const { binding, references } = bindHttpBusinessCommands(
      app,
      commands,
      resources,
      (owner) => registry.configOf(owner)?.writable === true,
      events,
    );
    const execution = { signal, ...(options.requestId ? { requestId: options.requestId } : {}) };
    const mapped = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
        if (error instanceof AppAccessDenied) throw forbiddenBy(error);
        throw error;
      }
    };
    return {
      prepare: (body) =>
        mapped(() => prepareBusinessCommand({ body, app, binding, references, resources, actor, execution, captureFlags: admittedFlags })),
      execute: (raw) =>
        mapped(async () => {
          const body = snapshot(raw, MAX_COMMAND_BYTES).value;
          return executeBusinessCommand(binding, actor, body, {
            ...execution,
            flags: await authorizedCommandFlags(binding, actor, body, admittedFlags),
          });
        }),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
