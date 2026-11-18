/**
 * A `multipart/form-data` body, read whole: the parts that carry a filename are files, the rest are fields. For an
 * integration's callback that brings a file beside its event (inboundHost.ts); the signature is the provider's, over
 * these same raw bytes, so nothing here decides who may send one. The body is already bounded by the host before it
 * arrives, so this only has to be strict about its own shape: anything it cannot read is undefined, never a guess.
 */

/** The most parts one body may carry: a callback's fields and files, not a form's. */
const PARTS_MOST = 64;

export interface MultipartFile {
  /** The part's `name`: the command input it is for. */
  readonly field: string;
  /** Its `filename`, as sent. */
  readonly name: string;
  /** Its own Content-Type, or '' when it names none. */
  readonly type: string;
  readonly data: Buffer;
}

interface MultipartBody {
  /** Every part without a filename, by its name (the last of a name repeated wins). */
  readonly fields: Readonly<Record<string, string>>;
  readonly files: readonly MultipartFile[];
}

/** The boundary a Content-Type names for multipart/form-data, or undefined for any other type. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (!contentType || !/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return undefined;
  const found = /;\s*boundary=(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(contentType);
  return found?.[1] ?? found?.[2];
}

/** A header parameter (`name="x"`) of a Content-Disposition line, unquoted. */
function parameter(line: string, key: string): string | undefined {
  const found = new RegExp(`[;\\s]${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s;]*))`, 'i').exec(line);
  const value = found?.[1] ?? found?.[2];
  return value === undefined ? undefined : value.replace(/\\(.)/g, '$1');
}

/** The body's parts, or undefined for a body that is not well-formed multipart under `boundary`. */
export function readMultipart(body: Buffer, boundary: string): MultipartBody | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  let at = body.indexOf(delimiter);
  if (at < 0) return undefined;
  const fields: Record<string, string> = Object.create(null);
  const files: MultipartFile[] = [];
  let count = 0;
  for (;;) {
    at += delimiter.length;
    // `--` after a delimiter closes the body; otherwise the delimiter's own line ends in CRLF.
    if (body.subarray(at, at + 2).toString('latin1') === '--') break;
    if (body.subarray(at, at + 2).toString('latin1') !== '\r\n') return undefined;
    at += 2;
    const headEnd = body.indexOf('\r\n\r\n', at);
    if (headEnd < 0) return undefined;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headEnd + 4);
    if (next < 0) return undefined;
    if (++count > PARTS_MOST) return undefined;
    const head = body.subarray(at, headEnd).toString('utf8');
    const content = body.subarray(headEnd + 4, next);
    let disposition = '';
    let type = '';
    for (const line of head.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) return undefined;
      const header = line.slice(0, colon).trim().toLowerCase();
      if (header === 'content-disposition') disposition = line.slice(colon + 1);
      else if (header === 'content-type') type = line.slice(colon + 1).trim();
    }
    const name = parameter(disposition, 'name');
    if (!name || name === '__proto__' || !/^\s*form-data\s*(;|$)/i.test(disposition)) return undefined;
    const filename = parameter(disposition, 'filename');
    if (filename === undefined) fields[name] = content.toString('utf8');
    else files.push(Object.freeze({ field: name, name: filename, type, data: Buffer.from(content) }));
    at = next + 2;
  }
  return Object.freeze({ fields: Object.freeze({ ...fields }), files: Object.freeze(files) });
}
