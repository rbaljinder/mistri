/**
 * Files a form holds for its command: a `field.files` or `field.signature`
 * value. A form cannot carry a file inside its command's input — a public
 * submission is held to 64 KB, and a command's envelope to its own bound — so
 * each file is sent on its own as it is picked, dropped or pasted, held, and
 * named in the input by an id. Held:
 *
 * - under the grant that runs the command: the same authorization, by the
 *   same person (or the same public form), the field a file resource the
 *   command writes, and the resource's cap and its 413;
 * - for the person who sent it: `actor:<id>` signed in, and on a public form
 *   the visitor's own cookie (HttpOnly, SameSite=Strict, scoped to the
 *   form's path), so one person's id is no use to another;
 * - by an id of 32 random bytes the sender alone is told; the store keeps its
 *   hash, so the id is never guessable and never read back out;
 * - for a day signed in and an hour on a public form, within a count and a
 *   size per sender, and on a public form within the bytes one client
 *   address may send in a day and the App's share of every visitor's
 *   together: what is held is never readable back, so it is no place to keep
 *   anything.
 *
 * The command takes them in its own transaction (adapters/commands/
 * commandStaging.ts): deleted as the handler is handed the files, so a
 * refused or rolled-back command takes none, and an id used once is used up.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppAccessDenied } from '../app/appAccess.js';
import { acceptsMedia, STAGED_FILE_ID } from '../../shared/command.js';
import { heldFileFields, heldFilePath } from '../../shared/commandInput.js';
import { fileValues } from '../http/fileRows.js';
import { sniffImage } from '../http/imageSniff.js';
import { StagedFileRefused, StagedFilesFull, type StagedLimits } from '../../adapters/commands/commandStaging.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { AppCommandField } from '../../shared/command.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from './businessCommandAccess.js';
import { BusinessCommandExecutionError } from './commandErrors.js';
import type { BusinessCommandActor, BusinessCommandRegistry, CommandFile } from './businessCommands.js';

/** How long a held file waits for its command. */
const STAGED_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a public form's held file waits: a visitor attaches and sends in one sitting, and what a visitor never sent
    stops counting against the share every visitor holds together within the hour rather than the day. */
export const PUBLIC_STAGED_FILE_TTL_MS = 60 * 60 * 1000;
/** What a signed-in person may hold at once. */
const STAGED_MOST: StagedLimits = Object.freeze({ files: 40, bytes: 200 * 1024 * 1024 });
/** The most bytes one file sent to a public form may be, whatever its resource takes. */
export const PUBLIC_STAGED_FILE_MOST = 10 * 1024 * 1024;
/** What one visitor of a public form may hold at once, and every visitor of the App's forms together. */
export const PUBLIC_STAGED_MOST: StagedLimits = Object.freeze({
  files: 10,
  bytes: 25 * 1024 * 1024,
  shared: Object.freeze({ prefix: 'visitor:', bytes: 256 * 1024 * 1024 }),
});

type HeldField = Extract<AppCommandField, { type: 'files' | 'signature' }>;

/** A refusal of a file sent to be held, said with the status a host answers. */
export class StageRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413 | 415 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StageRefusal';
  }
}

/** A sender who holds as many as they may, said as the answer a host sends. */
export const stagedFullRefusal = (full: StagedFilesFull): StageRefusal =>
  new StageRefusal(429, 'too_many_files', `${full.message} Send the form, or remove a file, and try again.`);

/** The hash a held file is kept under. */
export const stagedIdHash = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex');

/** Whose a held file is: the signed-in account, or the public form's visitor by their cookie; undefined for nobody. */
export function stagedOwner(actor: BusinessCommandActor, visitor: string | undefined): string | undefined {
  if (actor.kind === 'public') return visitor && STAGED_FILE_ID.test(visitor) ? `visitor:${stagedIdHash(visitor)}` : undefined;
  if (actor.kind !== undefined) return undefined;
  return typeof actor.id === 'string' && actor.id ? `actor:${actor.id}` : undefined;
}

/* ---------- the visitor's cookie ---------- */

const visitorCookieName = (form: string): string => `mistri_files_${form}`;

/** The visitor's token for this form's held files, from the request's cookie; undefined for none or anything malformed. */
export function readVisitorToken(req: Pick<IncomingMessage, 'headers'>, form: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  const name = visitorCookieName(form);
  let found: string | undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    // Two cookies of one name (a path trick from a sibling page) name nobody.
    if (found !== undefined) return undefined;
    found = part.slice(at + 1).trim();
  }
  return found !== undefined && STAGED_FILE_ID.test(found) ? found : undefined;
}

