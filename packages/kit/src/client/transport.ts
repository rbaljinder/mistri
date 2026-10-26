/**
 * How the client reaches its server: one request, to a server path
 * (`/api/…`), sent where this page's server answers it (addressMount.js
 * `served`).
 *
 * Every API call the shell makes goes through here rather than `fetch`
 * directly, so that where the server is, and how a request proves who sent
 * it, is decided in one place. Served, that is the page's own origin with
 * its cookie, which is what `fetch` does without being told.
 */
import { served } from './addressMount.js';

/** A request to a server path. `fetch` is read when called, so a test's stub of it still answers. */
export const fetchServer = (path: string, init?: RequestInit): Promise<Response> => fetch(served(path), init);
