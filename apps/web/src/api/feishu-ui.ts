import {ApiClient} from './client';
export interface LoginConfiguration {provider:'IPAC_FEISHU';configured:boolean;loginUrl:string;unavailableReason:string|null}
export function loginUnavailableMessage(reason:string|null):string {
 if(reason==='IPAC_SESSION_STATUS_UNAVAILABLE')return '统一登录服务暂时不可用，请稍后重试。';
 return '统一登录尚未配置，请联系管理员。';
}
export function loginDestination(configuration:LoginConfiguration,returnTo:string,origin:string):string {
 if(!configuration.configured)throw new Error(loginUnavailableMessage(configuration.unavailableReason));
 const login=new URL(configuration.loginUrl,origin);
 if(login.origin!==origin||login.pathname!=='/api/v1/auth/feishu/login')throw new Error('登录服务地址无效。');
 if(!returnTo.startsWith('/')||returnTo.startsWith('//')||returnTo.includes('\\'))throw new Error('登录返回地址无效。');
 login.searchParams.set('returnTo',returnTo);return login.pathname+login.search;
}
export interface LoginRecovery {restore:()=>Promise<boolean>;recovered?:()=>void}
/** A native expired-access prompt is not proof that the refresh session has
 * expired. Recover that real session before offering a new OAuth flow. */
export function createLoginRecovery(recovery:LoginRecovery|undefined,showLogin:()=>Promise<void>,showRetry:()=>void){
 let opening:Promise<void>|null=null;
 return()=>opening||=(async()=>{if(recovery){try{if(await recovery.restore()){recovery.recovered?.();return;}}catch{showRetry();return;}}await showLogin();})().finally(()=>opening=null);
}
export function installFeishuLogin(api:ApiClient,getReturnTo:()=>string,recovery?:LoginRecovery){
 document.body.setAttribute('data-rhtv-auth-provider','feishu');
 const style=document.createElement('style');style.textContent=`
 body[data-rhtv-auth-provider="feishu"] .ant-modal-root:has(.loginAndRegisterModalV3),
 body[data-rhtv-auth-provider="feishu"] .loginAndRegisterModalV3{display:none!important}
 #rhtv-feishu-login{position:fixed;inset:0;z-index:150000;background:#000b;display:flex;align-items:center;justify-content:center;font:14px system-ui;color:#eee}
 #rhtv-feishu-login section{position:relative;width:360px;max-width:calc(100vw - 48px);box-sizing:border-box;padding:36px;border:1px solid #383838;border-radius:16px;background:#191919;box-shadow:0 20px 70px #0008}
 #rhtv-feishu-login h1{font-size:24px;margin:0 0 12px;font-weight:600}
 #rhtv-feishu-login p{color:#aaa;line-height:1.7;margin:0 0 24px}
 #rhtv-feishu-login .rhtv-feishu-status{min-height:36px;font-size:13px;margin:0 0 16px;overflow-wrap:anywhere}
 #rhtv-feishu-login .rhtv-feishu-primary{width:100%;border:0;border-radius:9px;padding:13px 16px;background:var(--studio-primary,#725e8f);color:#eee9f2;font:600 14px system-ui;cursor:pointer}
 #rhtv-feishu-login .rhtv-feishu-primary:disabled{opacity:.35;cursor:default}
 #rhtv-feishu-login .rhtv-feishu-close{position:absolute;top:12px;right:12px;padding:4px 8px;background:none;border:0;color:#aaa;font-size:22px;cursor:pointer}
 `;document.head.append(style);
 let configuration:LoginConfiguration|null=null,loading:Promise<LoginConfiguration>|null=null;
 const load=()=>loading||=(api.request<LoginConfiguration>('/auth/config',{anonymous:true,retryAuth:false}).then(result=>{configuration=result.data;return configuration;}).finally(()=>loading=null));
 const dismissNative=()=>document.querySelector<HTMLElement>('.loginAndRegisterModalV3 .ant-modal-close')?.click();
 function panel(retry=false){
  document.getElementById('rhtv-feishu-login')?.remove();
  const overlay=document.createElement('div');overlay.id='rhtv-feishu-login';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','rhtv-feishu-title');
  const panel=document.createElement('section'),heading=document.createElement('h1'),intro=document.createElement('p'),status=document.createElement('p'),button=document.createElement('button'),close=document.createElement('button');
  heading.id='rhtv-feishu-title';heading.textContent=retry?'恢复登录':'登录工作台';intro.textContent=retry?'暂时无法恢复登录，请稍后重试。':'使用公司飞书账号登录。';status.className='rhtv-feishu-status';status.setAttribute('role','status');status.textContent=retry?'登录服务暂时不可用；不会跳转到飞书。':'正在检查登录服务…';button.className='rhtv-feishu-primary';button.textContent=retry?'重试恢复':'使用飞书登录';button.disabled=!retry;close.className='rhtv-feishu-close';close.textContent='×';close.setAttribute('aria-label','关闭登录窗口');
  const dismiss=()=>{overlay.remove();dismissNative();};close.onclick=dismiss;overlay.addEventListener('keydown',event=>{if(event.key==='Escape')dismiss();});
  button.onclick=()=>{try{if(!configuration)throw new Error('登录服务尚未就绪。');location.assign(loginDestination(configuration,getReturnTo(),location.origin));}catch(error){status.textContent='暂时无法登录，请稍后重试。';}};
  panel.append(close,heading,intro,status,button);overlay.append(panel);document.body.append(overlay);close.focus();return{overlay,status,button};
 }
 const open=createLoginRecovery(recovery?{...recovery,recovered:()=>{document.getElementById('rhtv-feishu-login')?.remove();dismissNative();recovery.recovered?.();}}:undefined,async()=>{
  const {overlay,status,button}=panel();
  try{const value=await load();if(!overlay.isConnected)return;if(value.provider!=='IPAC_FEISHU')throw new Error('此工作台未配置飞书统一登录。');status.textContent=value.configured?'':loginUnavailableMessage(value.unavailableReason);button.disabled=!value.configured;if(value.configured)button.focus();}catch(error){status.textContent='暂时无法登录，请稍后重试。';button.disabled=true;}
 },()=>{const {button,status}=panel(true);button.onclick=()=>{button.disabled=true;status.textContent='正在恢复登录…';void open();};});
 const listener=(event:Event)=>{event.stopImmediatePropagation();void open();};
 window.addEventListener('onShowLoginRegisterModal',listener,{capture:true});
 return{open,load,disconnect:()=>window.removeEventListener('onShowLoginRegisterModal',listener,{capture:true})};
}
