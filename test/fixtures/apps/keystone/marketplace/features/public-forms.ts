import { commandForm, defineFeature, step } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/** The two forms anyone may send. Each runs under a public principal, even
 * for a signed-in visitor, writes a request Keystone or a dealer then acts on,
 * and answers the same whatever the database holds. */
export const publicForms = defineFeature({
  id: 'public-forms',
  views: {
    prequalify: commandForm(
      'Check your rate',
      'prequalify',
      [
        step('Your budget', ['vehicle', 'credit_band', 'monthly_income', 'desired_payment', 'zip']),
        step('About you', ['first_name', 'last_name', 'email', 'phone']),
      ],
      {
        public: true,
        description:
          'Two minutes, and no credit pull: Keystone estimates what it could lend you and at what APR from what you tell us, then emails you the estimate. Keystone is a demonstration; nothing is sent.',
        submitLabel: 'Check my rate',
        done: {
          title: 'Your rate check is in',
          description: 'Keep this reference. Keystone emails your estimate, and a dealer can pick it up from here when you are ready.',
        },
        prefillable: ['vehicle'],
      },
    ),
    inquire: commandForm('Contact the dealer', 'inquire', {
      public: true,
      description:
        'Your question goes straight to the dealer that has the car. From a car’s page the form already knows which car you mean.',
      submitLabel: 'Send to the dealer',
      done: {
        title: 'Sent to the dealer',
        description:
          'Keep this reference: the dealer can find your question by it. Their team replies by email or phone, usually the same day. Keystone is a demonstration: nobody reads what is sent.',
      },
      prefillable: ['vehicle', 'message'],
    }),
  },
} satisfies Feature);
