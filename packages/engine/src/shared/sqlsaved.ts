/**
 * Saved SQL statements, as a config file section.
 *
 * The same idea as the `views` section beside it, for the same reason: a
 * statement you retype every morning is a statement that should have a name,
 * and a *team's* statements belong in a file they can commit rather than in
 * one person's browser. `tablewalk.json` is already the place a repository says
 * "these are the databases this project talks to"; this lets it also say "and
 * these are the questions people ask of them".
 *
 * The stored form is the text, never anything compiled. It stays readable in
 * the editor, it survives the schema changing underneath it — at worst as a
 * visible error you can fix rather than a silently wrong answer — and it can be
 * reviewed in a pull request by someone who knows SQL and nothing about
 * tablewalk.
 */

export interface SavedQuery {
  name: string;
  sql: string;
  /** Optional prose, for a statement whose purpose is not obvious from it. */
  description?: string;
  /**
   * Connection id or name this belongs to. Absent means every connection —
   * which is right for a statement about a schema several databases share, and
   * wrong for one about a table only production has, so it is worth setting.
   */
  connection?: string;
  /** Where it came from, so the interface can say what it can be edited. */
  source?: 'config' | 'saved';
}

/**
 * Read the `queries` section of a config file.
 *
 * Errors name the file, the position *and* the statement's name where there is
 * one, because a config file is something a person wrote by hand and "queries
 * is not an array" sends them to search a file they may not have written.
 *
 * A duplicate name is refused rather than resolved. Two statements called
 * "Daily totals" that do different things is a worse outcome than a startup
 * error, and silently keeping the last one is the worst of the three.
 */
export function parseQueriesConfig(raw: unknown, where: string): SavedQuery[] {
  const queries = (raw as { queries?: unknown })?.queries;
  if (queries === undefined) return [];
  if (!Array.isArray(queries)) throw new Error(`${where}: "queries" must be an array.`);

  const seen = new Set<string>();
  return queries.map((entry, i) => {
    const at = `${where}: query ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} is not an object.`);
    }
    const q = entry as Record<string, unknown>;

    if (typeof q.name !== 'string' || !q.name.trim()) throw new Error(`${at} has no "name".`);
    const name = q.name.trim();
    if (seen.has(name)) {
      throw new Error(`${where}: two queries are called "${name}". Names have to be distinct.`);
    }
    seen.add(name);

    if (typeof q.sql !== 'string' || !q.sql.trim()) {
      throw new Error(`${at} ("${name}") has no "sql".`);
    }

    return {
      name,
      sql: q.sql.trim(),
      description: typeof q.description === 'string' && q.description.trim() ? q.description.trim() : undefined,
      connection: typeof q.connection === 'string' && q.connection.trim() ? q.connection.trim() : undefined,
      source: 'config' as const,
    };
  });
}

/** The saved statements that apply to one connection, by id or by name. */
export function queriesFor(all: SavedQuery[], connectionId: string, connectionName?: string): SavedQuery[] {
  return all.filter((q) => !q.connection || q.connection === connectionId || q.connection === connectionName);
}
