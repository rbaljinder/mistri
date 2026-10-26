/** What sqlcomplete says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  columns: { one: '{count} column', other: '{count} columns' },
  alias: 'alias for {name}',
  notInThisStatement: '{name} · not in this statement',
});
