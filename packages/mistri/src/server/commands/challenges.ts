/**
 * The human check a public door asks (`auth.challenge`): the seam a CAPTCHA-style provider plugs into, and nothing of
 * any provider's own. Core never calls a provider; a pack does (packs/challenge-turnstile), and the App wires it in
 * its commands module beside its commands and loaders:
 *
 *   import { defineChallenges } from '@mistriwork/mistri/commands';
 *   import { turnstile } from '@mistriwork/challenge-turnstile';
 *   export const challenges = defineChallenges({
 *     verifyHuman: turnstile({ siteKey: process.env.TURNSTILE_SITE_KEY!, secret: process.env.TURNSTILE_SECRET! }),
 *   });
 *
 * and names it: `auth: { challenge: 'verifyHuman', … }`. Every public door then asks it before the submission is
 * parsed — a public form's submit and a public page's command — with the token the visitor's widget gave, and refuses
 * (403, `challenge_failed`) where it says no, throws or takes longer than its deadline. The stock public form draws the
 * provider's widget from `widget` (what the browser may be told: the script, the global it registers, the site key);
 * a public page passes its own widget's token as `run(record, input, { challenge })`.
 */

/** What a verifier is asked about: the visitor's address as the server reads it (`--trust-proxy` decides), and the
    host name the request was made to — held to the server's allowed hosts before it gets here, without its port — so
    a provider can refuse a token its widget issued on another site. */
export interface ChallengeRequest {
  ip: string;
  host?: string;
}

/** A human check, as a provider pack makes it. */
export interface HumanCheck {
  /** Whether the token the visitor's widget gave is a person's. A no is false, never a throw. */
  verify(token: string, request: ChallengeRequest): Promise<boolean>;
  /** What the stock public form draws for it, which the browser is told: the provider's script (https), the global
      object that script registers (`turnstile`, `hcaptcha`, each with `render(element, { sitekey, callback })`), the
      public site key and, where the check names one, the widget's `action`, which its verify then insists on.
      Absent: the App's own page draws its widget and passes the token. */
  widget?: { script: string; api: string; siteKey: string; action?: string };
}

const made = new WeakSet<object>();
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The longest a verifier is waited on before the door refuses: a provider that does not answer is a no. */
const CHALLENGE_DEADLINE_MS = 5_000;

function checkWidget(name: string, widget: unknown): HumanCheck['widget'] {
  if (widget === undefined) return undefined;
  const { script, api, siteKey, action } = (widget ?? {}) as Record<string, unknown>;
  let url: URL | undefined;
  try {
    url = typeof script === 'string' ? new URL(script) : undefined;
  } catch {
    url = undefined;
  }
  /* https, or this machine's own http: a provider's local stand-in in a test (packs/challenge-turnstile/src/stub.ts). */
  const loopback = url?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !loopback))
    throw new TypeError(`The challenge "${name}": its widget's script is an https:// address.`);
  if (typeof api !== 'string' || !/^[A-Za-z_$][\w$]{0,31}$/.test(api))
    throw new TypeError(`The challenge "${name}": its widget's api is the name of the global its script registers.`);
  if (typeof siteKey !== 'string' || !siteKey.trim() || siteKey.length > 200)
    throw new TypeError(`The challenge "${name}": its widget's siteKey is the provider's public key.`);
  if (action !== undefined && (typeof action !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(action)))
    throw new TypeError(`The challenge "${name}": its widget's action is up to 32 letters, digits, dashes and underscores.`);
  return Object.freeze({ script: url.href, api, siteKey, ...(action !== undefined ? { action } : {}) });
}

/** The App's human checks by name: `export const challenges = defineChallenges({ verifyHuman: turnstile({ … }) })`. */
export function defineChallenges<const C extends Record<string, HumanCheck>>(challenges: C): Readonly<C> {
  if (!challenges || typeof challenges !== 'object' || Array.isArray(challenges))
    throw new TypeError("defineChallenges takes { name: a provider's check }.");
  const out: Record<string, HumanCheck> = Object.create(null);
  for (const [name, check] of Object.entries(challenges)) {
    if (!NAME.test(name)) throw new TypeError(`The challenge "${name}": a challenge's name is a word of letters, digits and underscores.`);
    if (!check || typeof check !== 'object' || typeof check.verify !== 'function')
      throw new TypeError(`The challenge "${name}" has no verify(token, request).`);
    const widget = checkWidget(name, check.widget);
    const verify = check.verify.bind(check);
    out[name] = Object.freeze({ verify, ...(widget ? { widget } : {}) });
  }
  const frozen = Object.freeze(out);
  made.add(frozen);
  return frozen as unknown as Readonly<C>;
}

/** The registry a commands module exports as `challenges`, checked; undefined when it exports none. */
export function challengesOf(module: Record<string, unknown>, file: string): Readonly<Record<string, HumanCheck>> | undefined {
  const challenges = module.challenges;
  if (challenges === undefined) return undefined;
  if (!challenges || typeof challenges !== 'object' || !made.has(challenges))
    throw new TypeError(
      `The commands module "${file}" exports "challenges" that defineChallenges did not make: export const challenges = defineChallenges({ … }).`,
    );
  return challenges as Readonly<Record<string, HumanCheck>>;
}

/** The check `auth.challenge` names, found in what the commands module exports; a name it lacks stops the App's load. */
export function namedChallenge(
  name: string | undefined,
  challenges: Readonly<Record<string, HumanCheck>> | undefined,
  where: string,
): HumanCheck | undefined {
  if (name === undefined) return undefined;
  const check = challenges && Object.hasOwn(challenges, name) ? challenges[name] : undefined;
  if (!check)
    throw new Error(
      `[auth-challenge] ${where}: "auth.challenge" names "${name}", which the commands module's "challenges" does not define: ` +
        `export const challenges = defineChallenges({ ${name}: … }).`,
    );
  return check;
}

/**
 * Whether a door may go on: no check named, or the check said yes to this token within its deadline. A token that is
 * not a string of a provider's size is a no without asking; a verifier that throws or stalls is a no.
 */
export async function challengePasses(check: HumanCheck | undefined, token: unknown, request: ChallengeRequest): Promise<boolean> {
  if (!check) return true;
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check.verify(token, request).then((answer) => answer === true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CHALLENGE_DEADLINE_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
