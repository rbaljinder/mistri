/** Chooser-owned access management. The page holds no account directory and
 * never treats a displayed capability or a cached revision as authority. */
import { SUITE_INVITATIONS_MAX_OFFSET, SUITE_INVITATIONS_PAGE } from '../../shared/suiteAdministration.js';

export const suiteAdministrationMarkup = `
<section id="management" hidden aria-labelledby="management-title">
 <h2 id="management-title">Manage App access</h2>
 <p>Manage access to <strong id="management-app"></strong> only. Enter the existing suite account ID shown in the recipient’s chooser.</p>
 <form id="management-lookup"><label>Subject account ID<input id="management-subject" autocomplete="off" maxlength="1024" required></label><button id="management-load" type="submit">Load access</button></form>
 <p id="management-message" role="status"></p>
 <section id="management-editor" hidden>
  <p id="management-current"></p>
  <fieldset id="management-roles"><legend>App roles</legend></fieldset>
  <button id="management-save" type="button">Save App access</button><button id="management-revoke" type="button">Revoke App access</button>
  <label>Invitation lifetime<select id="management-lifetime"><option value="3600000">1 hour</option><option value="86400000" selected>1 day</option><option value="604740000">Up to 7 days</option></select></label>
  <label id="management-delivery" hidden><input id="management-email" type="checkbox"> Email invitation to this account</label>
  <button id="management-issue" type="button">Create invitation</button>
  <section id="management-issued" hidden><h3>Invitation created</h3><p>Copy this link now. It can only be accepted by the selected account.</p><label>Invitation link<input id="management-link" readonly></label><p>Invitation ID: <code id="management-issued-id"></code></p><button id="management-copy" type="button">Copy invitation link</button></section>
  <h3>Invitations for this account</h3><ul id="management-invitations"></ul><p id="management-empty" hidden>No invitations for this account.</p>
  <nav aria-label="Invitation pages"><button id="management-previous" type="button">Previous invitations</button><span id="management-page"></span><button id="management-next" type="button">Next invitations</button></nav>
 </section>
</section>`;

/** Runs in the chooser's nonce-bearing script. Each request captures an owner
 * object and generation; navigating, editing the subject, or retiring the
 * session makes every old completion inert, including clipboard completions. */
