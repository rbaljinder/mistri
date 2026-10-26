import { defineFeature, listView, navGroup, rows } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* The review clock's App half, browser-safe: where the lender reads the alerts
   it writes, and what its principal may do. The job itself is server
   configuration (jobs.ts) and its command server code (review.ts).

   An overdue review is the lender's concern, so the alert is a platform-owned
   row and the room that shows it is the platform's. That is also why the
   `automation` role is a platform-realm role: the command it grants is a
   platform command, and a service principal holding the other realm's roles is
   refused at startup. A dealership never sees these alerts — it sees its own
   application's status, which is all the lender's progress it is told. */

const show = ['application_id.reference', 'application_id.tenant_id', 'application_id.status', 'due_on', 'raised_on'] as const;

/** The manager desk's section: the oldest overdue first. */
export const overdueReviews = rows('Overdue reviews', 'review_alert', { sort: 'due_on', show, limit: 8 });

export const reviewClock = defineFeature({
  id: 'review-clock',
  /* The clock's principal holds `automation`, and `automation` holds exactly
     this: one command, and reads of exactly that command's footprint. No
     generic write, no operator read, and nothing in the other realm. */
  auth: {
    roles: {
      automation: { read: ['loan_application', 'review_file', 'review_alert'], commands: ['flagOverdueReview'] },
    },
  },
  views: {
    'overdue-reviews': listView('Overdue reviews', 'review_alert', {
      icon: 'clock',
      realm: 'platform',
      sort: 'due_on',
      show,
      filters: ['due_on', 'raised_on'],
    }),
  },
  nav: [navGroup('lender-clock', 'Review clock', ['overdue-reviews'], { realm: 'platform' })],
} satisfies Feature);
