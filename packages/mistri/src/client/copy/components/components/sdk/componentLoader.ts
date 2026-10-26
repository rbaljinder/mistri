/** What sdk/componentLoader says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theAppServesNoComponent: 'The App serves no component "{id}".',
  theComponentHasNoDefault: 'The component "{id}" has no default export.',
});
