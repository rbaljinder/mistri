import { action, count, defineFeature, fields, header, history, listView, page, related } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { dealStatus, dollars, miles, months, perMonth, rate } from '../vocab.ts';

/* The desk's verbs. The arithmetic is the server's (server/dealMath.ts): a
   finance manager says the price, the money down, the products and the term,
   and the tax, the amount financed, the payment and the three scenarios of
   the payment grid are worked out from them in the same transaction, so the
   figures on the page always add up. */

/** A deal's road, in order. Cancelled is a way off it, said by its tone. */

export const submitToKeystoneAction = action('Submit to Keystone', { command: 'submitToLender' });
export const desk = defineFeature({
  id: 'desk',
  resources: {
    deal: {
      segments: {
        on_the_desk: 'status = structuring',
        with_keystone: { query: 'status = submitted', label: 'With Keystone' },
        approved: 'status = approved',
        contracted: 'status = contracted',
        funded: 'status = funded',
      },
      recordLabel: '{reference} · {lead_id.first_name} {lead_id.last_name}',
      labels: {
        reference: 'Deal',
        lead_id: 'Customer',
        vehicle_id: 'Vehicle',
        program_id: 'Program',
        applicant_id: 'Applicant',
        co_applicant_id: 'Co-applicant',
        salesperson_id: 'Salesperson',
        finance_manager_id: 'Finance manager',
        sale_price: 'Selling price',
        doc_fee: 'Documentation fee',
        title_fees: 'Title and registration',
        gap: 'GAP coverage',
        term_months: 'Term',
        apr: 'APR',
        monthly_payment: 'Payment',
        created_on: 'Opened',
        updated_at: 'Last worked',
        'lead_id.first_name': 'First name',
        'lead_id.last_name': 'Last name',
        'vehicle_id.model': 'Vehicle',
        'vehicle_id.make': 'Make',
        'salesperson_id.name': 'Salesperson',
        'finance_manager_id.name': 'Finance manager',
        'co_applicant_id.last_name': 'Co-applicant',
      },
      display: {
        status: dealStatus,
        sale_price: dollars,
        rebate: dollars,
        doc_fee: dollars,
        title_fees: dollars,
        sales_tax: dollars,
        trade_allowance: dollars,
        trade_payoff: dollars,
        cash_down: dollars,
        service_contract: dollars,
        gap: dollars,
        amount_financed: dollars,
        monthly_payment: perMonth,
        apr: rate,
        tax_rate: rate,
        term_months: months,
        updated_at: { format: 'relative' },
      },
      rollups: { trades: count('trade_in', { whose: 'deal_id' }) },
      actions: {
        submitToLender: submitToKeystoneAction,
        markContracted: action('Mark contracted', { command: 'markContracted' }),
        structureDeal: action('Rework the numbers', { command: 'structureDeal' }),
        selectScenario: action('Select scenario', { command: 'selectScenario' }),
        addTradeIn: action('Add trade-in', { command: 'addTradeIn' }),
      },
    },
    deal_scenario: {
      recordLabel: 'Scenario {label}',
      labels: {
        label: 'Scenario',
        term_months: 'Term',
        apr: 'APR',
        cash_down: 'Down',
        amount_financed: 'Financed',
        monthly_payment: 'Payment',
      },
      display: {
        term_months: months,
        apr: rate,
        cash_down: dollars,
        amount_financed: dollars,
        monthly_payment: perMonth,
        selected: { tone: { true: 'good', '*': 'neutral' }, values: { true: 'Selected', false: 'Offered' } },
      },
    },
    trade_in: {
      recordLabel: '{year} {make} {model}',
      labels: { acv: 'Actual cash value' },
      display: { allowance: dollars, acv: dollars, payoff: dollars, mileage: miles },
    },
  },
  views: {
    deals: listView('Deals', 'deal', {
      icon: 'handshake',
      show: ['reference', 'lead_id.first_name', 'lead_id.last_name', 'vehicle_id.model', 'amount_financed', 'monthly_payment', 'status'],
      filters: ['program_id', 'created_on'],
      sort: 'updated_at desc',
      totals: ['amount_financed'],
      tabs: [
        { segment: 'on_the_desk', sort: 'updated_at desc' },
        { segment: 'with_keystone', sort: 'updated_at' },
        { segment: 'approved', sort: 'updated_at' },
        { segment: 'contracted', sort: 'updated_at' },
        { segment: 'funded', sort: 'updated_at desc' },
        { label: 'All' },
      ],
      empty: { title: 'Nothing here', description: 'A deal is started from a lead once the customer has picked a car.' },
    }),
  },
  pages: {
    /* The desk. The payment leads, because it is what the customer is asked
       to say yes to; the road says where the deal stands with Keystone; the
       worksheet shows the figures in the order they add up (price, trade,
       taxes and fees, products, down payment) to the amount financed; the
       payment grid, the trade-ins and the application are tabs; beside them,
       the customer, the car and who is working it. */
    deal: page(
      'deal',
      [
        header({
          status: 'status',
          facts: ['vehicle_id.make', 'vehicle_id.model', 'program_id', { column: 'updated_at', before: 'Worked' }],
          primary: 'submitToLender',
        }),
        fields(['monthly_payment', 'amount_financed', 'apr']),
        fields(['sale_price', 'rebate'], { title: 'Price', presentation: 'table', width: 'half' }),
        fields(['trade_allowance', 'trade_payoff'], { title: 'Trade', presentation: 'table', width: 'half' }),
        fields(['tax_rate', 'sales_tax', 'doc_fee', 'title_fees'], { title: 'Taxes and fees', presentation: 'table', width: 'half' }),
        fields(['service_contract', 'gap'], { title: 'Products', presentation: 'table', width: 'half' }),
        fields(['cash_down', 'amount_financed', 'term_months', 'apr'], { title: 'Amount financed', presentation: 'table', columns: 2 }),
        related('Payment grid', 'deal_scenario', 'deal_id', {
          show: ['label', 'term_months', 'monthly_payment', 'selected'],
          sort: 'label',
        }),
        related('Trade-ins', 'trade_in', 'deal_id', {
          show: ['year', 'make', 'model', 'allowance'],
          empty: { title: 'No trade', description: 'Add one with "Add trade-in" while the deal is on the desk.' },
        }),
        related('Application', 'loan_application', 'deal_id', {
          show: ['reference', 'requested_amount', 'status'],
          empty: { title: 'Not submitted', description: 'Submit to Keystone once the customer has chosen a structure.' },
        }),
        fields(['lead_id.first_name', 'lead_id.last_name', 'lead_id.phone', 'lead_id.email'], { title: 'Customer', region: 'aside' }),
        fields(['vehicle_id.model', 'vehicle_id.trim', 'vehicle_id.stock_number', 'vehicle_id.mileage', 'vehicle_id.list_price'], {
          title: 'Vehicle',
          region: 'aside',
        }),
        fields(['salesperson_id.name', 'finance_manager_id.name', 'co_applicant_id.last_name', 'created_on'], {
          title: 'Deal',
          region: 'aside',
        }),
        history(),
      ],
      { listTabs: true },
    ),
  },
} satisfies Feature);
