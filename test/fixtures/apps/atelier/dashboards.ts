import { activity, breakdown, chart, dashboard, embed, metric, rows } from '@mistriwork/mistri/app';

/* Two desks. Today is where a shift starts: orders to confirm and to pack,
   payments to chase, returns to handle, the fulfillment pipeline and what is
   running short. Sales is the owner's: money in, by week, by product and by
   channel, and what went back out as refunds. */

const LIVE = 'status != cancelled';
const TO_PACK = 'status = pending and sales_order_id.status = confirmed and sales_order_id.financial_status = paid';

export const today = dashboard(
  'Today',
  [
    metric('To confirm', 'sales_order', { query: 'status = open', to: 'orders', icon: 'circle-dashed' }),
    metric('Awaiting payment', 'sales_order', { query: `financial_status = pending and ${LIVE}`, to: 'orders', icon: 'hourglass' }),
    metric('To pack', 'fulfillment', { query: TO_PACK, to: 'fulfillment', icon: 'package' }),
    metric('Returns to handle', 'order_return', {
      query: 'status = requested or status = approved or status = received',
      to: 'returns',
      icon: 'arrow-circle-up',
    }),
    // The pipeline as one flow, a card per step in the fulfillment machine's order.
    breakdown('Fulfillment', 'fulfillment', 'status', {
      query: 'status = pending or status = packed or status = shipped or (status = delivered and delivered_at = last 7 days)',
      shape: 'steps',
      notes: {
        pending: 'Waiting to be picked and packed',
        packed: 'Boxed, waiting for the carrier',
        shipped: 'With the carrier',
        delivered: 'Delivered this week',
      },
      icon: 'package',
    }),
    embed('orders', { title: 'Open orders', tab: 'open_orders', limit: 8, icon: 'receipt' }),
    chart('Orders by day', 'sales_order', 'day placed_at', {
      query: `placed_at = last 14 days and ${LIVE}`,
      over: 'placed_at',
      windows: ['last 14 days', 'last 30 days', 'last 90 days'],
      limit: 91,
      height: 200,
      shape: 'bar',
      icon: 'chart-bar',
    }),
    breakdown('Orders by state', 'sales_order', 'status', { query: 'placed_at = last 30 days', width: 'half', icon: 'chart-pie' }),
    breakdown('Orders by channel', 'sales_order', 'channel', {
      query: `placed_at = last 30 days and ${LIVE}`,
      width: 'half',
      icon: 'storefront',
    }),
  ],
  {
    icon: 'house',
    heading: 'Good to see you, {me.name}',
    description: 'Orders to confirm and pack, payments to chase, returns to handle and what is running short.',
    aside: [
      embed('low-stock', { title: 'Low stock', limit: 8, icon: 'warning' }),
      activity(
        'Latest updates',
        {
          sales_order: { icon: 'receipt' },
          fulfillment: { icon: 'package' },
          order_return: { icon: 'arrow-circle-up' },
          payment: { icon: 'credit-card' },
        },
        { limit: 6, icon: 'clock' },
      ),
    ],
  },
);

export const sales = dashboard(
  'Sales',
  [
    metric('Sales, last 30 days', 'sales_order', {
      query: `placed_at = last 30 days and ${LIVE}`,
      measure: 'sum total_amount',
      compare: 'previous period',
      better: 'up',
      spark: true,
      over: 'placed_at',
      width: 'third',
      icon: 'currency-dollar',
    }),
    metric('Orders, last 30 days', 'sales_order', {
      query: `placed_at = last 30 days and ${LIVE}`,
      compare: 'previous period',
      better: 'up',
      width: 'third',
      icon: 'receipt',
    }),
    metric('Average order', 'sales_order', {
      query: `placed_at = last 30 days and ${LIVE}`,
      measure: 'avg total_amount',
      compare: 'previous period',
      better: 'up',
      width: 'third',
      icon: 'gauge',
    }),
    chart('Sales by week', 'sales_order', 'week placed_at', {
      query: `placed_at = last 6 months and ${LIVE}`,
      measure: 'sum total_amount',
      shape: 'bar',
      height: 220,
      icon: 'chart-bar',
    }),
    breakdown('Top products, last 90 days', 'order_line', 'variant_id.product_id.title', {
      query: 'sold_last_90_days',
      measure: 'sum line_amount',
      limit: 10,
      to: false,
      width: 'half',
      icon: 'tag',
    }),
    breakdown('Sales by category, last 90 days', 'order_line', 'variant_id.product_id.category', {
      query: 'sold_last_90_days',
      measure: 'sum line_amount',
      to: false,
      width: 'half',
      icon: 'chart-pie',
    }),
    breakdown('Sales by channel, last 90 days', 'sales_order', 'channel', {
      query: `placed_at = last 90 days and ${LIVE}`,
      measure: 'sum total_amount',
      width: 'half',
      icon: 'storefront',
    }),
    breakdown('Discount codes, last 90 days', 'sales_order', 'discount_code', {
      query: `placed_at = last 90 days and ${LIVE} and discount_code is not empty`,
      measure: 'sum discount_amount',
      width: 'half',
      icon: 'ticket',
    }),
    chart('Refunds by month', 'refund', 'month refunded_at', {
      query: 'refunded_at = last 6 months',
      measure: 'sum refund_amount',
      shape: 'bar',
      width: 'half',
      icon: 'arrow-circle-up',
    }),
    breakdown('Return reasons, last 90 days', 'order_return', 'reason', {
      query: 'requested_on = last 90 days',
      width: 'half',
      icon: 'chat-circle',
    }),
    rows('Best customers', 'customer', {
      query: 'spent > 0',
      show: ['name', 'orders', 'spent'],
      sort: 'spent desc',
      limit: 8,
      icon: 'users',
    }),
  ],
  {
    icon: 'chart-line',
    description: 'Money in by week, product, category and channel; what the discounts gave and what came back.',
  },
);
