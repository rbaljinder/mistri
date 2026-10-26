/**
 * What `@mistriwork/mistri/react` (src/embed/) and the server it talks to agree on
 * before the shell draws anything.
 *
 * Mounted in a host's own server, the client and the server are one package
 * and cannot disagree. Behind a host's rewrite, or on another origin, they
 * are two installs that can drift: the host upgrades its `mistri`
 * dependency and the mistri process stays where it was, or the reverse.
 * The shell then sends requests the server does not answer in the shape it
 * expects, and the failure shows up as a broken room rather than a sentence.
 * So the Provider asks first (`EMBED_BOOT_PATH`), and refuses a server it
 * was not built for with a sentence that says which side to move.
 *
 * `protocol` is an integer that changes only when an older client could not
 * work against the server at all. Beside it, versions may differ by one minor
 * release either way; past that the two are refused, whatever the protocol.
 *
 * Pure, so the server, the client and their tests read one rule.
 */
import type { FirstPaintData } from '@mistriwork/engine/shared/firstPaint.js';

/** Bumped when a client built before it could not work against a server after it. */
export const EMBED_PROTOCOL = 1;

/** Bare, answered before any gate: who is asking does not change which client the server can serve. With `?app=`, the embed's first page. */
export const EMBED_BOOT_PATH = '/api/embed/boot';

/**
 * What the boot answer says. The version is `major.minor` only, which is all
 * the rule reads. Asked with `?app=` (server/embed/boot.ts), it also says
 * whether the request is signed in, and carries the shell's first answers in
 * `data`, the shape a served page's first-paint block has.
 */
export interface EmbedBoot {
  protocol: number;
  version: string;
  signedIn?: boolean;
  data?: FirstPaintData;
}

/** `0.8.14` → `0.8`. */
export const minorVersion = (version: string): string => version.split('.').slice(0, 2).join('.');

/**
 * Why this client cannot use this server, or undefined when it can. `client`
 * is the package's own version; `server` is the boot answer, as parsed JSON.
 */
export function embedRefusal(clientVersion: string, server: unknown): string | undefined {
  const answer = server as Partial<EmbedBoot> | null;
  if (!answer || typeof answer.protocol !== 'number' || typeof answer.version !== 'string') {
    return `The mistri server at this endpoint did not say which embed protocol it speaks; it is older than @mistriwork/mistri/react ${clientVersion} or not a mistri server. Upgrade the server, or point the endpoint at it.`;
  }
  const [clientMajor, clientMinor] = clientVersion.split('.').map(Number);
  const [serverMajor, serverMinor] = answer.version.split('.').map(Number);
  if (answer.protocol !== EMBED_PROTOCOL || clientMajor !== serverMajor || Math.abs(clientMinor - serverMinor) > 1) {
    const older =
      answer.protocol < EMBED_PROTOCOL || serverMajor < clientMajor || (serverMajor === clientMajor && serverMinor < clientMinor);
    return `@mistriwork/mistri/react ${minorVersion(clientVersion)} (embed protocol ${EMBED_PROTOCOL}) cannot use the mistri server at this endpoint, which is ${answer.version} (protocol ${answer.protocol}). ${older ? 'Upgrade the server' : 'Upgrade the mistri package in this app'} so the two are within one minor release.`;
  }
  return undefined;
}
