// Private deployment policy, loaded with --policy. Never import this module into the App.
import { defineAppRowPolicy, type PolicyDb, type RowScope } from '@mistriwork/mistri/policy';

/* Which rows a signed-in borrower reads: their own customer row, their
   loans and everything under them, and the dealers who sold them the cars.
   A row policy filters on each table's own columns, so every table below
   carries customer_id itself (the schema's composite keys keep it true).

   The customer is found from the verified session only: by the exact
   account id servicing linked (customer.account_id). Unlinked or ambiguous
   accounts grant nothing, even when the email matches. Nothing a request
   says is read. The lookup uses the read-only db supplied by the App, on
   its own pooled connection. */

const NOTHING: RowScope = {
  customer: false,
  loan: false,
  installment: false,
  payment: false,
  autopay: false,
  payoff_quote: false,
  loan_document: false,
  dealer: false,
};

async function customerOf(db: PolicyDb, accountId: string): Promise<{ id: number; dealers: string[] } | null> {
  const found = await db.customer.where({ account_id: accountId }).limit(2);
  if (found.length !== 1) return null;
  const id = found[0].id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  const dealers = new Set<string>();
  let after: number | undefined;
  for (;;) {
    const query = after === undefined ? db.loan.where({ customer_id: id }) : db.loan.where`customer_id = ${id} and id > ${after}`;
    const loans = await query.orderBy('id').limit(1000);
    for (const loan of loans) {
      if (typeof loan.id !== 'number' || !Number.isSafeInteger(loan.id) || (after !== undefined && loan.id <= after)) {
        throw new Error('The policy lookup returned an invalid or repeated primary key.');
      }
      after = loan.id;
      if (typeof loan.dealer_id === 'string' && loan.dealer_id.length > 0) dealers.add(loan.dealer_id);
    }
    if (loans.length < 1000) return { id, dealers: [...dealers] };
  }
}

export default defineAppRowPolicy({
  appId: 'customer',
  async resolveRows(principal, { db }) {
    // Servicing staff invite borrowers here; they read no borrower's rows through this App.
    if (!principal.roles.includes('borrower')) return NOTHING;
    const customer = await customerOf(db, principal.id);
    if (!customer) return NOTHING;
    const own = { groups: [[{ column: 'customer_id', op: '=' as const, value: customer.id }]] };
    return {
      customer: { groups: [[{ column: 'id', op: '=' as const, value: customer.id }]] },
      loan: own,
      installment: own,
      payment: own,
      autopay: own,
      payoff_quote: own,
      loan_document: own,
      dealer: customer.dealers.length ? { groups: customer.dealers.map((id) => [{ column: 'id', op: '=' as const, value: id }]) } : false,
    };
  },
  // Each command answers only fixed words: nothing in its receipt names another row.
  resultReferences: {
    makePayment: () => [],
    requestPayoffQuote: () => [],
    enrollAutopay: () => [],
    cancelAutopay: () => [],
  },
});
