/**
 * A capability link's secret and its references (shared/appLinks.ts).
 *
 * The URL carries `mstl1.<id>.<mac>`: the id names the stored row
 * (adapters/commands/commandLinks.ts) and the MAC is an HMAC over what the row
 * grants, keyed from the App's form key (formKey.ts, purpose `mistri link v1`).
 * Nothing secret is stored: the row and the id open nothing without the key,
 * and rotating MISTRI_FORM_KEY voids every link, as it voids form tickets.
 *
 * A command that mints a link holds a LinkRef, which serializes to
 * `mistri-link:<id>.<seal>`; that is what reaches the receipt, the effect outbox
 * and a replayed result. The URL is rendered only at the edges: the minting
 * command's HTTP answer and an effect's delivery (renderLinkRefs). The seal
 * (refSeal.ts) tells it from the same words in a visitor's text, which stay text.
 *
 * After the first open the visitor holds a session token instead
 * (`mstls1.<id>.<exp>.<gates>.<opened>.<mac>`, five minutes, purpose `mistri
 * link session v2`), in a cookie scoped to `/<app>/l/` and in the page's own
 * header, so the secret leaves the address bar and history.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SURFACE_TOKEN_MAX_TTL_SECONDS } from '../auth/surfaceToken.js';
import { purposeKey } from '../forms/formKey.js';
import type { CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import { LINK_ID } from '../../adapters/commands/commandLinks.js';
import { refSeal, refSealed, SEAL } from './refSeal.js';

export const LINK_TOKEN_PREFIX = 'mstl1.';
const TOKEN = /^mstl1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const SESSION = /^mstls1\.([A-Za-z0-9_-]{22})\.(\d{10,13})\.([0-3])\.(\d{10,13})\.([A-Za-z0-9_-]{43})$/;
/** How long a link session lasts: a surface token's longest life. */
export const LINK_SESSION_SECONDS = SURFACE_TOKEN_MAX_TTL_SECONDS;
/*
 * How long one open lasts, however often the page renews its session. Renewal
 * slides the five minutes, never past this: a `uses: 1` link spent on its first
 * open must not stay workable to its `expires` by a reload every few minutes.
 */
export const LINK_OPEN_SECONDS = 30 * 60;
/** A session's gates, as bits: the holder typed the confirmation, the holder typed the emailed code. */
export const GATE_CONFIRMED = 1;
export const GATE_STEPPED_UP = 2;

/** A new link id: 128 random bits, base64url. */
export const newLinkId = (): string => randomBytes(16).toString('base64url');

type Granted = Pick<CommandLinkRow, 'id' | 'tenant' | 'resource' | 'rowKey' | 'name'>;
const mac = (purpose: string, appId: string, text: string): Buffer =>
  createHmac('sha256', purposeKey(purpose, appId)).update(text, 'utf8').digest().subarray(0, 32);
const linkMac = (appId: string, row: Granted) =>
  mac('mistri link v1', appId, `${appId}|${row.tenant}|${row.resource}|${row.rowKey}|${row.name}|${row.id}`);

/** The secret a link's URL carries. Throws FormKeyMissing without a key. */
export function linkToken(appId: string, row: Granted): string {
  return `${LINK_TOKEN_PREFIX}${row.id}.${linkMac(appId, row).toString('base64url')}`;
}

/** The id a token names, by shape alone; nothing is proven until linkTokenMatches says so of the row it names. */
export function linkTokenId(token: unknown): string | undefined {
  return typeof token === 'string' ? TOKEN.exec(token)?.[1] : undefined;
}

/**
 * Whether `token` is the one minted for `row`. With no row (an unknown id) the
 * same comparison is made against nothing, so a bad MAC and an unknown id take
 * the same work; without a key, false.
 */
export function linkTokenMatches(appId: string, token: string, row: Granted | undefined): boolean {
  const parts = TOKEN.exec(token);
  let expected: Buffer;
  try {
    expected = linkMac(appId, row ?? { id: parts?.[1] ?? '', tenant: '', resource: '\u0000', rowKey: '', name: '' });
  } catch {
    return false;
  }
  const given = Buffer.from(parts?.[2] ?? '', 'base64url');
  const same = timingSafeEqual(given.length === expected.length ? given : Buffer.alloc(expected.length), expected);
  return same && given.length === expected.length && row !== undefined && parts?.[1] === row.id;
}

const sessionText = (appId: string, tenant: string, id: string, exp: number, gates: number, opened: number) =>
  `${appId}|${tenant}|${id}|${exp}|${gates}|${opened}`;

/** A session for an opened link: who holds it is not known, only that they opened it and which gates they passed. */
export function linkSession(appId: string, tenant: string, id: string, gates: number, now = Date.now(), opened?: number): string {
  const at = Math.floor(now / 1000);
  const first = opened ?? at;
  const exp = Math.min(at + LINK_SESSION_SECONDS, first + LINK_OPEN_SECONDS);
  const signed = mac('mistri link session v2', appId, sessionText(appId, tenant, id, exp, gates, first)).toString('base64url');
  return `mstls1.${id}.${exp}.${gates}.${first}.${signed}`;
}

