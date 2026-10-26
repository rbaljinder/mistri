import { applyTo, callToAction, commandForm, defineFeature, faq, hero, landing, signIn, step, steps } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* The public credit application, `/leads/form/apply?via=<address>`: each
   dealer publishes the same form under its own intake address, and the server
   resolves the address on every step. What the applicant types never chooses
   a dealer, so the answer is the same whether the application landed in a
   dealer's New leads or with Keystone's triage.

   Saved on every step into real rows: the first step writes a `draft` lead
   (or a triage submission) and each later step writes beneath it. The steps
   follow what the schema can hold at once: an applicant row is written whole,
   so where they live and what they earn are one step, not two. */

export const apply = defineFeature({
  id: 'apply',
  views: {
    welcome: landing<'apply'>(
      hero(
        'The desk for Keystone dealers',
        'Work every lead, desk every deal and send it to Keystone Auto Finance from one screen. Sign in with the account your dealership invited.',
        [signIn('Sign in')],
      ),
      [
        steps('How a deal moves', [
          {
            title: 'A lead comes in',
            description: 'From your website, the Keystone marketplace, the phone or the showroom floor, into New leads.',
          },
          {
            title: 'You desk it',
            description: 'Price, trade, taxes, products and three payment structures, worked out for you as you change them.',
          },
          {
            title: 'Keystone answers',
            description: 'Submit in one step. The decision, its terms and anything Keystone needs come back to the deal.',
          },
        ]),
        faq('Questions', [
          {
            question: 'Is this a real lender?',
            answer: 'No. Keystone is a demonstration over synthetic data; no credit is offered and no bureau is asked.',
          },
          {
            question: 'I work at two dealerships.',
            answer: 'Sign in once and choose which one to work in. Each browser tab keeps its own choice.',
          },
          {
            question: 'How do customers apply?',
            answer: "Through your dealership's own apply link. Their application lands in your New leads.",
          },
        ]),
        callToAction('Applying for a car loan?', "Use the apply link on your dealer's website, so your application reaches them.", [
          applyTo('apply', 'Apply for financing'),
        ]),
      ],
      { label: 'Keystone for dealers' },
    ),
    apply: commandForm(
      'Apply for financing',
      'submitApplication',
      [
        step('About you', 'startApplication'),
        step('Home and work', 'saveApplicant'),
        step('The car', 'saveVehicle'),
        step('Co-applicant', 'saveCoApplicant'),
      ],
      {
        public: true,
        submitLabel: 'Send application',
        resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
        draft: { status: 'draft' },
        description: 'About ten minutes. Each step is saved as you go, so you can come back to it in this browser for fourteen days.',
        done: { title: 'Application received', description: 'Keep this reference. Your dealer will contact you, usually the same day.' },
      },
    ),
  },
} satisfies Feature);
