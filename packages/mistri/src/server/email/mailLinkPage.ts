/**
 * The page a signed mail link opens (tenantMail.ts): the record as the
 * App's `links` command answered it — what the App decided a requester may
 * see — drawn on the server, and the reply box when the link declares one.
 *
 * No script runs on it and nothing loads from elsewhere: the token is in the
 * address, and a page with no script and no third-party request has nothing
 * that could carry it off (its Referrer-Policy is no-referrer besides). It
 * costs the public budget nothing, and a requester on a phone mail client's
 * own browser gets it in one round trip. Its style is inline, under the
 * page's nonce, in the tool's quiet tokens — or, for a tenant that saved
 * its branding, in its name, logo and accent (tenant/tenantBranding.ts). A
 * color reaches the style only as a hex the theme validator passed, checked
 * again here; the logo is an image on the App's own origin, the one load the
 * page's policy then allows.
 */
import { fieldLabel } from '../../shared/command.js';

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

type Scalar = string | number | boolean | null;
const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** The words a requester reads, longer than a line, kept as written. */
const PROSE = new Set(['body', 'text', 'message', 'description', 'content', 'comment', 'note', 'details']);
const TITLE = ['title', 'subject', 'name', 'summary'];

const said = (value: Scalar) => (value === null ? '—' : value === true ? 'Yes' : value === false ? 'No' : String(value));

function fields(record: Record<string, unknown>, skip: ReadonlySet<string>): string {
  const rows: string[] = [];
  const prose: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key) || !isScalar(value)) continue;
    if (PROSE.has(key) && typeof value === 'string') prose.push(`<p class="prose">${escape(value)}</p>`);
    else rows.push(`<dt>${escape(fieldLabel(key))}</dt><dd>${escape(said(value))}</dd>`);
  }
  return (rows.length ? `<dl>${rows.join('')}</dl>` : '') + prose.join('');
}

function lists(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, value]) => Array.isArray(value) && value.length && value.every(isRecord))
    .map(
      ([key, value]) =>
        `<section><h2>${escape(fieldLabel(key))}</h2>${(value as Record<string, unknown>[])
          .map((item) => `<article>${fields(item, new Set())}</article>`)
          .join('')}</section>`,
    )
    .join('');
}

/** A tenant's brand as mail wears it: validated values only (tenantBranding.ts's `mail`). */
export interface MailBrand {
  readonly name: string;
  /** The logo's address on the App's own origin, from the mount: `/api/branding/logo/<sha256>`. */
  readonly logo?: string;
  readonly light: { readonly accent: string; readonly onAccent: string };
  readonly dark: { readonly accent: string; readonly onAccent: string };
}

const HEX = /^#[0-9a-f]{6}$/i;
const MAIL_LOGO = /^\/api\/branding\/logo\/[0-9a-f]{64}$/;

/** The brand's colors as custom properties, or nothing: a value that is not a plain hex never reaches CSS. */
function brandStyle(brand: MailBrand | undefined): string {
  if (!brand) return '';
  const { light, dark } = brand;
  if (![light.accent, light.onAccent, dark.accent, dark.onAccent].every((value) => HEX.test(value))) return '';
  return `:root{--accent:${light.accent};--on-accent:${light.onAccent}}@media (prefers-color-scheme:dark){:root{--accent:${dark.accent};--on-accent:${dark.onAccent}}}`;
}

