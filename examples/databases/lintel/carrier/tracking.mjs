/**
 * The tracking numbers the storeroom's deliveries carry (data.mjs gives the first six to its part receipts, in
 * order) and the shipments the carrier's stub (api.mjs) answers for them. One list, so a delivery's number is
 * always one the stub knows. The last four are on their way and have no delivery yet.
 */
export const RECEIPT_TRACKING = ['NB7310004412', 'NB7310005127', 'NB7310006843', 'NB7310007390', 'NB7310008016', 'NB7310009254'];
export const INBOUND_TRACKING = ['NB7310010068', 'NB7310010931', 'NB7310011477', 'NB7310012205'];

const DAY = 86_400_000;
/**
 * The day each of those deliveries came, from the seed's `today` (YYYY-MM-DD), oldest first: four in the months
 * before this one, then this month's first day and today. Counted back from today alone, the newest landed two weeks
 * back, and for half of every month the delivery board's calendar opened on a month with none in it.
 */
export function receiptDays(today) {
  const first = Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`);
  const days = [-70, -50, -30, -12].map((n) => first + n * DAY);
  return [...days, first, Date.parse(`${today}T00:00:00Z`)].map((ms) => new Date(ms).toISOString().slice(0, 10));
}
