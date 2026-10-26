/** What JsonView says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  raw: 'Raw',
  rawJson: 'Raw JSON',
  copied: 'Copied',
  copyRefused: 'Copy refused',
  copy: 'Copy',
  copiedTheJson: 'Copied the JSON.',
  notShown: '{total} not shown',
  showMore: 'Show {next} more',
  moreFolded: '+{count} more',
  anEmptyString: 'An empty string',
});
