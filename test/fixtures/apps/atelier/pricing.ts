/* How an order's total is made, in one place: the commands price a new order
   with it, and the seed (test/fixtures/databases/atelier) prices six months of
   orders with the same rules, so the two can never disagree.

   Everything is counted in integer cents and written as decimal text at the
   edge. The stored columns are decimals for now, named `…_amount`; moving
   them to minor units changes `toAmount`/`fromAmount`, not the arithmetic.

   total = subtotal − discount + shipping + tax, where tax is charged on the
   goods after the discount and never on shipping. */

/** Sales tax by the state an order ships to (a store pickup: the store's), as a fraction. */
export const TAX_RATES: Readonly<Record<string, number>> = {
  NY: 0.08875,
  CA: 0.095,
  NJ: 0.06625,
  MA: 0.0625,
  PA: 0.06,
  IL: 0.1025,
  TX: 0.0825,
  WA: 0.101,
  CO: 0.0815,
  GA: 0.089,
  FL: 0.07,
  OR: 0,
  DC: 0.06,
  MN: 0.08875,
  AZ: 0.086,
};
/** A state the table does not name. */
export const DEFAULT_TAX_RATE = 0.07;

export const SHIPPING_CENTS = { standard: 800, express: 1800, pickup: 0 } as const;
/** Standard shipping is free once the goods, after the discount, reach this. */
export const FREE_SHIPPING_FROM_CENTS = 15000;

export type ShippingMethod = keyof typeof SHIPPING_CENTS;

export interface DiscountRule {
  kind: string; // 'percent' or 'fixed', held by the table's CHECK
  percent_off: number | string | null;
  amount_off_amount: number | string | null;
  min_subtotal_amount: number | string;
}

export interface Priced {
  subtotal: number;
  discount: number;
  shipping: number;
  taxRate: number;
  tax: number;
  total: number;
}

/** A stored decimal ('12.30', 12.3) as integer cents, exactly. */
export function toCents(amount: number | string | null | undefined): number {
  if (amount === null || amount === undefined || amount === '') return 0;
  return Math.round(Number(amount) * 100);
}
/** Integer cents as the decimal text the `…_amount` columns hold. */
export function toAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Not a whole number of cents: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
/** Cents said as dollars, for a refusal or a receipt: $1,234.50. */
export function dollars(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function taxRateFor(state: string): number {
  return TAX_RATES[state.toUpperCase()] ?? DEFAULT_TAX_RATE;
}

/** What a discount takes off these goods, or 0 where the goods are under its minimum. */
export function discountCents(rule: DiscountRule | null, subtotal: number): number {
  if (!rule || subtotal < toCents(rule.min_subtotal_amount)) return 0;
  const off = rule.kind === 'percent' ? Math.round((subtotal * Number(rule.percent_off)) / 100) : toCents(rule.amount_off_amount);
  return Math.min(off, subtotal);
}

/** An order's figures from its lines (quantity × unit price in cents), its discount, how it ships and where. */
export function priceOrder(
  lines: readonly { quantity: number; unitCents: number }[],
  options: { discount: DiscountRule | null; shipping: ShippingMethod; state: string },
): Priced {
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0);
  const discount = discountCents(options.discount, subtotal);
  const goods = subtotal - discount;
  const shipping = options.shipping === 'standard' && goods >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS[options.shipping];
  const taxRate = taxRateFor(options.state);
  const tax = Math.round(goods * taxRate);
  return { subtotal, discount, shipping, taxRate, tax, total: goods + shipping + tax };
}

/**
 * What returned goods are worth to the customer: their share of the goods after
 * the order's discount, with the tax charged on that share. Shipping stays
 * with the shop. Never more than was paid: the refund command caps it there.
 */
export function returnCents(
  order: { subtotal: number; discount: number; taxRate: number },
  lines: readonly { quantity: number; unit_price_amount: number | string }[],
): number {
  const goods = lines.reduce((sum, line) => sum + line.quantity * toCents(line.unit_price_amount), 0);
  const share = order.subtotal ? Math.round((goods * (order.subtotal - order.discount)) / order.subtotal) : 0;
  return share + Math.round(share * order.taxRate);
}
