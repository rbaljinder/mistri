import type { Server } from 'node:http';
/** The carrier stub's shipments, as it serves them. */
export declare const SHIPMENTS: Array<Record<string, string | null>>;
/** The stub, not yet listening: `listen(0, '127.0.0.1')` for a free port (examples/apps/lintel/tests). */
export declare function createCarrier(): Server;