/** A new visitor token. */
export const newVisitorToken = (): string => randomBytes(32).toString('base64url');

/** The Set-Cookie value: HttpOnly, SameSite=Strict, for the form's own API paths, for as long as a public held file waits. */
export function visitorCookie(form: string, token: string, secure: boolean): string {
  const parts = [
    `${visitorCookieName(form)}=${token}`,
    `Path=/api/forms/${form}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${PUBLIC_STAGED_FILE_TTL_MS / 1000}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ---------- holding a file ---------- */

/** The type a held file is kept as: a picture's read from its bytes; a claimed picture that is not one is plain bytes. */
function heldType(claimed: unknown, bytes: Uint8Array): string {
  const sniffed = sniffImage(bytes);
  if (sniffed) return sniffed;
  const said =
    typeof claimed === 'string' && claimed.length <= 127 && /^[\w.+-]+\/[\w.+-]+$/.test(claimed)
      ? claimed.toLowerCase()
      : 'application/octet-stream';
  return said.startsWith('image/') ? 'application/octet-stream' : said;
}

const fieldWord = (field: HeldField) => (field.type === 'signature' ? 'signature' : 'file');

/**
 * Holds one file for `command`'s field `field`, sent by `actor` (with a public form's `visitor` token): the body is
 * `{ command, field, file: { name, type?, data } }`, the bytes base64. Answers the held file's id, never kept here,
 * with its name, type and size as held.
 */
export async function stageCommandFile(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  body: unknown,
  options: { visitor?: string; now?: () => Date } = {},
): Promise<{ id: string; name: string; type: string; size: number }> {
  const said = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const { command: commandId, field: fieldName, file } = said;
  if (typeof commandId !== 'string' || typeof fieldName !== 'string' || !file || typeof file !== 'object' || Array.isArray(file))
    throw new StageRefusal(400, 'invalid_input', 'A file is held as { command, field, file: { name, type, data } }.');
  let authorized;
  try {
    authorized = binding.authorize(commandId, actor);
  } catch (error) {
    if (error instanceof AppAccessDenied || error instanceof BusinessCommandExecutionError)
      throw new StageRefusal(403, 'forbidden', 'This command is not available to this account.');
    throw error;
  }
  const publicActor = actor.kind === 'public';
  // A public form holds files for its own public command, and a signed-in person for a command that is not one.
  if (publicActor !== (authorized.command.public === true) || (publicActor && authorized.actor.kind !== 'public'))
    throw new StageRefusal(403, 'forbidden', 'This command is not available to this account.');
  /* A field inside a group is named by its path, a repeating group's rows by `[]` (`attachments[].file`; a row's own
     `attachments[2].file` is read as that): the hold is the field's, whichever row it ends up in. */
  const path = heldFilePath(fieldName);
  const field = heldFileFields(authorized.command.fields).find((each) => each.path === path)?.field as HeldField | undefined;
  if (!field) throw new StageRefusal(404, 'no_such_field', 'This command takes no file by that name.');
  const rule = authorized.files?.get(field.from);
  if (!rule) throw new StageRefusal(404, 'no_such_field', 'This command takes no file by that name.');
  const owner = stagedOwner(authorized.actor.kind === 'public' ? actor : authorized.actor, options.visitor);
  if (!owner) throw new StageRefusal(403, 'forbidden', 'This file cannot be held for you.');
  const { name, type, data } = file as Record<string, unknown>;
  if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new StageRefusal(400, 'invalid_input', 'The file content must be base64.');
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  if (!bytes.byteLength) throw new StageRefusal(400, 'invalid_input', 'The file is empty.');
  // The resource's cap, and on a public form never more than a public file may be.
  const cap = publicActor ? Math.min(rule.maxBytes, PUBLIC_STAGED_FILE_MOST) : rule.maxBytes;
  const made = fileValues({ ...rule, maxBytes: cap }, { name, type, bytes }, {});
  if ('error' in made)
    throw new StageRefusal(made.status === 413 ? 413 : 400, made.status === 413 ? 'too_large' : 'invalid_input', made.error);
  const kept = made.values[rule.name] as string;
  const media = heldType(type, bytes);
  if (field.type === 'signature' ? media !== 'image/png' : !acceptsMedia(field.accept, media))
    throw new StageRefusal(
      415,
      'unsupported_type',
      field.type === 'signature'
        ? 'A signature is held as a PNG picture.'
        : `"${kept}" is not a type this ${fieldWord(field)} takes${field.accept ? ` (${field.accept.join(', ')})` : ''}.`,
    );
  if (!authorized.commandTransaction) throw new StageRefusal(503, 'temporarily_unavailable', 'Files cannot be held just now.');
  const id = randomBytes(32).toString('base64url');
  const now = (options.now ?? (() => new Date()))().getTime();
  try {
    await authorized.commandTransaction(async (_records, journal) => {
      if (typeof journal.stage !== 'function') throw new StageRefusal(503, 'temporarily_unavailable', 'Files cannot be held here.');
      await journal.stage(
        authorized.actor.appId,
        {
          idHash: stagedIdHash(id),
          owner,
          command: commandId,
          field: path,
          name: kept,
          type: media,
          size: bytes.byteLength,
          data: bytes,
          expiresAt: now + (publicActor ? PUBLIC_STAGED_FILE_TTL_MS : STAGED_FILE_TTL_MS),
        },
        publicActor ? PUBLIC_STAGED_MOST : STAGED_MOST,
        now,
      );
    });
  } catch (error) {
    // Said from inside the transaction, so it may arrive as the failed transaction's cause.
    const cause = error instanceof Error && !(error instanceof StagedFilesFull) && !(error instanceof StageRefusal) ? error.cause : error;
    if (cause instanceof StagedFilesFull) throw stagedFullRefusal(cause);
    if (cause instanceof StageRefusal) throw cause;
    throw error;
  }
  return { id, name: kept, type: media, size: bytes.byteLength };
}

/* ---------- taking them ---------- */

/**
 * The files a command's input names by id, taken from what is held for its sender, in the command's transaction:
 * each field's value becomes its files (a signature's one file), and a group holding a file field becomes its value
 * with each row's files in place, so a row's handler code reads `row.file` as it reads a top-level field. A file not
 * held for this sender, command and field path — another person's, another field's, one used already, one past its
 * day — refuses the command at that field (`attachments[1].file`), and nothing is taken.
 */
export async function takeHeldFiles(
  fields: readonly AppCommandField[],
  input: unknown,
  journal: CommandJournal,
  scope: { appId: string; command: string; owner: string | undefined; now: number },
): Promise<{
  files: Record<string, unknown>;
  taken: readonly CommandFile[];
  from: ReadonlyMap<CommandFile, string>;
}> {
  const taken: CommandFile[] = [];
  const from = new Map<CommandFile, string>();
  const take = async (field: HeldField, value: unknown, at: string): Promise<CommandFile | readonly CommandFile[] | undefined> => {
    if (value === undefined) return undefined;
    const ids = (Array.isArray(value) ? value : [value]) as string[];
    if (!ids.length) return undefined;
    if (!scope.owner || typeof journal.takeStaged !== 'function')
      throw new BusinessCommandExecutionError('invalid_input', 'not_applied', at);
    let held;
    try {
      held = await journal.takeStaged(scope.appId, {
        owner: scope.owner,
        command: scope.command,
        field: heldFilePath(at),
        hashes: ids.map(stagedIdHash),
        now: scope.now,
      });
    } catch (error) {
      if (error instanceof StagedFileRefused) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', at);
      throw error;
    }
    const each = held.map((file) => {
      const made: CommandFile = Object.freeze({ name: file.name, type: file.type, size: file.size, data: file.data });
      from.set(made, field.from);
      return made;
    });
    taken.push(...each);
    return field.type === 'signature' ? each[0]! : Object.freeze(each);
  };
  /* The fields of `list` that hold files, or hold a group that does, replaced in `values`: what is handed back is only
     what changed, and a group is handed back whole — a copy of its object or rows with the files in place. */
  const within = async (list: readonly AppCommandField[], values: Record<string, unknown>, path: string) => {
    const changed: Record<string, unknown> = {};
    for (const field of list) {
      const at = path ? `${path}.${field.name}` : field.name;
      const value = values[field.name];
      if (field.type === 'files' || field.type === 'signature') {
        const files = await take(field, value, at);
        if (files !== undefined) changed[field.name] = files;
      } else if (field.type === 'group' && heldFileFields(field.fields).length && value && typeof value === 'object') {
        const row = async (each: unknown, rowAt: string) => {
          const plain = each && typeof each === 'object' ? (each as Record<string, unknown>) : {};
          return Object.freeze({ ...plain, ...(await within(field.fields, plain, rowAt)) });
        };
        if (!Array.isArray(value)) changed[field.name] = await row(value, at);
        else {
          // One row after another: the takes share the command's one transaction, and the first refusal is the first row's.
          const rows: unknown[] = [];
          for (const [index, each] of value.entries()) rows.push(await row(each, `${at}[${index}]`));
          changed[field.name] = Object.freeze(rows);
        }
      }
    }
    return changed;
  };
  const values = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return { files: await within(fields, values, ''), taken, from };
}

/* ---------- a lookup's read ---------- */

/* Where the input names held id `id`: the value's own path (`attachments[1].file`), or undefined where no file field
   of the command holds it. */
function heldAt(fields: readonly AppCommandField[], input: unknown, id: string): string | undefined {
  const values = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'files' || field.type === 'signature') {
      if (value === id || (Array.isArray(value) && value.includes(id))) return field.name;
    } else if (field.type === 'group' && value && typeof value === 'object') {
      const rows = Array.isArray(value) ? value : [value];
      for (const [index, row] of rows.entries()) {
        const inner = heldAt(field.fields, row, id);
        if (inner) return `${field.name}${Array.isArray(value) ? `[${index}]` : ''}.${inner}`;
      }
    }
  }
  return undefined;
}

/** Thrown inside the read's transaction so the take rolls back and the file stays held for the command. */
class HeldReadDone extends Error {}

/**
 * A lookup's `files.read(id)`: one file the command's input names by id, read from what is held for its sender and
 * left held, so the handler takes it as it would have. The read is a take that rolls back: who may take a held file —
 * this sender, this command, this field path, within its day — is the take's rule in every store and every tenant
 * fence, and a second copy of that rule would be one to drift. An id the input does not name, or one not held for this
 * sender (another visitor's, one used already, one past its day), refuses at its field as the take would.
 */
export async function readHeldFile(
  fields: readonly AppCommandField[],
  input: unknown,
  id: unknown,
  transaction: AuthorizedBusinessCommand['commandTransaction'],
  scope: { appId: string; command: string; owner: string | undefined; now: number },
): Promise<CommandFile> {
  const at = typeof id === 'string' && STAGED_FILE_ID.test(id) ? heldAt(fields, input, id) : undefined;
  if (!at || !scope.owner || !transaction) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', at);
  let read: CommandFile | undefined;
  try {
    await transaction(async (_records, journal) => {
      if (typeof journal.takeStaged !== 'function') return;
      const [file] = await journal.takeStaged(scope.appId, {
        owner: scope.owner!,
        command: scope.command,
        field: heldFilePath(at),
        hashes: [stagedIdHash(id as string)],
        now: scope.now,
      });
      if (file) read = Object.freeze({ name: file.name, type: file.type, size: file.size, data: file.data });
      throw new HeldReadDone();
    });
  } catch (error) {
    if (read) return read;
    // Said from inside the transaction, so it may arrive as the failed transaction's cause.
    const cause = error instanceof Error && !(error instanceof StagedFileRefused) ? error.cause : error;
    if (!(error instanceof StagedFileRefused) && !(cause instanceof StagedFileRefused) && !(error instanceof HeldReadDone)) throw error;
  }
  throw new BusinessCommandExecutionError('invalid_input', 'not_applied', at);
}

/**
 * `[lookup-files-unattached]`: a lookup that reads `files.read(…)` in a command with no `field.files` or
 * `field.signature`. A lookup reads only what its own form attached, so every such read is refused; said by
 * `check` as advice, since it is read off the lookup's text and a helper's call is not seen.
 */
export function lookupFileWarnings(commands: BusinessCommandRegistry | undefined): string[] {
  if (!commands) return [];
  const warnings: string[] = [];
  for (const [id, command] of Object.entries(commands)) {
    if (!command.lookup || heldFileFields(command.fields).length) continue;
    if (!/\bfiles\s*\.\s*read\s*\(/.test(String(command.lookup))) continue;
    warnings.push(
      `command "${id}" reads files.read in its lookup and takes no file [lookup-files-unattached]: ` +
        'a lookup reads only a file its own form attached, by the id a field.files or field.signature holds, so this read is always refused → add the file field, or read a kept file in the handler with db.<resource>.readFile.',
    );
  }
  return warnings;
}
