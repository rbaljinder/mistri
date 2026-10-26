/**
 * An App's settings records (`resources.<r>.settings`): a resource that holds
 * one row — a company profile, the payroll settings — opened from the
 * reader's settings (the account menu, or the gear where nobody signs in)
 * under the words the App gave it, rather than from a list nobody needs.
 *
 * One entry per such resource this reader's catalog holds, so a resource the
 * reader cannot read offers nothing. The row is the first by key; its page,
 * its fields and what may be edited in it are the resource's own, judged by
 * the server as every record is.
 */
import { api, findTable, openRecord, state, toast } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import type { AppPayloadApp } from '../shared/appPayload.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from './copy/shell/appSettings.js';

async function openSettings(tableId: string, label: string): Promise<void> {
  const table = findTable(tableId) as TableMeta | undefined;
  const keys = table?.columns.filter((column) => column.primaryKey).map((column) => column.name) ?? [];
  if (!table || !keys.length) return;
  try {
    const data = (await api('/api/query', {
      ...ownedBy(state.activeConnection),
      table: table.id,
      columns: keys,
      orderBy: keys.map((column) => ({ column, direction: 'asc' })),
      limit: 1,
      offset: 0,
    })) as { rows?: Array<Record<string, unknown>> };
    const row = data.rows?.[0];
    if (!row) {
      toast(say('thereIsNoYet', { label: label.toLowerCase() }), 'info');
      return;
    }
    await openRecord(table.id, Object.fromEntries(keys.map((column) => [column, row[column]])), label);
  } catch (error) {
    toast(error instanceof Error ? error.message : say('couldNotBeOpened', { label }), 'error');
  }
}

/** The menu entries for an App's settings records, in the App's order. */
export function settingsEntries(app: AppPayloadApp | null) {
  if (!app) return [];
  return Object.entries(app.resources ?? {}).flatMap(([tableId, resource]) =>
    resource.settings && findTable(tableId)
      ? [
          {
            label: resource.settings,
            category: say('common.settings'),
            scope: 'app' as const,
            onSelect: () => void openSettings(tableId, resource.settings!),
          },
        ]
      : [],
  );
}
