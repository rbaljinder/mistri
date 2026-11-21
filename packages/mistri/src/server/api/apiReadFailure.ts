/** Private read-owner failure classification. Messages deliberately contain
 * no token, account, schema, SQL or driver diagnostics. The 503 code is the
 * command transport's own `temporarily_unavailable`: one API, one word for
 * "authority was never decided, try again", whichever half answers.
 *
 * The two `chosen_*` codes are the caller's own mistake about an App's `choose` (a name the App does not declare, a key
 * the choice's table cannot hold, a text that names a choice the call did not make): answered 422 with the sentence
 * `detail` carries, which names the choice and says nothing of any row. */
export type ApiReadFailureCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'temporarily_unavailable'
  | 'chosen_invalid'
  | 'chosen_required';

export class ApiReadFailure extends Error {
  constructor(
    readonly code: ApiReadFailureCode,
    /** For a `chosen_*` code: the words the caller is told. */
    readonly detail?: string,
  ) {
    super('The API item read is unavailable.');
    this.name = 'ApiReadFailure';
  }
}

/** A read's status and wire code: the one table both read transports answer by. */
export function apiReadStatus(code: ApiReadFailureCode): { status: number; code: string } {
  switch (code) {
    case 'unauthenticated':
      return { status: 401, code };
    case 'forbidden':
      return { status: 403, code };
    case 'invalid_request':
      return { status: 400, code };
    case 'chosen_invalid':
      return { status: 422, code: 'chosen_invalid' };
    case 'chosen_required':
      return { status: 422, code: 'chosen_required' };
    default:
      return { status: 503, code };
  }
}
