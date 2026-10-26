/*
 * Command desk: the browser gate's own App for the framework behaviour three
 * specs check — a command run from a record's action bar, the same command
 * under a row policy, and a run of related lists drawn as tabs. It is owned by
 * the test suite rather than by examples/, because a public sample being
 * reshaped must not be able to take the gate down with it; that is exactly
 * what happened when these specs borrowed Ignition's seed.
 *
 * It is therefore sized to those three specs and nothing more: one desk of
 * reviewers, one application to assign, one application with documents,
 * reviews and no decisions. Do not grow it to demonstrate a feature; author a
 * fixture beside it, or a public sample under examples/.
 */
import { action, defineApp, fields, listView, page, related } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

export default defineApp({
  id: 'command-desk',
  name: 'Command desk',
  track: 'receipts',
  sources: { reviews: { connection: 'reviews' } },
  /* The ceiling, not a grant: `write` is what the one command may write, and
     no role holds generic write, so Save, New and Delete stay off and the
     specs' `crud === 0` is a property of the App rather than of the UI. */
  resources: {
    review_team: {},
    reviewer: {},
    loan_application: {
      noun: 'application',
      access: 'write',
      display: { status: { tone: { submitted: 'neutral', in_review: 'info', decided: 'good' } } },
      // Offered wherever an application's record is drawn, which for this
      // fixture is the one record page.
      actions: { assignReviewer: action('Assign reviewer', { command: 'assignReviewer' }) },
    },
    application_document: {},
    application_review: {},
    loan_decision: {},
    assignment_history: { access: 'write' },
  },
  /* The fixture's server overrides providers, sign-up, the default role and
     the session store so each run is disposable; the role grants below are
     what it spreads and keeps. A viewer exists so that holding the command is
     visibly a grant rather than a consequence of signing in. */
  auth: {
    providers: ['email'],
    defaultRole: 'viewer',
    roles: {
      viewer: { read: true, write: false },
      manager: { read: true, write: false, commands: ['assignReviewer'] },
    },
  },
  views: {
    applications: listView('Applications', 'loan_application', {
      show: ['reference', 'status', 'team_id', 'reviewer_id.name'],
    }),
  },
  pages: {
    application: page(
      'loan_application',
      [
        fields(['reference', 'status', 'team_id', 'reviewer_id'], { columns: 2 }),
        /* Three related lists in a row, which `listTabs` draws as a tab strip:
         one populated, one shorter, one that stays empty. The empty tab's four
         columns are the point of the geometry assertions — a tab that loses
         its header row while loading moves everything under it. */
        related('Documents', 'application_document', 'application_id', { show: ['name', 'status', 'received_on'] }),
        related('Reviews', 'application_review', 'application_id', { show: ['name', 'reviewer_id.name', 'status', 'opened_on'] }),
        related('Decisions', 'loan_decision', 'application_id', { show: ['outcome', 'decided_by.name', 'recorded_on', 'record_note'] }),
      ],
      { listTabs: true },
    ),
  },
  home: 'applications',
  nav: ['applications'],
  ui: { currency: 'USD', locale: 'en-US', export: false },
} satisfies App);
