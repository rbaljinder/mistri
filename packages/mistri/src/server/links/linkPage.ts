/**
 * The page a capability link opens (linkRoutes.ts): the record's shown
 * columns, a form per declared command, or the gate its holder passes first.
 *
 * Server-drawn, in the mail link page's dress (email/mailLinkPage.ts), with a
 * small nonce'd script and nothing else: the page loads no App bundle, so a
 * link's holder is handed no more of the App than the one record. The script
 * carries the link session in a header on each POST (the cookie alone would
 * ride on any same-site request), asks the server for the revision each
 * command runs against, and never for a field's initial value.
 */
import type { AppCommandField } from '../../shared/command.js';
import { FRAMEWORK_WORDS, type FrameworkWordKey } from '@mistriwork/engine/shared/frameworkWords.js';
import { STYLE } from '../email/mailLinkPage.js';

export const LINK_SESSION_HEADER = 'x-mistri-link';

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface LinkPageCommand {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly AppCommandField[];
}

/** One of a link's `related` lists, as drawn: its title, its columns' labels, and each row's values said. */
export interface LinkPageRelated {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** The App's languages, where it has words in two or more: the page draws a switch between them. */
interface LinkPageLanguages {
  readonly offered: readonly string[];
  readonly current: string;
  /** The App's locale cookie (shared/appLocale.ts localeCookieName), set as the shell's picker sets it. */
  readonly cookie: string;
}

type LinkPage = {
  readonly app: string;
  readonly nonce: string;
  /** The platform's words as the App's catalog says them in the holder's language (appMessages.ts frameworkWords). */
  readonly words?: Readonly<Record<string, string>>;
  /** The holder's language tag, for `<html lang>`. */
  readonly lang?: string;
  readonly languages?: LinkPageLanguages;
} & (
  | { readonly state: 'miss' }
  | {
      readonly state: 'confirm' | 'stepUp' | 'record';
      /** The link's own address, `/<app>/l/<id>` as the browser sees it: the POSTs go under it. */
      readonly base: string;
      readonly session: string;
      readonly title: string;
      readonly confirm?: readonly { column: string; label: string }[];
      readonly shown?: readonly { label: string; value: string }[];
      readonly related?: readonly LinkPageRelated[];
      readonly commands?: readonly LinkPageCommand[];
      /** The step-up's channel when it is not email (`sms`): the page says it texts the number on file. */
      readonly channel?: string;
    }
);

/** What every miss answers, word for word: unknown, wrong, revoked, expired and spent are one page (in each language). */
export const LINK_MISS = FRAMEWORK_WORDS['mistri.link.miss'];

export function linkPagePolicy(nonce: string): string {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

/* The mail page's controls are a textarea and a button; a link's command asks a few more. */
const MORE_STYLE = `input,select{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--border-control);padding:7px 10px;width:100%}
input[type=checkbox]{width:auto;justify-self:start}input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.help{color:var(--text-dim);font-size:13px;margin:-4px 0 0}form h2{margin:0}form+form{margin-top:36px}
table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 16px}th,td{text-align:left;vertical-align:top;padding:6px 12px 6px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
th{color:var(--text-dim);font-weight:400}
footer{max-width:680px;margin:0 auto;padding:0 16px 32px;display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--text-dim);font-size:13px}
footer a{color:inherit}footer a[aria-current]{color:var(--text);font-weight:600;text-decoration:none}`;

/** A language as it calls itself ("Español"), as the shell's picker names it (kit Prefs.tsx ownName). */
function ownName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

function control(field: AppCommandField, form: string, choose: string): string {
  const id = `${form}-${field.name}`;
  const required = field.required ? ' required' : '';
  const name = `name="${escape(field.name)}" id="${escape(id)}"`;
  const label = `<label for="${escape(id)}">${escape(field.label)}</label>`;
  const help = field.help ? `<p class="help">${escape(field.help)}</p>` : '';
  switch (field.type) {
    case 'textarea':
      return `${label}<textarea ${name} rows="4"${required}${field.maxLength ? ` maxlength="${field.maxLength}"` : ''}></textarea>${help}`;
    case 'text':
      return `${label}<input type="text" ${name}${required}${field.maxLength ? ` maxlength="${field.maxLength}"` : ''}>${help}`;
    case 'number':
      return `${label}<input type="number" data-kind="number" ${name}${required}${field.min !== undefined ? ` min="${field.min}"` : ''}${
        field.max !== undefined ? ` max="${field.max}"` : ''
      } step="${field.step ?? (field.integer ? 1 : 'any')}">${help}`;
    case 'date':
      return `${label}<input type="date" ${name}${required}${field.min ? ` min="${escape(field.min)}"` : ''}${field.max ? ` max="${escape(field.max)}"` : ''}>${help}`;
    case 'boolean':
      return `${label}<input type="checkbox" data-kind="boolean" ${name}${field.accept ? ' required' : ''}>${help}`;
    case 'choice':
      // Each option's value is its JSON, so a numeric choice goes back a number.
      return `${label}<select data-kind="json" ${name}${required}><option value="">${escape(choose)}</option>${field.options
        .map((option) => `<option value="${escape(JSON.stringify(option.value))}">${escape(option.label)}</option>`)
        .join('')}</select>${help}`;
    default:
      return '';
  }
}

/* One script for every state: a gate's form posts and reloads; a command's form posts its input with the revision
   /prepare answered. The session rides in a header and is replaced by the one each answer carries. */
const SCRIPT = `(()=>{const main=document.querySelector('main[data-base]');if(!main)return;const base=main.dataset.base;let session=main.dataset.session;const versions={};
const say=(form,text,ok)=>{const p=form.querySelector('[data-say]');p.className=ok?'ok':'problem';p.setAttribute('role',ok?'status':'alert');p.textContent=text;};
const post=async(path,body)=>{const r=await fetch(base+'/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','${LINK_SESSION_HEADER}':session},body:JSON.stringify(body)});let b={};try{b=await r.json();}catch{}if(typeof b.session==='string')session=b.session;return{ok:r.ok,body:b};};
const failed=(b)=>(b&&(b.error||b.message))||main.dataset.failed;
const random=()=>{const a=new Uint8Array(18);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');};
const forms=[...document.querySelectorAll('form[data-command]')];let ready=false;const refused={};
if(forms.length)post('prepare',{}).then(({ok,body})=>{if(ok&&body.commands){Object.assign(versions,body.commands);Object.assign(refused,body.refused||{});ready=true;}});
for(const form of forms){const key=random();form.addEventListener('submit',async(e)=>{e.preventDefault();const command=form.dataset.command;const input={};
for(const el of form.elements){if(!el.name)continue;const kind=el.dataset.kind;if(kind==='boolean'){input[el.name]=el.checked;continue;}if(el.value==='')continue;input[el.name]=kind==='number'?Number(el.value):kind==='json'?JSON.parse(el.value):el.value;}
const v=versions[command];if(!v){say(form,ready?(refused[command]||main.dataset.notNow):main.dataset.loading,false);return;}
const button=form.querySelector('button');button.disabled=true;const {ok,body}=await post('run',{command,expectedVersion:v.expectedVersion,idempotencyKey:key,input});button.disabled=false;
if(ok){say(form,main.dataset.done,true);setTimeout(()=>location.reload(),900);}else say(form,failed(body),false);});}
for(const form of document.querySelectorAll('form[data-gate]')){form.addEventListener('submit',async(e)=>{e.preventDefault();const gate=form.dataset.gate;const fields=Object.fromEntries([...form.elements].filter((el)=>el.name).map((el)=>[el.name,el.value]));
const body=gate==='confirm'?{confirm:fields}:gate==='send'?{send:true}:{code:fields.code};const {ok,body:answer}=await post(gate==='confirm'?'confirm':'stepup',body);
if(gate==='send'){say(form,ok?form.dataset.sent:failed(answer),ok);return;}
if(ok)location.reload();else say(form,failed(answer),false);});}})();`;

/* The language switch: plain links to the page in each language, so it works without the script; the script also
   keeps the pick in the App's locale cookie, as the shell's picker does, so the page's own requests (a command's
   ctx.locale) are said in it too. */
const LANGUAGE_SCRIPT = `for(const a of document.querySelectorAll('footer a[data-locale]'))a.addEventListener('click',()=>{const f=a.closest('footer');document.cookie=[f.dataset.cookie+'='+encodeURIComponent(a.dataset.locale),'path=/','max-age=31536000','samesite=lax',...(location.protocol==='https:'?['secure']:[])].join(';');});`;

function languageSwitch(languages: LinkPageLanguages, label: string): string {
  const links = languages.offered.map((tag) => {
    const current = tag === languages.current ? ' aria-current="true"' : '';
    return `<a href="?locale=${encodeURIComponent(tag)}" data-locale="${escape(tag)}" lang="${escape(tag)}" hreflang="${escape(tag)}"${current}>${escape(ownName(tag))}</a>`;
  });
  return `<footer data-cookie="${escape(languages.cookie)}"><nav aria-label="${escape(label)}">${links.join(' ')}</nav></footer>`;
}

export function linkPage(page: LinkPage): string {
  const word = (key: FrameworkWordKey) => {
    const said = page.words?.[key];
    return typeof said === 'string' ? said : FRAMEWORK_WORDS[key];
  };
  let title: string;
  let body = '';
  let data = '';
  if (page.state === 'miss') title = word('mistri.link.miss');
  else {
    title = page.title;
    data =
      ` data-base="${escape(page.base)}" data-session="${escape(page.session)}"` +
      ` data-failed="${escape(word('mistri.link.failed'))}" data-not-now="${escape(word('mistri.link.notNow'))}"` +
      ` data-loading="${escape(word('mistri.link.loading'))}" data-done="${escape(word('mistri.link.done'))}"`;
    const say = '<p data-say aria-live="polite"></p>';
    const next = escape(word('mistri.link.continue'));
    if (page.state === 'confirm')
      body =
        `<form data-gate="confirm"><p>${escape(word('mistri.link.confirmLead'))}</p>` +
        (page.confirm ?? [])
          .map(
            (item, at) =>
              `<label for="confirm-${at}">${escape(item.label)}</label><input type="text" id="confirm-${at}" name="${escape(item.column)}" required autocomplete="off">`,
          )
          .join('') +
        `${say}<button type="submit">${next}</button></form>`;
    else if (page.state === 'stepUp')
      body =
        (page.channel === undefined
          ? `<form data-gate="send" data-sent="${escape(word('mistri.link.sentEmail'))}"><p>${escape(word('mistri.link.offerEmail'))}</p>${say}<button type="submit">${escape(word('mistri.link.askEmail'))}</button></form>`
          : `<form data-gate="send" data-sent="${escape(word('mistri.link.sentText'))}"><p>${escape(word('mistri.link.offerText'))}</p>${say}<button type="submit">${escape(word('mistri.link.askText'))}</button></form>`) +
        `<form data-gate="code"><label for="code">${escape(word('mistri.link.code'))}</label><input type="text" id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="12">${say}<button type="submit">${next}</button></form>`;
    else {
      body = `<dl>${(page.shown ?? []).map((item) => `<dt>${escape(item.label)}</dt><dd>${escape(item.value)}</dd>`).join('')}</dl>`;
      // A list with no rows is not drawn: a heading over nothing says less than its absence.
      for (const list of page.related ?? []) {
        if (!list.rows.length) continue;
        body += `<h2>${escape(list.title)}</h2>`;
        body += `<table><thead><tr>${list.columns.map((column) => `<th scope="col">${escape(column)}</th>`).join('')}</tr></thead><tbody>${list.rows
          .map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`;
      }
      body += (page.commands ?? [])
        .map(
          (command, at) =>
            `<form data-command="${escape(command.id)}"><h2>${escape(command.label)}</h2>${command.fields.map((field) => control(field, `c${at}`, word('mistri.link.choose'))).join('')}${say}<button type="submit">${escape(command.label)}</button></form>`,
        )
        .join('');
    }
  }
  const languages = page.languages && page.languages.offered.length > 1 ? page.languages : undefined;
  const code = (page.state === 'miss' ? '' : SCRIPT) + (languages ? LANGUAGE_SCRIPT : '');
  const script = code ? `<script nonce="${page.nonce}">${code}</script>` : '';
  const footer = languages ? languageSwitch(languages, word('mistri.language')) : '';
  return `<!doctype html><html lang="${escape(page.lang ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
<title>${escape(title)} · ${escape(page.app)}</title><style nonce="${page.nonce}">${STYLE}
${MORE_STYLE}</style></head>
<body><main${data}><p class="app">${escape(page.app)}</p><h1>${escape(title)}</h1>${body}</main>${footer}${script}</body></html>`;
}
