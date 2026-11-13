/**
 * A command's link to one of the App's public views (`context.publicLink`).
 *
 * The handler holds a PublicLinkRef, which serializes to
 * `mistri-public:<view>.<seal>`: that is what reaches the receipt, the effect
 * outbox and a replayed result. The seal (refSeal.ts) is what tells it from the
 * same words in a visitor's text, which stay text wherever they are delivered. Like a capability link (linkToken.ts) it becomes a URL
 * only at the edges — the command's HTTP answer and an effect's delivery — and
 * only then is its address read: a tenant's public or intake address as it
 * stands at delivery, so one rotated since the command ran is the one sent.
 *
 * The reference names the view alone, never a tenant: it renders for the tenant
 * it is delivered for (the request's, the effect's envelope's).
 */
import type { AppDef } from '../../shared/app.js';
import { appAddressBook, publicFormAddress, viewAddress, type AddressBook } from '../../shared/appAddress.js';
import { isPublicForm, isTenantApp, viewOrder } from '../../shared/appModel.js';
import { appKeepsInbox } from '../../shared/appNotify.js';
import { apiOnlyViews } from '../../shared/appPayload.js';
import { opensTo } from '../../shared/appViewRoles.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { withoutComments } from '../commands/commandTriggerChecks.js';
import { refSeal, refSealed, SEAL } from './refSeal.js';

const LINK_REF_BRAND: unique symbol = Symbol.for('mistri.link-ref');

const PUBLIC_REF_PREFIX = 'mistri-public:';
/* The view key escaped past what a sentence may put after it, so `…at mistri-public:inquiry.` ends at the key. */
const encodeView = (view: string) =>
  encodeURIComponent(view).replace(/[.!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const REF = new RegExp(`mistri-public:([A-Za-z0-9_%-]+)\\.(${SEAL})(?![A-Za-z0-9_-])`, 'g');

/** What `context.publicLink()` answers: a reference to a public view, said as its URL where it is delivered. */
export class PublicLinkRef {
  readonly view: string;
  readonly #said: string;
  /** The brand an output's text() reads it by (commandShapes.ts), as it reads a capability link's. */
  readonly [LINK_REF_BRAND] = true;
  /** The reference `appId` makes, sealed so a visitor's typed look-alike is never read as one. */
  constructor(view: string, appId: string) {
    this.view = view;
    const said = encodeView(view);
    this.#said = `${PUBLIC_REF_PREFIX}${said}.${refSeal(appId, 'public', said)}`;
    Object.freeze(this);
  }
  toJSON(): string {
    return this.#said;
  }
  toString(): string {
    return this.#said;
  }
}

/* Each reference in `text` the App made: its spelling and its view. A look-alike — a visitor's typed words, a seal
   another App or key made — is not one and stays the text it is. */
function sealedRefs(text: string, appId: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (!text.includes(PUBLIC_REF_PREFIX)) return out;
  for (const [whole, said, seal] of text.matchAll(REF)) {
    if (out.has(whole) || !refSealed(appId, 'public', said!, seal!)) continue;
    let view: string | undefined;
    try {
      view = decodeURIComponent(said!);
    } catch {
      view = undefined;
    }
    out.set(whole, view);
  }
  return out;
}

/** Whether `text` holds a public link reference the App made. */
export const holdsPublicRef = (text: string, appId: string): boolean => sealedRefs(text, appId).size > 0;

/* A reference an author wrote by hand, `mistri-public:<view>` with no seal: read only in the author's own words. */
const AUTHORED = new RegExp(`mistri-public:([A-Za-z0-9_%-]+)(?![A-Za-z0-9_%-])(?!\\.${SEAL}(?![A-Za-z0-9_-]))`, 'g');

/**
 * `text` with each reference its author wrote by hand sealed as the App's own. Only for words that are the author's
 * and never a visitor's: a public reply's declared literal (formHttp.ts publicMessage), matched whole against the
 * output's declaration, so nothing a visitor typed can reach it.
 */
export const sealAuthoredRefs = (text: string, appId: string): string =>
  text.includes(PUBLIC_REF_PREFIX)
    ? text.replace(AUTHORED, (_whole, said: string) => `${PUBLIC_REF_PREFIX}${said}.${refSeal(appId, 'public', said)}`)
    : text;

/** How many public link references `text` may hold, by spelling: each is counted at its URL's size where a body is bounded. */
export const publicRefCount = (text: string): number => (text.includes(PUBLIC_REF_PREFIX) ? [...text.matchAll(REF)].length : 0);

/**
 * `text` with each `mistri-public:<view>.<seal>` the App made replaced by what `render` answers for the view. Where one
 * does not render, undefined — or, with `keep`, the reference left as it is (an answer with no address to say it by).
 * Text that only looks like a reference is left as it is and never fails the text.
 */
export async function renderPublicRefs(
  text: string,
  appId: string,
  render: (view: string) => Promise<string | undefined>,
  keep = false,
): Promise<string | undefined> {
  const refs = sealedRefs(text, appId);
  if (refs.size === 0) return text;
  const urls = new Map<string, string | undefined>();
  for (const [whole, view] of refs) {
    const url = view === undefined ? undefined : await render(view);
    if (url === undefined && !keep) return undefined;
    urls.set(whole, url);
  }
  return text.replace(REF, (whole: string) => urls.get(whole) ?? whole);
}

/**
 * `text` with each reference the App made removed, and the space or punctuation it leaves behind tidied: for a message
 * whose links cannot be said (no address places them), where the reference is dropped and the words around it kept.
 */
export function withoutPublicRefs(text: string, appId: string): string {
  const refs = sealedRefs(text, appId);
  if (refs.size === 0) return text;
  return text
    .replace(REF, (whole: string) => (refs.has(whole) ? '' : whole))
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]+([.,;:!?)\]])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** A public view's URL as an effect is delivered: for the effect's tenant, in a tenant App; undefined where none is known. */
export type PublicLinkRender = (view: string, tenantId: string | undefined) => Promise<string | undefined>;

