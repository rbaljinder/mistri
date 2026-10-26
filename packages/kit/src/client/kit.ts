/**
 * `@mistriwork/kit`, as the tree has it (scripts/boundary/entries.json): the kit's shell API, which each product's
 * main fills (shells.ts), and the UI tokens a component may name (shared/uiTokens.ts). The shell itself (app.js) is
 * started by the page's entry, not imported, so it is not a name here.
 */
export type { KitShell, ShellChrome, ShellMain, ShellProduct, ShellTools } from './shells.js';
export { UI_TOKENS, nearestToken } from '../shared/uiTokens.js';
