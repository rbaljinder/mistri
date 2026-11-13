/**
 * `/api/record-links`: how many capability links of one record still open, and `/api/record-links/revoke`, which
 * revokes them all from the record's page. An App without tenants only (tenant/tenantHttpRoutes.ts serves a tenant
 * App's). Revoking is a write to the record: the reader must be able to write its resource and see the row, and the
 * revoke is noted in the record's history, where it keeps one, as the person who did it.
 */
import { isRowPolicyApp, isTenantApp, appAllowsWrite } from '../../shared/app.js';
import { appForConnection, appWriteWording } from '../app/apps.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { exactKey } from '../recordHistory.js';
import { commandsOf } from '../stores/commandStores.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { commandKeyText } from '@mistriwork/engine/shared/commandWire.js';
import { writeRefusal } from '@mistriwork/engine/server/http/writeRefusal.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';

export const RECORD_LINKS_PATH = '/api/record-links';
export const RECORD_LINKS_REVOKE_PATH = '/api/record-links/revoke';

/** The history entry a revoke leaves: what was done, said as the record's other actions are. */
export const revokedLinksAction = (count: number): string => (count === 1 ? 'Revoked 1 link' : `Revoked ${count} links`);

type LinkSource = {
  commandTransaction?: <T>(run: (records: WriteTransaction, journal: CommandJournal) => Promise<T>) => Promise<T>;
};

export async function recordLinkRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, appHosts } = post;
  if (path !== RECORD_LINKS_PATH && path !== RECORD_LINKS_REVOKE_PATH) return false;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  const app = host?.app.app;
  if (!app || isTenantApp(app)) {
    send(res, 404, { error: "A record's links belong to an App's record pages." });
    return true;
  }
  if (typeof body.table !== 'string') throw new AppAccessDenied();
  const table = body.table;
  const resource = Object.hasOwn(app.resources ?? {}, table) ? app.resources![table] : undefined;
  /* A row-policy App decides each write by its policy, which nothing here can ask about a revoke: there the links of
     a record end as its commands end them. */
  if (!resource?.links || !Object.keys(resource.links).length || isRowPolicyApp(app)) throw new AppAccessDenied();
  // The write gate a record's own save passes, and then the App's grant where it grants by no role table. A role that
  // only appends to the table never edits a row of it, so it cannot end the row's links either.
  const refused = writeRefusal(registry, appWriteWording(appHosts), connection, table, post.resources, post.access);
  if (refused || post.access?.appendOnly?.has(table) || (!post.access && !appAllowsWrite(app, schema, table, post.role))) {
    send(res, 403, { error: refused ?? 'Access to this resource is denied.', code: 'forbidden' });
    return true;
  }
  const key = exactKey(schema, table, body.key);
  // The same read that opens the record's page: a record this reader cannot see has no links for them.
  const visible = await adapter.query({
    table,
    columns: Object.keys(key),
    limit: 1,
    offset: 0,
    filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
  if (visible.rows.length !== 1) throw new AppAccessDenied();

  /* The journal is the App's own, opened as a command's is: the request's resources are the reader's view of the
     rows, which writes through no journal. The row was read through that view above. */
  const releases: Array<() => void> = [];
  res.once('close', () => {
    for (const release of releases.splice(0).reverse()) release();
  });
  const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
  const source = commandsOf(resources.forConnection(resources.connectionFor(table)) as never) as LinkSource;
  if (typeof source.commandTransaction !== 'function') throw new AppAccessDenied();
  const rowKey = commandKeyText(key);
  const now = clockNow().getTime();
  if (path === RECORD_LINKS_PATH) {
    const live = await source.commandTransaction(
      (_records, journal) => journal.countLinks?.(app.id, table, rowKey, now) ?? Promise.resolve(0),
    );
    send(res, 200, { live });
    return true;
  }
  /* What the revoke itself returns is what was live, counted in the same transaction as the update, so a link opened
     between a separate count and the revoke is neither missed nor reported wrongly; a revoke of none notes nothing. */
  const revoked = await source.commandTransaction(async (records, journal) => {
    if (typeof journal.revokeLinks !== 'function') throw new AppAccessDenied();
    const ended = await journal.revokeLinks(app.id, table, rowKey, undefined, now);
    // Who did it is the request's, read when the transaction opened; what was done is said here.
    if (ended) await records.noted?.({ table, key, action: revokedLinksAction(ended) });
    return ended;
  });
  send(res, 200, { revoked });
  return true;
}
