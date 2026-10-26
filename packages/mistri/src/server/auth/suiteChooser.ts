/** A small suite-owned sign-in and authorized App chooser. App/tenant data is
 * never embedded in this page: the current session asks the grant owner. Its
 * style is inline under the nonce, in the tool's quiet tokens (as the mail
 * link page's is): no script or sheet loads from elsewhere, and no App's
 * client bundle is fetched to draw a list of links. */
import { suiteAdministrationMarkup, suiteAdministrationScript } from './suiteAdministrationPage.js';
/** `denied` names the App a carried deep link pointed at, which the signed-in account cannot open. */
export function suiteChooserPage(name: string, basePath: string, nonce: string, rootAppId?: string, denied?: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const base = JSON.stringify(basePath).replace(/</g, '\\u003c');
  const root = JSON.stringify(rootAppId ?? null).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escape(name)}</title><style nonce="${nonce}">
:root{--ground:#f7f7f5;--surface:#fff;--line:#e3e3df;--line-control:#c9c9c3;--ink:#1d1d1b;--ink-muted:#5f5f5a;--accent:#2b5bd7;--link:#2b5bd7;--status-critical:#b42318;--radius:0;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--ground:#141413;--surface:#1c1c1a;--line:#2e2e2b;--line-control:#45453f;--ink:#ececea;--ink-muted:#a3a39d;--accent:#7ea2ff;--link:#7ea2ff;--status-critical:#ff8a7a}}
*{box-sizing:border-box}body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:0 16px;color:var(--ink);background:var(--ground)}
main{max-width:560px;margin:8vh auto 48px}h1{margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-.012em;overflow-wrap:anywhere}h2{margin:28px 0 10px;font-size:15px}
label{display:block;margin:12px 0;font-weight:600}input,select{font:inherit;font-weight:400;color:inherit;background:var(--surface);border:1px solid var(--line-control);border-radius:var(--radius);padding:8px 10px}input{width:100%;display:block;margin-top:4px}
button{font:inherit;font-weight:600;cursor:pointer;margin:8px 8px 8px 0;padding:7px 14px;color:var(--ink);background:var(--surface);border:1px solid var(--line-control);border-radius:var(--radius)}button[value=sign-in]{color:#fff;background:var(--accent);border-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}a{color:var(--link)}code{overflow-wrap:anywhere;color:var(--ink-muted)}[hidden]{display:none!important}#status,#preference-status,#management-message{color:var(--ink-muted)}
#links{list-style:none;margin:0;padding:0;border-top:2px solid var(--ink)}#links li{padding:12px 0 12px 12px;border-bottom:1px solid var(--line);border-left:3px solid var(--app-accent,transparent)}#links li>a:first-of-type{font-weight:600;text-decoration:none}#links li>a:first-of-type:hover{text-decoration:underline}#links svg{width:16px;height:16px;margin-right:8px;vertical-align:-3px;fill:var(--ink-muted)}
#denied{margin:0 0 16px;padding:8px 0 8px 12px;border-left:3px solid var(--status-critical)}#empty{margin:0 0 16px}
fieldset{min-width:0;border:1px solid var(--line)}input[type=checkbox]{width:auto;display:inline;margin:0 6px 0 0}select{max-width:100%}section p,li{overflow-wrap:anywhere}button:disabled{cursor:default;opacity:.6}#management{border-top:1px solid var(--line);margin-top:24px}#management-invitations{padding-left:20px}
</style></head><body><main><h1>${escape(name)}</h1><p id="status" role="status">Checking your session…</p>
<form id="login" hidden><label>Name (for a new account)<input name="name" autocomplete="name"></label><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label><button type="submit" value="sign-in">Sign in</button><button type="submit" value="sign-up">Create account</button></form>
${denied ? `<p id="denied" role="alert" hidden>Your account has no access to ${escape(denied)}. Open another App, or sign out and sign in with an account that has it.</p>` : ''}
<section id="apps" hidden><h2 id="apps-title">Your Apps</h2><ul id="links"></ul><p id="empty" hidden>No App access has been granted yet. Ask an App administrator to grant access to your account ID, or sign out and use another account.</p><p>Account ID: <code id="account"></code></p>
<form id="preference"><label for="default-app">Default App</label><select id="default-app"></select><button id="save-default" type="submit">Save default App</button><p id="preference-status" role="status"></p></form>
<button id="logout" type="button">Sign out of the suite</button></section>
<section id="invitation" hidden><h2>App invitation</h2><p id="invited-app"></p><button id="accept" type="button">Accept invitation</button></section>
${suiteAdministrationMarkup}
</main><script nonce="${nonce}">
const base=${base},rootAppId=${root}, status=document.getElementById('status'), login=document.getElementById('login'), apps=document.getElementById('apps');
let accountId=null,refreshSequence=0,presented=null;
// The notice open App tabs listen for (sessionLifecycle.ts): it carries no account, only that the session changed.
function announce(){try{localStorage.setItem('mistri.session-change.v1',crypto.randomUUID());}catch{}}
// A carried deep link: after a sign-in the server decides again whether this account may follow it.
const carried=new URLSearchParams(location.search).getAll('next').length===1;
const invitation=document.getElementById('invitation');
function invitationFromAddress(){const match=/^#invite=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]{43})$/.exec(location.hash);return match?{appId:match[1],token:match[2]}:null;}
let pending=invitationFromAddress();
function entryFromAddress(){
 if(location.hash)return null;
 const query=new URLSearchParams(location.search),entries=query.getAll('entry'),selected=query.getAll('app');
 if(entries.length!==1||entries[0]!=='1'||selected.length>1||Array.from(query.keys()).some(key=>key!=='entry'&&key!=='app'))return null;
 if(selected.length&&(!rootAppId||selected[0]!==rootAppId))return null;
 return base+'/'+(selected.length?'?app='+encodeURIComponent(rootAppId):'');
}
${suiteAdministrationScript()}
const preferenceUI=(()=>{
 const form=document.getElementById('preference'),select=document.getElementById('default-app'),button=document.getElementById('save-default'),message=document.getElementById('preference-status');
 let owner=null,generation=0,busy=false;
 const current=(chosen,sequence)=>owner===chosen&&generation===sequence;
 function controls(){select.disabled=busy;button.disabled=busy||!owner||(select.value!==''&&!owner.apps.includes(select.value));}
 function retire(){generation++;owner=null;busy=false;form.hidden=true;select.replaceChildren();message.textContent='';controls();}
 function present(account,apps,preference){
  retire();owner={accountId:account,apps:apps.map(app=>app.id),revision:preference.revision};
  const option=(value,text)=>{const item=document.createElement('option');item.value=value;item.textContent=text;select.append(item);};
  option('','Ask each time');for(const app of apps)option(app.id,app.name);
  if(preference.defaultApp&&!owner.apps.includes(preference.defaultApp))option(preference.defaultApp,'Unavailable App — choose another default');
  select.value=preference.defaultApp??'';form.hidden=false;
  if(preference.revision===0)message.textContent='No default saved yet. Save a preference to change the suite’s normal entry.';
  controls();
 }
 async function readCurrent(chosen){
  const response=await fetch(base+'/api/suite/preferences',{cache:'no-store',headers:{'x-mistri-account':chosen.accountId}});
  const data=await response.json();if(!response.ok||data.accountId!==chosen.accountId)throw new Error('Your account or preference changed. Reload the chooser.');return data;
 }
 select.addEventListener('change',controls);
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(!owner||busy||button.disabled)return;
  const chosen=owner,sequence=generation,defaultApp=select.value||null;busy=true;controls();message.textContent='Saving default App…';
  try{
   const response=await fetch(base+'/api/suite/preferences',{method:'POST',headers:{'content-type':'application/json','x-mistri-account':chosen.accountId},body:JSON.stringify({defaultApp,expectedRevision:chosen.revision})});
   const data=await response.json();if(!current(chosen,sequence))return;
   if(response.status===409){const latest=await readCurrent(chosen);if(!current(chosen,sequence))return;chosen.revision=latest.revision;message.textContent='The default changed elsewhere. Your selection is preserved. Review it and save again.';return;}
   if(!response.ok||data.accountId!==chosen.accountId)throw new Error(data.error||'The default App could not be saved.');
   chosen.revision=data.revision;message.textContent='Default App saved. Opening an App here does not change it.';
  }catch(error){if(current(chosen,sequence)){owner=null;message.textContent=error.message+' Reload the chooser before retrying.';}}
  finally{if(generation===sequence){busy=false;controls();}}
 });
 return {retire,present};
})();
async function refresh(){
 const sequence=++refreshSequence;
 administration.retire();
 preferenceUI.retire();
 const response=await fetch(base+'/api/suite/apps',{cache:'no-store'});
 if(sequence!==refreshSequence)return;
 if(response.status===401){accountId=null;presented=null;login.hidden=false;apps.hidden=true;const denied=document.getElementById('denied');if(denied)denied.hidden=true;invitation.hidden=true;status.textContent=pending?'Sign in to accept your App invitation.':'Sign in once to access your Apps.';return;}
 if(!response.ok)throw new Error('Your App access could not be checked. Try again.');
 const data=await response.json();if(sequence!==refreshSequence)return;accountId=data.accountId;login.hidden=true;apps.hidden=false;
 document.getElementById('account').textContent=accountId;const links=document.getElementById('links');links.replaceChildren();
 for(const app of data.apps){const item=document.createElement('li'),link=document.createElement('a');link.textContent=app.name;link.href=app.href;if(Array.isArray(app.icon)&&app.icon.length){const mark=document.createElementNS('http://www.w3.org/2000/svg','svg');mark.setAttribute('viewBox','0 0 256 256');mark.setAttribute('aria-hidden','true');mark.setAttribute('focusable','false');for(const d of app.icon){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',String(d));mark.append(path);}item.append(mark);}const accent=app.accent&&(matchMedia('(prefers-color-scheme: dark)').matches?app.accent.dark:app.accent.light);if(typeof accent==='string'&&/^#[0-9a-f]{6}$/i.test(accent))item.style.setProperty('--app-accent',accent);item.append(link);if(app.manageHref){const manage=document.createElement('a');manage.textContent='Manage access for '+app.name;manage.href=app.manageHref;item.append(document.createTextNode(' — '),manage);}links.append(item);}
 administration.present(accountId,data.apps,Boolean(data.emailAvailable));
 preferenceUI.present(accountId,data.apps,data.preference??{defaultApp:null,revision:0});
 const none=data.apps.length===0;document.getElementById('empty').hidden=!none;document.getElementById('apps-title').hidden=none;document.getElementById('links').hidden=none;document.getElementById('preference').hidden=none;
 const denied=document.getElementById('denied');if(denied)denied.hidden=false;status.textContent='Signed in.';
 presented=pending;invitation.hidden=!presented;if(presented){document.getElementById('invited-app').textContent='Invitation for '+presented.appId+'.';document.getElementById('accept').disabled=false;}
}
let signingIn=false;
login.addEventListener('submit',async event=>{event.preventDefault();if(signingIn)return;signingIn=true;for(const button of login.querySelectorAll('button'))button.disabled=true;
 const action=event.submitter.value,fields=new FormData(login),continuation=entryFromAddress(),sequence=refreshSequence;
 const body={email:fields.get('email'),password:fields.get('password')};if(action==='sign-up')body.name=fields.get('name');
 try{const response=await fetch(base+'/api/auth/'+action+'/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 if(!response.ok){status.textContent='Sign-in could not be completed. Check your details.';return;}login.elements.password.value='';announce();
 if(carried&&!location.hash&&sequence===refreshSequence){location.reload();return;}
 if(continuation&&sequence===refreshSequence&&continuation===entryFromAddress()){
  history.replaceState(null,'',location.pathname);location.assign(continuation);return;
 }
 await refresh();}
 catch{status.textContent='Sign-in could not be confirmed. Reload before trying again.';}
 finally{signingIn=false;for(const button of login.querySelectorAll('button'))button.disabled=false;}
});
document.getElementById('logout').addEventListener('click',async()=>{administration.retire();preferenceUI.retire();refreshSequence++;try{const response=await fetch(base+'/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json','x-mistri-account':accountId},body:'{}'});if(!response.ok)throw new Error();announce();await refresh();}catch{status.textContent='Sign-out could not be confirmed. Reload to check your session.';}});
document.getElementById('accept').addEventListener('click',async()=>{if(!presented||presented!==pending||!accountId)return;const chosen=presented,subject=accountId,button=document.getElementById('accept');button.disabled=true;
 try{const response=await fetch(base+'/api/suite/invitations/accept',{method:'POST',headers:{'content-type':'application/json','x-mistri-account':subject},body:JSON.stringify(chosen)});
 if(pending!==chosen||accountId!==subject)return;if(!response.ok)throw new Error();pending=null;presented=null;history.replaceState(null,'',location.pathname);await refresh();if(pending)return;invitation.hidden=true;status.textContent='Invitation accepted.';}
 catch{if(pending!==chosen||accountId!==subject)return;status.textContent='The invitation is unavailable or belongs to another account. Ask its App administrator.';button.disabled=false;}
});
refresh().catch(error=>{status.textContent=error.message;});
addEventListener('hashchange',()=>{pending=invitationFromAddress();presented=null;invitation.hidden=true;document.getElementById('accept').disabled=true;refresh().catch(error=>{status.textContent=error.message;});});
</script></body></html>`;
}
