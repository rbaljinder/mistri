/** The SQLite seed's exports, typed for the App's tests (examples/apps/lintel/tests/start.ts). */
export declare const APP: string;
export declare function lintelConfig(url: string, mailLog: string): Record<string, unknown>;
export declare function provisionStores(config: string): void;
/** Seeds a new database file and writes `<file>.json` beside it; returns the file's absolute path. */
export declare function seed(file: string, options?: { today?: string; photos?: boolean; stores?: boolean }): string;
