/**
 * What is in this database, answered from the catalog alone.
 *
 * The first minute with an unfamiliar schema is spent on questions the
 * structure already answers: where does this thing centre, what are the tables
 * I will actually query, how deep does it go, and what is that lump over there
 * connected to nothing. The diagram shows all of it at once, which is a
 * different thing from saying it — a picture of sixty-six tables answers "what
 * is in here" only for someone who already knows.
 *
 * This is the non-model version of the feature the backlog files under LLM
 * assistance, and it is the honest first version: everything below is derived
 * from foreign keys that were introspected on connect, so it costs no network,
 * no key, and cannot be wrong about a table it hallucinated.
 *
 * Pure on purpose — no DOM, no state, no imports. It takes a schema and returns
 * a description, which is what makes it testable without a browser.
 */

/** A table has to be pointed at by this many others before it is a hub. */
const HUB_MINIMUM = 2;

/** How much of a table has to be foreign keys before it is a join table. */
const JOIN_RATIO = 0.6;

/**
 * Describe a schema's shape.
 *
 * @param {{tables: Array, foreignKeys: Array}} schema
 * @returns {{
 *   counts: {tables: number, views: number, keys: number},
 *   hubs: Array<{table: object, incoming: number, from: string[]}>,
 *   leaves: object[],
 *   joins: Array<{table: object, connects: string[]}>,
 *   chain: object[],
 *   islands: object[],
 *   start: object | null,
 * }}
 */
export function describeSchema(schema) {
  const tables = schema?.tables ?? [];
  const keys = (schema?.foreignKeys ?? []).filter((fk) => fk.from.table !== fk.to.table);
  const byId = new Map(tables.map((t) => [t.id, t]));

  /* Counted as *distinct tables*, not constraints. `work_order` pointing at
     `employee` three times — raised_by, assigned_to, approved_by — says one
     thing about the shape, not three, and counting constraints would rank a
     table by how many roles one neighbour plays in it. */
  const incoming = new Map(tables.map((t) => [t.id, new Set()]));
  const outgoing = new Map(tables.map((t) => [t.id, new Set()]));
  for (const fk of keys) {
    incoming.get(fk.to.table)?.add(fk.from.table);
    outgoing.get(fk.from.table)?.add(fk.to.table);
  }

  const inCount = (t) => incoming.get(t.id)?.size ?? 0;
  const outCount = (t) => outgoing.get(t.id)?.size ?? 0;

  const real = tables.filter((t) => !t.isView);

  const hubs = real
    .filter((t) => inCount(t) >= HUB_MINIMUM)
    .sort((a, b) => inCount(b) - inCount(a) || a.name.localeCompare(b.name))
    .slice(0, 4)
    .map((table) => ({
      table,
      incoming: inCount(table),
      from: [...(incoming.get(table.id) ?? [])].map((id) => byId.get(id)?.name ?? id).sort(),
    }));

  /* Leaves point outwards and are pointed at by nothing, which is what a
     transaction or an event table looks like: the thing that happened, hanging
     off the things it happened to. They are usually what someone actually
     wants to query, and they are the least visible in a diagram because they
     sit at the edges. */
  const leaves = real
    .filter((t) => outCount(t) > 0 && inCount(t) === 0)
    .sort((a, b) => outCount(b) - outCount(a) || a.name.localeCompare(b.name));

  /* A join table is mostly foreign keys, points at two or more things, and —
     the part that separates it from a lookup table — is pointed at by almost
     nothing itself. A join table *connects* things; things do not connect to
     it.
  
     Without that last clause `country` qualifies: three of its five columns are
     references, to currency, language and region. But half the schema points at
     `country`, which makes it a dimension everyone shares rather than a bridge
     between two tables, and calling it a join table would mislead about the
     one thing this list exists to say. */
  const joins = real
    .filter((t) => {
      const fkColumns = t.columns.filter((c) => c.references).length;
      return outCount(t) >= 2 && inCount(t) <= 1 && t.columns.length > 0 && fkColumns / t.columns.length >= JOIN_RATIO;
    })
    .map((table) => ({
      table,
      connects: [...(outgoing.get(table.id) ?? [])].map((id) => byId.get(id)?.name ?? id).sort(),
    }));

  return {
    counts: {
      tables: real.length,
      views: tables.length - real.length,
      keys: schema?.foreignKeys?.length ?? 0,
    },
    hubs,
    leaves,
    joins,
    chain: longestChain(tables, outgoing)
      .map((id) => byId.get(id))
      .filter(Boolean),
    islands: real.filter((t) => inCount(t) === 0 && outCount(t) === 0),
    start: suggestStart(real, inCount, outCount),
  };
}

/**
 * The longest path of references, as the tables along it.
 *
 * The diagram computes the same *depth* to lay itself out, but a number is not
 * the interesting part — "five levels deep" says less than "region → country →
 * address → site → building → room", which is the shape of the domain written
 * out. Recomputed here rather than shared because the diagram throws the path
 * away and keeps only the count.
 *
 * A cycle is broken at the first table already on the path. A circular schema
 * has no longest chain, and the alternative to stopping is not stopping.
 */
function longestChain(tables, outgoing) {
  const best = new Map();

  const walk = (id, seen) => {
    if (seen.has(id)) return [];
    if (best.has(id)) return best.get(id);

    seen.add(id);
    let longest = [];
    for (const next of outgoing.get(id) ?? []) {
      const path = walk(next, seen);
      if (path.length > longest.length) longest = path;
    }
    seen.delete(id);

    const result = [id, ...longest];
    /* Only memoised when the walk was not truncated by the cycle guard — a
       path cut short by `seen` is an answer about this route, not about this
       table, and caching it would poison every later route through it. */
    if (!longest.some((t) => seen.has(t))) best.set(id, result);
    return result;
  };

  let chain = [];
  for (const t of tables) {
    const path = walk(t.id, new Set());
    if (path.length > chain.length) chain = path;
  }
  return chain.length > 1 ? chain : [];
}

/**
 * Where to start reading.
 *
 * The table that connects to the most, with a readable name to recognise rows
 * by. Both halves matter: a join table is highly connected and tells you
 * nothing on its own, and a lookup table is readable and leads nowhere.
 */
function suggestStart(tables, inCount, outCount) {
  const scored = tables
    .filter((t) => t.columns.some((c) => !c.primaryKey && !c.references))
    .map((t) => ({
      table: t,
      // Outgoing weighted higher: a table you can walk *from* opens more of the
      // schema than one that is merely popular.
      score: outCount(t) * 2 + inCount(t),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));
  return scored[0]?.table ?? null;
}
