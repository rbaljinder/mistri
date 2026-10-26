/**
 * The Ladle sample's host server (examples/apps/ladle/host/server.ts) as an install runs it: its page takes
 * `@mistriwork/mistri/react` by name, through the package's exports, to the BUILT library. An install's exports name dist/
 * outright; this checkout's answer from source unless asked for `mistri-built` (scripts/pack-manifest.mjs), so the
 * host's Vite is handed that condition and nothing else. Everything else is the sample's, unchanged, its plugins and
 * React from node_modules included. What e2e/embed-built.spec.ts walks.
 *
 * Arguments: the config file and the port.
 */
import { defaultClientConditions } from 'vite';
import { startHost } from '../../examples/apps/ladle/host/server.ts';

const [config, port] = process.argv.slice(2);
const host = await startHost({
  config,
  port: Number(port),
  vite: { resolve: { conditions: ['mistri-built', ...defaultClientConditions], dedupe: ['react', 'react-dom'] } },
});
console.log(`Ladle Cooking School on ${host.origin} (staff at ${host.origin}/staff)`);

process.once('SIGTERM', () => void host.close().then(() => process.exit(0)));
process.once('SIGINT', () => void host.close().then(() => process.exit(0)));
