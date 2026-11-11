import {ApiError} from '../api/client';
import {AuthSession,installSessionRenewal} from '../api/auth';
import {ServiceLoginGate} from '../api/login-gate';
import {ProductClient} from '../service/product-client';
import {nativeEditorBrand} from '../brand/palette';
import type {Features} from '../features/policy';

/** Only the three native application shells carry this marker. Generated
 * works and signed preview documents are never gated or rewritten here. */
export function nativeFrameModule(source:string,location:Location){
 const path=location.pathname,url=new URL(source,location.href);
 const prefix=/^\/opencut(?:\/|\/index\.html)?$/.test(path)?'/opencut/assets/':/^\/hyperframes-studio(?:\/|\/index\.html)?$/.test(path)?'/hyperframes-studio/assets/':/^\/labs\/rhhyperframes(?:\/|\/index\.html)?$/.test(path)?'/_nuxt/':null;
 if(!prefix||url.origin!==location.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix)||!/^[-\w.]+\.js$/.test(url.pathname.slice(prefix.length)))throw new Error('编辑器启动资源无效。');
 return url.href;
}
function parentRuntime(surface:Window){
 let host=surface.parent;
 while(host!==surface){
  if(host.location.origin!==surface.location.origin)throw new Error('无法访问 STUDIO 主页面。');
  const runtime=(host as any).__RHTV_PREVIEW__;if(runtime)return runtime;
  if(host===host.parent)break;host=host.parent;
 }
 return null;
}
function loadModule(doc:Document,entry:HTMLScriptElement,url:string){
 return new Promise<void>((resolve,reject)=>{const script=doc.createElement('script');script.type='module';script.src=url;script.setAttribute('data-studiotv-native-started','');if(entry.hasAttribute('crossorigin'))script.setAttribute('crossorigin',entry.getAttribute('crossorigin')??'');if(entry.nonce)script.nonce=entry.nonce;script.onload=()=>resolve();script.onerror=()=>reject(new Error('编辑器资源未能加载，请返回工作台重试。'));doc.body.append(script);});
}
function showFailure(doc:Document,surface:Window,message:string){
 doc.documentElement.setAttribute('data-studiotv-frame-pending','');
 let panel=doc.getElementById('studiotv-frame-shell-error');if(!panel){panel=doc.createElement('main');panel.id='studiotv-frame-shell-error';panel.setAttribute('role','alert');panel.style.cssText='position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;gap:16px;padding:32px;background:#15131a;color:#eee;font:14px system-ui';doc.body.append(panel);}
 const text=doc.createElement('p'),back=doc.createElement('button');text.textContent=message;back.textContent='返回工作台';back.onclick=()=>surface.location.assign('/projects/');panel.replaceChildren(text,back);
}
export function initializeFrameShell(options:{mode:'preview'|'service';features?:Features;doc?:Document;surface?:Window;loadNative?:(doc:Document,entry:HTMLScriptElement,url:string)=>Promise<void>}){
 const doc=options.doc??document,surface=options.surface??window;let disconnected=false,release=()=>{};
 const reloadPersisted=(event:PageTransitionEvent)=>{if(event.persisted)surface.location.reload();};
 const disconnect=()=>{surface.removeEventListener('pagehide',hide);surface.removeEventListener('pageshow',reloadPersisted);if(disconnected)return;disconnected=true;release();};
 const hide=(event:PageTransitionEvent)=>{
  const persisted=event.persisted&&options.mode==='service'&&!!nativeEditorBrand(surface.location.pathname);
  if(persisted)doc.documentElement.setAttribute('data-studiotv-frame-pending','');disconnect();
  // A retained document has already disposed its native presentation hooks
  // and private auth client. Re-enter through a fresh shell before showing it.
  if(persisted)surface.addEventListener('pageshow',reloadPersisted,{once:true});
 };
 const started=(async()=>{
  if(!nativeEditorBrand(surface.location.pathname))return false;
  const entry=doc.querySelector<HTMLScriptElement>('script[data-studiotv-native-entry]');if(!entry)throw new Error('编辑器启动入口缺失。');
  const source=nativeFrameModule(entry.getAttribute('data-studiotv-native-entry')??'',surface.location);
  if(options.mode==='service'){
   if(surface.parent!==surface){
    // This runtime is published by the STUDIO native bootstrap only after the
    // main shell has been admitted. Reuse its real identity; never rotate a
    // separate refresh cookie or expose a second token in the frame.
    const runtime=parentRuntime(surface);if(runtime?.mode!=='service'||!runtime.auth?.user?.id)throw new ApiError(401,'FRAME_HOST_UNAUTHENTICATED','请从已登录的 STUDIO 工作台打开编辑器。');
    release=runtime.auth.onClear(()=>showFailure(doc,surface,'登录状态已变更，请返回工作台。'));
   }else{
    const api=new ProductClient('/api/v1',surface.fetch.bind(surface),options.features),auth=new AuthSession(api),gate=new ServiceLoginGate({api,auth},{doc,surface});
    api.onRevoked(error=>{gate.denied(error);auth.clear();});const clear=auth.onClear(()=>api.clearRequests()),renew=installSessionRenewal(auth,surface,doc);
    // The native standalone transport receives no STUDIO session bridge. Only
    // this private client can use the recovered in-memory Bearer token.
    release=()=>{renew();gate.disconnect();clear();api.clearRequests();auth.clear();};
    await gate.waitForSession();if(disconnected||!auth.user)return false;
   }
  }
  if(disconnected)return false;doc.documentElement.removeAttribute('data-studiotv-frame-pending');await(options.loadNative??loadModule)(doc,entry,source);return !disconnected;
 })().catch(error=>{if(!disconnected)showFailure(doc,surface,error instanceof Error?error.message:'暂时无法打开编辑器，请返回工作台。');return false;});
 surface.addEventListener('pagehide',hide,{once:true});
 return{started,disconnect};
}
