/**
 * The reference shelf: what a client can put in front of a model without a
 * tool call. The schema brief per connection, one table in full through a
 * template, the team's named queries and pages, argument completion for
 * them, and the Markdown each is rendered as. The App reference (`tablewalk
 * docs`) is the App framework's, and an agent building an App reads it through
 * `tablewalk observe --mcp` (observe/mcp.ts): this server serves no App.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { queriesFor, type SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { findTable, referencesFrom, referencesTo, renderDDL, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
// Pure like shape.js, and split out for exactly this reason: the same brief
// the browser downloads and the CLI prints, offered as ambient context.
import { toMarkdown } from '@mistriwork/engine/shared/schematext.js';
import { openFor } from './toolkit.js';
import type { Answer } from './protocol.js';

/**
 * The team's own work, as things an agent can read.
 *
 * A tablewalk.json carries named statements and page definitions, and a
 * layouts file carries the pages someone built in the browser. Those are the
 * questions a team has decided are worth asking — "customers over their
 * limit", "everything about one work order" — written down by the people who
 * know the schema. An agent that cannot see them re-derives them badly, and
 * an agent that can see them starts where the team already got to.
 *
 * Resources rather than tools: they are documents, they do not change when
 * read, and a client can put them in front of a model without spending a
 * call. The SQL is *not* run here — reading the shelf is not executing what
 * is on it, and `sql` exists for that with its own read-only guarantee.
 */
export interface Shelf {
  queries: SavedQuery[];
  pages: PageDef[];
  /** Pages saved from the browser, read per connection when asked. */
  savedPages?: (connection: string) => Promise<Record<string, unknown>>;
}

function queriesBrief(shelf: Shelf, connection: string, name: string): string {
  const mine = queriesFor(shelf.queries, connection, name);
  if (!mine.length) return `# Named queries — ${name}\n\nNone written down for this connection.`;
  const lines = [
    `# Named queries — ${name}`,
    '',
    `${mine.length} statement${mine.length === 1 ? '' : 's'} from your config. Run one with the \`sql\` tool.`,
    '',
  ];
  for (const query of mine) {
    lines.push(`## ${query.name}`, '');
    if (query.description) lines.push(query.description, '');
    lines.push('```sql', query.sql.trim(), '```', '');
  }
  return lines.join('\n').trim();
}

function pagesBrief(pages: PageDef[], saved: Record<string, unknown>, name: string): string {
  const all = [
    ...pages.map((p) => ({ id: p.id, name: p.name, base: p.base, sections: p.sections?.length ?? 0, from: 'config' })),
    ...Object.entries(saved).map(([id, page]) => {
      const def = page as { name?: string; base?: string; sections?: unknown[] };
      return { id, name: def.name ?? id, base: def.base ?? '?', sections: def.sections?.length ?? 0, from: 'browser' };
    }),
  ];
  if (!all.length) return `# Pages — ${name}\n\nNone defined for this connection.`;
  const lines = [
    `# Pages — ${name}`,
    '',
    'A page is one record with everything around it — counts, lists and related rows — ' +
      'assembled by whoever knows this schema. The root table is where a page starts.',
    '',
    '| page | root table | sections | from |',
    '| --- | --- | --- | --- |',
  ];
  for (const page of all) lines.push(`| ${page.name} | ${page.base} | ${page.sections} | ${page.from} |`);
  return lines.join('\n');
}

/**
 * One table as Markdown: the DDL, then the part no DDL states — what points
 * here. The same facts the `table` tool answers, shaped for attachment
 * rather than for parsing.
 */
