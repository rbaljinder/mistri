/*
 * The command request as it arrives: the single- and multi-target envelopes
 * and the prepare requests, read through the bounded canonical walk into
 * frozen copies. Shape only; the route supplies App identity, and
 * authorization decides what a request may reach.
 */
import { BULK_LIMIT, commandKeyText } from '../../shared/command.js';
import {
  CommandInputError,
  MAX_COMMAND_BYTES,
  canonicalCommandJson,
  reservedKeys,
  snapshot,
  type Json,
} from '@mistriwork/engine/adapters/commands/canonicalJson.js';

export { canonicalCommandJson, CommandInputError, commandKeyText };

export type CommandKey = Readonly<Record<string, string | number>>;

export interface CommandAvailabilityCheck {
  readonly command: string;
  readonly commandVersion: number;
  readonly keys: readonly CommandKey[];
}
export interface CommandAvailabilityResult {
  readonly checks: readonly { readonly command: string; readonly commandVersion: number; readonly available: readonly boolean[] }[];
}

/** Visibility-only batches, not execution cardinality. No actor/input/source. */
export function parseCommandAvailability(raw: unknown): readonly CommandAvailabilityCheck[] {
  try {
    const value = snapshot(raw, 65_536).value as Record<string, Json>;
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 1 ||
      !Array.isArray(value.checks) ||
      !value.checks.length ||
      value.checks.length > 16
    )
      return invalid('checks');
    let total = 0;
    const seen = new Set<string>();
    return Object.freeze(
      value.checks.map((rawCheck, index) => {
        const at = `checks[${index}]`;
        if (!rawCheck || Array.isArray(rawCheck) || typeof rawCheck !== 'object') return invalid(at);
        const check = rawCheck as Record<string, Json>;
        if (Object.keys(check).length !== 3 || Object.keys(check).some((key) => !['command', 'commandVersion', 'keys'].includes(key)))
          return invalid(at);
        if (
          typeof check.command !== 'string' ||
          !commands.test(check.command) ||
          check.command.length > 128 ||
          reservedKeys.has(check.command) ||
          seen.has(check.command)
        )
          return invalid(`${at}.command`);
        seen.add(check.command);
        if (typeof check.commandVersion !== 'number' || !Number.isSafeInteger(check.commandVersion) || check.commandVersion < 1)
          return invalid(`${at}.commandVersion`);
        if (!Array.isArray(check.keys) || !check.keys.length || (total += check.keys.length) > BULK_LIMIT) return invalid(`${at}.keys`);
        const keys = check.keys.map((key) => parseKey(key, false, `${at}.keys`));
        if (new Set(keys.map(commandKeyText)).size !== keys.length) return invalid(`${at}.keys`);
        return Object.freeze({ command: check.command, commandVersion: check.commandVersion, keys: Object.freeze(keys) });
      }),
    );
    // A refusal thrown inside the walk already names what it could; one from
    // the walk itself (bounds, prototypes, cycles) is about the body as a whole.
  } catch (error) {
    return invalid(error instanceof CommandInputError ? error.field : undefined);
  }
}

export interface CommandRequest {
  readonly command: string;
  readonly commandVersion: number;
  readonly key: CommandKey;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly input: unknown;
}

/** The multi-target envelope, for a command declared `targets: 'many'`. */
interface MultiCommandRequest {
  readonly command: string;
  readonly commandVersion: number;
  /** Ordered, duplicate-free, at most BULK_LIMIT. */
  readonly keys: readonly CommandKey[];
  /** Aligned with `keys`. */
  readonly expectedVersions: readonly number[];
  readonly idempotencyKey: string;
  readonly input: unknown;
}

/** A parsed request is exactly the envelope it came in, as a frozen copy. */
type ParsedCommandRequest = CommandRequest | MultiCommandRequest;

interface CommandTargetList {
  readonly keys: readonly CommandKey[];
  readonly expectedVersions: readonly number[];
  /** The request named its targets as `keys`, and its answer names them the same way. */
  readonly multi: boolean;
}

/** Either envelope's targets as one ordered list: the single envelope is a list of one. */
export function commandTargetList(request: ParsedCommandRequest): CommandTargetList {
  return 'keys' in request
    ? { keys: request.keys, expectedVersions: request.expectedVersions, multi: true }
    : { keys: [request.key], expectedVersions: [request.expectedVersion], multi: false };
}

