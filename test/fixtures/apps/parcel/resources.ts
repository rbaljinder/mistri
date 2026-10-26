import type { Resources } from './mistri-schema.d.ts';

/* How Parcel's two resources read, wherever they appear. Both are the API's
   and read-only, because the connection is; nothing here asks otherwise. */
export const resources = {
  shipments: {
    segments: {
      on_the_way: 'status = in_transit',
      out_for_delivery: 'status = out_for_delivery',
      held: 'status = exception',
      delivered: 'status = delivered',
    },
    noun: 'shipment',
    labels: {
      carrier_id: 'Carrier',
      weight_lb: 'Weight (lb)',
      eta: 'Estimated delivery',
      shipped_at: 'Shipped',
      delivered_at: 'Delivered',
      exception_reason: 'Held because',
      origin_city: 'From',
      origin_state: 'From state',
      destination_city: 'To',
      destination_state: 'To state',
    },
    display: {
      status: {
        tone: {
          label_created: 'neutral',
          in_transit: 'info',
          out_for_delivery: 'warn',
          delivered: 'good',
          exception: 'bad',
        },
      },
      declared_value: { format: 'money' },
      // "Tomorrow", "in 3 days": when a package is due, said from today.
      eta: { format: 'relative' },
    },
  },
  carriers: {
    noun: 'carrier',
    labels: { on_time_rate: 'On time' },
    display: { on_time_rate: { format: 'percent', bar: true } },
  },
} satisfies Resources;
