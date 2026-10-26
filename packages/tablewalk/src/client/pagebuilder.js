/**
 * Building a page without writing one.
 *
 * A page is a short JSON document and the format is not hard, but two things
 * about it are: knowing which relationships exist, and spelling the path that
 * reaches one. `invoice_id.customer_id` is obvious only once you already know
 * it — which is the wrong way round for the field that decides whether a
 * section shows the right rows.
 *
 * So the builder does not ask for a path. It asks the schema what points at
 * the root, directly and one table further out, and offers the answers with
 * their paths already written. Everything else is a name, a width and a
 * limit, and those are choices rather than knowledge.
 *
 * What comes out is the same `PageDef` the config file holds, saved per
 * connection on the server — and copyable as JSON, because a page worth
 * keeping is usually a page worth committing, and the format the builder
 * writes has to be the format the file reads or the two will drift.
 */
import { createElement } from 'react';
import { api, findTable, go, pageView, state, toast } from '@mistriwork/kit/client/core.js';
import { deletePage, savePage } from '@mistriwork/kit/client/savedPages.js';
import { promptFor } from '@mistriwork/kit/client/prompt.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { surfaceOf } from '@mistriwork/kit/client/surfaces.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { say } from './copy/workbench/pagebuilder.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

/* The builder's component loads the first time it opens (app.js registers it
   through surfaces.js); the saved pages above do not wait for it. So does its
   draft recovery, which checks a draft with the page parser: every record page
   imports this module for the saved pages, and the parser is most of a first
   paint's shared code (scripts/bundle-budget.mjs). */

/* ---------- the panel ---------- */

let host = null;
let generation = 0;

/** Who opened the builder, so closing hands focus back instead of to <body>. */
let opener = null;

export function closeBuilder() {
  generation += 1;
  if (host) {
    unmount(host);
    host.remove();
    host = null;
  }
  if (opener?.isConnected) opener.focus();
  opener = null;
}

subscribeSessionIdentity(() => {
  // An old editor must not restore focus into a retired private surface.
  opener = null;
  closeBuilder();
});

/**
 * The builder is `components/PageBuilder.tsx`, on a host of its own. What stays
 * here is the draft's provenance — a page that came from the config file or
 * from the schema is not this browser's to overwrite, so it is edited as a
 * new saved page — and the relations the schema offers, fetched once.
 * @param {import('@mistriwork/engine/shared/page.js').PageDef} page
 * @param {{onSaved?: (page: import('@mistriwork/engine/shared/page.js').PageDef) => void, onDeleted?: (page: import('@mistriwork/engine/shared/page.js').PageDef) => void, recoveryId?: string, recordKey?: Record<string, unknown>}} options
 */
export async function openBuilder(page, { onSaved, onDeleted, recoveryId, recordKey } = {}) {
  closeBuilder();
  const owner = sessionIdentity();
  const opened = generation;
  const connection = state.activeConnection;
  const draft = structuredClone(page);
  const derived = page.source !== 'saved';
  if (derived) {
    draft.id = `saved:${page.base}:${Date.now()}`;
    draft.name = `${page.name} (edited)`;
    draft.source = 'saved';
  }
  let relations = [];
  let references = [];
  const recovering = import('./pageDraftRecovery.js');
  try {
    const data = await api(`/api/pages/relations?table=${encodeURIComponent(page.base)}`);
    relations = data.relations ?? [];
    references = data.references ?? [];
  } catch {
    /* Without relations the builder can still reorder and rename what is there. */
  }
  const { pageDraftRecovery } = await recovering;
  if (owner !== sessionIdentity() || opened !== generation || connection !== state.activeConnection) return;
  opener = document.activeElement;
  host = document.createElement('div');
  host.className = 'host-contents';
  portalRoot().append(host);
  const current = () => owner === sessionIdentity() && opened === generation && connection === state.activeConnection;
  const requireCurrent = () => {
    if (!current()) throw new Error(say('theConnectionOrEditor'));
  };
  const recovery = pageDraftRecovery(connection, recoveryId ? { ...page, id: recoveryId } : page);
  const initial = JSON.stringify(draft);
  mount(
    host,
    createElement(surfaceOf('pageBuilder'), {
      draft,
      derived,
      original: page,
      destination: say('thisServer', { label: state.schema?.label ?? connection ?? say('defaultConnection') }),
      relations,
      references,
      previewContext: { connection, recordKey },
      recovery: recovery.recovered,
      recoverySourceChanged: recovery.sourceChanged,
      recoveryStatus: recovery.status,
      onDraftChange: (changed) =>
        current() ? (JSON.stringify(changed) === initial ? recovery.clear() : recovery.write(changed)) : 'unavailable',
      onDiscard: () => (current() ? recovery.clear() : 'unavailable'),
      onClose: () => {
        if (current()) closeBuilder();
      },
      onSave: async (saved) => {
        requireCurrent();
        await savePage(saved, connection);
        if (owner !== sessionIdentity()) return;
        recovery.clear();
        if (!current()) return;
        closeBuilder();
        toast(say('saved', { name: saved.name }), 'ok');
        onSaved?.(saved);
      },
      onDelete: async (original) => {
        requireCurrent();
        await deletePage(original.id, connection);
        if (owner !== sessionIdentity()) return;
        recovery.clear();
        if (!current()) return;
        closeBuilder();
        toast(say('deleted', { name: original.name }), 'ok');
        onDeleted?.(original);
      },
    }),
  );
}

/** Start a page from scratch for a table.
 * @param {string} tableId
 * @param {{onSaved?: (page: import('@mistriwork/engine/shared/page.js').PageDef) => void}} options
 */
export async function newPage(tableId, { onSaved } = {}) {
  const owner = sessionIdentity(),
    connection = state.activeConnection;
  const table = findTable(tableId);
  if (!table) return;
  const name = await promptFor({
    title: say('newPage'),
    label: say('common.name'),
    value: `${table.name}`,
    placeholder: say('pageNamePlaceholder'),
  });
  if (!name || owner !== sessionIdentity() || connection !== state.activeConnection) return;
  await openBuilder(
    {
      id: `saved:${table.id}:${Date.now()}`,
      name,
      base: table.id,
      sections: [{ kind: 'fields', width: 'full' }],
      source: 'saved',
    },
    { recoveryId: `new:${table.id}`, onSaved: onSaved ?? ((page) => go(pageView(page.id, page.base), 'replace')) },
  );
}
