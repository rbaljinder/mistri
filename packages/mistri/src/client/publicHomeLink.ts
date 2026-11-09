/**
 * Whether the App's home is somewhere this visitor can go, for the "Back to <App>" a public form's receipt ends in.
 *
 * A signed-out visitor to an App that signs people in is sent to the staff sign-in by its root, unless the root is a
 * public page: the landing or a public form (who-am-I's `home`), or lists the public browses (`public`). A link that
 * leads a visitor to a door they hold no key to is not a way back, so it is not drawn. Someone signed in has the App;
 * an App that signs nobody in has no door to be sent to.
 */
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/** Who-am-I's answer, as far as this question reads it. */
interface WhoAmI {
  signedIn?: boolean;
  signIn?: unknown;
  home?: unknown;
  public?: boolean;
}

export function homeIsReachable(me: WhoAmI | null | undefined): boolean {
  if (!me || typeof me !== 'object') return false;
  if (me.signedIn === true || !me.signIn) return true;
  return (me.home !== undefined && me.home !== null) || me.public === true;
}

/** The link to draw once the form is received: `href` where the visitor can follow it, else none. Not asked until then. */
export function homeHrefFor(appId: string, href: string): () => Promise<string | undefined> {
  return async () => {
    try {
      const res = await fetchServer(`/api/whoami?app=${encodeURIComponent(appId)}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15_000),
      });
      return homeIsReachable((await res.json()) as WhoAmI) ? href : undefined;
    } catch {
      return undefined;
    }
  };
}
