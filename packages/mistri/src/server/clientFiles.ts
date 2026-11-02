/**
 * The App framework's page: the kit's, built by config/vite.mistri.config.ts into this package's dist/client with
 * this product's main. From source the built folder is this package's dist/client beside src/; built, it is the
 * dist/client beside this module's dist/server. The workspace whose vite.config.ts serves the page from source is the
 * repository's root, four folders up from either.
 */
import { fileURLToPath } from 'node:url';
import { clientFiles } from '@mistriwork/kit/clientFiles.js';

const FROM_SOURCE = import.meta.url.endsWith('.ts');

export const CLIENT_FILES = clientFiles({
  built: fileURLToPath(new URL(FROM_SOURCE ? '../../dist/client/' : '../client/', import.meta.url)),
  workspace: fileURLToPath(new URL('../../../../', import.meta.url)),
});
