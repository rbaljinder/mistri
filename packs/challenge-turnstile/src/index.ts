/**
 * @mistriwork/challenge-turnstile: Cloudflare Turnstile as the human check an App's public doors ask (`auth.challenge`).
 *
 * Core ships the seam only (packages/mistri/src/server/commands/challenges.ts): a named verifier the commands module
 * exports, asked before a public form's submit or a public page's command is read, and a slot in the stock public
 * form that draws the verifier's widget. This pack is one such verifier — it never reads a row, and core never
 * imports it:
 *
 *   import { defineChallenges } from '@mistriwork/mistri/commands';
 *   import { turnstile } from '@mistriwork/challenge-turnstile';
 *   export const challenges = defineChallenges({
 *     verifyHuman: turnstile({ siteKey: process.env.TURNSTILE_SITE_KEY!, secret: process.env.TURNSTILE_SECRET! }),
 *   });
 *
 * `turnstileStub()` (./stub.ts) stands in for Cloudflare in a test: a local siteverify and a widget script, so a
 * test — node or browser — makes no live call.
 *
 * Unpublished until after 1.0: it reaches into core by path for one type, and the seam it plugs into is held to the
 * same freeze as the rest of `@mistriwork/mistri/commands` from then.
 */
import type { ChallengeRequest, HumanCheck } from '../../../packages/mistri/src/server/commands/challenges.js';

export { turnstileStub } from './stub.js';
export type { TurnstileStub, TurnstileStubOptions } from './stub.js';

/** Cloudflare's: where a token is verified, and the widget's script, rendered explicitly into the form's slot. */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** A Turnstile token is at most 2048 characters (Cloudflare's documentation); a longer one is not asked about. */
const TOKEN_MOST = 2048;

export interface TurnstileOptions {
  /** The widget's public key: drawn in the page, so it is no secret. */
  siteKey: string;
  /** The secret siteverify takes. Read it from the environment; it is never sent to the browser. */
  secret: string;
  /** The host names a token may have been issued on; any other is a no. Absent: the host the request was made to
      (`ChallengeRequest.host`), so a token solved on another site is refused. Name them where a proxy rewrites the
      Host, or where Cloudflare's testing keys answer with a host of their own. */
  hostnames?: readonly string[];
  /** The widget's `action`, where the App sets one: drawn into the stock form's widget, and a token issued for
      another is a no. */
  action?: string;
  /** How long siteverify is waited on, in milliseconds (default 4000, under core's own 5 s deadline). */
  timeoutMs?: number;
  /** For a test: another siteverify (`turnstileStub().verifyUrl`) and another widget script. */
  verifyUrl?: string;
  scriptUrl?: string;
  /** For a test: the fetch siteverify is asked with. */
  fetch?: typeof fetch;
}

/** What siteverify answers, as far as this reads it. */
interface SiteverifyAnswer {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`turnstile({ ${name} }) is a non-empty string.`);
  return value;
}

/** A Turnstile verifier for `defineChallenges`. */
export function turnstile(options: TurnstileOptions): HumanCheck {
  const siteKey = required(options?.siteKey, 'siteKey');
  const secret = required(options.secret, 'secret');
  const verifyUrl = options.verifyUrl ?? TURNSTILE_VERIFY_URL;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const hostnames = options.hostnames ? new Set(options.hostnames.map((name) => name.toLowerCase())) : undefined;
  const ask = options.fetch ?? fetch;
  return {
    widget: {
      script: options.scriptUrl ?? TURNSTILE_SCRIPT_URL,
      api: 'turnstile',
      siteKey,
      ...(options.action ? { action: options.action } : {}),
    },
    async verify(token: string, request: ChallengeRequest): Promise<boolean> {
      if (typeof token !== 'string' || !token || token.length > TOKEN_MOST) return false;
      let answer: SiteverifyAnswer;
      try {
        const response = await ask(verifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret, response: token, ...(request?.ip ? { remoteip: request.ip } : {}) }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        if (!response.ok) return false;
        answer = (await response.json()) as SiteverifyAnswer;
      } catch {
        // Cloudflare unreachable, slow or answering nonsense: not a person we could confirm.
        return false;
      }
      if (answer?.success !== true) return false;
      const allowed = hostnames ?? (request?.host ? new Set([request.host.toLowerCase()]) : undefined);
      if (allowed && !(typeof answer.hostname === 'string' && allowed.has(answer.hostname.toLowerCase()))) return false;
      if (options.action !== undefined && answer.action !== options.action) return false;
      return true;
    },
  };
}
