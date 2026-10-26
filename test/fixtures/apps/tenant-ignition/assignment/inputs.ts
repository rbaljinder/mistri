import type { Tables } from './schema.js';

/* The one declaration of assignReviewer's input, read by its server
   registration (test/support/tenantAssignmentFixture.ts). The App names the
   command (resources.ts) and is served this input with it; importing nothing
   else, so the registration can read it without the App's module graph. */
export const assignReviewerInput = {
  reviewer: {
    label: 'Reviewer',
    type: 'reference',
    from: 'review_staff' satisfies keyof Tables,
    by: 'id' satisfies Tables['review_staff'],
    labelColumn: 'name' satisfies Tables['review_staff'],
    query: 'active = 1 and role = reviewer',
  },
  reason: { label: 'Assignment reason', type: 'textarea', max: 500 },
} as const;
