/** Existing resource bodies, with opaque tenant-history references instead of
 * the ordinary journal's numeric IDs. No client identity grants or envelope. */
import type {
  HttpDeletePreview,
  HttpDeleteSuccess,
  HttpHistoryPreview,
  HttpInsertSuccess,
  HttpRevertRequest,
  HttpUndoFailure,
  HttpUndoSuccess,
  HttpUpdateSuccess,
  ResourceHttpBodies,
  ResourceHttpFailure,
  ResourceHttpPath,
  ResourceHttpSuccess,
} from '@mistriwork/engine/shared/resourceHttp.js';

export type TenantHttpResourceBody<Path extends ResourceHttpPath> = Path extends '/api/revert'
  ? HttpRevertRequest<string>
  : ResourceHttpBodies[Path];
export type TenantHttpResourceSuccess<Path extends ResourceHttpPath> = Path extends '/api/update'
  ? HttpUpdateSuccess<string>
  : Path extends '/api/insert'
    ? HttpInsertSuccess<string>
    : Path extends '/api/delete'
      ? HttpDeletePreview | HttpDeleteSuccess<string>
      : Path extends '/api/revert'
        ? HttpHistoryPreview<string> | HttpUndoSuccess<string>
        : ResourceHttpSuccess<Path, 'app'>;
export type TenantHttpResourceReply<Path extends ResourceHttpPath> =
  | TenantHttpResourceSuccess<Path>
  | (Path extends '/api/revert' ? HttpUndoFailure<string> : ResourceHttpFailure<Path, 'app'>);