const columns = /^[A-Za-z_][A-Za-z0-9_]*$/;
const commands = /^[A-Za-z][A-Za-z0-9_-]*$/;
const requestFields = new Set(['command', 'commandVersion', 'key', 'expectedVersion', 'idempotencyKey', 'input']);
const multiFields = new Set(['command', 'commandVersion', 'keys', 'expectedVersions', 'idempotencyKey', 'input']);
/* The refusal names the envelope member it objected to. Every name passed here
   is a literal of this module's own vocabulary, or an index this code counted
   — never a member name taken from the request, which is the least trusted
   text in the system and must not be echoed back by a refusal. A column
   inside a key is the one place a name could come from the payload, so those
   refusals name the key, not the column the caller wrote. */
const invalid = (field?: string): never => {
  throw new CommandInputError(field);
};

function parseKey(key: Json | undefined, creating: boolean, field = 'key'): CommandKey {
  if (!key || typeof key !== 'object' || Array.isArray(key)) return invalid(field);
  const entries = Object.entries(key);
  if (entries.length ? entries.length > 16 : !creating) return invalid(field);
  for (const [column, scalar] of entries) {
    if (!columns.test(column) || reservedKeys.has(column)) return invalid(field);
    if (typeof scalar === 'string') {
      if (Buffer.byteLength(scalar, 'utf8') > 1_024) return invalid(field);
    } else if (typeof scalar !== 'number' || !Number.isFinite(scalar)) return invalid(field);
  }
  return key as CommandKey;
}

/** Shape-only detached key capture using the same rule as command envelopes.
 * `creating` is trusted current command metadata, not a request grant. This
 * does not prove exact catalog key columns, typed validity or authorization.
 * Historical callers must preserve this spelling after canonicalKey validation. */
export function parseCommandKey(raw: unknown, creating = false): CommandKey {
  try {
    return parseKey(snapshot(raw, MAX_COMMAND_BYTES).value, creating);
  } catch {
    return invalid('key');
  }
}

function parseRevision(value: Json | undefined, field = 'expectedVersion'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return invalid(field);
  return value;
}

/** Scope-only recovery never invents original target, revision or input. */
export function parseCommandRecoveryRequest(raw: unknown) {
  const request = snapshot(raw, 4096).value;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return invalid();
  const data = request as Record<string, unknown>;
  if (Object.keys(data).length !== 3 || Object.keys(data).some((key) => !['command', 'commandVersion', 'idempotencyKey'].includes(key))) {
    return invalid(['command', 'commandVersion', 'idempotencyKey'].find((name) => !Object.hasOwn(data, name)));
  }
  if (typeof data.command !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(data.command) || reservedKeys.has(data.command))
    return invalid('command');
  if (typeof data.commandVersion !== 'number' || !Number.isSafeInteger(data.commandVersion) || data.commandVersion < 1)
    return invalid('commandVersion');
  if (typeof data.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.idempotencyKey)) return invalid('idempotencyKey');
  return Object.freeze({ command: data.command, commandVersion: data.commandVersion, idempotencyKey: data.idempotencyKey });
}

/** The route supplies App identity separately; this payload never accepts actor/source/SQL.
 * `creating` admits an empty key: a form's command names no existing row. It
 * is the caller's answer for the command the envelope names.
 * A request names one target (`key`, `expectedVersion`) or an ordered,
 * duplicate-free list of at most BULK_LIMIT (`keys`, `expectedVersions`). */
