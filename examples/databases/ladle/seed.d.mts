/** The SQLite seed's exports, typed for the App's tests (examples/apps/ladle/tests/schedule.test.ts). */
export declare const APP: string;
export declare function provisionStores(config: string): void;
/** Seeds a new database file and writes `<file>.json` beside it; returns the file's absolute path. */
export declare function seed(file: string, options?: { today?: string; stores?: boolean }): string;
