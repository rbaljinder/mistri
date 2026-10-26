/**
 * Where the request path (core.js) meets a record page's composed answers
 * (composedReads.ts) without importing them: they tell it of themselves as
 * they load, so a page that opens no record page — the public page — carries
 * none of them. Depends on nothing, so either side may load first.
 */
interface ComposedReads {
  /** The answer a compose brought for this request, once. */
  reply(path: string, body: Record<string, unknown>): Promise<unknown>;
  /** Whether a compose kept, or on its way, could answer this path. */
  may(path: string): boolean;
  /** Every answer forgotten: a write makes them the past. */
  forget(): void;
}

let reads: ComposedReads | null = null;

export function setComposedReads(given: ComposedReads): void {
  reads = given;
}

/** The composed answers, where a module that reads record pages has loaded them. */
export const composedReads = (): ComposedReads | null => reads;

/* The connection a request that names none goes to: core.js says, as it loads. */
let connection: () => string | null = () => null;

export function setComposedConnection(source: () => string | null): void {
  connection = source;
}

export const composedConnection = (): string | null => connection();
