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
import { STYLE } from '../email/mailLinkPage.js';

export const LINK_SESSION_HEADER = 'x-mistri-link';

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface LinkPageCommand {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly AppCommandField[];
}

type LinkPage = {
  readonly app: string;
  readonly nonce: string;
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
      readonly commands?: readonly LinkPageCommand[];
      /** The step-up's channel when it is not email (`sms`): the page says it texts the number on file. */
      readonly channel?: string;
    }
);

/** What every miss answers, word for word: unknown, wrong, revoked, expired and spent are one page. */
export const LINK_MISS = 'This link opens nothing.';

export function linkPagePolicy(nonce: string): string {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

/* The mail page's controls are a textarea and a button; a link's command asks a few more. */
const MORE_STYLE = `input,select{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--border-control);padding:7px 10px;width:100%}
input[type=checkbox]{width:auto;justify-self:start}input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.help{color:var(--text-dim);font-size:13px;margin:-4px 0 0}form h2{margin:0}form+form{margin-top:36px}`;

function control(field: AppCommandField, form: string): string {
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
      return `${label}<select data-kind="json" ${name}${required}><option value="">Choose…</option>${field.options
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
const failed=(b)=>(b&&(b.error||b.message))||'That did not work. Try again.';
const random=()=>{const a=new Uint8Array(18);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');};
const forms=[...document.querySelectorAll('form[data-command]')];let ready=false;const refused={};
if(forms.length)post('prepare',{}).then(({ok,body})=>{if(ok&&body.commands){Object.assign(versions,body.commands);Object.assign(refused,body.refused||{});ready=true;}});
for(const form of forms){const key=random();form.addEventListener('submit',async(e)=>{e.preventDefault();const command=form.dataset.command;const input={};
for(const el of form.elements){if(!el.name)continue;const kind=el.dataset.kind;if(kind==='boolean'){input[el.name]=el.checked;continue;}if(el.value==='')continue;input[el.name]=kind==='number'?Number(el.value):kind==='json'?JSON.parse(el.value):el.value;}
const v=versions[command];if(!v){say(form,ready?(refused[command]||'This cannot be done now.'):'This page is still loading. Try again in a moment.',false);return;}
const button=form.querySelector('button');button.disabled=true;const {ok,body}=await post('run',{command,expectedVersion:v.expectedVersion,idempotencyKey:key,input});button.disabled=false;
if(ok){say(form,'Done.',true);setTimeout(()=>location.reload(),900);}else say(form,failed(body),false);});}
for(const form of document.querySelectorAll('form[data-gate]')){form.addEventListener('submit',async(e)=>{e.preventDefault();const gate=form.dataset.gate;const fields=Object.fromEntries([...form.elements].filter((el)=>el.name).map((el)=>[el.name,el.value]));
const body=gate==='confirm'?{confirm:fields}:gate==='send'?{send:true}:{code:fields.code};const {ok,body:answer}=await post(gate==='confirm'?'confirm':'stepup',body);
if(gate==='send'){say(form,ok?form.dataset.sent:failed(answer),ok);return;}
if(ok)location.reload();else say(form,failed(answer),false);});}})();`;

export function linkPage(page: LinkPage): string {
  let title: string;
  let body = '';
  let data = '';
  if (page.state === 'miss') title = LINK_MISS;
  else {
    title = page.title;
    data = ` data-base="${escape(page.base)}" data-session="${escape(page.session)}"`;
    const say = '<p data-say aria-live="polite"></p>';
    if (page.state === 'confirm')
      body =
        `<form data-gate="confirm"><p>To see this, first confirm a detail only you would know.</p>` +
        (page.confirm ?? [])
          .map(
            (item, at) =>
              `<label for="confirm-${at}">${escape(item.label)}</label><input type="text" id="confirm-${at}" name="${escape(item.column)}" required autocomplete="off">`,
          )
          .join('') +
        `${say}<button type="submit">Continue</button></form>`;
    else if (page.state === 'stepUp')
      body =
        (page.channel === undefined
          ? `<form data-gate="send" data-sent="If the address on file takes mail, a code is on its way. It works for ten minutes."><p>To see this, we email a code to the address on file.</p>${say}<button type="submit">Email me a code</button></form>`
          : `<form data-gate="send" data-sent="If the number on file takes messages, a code is on its way. It works for ten minutes."><p>To see this, we send a code to the number on file.</p>${say}<button type="submit">Send me a code</button></form>`) +
        `<form data-gate="code"><label for="code">Code</label><input type="text" id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="12">${say}<button type="submit">Continue</button></form>`;
    else {
      body = `<dl>${(page.shown ?? []).map((item) => `<dt>${escape(item.label)}</dt><dd>${escape(item.value)}</dd>`).join('')}</dl>`;
      body += (page.commands ?? [])
        .map(
          (command, at) =>
            `<form data-command="${escape(command.id)}"><h2>${escape(command.label)}</h2>${command.fields.map((field) => control(field, `c${at}`)).join('')}${say}<button type="submit">${escape(command.label)}</button></form>`,
        )
        .join('');
    }
  }
  const script = page.state === 'miss' ? '' : `<script nonce="${page.nonce}">${SCRIPT}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
<title>${escape(title)} · ${escape(page.app)}</title><style nonce="${page.nonce}">${STYLE}
${MORE_STYLE}</style></head>
<body><main${data}><p class="app">${escape(page.app)}</p><h1>${escape(title)}</h1>${body}</main>${script}</body></html>`;
}
