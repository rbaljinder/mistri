/** Private read-owner failure classification. Messages deliberately contain
 * no token, account, schema, SQL or driver diagnostics. The 503 code is the
 * command transport's own `temporarily_unavailable`: one API, one word for
 * "authority was never decided, try again", whichever half answers. */
export type ApiReadFailureCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'temporarily_unavailable';

export class ApiReadFailure extends Error {
  constructor(readonly code: ApiReadFailureCode) {
    super('The API item read is unavailable.');
    this.name = 'ApiReadFailure';
  }
}
