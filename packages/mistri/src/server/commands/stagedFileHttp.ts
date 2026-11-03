/**
 * The two doors a file is held through (stagedFiles.ts): a signed-in form's,
 * `POST /api/commands/files`, under the session's account; and a public
 * form's, `POST /api/forms/<key>/files`, under the form's own public
 * principal and the visitor's cookie, which this door sets where the visitor
 * has none, for the form's own command whatever the body names. Each binds the App's commands as a run would, so a file is held
 * only under the grant that runs its command.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { FILE_UPLOAD_BODY, HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { cookieUnder } from '@mistriwork/engine/shared/mount.js';
import type { AppDef } from '../../shared/app.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { bindHttpBusinessCommands } from './businessCommandLoader.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from './businessCommands.js';
import {
  newVisitorToken,
  PUBLIC_STAGED_FILE_MOST,
  readVisitorToken,
  StageRefusal,
  stageCommandFile,
  visitorCookie,
} from './stagedFiles.js';

/** A public file's body: base64 of the largest file a public form holds, and room for the rest. */
const PUBLIC_FILE_BODY = Math.ceil(PUBLIC_STAGED_FILE_MOST / 3) * 4 + 64 * 1024;

interface StageDoor {
  req: IncomingMessage;
  res: ServerResponse;
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  connection: string;
  events?: CommandJournalAppScope;
  actor: BusinessCommandActor;
  limit: number;
  visitor?: string;
  /** A public form's command: the visitor names only the field, never which command the file is for. */
  command?: string;
}

async function stage(door: StageDoor): Promise<void> {
  const { req, res, registry, app, connection } = door;
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > door.limit) {
    // The rest of the body is left unread, so the connection carries nothing after the answer.
    res.setHeader('connection', 'close');
    send(res, 413, { code: 'too_large', error: 'This file is too large.' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req, door.limit);
    if (door.command !== undefined) body = { ...body, command: door.command };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 413) res.setHeader('connection', 'close');
    send(res, error.status, { code: error.status === 413 ? 'too_large' : 'invalid_input', error: error.message });
    return;
  }
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
    const { binding } = bindHttpBusinessCommands(
      app,
      door.commands,
      resources,
      (owner) => registry.configOf(owner)?.writable === true,
      door.events,
    );
    const held = await stageCommandFile(binding, door.actor, body, door.visitor ? { visitor: door.visitor } : {});
    send(res, 200, held);
  } catch (error) {
    if (!(error instanceof StageRefusal)) throw error;
    send(res, error.status, { code: error.code, error: error.message });
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** A signed-in form's file, held for the session's account. */
export async function stageFileHttp(ctx: RequestContext, connection: string, actor: BusinessCommandActor): Promise<void> {
  const { req, res, registry, commands, signedIn } = ctx;
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    send(res, 405, { error: 'A file is held with POST.' });
    return;
  }
  await stage({
    req,
    res,
    registry,
    app: signedIn!.app.app,
    commands: commands!.registry,
    connection,
    ...(commands!.events ? { events: commands!.events } : {}),
    actor,
    limit: FILE_UPLOAD_BODY,
  });
}

/** A public form's file, held for the visitor by their cookie, which is set here where they have none. */
export async function stagePublicFileHttp(
  ctx: RequestContext,
  options: {
    app: AppDef;
    commands: BusinessCommandRegistry;
    events?: CommandJournalAppScope;
    connection: string;
    actor: BusinessCommandActor;
    key: string;
    command: string;
    secure: boolean;
  },
): Promise<void> {
  const { req, res, registry } = ctx;
  let visitor = readVisitorToken(req, options.key);
  if (!visitor) {
    visitor = newVisitorToken();
    res.setHeader('set-cookie', cookieUnder(ctx.mount.base, visitorCookie(options.key, visitor, options.secure)));
  }
  await stage({
    req,
    res,
    registry,
    app: options.app,
    commands: options.commands,
    connection: options.connection,
    ...(options.events ? { events: options.events } : {}),
    actor: options.actor,
    limit: PUBLIC_FILE_BODY,
    visitor,
    command: options.command,
  });
}
