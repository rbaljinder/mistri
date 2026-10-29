/**
 * `node --import tsx --import test/support/capacityPreload.ts <the CLI> ...`:
 * the capacity harness's control port inside an App served by the ordinary
 * CLI, for an App that is not in this repository (`--app` on the harness).
 * Loaded before the CLI so its diagnostics-channel counter sees the first
 * request; it answers `/ready` at once, and the harness waits on the App's
 * own `/readyz` for the rest.
 *
 * Environment: CAPACITY_CONTROL_PORT, CAPACITY_OUT (where profiles are written).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCapacityControl } from './capacityProbe.js';

const port = Number(process.env.CAPACITY_CONTROL_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('CAPACITY_CONTROL_PORT is required');
await openCapacityControl({ port, out: process.env.CAPACITY_OUT ?? join(tmpdir(), 'capacity'), ready: () => ({ pid: process.pid }) });
