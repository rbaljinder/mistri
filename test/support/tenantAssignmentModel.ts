/** Private synthetic assignment proof; no tenant or actor authority in these IDs. */
export const tenantAssignmentModel = Object.freeze({
  appId: 'tenant-ignition-assignment',
  appName: 'Ignition · Tenant assignments',
  staff: 'review_staff',
  application: 'loan_application',
  history: 'assignment_history',
  command: 'assignReviewer',
  action: 'Assign reviewer',
});
export const tenantAssignmentRows = Object.freeze({
  north: Object.freeze({
    application: 'northstar-application',
    otherApplication: 'northstar-other-application',
    closedApplication: 'northstar-closed-application',
    assignedApplication: 'northstar-assigned-application',
    staleApplication: 'northstar-stale-application',
    mismatchedLeadApplication: 'northstar-mismatched-lead-application',
    manager: 'northstar-manager',
    reviewer: 'northstar-reviewer',
    alternateReviewer: 'northstar-reviewer-alt',
    otherReviewer: 'northstar-other-reviewer',
    inactiveReviewer: 'northstar-inactive-reviewer',
    wrongRole: 'northstar-wrong-role',
  }),
  south: Object.freeze({
    application: 'riverview-application',
    manager: 'riverview-manager',
    reviewer: 'riverview-reviewer',
    alternateReviewer: 'riverview-reviewer-alt',
    inactiveReviewer: 'riverview-inactive-reviewer',
    wrongRole: 'riverview-wrong-role',
  }),
});
