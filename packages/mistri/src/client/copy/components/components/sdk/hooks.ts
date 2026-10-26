/** What sdk/hooks says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  visitorUnavailable: 'Visitor experiments are unavailable in this component host.',
  thePageReadsIsNotOne: 'The page "{label}" reads {map}; "{resource}" is not one of them. Add it to the page\'s reads.',
  thePageRunsIsNotOne: 'The page "{label}" runs {map}; "{command}" is not one of them. Add it to the page\'s commands.',
  useaddressstateKeepsAPages: "useAddressState keeps a page's place in its address; it is drawn on a free-form page (definePage).",
  thePageKeepsInItsAddress: 'The page "{label}" keeps {params} in its address; add "{name}" to its params.',
  noCommands: 'no commands',
  noParameters: 'no parameters',
});
