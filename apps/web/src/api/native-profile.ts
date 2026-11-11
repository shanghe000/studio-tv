import type {AuthSession} from './auth';

const accountSelector='.canvas-header-account-area .userInfoBox[role="button"]';
const defaultAvatar='/project/assets/avatar-big-B1NVlEMF.png.svg';
type ProfileSession=Pick<AuthSession,'user'|'onClear'>;

function avatarSource(value:string|null|undefined){
 if(value){try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}}
 return defaultAvatar;
}

// Bind only the native account's existing text and image slots. Its DOM,
// styles, click handlers, account dialog and logout remain owned by the UI.
export function bindNativeProfile(account:Element,user:ProfileSession['user']){
 const label=account.querySelector<HTMLElement>('.headIconBox > .team-sign--personal');
 const avatar=account.querySelector<HTMLElement>('.headIconBox > .headIcon');
 const name=user?.displayName||'Personal';
 if(label&&label.textContent!==name)label.textContent=name;
 const image='url('+JSON.stringify(avatarSource(user?.avatarUrl))+')';
 if(avatar&&avatar.style.backgroundImage!==image)avatar.style.backgroundImage=image;
}

export function installNativeProfile(auth:ProfileSession,root:Document=document,lifecycle:Window=window){
 const accounts=new Map<Element,MutationObserver>();
 let paused=false,disposed=false;
 const prune=()=>{for(const [account,observer] of accounts)if(!account.isConnected){observer.disconnect();accounts.delete(account);}};
 const mount=(node:ParentNode=root)=>{
  if(paused||disposed)return;
  prune();
  const candidates=[...node.querySelectorAll(accountSelector)];
  if('matches' in node&&(node as Element).matches(accountSelector))candidates.unshift(node as Element);
  for(const account of candidates){
   bindNativeProfile(account,auth.user);
   if(accounts.has(account))continue;
   const observer=new MutationObserver(()=>{if(!paused&&!disposed){prune();if(accounts.has(account))bindNativeProfile(account,auth.user);}});
   // Reconcile native rerenders only inside this existing account slot.
   observer.observe(account,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','class']});
   accounts.set(account,observer);
  }
 };
 const clearIdentity=auth.onClear(()=>{if(!paused&&!disposed){for(const account of accounts.keys())bindNativeProfile(account,null);}});
 const pause=()=>{paused=true;for(const observer of accounts.values())observer.disconnect();accounts.clear();};
 const resume=()=>{if(!disposed){paused=false;mount();}};
 lifecycle.addEventListener('pagehide',pause);
 lifecycle.addEventListener('pageshow',resume);
 mount();
 return{mount,prune,dispose(){if(disposed)return;disposed=true;pause();clearIdentity();lifecycle.removeEventListener('pagehide',pause);lifecycle.removeEventListener('pageshow',resume);}};
}
