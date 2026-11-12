/**
 * A link found by id, in the command journal beside the records it names: what the link door reads
 * (linkRoutes.ts), and what turns a handler's `mistri-link:<id>` into a URL where one may be said — the minting
 * command's HTTP answer and an effect's delivery (renderLinkRefs).
 */
import type { CommandJournal, CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import type { AppDef } from '../../shared/app.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { commandsOf } from '../stores/commandStores.js';
import { linkUrl, renderLinkRefs } from './linkToken.js';

/** Whether any resource of the App declares a link: only then is `/l/` a door, or a command's answer read for one. */
export const servesLinks = (app: Pick<AppDef, 'resources'>): boolean =>
  Object.values(app.resources ?? {}).some((resource) => resource.links && Object.keys(resource.links).length > 0);

type JournalLinks = Pick<CommandJournal, 'readLink' | 'openLink' | 'revokeLinks'>;

interface FoundLink {
  readonly row: CommandLinkRow;
  /** A transaction on the journal that holds the link (openLink spends a use there). */
  journal<T>(run: (journal: JournalLinks) => Promise<T>): Promise<T>;
}

/* An App's links are kept in the journal of each connection that holds a resource declaring some; the id is random,
   so it is asked of each in turn. Most Apps have one. */
export async function lookUpLink(app: AppDef, resources: RuntimeResources, id: string, now: number): Promise<FoundLink | undefined> {
  const owners = new Set(
    Object.entries(app.resources ?? {})
      .filter(([, resource]) => resource.links && Object.keys(resource.links).length > 0)
      .map(([name]) => resources.connectionFor(name)),
  );
  for (const owner of owners) {
    const source = commandsOf(resources.forConnection(owner) as never) as {
      commandTransaction?: <T>(run: (records: unknown, journal: CommandJournal) => Promise<T>) => Promise<T>;
    };
    if (typeof source.commandTransaction !== 'function') continue;
    const journal = <T>(run: (journal: JournalLinks) => Promise<T>) => source.commandTransaction!((_records, held) => run(held));
    const row = await journal((held) => held.readLink?.(app.id, id, now) ?? Promise.resolve(undefined));
    if (row && row.app === app.id && row.tenant === '') return { row, journal };
  }
  return undefined;
}

/** A link's URL by id, while it still opens and the App's address is known; undefined otherwise. */
export async function renderedLink(app: AppDef, resources: RuntimeResources, id: string, now = Date.now()): Promise<string | undefined> {
  const found = await lookUpLink(app, resources, id, now);
  return found ? linkUrl(app.id, found.row) : undefined;
}

/** `value` with each link reference it holds rendered as its URL; as it was where one does not render. */
export async function withLinkUrls<T>(app: AppDef, resources: RuntimeResources, value: T): Promise<T> {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') return value;
  const rendered = await renderLinkRefs(text, (id) => renderedLink(app, resources, id));
  return rendered === undefined || rendered === text ? value : (JSON.parse(rendered) as T);
}
