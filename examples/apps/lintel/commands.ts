// Lintel's business commands, beside its manifest: the App names each by its
// key and never imports this module (commands/ holds one module per part of
// the business).
import { defineCommands } from '@mistriwork/mistri/commands';
import { endLease, giveNotice, signLease } from './commands/leasing.ts';
import { addCharge, assessLateFees, postRent, recordPayment, settleCharge } from './commands/ledger.ts';
import {
  addNote,
  cancelRequest,
  completeRequest,
  messageOffice,
  replyToResident,
  reportIssue,
  scheduleVisit,
  assignTechnician,
} from './commands/maintenance.ts';
import { requestViewing } from './commands/viewing.ts';

export default defineCommands({
  // Public: reachable only through the viewing form, under a public principal.
  requestViewing,
  // Leasing.
  signLease,
  giveNotice,
  endLease,
  // The ledger, by people and by the jobs.
  postRent,
  assessLateFees,
  recordPayment,
  settleCharge,
  addCharge,
  // Repairs.
  reportIssue,
  scheduleVisit,
  assignTechnician,
  completeRequest,
  cancelRequest,
  replyToResident,
  addNote,
  messageOffice,
});
