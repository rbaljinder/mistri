// Explicit --commands entry. Never import this module from the App graph.
import { defineCommands } from '@mistriwork/mistri/commands';
import { checkRate, removeSavedVehicle, saveVehicle, sendInquiry } from './server/account.ts';
import { sendToDealer } from './server/desk.ts';
import { inquire, prequalify } from './server/public-forms.ts';

export default defineCommands({
  // Public: reachable only through the two forms, under a public principal.
  prequalify,
  inquire,
  // A customer's own.
  saveVehicle,
  removeSavedVehicle,
  sendInquiry,
  checkRate,
  // Keystone's marketing desk.
  sendToDealer,
});
