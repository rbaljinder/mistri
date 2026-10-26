/*
 * Saved application: the browser gate's own App for a public form saved on
 * every step (each step runs a command) — personal details, address, income and
 * co-applicants, each written to its own table as the applicant moves on,
 * then a review drawn from the page's memory and one submit. Owned by the test
 * suite, like command-desk beside it, so a sample App being reshaped cannot
 * take this proof down. Sized to its one spec (e2e/saved-form.spec.ts).
 */
import { commandForm, defineApp, listView, step } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'saved-application',
  name: 'Saved application',
  sources: { lending: { connection: 'lending' } },
  /* The ceiling the commands write under, not a grant: no role holds generic
     write, so the only writes are the form's. */
  resources: {
    application: { access: 'write' },
    applicant_address: { access: 'write' },
    income: { access: 'write' },
    co_applicant: { access: 'write' },
  },
  /* Anyone may make an account, to follow an application they submitted: the
     role a new account gets reads nothing. Officers are granted by an admin. */
  auth: {
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'applicant',
    roles: { officer: { read: true, write: false }, applicant: { read: [], write: false } },
  },
  views: {
    applications: listView('Applications', 'application'),
    apply: commandForm(
      'Apply for financing',
      'submitApplication',
      [
        step('About you', 'startApplication'),
        step('Address', 'saveAddress'),
        step('Income', 'saveIncome'),
        step('Co-applicant', 'saveCoApplicants'),
      ],
      {
        public: true,
        submitLabel: 'Submit application',
        resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
        draft: { status: 'in_progress' },
        done: { title: 'Application received', description: 'Keep this reference.' },
        statusCheck: {
          receipt: 'reference',
          confirm: { last_name: 'Last name' },
          show: ['status'],
          says: { status: { submitted: 'Received', in_review: 'In review' } },
        },
        // Added to an account on proven control: this browser straight after submitting, or a signed-in status check.
        link: {
          owner: 'account_id',
          at: 'linked_at',
          via: 'linked_via',
          sameDevice: { token: 'claim_token_hash', expires: 'claim_expires_at' },
          statusCheck: true,
        },
      },
    ),
  },
  home: 'applications',
  nav: ['applications'],
});
