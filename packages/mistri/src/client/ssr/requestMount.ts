/**
 * The mount a server render is for, per request.
 *
 * In the page the mount is read once, from the page itself (addressMount.js).
 * A server renders many pages at once, possibly for several mounts, and
 * React's server renderer does its work in later turns of the event loop,
 * so the request's mount rides in Node's AsyncLocalStorage around the render
 * (render.tsx) and the server's addressMount (addressMount.server.ts) reads
 * it from there. Reached through `process.getBuiltinModule` so the client's
 * type check, which has no Node types, never sees a Node import.
 */
import { NO_MOUNT, type AddressMount } from '@mistriwork/engine/shared/mount.js';

interface Store<T> {
  run<R>(value: T, work: () => R): R;
  getStore(): T | undefined;
}

const hooks = (
  globalThis as unknown as { process?: { getBuiltinModule?: (name: string) => { AsyncLocalStorage: new <T>() => Store<T> } } }
).process?.getBuiltinModule?.('node:async_hooks');
const store: Store<AddressMount> | undefined = hooks ? new hooks.AsyncLocalStorage<AddressMount>() : undefined;

/** Run a render under one request's mount. */
export function withMount<R>(mount: AddressMount, work: () => R): R {
  return store ? store.run(mount, work) : work();
}

/** The mount of the render in progress. */
export const currentMount = (): AddressMount => store?.getStore() ?? NO_MOUNT;