/** A session's link id and gates, when it is this App's, unexpired and for `id`; otherwise undefined. */
export function readLinkSession(
  appId: string,
  tenant: string,
  id: string,
  session: unknown,
  now = Date.now(),
): { gates: number; opened: number } | undefined {
  if (typeof session !== 'string') return undefined;
  const parts = SESSION.exec(session);
  if (!parts || parts[1] !== id || !LINK_ID.test(id)) return undefined;
  const exp = Number(parts[2]);
  const gates = Number(parts[3]);
  const opened = Number(parts[4]);
  let expected: Buffer;
  try {
    expected = mac('mistri link session v2', appId, sessionText(appId, tenant, id, exp, gates, opened));
  } catch {
    return undefined;
  }
  const given = Buffer.from(parts[5], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  if (exp * 1000 <= now || (opened + LINK_OPEN_SECONDS) * 1000 <= now) return undefined;
  return { gates, opened };
}

const LINK_REF_BRAND: unique symbol = Symbol.for('mistri.link-ref');

/** What `context.link()` answers: a reference to a minted link. It serializes as `mistri-link:<id>.<seal>`, never the secret. */
export class LinkRef {
  readonly id: string;
  readonly #said: string;
  /** The brand an output's text() reads it by (commandShapes.ts). */
  readonly [LINK_REF_BRAND] = true;
  constructor(id: string, appId: string) {
    if (!LINK_ID.test(id)) throw new TypeError('A link reference names a link id.');
    this.id = id;
    this.#said = `${LINK_REF_PREFIX}${id}.${refSeal(appId, 'link', id)}`;
    Object.freeze(this);
  }
  toJSON(): string {
    return this.#said;
  }
  toString(): string {
    return this.#said;
  }
}
export const LINK_REF_PREFIX = 'mistri-link:';
/** A reference's length as written: the prefix, the id, a dot and the seal. */
export const LINK_REF_LENGTH = LINK_REF_PREFIX.length + 22 + 1 + 22;
const REF = new RegExp(`mistri-link:([A-Za-z0-9_-]{22})\\.(${SEAL})(?![A-Za-z0-9_-])`, 'g');

/* The references in `text` the App made, by spelling, with their ids; a look-alike is not one and stays the text it is. */
function sealedIds(text: string, appId: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text.includes(LINK_REF_PREFIX)) return out;
  for (const [whole, id, seal] of text.matchAll(REF)) if (!out.has(whole) && refSealed(appId, 'link', id!, seal!)) out.set(whole, id!);
  return out;
}

/** Whether `text` holds a link reference the App made. */
export const holdsLinkRef = (text: string, appId: string): boolean => sealedIds(text, appId).size > 0;

/** How many link references `text` may hold, by spelling: each is counted at its URL's size where a body is bounded. */
export const linkRefCount = (text: string): number => (text.includes(LINK_REF_PREFIX) ? [...text.matchAll(REF)].length : 0);

/** Why a message holding a capability link a command minted was not sent: a message to a person (a notice's mail, a
    channel's text) says no capability link, and is never sent its reference instead. */
export const LINK_REF_UNSAID = 'a capability link in it cannot be said in a message';

/**
 * `text` with each `mistri-link:<id>.<seal>` the App made replaced by what
 * `render` answers for the id (its URL), or undefined when a reference does
 * not render: a link revoked or expired before delivery sends nothing. Text
 * that only looks like a reference is left as it is and never fails the text.
 */
export async function renderLinkRefs(
  text: string,
  appId: string,
  render: (id: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const ids = sealedIds(text, appId);
  if (ids.size === 0) return text;
  const urls = new Map<string, string>();
  for (const [whole, id] of ids) {
    const url = await render(id);
    if (url === undefined) return undefined;
    urls.set(whole, url);
  }
  return text.replace(REF, (whole: string) => urls.get(whole) ?? whole);
}

/* Where an App's links are served, `<origin><base>`, as the server is started (serve.ts); a link renders only where one is known. */
const bases = new Map<string, string>();
export function configureLinkBase(appId: string, base: string): () => void {
  bases.set(appId, base.replace(/\/+$/, ''));
  return () => {
    if (bases.get(appId) === base.replace(/\/+$/, '')) bases.delete(appId);
  };
}
const linkBase = (appId: string): string | undefined => bases.get(appId);

/** A link's URL: `<base>/l/<token>`, or undefined where the App's address or key is not known. */
export function linkUrl(appId: string, row: Granted, base = linkBase(appId)): string | undefined {
  if (base === undefined) return undefined;
  try {
    return `${base}/l/${linkToken(appId, row)}`;
  } catch {
    return undefined;
  }
}

/** A URL shaped as a link's that names no link: a decoy's answer (formHttp.ts decoyReply), which opens to the one miss. */
export function decoyLinkUrl(appId: string, base = linkBase(appId)): string | undefined {
  return base === undefined ? undefined : `${base}/l/${LINK_TOKEN_PREFIX}${newLinkId()}.${randomBytes(32).toString('base64url')}`;
}
