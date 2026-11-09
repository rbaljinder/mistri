/*
 * The App this front end uses as its back end: the repository's Command desk fixture (loan applications, the
 * reviewers on two desks, and the one `assignReviewer` command), made headless. It draws no screen of its own, so its
 * only addresses are its sign-in and the API the hooks call; anyone may sign up and comes in as a manager, who may
 * run the command. Its sign-in store is a file beside the seeded database.
 */
import { fileURLToPath } from 'node:url';
import app from '../../../test/fixtures/apps/command-desk/app.ts';

export default {
  ...app,
  ui: { ...app.ui, headless: true },
  auth: {
    ...app.auth,
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'manager',
    store: fileURLToPath(new URL('../.data/sessions.db', import.meta.url)),
  },
};
