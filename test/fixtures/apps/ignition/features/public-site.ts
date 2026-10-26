import { commandForm, defineFeature, step } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';
import { ignitionLanding } from '../landing.ts';

/* The signed-out front door: the landing page and the public financing form.
   Public views are in no menu, and they carry no realm — a visitor holds no
   membership, so there is no realm for them to be in. The App's `home` sends a
   signed-out visitor here.

   The form is the one write anybody may make, and the dealership it lands in is
   not its decision: each dealership publishes the same form under its own intake
   address, `/ignition/form/finance?via=<address>`, and the server resolves that
   address. Nothing the visitor types chooses a dealership — the form does not
   even ask for a dealer code — so the answer can be, and is, identical whether
   the submission reached a dealership or the lender's triage.

   The handlers are server code (financing.ts, registered with `public: true`
   through commands.ts), never imported here. */
export const publicSite = defineFeature({
  id: 'public-site',
  views: {
    // The public front page at /ignition, signed out: content only (landing.ts).
    welcome: ignitionLanding,
    /* Served signed out at /ignition/form/finance, and saved on every step:
       each step is its own public submission, resolved from the link's intake
       address every time, and saved into the place it resolved to — a lead in
       that dealership, or the lender's triage. The applicant's place is a
       cookie whose hash the draft keeps, bound to that place, so the same
       browser under another dealership's link continues nothing. The
       reference the submit returns is the applicant's receipt, and it says
       nothing about where the application went. */
    finance: commandForm(
      'Apply for financing',
      'applyForFinancing',
      [
        step('About you', 'startFinancing'),
        step('Address', 'saveFinancingAddress'),
        step('Income', 'saveFinancingIncome'),
        step('The loan', 'saveFinancingLoan'),
        step('Co-applicant', 'saveFinancingCoApplicants'),
      ],
      {
        public: true,
        submitLabel: 'Submit application',
        resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
        draft: { status: 'draft' },
        description:
          'A demonstration form over synthetic data. Use the stock number from your dealer’s quotation; ' +
          'the dealership sees your application under the reference you are given.',
        done: {
          title: 'Application received',
          description: 'Keep this reference. The dealership will contact you at the email you gave.',
        },
      },
    ),
  },
} satisfies Feature);
