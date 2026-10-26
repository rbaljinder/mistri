// Private deployment policy: which rows each reader reaches. Never import
// this module into the browser App (`--policy test/fixtures/apps/forecourt-market/policy.ts`).
import { defineAppRowPolicy } from '@mistriwork/mistri/policy';

const DESK = ['staff', 'admin'];

export default defineAppRowPolicy({
  appId: 'forecourt',
  resolveRows(principal) {
    const desk = principal.roles.some((role) => DESK.includes(role));
    // The account comes only from the verified session.
    const mine = { column: 'account_id', op: '=', value: principal.id } as const;
    return {
      vehicle: true,
      vehicle_photo: true,
      dealer: true,
      site_image: true,
      // A buyer reads their own inquiries and their thread, never the desk's notes about them.
      inquiry: desk ? true : { groups: [[mine]] },
      inquiry_message: desk ? true : { groups: [[mine, { column: 'kind', op: '!=', value: 'note' }]] },
      // Nobody, the desk included, sees somebody else's saved cars.
      saved_vehicle: { groups: [[mine]] },
    };
  },
  /* Every command's result, said as the records it names: only an account
     inquiry returns one, the inquiry it made. */
  resultReferences: {
    saveVehicle: () => [],
    removeSavedVehicle: () => [],
    replyToBuyer: () => [],
    addNote: () => [],
    logCall: () => [],
    bookTestDrive: () => [],
    recordOffer: () => [],
    markSold: () => [],
    markLost: () => [],
    assignInquiry: () => [],
    sendVehicleInquiry: (result) => [{ table: 'inquiry', key: { id: (result as { inquiryId: string }).inquiryId } }],
  },
  publicForms: {
    inquire: {
      // The form's fixed inbox writes an inquiry and its first message, and reads the car it names; it grants no reads back.
      rows: { inquiry: true, inquiry_message: true, vehicle: true },
      resultReferences: () => [],
    },
  },
});
