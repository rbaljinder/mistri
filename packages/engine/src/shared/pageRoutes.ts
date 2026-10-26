/**
 * A free-form page's two words on the wire, said by the client that sends
 * them and the server that reads them (server/http/pageLoad.ts). Apart from
 * the SDK's module lists so the shell's first chunk carries only these.
 */

/** Where a page's loader is run for the reader: `POST { page, params }`. */
export const PAGE_LOAD_PATH = '/api/pages/load';
/** The header a page's own requests carry: its path. */
export const PAGE_HEADER = 'x-mistri-page';
