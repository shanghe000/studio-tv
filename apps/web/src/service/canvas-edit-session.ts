import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import {canvasProjectFromPath} from './canvas-lifecycle';
import type {ProductClient} from './product-client';
import {CanvasHandoffSession} from './canvas-handoff';
import {canvasTabResume} from './canvas-tab-resume';

export interface CanvasEditSessionReceipt {projectId:string;clientId:string;expiresAt:string;ttlSeconds:30}
export interface CanvasEditSessionState {status:'connecting'|'editing'|'occupied'|'offline'|'readonly';message?:string}
/** One editing page per canvas. The server owns the lease; the browser never
 * reuses another page's identity or treats a failed renewal as ownership. */
export class CanvasEditSessionClient {
 readonly clientId=randomUuid();
 private view:CanvasEditSessionState={status:'connecting'};
 private listeners=new Set<()=>void>();
 private deadline=0;
 private renewAt=0;
 private retryAt=0;
 private backoff=2000;
 private generation=0;
 private stopped=false;
 private started=false;
 private request:Promise<void>|null=null;
 private controller:AbortController|null=null;
 private timer:ReturnType<typeof setInterval>|undefined;
 constructor(readonly api:ProductClient,readonly projectId:string,readonly userId:string,private isCurrent:()=>boolean,private canEdit:()=>boolean,private sameIdentity:()=>boolean,private now=()=>Date.now()){}
 readonly current=()=>!this.stopped&&this.isCurrent();
 state(){return{...this.view};}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 private update(view:CanvasEditSessionState){this.view=view;for(const listener of this.listeners)listener();}
 holds(){return this.current()&&this.canEdit()&&this.view.status==='editing'&&this.deadline>this.now()+250;}
 private path(){return'/projects/'+encodeURIComponent(this.projectId)+'/edit-session';}
 readonly ensure=():Promise<void>=>this.holds()?Promise.resolve():this.renew();
 private renew():Promise<void>{
  if(!this.current())return Promise.reject(new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开。'));
  if(!this.canEdit()){this.deadline=0;this.update({status:'readonly',message:'当前账号只有查看权限。'});return Promise.reject(new ApiError(403,'READ_ONLY','当前账号只有查看权限。'));}
  if(this.request)return this.request;const generation=this.generation,sentAt=this.now(),controller=new AbortController();this.controller=controller;
  const work=(async()=>{try{
   const {data}=await this.api.requestV2<CanvasEditSessionReceipt>(this.path(),{method:'POST',body:{clientId:this.clientId},signal:controller.signal});
   if(generation!==this.generation||!this.current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开。');
   if(data?.projectId!==this.projectId||data.clientId!==this.clientId||data.ttlSeconds!==30||!Number.isFinite(Date.parse(data.expiresAt))||sentAt+30000<=this.now()+250)throw new ApiError(502,'INVALID_EDIT_SESSION','编辑连接暂时不可用，请重试。');
   this.deadline=sentAt+30000;this.renewAt=sentAt+10000;this.retryAt=0;this.backoff=2000;this.update({status:'editing'});
  }catch(error){
   if(generation!==this.generation||!this.current())throw error;this.deadline=0;
   const permanent=error instanceof ApiError&&[401,403,404].includes(error.status),occupied=error instanceof ApiError&&error.code==='PROJECT_EDIT_OCCUPIED';
   this.retryAt=permanent?Infinity:this.now()+this.backoff;this.backoff=Math.min(10000,this.backoff*2);
   this.update(permanent?{status:'readonly',message:error.message}:occupied?{status:'occupied',message:error.message}:{status:'offline',message:'连接暂时中断，正在重新连接画布。'});throw error;
  }})();this.request=work;void work.finally(()=>{if(this.request===work){this.request=null;this.controller=null;}}).catch(()=>{});return work;
 }
 start(){if(!this.started){this.started=true;this.timer=setInterval(()=>{
  if(!this.current()||this.request)return;const now=this.now();
  if(this.view.status==='editing'&&this.deadline<=now+250){this.deadline=0;this.retryAt=now;this.update({status:'offline',message:'编辑连接正在恢复。'});}
  if(this.view.status==='editing'?now>=this.renewAt:now>=this.retryAt&&this.view.status!=='readonly')void this.renew().catch(()=>{});
 },1000);}return this.ensure();}
 offline(){if(!this.current())return;this.generation++;this.controller?.abort();this.controller=null;this.request=null;this.deadline=0;this.retryAt=Infinity;this.update({status:'offline',message:'网络已断开，恢复后会自动连接。'});}
 invalidate(error?:unknown){
  if(!this.current())return;this.generation++;this.controller?.abort();this.controller=null;this.request=null;this.deadline=0;
  const occupied=error instanceof ApiError&&error.code==='PROJECT_EDIT_OCCUPIED';this.retryAt=this.now()+(occupied?2000:0);
  this.update(occupied?{status:'occupied',message:error.message}:{status:'offline',message:'编辑连接正在恢复。'});
  if(!occupied)void this.ensure().catch(()=>{});
 }
 online(){if(!this.current())return;this.retryAt=0;void this.ensure().catch(()=>{});}
 stop(){
  if(this.stopped)return;this.stopped=true;this.generation++;this.deadline=0;this.controller?.abort();this.controller=null;this.request=null;clearInterval(this.timer);this.listeners.clear();
  // A late old-page DELETE can only release that old client ID. Auth changes
  // must never send the previous page's release with a different identity.
  if(this.started&&this.sameIdentity())void this.api.requestV2(this.path(),{method:'DELETE',body:{clientId:this.clientId},headers:{'X-STUDIO-Canvas-Session':this.clientId},keepalive:true,retryAuth:false}).catch(()=>{});
 }
}

/** Use native read-only mode while a whole-canvas session is unavailable.
 * Once held, native pointer/keyboard/drag protocols run completely unchanged. */
export function installCanvasEditSession(runtime:any,native:any,surface:any=window,doc:Document=document,notice:(text:string)=>void=()=>{}){
 if(typeof runtime.setCanvasEditSession!=='function'||!runtime.api||!runtime.auth?.onClear)return()=>{};
 const style=doc.createElement('style');style.textContent=canvasEditSessionStyles;doc.head.append(style);
 const panel=doc.createElement('aside'),message=doc.createElement('p'),actions=doc.createElement('div');
 panel.className='studio-canvas-edit-session';panel.setAttribute('data-studio-canvas-edit-session','');
 message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 panel.hidden=true;panel.append(message,actions);doc.body.append(panel);
 let disposed=false,suspended=false,attachment:any=null,user='',client:CanvasHandoffSession|null=null;
 let releaseClient:(()=>void)|undefined,releaseStore:(()=>void)|undefined,restorers:(()=>void)[]=[];
 let ownsReadLock=false,wasEditing=false,ime=false,pointer=false,focused=false,historyEpoch=0;
 let resume:ReturnType<typeof canvasTabResume>|undefined,channel:BroadcastChannel|undefined;
 const store=native.bq,current=()=>!disposed&&!suspended&&!!client&&runtime.auth.user?.id===user&&runtime.canvasAttachment()?.id===attachment?.id&&runtime.canvasAttachment()?.client===attachment?.client;
 const allowed=()=>current()&&runtime.storage.canEdit(attachment.id)&&client!.holds();
 let historyProject=canvasProjectFromPath(surface.location.pathname),historyIdentity=runtime.auth.user?.id,historyManager:any;
 const historyScope=(project:string|null,identity:string|undefined,manager:any)=>{
  if(project!==historyProject||identity!==historyIdentity||historyManager&&manager&&historyManager!==manager)historyEpoch++;
  historyProject=project;historyIdentity=identity;if(manager)historyManager=manager;
 };
 const readOnly=(value:boolean)=>{const state=store?.getState?.();if(!state)return;if(value){if(state.isRead)return;ownsReadLock=true;}else{if(!ownsReadLock)return;ownsReadLock=false;}if(state.isRead!==value){if(typeof state.setIsRead==='function')state.setIsRead(value);else store.setState?.({isRead:value});}};
 const foreground=()=>doc.visibilityState!=='hidden'&&doc.hasFocus();
 const tool=(label:string,action:()=>Promise<void>|undefined)=>{
  const button=doc.createElement('button');button.type='button';button.textContent=label;button.hidden=true;
  button.onclick=()=>{if(!current()||button.disabled)return;button.disabled=true;void Promise.resolve(action()).catch(()=>{}).finally(()=>{button.disabled=false;render();});};
  actions.append(button);return button;
 };
 const retry=tool('重试连接',()=>client?.retry()),ask=tool('申请编辑',()=>client?.requestEdit()),cancel=tool('取消申请',()=>client?.cancelRequest());
 const approve=tool('保存并交接',()=>client?.decision('APPROVE')),decline=tool('暂不交接',()=>client?.decision('DECLINE'));
 const buttons=[retry,ask,cancel,approve,decline];
 let busySince:number|undefined,busyTimer:ReturnType<typeof setTimeout>|undefined;
 const clearBusy=()=>{clearTimeout(busyTimer);busyTimer=undefined;busySince=undefined;};
 function render(){
  if(!current()){panel.hidden=true;return;}
  const state=client!.state(),held=allowed(),resumed=held&&!wasEditing;wasEditing=held;readOnly(!held);
  if(resumed&&runtime.storage.hasDraft?.(attachment.id))void Promise.resolve(runtime.resumeCanvasOperations?.(attachment.id)).catch(()=>{});
  const show=(text:string,...shown:HTMLButtonElement[])=>{
   if(message.textContent!==text)message.textContent=text;
   for(const button of buttons)button.hidden=!shown.includes(button);
   panel.hidden=false;
  };
  // Most admissions finish before a message would be useful. Delay the
  // passive progress chip, keeping actual requests and lost networks immediate.
  const passive=state.status==='connecting'||state.status==='syncing'||(state.status==='offline'&&state.message==='正在重新连接画布…');
  panel.toggleAttribute('data-quiet',passive);
  if(passive){
   busySince??=Date.now();
   const left=1200-(Date.now()-busySince);
   if(left>0){
    panel.hidden=true;
    busyTimer??=setTimeout(()=>{busyTimer=undefined;render();},left);return;
   }
  }else clearBusy();
  if(state.accountHandoff){show(state.message??'正在保存修改并交接。');return;}
  switch(state.status){
   case 'editing':
    if(state.incoming){
     if(state.incoming.sameAccount)show(state.message??'正在把编辑权切换到正在使用的页面。');
     else show(state.message??state.incoming.displayName+' 想编辑此画布。',approve,decline);
    }else panel.hidden=true;
    break;
   case 'occupied':
    ask.textContent=state.holder?.userId===user?'切换到此页编辑':state.holder?'申请编辑':'开始编辑';
    const oldPeer=state.holder?.userId!==user&&state.holder?.canApprove===false;
    if(oldPeer){
     show(state.holder!.displayName+' 正在使用旧版画布，请对方刷新或退出后再接手。',...(state.outgoing?.state==='PENDING'?[cancel]:[ask]));
    }else if(state.outgoing?.state==='PENDING'){
     show(state.outgoing.sameAccount?'正在等待上一页保存。上一页没有响应时会自动恢复。':'已申请编辑，等待对方保存并交接。你可以继续查看。',cancel);
    }else if(state.holder?.userId===user)show('你的另一页正在编辑。切回此页会自动接手。',ask);
    else if(state.holder)show(state.message??state.holder.displayName+' 正在编辑。你可以继续查看或申请编辑。',ask);
    else show(state.message??'正在查看画布。',ask);
    break;
   case 'readonly':show(state.message??'当前账号只有查看权限。');break;
   case 'offline':show(state.message??'正在重新连接画布。',...(passive?[]:[retry]));break;
   default:show(state.message??'正在打开画布…');
  }
 }
 const prepareNative=()=>{
  if(ime||pointer)return false;
  const input=doc.activeElement as HTMLElement|null;
  if(input?.matches('input,textarea,[contenteditable]:not([contenteditable="false"])')&&input.closest('.react-flow,.ce-node-toolbar,.config-panel-wrap,.config-panel-modal-content,.rh-params-card,.rh-image-node-local-ui'))input.blur();
  attachment?.client?.flushOperationQueue?.(true);
  return true;
 };
 const restore=()=>{for(const callback of restorers.splice(0).reverse())callback();};
 const wrap=(manager:any,name:string,blocked:any)=>{const original=manager?.[name];if(typeof original!=='function')return;const owned=function(this:any,...args:any[]){if(!allowed())return typeof blocked==='function'?blocked():blocked;return original.apply(this,args);};manager[name]=owned;restorers.push(()=>{if(manager[name]===owned)manager[name]=original;});};
 const leave=()=>{clearBusy();releaseClient?.();releaseClient=undefined;client?.stop();resume?.close();resume=undefined;channel?.close();channel=undefined;pointer=false;ime=false;runtime.setCanvasEditSession(null);restore();readOnly(false);client=null;attachment=null;user='';wasEditing=false;panel.hidden=true;};
 const refresh=()=>{
  if(disposed||suspended)return;const next=runtime.canvasAttachment?.(),identity=runtime.auth.user?.id;
  historyScope(canvasProjectFromPath(surface.location.pathname),identity,next?.client);
  if(next?.id===attachment?.id&&next?.client===attachment?.client&&identity===user){render();return;}
  leave();if(!next||!identity||canvasProjectFromPath(surface.location.pathname)!==next.id)return;attachment=next;user=identity;
  focused=foreground();
  if(typeof surface.BroadcastChannel==='function'){
   channel=new surface.BroadcastChannel('studio-canvas-edit:'+identity+':'+next.id);
   channel!.onmessage=()=>client?.wake();
  }
  const owned:CanvasHandoffSession=new CanvasHandoffSession(runtime.api,next.id,identity,()=>current()&&client===owned,
   ()=>runtime.storage.canEdit(next.id),()=>runtime.auth.user?.id===identity,{
    foreground,visible:()=>doc.visibilityState!=='hidden',beforeDrain:prepareNative,
    prepare:(signal,progress)=>runtime.prepareCanvasHandoff(next.id,owned.clientId,signal,progress),
    sync:(signal,progress)=>runtime.syncCanvasHandoff(next.id,owned.clientId,signal,progress),
    finish:(signal,progress)=>runtime.finishCanvasHandoff(next.id,owned.clientId,signal,progress),
    recheckAccess:async signal=>{await runtime.storage.refreshAccess(next.id);signal.throwIfAborted();},
    resume:()=>{resume??=canvasTabResume(surface,identity,next.id);return resume.resume();},remember:token=>resume?.remember(token),forgetResume:()=>resume?.forget(),changed:()=>channel?.postMessage('changed'),
    leaseChanged:term=>{
     if(client===owned&&runtime.canvasAttachment()?.client===next.client&&runtime.auth.user?.id===identity)
      runtime.api.setCanvasSession?.(next.id,owned.clientId,owned.pageProof,term);
    },
   });
  client=owned;
  readOnly(true);for(const name of ['enqueue','moveNodes','addEdge','removeEdge','addNode','removeNode','patchNodeData','patchNodeMeta','pasteGraph','updateCanvasMeta','applyHistoryTransition','markUndoBoundary','undo','redo'])wrap(next.client,name,false);wrap(next.client,'appendNodeOutputHistoryEntry','not-found');wrap(next.client,'removeNodeOutputHistoryItem',()=>({status:'unavailable'}));
  runtime.setCanvasEditSession(owned);releaseClient=owned.subscribe(render);render();void owned.start().catch(()=>{});
 };

 releaseStore=store?.subscribe?.(()=>{if(current()&&!allowed())readOnly(true);});
 const offline=()=>client?.offline(),online=()=>client?.online(),pagehide=()=>{if(disposed)return;suspended=true;leave();},pageshow=()=>{if(disposed)return;suspended=false;refresh();};
 const releaseAuth=runtime.auth.onClear(()=>{historyEpoch++;leave();readOnly(true);}),releaseAccess=runtime.storage.subscribeAccess?.(()=>{if(current()&&!runtime.storage.canEdit(attachment.id)){leave();refresh();}else if(current()&&client?.state().status==='readonly'){client.online();render();}else refresh();});
 // Frozen XTe.restoreCanvasHistoryNode ignores pasteGraph's false return,
 // then adds an optimistic React node and reports success. Its history modal
 // is outside the canvas input shield, and its detail read can finish after
 // losing edit access. Gate this exact synchronous callback before either
 // store changes; a rejected import must leave the history chooser open. The
 // native manager is reused on quick route changes, so object identity alone
 // cannot authorize a late detail response after a project/account roundtrip.
 const react=native.r,originalCallback=react?.useCallback;
 const historyCallback=typeof originalCallback==='function'?function(this:any,fn:Function,deps:any[]){
  if(deps?.length!==4||typeof deps[3]!=='function')return originalCallback.call(this,fn,deps);
  const source=Function.prototype.toString.call(fn);
  if(!/\bter\(/.test(source)||!source.includes('pasteGraph(')||!source.includes('flushOperationQueue('))return originalCallback.call(this,fn,deps);
  const project=canvasProjectFromPath(surface.location.pathname),identity=runtime.auth.user?.id,owner=native.bt?.()??attachment?.client;
  historyScope(project,identity,owner);const epoch=historyEpoch;
  return originalCallback.call(this,(...args:any[])=>{
   if(disposed)return null;
   if(epoch!==historyEpoch||!project||!identity||canvasProjectFromPath(surface.location.pathname)!==project||runtime.auth.user?.id!==identity||attachment?.id!==project||owner&&attachment?.client!==owner||native.bt&&native.bt()!==attachment?.client){
    notice('画布或账号已切换，请在当前画布重新选择历史内容。');return null;
   }
   if(!allowed()||store?.getState?.().isRead===true||attachment.client.isWriteBlocked?.()){
    notice(runtime.storage.canEdit(project)?'画布暂时无法编辑，历史内容尚未加入。连接恢复或取得编辑权限后，请再次点击使用。':'当前画布只有查看权限，无法将历史内容加入画布。');render();return null;
   }
   return fn(...args);
  },[...deps,project,identity,owner,epoch]);
 }:undefined;
 if(historyCallback)react.useCallback=historyCallback;
 const jsxRestorers:(()=>void)[]=[];
 for(const name of ['jsx','jsxs']){const original=native.j?.[name];if(typeof original!=='function')continue;const wrapper=function(this:any,type:any,properties:any,...args:any[]){
  if(canvasProjectFromPath(surface.location.pathname)&&Array.isArray(properties?.nodes)&&Array.isArray(properties?.edges)&&typeof properties.onNodesChange==='function'&&typeof properties.onEdgesChange==='function'){
   const before=properties.onBeforeDelete,owner=attachment?.client,project=attachment?.id,identity=user,active=()=>allowed()&&attachment?.client===owner&&attachment?.id===project&&user===identity;properties={...properties,onBeforeDelete:(...values:any[])=>{if(!active())return false;const result=before?.(...values)??true;return result&&typeof result.then==='function'?Promise.resolve(result).then(value=>active()?value:false):active()?result:false;}};
  }return original.call(this,type,properties,...args);
 };native.j[name]=wrapper;jsxRestorers.push(()=>{if(native.j[name]===wrapper)native.j[name]=original;});}
 const focusChanged=(event:Event)=>{
  if(event.type==='blur'||doc.visibilityState==='hidden'){
   pointer=false;focused=false;client?.background();return;
  }
  const active=foreground();if(active===focused)return;focused=active;
  if(active)client?.activate();else {pointer=false;client?.background();}
 };
 const pointerStart=(event:Event)=>{
  if(!(event.target instanceof Element)||!event.target.closest('.react-flow,.config-panel-wrap,.rh-params-card,.ce-node-toolbar'))return;
  if(event.isTrusted&&doc.visibilityState!=='hidden')client?.activate(true);
  if(allowed())pointer=true;
 };
 const wakePendingSwitch=()=>{if(client?.state().incoming?.sameAccount)client.wake();};
 const pointerEnd=()=>{pointer=false;wakePendingSwitch();};
 const composeStart=()=>{ime=true;};
 const composeEnd=()=>{ime=false;wakePendingSwitch();};
 surface.addEventListener('focus',focusChanged);surface.addEventListener('blur',focusChanged);doc.addEventListener('visibilitychange',focusChanged);
 surface.addEventListener('pointerdown',pointerStart,true);surface.addEventListener('pointerup',pointerEnd,true);surface.addEventListener('pointercancel',pointerEnd,true);
 surface.addEventListener('compositionstart',composeStart,true);surface.addEventListener('compositionend',composeEnd,true);
 const releaseFocus=()=>{
  surface.removeEventListener('focus',focusChanged);surface.removeEventListener('blur',focusChanged);doc.removeEventListener('visibilitychange',focusChanged);
  surface.removeEventListener('pointerdown',pointerStart,true);surface.removeEventListener('pointerup',pointerEnd,true);surface.removeEventListener('pointercancel',pointerEnd,true);
  surface.removeEventListener('compositionstart',composeStart,true);surface.removeEventListener('compositionend',composeEnd,true);
 };
 const blockInput=(event:Event)=>{
  if(!current()||allowed()||!(event.target instanceof Element))return;
  if(event.type==='pointerdown'&&(event.target.matches('.react-flow__pane,.react-flow__viewport')||event.target.closest('.react-flow__controls,.react-flow__minimap,.canvas-bottom-controls-row,.canvas-bottom-pill,video,audio')))return;
  const inCanvas=!!event.target.closest('.rh-canvas-board,.rh-canvas-flow,.react-flow,.ce-node-toolbar,.rh-params-card,.config-panel-wrap,.config-panel-modal-content,.group-toolbar');
  const keyboard=event as KeyboardEvent,key=keyboard.key||'',mutationKey=['Delete','Backspace','Enter'].includes(key)||key.length===1&&!keyboard.metaKey&&!keyboard.ctrlKey||!!(keyboard.metaKey||keyboard.ctrlKey)&&['z','v','x'].includes(key.toLowerCase());
  if(event.type==='keydown'&&!mutationKey)return;if(!inCanvas&&!(event.type==='keydown'&&event.target===doc.body))return;
  event.preventDefault();event.stopImmediatePropagation();render();
 };
 const inputListeners=['pointerdown','beforeinput','paste','cut','drop','keydown'];for(const name of inputListeners)surface.addEventListener(name,blockInput,true);
 const listeners:Array<[string,EventListener]>=[['rhtv:canvas-attachment',refresh],['popstate',refresh],['pagehide',pagehide],['pageshow',pageshow],['offline',offline],['online',online]];for(const [name,callback]of listeners)surface.addEventListener(name,callback);
 refresh();return()=>{if(disposed)return;leave();disposed=true;releaseFocus();releaseAuth();releaseAccess?.();releaseStore?.();if(historyCallback&&react.useCallback===historyCallback)react.useCallback=originalCallback;for(const restoreJsx of jsxRestorers.reverse())restoreJsx();for(const name of inputListeners)surface.removeEventListener(name,blockInput,true);for(const [name,callback]of listeners)surface.removeEventListener(name,callback);readOnly(false);panel.remove();style.remove();};
}
export const canvasEditSessionStyles=`
.studio-canvas-edit-session{position:fixed;top:76px;right:20px;z-index:1250;box-sizing:border-box;display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;width:max-content;max-width:min(360px,calc(100vw - 40px));padding:12px 16px;border:1px solid #61546e;border-radius:12px;background:#2e2835;color:#f4edf9;font:14px/1.6 Inter,system-ui,sans-serif}
.studio-canvas-edit-session[data-quiet]{font-size:13px;padding:5px 12px;max-width:min(240px,calc(100vw - 40px));pointer-events:none}.studio-canvas-edit-session[data-quiet] p{flex:auto}.studio-canvas-edit-session[hidden],.studio-canvas-edit-session button[hidden]{display:none!important}.studio-canvas-edit-session>div{display:flex;align-items:center;gap:6px}.studio-canvas-edit-session>div:not(:has(button:not([hidden]))){display:none}.studio-canvas-edit-session p{flex:1 1 200px;min-width:0;margin:0;overflow-wrap:anywhere}.studio-canvas-edit-session button{flex:none;min-height:44px;padding:8px 12px;border:1px solid #8d75a1;border-radius:8px;background:#40354c;color:#f4edf9;font:inherit;font-weight:600;cursor:pointer}.studio-canvas-edit-session button:hover:not(:disabled){background:#514160}.studio-canvas-edit-session button:disabled{opacity:.6;cursor:default}.studio-canvas-edit-session button:focus-visible{outline:2px solid #d5b7ef;outline-offset:3px}.studio-canvas-edit-session ::selection{background:#7955a0;color:#fff}
@media(max-width:480px){.studio-canvas-edit-session{right:12px;top:68px;max-width:calc(100vw - 24px);padding:12px}.studio-canvas-edit-session p{flex-basis:180px}}
`;
