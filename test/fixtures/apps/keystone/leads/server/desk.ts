import {
  addTradeInInput,
  markContractedInput,
  selectScenarioInput,
  structureDealInput,
  submitToLenderInput,
} from '../features/desk-inputs.ts';
// The desk: rework a deal's numbers, add a trade, pick a structure from the
// grid, submit it to Keystone, and mark it contracted once Keystone approves.
// Tenant-realm commands; the arithmetic is dealMath.ts's, and every command
// that changes a figure rewrites the whole worksheet and the grid from it, in
// one transaction, so the page always adds up.
import { defineCommand, literal, refuse, shape, text } from '@mistriwork/mistri/commands';
import type { Rows } from '../mistri-schema.d.ts';

import { aprFor, cents, decisionDue, grid, known, money, num, outsideProgram, payment, stamp, work, type Figures } from './dealMath.ts';
import { applicationSubmitted } from './events.ts';
import { whoIs } from './leads.ts';
import { keystone } from './source.ts';

const key = text({ max: 200 });
// What a deal row's parents are, read so the write that changes it can be checked against them.
const DEAL_PARENTS = ['lead', 'applicant', 'vehicle', 'dealer_user', 'program'] as const;

type Deal = Rows['deal'];
type Program = Rows['program'];
type Vehicle = Rows['vehicle'];

/** The worksheet a deal holds now, as numbers. */
const figuresOf = (deal: Deal): Figures => ({
  sale_price: num(deal.sale_price),
  rebate: num(deal.rebate),
  doc_fee: num(deal.doc_fee),
  title_fees: num(deal.title_fees),
  tax_rate: num(deal.tax_rate),
  trade_allowance: num(deal.trade_allowance),
  trade_payoff: num(deal.trade_payoff),
  service_contract: num(deal.service_contract),
  gap: num(deal.gap),
  cash_down: num(deal.cash_down),
});

type Scenarios = {
  where(where: { deal_id: string }): PromiseLike<Rows['deal_scenario'][]>;
  remove(row: Rows['deal_scenario']): Promise<unknown>;
  insert(values: Omit<Rows['deal_scenario'], 'id' | 'dealer_id'>): Promise<unknown>;
};

/** The figures the worksheet leads to, refused when the program will not lend them. */
function price(figures: Figures, program: Program, term: number, vehicle: Vehicle, today: Date) {
  const { sales_tax, amount_financed } = work(figures);
  const why = outsideProgram(program, amount_financed, term, vehicle, today);
  if (why) refuse(why);
  const apr = aprFor(program, term);
  return { sales_tax, amount_financed, apr, monthly_payment: payment(amount_financed, apr, term) };
}

/** Write the deal's worksheet and its payment grid from `figures`, scenario A selected. */
async function restructure(
  db: { deal: { update(row: Deal, changes: Partial<Deal>): Promise<Deal> }; deal_scenario: Scenarios },
  deal: Deal,
  figures: Figures,
  program: Program,
  term: number,
  vehicle: Vehicle,
  now: Date,
) {
  const priced = price(figures, program, term, vehicle, now);
  for (const row of await db.deal_scenario.where({ deal_id: deal.id })) await db.deal_scenario.remove(row);
  for (const row of grid(program, priced.amount_financed, term, figures.cash_down)) {
    await db.deal_scenario.insert({
      deal_id: deal.id,
      label: row.label,
      term_months: row.term_months,
      apr: row.apr.toFixed(3),
      cash_down: cents(row.cash_down),
      amount_financed: cents(row.amount_financed),
      monthly_payment: cents(row.monthly_payment),
      selected: row.label === 'A',
    });
  }
  return db.deal.update(deal, {
    program_id: program.id,
    sale_price: cents(figures.sale_price),
    rebate: cents(figures.rebate),
    doc_fee: cents(figures.doc_fee),
    title_fees: cents(figures.title_fees),
    tax_rate: figures.tax_rate.toFixed(3),
    sales_tax: cents(priced.sales_tax),
    trade_allowance: cents(figures.trade_allowance),
    trade_payoff: cents(figures.trade_payoff),
    service_contract: cents(figures.service_contract),
    gap: cents(figures.gap),
    cash_down: cents(figures.cash_down),
    amount_financed: cents(priced.amount_financed),
    term_months: term,
    apr: priced.apr.toFixed(3),
    monthly_payment: cents(priced.monthly_payment),
    updated_at: stamp(now),
  });
}

const reworked = shape({ dealId: key, monthlyPayment: text({ max: 20 }), message: literal('Deal restructured.') });
const traded = shape({ dealId: key, tradeId: key, message: literal('Trade-in added.') });
const selected = shape({ dealId: key, label: literal('A', 'B', 'C'), message: literal('Structure selected.') });
export const submitted = shape({
  dealId: key,
  applicationId: key,
  reference: text({ max: 20 }),
  dueAt: text({ max: 19 }),
  message: literal('Submitted to Keystone.'),
});
const contracted = shape({ dealId: key, message: literal('Deal contracted.') });

