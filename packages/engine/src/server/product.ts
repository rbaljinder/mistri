/**
 * Which product this process is: the database browser (`tablewalk`) or the App framework (`mistri`). The engine is
 * both binaries', and what an operator sets is said in the binary's own name: `TABLEWALK_READ_POOL` for the
 * browser, `MISTRI_READ_POOL` for an App, read by the same code here. Each main says which it is before it reads a
 * flag (packages/tablewalk/src/server/cli/browserMain.ts, packages/mistri/src/server/cli/mistriMain.ts); anything
 * else that runs the engine — an App mounted in a host's server (`createHandler`), a test — is an App's.
 *
 * Only the variables both binaries read go through here. A variable one product alone reads names itself.
 */
type ProductName = 'tablewalk' | 'mistri';

let current: ProductName = 'mistri';

/** Say which product this process is. A main calls it first. */
export function setProduct(name: ProductName): void {
  current = name;
}

export const product = (): ProductName => current;

/** The config file a project keeps beside it: `mistri.json` for an App, `tablewalk.json` for the browser. */
export const configFileName = (): string => `${current}.json`;

/** The variable an operator sets for `key` (`READ_POOL` → `MISTRI_READ_POOL`), in this product's name. */
export const envName = (key: string): string => `${current.toUpperCase()}_${key}`;

/** What the environment holds for `key`, read in this product's name. */
export const productEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[envName(key)];
