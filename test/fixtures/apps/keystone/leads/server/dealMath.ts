// The desk's arithmetic, in one place: what a deal's figures add up to, the
// payment on them, and the three structures of the payment grid. Server-only.
//
// Money arrives from PostgreSQL as exact decimal text ("24999.00") and goes
// back the same way; in between it is worked in cents-rounded numbers, so no
// figure written is ever a float's approximation.

export const money = (n: number) => Math.round(n * 100) / 100;
export const cents = (n: number) => money(n).toFixed(2);
/** A form's starting values without the empty ones: `initial` answers JSON, and JSON has no `undefined`. */
export const known = <T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined | null> } =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null)) as {
    [K in keyof T]?: Exclude<T[K], undefined | null>;
  };
export const num = (value: string | number | null | undefined) => Number(value ?? 0);

/** The level monthly payment that pays `principal` off in `term` months at `apr` percent a year. */
export function payment(principal: number, apr: number, term: number): number {
  const r = apr / 1200;
  return money(r === 0 ? principal / term : (principal * r) / (1 - (1 + r) ** -term));
}

type Program = {
  base_apr: string | number;
  max_term: number;
  max_amount: string | number;
  max_mileage: number;
  max_vehicle_age: number;
  name: string;
};

/** Keystone's buy rate for a program: its base rate, and half a point for a
    term past 72 months. The dealer has no bureau score, so this is the rate
    it desks against; Keystone prices the applicant when it decides. */
export const aprFor = (program: Program, term: number) => Math.round((num(program.base_apr) + (term > 72 ? 0.5 : 0)) * 1000) / 1000;

/** What a deal's worksheet holds, as numbers. */
export type Figures = {
  sale_price: number;
  rebate: number;
  doc_fee: number;
  title_fees: number;
  tax_rate: number;
  trade_allowance: number;
  trade_payoff: number;
  service_contract: number;
  gap: number;
  cash_down: number;
};

/**
 * The worksheet, in the order it adds up: the price less the rebate, the tax
 * on the price less the trade (the trade is not taxed twice), the fees, the
 * products, the trade's payoff that rolls into the loan, less the trade's
 * allowance and the cash down.
 */
export function work(f: Figures) {
  const sales_tax = money((Math.max(0, f.sale_price - f.trade_allowance) * f.tax_rate) / 100);
  const amount_financed = money(
    f.sale_price -
      f.rebate +
      sales_tax +
      f.doc_fee +
      f.title_fees +
      f.service_contract +
      f.gap +
      f.trade_payoff -
      f.trade_allowance -
      f.cash_down,
  );
  return { sales_tax, amount_financed };
}

/** The payment grid: A as structured, B the next common term, C with $2,000 more down. */
export function grid(program: Program, amountFinanced: number, term: number, cashDown: number) {
  const other = term === 72 ? 60 : 72;
  const alternate = Math.min(other, program.max_term);
  return [
    { label: 'A', term_months: term, cash_down: cashDown, amount_financed: amountFinanced },
    { label: 'B', term_months: alternate, cash_down: cashDown, amount_financed: amountFinanced },
    { label: 'C', term_months: term, cash_down: cashDown + 2000, amount_financed: Math.max(0, money(amountFinanced - 2000)) },
  ].map((row) => {
    const apr = aprFor(program, row.term_months);
    return { ...row, apr, monthly_payment: payment(row.amount_financed, apr, row.term_months) };
  });
}

/** Why a structure falls outside the program, in the desk's words, or undefined when it fits. */
export function outsideProgram(
  program: Program,
  amountFinanced: number,
  term: number,
  vehicle: { year: number; mileage: number },
  today: Date,
): string | undefined {
  if (term > program.max_term) return `${program.name} lends up to ${program.max_term} months; this deal asks ${term}.`;
  if (amountFinanced > num(program.max_amount)) {
    return `${program.name} lends up to $${num(program.max_amount).toLocaleString('en-US')}; this deal finances $${amountFinanced.toLocaleString('en-US')}.`;
  }
  if (vehicle.mileage > program.max_mileage)
    return `${program.name} takes cars under ${program.max_mileage.toLocaleString('en-US')} miles.`;
  if (today.getUTCFullYear() - vehicle.year > program.max_vehicle_age)
    return `${program.name} takes cars up to ${program.max_vehicle_age} years old.`;
  if (amountFinanced <= 0) return 'Nothing is left to finance: the money down and the trade cover the car.';
  return undefined;
}

/** A moment as the schema's `timestamp` holds it: UTC, to the second. */
export const stamp = (at: Date) => at.toISOString().slice(0, 19).replace('T', ' ');
export const day = (at: Date) => at.toISOString().slice(0, 10);

/** The next reference in a dealer's own series (`LD-1001`, `DL-1001`): the highest it holds, plus one. */
export function nextReference(prefix: string, existing: readonly { reference: string | null }[]): string {
  let highest = 1000;
  for (const { reference } of existing) {
    const match = reference ? new RegExp(`^${prefix}-(\\d+)$`).exec(reference) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

/**
 * When Keystone owes the dealer an answer: four business hours after the
 * submission, business hours being 9 to 6 Eastern on weekdays (said here in
 * UTC as 13:00 to 22:00, a fixed offset the demonstration can live with).
 */
export function decisionDue(from: Date): Date {
  const OPEN = 13,
    CLOSE = 22;
  let at = new Date(from.getTime());
  let left = 4 * 60;
  for (;;) {
    const weekday = at.getUTCDay();
    const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
    if (weekday === 0 || weekday === 6 || hour >= CLOSE) {
      at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1, OPEN));
      continue;
    }
    if (hour < OPEN) {
      at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), OPEN));
      continue;
    }
    const today = (CLOSE - hour) * 60;
    if (left <= today) return new Date(at.getTime() + left * 60_000);
    left -= today;
    at = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1, OPEN));
  }
}
