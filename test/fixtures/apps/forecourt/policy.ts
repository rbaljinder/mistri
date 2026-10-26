// Private deployment policy. Never import this module into the browser App.
import { defineAppRowPolicy } from '@mistriwork/mistri/policy';

export default defineAppRowPolicy({
  appId: 'forecourt',
  resolveRows(principal) {
    const staff = principal.roles.some((role) => role === 'staff' || role === 'admin');
    return {
      vehicle: true,
      vehicle_photo: true,
      dealer: true,
      site_image: true,
      inquiry: staff ? true : { groups: [[{ column: 'account_id', op: '=', value: principal.id }]] },
      inquiry_activity: staff,
      // Staff accounts have their own shortlist too; no role sees somebody
      // else's saved vehicles. The account comes only from the verified session.
      saved_vehicle: { groups: [[{ column: 'account_id', op: '=', value: principal.id }]] },
    };
  },
  resultReferences: {
    recordInquiryReply: () => [],
    closeInquiry: () => [],
    saveVehicle: () => [],
    removeSavedVehicle: () => [],
    sendVehicleInquiry: (result) => [{ table: 'inquiry', key: { id: (result as { inquiryId: string | number }).inquiryId } }],
  },
  publicForms: {
    inquire: {
      // This fixed inbox permits inserts only. It grants no browser reads of
      // inquiries, and signed-in visitors still submit as public:inquire.
      rows: { inquiry: true, vehicle: true },
      resultReferences: () => [],
    },
  },
});