/** What a public view is opened as: a public form by its intake address, a room by the public one. */
type PublicLinkKind = 'form' | 'room';

/* The rooms' segments, as the shell's book says them (client/publicAddress.ts): a view's segment depends only on the
   views claimed before it and the inbox and assistant, never on pages or tables, so no catalog is needed. */
const books = new WeakMap<AppDef, AddressBook>();
function roomBook(app: AppDef): AddressBook {
  let book = books.get(app);
  if (!book) {
    const apiOnly = apiOnlyViews(app);
    const views = Object.fromEntries(Object.entries(app.views).filter(([key, view]) => !apiOnly.has(key) && !isPublicForm(view)));
    book = appAddressBook({
      views: views as never,
      order: viewOrder({ views, nav: app.nav }),
      resources: {},
      pages: [],
      tables: [],
      inbox: appKeepsInbox(app),
      assistant: app.assistant?.placement.includes('page') === true,
    });
    books.set(app, book);
  }
  return book;
}

/**
 * Whether a view is one a signed-out visitor opens, and how: a public form; a public free-form page; a list over a
 * resource the App's public grant reads (and lists, not by key alone) that names no role. An App with no sign-in is
 * open throughout; a tenant App always has one. Anything else is undefined.
 */
export function publicLinkKind(app: AppDef, view: string): PublicLinkKind | undefined {
  if (!Object.hasOwn(app.views, view)) return undefined;
  const target = app.views[view] as AppDef['views'][string] & { table?: unknown; page?: { public?: unknown; record?: unknown } };
  if (isPublicForm(target)) return 'form';
  if (!roomBook(app).views.has(view)) return undefined;
  const auth = app.auth;
  if (!auth) return isTenantApp(app) ? undefined : 'room';
  if (!auth.public || !opensTo(target, [], auth)) return undefined;
  if (target.page?.public === true) return 'room';
  if (typeof target.table === 'string' && !('sections' in target) && !('command' in target)) {
    const table = target.table;
    return auth.public.read.includes(table) && !auth.public.byKey?.includes(table) ? 'room' : undefined;
  }
  return undefined;
}

/**
 * `context.publicLink(view)`: the reference, or a refusal naming the view where it is not one a signed-out visitor
 * opens — said at the call, as `context.link` refuses a name its target does not declare. A view the handler spells as
 * a literal is judged before then, at load and by `mistri check` (publicLinkCallProblems); this refusal is for a view
 * the handler computes.
 */
export function publicLinkTo(app: AppDef, view: string): PublicLinkRef {
  if (typeof view !== 'string' || !publicLinkKind(app, view))
    throw new TypeError(
      Object.hasOwn(app.views, String(view))
        ? `publicLink("${view}"): "${view}" is not a public view of ${app.id}. A public link opens a public form, a public page or a list the public grant reads.`
        : `publicLink("${String(view)}"): ${app.id} has no view "${String(view)}".`,
    );
  return new PublicLinkRef(view, app.id);
}

