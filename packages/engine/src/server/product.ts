/**
 * Which product this process is: the database browser (`tablewalk`) or the App framework (`mistri`). The engine is
 * both binaries', and what an operator sets is said in the binary's own name: `TABLEWALK_READ_POOL` for the
 * browser, `MISTRI_READ_POOL` for an App, read by the same code here. Each main says which it is before it reads a
 * flag (packages/mistri/src/server/cli/mistriMain.ts here, the database browser's main in its own repository); anything
 * else that runs the engine — an App mounted in a host's server (`createHandler`), a test — is an App's.
 *
 * Only the variables both binaries read go through here. A variable one product alone reads names itself.
 */
type ProductName = 'tablewalk' | 'mistri';

let current: ProductName = 'mistri';
let hostVersion: string | undefined;

/**
 * Say which product this process is. A main calls it first. A host product that runs the engine from npm passes
 * its own version too: `--version`, MCP's serverInfo and telemetry (`packageVersion`) then report it, where the
 * engine's number is the framework's and moves on its own schedule. Left out, they report the engine's.
 */
export function setProduct(name: ProductName, version?: string): void {
  current = name;
  hostVersion = version;
}

/** The version the host said it is, if it said one (`setProduct`). */
export const productVersion = (): string | undefined => hostVersion;

export const product = (): ProductName => current;

/** The config file a project keeps beside it: `mistri.json` for an App, `tablewalk.json` for the browser. */
export const configFileName = (): string => `${current}.json`;

/** The variable an operator sets for `key` (`READ_POOL` → `MISTRI_READ_POOL`), in this product's name. */
export const envName = (key: string): string => `${current.toUpperCase()}_${key}`;

/** What the environment holds for `key`, read in this product's name. */
export const productEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[envName(key)];
