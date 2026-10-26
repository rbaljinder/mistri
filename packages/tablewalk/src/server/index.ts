#!/usr/bin/env node
/**
 * The `tablewalk` binary: the database browser, and nothing else (cli/browserMain.ts). An App is `mistri`'s, a
 * binary of its own, and this one refuses an App's start by that name.
 *
 * The server is deliberately not a general database proxy. Every endpoint maps to one thing the browser needs, takes
 * a structured request rather than SQL, and hands the adapter a shape that cannot express a write. That constraint
 * is what makes it safe to point at a database you care about.
 */
import { runBin } from '@mistriwork/engine/server/cli/bin.js';

runBin(import.meta.url, () => import('./cli/browserMain.js'));