/* `publicLink('view')` in a handler's text, the view a plain string literal: a computed one is left to the call. */
const LITERAL_CALL = /\bpublicLink\s*\(\s*(['"`])([^'"`$\\]*)\1\s*\)/g;

/**
 * Each `publicLink(view)` a command's handler spells with a literal view that no signed-out visitor opens, said by
 * command and view with the fix: refused at load (businessCommandLoader.ts) and by `mistri check`, where otherwise
 * every run that reaches the call would throw. Comments are read past; a view the handler computes is judged at the
 * call (publicLinkTo).
 */
export function publicLinkCallProblems(app: AppDef, registry: BusinessCommandRegistry): string[] {
  const out: string[] = [];
  for (const [id, command] of Object.entries(registry)) {
    if (typeof command.handle !== 'function') continue;
    let text: string;
    try {
      text = withoutComments(Function.prototype.toString.call(command.handle));
    } catch {
      continue;
    }
    const said = new Set<string>();
    for (const [, , view] of text.matchAll(LITERAL_CALL)) {
      if (view === undefined || said.has(view) || publicLinkKind(app, view)) continue;
      said.add(view);
      out.push(
        Object.hasOwn(app.views, view)
          ? `command "${id}" links to "${view}" with publicLink, which is not a public view of ${app.id} [public-link-not-public]: ` +
              `a public link opens a public form, a public page or a list the public grant reads. Make "${view}" public, or link to a view that is.`
          : `command "${id}" links to "${view}" with publicLink, and ${app.id} has no view "${view}" [public-link-not-public]. ` +
              `Name one of its public views.`,
      );
    }
  }
  return out;
}

/** A public view's address under the App, before any mount: `/compass/leads`, or `/compass/form/inquiry`. */
function publicLinkPath(app: AppDef, view: string, kind: PublicLinkKind): string | undefined {
  return kind === 'form' ? publicFormAddress(app.id, view) : viewAddress(roomBook(app), app.id, view);
}

/* Where an ordinary App's pages are served, as the server is started (serve.ts): a path under the App made a URL. */
const outwards = new Map<string, (path: string) => string>();
export function configurePublicLinks(appId: string, outward: (path: string) => string): () => void {
  outwards.set(appId, outward);
  return () => {
    if (outwards.get(appId) === outward) outwards.delete(appId);
  };
}

/** A public view's URL in an App that is not a tenant App; undefined where the server's address is not known. */
export function appPublicUrl(app: AppDef, view: string): string | undefined {
  const kind = publicLinkKind(app, view);
  const outward = outwards.get(app.id);
  const path = kind && publicLinkPath(app, view, kind);
  return outward && path ? outward(path) : undefined;
}

/**
 * A tenant App's public links: the tenant's own origin, the view's address under the server's mount and the address
 * the tenant hands out (its intake address, for a form) as `via`, read when the link is said, so one rotated since the
 * command ran is never sent. A tenant with no such address, or no origin, says none.
 */
export function tenantPublicLinks(
  app: AppDef,
  where: {
    readonly origin: (tenant: string) => string | undefined;
    readonly outward: (path: string) => string;
    readonly addresses: (tenant: string) => Promise<{ readonly intake?: string; readonly public?: string }>;
  },
): PublicLinkRender {
  return async (view, tenant) => {
    const kind = tenant === undefined ? undefined : publicLinkKind(app, view);
    const path = kind && publicLinkPath(app, view, kind);
    const origin = path && where.origin(tenant!);
    if (!path || origin === undefined) return undefined;
    const addresses = await where.addresses(tenant!);
    const address = kind === 'form' ? addresses.intake : addresses.public;
    return address ? `${origin}${where.outward(path)}?via=${encodeURIComponent(address)}` : undefined;
  };
}

/** An App that is not a tenant App's public links, under the address it was started on: one renderer for every tenant. */
export const appPublicLinks =
  (app: AppDef): PublicLinkRender =>
  (view) =>
    Promise.resolve(appPublicUrl(app, view));

/** Why a message holding a public link was not sent: its view has no address to be said by where it is delivered. */
export const PUBLIC_LINK_UNSAID = 'a public link in it has no address to be said by';

/**
 * A message's text as it reaches a person (a notice's mail, a contact's mail, a channel's text): its public links
 * said as URLs for `tenant`. Undefined where one has none, and the message is then not sent: unlike an answer, which
 * keeps a reference it cannot say, a person is never sent `mistri-public:<view>`. Only a reference the App made is
 * one: a visitor's look-alike in the text is sent as the text it is.
 */
export const sayPublicLinks = (
  text: string,
  appId: string,
  render: PublicLinkRender | undefined,
  tenant: string | undefined,
): Promise<string | undefined> => renderPublicRefs(text, appId, (view) => (render ? render(view, tenant) : Promise.resolve(undefined)));

/** `value` with its public links said as URLs under the address an App that is not a tenant App was started on. */
export const withAppPublicUrls = <T>(app: AppDef, value: T): Promise<T> =>
  withPublicUrls(value, app.id, (view) => Promise.resolve(appPublicUrl(app, view)));

/**
 * `value` with the public link references the App made said as URLs by `render`; one with no URL to be said by stays a
 * reference, as an unrendered capability link does.
 */
export async function withPublicUrls<T>(value: T, appId: string, render: (view: string) => Promise<string | undefined>): Promise<T> {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || !holdsPublicRef(text, appId)) return value;
  const rendered = await renderPublicRefs(text, appId, render, true);
  return rendered === undefined || rendered === text ? value : (JSON.parse(rendered) as T);
}
