/**
 * The rows an @ may name — the half of RichTextField.tsx that a first page does
 * not need (a public form never offers mentions), loaded with the first @.
 */
import { api, findTable, refsFrom } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { MENTION_HANDLE } from '@mistriwork/engine/shared/richText.js';
import { mentionLabelText, mentionQuery, type MentionSource as MentionResource } from '@mistriwork/engine/shared/mentionLookup.js';
import { quoteValue } from '@mistriwork/engine/shared/query.js';
import type { MentionPerson } from './RichTextEditor.js';

/* A team's link rows (`through: 'team_member'`): its reference to the teams, and the team column it points at. */
function linkToTeams(source: MentionResource & { through?: string }): { column: string; team: string } | undefined {
  if (!source.through) return undefined;
  const teams = findTable(source.from) as { id?: string } | undefined;
  const links = (refsFrom(source.through) ?? []) as Array<{ from: { columns: string[] }; to: { table: string; columns: string[] } }>;
  const link = links.find((fk) => fk.to.table === teams?.id && fk.from.columns.length === 1);
  return link && { column: link.from.columns[0], team: link.to.columns[0] };
}

/* Of the teams found, those a link row names: a team with no member has nobody a mention would tell.
   Read as the reader may read the link rows; where they cannot, no team is offered rather than every one. */
async function withMembers(
  source: MentionResource & { through?: string },
  rows: Array<Record<string, unknown>>,
  connection: string | null | undefined,
): Promise<Array<Record<string, unknown>>> {
  const link = linkToTeams(source);
  if (!link) return rows;
  const keys = [...new Set(rows.map((row) => row[link.team]).filter((key) => typeof key === 'string' || typeof key === 'number'))];
  if (!keys.length) return [];
  const q = `${source.through} ${link.column} in (${keys.map(quoteValue).join(', ')}) show ${link.column}`;
  const data = (await api('/api/run', { ...ownedBy(connection ?? null), q, limit: 500, offset: 0, count: 'none' })) as {
    rows?: Array<Record<string, unknown>>;
  };
  const named = new Set((data.rows ?? []).map((row) => String(row[link.column])));
  return rows.filter((row) => named.has(String(row[link.team])));
}

/* One resource's rows an @ may name, by what was typed: read as the reader may read it. The query and the name a
   row is said by are shared/mentionLookup.ts's, so a label template ('{first_name} {last_name}') reads the same
   here as where the server checks it. */
export async function mentionRows(
  source: MentionResource & { through?: string },
  typed: string,
  connection: string | null | undefined,
  kind?: 'group',
): Promise<MentionPerson[]> {
  const table = findTable(source.from) as { columns?: Array<{ name: string; type?: string }> } | undefined;
  const link = kind === 'group' ? linkToTeams(source) : undefined;
  const q = mentionQuery(source, typed, table?.columns, link ? [link.team] : []);
  /* Teams narrowed by their members are read a few more, so eight can still be offered once the empty ones go. */
  const data = (await api('/api/run', { ...ownedBy(connection ?? null), q, limit: link ? 24 : 8, offset: 0, count: 'none' })) as {
    rows?: Array<Record<string, unknown>>;
  };
  const rows = link ? (await withMembers(source, data.rows ?? [], connection)).slice(0, 8) : (data.rows ?? []);
  return rows.flatMap((row) => {
    const id = row[source.by];
    const handle =
      typeof id === 'string' && MENTION_HANDLE.test(id) ? id : typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : undefined;
    if (handle === undefined) return [];
    const label = mentionLabelText(source, row) || handle;
    return [{ id: handle, label, ...(kind || !readable(source, handle, label) ? {} : { handle }), ...(kind ? { kind } : {}) }];
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* Whether the stored handle is one a person would say after the @ ("@morgan"), shown beside the name to tell two
   Morgans apart. A key the database handed out — the people's primary key, a number, a UUID — is not: the list
   said "Morgan Hughes @3f2a…". The name is what the mention reads either way. */
function readable(source: { from: string; by: string }, handle: string, label: string): boolean {
  const people = findTable(source.from) as { columns?: Array<{ name: string; primaryKey?: boolean }> } | undefined;
  if (people?.columns?.some((column) => column.name === source.by && column.primaryKey)) return false;
  /* Nor is an email: the list would say "Vic Ramos @vramos@example.test"; the label's words tell people apart. */
  return handle !== label && !/^\d+$/.test(handle) && !UUID.test(handle) && !handle.includes('@');
}
