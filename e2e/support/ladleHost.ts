/**
 * The Ladle sample's host server (examples/apps/ladle/host/server.ts) as a source checkout's suite runs it: its page
 * takes `@mistriwork/mistri/react` from src/embed through the embed's own Vite plugins (config/vite.embed.config.ts), as
 * embedReactHost.ts does, so nothing is built first. Everything else is the sample's, unchanged. What
 * e2e/ladle.spec.ts walks.
 *
 * Arguments: the config file and the port.
 */
import { resolve } from 'node:path';
import { startHost } from '../../examples/apps/ladle/host/server.ts';
import { embedPlugins } from '../../config/vite.embed.config.ts';

const [config, port] = process.argv.slice(2);
const host = await startHost({
  config,
  port: Number(port),
  vite: {
    plugins: embedPlugins(),
    resolve: { alias: { '@mistriwork/mistri/react': resolve('packages/mistri/src/embed/index.tsx') }, dedupe: ['react', 'react-dom'] },
  },
});
console.log(`Host listening on ${port}`);

process.once('SIGTERM', () => void host.close().then(() => process.exit(0)));
