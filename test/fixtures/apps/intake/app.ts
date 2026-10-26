/*
 * Intake: the browser gate's own App for the intake style of a command form —
 * a public form of five steps (email and its confirmation, a row of names with
 * a date of birth, a choice and several in icon cards, a yes or no as two
 * buttons that a question on each answer waits on, a consent) ending in an
 * editable review, and a signed-in form in the stepper style beside it. Sized to
 * e2e/intake-form.spec.ts; the names are invented.
 */
import { commandForm, defineApp, listView, step } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'intake',
  name: 'Fernhollow Credit Union',
  sources: { members: { connection: 'members' } },
  /* The ceiling the commands write under, not a grant: no role holds generic write. */
  resources: { application: { access: 'write' } },
  auth: {
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'applicant',
    roles: {
      officer: { read: true, write: false, commands: ['addApplication'] },
      applicant: { read: [], write: false },
    },
  },
  views: {
    applications: listView('Applications', 'application'),
    apply: commandForm(
      'Open an account',
      'submitApplication',
      [
        step('Email', ['email', 'confirm_email'], { title: "Let's start with your email.", lead: 'We write only about this application.' }),
        step('Name', [['first_name', 'last_name'], 'date_of_birth', 'ssn'], {
          title: "What's your name?",
          lead: 'As it appears on your ID.',
        }),
        step('Account', ['account_type', 'extras'], { title: 'What would you like to open?', next: 'Almost there' }),
        step('Joint', ['joint', 'nickname', 'alone'], { title: 'Is anyone applying with you?', skip: 'Skip' }),
        step('Consent', ['consent'], { title: 'One last step' }),
      ],
      {
        public: true,
        style: 'intake',
        description: 'It takes about five minutes.',
        note: { icon: 'shield-check', text: 'Your information is stored securely' },
        submitLabel: 'Submit',
        done: { title: 'Your request is in', description: 'Keep this reference.' },
      },
    ),
    'add-application': commandForm(
      'Add an application',
      'addApplication',
      [step('Applicant', ['first_name', 'last_name']), step('Contact', ['email'])],
      { done: { title: 'Added' } },
    ),
  },
  home: 'applications',
  nav: ['applications', 'add-application'],
});
