/**
 * A model provider's refusal of the call itself, in the platform's words: what the person is told, and what the
 * operator's log is told. A leaf both provider modules read (assistantModel.ts, assistantOpenAI.ts), so neither
 * imports the other for it.
 */
/** A provider's refusal of the call itself (a bad key, an overloaded service), said without its internals. */
export class ModelUnavailable extends Error {
  constructor(
    message: string,
    /** What the operator's log says where the person is told less: the status and the kind of error the provider named. */
    readonly operator?: string,
  ) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}
/** A `ModelUnavailable` as the turn reads it (by its name: each provider module throws its own). */
export type ModelRefusal = Error & { operator?: string };

/**
 * A provider's answer to a call it would not take, in the platform's words. The person is told what they can act on
 * (try again) and nothing of the operator's account; the log is told the status and the provider's error type, and
 * for a spent balance what to do. The provider's own message is read only to tell a spent balance from any other
 * bad request (Anthropic answers both 400 `invalid_request_error`), and is never kept: it can quote the request.
 */
export async function modelRefused(response: Response, keyName: string): Promise<ModelRefusal> {
  const status = response.status;
  let type: string | undefined;
  let credit = false;
  try {
    const error = ((await response.json()) as { error?: { type?: unknown; code?: unknown; message?: unknown } } | null)?.error;
    const named = typeof error?.code === 'string' ? error.code : error?.type;
    if (typeof named === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(named)) type = named;
    credit =
      type === 'insufficient_quota' ||
      type === 'billing_error' ||
      (typeof error?.message === 'string' && /credit balance/i.test(error.message));
  } catch {
    /* No body, or not JSON (a proxy's page): the status is all there is to say. */
  }
  const said = `${status}${type ? ` ${type}` : ''}`;
  if (credit)
    return new ModelUnavailable(
      'The assistant is unavailable right now.',
      `the model provider refused the call (${said}): the account's credit or quota is spent. Add credit to the account ${keyName} belongs to`,
    );
  if (status === 401 || status === 403)
    return new ModelUnavailable(`The assistant's model key was refused. The operator sets ${keyName}.`, `${keyName} was refused (${said})`);
  if (status === 429 || status === 529)
    return new ModelUnavailable('The model is busy. Try again in a moment.', `the model is busy (${said})`);
  return new ModelUnavailable(`The model could not be reached (${status}).`, `the model provider refused the call (${said})`);
}
