/**
 * The packaged walks: orient, check before a migration, investigate a row.
 * Each returns instructions plus the briefs they lean on, embedded, so the
 * plan arrives with its reading rather than as calls the plan asks for.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { toMarkdown } from '@mistriwork/engine/shared/schematext.js';
import { openFor } from './toolkit.js';
import { tableBrief } from './shelf.js';
import type { Answer } from './protocol.js';

/* Prompts package the tool-chaining knowledge that otherwise lives
   only in whichever agent happens to have learned it. Each returns
   instructions plus the resources they lean on, embedded — the brief
   arrives with the plan instead of being a call the plan asks for. */
export function listPrompts(answer: Answer): void {
  return answer({
    result: {
      prompts: [
        {
          name: 'orient',
          title: 'Orient in this database',
          description: 'The schema brief plus how to start: hubs, event tables, and the first calls worth making.',
          arguments: [{ name: 'connection', description: 'Connection id; defaults to the active one.', required: false }],
        },
        {
          name: 'pre-migration-check',
          title: 'Check before a migration',
          description:
            'Everything worth knowing before DDL touches these tables: both directions of their keys, delete rules, and what the columns actually hold.',
          arguments: [
            { name: 'tables', description: 'Comma-separated table ids the migration touches.', required: true },
            { name: 'connection', description: 'Connection id; defaults to the active one.', required: false },
          ],
        },
        {
          name: 'investigate-row',
          title: 'Investigate one row',
          description:
            'Walk a row properly: the record with children inlined, which relationships to follow, and when to profile a suspicious column.',
          arguments: [
            { name: 'table', description: 'Table id.', required: true },
            { name: 'key', description: 'The primary key as JSON, e.g. {"id": 42}.', required: true },
            { name: 'connection', description: 'Connection id; defaults to the active one.', required: false },
          ],
        },
      ],
    },
  });
}

export async function getPrompt(registry: Registry, params: Record<string, unknown>, answer: Answer): Promise<void> {
  const { name: promptName, arguments: promptArgs = {} } = params as { name?: string; arguments?: Record<string, string> };
  try {
    const conn = promptArgs.connection;
    const { schema, id: connId } = await openFor(registry, conn);
    const brief = (uri: string, text: string) => ({
      role: 'user',
      content: { type: 'resource', resource: { uri, mimeType: 'text/markdown', text } },
    });
    if (promptName === 'orient') {
      return answer({
        result: {
          description: `Orientation in ${schema.label}`,
          messages: [
            brief(`tablewalk://${encodeURIComponent(connId)}/schema`, toMarkdown(schema) as string),
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  'Read the attached schema brief before calling anything. Then call schema_summary ' +
                  'for the hubs and the deepest walk, and open your first table with `table` rather ' +
                  'than guessing columns. Prefer `query` with `show` over `sql`; use `find` when you ' +
                  'only know a name; call `refresh` after any DDL.',
              },
            },
          ],
        },
      });
    }
    if (promptName === 'pre-migration-check') {
      const wanted = String(promptArgs.tables ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (!wanted.length) {
        return answer({ error: { code: -32602, message: 'Which tables? Pass `tables` as a comma-separated list.' } });
      }
      const attached = wanted
        .map((t) => tableNamed(schema, t))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .map((t) => brief(`tablewalk://${encodeURIComponent(connId)}/table/${encodeURIComponent(t.id)}`, tableBrief(schema, t)));
      return answer({
        result: {
          description: `Pre-migration check: ${wanted.join(', ')}`,
          messages: [
            ...attached,
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `Before writing DDL for ${wanted.join(', ')}: the attached briefs carry both ` +
                  'directions of each table\u2019s keys and every ON DELETE rule — anything pointing at ' +
                  'a table you are changing is a migration constraint. For each column the migration ' +
                  'actually touches, call `change_impact {table, column}`: it answers the questions ' +
                  'that decide whether the DDL takes at all — how many rows hold null (so whether NOT ' +
                  'NULL would be refused), what points at it under which delete rule, whether those ' +
                  'referencing columns are NOT NULL, and whether an index leads on them. Those facts ' +
                  'are in the database and nowhere in the repository, so they cannot be read off the ' +
                  'code. Call `profile` on each table for the wider column shape (ranges and common ' +
                  'values decide whether a narrower type can land), and `tables` for row counts that ' +
                  `decide whether the migration needs batching. \`order {tables: ${JSON.stringify(wanted)}}\` gives the ` +
                  'order rows have to arrive and leave in, which is the order the DDL has to respect ' +
                  'too, and names any cycle between them. `lint` on the same tables says what the ' +
                  'shape already costs — an unindexed foreign key is a migration that scans, and a ' +
                  'reference with no ON DELETE rule is a decision this migration could make instead of ' +
                  'postponing again. If another connection already has the intended shape, `diff` says ' +
                  'exactly what is missing. After the DDL runs, call `refresh` before anything else.',
              },
            },
          ],
        },
      });
    }
    if (promptName === 'investigate-row') {
      const table = String(promptArgs.table ?? '');
      const key = String(promptArgs.key ?? '');
      return answer({
        result: {
          description: `Investigate ${table} ${key}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `Investigate ${table} ${key} on connection ${connId}. Start with ` +
                  `\`record {table: "${table}", key: ${key || '{...}'}, expand: 5}\` — the row, its human ` +
                  'name, and the first rows of everything pointing at it. Follow the relationships whose ' +
                  'counts look wrong for the story the row tells; each carries a ready-to-run `query`. ' +
                  'When a column\u2019s value looks suspicious, `profile` its table to see whether the value ' +
                  'is an outlier or the norm. When a value on the row appears somewhere you cannot ' +
                  'account for — an id, a reference, a string out of a log — `find {value: "…"}` says ' +
                  'which other tables mention it. Every answer carries a `link` — cite it, so a human ' +
                  'can open exactly what you saw.',
              },
            },
          ],
        },
      });
    }
    return answer({ error: { code: -32602, message: `No prompt called "${String(promptName)}".` } });
  } catch (err) {
    return answer({ error: { code: -32602, message: (err as Error).message } });
  }
}
