/** What sdk/hooks says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  reviewNotOffered: '{label} has no record revision to review; run it as it is.',
  visitorUnavailable: 'Visitor experiments are unavailable in this component host.',
  thePageReadsIsNotOne: 'The page "{label}" reads {map}; "{resource}" is not one of them. Add it to the page\'s reads.',
  thePageReadsOptionally:
    'The page "{label}" names "{resource}" in its optionalReads: read it with `optional: true`, and draw `refused` for a reader who is not granted it.',
  thePageRunsIsNotOne:
    'The page "{label}" runs {map}; "{command}" is not one of them. Add it to the `commands` list of its definePage. Declaring grants nothing: useCommand(\'{command}\').granted then says whether this reader may run it.',
  thePageRunsActionIsNotOne: 'The page "{label}" runs {map}; "{action}" is not one of them. Add it to the page\'s actions.',
  useaddressstateKeepsAPages: "useAddressState keeps a page's place in its address; it is drawn on a free-form page (definePage).",
  thePageKeepsInItsAddress: 'The page "{label}" keeps {params} in its address; add "{name}" to its params.',
  addressView: 'the view "{view}"',
  addressRecord: 'a record under "{view}"',
  addressPage: 'the page "{path}"',
  addressHome: "the App's home",
  noAddressFor: 'The App has no address for {what}: name a view, record or page it declares.',
  assistantAbout: "useAssistant().open's about names a record by its table and its id, a string or a number.",
  assistantText: "useAssistant().open's text is the words put in the box, a string.",
  noCommands: 'no commands',
  noActions: 'no actions',
  noParameters: 'no parameters',
  thePageLoadsIsNotOne: 'The page "{label}" loads {map}; "{loader}" is not one of them. Add it to the page\'s loaders.',
  noLoaders: 'no loaders',
  useloaderOutsideAPage: "useLoader runs a free-form page's loader; it is drawn on a page (definePage).",
});
