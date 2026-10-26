// Forecourt's commands, beside its manifest: the App names each by its key
// and never imports this module (`--commands test/fixtures/apps/forecourt-market/commands.ts`).
import { defineCommands } from '@mistriwork/mistri/commands';
import { addNote, assignInquiry, bookTestDrive, logCall, markLost, markSold, recordOffer, replyToBuyer } from './desk-commands.ts';
import { inquireAboutVehicle, sendVehicleInquiry } from './inquiry-commands.ts';
import { removeSavedVehicle, saveVehicle } from './shortlist-commands.ts';

export default defineCommands({
  // Public: reachable only through the inquiry form, under a public principal.
  inquireAboutVehicle,
  // A signed-in buyer's own.
  sendVehicleInquiry,
  saveVehicle,
  removeSavedVehicle,
  // The desk's.
  replyToBuyer,
  addNote,
  logCall,
  bookTestDrive,
  recordOffer,
  markSold,
  markLost,
  assignInquiry,
});
