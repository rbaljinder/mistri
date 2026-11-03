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
 * - for a day, within a count and a size per sender, and on a public form
 *   within the form's own share of every visitor's together: what is held is
 *   never readable back, so it is no place to keep anything.
 *
 * The command takes them in its own transaction (adapters/commands/
 * commandStaging.ts): deleted as the handler is handed the files, so a
 * refused or rolled-back command takes none, and an id used once is used up.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppAccessDenied } from '../app/appAccess.js';
import { acceptsMedia, STAGED_FILE_ID } from '../../shared/command.js';
import { fileValues } from '../http/fileRows.js';
import { sniffImage } from '../http/imageSniff.js';
import { StagedFileRefused, StagedFilesFull, type StagedLimits } from '../../adapters/commands/commandStaging.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { AppCommandField } from '../../shared/command.js';
import type { BusinessCommandBinding } from './businessCommandAccess.js';
import { BusinessCommandExecutionError } from './commandErrors.js';
import type { BusinessCommandActor, CommandFile } from './businessCommands.js';

/** How long a held file waits for its command. */
const STAGED_FILE_TTL_MS = 24 * 60 * 60 * 1000;
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

/** The Set-Cookie value: HttpOnly, SameSite=Strict, for the form's own API paths, for as long as a held file waits. */
export function visitorCookie(form: string, token: string, secure: boolean): string {
  const parts = [
    `${visitorCookieName(form)}=${token}`,
    `Path=/api/forms/${form}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${STAGED_FILE_TTL_MS / 1000}`,
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
  const field = authorized.command.fields.find(
    (each): each is HeldField => each.name === fieldName && (each.type === 'files' || each.type === 'signature'),
  );
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
          field: field.name,
          name: kept,
          type: media,
          size: bytes.byteLength,
          data: bytes,
          expiresAt: now + STAGED_FILE_TTL_MS,
        },
        publicActor ? PUBLIC_STAGED_MOST : STAGED_MOST,
        now,
      );
    });
  } catch (error) {
    // Said from inside the transaction, so it may arrive as the failed transaction's cause.
    const cause = error instanceof Error && !(error instanceof StagedFilesFull) && !(error instanceof StageRefusal) ? error.cause : error;
    if (cause instanceof StagedFilesFull)
      throw new StageRefusal(429, 'too_many_files', `${cause.message} Send the form, or remove a file, and try again.`);
    if (cause instanceof StageRefusal) throw cause;
    throw error;
  }
  return { id, name: kept, type: media, size: bytes.byteLength };
}

/* ---------- taking them ---------- */

/**
 * The files a command's input names by id, taken from what is held for its sender, in the command's transaction:
 * each field's value becomes its files (a signature's one file). A file not held for this sender, command and field —
 * another person's, one used already, one past its day — refuses the command at that field, and nothing is taken.
 */
export async function takeHeldFiles(
  fields: readonly AppCommandField[],
  input: unknown,
  journal: CommandJournal,
  scope: { appId: string; command: string; owner: string | undefined; now: number },
): Promise<{
  files: Record<string, CommandFile | readonly CommandFile[]>;
  taken: readonly CommandFile[];
  from: ReadonlyMap<CommandFile, string>;
}> {
  const files: Record<string, CommandFile | readonly CommandFile[]> = {};
  const taken: CommandFile[] = [];
  const from = new Map<CommandFile, string>();
  const values = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const field of fields) {
    if (field.type !== 'files' && field.type !== 'signature') continue;
    const value = values[field.name];
    if (value === undefined) continue;
    const ids = (Array.isArray(value) ? value : [value]) as string[];
    if (!ids.length) continue;
    if (!scope.owner || typeof journal.takeStaged !== 'function')
      throw new BusinessCommandExecutionError('invalid_input', 'not_applied', field.name);
    let held;
    try {
      held = await journal.takeStaged(scope.appId, {
        owner: scope.owner,
        command: scope.command,
        field: field.name,
        hashes: ids.map(stagedIdHash),
        now: scope.now,
      });
    } catch (error) {
      if (error instanceof StagedFileRefused) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', field.name);
      throw error;
    }
    const each = held.map((file) => {
      const made: CommandFile = Object.freeze({ name: file.name, type: file.type, size: file.size, data: file.data });
      from.set(made, field.from);
      return made;
    });
    taken.push(...each);
    files[field.name] = field.type === 'signature' ? each[0]! : Object.freeze(each);
  }
  return { files, taken, from };
}
