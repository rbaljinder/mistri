// Forecourt's commands, beside its manifest: the App names them and never imports this module.
import { defineCommands } from '@mistriwork/mistri/commands';
import { inquireAboutVehicle } from './inquiry.ts';
import { closeInquiry, recordInquiryReply } from './inquiry-workflow.ts';
import { sendVehicleInquiry } from './account-inquiry.ts';
import { removeSavedVehicle, saveVehicle } from './shortlist.ts';

export default defineCommands({
  // Public: reachable only through the App's inquiry form, under a public principal.
  inquireAboutVehicle,
  recordInquiryReply,
  closeInquiry,
  sendVehicleInquiry,
  saveVehicle,
  removeSavedVehicle,
});
