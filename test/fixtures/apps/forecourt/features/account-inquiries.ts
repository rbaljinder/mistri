import { action, defineFeature } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

export const accountInquiries = defineFeature({
  id: 'account-inquiries',
  resources: {
    vehicle: {
      segments: {
        hybrid_and_electric: 'fuel = Hybrid or fuel = Electric',
        suvs: { query: 'body_type = SUV', label: 'SUVs' },
        under_10_000: { query: 'price < 10000', label: 'Under $10,000' },
      },
      actions: { sendAccountInquiry: action('Send account inquiry', { command: 'sendVehicleInquiry' }) },
    },
  },
  auth: {
    roles: {
      shopper: { read: ['inquiry'], commands: ['sendVehicleInquiry'] },
      staff: { commands: ['sendVehicleInquiry'] },
      admin: { commands: ['sendVehicleInquiry'] },
    },
  },
} satisfies Feature);
