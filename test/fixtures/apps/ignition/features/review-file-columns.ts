/** Shared reviewer-file columns used by the lender desk and staff record views. */
export const reviewFileColumns = {
  application: 'application_id.reference',
  dealer: 'dealer_id.name',
  reviewer: 'reviewer_id.name',
  deadline: 'review_due_on',
} as const;
