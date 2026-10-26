// Ignition's commands, beside its manifest: the App names each by its key here
// and never imports this module.
//
// Every command Ignition registers, in one place, and nothing else: the
// dealership's four, the lender's six, the public form's six, and the review
// clock's. There is no private identity file to load any more — the old
// IGNITION_STAFF_MAP is gone, and a platform command finds its author through
// `lender_staff.account_id`, which is the lender's own record — so registration
// takes no environment at all.
import { defineCommands } from '@mistriwork/mistri/commands';
import { financingCommands } from './financing.ts';
import { leadCommands } from './leads.ts';
import { platformCommands } from './platform.ts';
import { flagOverdueReview } from './review.ts';

export default defineCommands({
  // The dealership's, in its own tenant: qualifyLead, disqualifyLead,
  // convertLead, withdrawApplication.
  ...leadCommands,
  // The lender's, across dealerships: assignReviewer, recordReview,
  // recordDecision, reviseApplication, rotateIntakeAddress,
  // closeIntakeSubmission.
  ...platformCommands,
  // Public: reachable only through the App's public form, under a public
  // principal, and placed by the intake address the link carries — its five
  // steps (startFinancing, saveFinancingAddress, saveFinancingIncome,
  // saveFinancingLoan, saveFinancingCoApplicants) and its submit,
  // applyForFinancing.
  ...financingCommands,
  // The review clock's, run by the reviewDue job as its service principal.
  flagOverdueReview,
});
