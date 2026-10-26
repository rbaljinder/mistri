// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
export const terms = field.choice([48, 60, 66, 72, 75, 84], { label: 'Term', each: (n) => `${n} months` });
export const structureDealInput = {
  price: field.group({
    sale_price: field.money({ label: 'Selling price', min: 1, max: 500000 }),
    rebate: field.money({ label: 'Manufacturer rebate', min: 0, max: 20000 }),
  }),
  fees: field.group(
    {
      doc_fee: field.money({ label: 'Documentation fee', min: 0, max: 2000 }),
      title_fees: field.money({ label: 'Title and registration', min: 0, max: 3000 }),
    },
    { description: "Sales tax is worked out from the price less the trade, at the deal's tax rate." },
  ),
  products: field.group({
    service_contract: field.money({ min: 0, max: 10000 }),
    gap: field.money({ label: 'GAP coverage', min: 0, max: 3000 }),
  }),
  financing: field.group({
    program: field.reference('program', {
      by: 'id',
      labelColumn: 'name',
      query: 'active = true sort min_score desc',
      label: 'Keystone program',
    }),
    term_months: terms,
    cash_down: field.money({ min: 0, max: 500000 }),
  }),
};

export const addTradeInInput = {
  car: field.group(
    {
      vin: field.text({
        label: 'VIN',
        pattern: /[A-HJ-NPR-Z0-9]{17}/,
        case: 'upper',
        message: 'Seventeen letters and digits, no I, O or Q.',
      }),
      year: field.number({ integer: true, min: 1990, max: 2027 }),
      make: field.text({ max: 40 }),
      model: field.text({ max: 60 }),
      mileage: field.number({ integer: true, min: 0, max: 999999 }),
      condition: field.choice(['excellent', 'good', 'fair', 'rough'], { each: (word) => word[0].toUpperCase() + word.slice(1) }),
    },
    { label: 'The trade' },
  ),
  money: field.group(
    {
      allowance: field.money({ min: 0, max: 200000, help: 'What the customer is credited.' }),
      acv: field.money({
        label: 'Actual cash value',
        min: 0,
        max: 200000,
        optional: true,
        help: 'The appraisal. Leave empty to use the allowance.',
      }),
      payoff: field.money({ min: 0, max: 200000, optional: true, help: 'What is still owed on it. Leave empty when it is paid off.' }),
      lienholder: field.text({ max: 80, optional: true, help: 'Who holds the loan, when there is a payoff.' }),
    },
    { label: 'What it is worth' },
  ),
};

export const selectScenarioInput = {
  label: field.choice(
    [
      { value: 'A', label: 'Scenario A' },
      { value: 'B', label: 'Scenario B' },
      { value: 'C', label: 'Scenario C' },
    ],
    { label: 'Structure', help: "Its term, money down and payment become the deal's." },
  ),
};

export const submitToLenderInput = {
  dealer_note: field.textarea({
    label: 'Note to Keystone',
    max: 1000,
    optional: true,
    help: 'Anything the underwriter should know: time on the job, a co-signer, a prior loan paid as agreed.',
  }),
};

export const markContractedInput = { confirm: field.bool({ label: 'The customer has signed the retail installment contract' }) };
