/**
 * The door a dispatcher holds every request to before any route reads it,
 * in one order: the Host, the proxy's identity, the product's session, then
 * a write's Origin and body (trust.ts `doorRefusal`). The order is the
 * defence, so it is kept here once rather than spelled in each dispatcher:
 *
 *   - the Host first, on every request, read or write, page or endpoint. The
 *     name tablewalk was reached by is the one thing a rebinding attack
 *     cannot fake, so it is checked before anything is served — including
 *     index.html, so the attempt fails at the door rather than at the first
 *     fetch;
 *   - the proxy's identity (`--auth-proxy-header`), unless the product says
 *     the request names no one whatever its headers carry;
 *   - the product's session (`SessionDoor`): an App's sign-in, its public
 *     forms and pages, a host's bearer on another origin. The database
 *     browser has none;
 *   - a write's Origin and JSON body last, because the session part decides
 *     whether an Origin is vouched for (embed/crossOrigin.ts `embedDoor`).
 *
 * Returns who is asking and what the session established, or `undefined`
 * when the door already answered — in which case the caller is done.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { doorRefusal, identityFor, writes, type Bound } from './trust.js';
import type { Identity } from './context.js';
import { admitAs } from '../../adapters/poolAdmission.js';

/** Which step refused: a dispatcher answers each in its own shape (a command's, the API's, a page's). */
type DoorCheck = 'host' | 'identity' | 'origin';

interface DoorAsk {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly bound: Bound;
  /** Answer a refusal, in the dispatcher's own shape. */
  readonly refuse: (check: DoorCheck, status: 401 | 403, error: string) => void;
}

/** What a request arriving at the session part is, once the Host has passed. */
interface Arrival {
  /** The session part answered it already: a preflight from a host on another origin. */
  readonly answered?: boolean;
  /** It names no one, whatever its headers say: a public storefront's request (http/tenantHosts.ts). */
  readonly anonymous?: boolean;
}

/** A product's part of the door, between the proxy's identity and a write's Origin. */
interface SessionDoor<S> {
  /** After the Host, before the proxy identity is read. */
  arrive?(): Arrival | Promise<Arrival>;
  /**
   * The session over the proxy's identity, which it completes in place (the
   * account, its roles and name): what it established, or `undefined` when it
   * answered the request.
   */
  admit(identity: Identity): Promise<S | undefined>;
}

export async function door<S>(ask: DoorAsk, session: SessionDoor<S>): Promise<{ identity: Identity; session: S } | undefined> {
  const { req, bound, refuse } = ask;
  /* A write's Origin and body are the door's second asking, below: the
     session part decides first whether its Origin is vouched for. */
  const wrongHost = doorRefusal(req, bound, { writing: false })?.error;
  if (wrongHost) {
    refuse('host', 403, wrongHost);
    return undefined;
  }
  const arrival = (await session.arrive?.()) ?? {};
  if (arrival.answered) return undefined;
  const identity: Identity = arrival.anonymous ? {} : identityFor(req, bound);
  if (identity.refusal) {
    refuse('identity', 401, identity.refusal);
    return undefined;
  }
  const admitted = await session.admit(identity);
  if (admitted === undefined) return undefined;
  /* Signed in, its pool checkouts wait their turn as the account's, not its
     address's (adapters/poolAdmission.ts): one person's tabs on two networks
     are one share of the line, and an office behind one address is many. */
  admitAs(identity.id ?? identity.who);
  /* Every request that can change something is checked before it is read, so
     a refusal costs nothing and happens before any work. Admitted on a bearer
     (embedDoor), the Origin was checked against the one the bearer was issued
     to; the Host and the JSON body still are. */
  if (writes(req)) {
    const refusal = doorRefusal(req, bound, { writing: true })?.error;
    if (refusal) {
      refuse('origin', 403, refusal);
      return undefined;
    }
  }
  return { identity, session: admitted };
}
