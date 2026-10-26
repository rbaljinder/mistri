// Explicit --commands entry. Never import this module from the App graph.
//
// Every command Keystone Desk registers: the lead's five and the desk's five,
// the application's two (all tenant realm), the public apply form's five, and
// the decision clock's one (platform realm, run only by its job).
import { defineCommands } from '@mistriwork/mistri/commands';
import { applicationCommands } from './applications.ts';
import { applyCommands } from './apply.ts';
import { flagLateDecision } from './clock.ts';
import { deskCommands } from './desk.ts';
import { leadCommands } from './leads.ts';

export default defineCommands({
  ...leadCommands,
  ...deskCommands,
  ...applicationCommands,
  ...applyCommands,
  flagLateDecision,
});
