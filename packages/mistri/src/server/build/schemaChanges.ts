/**
 * What a regeneration of `mistri-schema.d.ts` took away, said as the author meets it: the columns the old file had and
 * the new one lacks. That is the moment a migration breaks an App, and the typecheck that follows says it per use; this
 * says it once per column, with the guess that matters most: one column gone and one of the same type arrived on the
 * same table is probably a rename.
 *
 * Read from the file's `Rows` block (a column and its type), so a guess has the type to go on; a file from before
 * `Rows` is read from `Tables`, which has names alone, and then a rename is not guessed.
 */

/** A table's columns as the generated file lists them, each with its type ('' where the file does not say). */
function columnsOf(text: string): Map<string, Map<string, string>> {
  const block = (name: string) => new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\};`).exec(text)?.[1] ?? '';
  const tables = new Map<string, Map<string, string>>();
  for (const line of block('Rows').split('\n')) {
    const match = /^\s+("?[^:"]+"?): \{ (.*) \};$/.exec(line);
    if (!match) continue;
    const columns = new Map<string, string>();
    for (const part of match[2].split('; ')) {
      const at = part.indexOf(': ');
      if (at > 0) columns.set(part.slice(0, at).replace(/^"|"$/g, '').replace(/\?$/, ''), part.slice(at + 2));
    }
    tables.set(match[1].replace(/"/g, ''), columns);
  }
  if (tables.size) return tables;
  for (const line of block('Tables').split('\n')) {
    const match = /^\s+("?[^:"]+"?): (.*);$/.exec(line);
    if (match)
      tables.set(
        match[1].replace(/"/g, ''),
        new Map([...match[2].matchAll(/"([^"]+)"/g)].map((each) => [each[1], ''] as [string, string])),
      );
  }
  return tables;
}

/** One line for each removed table or column, and for a guessed rename in place of its two halves. */
export function schemaChanges(before: string, after: string): string[] {
  const was = columnsOf(before);
  const now = columnsOf(after);
  const said: string[] = [];
  for (const [table, columns] of was) {
    const kept = now.get(table);
    if (!kept) {
      said.push(`removed table ${table}`);
      continue;
    }
    const gone = [...columns].filter(([name]) => !kept.has(name));
    const arrived = [...kept].filter(([name]) => !columns.has(name));
    const typed = gone.length === 1 && arrived.length === 1 && gone[0][1] !== '' && gone[0][1] === arrived[0][1];
    if (typed)
      said.push(
        `possibly renamed ${table}.${gone[0][0]} → ${table}.${arrived[0][0]} (a guess: one column gone and one of the same type arrived)`,
      );
    else for (const [name] of gone) said.push(`removed ${table}.${name}`);
  }
  return said;
}
