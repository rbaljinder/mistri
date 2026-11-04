/**
 * What a log line may say of an error: its name and `code`, and its message
 * without addresses, URLs or runs that could be secrets. A failed send used to
 * be logged as "could not be emailed" and nothing else, which left an operator
 * guessing between a refused login, a bad address and a network that was down;
 * the provider's own message often quotes the recipient or the endpoint it was
 * handed (a webhook URL carries its token in the path), so it is cleaned
 * rather than printed whole. The stack is never read.
 */
const MESSAGE_LIMIT = 200;

export interface Cause {
  name: string;
  code?: string;
  message: string;
}

export function describeCause(error: unknown): Cause {
  const object = error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown; message?: unknown }) : undefined;
  const name = typeof object?.name === 'string' ? object.name : typeof error;
  // A driver's code is a short word (`ECONNREFUSED`, `EAUTH`); anything longer or odd could be data.
  const code = typeof object?.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(object.code) ? object.code : undefined;
  const message = (typeof object?.message === 'string' ? object.message : '')
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '<url>')
    .replace(/[^\s@]+@[^\s@]+/g, '<address>')
    .replace(/[A-Za-z0-9_\-+/=.]{32,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, ...(code ? { code } : {}), message: message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}…` : message };
}

/** The cause as one clause to end a log line: `Error (EAUTH): Invalid login`. */
export function causeText(error: unknown): string {
  const { name, code, message } = describeCause(error);
  return `${name}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`;
}
