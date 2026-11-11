import {canvasProjectFromPath} from './canvas-lifecycle';

/** A quiet save-status surface. Recovery choices and maintenance exports stay
 * outside the product UI; retries never supply choices or discard content. */
export function installDraftRecoveryUi(runtime:any,doc:Document=document,surface:Window & typeof globalThis=window){
 if(typeof runtime.storage?.subscribeDrafts!=='function')return()=>{};
 let disposed=false,queued=false,currentKey='',busyKey='',operation:symbol|undefined,requestId='';
 const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const item=doc.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
 const style=node('style');style.id='studio-canvas-sync-styles';style.textContent=draftRecoveryStyles;doc.head.append(style);
 const status=node('aside'),message=node('p'),retry=node('button','重试同步'),log=node('p');
 status.className='studio-canvas-sync-status';status.setAttribute('data-studio-canvas-sync-status','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');status.hidden=true;
 message.setAttribute('data-sync-message','');log.setAttribute('data-sync-log','');log.hidden=true;retry.type='button';retry.setAttribute('data-sync-retry','');status.append(message,retry,log);doc.body.append(status);
 const project=()=>String(runtime.canvasAttachment?.()?.id??runtime.inspect?.().id??canvasProjectFromPath(surface.location.pathname)??'');
 const key=()=>runtime.auth.user?.id&&project()?runtime.auth.user.id+':'+project():'';
 const current=(owner:string)=>!disposed&&owner===key();
 const refresh=()=>{
  if(disposed||queued)return;queued=true;queueMicrotask(()=>{
   queued=false;if(disposed)return;const owner=key();if(owner!==currentKey){currentKey=owner;requestId='';}
   status.hidden=true;if(!owner)return;
   const view=runtime.storage.draftRecoveryState(project()),hasDraft=runtime.storage.hasDraft?.(project())===true;
   const needsSync=view.blocked||!!view.retryableError||view.persistence==='memory-only'&&hasDraft;
   if(!needsSync)return;
   status.hidden=false;const busy=busyKey===owner||view.busy,canEdit=runtime.storage.canEdit?.(project())!==false;
   status.setAttribute('aria-busy',String(busy));retry.disabled=busy||!canEdit||typeof runtime.retryCanvasSync!=='function';retry.textContent=busy?'正在同步…':'重试同步';
   const retained=view.persistence==='saved'?'内容已保留在当前设备。':'内容保留在当前页面。';
   message.textContent=busy?'正在重新连接，当前修改已保留。':!canEdit?'部分修改尚未同步，'+retained+'恢复编辑权限后可继续同步。':'部分修改尚未同步，'+retained;
   log.textContent=requestId?'日志编号：'+requestId:'';log.hidden=!requestId;
  });
 };
 retry.onclick=()=>{
  const owner=key();if(!owner||retry.disabled||busyKey===owner||typeof runtime.retryCanvasSync!=='function')return;
  const token=Symbol('canvas-sync-retry');operation=token;busyKey=owner;requestId='';refresh();
  void(async()=>{
   try{await runtime.retryCanvasSync();}
   catch(error){if(current(owner)){const id=error&&typeof error==='object'?(error as {requestId?:unknown}).requestId:undefined;if(typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))requestId=id;}}
   finally{if(operation===token){operation=undefined;busyKey='';}refresh();}
  })();
 };
 const observer=new surface.MutationObserver(records=>{if(records.some(record=>!(record.target instanceof Element&&record.target.closest('[data-studio-canvas-sync-status]'))))refresh();});observer.observe(doc.body,{childList:true,subtree:true});
 const release=runtime.storage.subscribeDrafts(refresh),releaseAuth=runtime.auth.onClear(refresh);
 surface.addEventListener('popstate',refresh);surface.addEventListener('rhtv:canvas-attachment',refresh);refresh();
 return()=>{disposed=true;operation=undefined;observer.disconnect();release();releaseAuth();surface.removeEventListener('popstate',refresh);surface.removeEventListener('rhtv:canvas-attachment',refresh);status.remove();style.remove();};
}

export const draftRecoveryStyles=`
.studio-canvas-sync-status{position:fixed;right:20px;bottom:20px;z-index:1250;box-sizing:border-box;display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;width:max-content;max-width:min(360px,calc(100vw - 40px));padding:12px 16px;border:1px solid #61546e;border-radius:12px;background:#2e2835;color:#f4edf9;font:14px/1.6 Inter,system-ui,sans-serif}
.studio-canvas-sync-status[hidden]{display:none!important}.studio-canvas-sync-status p{flex:1 1 200px;min-width:0;margin:0;overflow-wrap:anywhere}.studio-canvas-sync-status button{flex:none;min-height:44px;padding:8px 12px;border:1px solid #8d75a1;border-radius:8px;background:#40354c;color:#f4edf9;font:inherit;font-weight:600;cursor:pointer}.studio-canvas-sync-status button:hover:not(:disabled){background:#514160}.studio-canvas-sync-status button:disabled{opacity:.6;cursor:default}.studio-canvas-sync-status button:focus-visible{outline:2px solid #d5b7ef;outline-offset:3px}.studio-canvas-sync-status [data-sync-log]{flex-basis:100%;color:#ddd0e7;font-size:12px}.studio-canvas-sync-status ::selection{background:#7955a0;color:#fff}
@media(max-width:480px){.studio-canvas-sync-status{right:12px;bottom:16px;max-width:calc(100vw - 24px);padding:12px}.studio-canvas-sync-status p{flex-basis:180px}}
`;