export function suiteAdministrationScript(): string {
  return `
const administration=(()=>{
 const element=id=>document.getElementById('management-'+id), panel=document.getElementById('management');
 const subject=element('subject'),message=element('message'),editor=element('editor');
 let owner=null,generation=0,busy=false,stale=true,grant=null,draft=null,offset=0,total=0;
 const current=(chosen,sequence)=>owner===chosen&&generation===sequence;
 function say(text){message.textContent=text;}
 function clearIssued(){element('issued').hidden=true;element('link').value='';element('issued-id').textContent='';}
 function controls(){
  element('load').disabled=busy||!subject.value;
  for(const id of ['save','revoke','issue'])element(id).disabled=busy||stale||!grant||(id==='issue'&&!draft?.length)||(id!=='revoke'&&draft?.some(role=>!grant.assignableRoles.includes(role)));
  for(const input of element('roles').querySelectorAll('input'))input.disabled=busy;
  element('lifetime').disabled=busy;
  element('email').disabled=busy;
  element('previous').disabled=busy||offset===0;
  element('next').disabled=busy||offset+${SUITE_INVITATIONS_PAGE}>=total||offset+${SUITE_INVITATIONS_PAGE}>${SUITE_INVITATIONS_MAX_OFFSET};
  for(const button of element('invitations').querySelectorAll('button'))button.disabled=busy||stale;
 }
 function retire(){
  generation++;owner=null;busy=false;stale=true;grant=null;draft=null;offset=0;total=0;
  panel.hidden=true;editor.hidden=true;subject.value='';element('email').checked=false;element('delivery').hidden=true;say('');clearIssued();element('current').textContent='';element('app').textContent='';element('invitations').replaceChildren();element('roles').replaceChildren();
 }
 function present(account,apps,emailAvailable=false){
  retire();const match=/^#manage=([A-Za-z0-9_-]+)$/.exec(location.hash);if(!match)return;
  const app=apps.find(item=>item.id===match[1]&&item.manageHref);if(!app)return;
  owner={accountId:account,appId:app.id,api:new URL(app.href,location.origin).pathname.replace(/\\/$/,'')+'/api/suite/',subjectId:''};
  element('app').textContent=app.name;panel.hidden=false;element('delivery').hidden=!emailAvailable;controls();
 }
 async function request(chosen,path,body){
  const response=await fetch(chosen.api+path,{method:'POST',cache:'no-store',headers:{'content-type':'application/json','x-mistri-account':chosen.accountId},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok){const error=new Error(data.error||'App access could not be checked.');error.status=response.status;error.accountChanged=data.error==='The signed-in account changed.';throw error;}return data;
 }
 function sessionChanged(error){
  if(error.status!==401&&!error.accountChanged)return false;
  retire();refresh().catch(error=>{status.textContent=error.message;});return true;
 }
 function matches(data,chosen){return data.accountId===chosen.accountId&&data.appId===chosen.appId&&data.subjectId===chosen.subjectId;}
 function drawRoles(){
  const field=element('roles');field.replaceChildren();const legend=document.createElement('legend');legend.textContent='App roles';field.append(legend);
   for(const role of new Set([...grant.assignableRoles,...draft])){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=role;input.checked=draft.includes(role);
    input.addEventListener('change',()=>{draft=input.checked?[...draft,role]:draft.filter(value=>value!==role);controls();});label.append(input,document.createTextNode(' '+role+(grant.assignableRoles.includes(role)?'':' (no longer available)')));field.append(label);}
 }
 const statuses={'pending':'Pending','consumed':'Accepted','revoked':'Revoked','expired':'Expired','issuer-changed':'Unavailable: issuing administrator changed','target-changed':'Unavailable: account access changed','roles-changed':'Unavailable: App roles changed','not-yet-valid':'Not yet valid'};
 function drawInvitations(page){
  const list=element('invitations');list.replaceChildren();offset=page.offset;total=page.total;
  for(const item of page.invitations){const row=document.createElement('li'),description=document.createElement('p');
   if(item.id===element('issued-id').textContent&&item.status!=='pending')clearIssued();
   description.textContent=item.roles.join(', ')+' — '+statuses[item.status]+'. Expires '+new Date(item.expiresAt).toLocaleString()+'. Invitation '+item.id+'. Issuer '+item.actorId+'.';row.append(description);
   if(item.canRevoke){const button=document.createElement('button');button.type='button';button.textContent='Revoke invitation';button.addEventListener('click',()=>mutate('invitations/revoke',{id:item.id}));row.append(button);}list.append(row);}
  element('empty').hidden=page.invitations.length>0;element('page').textContent=total?String(offset+1)+'–'+String(offset+page.invitations.length)+' of '+total:'0 invitations';
 }
 async function load(keep=false,from=0,success=''){
  if(!owner||busy||!subject.value)return;
  const same=owner.subjectId===subject.value,kept=keep&&same?draft:null;
  owner={...owner,subjectId:subject.value};const chosen=owner,sequence=++generation;
  busy=true;stale=true;controls();say('Loading current App access…');
  try{
   const [next,page]=await Promise.all([request(chosen,'grants/read',{subjectId:chosen.subjectId}),request(chosen,'invitations/list',{subjectId:chosen.subjectId,offset:from})]);
   if(!current(chosen,sequence))return;if(!matches(next,chosen)||!matches(page,chosen))throw new Error('The selected account changed. Load access again.');
   grant=next;draft=kept??[...next.roles];stale=false;editor.hidden=false;
   element('current').textContent='Account '+chosen.subjectId+' — current revision '+next.revision+'. Current roles: '+(next.roles.join(', ')||'No App access')+'.';
   drawRoles();drawInvitations(page);
    if(draft.some(role=>!next.assignableRoles.includes(role)))say('Remove unavailable selected roles before saving.');
    else say(success||(kept?'Current access refreshed. Your selected roles are preserved; review before saving.':'Current App access loaded.'));
   }catch(error){if(current(chosen,sequence)&&!sessionChanged(error))say(error.message+' Load access again before making changes.');}
  finally{if(current(chosen,sequence)){busy=false;controls();}}
 }
 async function mutate(path,body){
  if(!owner||busy||stale||!grant)return;
  const chosen=owner,sequence=generation;busy=true;controls();say('Saving…');
  try{
   const answer=await request(chosen,path,body);if(!current(chosen,sequence))return;
   if(path==='invitations/issue'){
    const link=new URL(answer.acceptUrl,location.origin);element('link').value=link.href;element('issued-id').textContent=answer.id;element('issued').hidden=false;
   }
   if(path==='grants'){draft=[...answer.roles];clearIssued();}
   const issuedMessage=answer.delivery?.status==='accepted'?'Invitation created. Email accepted by the delivery service; you can also copy the link.'
    :answer.delivery?.status==='unknown'?'Invitation created. Email delivery could not be confirmed. Copy the link instead.':'Invitation created. Copy the link now.';
   busy=false;await load(true,0,path==='grants'?'App access saved.':path==='invitations/issue'?issuedMessage:'Invitation revoked.');
  }catch(error){
   if(!current(chosen,sequence)||sessionChanged(error))return;stale=true;
   say(error.status===409?'App access changed. Your selected roles are preserved. Load access to review the current revision before trying again.'
    : error.status?'The change was refused. '+error.message+' Load access before trying again.'
     :'The result could not be confirmed. Load access and check invitations before trying again.');
  }finally{if(current(chosen,sequence)){busy=false;controls();}}
 }
 subject.addEventListener('input',()=>{
  if(!owner)return;generation++;owner={...owner,subjectId:''};busy=false;stale=true;grant=null;draft=null;offset=0;total=0;editor.hidden=true;clearIssued();say('Load this account’s current access before editing.');controls();
 });
 element('lookup').addEventListener('submit',event=>{event.preventDefault();return load(true,0);});
 element('save').addEventListener('click',()=>{if(grant&&owner)return mutate('grants',{subjectId:owner.subjectId,roles:[...draft],expectedRevision:grant.revision});});
 element('revoke').addEventListener('click',()=>{if(grant&&owner&&!busy&&!stale){draft=[];drawRoles();return mutate('grants',{subjectId:owner.subjectId,roles:[],expectedRevision:grant.revision});}});
 element('issue').addEventListener('click',()=>{if(grant&&owner&&draft.length)return mutate('invitations/issue',{subjectId:owner.subjectId,roles:[...draft],expectedRevision:grant.revision,expiresAt:Date.now()+Number(element('lifetime').value),...(!element('delivery').hidden&&element('email').checked?{delivery:'email'}:{})});});
 element('previous').addEventListener('click',()=>load(true,Math.max(0,offset-${SUITE_INVITATIONS_PAGE})));
 element('next').addEventListener('click',()=>load(true,offset+${SUITE_INVITATIONS_PAGE}));
 element('copy').addEventListener('click',async()=>{
  const chosen=owner,sequence=generation,link=element('link').value;if(!chosen||!link)return;
  try{await navigator.clipboard.writeText(link);if(current(chosen,sequence))say('Invitation link copied.');}
  catch{if(current(chosen,sequence)){element('link').select();say('Copy the selected invitation link.');}}
 });
 return {retire,present};
})();`;
}
