import {ApiClient,ApiError} from './client';
import type {Session,User} from './types';

const startupTimeout=10_000;
/** A bounded waiter also fences transports or lock implementations that ignore
 * cancellation. Its budget is absolute, including retries and lock queuing. */
export function createSessionStartupDeadline(code:string,message:string){
 const controller=new AbortController(),expiresAt=Date.now()+startupTimeout,timeout=new ApiError(503,code,message);
 let reject!:(reason:unknown)=>void;const canceled=new Promise<never>((_resolve,no)=>{reject=no;});void canceled.catch(()=>{});
 const aborted=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',aborted,{once:true});
 const timer=setTimeout(()=>controller.abort(timeout),startupTimeout);
 const check=()=>{if(Date.now()>=expiresAt&&!controller.signal.aborted)controller.abort(timeout);if(controller.signal.aborted)throw controller.signal.reason;};
 return{signal:controller.signal,check,
  async run<T>(work:()=>Promise<T>){check();const result=await Promise.race([work(),canceled]);check();return result;},
  wait(milliseconds:number){check();return new Promise<void>((resolve,no)=>{const cleanup=()=>{clearTimeout(delay);controller.signal.removeEventListener('abort',stop);},stop=()=>{cleanup();no(controller.signal.reason);},delay=setTimeout(()=>{cleanup();resolve();},milliseconds);controller.signal.addEventListener('abort',stop,{once:true});});},
  cancel(){controller.abort(new DOMException('登录检查已取消。','AbortError'));},
  close(){clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);},
 };
}
export class AuthSession {
 user:User|null=null;
 private csrf:string|null=null;
 private refreshing:Promise<boolean>|null=null;
 private recovery:ReturnType<typeof createSessionStartupDeadline>|null=null;
 private epoch=0;
 private readonly clearListeners=new Set<()=>void>();
 private readonly sessionListeners=new Set<()=>void>();
 private renewAt=0;
 get renewalDueAt(){return this.renewAt;}
 onSession(callback:()=>void){this.sessionListeners.add(callback);return()=>{this.sessionListeners.delete(callback);};}
 private changed(){const failures:unknown[]=[];for(const listener of [...this.sessionListeners]){try{listener();}catch(error){failures.push(error);}}return failures;}
 ensureFresh(){return this.user&&this.api.getAccessToken()&&Date.now()<this.renewAt?Promise.resolve(true):this.restore();}
 constructor(readonly api:ApiClient){api.onRefresh(()=>this.restore());}
 private async csrfToken(signal?:AbortSignal,check?:()=>void){
  check?.();if(this.csrf)return this.csrf;
  const epoch=this.epoch,token=(await this.api.request<{csrfToken:string}>('/auth/csrf',{anonymous:true,signal})).data.csrfToken;
  check?.();if(epoch!==this.epoch||signal?.aborted)throw new DOMException('登录检查已取消。','AbortError');
  this.csrf=token;return token;
 }
 private cancelRecovery(){const recovery=this.recovery;this.recovery=null;this.refreshing=null;recovery?.cancel();}
 async restore():Promise<boolean>{
  if(this.refreshing)return this.refreshing;
  const epoch=this.epoch,recovery=createSessionStartupDeadline('SESSION_RECOVERY_TIMEOUT','登录恢复超时，请重试。');this.recovery=recovery;
  const check=()=>{recovery.check();if(epoch!==this.epoch||this.recovery!==recovery)throw new DOMException('登录检查已取消。','AbortError');};
  const restore=async()=>{
   if(epoch!==this.epoch)return false;
   check();
   for(let attempt=0;attempt<2;attempt++){
    let session:Session;
    try{const csrf=await this.csrfToken(recovery.signal,check);if(epoch!==this.epoch)return false;check();session=(await this.api.request<Session>('/auth/sessions/refresh',{method:'POST',headers:{'X-CSRF-Token':csrf},anonymous:true,retryAuth:false,signal:recovery.signal})).data;}
    catch(error){
     if(epoch!==this.epoch)return false;
     check();
     if(error instanceof ApiError&&error.status===403&&error.code==='CSRF_INVALID'){this.csrf=null;if(attempt===0)continue;}
     // Another same-origin tab may still be installing its rotated HttpOnly
     // cookie. The server rejects the old token; it never returns credentials
     // for this narrowly marked collision. Wait once, then use the new cookie.
     if(error instanceof ApiError&&error.status===401&&error.code==='REFRESH_RACE_RETRY'){
      this.csrf=null;if(attempt===0){await recovery.wait(1000);if(epoch!==this.epoch)return false;check();continue;}
      throw new ApiError(503,'SESSION_RECOVERY_PENDING','登录会话正在恢复，请稍后重试。');
     }
     if(error instanceof ApiError&&error.status===401){this.clear();return false;}throw error;
    }
    if(epoch!==this.epoch)return false;
    check();
    // A verified replacement can clear the previous identity atomically.
    // Detach our own cancellation slot before accept() invokes that cleanup.
    if(this.recovery===recovery)this.recovery=null;
    this.accept(session);this.csrf=null;return true;
   }
   return false;
  };
  // Rotate a shared HttpOnly cookie serially across same-origin tabs when the browser supports Web Locks.
  const locks=globalThis.navigator?.locks;
  const refresh=recovery.run(async()=>locks?await locks.request('rhtv:auth-refresh',{signal:recovery.signal},()=>recovery.run(restore)):await restore()).catch(error=>{
   if(recovery.signal.aborted){if(epoch!==this.epoch||recovery.signal.reason?.name==='AbortError')return false;throw recovery.signal.reason;}throw error;
  }).finally(()=>{recovery.close();if(this.recovery===recovery)this.recovery=null;if(this.refreshing===refresh)this.refreshing=null;});
  this.refreshing=refresh;return refresh;
 }
 onClear(callback:()=>void){this.clearListeners.add(callback);return()=>{this.clearListeners.delete(callback);};}
 accept(session:Session){
  if(!Number.isFinite(session.expiresIn)||session.expiresIn<=0||typeof session.accessToken!=='string'||!session.accessToken)throw new ApiError(502,'INVALID_SESSION','服务器返回了无效的登录会话。');
  const now=Date.now(),ttl=Math.min(session.expiresIn*1000,2**31-1);let expiresAt=now+ttl;
  // Expiration is only a conservative renewal hint. Identity and permission
  // remain verified by the API; no claim here grants access.
  try{const payload=JSON.parse(atob(session.accessToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(Number.isFinite(payload.exp))expiresAt=Math.min(expiresAt,payload.exp*1000);}catch{}
  if(expiresAt<=now)throw new ApiError(502,'INVALID_SESSION','服务器返回了已过期的登录会话。');
  // An explicit fresh acceptance must fence any older recovery, including a
  // same-user response. restore() detaches its own slot immediately above.
  if(this.recovery)this.cancelRecovery();
  if(this.user&&this.user.id!==session.user.id)this.clear();this.api.setAccessToken(session.accessToken);this.user=session.user;this.renewAt=expiresAt-Math.min(60000,(expiresAt-now)/10);const failures=this.changed();if(failures.length)throw new AggregateError(failures,'会话恢复后处理失败，请刷新页面后重试。');
 }
 async signOut(){for(let attempt=0;attempt<2;attempt++){try{const csrf=await this.csrfToken();await this.api.request('/auth/session',{method:'DELETE',headers:{'X-CSRF-Token':csrf},retryAuth:false});this.clear();return;}catch(error){if(error instanceof ApiError&&error.status===403&&error.code==='CSRF_INVALID'){this.csrf=null;if(attempt===0)continue;}throw error;}}}
 clear(){
  this.epoch++;
  this.cancelRecovery();
  this.api.setAccessToken(null);this.user=null;this.csrf=null;this.renewAt=0;const failures=this.changed();
  // Notify every owner of identity-bound state. Failed cleanup must also
  // prevent accept() from attaching a different user to leftover state.
  for(const listener of [...this.clearListeners]){try{listener();}catch(error){failures.push(error);}}
  if(failures.length)throw new AggregateError(failures,'会话数据清理失败，请刷新页面后重新登录。');
 }
}
// A compatibility view for the immutable native auth helpers. Tokens are never persisted.
export function installNativeSessionBridge(auth:AuthSession){
 const sensitive=new Set(['Rh-Accesstoken','Rh-Refreshtoken','Rh-Identify','Rh-Expire-In','Rh-Comfy-Auth','Rh-Comfy-Expire-In','Rh-first-login','userId','userInfo']);
 const memory=new Map<string,string>();
 auth.onClear(()=>memory.clear());
 const original={get:Storage.prototype.getItem,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem};
 for(const key of sensitive)original.remove.call(localStorage,key);
 Storage.prototype.getItem=function(key:string){if(this===localStorage&&sensitive.has(key)){if(key==='Rh-Accesstoken')return auth.api.getAccessToken();if(key==='userId')return auth.user?.id||null;return memory.get(key)||null;}return original.get.call(this,key);};
 Storage.prototype.setItem=function(key:string,value:string){if(this===localStorage&&sensitive.has(key)){if(!['Rh-Accesstoken','Rh-Refreshtoken','userId'].includes(key))memory.set(key,String(value));return;}original.set.call(this,key,value);};
 Storage.prototype.removeItem=function(key:string){if(this===localStorage&&sensitive.has(key)){memory.delete(key);return;}original.remove.call(this,key);};
 let prototype:any=Document.prototype,descriptor:PropertyDescriptor|undefined;
 while(prototype&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(prototype,'cookie');prototype=Object.getPrototypeOf(prototype);}
 if(!descriptor?.get||!descriptor?.set)throw new Error('Browser cookie bridge unavailable');
 const get=descriptor.get,set=descriptor.set;
 for(const key of ['Rh-Accesstoken','Rh-Refreshtoken','userId','Rh-Identify','Rh-first-login'])set.call(document,key+'=; Path=/; Max-Age=0; SameSite=Lax');
 Object.defineProperty(document,'cookie',{configurable:true,get(){const regular=String(get.call(document)).split(';').filter(x=>!sensitive.has(x.trim().split('=')[0])).join(';');const values=[regular];const token=auth.api.getAccessToken();if(token)values.push('Rh-Accesstoken='+encodeURIComponent(token));if(auth.user)values.push('userId='+encodeURIComponent(auth.user.id));return values.filter(Boolean).join('; ');},set(value:string){const key=String(value).split('=',1)[0].trim();if(!sensitive.has(key))set.call(document,value);}});
 installSessionRenewal(auth);
}

/** Renew short access credentials while the page is in use. Background tabs
 * pause their timer and recover on wake; the refresh cookie's hard deadline
 * is always enforced by the server. No token or identity is persisted. */
export function installSessionRenewal(auth:AuthSession,surface:Window=window,doc:Document=document){
 let timer:ReturnType<typeof setTimeout>|undefined,paused=false,disposed=false,retrying=false,retry=5000;
 const stop=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
 const active=()=>!disposed&&!paused&&doc.visibilityState!=='hidden';
 const schedule=()=>{stop();if(active()&&auth.user&&auth.api.getAccessToken())timer=setTimeout(()=>void renew(),Math.max(0,auth.renewalDueAt-Date.now()));};
 // Cold admission and signed-out retries belong to the service login gate.
 // Wake events must not create a new refresh attempt without a live identity.
 const renew=async()=>{stop();if(!active()||retrying||!auth.user||!auth.api.getAccessToken())return;retrying=true;try{await auth.ensureFresh();retry=5000;}catch{if(active()&&auth.user){timer=setTimeout(()=>void renew(),retry);retry=Math.min(60000,retry*2);}}finally{retrying=false;if(timer===undefined)schedule();}};
 const wake=()=>{paused=false;void renew();},visibility=()=>{if(doc.visibilityState==='hidden')stop();else wake();},hide=()=>{paused=true;stop();};
 const changed=()=>{retry=5000;schedule();},release=auth.onSession(changed);
 for(const name of ['focus','online','pageshow'])surface.addEventListener(name,wake);
 surface.addEventListener('pagehide',hide);doc.addEventListener('visibilitychange',visibility);schedule();
 return()=>{disposed=true;stop();release();for(const name of ['focus','online','pageshow'])surface.removeEventListener(name,wake);surface.removeEventListener('pagehide',hide);doc.removeEventListener('visibilitychange',visibility);};
}
