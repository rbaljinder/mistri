/** What the dev observer's badge says in a page, in the observer's room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  // The slowest interaction, for the INP report: "click on button.save".
  inpSource: '{type} on {node}',
  observer: 'Observer',
  theDevObserver: "The dev observer: this server's requests, statements and logs",
  openInObserver: 'Open in observer',
  unhandledRejection: 'Unhandled rejection: {reason}',
});
