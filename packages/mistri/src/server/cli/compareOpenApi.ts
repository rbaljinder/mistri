/** Local committed-preview comparison only; no hosts or generic OpenAPI proof. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { compareApiReadSpecs } from '../api/apiReadSpecCompare.js';

const MAX_BYTES = 1_048_576;
class ComparisonFileError extends Error {}
const fail = (which: string, reason: string): never => {
  throw new ComparisonFileError(`OpenAPI comparison: ${which} ${reason}.`);
};

async function readDocument(path: string, which: 'previous' | 'current'): Promise<unknown> {
  if (
    typeof path !== 'string' ||
    !path.length ||
    path.includes('\0') ||
    (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
  ) {
    return fail(which, 'must be a local regular-file path, not a URL');
  }
  if (![constants.O_NOFOLLOW, constants.O_NONBLOCK].every((flag) => typeof flag === 'number' && Number.isInteger(flag) && flag !== 0)) {
    return fail(which, 'file comparison is unsupported on this platform; safe no-follow and nonblocking file opens are required');
  }
  // NOFOLLOW refuses a final symlink; NONBLOCK prevents a FIFO open from
  // waiting for a writer before fstat can reject it. All reads use this fd.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() =>
    fail(which, 'file could not be opened; check that it exists, is readable and is not a symlink'),
  );
  let data: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile()) return fail(which, 'must be a regular file');
    if (before.size > MAX_BYTES) return fail(which, 'file exceeds the 1 MiB limit');
    // One extra byte detects growth beyond the cap without unbounded readFile.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) return fail(which, 'file exceeds the 1 MiB limit');
    const after = await handle.stat();
    if (after.size !== before.size || length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      return fail(which, 'file changed while reading; retry with a stable file');
    }
    data = buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof ComparisonFileError) throw error;
    return fail(which, 'file could not be read; retry with a stable readable file');
  } finally {
    await handle.close().catch(() => fail(which, 'file could not be closed'));
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return fail(which, 'file must contain valid UTF-8 JSON');
  }
}

export async function compareOpenApiFiles(previous: string, current: string) {
  const before = await readDocument(previous, 'previous');
  const after = await readDocument(current, 'current');
  try {
    return compareApiReadSpecs(before, after);
  } catch {
    return fail('files', 'must contain supported mistri private read previews without remote references');
  }
}