export function tableBrief(schema: DatabaseSchema, table: ReturnType<typeof findTable> & object): string {
  const lines = [`## ${table.id}`, '', '```sql', renderDDL(schema, table.id).trim(), '```', ''];
  /* The DDL above is a reconstruction and drops checks, so a vocabulary read
     out of one would vanish here if it were not said again. */
  const vocab = table.columns.filter((c) => c.allowed?.length);
  if (vocab.length) {
    lines.push('Allowed values:', ...vocab.map((c) => `- ${c.name}: ${c.allowed!.map((v) => `\`${v}\``).join(', ')}`), '');
  }
  const out = referencesFrom(schema, table.id);
  if (out.length) {
    lines.push('Points at:', ...out.map((fk) => `- ${fk.from.columns.join(', ')} → ${fk.to.table}`), '');
  }
  const back = referencesTo(schema, table.id);
  if (back.length) {
    lines.push(
      'Pointed at by:',
      ...back.map((fk) => `- ${fk.from.table} via ${fk.from.columns.join(', ')}${fk.onDelete ? ` (on delete ${fk.onDelete})` : ''}`),
      '',
    );
  }
  if (!out.length && !back.length) lines.push('No foreign keys in either direction.', '');
  return lines.join('\n');
}

/* Resources are the reference shelf: things a client can attach to a
   conversation without spending a tool call, @-mentionable where the
   client supports it. The schema brief per connection is concrete;
   tables come as a template, because listing sixty-six of them per
   connection would drown the one resource everyone wants. */
export function listResources(registry: Registry, shelf: Shelf, answer: Answer): void {
  return answer({
    result: {
      resources: registry.list().flatMap((c) => [
        {
          uri: `tablewalk://${encodeURIComponent(c.id)}/schema`,
          name: `${c.name} — schema brief`,
          description: 'Every table with its columns and keys, and the foreign-key graph in both directions, as Markdown.',
          mimeType: 'text/markdown',
        },
        /* Listed only where there is something on the shelf: an empty
           document offered per connection is three lines of nothing in
           every client's resource picker. */
        ...(queriesFor(shelf.queries, c.id, c.name).length
          ? [
              {
                uri: `tablewalk://${encodeURIComponent(c.id)}/queries`,
                name: `${c.name} — named queries`,
                description: 'The statements this team wrote down, with their descriptions. Not run by reading them.',
                mimeType: 'text/markdown',
              },
            ]
          : []),
        ...(shelf.pages.some((p) => !p.connection || p.connection === c.id || p.connection === c.name)
          ? [
              {
                uri: `tablewalk://${encodeURIComponent(c.id)}/pages`,
                name: `${c.name} — pages`,
                description: 'Record pages defined for this connection: the root table each starts from, and how much is on it.',
                mimeType: 'text/markdown',
              },
            ]
          : []),
      ]),
    },
  });
}

export function listResourceTemplates(answer: Answer): void {
  return answer({
    result: {
      resourceTemplates: [
        {
          uriTemplate: 'tablewalk://{connection}/table/{table}',
          name: 'One table in full',
          description: 'DDL plus foreign keys in both directions, as Markdown. {connection} is a connection id, {table} a table id.',
          mimeType: 'text/markdown',
        },
      ],
    },
  });
}

/* Argument completion for the resource template: the same
   errors-teach spirit, moved before the mistake — a client that asks
   here never mistypes a table id at all. */
export async function completeArgument(registry: Registry, params: Record<string, unknown>, answer: Answer): Promise<void> {
  const { ref, argument, context } = params as {
    ref?: { type?: string; uri?: string };
    argument?: { name?: string; value?: string };
    context?: { arguments?: Record<string, string> };
  };
  const prefix = String(argument?.value ?? '').toLowerCase();
  let values: string[] = [];
  if (ref?.type === 'ref/resource' || ref?.type === 'ref/prompt') {
    if (argument?.name === 'connection') {
      values = registry.list().map((c) => c.id);
    } else if (argument?.name === 'table' || argument?.name === 'tables') {
      const conn = context?.arguments?.connection ?? registry.active ?? '';
      try {
        const { schema } = await openFor(registry, conn);
        values = schema.tables.map((t) => t.id);
      } catch {
        /* An unknown connection completes to nothing, not to an error —
           half-typed context is the normal state of a completion. */
      }
    }
  }
  const matched = values.filter((v) => v.toLowerCase().startsWith(prefix));
  return answer({
    result: {
      completion: {
        values: matched.slice(0, 100),
        total: matched.length,
        hasMore: matched.length > 100,
      },
    },
  });
}

export async function readResource(registry: Registry, shelf: Shelf, params: Record<string, unknown>, answer: Answer): Promise<void> {
  const uri = String((params as { uri?: string }).uri ?? '');
  const match = /^tablewalk:\/\/([^/]+)\/(schema|queries|pages|table\/(.+))$/.exec(uri);
  if (!match) {
    return answer({ error: { code: -32002, message: `No resource at "${uri}".` } });
  }
  try {
    const connId = decodeURIComponent(match[1]);
    const named = registry.list().find((c) => c.id === connId);
    if (match[2] === 'queries' || match[2] === 'pages') {
      /* The shelf is config and files, not the database — answered
         without opening a connection, so a resource about a database
         that is down still reads. */
      const label = named?.name ?? connId;
      const text =
        match[2] === 'queries'
          ? queriesBrief(shelf, connId, label)
          : pagesBrief(
              shelf.pages.filter((p) => !p.connection || p.connection === connId || p.connection === label),
              (await shelf.savedPages?.(connId)) ?? {},
              label,
            );
      return answer({
        result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
      });
    }
    const { schema } = await openFor(registry, connId);
    if (match[2] === 'schema') {
      return answer({
        result: { contents: [{ uri, mimeType: 'text/markdown', text: toMarkdown(schema) as string }] },
      });
    }
    const table = tableNamed(schema, decodeURIComponent(match[3]));
    if (!table) {
      return answer({ error: { code: -32002, message: `No table "${decodeURIComponent(match[3])}" behind "${uri}".` } });
    }
    return answer({
      result: { contents: [{ uri, mimeType: 'text/markdown', text: tableBrief(schema, table) }] },
    });
  } catch (err) {
    return answer({ error: { code: -32002, message: (err as Error).message } });
  }
}
