// The soft estimate behind Check your rate: no bureau, only what the person
// told us and the advertised programs. Pure, so the arithmetic is readable.
import type { Rows } from '../mistri-schema.d.ts';

type Program = Rows['program'];
type Vehicle = Rows['vehicle'];

const tierRank: Record<string, number> = { super_prime: 0, prime: 1, near_prime: 2, subprime: 3 };
// A band may be offered its own tier or any riskier one; "not sure" is estimated as fair.
const bandRank: Record<string, number> = { excellent: 0, good: 1, fair: 2, rebuilding: 3, unsure: 2 };

/** At most this share of income goes to the car payment. */
const PAYMENT_TO_INCOME = 0.15;
/** Below this, no program is worth offering. */
const SMALLEST_LOAN = 5000;

export type Estimate = { status: 'matched'; program: Program; amount: number; apr: number } | { status: 'no_match' };

export function estimate(
  programs: readonly Program[],
  input: { credit_band: string; monthly_income: number; desired_payment: number },
  car: Vehicle | undefined,
  year: number,
): Estimate {
  const rank = bandRank[input.credit_band] ?? 2;
  const eligible = programs.filter(
    (p) =>
      p.advertised &&
      p.active &&
      (tierRank[p.tier] ?? 9) >= rank &&
      (!car || (year - car.year <= p.max_vehicle_age && car.mileage <= p.max_mileage)) &&
      // The electric program is for electric cars only.
      (p.code !== 'KS-EV' || car?.fuel === 'electric'),
  );
  if (!eligible.length) return { status: 'no_match' };
  const program = eligible.reduce((best, p) => (Number(p.base_apr) < Number(best.base_apr) ? p : best));
  const apr = Number(program.base_apr);
  const payment = Math.min(input.desired_payment, input.monthly_income * PAYMENT_TO_INCOME);
  const months = Math.min(program.max_term, 72);
  const r = apr / 1200;
  let amount = r === 0 ? payment * months : (payment * (1 - (1 + r) ** -months)) / r;
  amount = Math.min(amount, Number(program.max_amount));
  if (car) amount = Math.min(amount, (Number(car.list_price) * Number(program.max_ltv_pct)) / 100);
  // Said in round figures: it is an estimate, not an offer.
  amount = Math.floor(amount / 500) * 500;
  return amount < SMALLEST_LOAN ? { status: 'no_match' } : { status: 'matched', program, amount, apr };
}
