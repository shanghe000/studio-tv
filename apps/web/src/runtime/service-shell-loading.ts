export const NATIVE_ENTRY='/project/assets/index-DeyN_Phq.js';
const slowAfter=20_000,recoveryAfter=60_000;
type Surface=Pick<Window,'location'|'requestAnimationFrame'|'cancelAnimationFrame'>;

/** Download and prepare the fixed immutable entry without executing it.
 * The bootstrap calls this only after real session + tv.access admission. */
export function preloadNativeEntry(doc:Document=document){
 const existing=[...doc.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].find(link=>link.getAttribute('href')===NATIVE_ENTRY);
 if(existing)return()=>{};
 const link=doc.createElement('link');link.rel='modulepreload';link.href=NATIVE_ENTRY;doc.head.append(link);return()=>link.remove();
}

/** Loading belongs outside React's root. Session admission and native module
 * execution are separate milestones; neither alone proves a visible commit. */
export function createServiceShellLoading(options:{doc?:Document;surface?:Surface;canReload?:()=>boolean}={}){
 const doc=options.doc??document,surface=options.surface??window;
 const panel=doc.createElement('div'),card=doc.createElement('section'),heading=doc.createElement('p'),detail=doc.createElement('p'),style=doc.createElement('style');
 panel.id='studio-tv-shell-loading';panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');heading.textContent='正在打开工作台';detail.textContent='正在准备登录验证…';card.append(heading,detail);panel.append(card);
 style.textContent='#studio-tv-shell-loading{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:24px;background:#15131a;color:#ece8f1;font:14px system-ui}#studio-tv-shell-loading[hidden]{display:none!important}#studio-tv-shell-loading section{max-width:360px;text-align:center}#studio-tv-shell-loading p{margin:0 0 12px;line-height:1.7}#studio-tv-shell-loading p:first-child{font-size:18px;font-weight:600}#studio-tv-shell-loading p:nth-child(2){color:#bfb5ca}#studio-tv-shell-loading button{padding:10px 24px;border:1px solid #454049;border-radius:8px;background:#e6e6e6;color:#15131a;font:14px system-ui;cursor:pointer}';
 doc.head.append(style);doc.body.append(panel);
 let state:'pending'|'authorized'|'mounted'|'failed'|'canceled'|'disposed'='pending';
 let slow:ReturnType<typeof setTimeout>|undefined,timeout:ReturnType<typeof setTimeout>|undefined,frame:number|undefined,observer:MutationObserver|null=null,delayed=false,retrying=false;
 const waiters=new Set<{resolve:()=>void;reject:(error:Error)=>void;release:()=>void}>();
 const abortError=()=>new DOMException('页面加载已取消。','AbortError');
 const timeoutError=()=>new Error('工作台资源加载时间较长，请刷新后重试。');
 const hasRootContent=()=>[...(doc.getElementById('root')?.children??[])].some(child=>!['SCRIPT','STYLE'].includes(child.tagName));
 const canReload=()=>options.canReload?.()??!hasRootContent();
 const reloadBeforeMount=()=>{
  if(state!=='authorized'&&state!=='failed')return;
  if(canReload()){surface.location.reload();return;}
  detail.textContent=state==='failed'?'界面初始化未完成，当前画布内容仍保留，请保持页面打开。':'画布已打开，正在完成初始化，请稍候…';card.replaceChildren(heading,detail);
 };
 const showRetry=(label:string,action:()=>void)=>{const retry=doc.createElement('button');retry.type='button';retry.textContent=label;retry.onclick=()=>{if(state==='authorized'||state==='failed')action();};card.replaceChildren(heading,detail,retry);};
 const stopWatch=()=>{observer?.disconnect();observer=null;if(frame!==undefined)surface.cancelAnimationFrame(frame);frame=undefined;};
 const stop=()=>{stopWatch();if(slow!==undefined)clearTimeout(slow);if(timeout!==undefined)clearTimeout(timeout);slow=undefined;timeout=undefined;};
 const rejectWaiting=(error:Error)=>{for(const waiter of [...waiters]){waiters.delete(waiter);waiter.release();waiter.reject(error);}};
 const visibleRoot=()=>{
  const root=doc.getElementById('root');if(!root||root.hidden||root.inert)return false;
  const rootStyle=doc.defaultView?.getComputedStyle(root);if(rootStyle?.display==='none'||rootStyle?.visibility==='hidden'||rootStyle?.visibility==='collapse')return false;
  return [...root.children].some(child=>{
   if(!(child instanceof doc.defaultView!.HTMLElement)||['SCRIPT','STYLE'].includes(child.tagName)||child.hidden||child.inert)return false;
   const computed=doc.defaultView?.getComputedStyle(child);return computed?.display!=='none'&&computed?.visibility!=='hidden'&&computed?.visibility!=='collapse';
  });
 };
 const check=()=>{
  if(state!=='authorized'||!waiters.size||frame!==undefined||!visibleRoot())return;
  frame=surface.requestAnimationFrame(()=>{
   frame=undefined;if(state!=='authorized'||!visibleRoot())return;
   state='mounted';stopWatch();for(const waiter of [...waiters]){waiters.delete(waiter);waiter.release();waiter.resolve();}
  });
 };
 const fail=(error?:unknown)=>{
  if(['canceled','disposed','failed'].includes(state))return;
  state='failed';stop();rejectWaiting(error instanceof Error?error:timeoutError());
  // Never unhide this surface: a live admission gate may own its hidden state.
  heading.textContent='工作台暂时未能加载';detail.textContent=canReload()?'资源加载尚未完成，请刷新后重试。':'界面初始化未完成，当前画布内容仍保留，请保持页面打开。';
  if(canReload())showRetry('刷新重试',reloadBeforeMount);else card.replaceChildren(heading,detail);
 };
 const preparing=()=>{
  if(state!=='authorized')return;retrying=false;heading.textContent='正在加载工作台';
  detail.textContent=delayed?'资源仍在加载，完成后会自动打开。':'正在加载界面资源…';
  if(delayed)showRetry('重新加载',reloadBeforeMount);else card.replaceChildren(heading,detail);
 };
 const retryConnection=(retry:()=>void)=>{
  if(state!=='authorized')return;retrying=true;heading.textContent='正在恢复连接';detail.textContent='连接暂时不可用，恢复后会自动打开工作台。';
  showRetry('立即重试',()=>{if(state==='authorized'){card.querySelector('button')?.setAttribute('disabled','');retry();}});
 };
 const authorized=()=>{
  if(state!=='pending')return;state='authorized';heading.textContent='正在加载工作台';detail.textContent='正在加载界面资源…';
  slow=setTimeout(()=>{if(state==='authorized'&&!retrying)detail.textContent='首次打开需要下载界面资源，仍在加载，请稍候…';},slowAfter);
  // A slow download is not a failed initialization. Keep the original import
  // and mount observer alive so a late successful commit can release this UI.
  timeout=setTimeout(()=>{if(state!=='authorized')return;delayed=true;if(!retrying)preparing();},recoveryAfter);
  check();
 };
 const waitForRootMount=(signal?:AbortSignal)=>{
  if(signal?.aborted||['canceled','disposed'].includes(state))return Promise.reject(abortError());
  if(state==='failed')return Promise.reject(timeoutError());
  if(state==='mounted')return Promise.resolve();
  return new Promise<void>((resolve,reject)=>{
   const aborted=()=>{waiters.delete(waiter);waiter.release();if(!waiters.size)stopWatch();reject(abortError());};
   const waiter={resolve,reject,release:()=>signal?.removeEventListener('abort',aborted)};waiters.add(waiter);signal?.addEventListener('abort',aborted,{once:true});
   if(!observer){observer=new doc.defaultView!.MutationObserver(check);observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','inert','class','style']});}check();
  });
 };
 const disconnect=()=>{if(state==='disposed')return;state='disposed';stop();rejectWaiting(abortError());panel.remove();style.remove();};
 const cancel=()=>{
  if(['canceled','disposed'].includes(state))return;state='canceled';stop();rejectWaiting(abortError());
  // Synchronous identity cleanup must never reveal an already mounted root.
  // The login gate will retain this block and require a fresh document.
  const root=doc.getElementById('root');if(root){root.hidden=true;root.inert=true;}panel.remove();style.remove();
 };
 const finish=()=>{if(state==='mounted')disconnect();};
 return{authorized,preparing,retryConnection,waitForRootMount,finish,fail,cancel,disconnect};
}
