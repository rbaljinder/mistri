/*
 * AI proposals: the browser gate's own App for what AI proposes — the assistant
 * keeps a command for review, a person approves or dismisses it from For review,
 * and the run is theirs. Owned by the test suite; see README.md.
 */
import { action, assistant, defineApp, fields, history, listView, page } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'ai-proposals',
  name: 'AI proposals',
  track: 'receipts',
  sources: { claims: { connection: 'claims' } },
  resources: {
    claim: {
      noun: 'claim',
      access: 'write',
      actions: {
        appeal: action('Send appeal', { command: 'sendAppeal' }),
        close: action('Close claim', { command: 'closeClaim' }),
      },
    },
  },
  auth: {
    providers: ['email'],
    defaultRole: 'clerk',
    roles: { clerk: { read: true, write: false, commands: ['sendAppeal', 'closeClaim'] } },
  },
  assistant: assistant({
    instructions: 'A claims desk. The clerk asks for appeals and closures; each is kept for review.',
    placement: ['panel'],
  }),
  views: { claims: listView('Claims', 'claim', { show: ['name', 'status', 'note'] }) },
  pages: { claim: page('claim', [fields(['name', 'status', 'note'], { columns: 2 }), history()]) },
  home: 'claims',
  nav: ['claims'],
  ui: { currency: 'USD', locale: 'en-US', export: false },
});
