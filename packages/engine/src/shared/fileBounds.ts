/**
 * The most bytes one uploaded file may be, whatever a resource says: an App's
 * `file` block may ask for less, never more (appModel.ts), and the server
 * sizes the one request body allowed past its usual bound from it (server
 * http/reply.ts FILE_UPLOAD_BODY). Uploads cross as base64 inside JSON.
 */
export const FILE_MAX_BYTES_CEILING = 25 * 1024 * 1024;

/** An upload's cap when the resource does not say. */
export const FILE_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
