/** What a command's answer says when it carries a link, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  copy: 'Copy',
  withLink: '{message} {url}',
  refused: 'The browser refused clipboard access, so nothing was copied.',
});