/** The page's policy: nothing loads, unless a tenant's logo, from this origin only. */
export function mailLinkPolicy(nonce: string, brand?: MailBrand): string {
  const image = brand?.logo && MAIL_LOGO.test(brand.logo) ? "; img-src 'self'" : '';
  return `default-src 'none'; style-src 'nonce-${nonce}'${image}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

/**
 * A message's `{brand.name}`, `{brand.logo}` and `{brand.accent}`, filled for its tenant — as `{link}` is
 * filled with its address. In HTML the name is escaped, the logo is an image at the App's public address in
 * the shell's fixed box (the name, where the tenant has no logo), and the accent is a hex or nothing; in the
 * text the logo is the name. A mail client loads nothing it is not given, so the address is absolute.
 */
export function fillMailBrand(words: string, brand: MailBrand, baseURL: string, html: boolean): string {
  if (!words.includes('{brand.')) return words;
  const accent = HEX.test(brand.light.accent) ? brand.light.accent : '';
  const logo =
    html && brand.logo && MAIL_LOGO.test(brand.logo)
      ? `<img src="${escape(`${baseURL.replace(/\/+$/, '')}${brand.logo}`)}" alt="${escape(brand.name)}" width="96" height="24" style="display:block;border:0;width:96px;height:24px;object-fit:contain;object-position:left center">`
      : html
        ? escape(brand.name)
        : brand.name;
  return words
    .split('{brand.name}')
    .join(html ? escape(brand.name) : brand.name)
    .split('{brand.logo}')
    .join(logo)
    .split('{brand.accent}')
    .join(accent);
}

export interface MailLinkPage {
  readonly app: string;
  /** The resource's label: what the record is, when its answer names no title. */
  readonly what: string;
  readonly view?: unknown;
  /** A refusal instead of a record: its sentence. */
  readonly problem?: string;
  readonly reply?: boolean;
  readonly sent?: boolean;
  /** The reply's refusal, said above the box. */
  readonly replyProblem?: string;
  readonly nonce: string;
  /** The tenant's brand, when it saved one. */
  readonly brand?: MailBrand;
  /** How the page reaches the App's root from its own address (`../..`): the logo's address is the root's. */
  readonly root?: string;
}

export function mailLinkPage(page: MailLinkPage): string {
  const view = isRecord(page.view) ? page.view : undefined;
  const titleKey = view ? TITLE.find((key) => typeof view[key] === 'string' && view[key]) : undefined;
  const title = page.problem ? page.problem : titleKey ? String(view![titleKey]) : page.what;
  const body = page.problem
    ? ''
    : view
      ? fields(view, new Set(titleKey ? [titleKey] : [])) + lists(view)
      : isScalar(page.view)
        ? `<p class="prose">${escape(said(page.view))}</p>`
        : '';
  const reply =
    page.reply && !page.problem
      ? `<form method="post">${page.sent ? '<p class="ok" role="status">Your reply was sent.</p>' : ''}${
          page.replyProblem ? `<p class="problem" role="alert">${escape(page.replyProblem)}</p>` : ''
        }<label for="reply">Reply</label><textarea id="reply" name="body" rows="5" required maxlength="20000"></textarea><button type="submit">Send reply</button></form>`
      : '';
  const app = page.brand?.name || page.app;
  const logo = page.brand?.logo && MAIL_LOGO.test(page.brand.logo) ? `${page.root ?? '../..'}${page.brand.logo}` : undefined;
  /* A fixed box, as the shell draws it: the line is the same height with the picture or without it. */
  const mark = logo ? `<img src="${escape(logo)}" alt="${escape(app)}" width="96" height="24">` : escape(app);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
<title>${escape(title)} · ${escape(app)}</title><style nonce="${page.nonce}">${STYLE}${brandStyle(page.brand)}</style></head>
<body><main><p class="app">${mark}</p><h1>${escape(title)}</h1>${body}${reply}</main></body></html>`;
}

/* The tool's ground, ink and lines (docs/design.md), light and dark; square, quiet, spaced by ratio. The unsubscribe
   page (unsubscribe.ts) wears it too. */
export const STYLE = `:root{--bg:#f7f7f5;--surface:#fff;--border:#e3e3df;--border-control:#c9c9c3;--text:#1d1d1b;--text-dim:#5f5f5a;--accent:#2b5bd7;--ok:#1f7a4d;--danger:#b42318;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--surface:#1c1c1a;--border:#2e2e2b;--border-control:#45453f;--text:#ececea;--text-dim:#a3a39d;--accent:#7ea2ff;--ok:#5cc18f;--danger:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:680px;margin:0 auto;padding:32px 16px 48px}.app{margin:0 0 6px;color:var(--text-dim);font-size:13px}
h1{margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-.012em;overflow-wrap:anywhere}h2{margin:28px 0 10px;font-size:15px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 20px;margin:0 0 16px}dt{color:var(--text-dim)}dd{margin:0;overflow-wrap:anywhere}
.prose{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 12px}
article{background:var(--surface);border:1px solid var(--border);padding:12px 14px;margin:0 0 8px}article dl{margin-bottom:6px}
form{margin-top:28px;display:grid;gap:8px}label{font-weight:600}
textarea{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--border-control);padding:8px 10px;resize:vertical;width:100%}
textarea:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{justify-self:start;font:inherit;font-weight:600;color:var(--on-accent,#fff);background:var(--accent);border:0;padding:7px 14px;cursor:pointer}
.app img{display:block;width:96px;height:24px;object-fit:contain;object-position:left center}
.ok{color:var(--ok);margin:0}.problem{color:var(--danger);margin:0}`;
