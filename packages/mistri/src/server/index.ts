#!/usr/bin/env node
/**
 * The `mistri` binary: the App framework's command line (cli/mistriMain.ts) — serve an App, `dev`, `check`,
 * `build`, `migrate` and the rest. Browsing a database with no App is the database browser's, `tablewalk`, and this
 * binary refuses that start by its name.
 */
import { runBin } from '@mistriwork/engine/server/cli/bin.js';

runBin(import.meta.url, () => import('./cli/mistriMain.js'));
