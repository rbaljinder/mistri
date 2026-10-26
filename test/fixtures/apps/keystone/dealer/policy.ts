// Private deployment policy, loaded with --policy. Never import this module into the App.
import { defineAppRowPolicy, type PolicyDb, type RowScope } from '@mistriwork/mistri/policy';

/* Which rows a signed-in manager reads: their dealerships, and every
   dealer-owned row of those dealerships; Keystone's visits to them and the
   people at Keystone who look after them; and the rate sheet, which is the
   same for every dealer. A row policy filters on each table's own columns,
   so every dealer-owned table is scoped by its dealer_id.

   The dealerships are found from the verified session only: the person's
   active owner or sales-manager seats on dealer_user, by the exact account
   id the seat was linked to. Unlinked seats grant nothing, even when their
   email matches. A person with seats at two dealerships sees both together;
   there is no chooser here (the leads desk has one). The lookup uses the
   read-only db supplied by the App, on its own pooled connection. */

const NOTHING: RowScope = {
  dealer: false,
  dealer_site: false,
  dealer_user: false,
  vehicle: false,
  vehicle_photo: false,
  lead: false,
  dealer_visit: false,
  lender_user: false,
  program: false,
};

// Query-language literals, not SQL: quote account and row IDs just as the
// handle's tagged template does.
const quoted = (value: string | number): string =>
  typeof value === 'number' ? String(value) : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function allRows(table: PolicyDb[string], where: string, keyType: 'string' | 'number') {
  const rows: Awaited<ReturnType<typeof table.where>> = [];
  const seen = new Set<string | number>();
  let after: string | number | undefined;
  for (;;) {
    const page = await table
      .where(after === undefined ? where : `(${where}) and id > ${quoted(after)}`)
      .orderBy('id')
      .limit(1000);
    for (const row of page) {
      const id = row.id;
      if (
        (typeof id !== 'string' && typeof id !== 'number') ||
        typeof id !== keyType ||
        (typeof id === 'string' ? !id.length : !Number.isSafeInteger(id)) ||
        seen.has(id)
      ) {
        throw new Error('The policy lookup returned an invalid or repeated primary key.');
      }
      // Text ordering belongs to the database's collation, not JavaScript.
      seen.add(id);
      after = id;
    }
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function relatedRows(table: PolicyDb[string], column: 'id' | 'dealer_id', dealers: string[], keyType: 'string' | 'number') {
  const rows: Awaited<ReturnType<typeof table.where>> = [];
  // The query language allows 64 OR branches. Equality literals also keep
  // commas inside a text ID intact, unlike its comma-separated IN syntax.
  for (let start = 0; start < dealers.length; start += 64) {
    const where = dealers
      .slice(start, start + 64)
      .map((id) => `${column} = ${quoted(id)}`)
      .join(' or ');
    for (const row of await allRows(table, where, keyType)) rows.push(row);
  }
  return rows;
}

async function seatsOf(db: PolicyDb, accountId: string): Promise<{ dealers: string[]; keystone: number[] }> {
  const seats = await allRows(
    db.dealer_user,
    `status = "active" and role in ("owner", "sales_manager") and dealer_account_id = ${quoted(accountId)}`,
    'string',
  );
  const dealers = [...new Set(seats.map((row) => row.dealer_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!dealers.length) return { dealers, keystone: [] };
  const [dealerships, visits] = await Promise.all([
    relatedRows(db.dealer, 'id', dealers, 'string'),
    relatedRows(db.dealer_visit, 'dealer_id', dealers, 'number'),
  ]);
  const keystone = [
    ...new Set(
      [...dealerships.map((row) => row.relationship_manager_id), ...visits.map((row) => row.lender_user_id)].filter(
        (id): id is number => typeof id === 'number' && Number.isSafeInteger(id),
      ),
    ),
  ];
  return { dealers, keystone };
}

export default defineAppRowPolicy({
  appId: 'dealer',
  async resolveRows(principal, { db }) {
    // Keystone's support desk invites people here; it reads no dealership's rows through this App.
    if (!principal.roles.includes('manager')) return NOTHING;
    const { dealers, keystone } = await seatsOf(db, principal.id);
    if (!dealers.length) return NOTHING;
    const own = { groups: [[{ column: 'dealer_id', op: 'in' as const, value: dealers }]] };
    return {
      dealer: { groups: [[{ column: 'id', op: 'in' as const, value: dealers }]] },
      dealer_site: own,
      dealer_user: own,
      vehicle: own,
      vehicle_photo: own,
      lead: own,
      dealer_visit: own,
      lender_user: keystone.length ? { groups: [[{ column: 'id', op: 'in' as const, value: keystone }]] } : false,
      program: true,
    };
  },
  // Each command answers only fixed words: nothing in its receipt names another row.
  resultReferences: {
    publishWebsite: () => [],
    unpublishWebsite: () => [],
    listForSale: () => [],
    takeOffTheMarket: () => [],
    addTeamMember: () => [],
    updateDealerContact: () => [],
    changeTeamRole: () => [],
    deactivateTeamMember: () => [],
  },
});
