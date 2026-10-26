/**
 * The client as the App framework's: the entry, the public pages, an App's shell and a tenant's flows, with the database
 * browser's main stood in for (vite.config.ts, `withoutOtherMain`), into packages/mistri/dist/client.
 */
import { defineConfig } from 'vite';
import { clientConfig } from './vite.config.js';

export default defineConfig(clientConfig('mistri'));