/** A reference Keystone quotes back: `KA-` and six digits, unused at this dealer. */
async function applicationReference(applications: { find(where: { reference: string }): Promise<unknown> }) {
  for (;;) {
    const reference = `KA-${200000 + Math.floor(Math.random() * 800000)}`;
    if (!(await applications.find({ reference }))) return reference;
  }
}

export const deskCommands = {
  /* The finance manager says the price, the rebate, the fees, the products,
     the program, the term and the money down; the tax, the amount financed,
     the payment and the grid follow. */
  structureDeal: defineCommand({
    target: 'deal',
    input: structureDealInput,
    source: keystone,
    read: [...DEAL_PARENTS, 'trade_in'],
    write: ['deal_scenario'],
    when: 'status = structuring',
    output: reworked,
    initial: ({ record: deal }) => ({
      price: { sale_price: num(deal.sale_price), rebate: num(deal.rebate) },
      fees: { doc_fee: num(deal.doc_fee), title_fees: num(deal.title_fees) },
      products: { service_contract: num(deal.service_contract), gap: num(deal.gap) },
      financing: known({
        program: deal.program_id ?? undefined,
        term_months: deal.term_months as 48 | 60 | 66 | 72 | 75 | 84,
        cash_down: num(deal.cash_down),
      }),
    }),
    async handle({ db, record: deal, now }, input) {
      const program = await db.program.get(input.financing.program);
      if (!program.active) refuse(`${program.name} is closed to new deals.`);
      const vehicle = await db.vehicle.get(deal.vehicle_id);
      const figures = { ...figuresOf(deal), ...input.price, ...input.fees, ...input.products, cash_down: input.financing.cash_down };
      const updated = await restructure(db, deal, figures, program, input.financing.term_months, vehicle, now());
      return { dealId: deal.id, monthlyPayment: cents(num(updated.monthly_payment)), message: 'Deal restructured.' as const };
    },
  }),

  /* A trade goes toward the car: its allowance comes off, its payoff rolls
     in, and the tax is on the price less the allowance. */
  addTradeIn: defineCommand({
    target: 'deal',
    input: addTradeInInput,
    source: keystone,
    read: [...DEAL_PARENTS],
    write: ['trade_in', 'deal_scenario'],
    when: 'status = structuring',
    output: traded,
    async handle({ db, record: deal, now }, input) {
      const payoff = input.money.payoff ?? 0;
      const lienholder = input.money.lienholder?.trim() || null;
      if (payoff > 0 && !lienholder) refuse('Say who holds the loan on the trade: it has a payoff.');
      if (payoff === 0 && lienholder) refuse('A trade with a lienholder has a payoff; enter what is still owed.');
      const trade = await db.trade_in.insert({
        deal_id: deal.id,
        ...input.car,
        allowance: cents(input.money.allowance),
        acv: cents(input.money.acv ?? input.money.allowance),
        payoff: cents(payoff),
        lienholder,
        version: 0,
      });
      if (deal.program_id === null) refuse('Pick a program for the deal first.');
      const program = await db.program.get(deal.program_id);
      const vehicle = await db.vehicle.get(deal.vehicle_id);
      const figures = {
        ...figuresOf(deal),
        trade_allowance: money(num(deal.trade_allowance) + input.money.allowance),
        trade_payoff: money(num(deal.trade_payoff) + payoff),
      };
      await restructure(db, deal, figures, program, deal.term_months, vehicle, now());
      return { dealId: deal.id, tradeId: trade.id, message: 'Trade-in added.' as const };
    },
  }),

  /* The customer picks a structure from the grid: its term, money down and
     payment become the deal's. */
  selectScenario: defineCommand({
    target: 'deal',
    input: selectScenarioInput,
    source: keystone,
    read: [...DEAL_PARENTS],
    write: ['deal_scenario'],
    when: 'status = structuring',
    output: selected,
    initial: async ({ db, record: deal }) =>
      known({ label: (await db.deal_scenario.find({ deal_id: deal.id, selected: true }))?.label as 'A' | 'B' | 'C' | undefined }),
    async handle({ db, record: deal, now }, input) {
      const choice = await db.deal_scenario.find({ deal_id: deal.id, label: input.label });
      if (!choice) refuse(`This deal has no scenario ${input.label}; rework the numbers to draw the grid again.`);
      for (const row of await db.deal_scenario.where({ deal_id: deal.id })) {
        if (row.selected !== (row.id === choice.id)) await db.deal_scenario.update(row, { selected: row.id === choice.id });
      }
      await db.deal.update(deal, {
        term_months: choice.term_months,
        apr: choice.apr,
        cash_down: choice.cash_down,
        amount_financed: choice.amount_financed,
        monthly_payment: choice.monthly_payment,
        updated_at: stamp(now()),
      });
      return { dealId: deal.id, label: input.label as 'A' | 'B' | 'C', message: 'Structure selected.' as const };
    },
  }),

  /* The application Keystone reads: what is asked (the selected structure),
     what it is measured by (loan to value, payment to income, debt to income
     from the housing and this payment), and the dealer's note. The deal and
     the lead move to submitted, and the decision clock starts. */
  submitToLender: defineCommand({
    target: 'deal',
    input: submitToLenderInput,
    source: keystone,
    read: [...DEAL_PARENTS, 'deal_scenario'],
    write: ['loan_application', 'lead', 'lead_activity'],
    when: 'status = structuring',
    output: submitted,
    events: {
      submitted: applicationSubmitted,
    },
    async handle({ db, record: deal, actor, now }, input) {
      if (!(await db.deal_scenario.find({ deal_id: deal.id, selected: true }))) refuse('Select the structure the customer chose first.');
      if (deal.program_id === null) refuse('Pick a program for the deal first.');
      if (await db.loan_application.find({ deal_id: deal.id })) refuse('This deal has been submitted already.');
      const applicant = await db.applicant.get(deal.applicant_id);
      const vehicle = await db.vehicle.get(deal.vehicle_id);
      const financed = num(deal.amount_financed),
        monthly = num(deal.monthly_payment),
        income = num(applicant.monthly_income);
      if (income <= 0) refuse("The applicant's income is missing; Keystone cannot measure the payment against it.");
      const value = num(vehicle.list_price);
      const at = now();
      const due = decisionDue(at);
      const application = await db.loan_application.insert({
        reference: await applicationReference(db.loan_application),
        deal_id: deal.id,
        applicant_id: deal.applicant_id,
        co_applicant_id: deal.co_applicant_id,
        vehicle_id: deal.vehicle_id,
        program_id: deal.program_id,
        status: 'submitted',
        requested_amount: cents(financed),
        requested_term: deal.term_months,
        down_payment: deal.cash_down,
        vehicle_value: cents(value),
        ltv_pct: ((financed / value) * 100).toFixed(1),
        pti_pct: ((monthly / income) * 100).toFixed(1),
        dti_pct: (((monthly + num(applicant.monthly_housing)) / income) * 100).toFixed(1),
        dealer_note: input.dealer_note ?? null,
        submitted_at: stamp(at),
        decided_at: null,
        approved_amount: null,
        approved_apr: null,
        approved_term: null,
        approved_payment: null,
        decline_reason: null,
        withdrawn_reason: null,
        version: 0,
      });
      const me = await whoIs(db.dealer_user, actor);
      await db.deal.update(deal, {
        status: 'submitted',
        finance_manager_id: deal.finance_manager_id ?? me?.id ?? null,
        updated_at: stamp(at),
      });
      const lead = await db.lead.get(deal.lead_id);
      if (lead.status === 'desking' || lead.status === 'contacted') await db.lead.update(lead, { status: 'submitted' });
      await db.lead_activity.insert({
        lead_id: deal.lead_id,
        kind: 'status',
        author_id: me?.id ?? null,
        created_at: stamp(at),
        body: `Submitted ${deal.reference} to Keystone as ${application.reference}.`,
      });
      return {
        dealId: deal.id,
        applicationId: application.id,
        reference: application.reference,
        dueAt: stamp(due),
        message: 'Submitted to Keystone.' as const,
      };
    },
  }),

  /* The customer has signed on Keystone's approval: the contract goes to
     Keystone's funding queue. */
  markContracted: defineCommand({
    target: 'deal',
    input: markContractedInput,
    source: keystone,
    read: [...DEAL_PARENTS, 'loan_application'],
    write: ['lead_activity'],
    when: 'status = approved',
    output: contracted,
    async handle({ db, record: deal, actor, now }, input) {
      if (!input.confirm) refuse('invalid_input', 'confirm');
      const application = await db.loan_application.find({ deal_id: deal.id });
      if (!application || (application.status !== 'approved' && application.status !== 'countered')) {
        refuse("Keystone has not approved this deal's application.");
      }
      await db.deal.update(deal, { status: 'contracted', updated_at: stamp(now()) });
      const me = await whoIs(db.dealer_user, actor);
      await db.lead_activity.insert({
        lead_id: deal.lead_id,
        kind: 'status',
        author_id: me?.id ?? null,
        created_at: stamp(now()),
        body: `${deal.reference} contracted; sent to Keystone for funding.`,
      });
      return { dealId: deal.id, message: 'Deal contracted.' as const };
    },
  }),
};
