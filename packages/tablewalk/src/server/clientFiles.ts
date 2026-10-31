/**
 * The database browser's page: the kit's, built by config/vite.tablewalk.config.ts into this package's dist/client, with
 * the App framework's main left out. From source the built folder is this package's dist/client beside src/; built, it is the
 * dist/client beside this module's dist/server.
 */
import { fileURLToPath } from 'node:url';
import { clientFiles } from '@mistriwork/kit/clientFiles.js';

const FROM_SOURCE = import.meta.url.endsWith('.ts');

export const CLIENT_FILES = clientFiles(fileURLToPath(new URL(FROM_SOURCE ? '../../dist/client/' : '../client/', import.meta.url)));
