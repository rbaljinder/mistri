// Private deployment policy. Never import this module into the browser App.
import { defineAppRowPolicy } from '@mistriwork/mistri/policy';

/* The catalog is everyone's; what a person sent is theirs. The account comes
   only from the verified session (principal.id), never from a request. */
export default defineAppRowPolicy({
  appId: 'marketplace',
  resolveRows(principal) {
    const own = (column: string) => ({ groups: [[{ column, op: '=' as const, value: principal.id }]] });
    const desk = principal.roles.includes('marketplace_admin');
    return {
      vehicle: true,
      vehicle_photo: true,
      dealer: true,
      program: true,
      // The desk has its own shortlist too; nobody reads another account's.
      saved_vehicle: own('account_id'),
      // The desk reads every rate check, to send the matched ones on.
      prequalification: desk ? true : own('account_id'),
      // A customer follows their own inquiries; the desk sees what the marketplace sent dealers.
      lead: desk ? { groups: [[{ column: 'source', op: '=' as const, value: 'marketplace' }]] } : own('marketplace_account_id'),
      lead_activity: false,
    };
  },
  resultReferences: {
    saveVehicle: () => [],
    removeSavedVehicle: () => [],
    sendToDealer: () => [],
    sendInquiry: (result) => [{ table: 'lead', key: { id: (result as { leadId: string }).leadId } }],
    checkRate: (result) => [{ table: 'prequalification', key: { id: (result as { prequalificationId: string }).prequalificationId } }],
  },
  publicForms: {
    // Each form may insert its one request and read the cars and rates it is placed by; it grants no reads back.
    prequalify: { rows: { prequalification: true, vehicle: true, dealer: true, program: true }, resultReferences: () => [] },
    inquire: { rows: { lead: true, lead_activity: true, vehicle: true, dealer: true }, resultReferences: () => [] },
  },
});
