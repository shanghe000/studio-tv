import {ApiError,type ApiClient} from './client';
import {createSessionStartupDeadline,type AuthSession} from './auth';
import {loginDestination,loginUnavailableMessage,type LoginConfiguration} from './feishu-ui';

const markerKey='studiotv-login-transition';
const loginAttemptLifetime=5*60*1000;
type Marker={version:1;kind:'login'|'signed-out'|'denied';createdAt:number;returnTo:string;hash:string};
type Surface=Pick<Window,'location'|'history'|'sessionStorage'|'addEventListener'|'removeEventListener'>;
type SessionPort={auth:Pick<AuthSession,'user'|'ensureFresh'|'onClear'>;api:Pick<ApiClient,'request'>};

/** Match the server's returnTo boundary. Fragments stay in this tab, outside
 * the OAuth transaction; authentication endpoints are never return targets. */
export function safeLoginReturnTo(raw:string):boolean {
 if(!raw.startsWith('/')||raw.startsWith('//')||raw.length>4096||/[#\\\r\n]/.test(raw))return false;
 try{
  const url=new URL(raw,'https://studio.invalid'),decoded=decodeURIComponent(url.pathname),full=decodeURIComponent(raw);
  if(url.origin!=='https://studio.invalid'||/[\\\r\n]/.test(full)||decoded.startsWith('//'))return false;
  const path=new URL(decoded,'https://studio.invalid').pathname.replace(/\/+$/,'');
  return path!=='/login'&&path!=='/auth'&&!path.startsWith('/auth/')&&path!=='/api/v1/auth'&&!path.startsWith('/api/v1/auth/');
 }catch{return false;}
}

/** The service shell is admitted only after a real refresh and a protected
 * tv.access read. This is a presentation gate, never an authorization lease. */
export class ServiceLoginGate {
 private readonly doc:Document;
 private readonly surface:Surface;
 private panel:HTMLElement|null=null;
 private style:HTMLStyleElement|null=null;
 private checking:Promise<boolean>|null=null;
 private grantDeadline:ReturnType<typeof createSessionStartupDeadline>|null=null;
 private recheckAfterClear=false;
 private redirecting=false;
 private signingOut=false;
 private disposed=false;
 private failure:ApiError|null=null;
 private stopped:'signed-out'|'denied'|null=null;
 private admitted=false;
 private needsReload=false;
 private epoch=0;
 private readonly hidden=new Map<HTMLElement,{hidden:boolean;inert:boolean}>();
 private observer:MutationObserver|null=null;
 private resolveAdmission!:()=>void;
 private readonly admission=new Promise<void>(resolve=>this.resolveAdmission=resolve);
 private readonly release:()=>void;
 private returnTo:string;
 private hash:string;
 constructor(private readonly session:SessionPort,options:{doc?:Document;surface?:Surface}={}){
  this.doc=options.doc??document;this.surface=options.surface??window;
  const requested=this.surface.location.pathname+this.surface.location.search,previous=this.readMarker();
  this.returnTo=safeLoginReturnTo(requested)?requested:previous?.returnTo??'/projects/';
  this.hash=safeLoginReturnTo(requested)?this.surface.location.hash||(previous?.kind==='login'&&previous.returnTo===requested?previous.hash:''):previous?.hash??'';
  this.stopped=previous?.kind==='signed-out'?'signed-out':previous?.kind==='denied'?'denied':null;
  this.release=this.session.auth.onClear(()=>this.cleared());
  this.block();
 }
 waitForSession(){void this.enter();return this.admission;}
 enter():Promise<boolean>{
  if(this.disposed)return Promise.resolve(false);
  if(this.checking)return this.checking;
  this.failure=null;
  this.show('正在恢复登录','正在确认登录状态与工作台权限…');
  const epoch=this.epoch;
  let grant:ReturnType<typeof createSessionStartupDeadline>|null=null;
  const attempt=(async()=>{
   try{
    let restored=await this.session.auth.ensureFresh();
    // A verified same-user acceptance can supersede the pending recovery
    // without clear(). Check that fresh session once before the actual grant.
    if(!restored&&!this.disposed&&epoch===this.epoch&&!this.recheckAfterClear&&this.session.auth.user)restored=await this.session.auth.ensureFresh();
    if(this.disposed||epoch!==this.epoch)return false;
    if(this.recheckAfterClear&&this.session.auth.user)return false;
    if(this.failure?.status===403){this.showDenied();return false;}
    if(!restored||!this.session.auth.user){await this.requireLogin();return false;}
    const actor=this.session.auth.user.id;
    // /me and refresh establish identity only. This existing read also checks
    // the application's tv.access permission, without loading the home page.
    grant=createSessionStartupDeadline('APPLICATION_ADMISSION_TIMEOUT','工作台权限检查超时，请重试。');this.grantDeadline=grant;
    await grant.run(()=>this.session.api.request('/projects?page=1&pageSize=1',{signal:grant!.signal}));
    if(this.disposed||epoch!==this.epoch||this.session.auth.user?.id!==actor)return false;
    this.stopped=null;this.restoreFragment();this.removeMarker();
    // Cleared adapter state cannot safely reuse a retained native document,
    // particularly after an account switch. Keep it hidden until a new shell.
    if(this.needsReload){this.surface.location.reload();return false;}
    this.admitted=true;this.allow();this.resolveAdmission();return true;
   }catch(error){
    if(this.disposed||epoch!==this.epoch)return false;
    if(this.recheckAfterClear&&this.session.auth.user)return false;
    if(this.stopped==='signed-out'){this.showSignedOut();return false;}
    const failure=this.failure??error;
    if(failure instanceof ApiError&&failure.status===403){this.failure=failure;this.showDenied();}
    else if(failure instanceof ApiError&&failure.status===401){await this.requireLogin();}
    else this.showRetry();
    return false;
   }
  })().finally(()=>{
   grant?.close();if(this.grantDeadline===grant)this.grantDeadline=null;
   if(this.checking!==attempt)return;
   this.checking=null;
   const recheck=this.recheckAfterClear;this.recheckAfterClear=false;
   if(recheck&&!this.disposed&&this.session.auth.user)queueMicrotask(()=>void this.enter());
  });
  this.checking=attempt;return attempt;
 }
 /** Called before AuthSession.clear so a permission denial cannot be
  * mistaken for an anonymous session by synchronous cleanup listeners. */
 denied(error?:ApiError){
  if(this.disposed)return;
  if(error)this.failure=error;
  if(error?.status===403){this.captureReturnLocation();this.stopped='denied';this.writeMarker('denied');}
 }
 async signOut(action:()=>Promise<void>){
  if(this.disposed)return action();
  this.signingOut=true;
  try{await action();if(!this.disposed&&!this.session.auth.user){this.stopped='signed-out';this.writeMarker('signed-out');this.showSignedOut();}}
  finally{this.signingOut=false;}
 }
 disconnect(){this.disposed=true;this.epoch++;this.grantDeadline?.cancel();this.grantDeadline=null;this.release();this.allow();this.style?.remove();this.style=null;}
 private cleared(){
  if(this.disposed)return;
  this.grantDeadline?.cancel();
  if(this.admitted)this.needsReload=true;
  this.captureReturnLocation();
  this.block();
  if(this.signingOut){this.stopped='signed-out';this.writeMarker('signed-out');this.showSignedOut();return;}
  if(this.checking){this.recheckAfterClear=true;return;}
  // accept() can clear one identity before installing its replacement in
  // the same turn. Check the replacement's actual application grant first.
  queueMicrotask(()=>{
   if(this.disposed||this.checking)return;
   if(this.session.auth.user){void this.enter();return;}
   if(this.stopped==='denied'){this.showDenied();return;}
   if(this.stopped==='signed-out'){this.showSignedOut();return;}
   void this.requireLogin();
  });
 }
 private async requireLogin(){
  this.captureReturnLocation();
  if(this.stopped==='denied'){this.showDenied();return;}
  if(this.stopped==='signed-out'){this.showSignedOut();return;}
  const query=new URLSearchParams(this.surface.location.search),authPath=!safeLoginReturnTo(this.surface.location.pathname);
  if(authPath||query.has('error')||query.has('auth_error')||query.has('login_error')||this.readMarker()?.kind==='login'){
   this.showLogin('登录未完成，请重新使用飞书登录。');return;
  }
  await this.beginLogin(true);
 }
 private async beginLogin(automatic=false){
  if(this.redirecting||this.disposed)return;
  this.captureReturnLocation();
  this.redirecting=true;this.show('正在前往飞书登录','使用公司飞书账号登录后，将返回当前页面。');
  try{
   const configuration=(await this.session.api.request<LoginConfiguration>('/auth/config',{anonymous:true,retryAuth:false})).data;
   if(this.disposed)return;
   if(configuration.provider!=='IPAC_FEISHU')throw new Error('Invalid login provider');
   if(!configuration.configured){this.show('暂时无法登录',loginUnavailableMessage(configuration.unavailableReason),'重试',()=>void this.enter());return;}
   const destination=loginDestination(configuration,this.returnTo,this.surface.location.origin);
   // Persist only the route, never a token. If tab storage is unavailable,
   // automatic redirect is disabled so a failed callback cannot loop.
   if(!this.writeMarker('login')&&automatic){this.showLogin('请使用飞书登录后继续。');return;}
   this.surface.location.replace(destination);
  }catch{if(!this.disposed)this.showRetry();}
  finally{this.redirecting=false;}
 }
 private showLogin(message:string){this.show('登录工作台',message,'使用飞书登录',()=>void this.beginLogin());}
 private showSignedOut(){this.show('已退出工作台','使用飞书重新登录后继续。','使用飞书登录',()=>void this.beginLogin());}
 private showDenied(){
  this.stopped='denied';this.writeMarker('denied');
  this.show('无法进入工作台',this.failure?.code==='ACCOUNT_DISABLED'?'当前账号已停用，请联系管理员。':'当前账号没有使用工作台的权限，请联系管理员。','重新检查',()=>void this.enter());
 }
 private showRetry(){this.show('暂时无法恢复登录','登录或授权服务暂时不可用，请稍后重试。','重试恢复',()=>void this.enter());}
 private show(title:string,message:string,label?:string,action?:()=>void){
  this.block();
  if(!this.panel){this.panel=this.doc.createElement('main');this.panel.id='studio-tv-login-gate';this.panel.setAttribute('aria-labelledby','studiotv-login-heading');this.doc.body.append(this.panel);}
  const card=this.doc.createElement('section'),heading=this.doc.createElement('h1'),status=this.doc.createElement('p');
  heading.id='studiotv-login-heading';heading.textContent=title;status.textContent=message;status.setAttribute('role','status');card.append(heading,status);
  if(label&&action){const button=this.doc.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{button.disabled=true;action();};card.append(button);}
  this.panel.replaceChildren(card);
 }
 private block(){
  if(!this.style){this.style=this.doc.createElement('style');this.style.textContent=`body[data-studiotv-login-blocked] > :not(#studio-tv-login-gate):not(script):not(style){visibility:hidden!important}#studio-tv-login-gate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#15131a;color:#ece8f1;font:14px system-ui}#studio-tv-login-gate section{width:360px;max-width:100%;padding:32px;box-sizing:border-box;border:1px solid #38313f;border-radius:16px;background:#211c27}#studio-tv-login-gate h1{font-size:24px;font-weight:600;margin:0 0 16px}#studio-tv-login-gate p{line-height:1.7;color:#bfb5ca;margin:0 0 24px}#studio-tv-login-gate button{width:100%;padding:12px;border:0;border-radius:8px;background:#725e8f;color:white;font:600 14px system-ui;cursor:pointer}#studio-tv-login-gate button:disabled{opacity:.5;cursor:wait}`;this.doc.head.append(this.style);}
  this.doc.body.setAttribute('data-studiotv-login-blocked','');
  const hide=()=>{for(const child of this.doc.body.children){if(!(child instanceof this.doc.defaultView!.HTMLElement)||child.id==='studio-tv-login-gate'||['SCRIPT','STYLE'].includes(child.tagName))continue;if(!this.hidden.has(child))this.hidden.set(child,{hidden:child.hidden,inert:child.inert});child.hidden=true;child.inert=true;}};
  hide();
  if(!this.observer){this.observer=new this.doc.defaultView!.MutationObserver(hide);this.observer.observe(this.doc.body,{childList:true});}
 }
 private allow(){this.observer?.disconnect();this.observer=null;for(const [element,original] of this.hidden){element.hidden=original.hidden;element.inert=original.inert;}this.hidden.clear();this.doc.body.removeAttribute('data-studiotv-login-blocked');this.panel?.remove();this.panel=null;}
 private readMarker():Marker|null {
  try{
   const raw=this.surface.sessionStorage.getItem(markerKey);if(!raw)return null;
   const value=JSON.parse(raw) as Marker;
   if(value.version!==1||!['login','signed-out','denied'].includes(value.kind)||!Number.isFinite(value.createdAt)||!safeLoginReturnTo(value.returnTo)||typeof value.hash!=='string'||value.hash.length>4096||value.hash!==''&&!value.hash.startsWith('#')||value.createdAt>Date.now()||value.kind==='login'&&Date.now()-value.createdAt>loginAttemptLifetime){this.removeMarker();return null;}
   return value;
  }catch{return null;}
 }
 private writeMarker(kind:Marker['kind']):boolean {try{this.surface.sessionStorage.setItem(markerKey,JSON.stringify({version:1,kind,createdAt:Date.now(),returnTo:this.returnTo,hash:this.hash.slice(0,4096)} satisfies Marker));return true;}catch{return false;}}
 private removeMarker(){try{this.surface.sessionStorage.removeItem(markerKey);}catch{/* No credential or authorization is stored here. */}}
 private captureReturnLocation(){const requested=this.surface.location.pathname+this.surface.location.search;if(safeLoginReturnTo(requested)){const previous=this.readMarker();this.returnTo=requested;this.hash=this.surface.location.hash||(previous?.kind==='login'&&previous.returnTo===requested?previous.hash:'');}}
 private restoreFragment(){
  const previous=this.readMarker();
  if(previous?.kind==='login'&&previous.hash&&this.surface.location.pathname+this.surface.location.search===previous.returnTo&&!this.surface.location.hash)this.surface.history.replaceState(this.surface.history.state,'',previous.returnTo+previous.hash);
 }
}
