/**
 * Hand dates and timestamps back as the text the server stores.
 *
 * `pg` parses `timestamp without time zone` into a JavaScript `Date`, which
 * has no such thing as "without time zone" — so it reads the value in the
 * *process's* offset and prints it back in UTC. A row written 09:00 came out
 * of this adapter as `2026-08-01T13:00:00.000Z`: not a formatting difference,
 * a different time, on a value the column explicitly says has no zone. The
 * MySQL adapter avoids the whole question with `dateStrings: true`; `pg` has
 * no such option, so the parsers are replaced instead.
 *
 * `timestamptz` is included even though it is a real instant. Its text form
 * carries the offset, which is more information than a `Date` rendered in
 * whatever zone the browser happens to be in — and tablewalk's job is to show
 * what is stored.
 *
 * Set on the module, because that is the only place `pg` keeps them. Done
 * once, and idempotent, so opening a second connection does not repeat it.
 */
const PG_DATE_OIDS = [
  1082, // date
  1083, // time
  1114, // timestamp without time zone
  1184, // timestamp with time zone
  1266, // time with time zone
];
let datesKept = false;

export function keepDatesAsText(pg: unknown): void {
  if (datesKept) return;
  const mod = pg as {
    types?: { setTypeParser(oid: number, parse: (value: string) => string): void };
    default?: { types?: { setTypeParser(oid: number, parse: (value: string) => string): void } };
  };
  const types = mod.types ?? mod.default?.types;
  /* A `pg` that does not expose `types` is one this cannot fix, and a
     connection is worth more than a formatting guarantee. */
  if (!types?.setTypeParser) return;
  for (const oid of PG_DATE_OIDS) types.setTypeParser(oid, (value) => value);
  datesKept = true;
}
