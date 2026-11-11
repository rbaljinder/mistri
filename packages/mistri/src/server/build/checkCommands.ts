/* The checks of a command's own declaration against the App's roles and its handler's text: what it reads under its own
   authority, what a granted role cannot read, and a tenant App's public command that removes a row. */
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { genericWriteOf } from '../commands/genericWriteBrand.js';
import { flowCommandOf } from '../commands/flowCommandBrand.js';
import { callerRead, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { appCommandGrants, logicalResource, resolveAppAccess, type AppDef } from '../../shared/app.js';

/**
 * Every read a command makes under its own authority rather than its
 * caller's (`elevate`), as `check --design` lists them: which tables, and
 * which roles granted the command would not read them otherwise.
 */
export function commandElevations(app: AppDef, commands: BusinessCommandRegistry, schema: DatabaseSchema | undefined): string[] {
  return Object.entries(commands)
    .filter(([, command]) => command.elevate?.read.length)
    .map(([id, command]) => {
      const tables = command.elevate!.read.map((local) => logicalResource(app, command.source, local));
      const roles = Object.keys(app.auth?.roles ?? {}).filter((role) => appCommandGrants(app, [role]).has(id));
      const blind = schema
        ? roles.filter((role) => {
            try {
              const readable = resolveAppAccess(app, schema, [role]).readable;
              return tables.some((table) => !readable.has(table));
            } catch {
              return false;
            }
          })
        : [];
      return (
        `command "${id}" reads ${tables.map((table) => `"${table}"`).join(', ')} under its own authority` +
        (blind.length ? `, for role${blind.length === 1 ? '' : 's'} ${blind.map((role) => `"${role}"`).join(', ')}` : '')
      );
    });
}

/**
 * Each role granted a command that cannot read a table the command's caller must (`read`, less what it `elevate`s):
 * every run is refused for that role, so each is named with its command and table. Public, flow and generic-write
 * commands are no role's grant.
 */
export function commandUnreadable(app: AppDef, commands: BusinessCommandRegistry, schema: DatabaseSchema): string[] {
  const out: string[] = [];
  for (const [id, command] of Object.entries(commands)) {
    if (command.public === true || genericWriteOf(command) !== undefined || flowCommandOf(command) !== undefined) continue;
    /* A file resource it writes beside its target, it may only add to for a role that cannot read it: the run goes
       ahead and a read of those rows is refused then (businessCommandAuthorization.ts insertOnly). */
    const tables = callerRead(command)
      .filter(
        (local) =>
          local === command.target || !command.write.includes(local) || !app.resources?.[logicalResource(app, command.source, local)]?.file,
      )
      .map((local) => logicalResource(app, command.source, local));
    for (const role of Object.keys(app.auth?.roles ?? {})) {
      if (!appCommandGrants(app, [role]).has(id)) continue;
      let readable: ReadonlySet<string>;
      try {
        readable = resolveAppAccess(app, schema, [role]).readable;
      } catch {
        continue;
      }
      for (const table of tables.filter((each) => !readable.has(each)))
        out.push(
          `command "${id}" is granted to role "${role}", which cannot read "${table}" its read names, so every run is refused [command-reads-unreadable]. ` +
            `Let "${role}" read "${table}", drop it from the command's read, or elevate its read.`,
        );
    }
  }
  return out;
}

/* `db.lead.remove(`, `db['lead'].remove(`, `tx.lead.remove(`: what a handler's text shows of a removal. A removal it
   makes through a helper elsewhere is not seen, and the run refuses it all the same. */
const HANDLER_REMOVES = /\b(?:db|tx)\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]\n]{1,80}\])\s*\.\s*remove\s*\(/;

/**
 * Each public command of a tenant App whose handler removes a row: a signed-out submission is placed with one tenant
 * and may insert, and update that tenant's declared rows, never delete, so every run is refused.
 */
export function publicCommandRemovals(commands: BusinessCommandRegistry): string[] {
  const out: string[] = [];
  for (const [id, command] of Object.entries(commands)) {
    if (command.public !== true || typeof command.handle !== 'function') continue;
    let text: string;
    try {
      text = Function.prototype.toString.call(command.handle);
    } catch {
      continue;
    }
    if (HANDLER_REMOVES.test(text))
      out.push(
        `public command "${id}" removes a row in its handler, and a signed-out submission to a tenant App may not delete, so every run is refused [public-command-remove]. ` +
          `Mark the row (a status or a closed_at) instead of removing it, or make the removal a signed-in command.`,
      );
  }
  return out;
}
