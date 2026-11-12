/**
 * A handler's `link(name)` and `revokeLinks(name?)` (businessCommands.ts):
 * minting and revoking capability links in the command's own transaction.
 *
 * A mint is queued while the handler runs and written once the receipt id is
 * known (businessCommandExecution.ts), so a link names the receipt that made it
 * and is rolled back with a command that does not commit. What the handler
 * holds is a LinkRef, `mistri-link:<id>`: the URL never reaches the receipt.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal, CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import type { AppLinkDef } from '../../shared/appLinks.js';
import { LinkRef, newLinkId } from './linkToken.js';

class CommandLinkUnavailable extends Refusal {
  constructor(message = 'Capability links are kept in the command journal, and this store keeps none.') {
    super(message);
    this.name = 'CommandLinkUnavailable';
  }
}

interface HandlerLinks {
  link(name: string): Promise<LinkRef>;
  revokeLinks(name?: string): Promise<number>;
  /** The mints queued so far, each written with the receipt's id (mintQueued). */
  readonly queued: Omit<CommandLinkRow, 'receipt'>[];
}

/**
 * `links` is what the authorizer let this actor mint (AuthorizedBusinessCommand.links); `rowKey` is the record's key
 * text (commandKeyText), absent where the command names no one existing record. A public command names none: its
 * `rowKey` is asked when it mints, and answers the one row it has made on its target by then, or nothing.
 */
export function handlerLinks(options: {
  journal: CommandJournal;
  appId: string;
  tenant: string;
  resource: string;
  command: string;
  actorId: string;
  links: Readonly<Record<string, AppLinkDef>> | undefined;
  rowKey: string | undefined | (() => string | undefined);
  now: () => Date;
}): HandlerLinks {
  const queued: Omit<CommandLinkRow, 'receipt'>[] = [];
  const made = typeof options.rowKey === 'function';
  const rowKey = (): string | undefined => (typeof options.rowKey === 'function' ? options.rowKey() : options.rowKey);
  const declared = (name: unknown): { def: AppLinkDef; rowKey: string } => {
    const def = typeof name === 'string' && options.links && Object.hasOwn(options.links, name) ? options.links[name] : undefined;
    const key = rowKey();
    if (!def || key === undefined)
      throw new TypeError(
        options.links && key !== undefined
          ? `Command "${options.command}" asked for a link "${String(name)}", which resource "${options.resource}" does not declare (links).`
          : made && options.links
            ? `Command "${options.command}" cannot mint a link yet: a public command mints one on the one record it has made on ` +
              `"${options.resource}", so it inserts exactly one first.`
            : `Command "${options.command}" cannot mint a link: one is minted by a person or a service, on the one existing record a ` +
              `command targets, or by a public command on the one record it made, in an App that serves links.`,
      );
    return { def, rowKey: key };
  };
  return {
    queued,
    async link(name) {
      const { def, rowKey } = declared(name);
      if (typeof options.journal.mintLink !== 'function') throw new CommandLinkUnavailable();
      const at = options.now().getTime();
      const row = {
        id: newLinkId(),
        app: options.appId,
        tenant: options.tenant,
        resource: options.resource,
        rowKey,
        name,
        expiresAt: at + def.expires,
        usesLeft: def.uses ?? null,
        revokedAt: null,
        createdAt: at,
        createdBy: options.actorId,
        command: options.command,
        opens: 0,
        lastOpenedAt: null,
      };
      queued.push(row);
      return new LinkRef(row.id);
    },
    async revokeLinks(name) {
      const key = name !== undefined ? declared(name).rowKey : options.links ? rowKey() : undefined;
      if (key === undefined) declared(undefined);
      if (typeof options.journal.revokeLinks !== 'function') throw new CommandLinkUnavailable();
      // A mint queued in this command and revoked in it is never written.
      for (let at = queued.length - 1; at >= 0; at--) if (name === undefined || queued[at].name === name) queued.splice(at, 1);
      return options.journal.revokeLinks(options.appId, options.resource, key!, name, options.now().getTime());
    },
  };
}

/** Writes the queued mints with the receipt that made them, in the command's transaction. */
export async function mintQueued(journal: CommandJournal, links: HandlerLinks, receipt: string): Promise<void> {
  for (const row of links.queued) await journal.mintLink!({ ...row, receipt });
}
