/**
 * The client as the database browser's: the entry and the Workbench's chunk, with the App framework's main stood in for (vite.config.ts,
 * `withoutOtherMain`), into packages/tablewalk/dist/client.
 */
import { defineConfig } from 'vite';
import { clientConfig } from '../vite.config.js';

export default defineConfig(clientConfig('tablewalk'));