export function parseCommandEnvelope(
  raw: unknown,
  options: { creating?: boolean | ((command: string) => boolean) } = {},
): ParsedCommandRequest {
  try {
    // The entire request has the same bound as input alone, including envelope overhead.
    const value = snapshot(raw, MAX_COMMAND_BYTES).value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const request = value as Record<string, Json>;
    const fields = Object.keys(request);
    const multi = Object.hasOwn(request, 'keys');
    const expected = multi ? multiFields : requestFields;
    // A member the envelope wanted and did not get can be named, because the
    // name is the envelope's. One it did not want cannot: that name is the
    // caller's own text. So a request carrying something unknown is refused
    // without a field rather than quoting it back.
    if (fields.length !== expected.size || fields.some((field) => !expected.has(field))) {
      return invalid([...expected].find((name) => !Object.hasOwn(request, name)));
    }
    const command = request.command;
    if (typeof command !== 'string' || !commands.test(command) || reservedKeys.has(command)) return invalid('command');
    const commandVersion = request.commandVersion;
    if (typeof commandVersion !== 'number' || !Number.isSafeInteger(commandVersion) || commandVersion < 1) return invalid('commandVersion');
    const creating = typeof options.creating === 'function' ? options.creating(command) === true : options.creating === true;
    let keys: CommandKey[], expectedVersions: number[];
    if (multi) {
      // A form's command creates its rows; it has no list of records to name.
      if (creating) return invalid('keys');
      const list = request.keys,
        revisions = request.expectedVersions;
      if (!Array.isArray(list) || !list.length || list.length > BULK_LIMIT) return invalid('keys');
      if (!Array.isArray(revisions) || revisions.length !== list.length) return invalid('expectedVersions');
      keys = list.map((key, index) => parseKey(key, false, `keys[${index}]`));
      if (new Set(keys.map(commandKeyText)).size !== keys.length) return invalid('keys');
      expectedVersions = revisions.map((revision, index) => parseRevision(revision, `expectedVersions[${index}]`));
    } else {
      keys = [parseKey(request.key, creating)];
      expectedVersions = [parseRevision(request.expectedVersion)];
    }
    const idempotencyKey = request.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) return invalid('idempotencyKey');
    return Object.freeze(
      multi
        ? {
            command,
            commandVersion,
            keys: Object.freeze(keys),
            expectedVersions: Object.freeze(expectedVersions),
            idempotencyKey,
            input: request.input,
          }
        : { command, commandVersion, key: keys[0], expectedVersion: expectedVersions[0], idempotencyKey, input: request.input },
    );
    // A member's own refusal keeps its name through the rethrow; the bounded
    // walk's refusals are about the request as a whole and name nothing.
  } catch (error) {
    return invalid(error instanceof CommandInputError ? error.field : undefined);
  }
}

/** The single-target envelope, exactly as it always was: a `keys` list is
 * refused here. The executor, which learns the command's `targets` only after
 * parsing, reads either envelope through parseCommandEnvelope. */
export function parseCommandRequest(raw: unknown, options: { creating?: boolean | ((command: string) => boolean) } = {}): CommandRequest {
  const request = parseCommandEnvelope(raw, options);
  return 'keys' in request ? invalid('keys') : request;
}

/** The envelope a parsed request came in, with a replacement input. */
export function commandRequestBody(request: ParsedCommandRequest, input: unknown): Record<string, unknown> {
  return { ...request, input };
}

/** The single-target prepare body. A `keys` list is refused here: the paths
 * that call this one prepare exactly one record. `creating` admits the empty
 * key of a signed-in form's command, as execution does: its form prepares
 * its starting values over no record. */
export function parseCommandPrepareRequest(
  raw: unknown,
  options: { creating?: (command: string) => boolean } = {},
): Pick<CommandRequest, 'command' | 'commandVersion' | 'key'> {
  const value = JSON.parse(canonicalCommandJson(raw)) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).length !== 3 || Object.keys(value).some((key) => !['command', 'commandVersion', 'key'].includes(key))) {
    return invalid(['command', 'commandVersion', 'key'].find((name) => !Object.hasOwn(value, name)));
  }
  const request = parseCommandRequest(
    {
      ...value,
      expectedVersion: 0,
      idempotencyKey: 'prepare-request-0000',
      input: null,
    },
    options,
  ) as CommandRequest;
  return Object.freeze({ command: request.command, commandVersion: request.commandVersion, key: request.key });
}

/** A prepare body naming one target (`key`) or several (`keys`), under the
 * same bounds, order and duplicate rule as execution. */
export function parseCommandPrepareTargets(
  raw: unknown,
  options: { creating?: (command: string) => boolean } = {},
): { command: string; commandVersion: number } & Omit<CommandTargetList, 'expectedVersions'> {
  const value = JSON.parse(canonicalCommandJson(raw)) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (!Object.hasOwn(value, 'keys')) {
    const single = parseCommandPrepareRequest(value, options);
    return Object.freeze({
      command: single.command,
      commandVersion: single.commandVersion,
      keys: Object.freeze([single.key]),
      multi: false,
    });
  }
  if (Object.keys(value).length !== 3 || Object.keys(value).some((key) => !['command', 'commandVersion', 'keys'].includes(key))) {
    return invalid(['command', 'commandVersion', 'keys'].find((name) => !Object.hasOwn(value, name)));
  }
  if (!Array.isArray(value.keys)) return invalid('keys');
  const request = parseCommandEnvelope({
    ...value,
    expectedVersions: value.keys.map(() => 0),
    idempotencyKey: 'prepare-request-0000',
    input: null,
  });
  return Object.freeze({
    command: request.command,
    commandVersion: request.commandVersion,
    keys: commandTargetList(request).keys,
    multi: true,
  });
}
