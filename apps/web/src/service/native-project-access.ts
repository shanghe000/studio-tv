import {canvasProjectFromPath} from './canvas-lifecycle';

/** Project permissions control local UI input. They do not lock the manager's
 * remote-update seam: viewers must still receive authoritative snapshots. */
export function installNativeProjectAccess(runtime:any,native:any,props:(element:any)=>any[],surface:any=window,doc:any=document){
 const store=native.bq;if(typeof store?.getState!=='function'||typeof runtime.storage?.subscribeAccess!=='function')return()=>{};
 let disposed=false,mode='',readOnly=false,router:any,routerRelease:(()=>void)|undefined,observer:any;
 const set=(value:boolean)=>{const state=store.getState();if(state.isRead!==value){if(typeof state.setIsRead==='function')state.setIsRead(value);else store.setState?.({isRead:value});}};
 const apply=()=>{
  if(disposed)return;const id=canvasProjectFromPath(router?.state?.location?.pathname??surface.location.pathname),next=id?`${id}:${runtime.storage.canEdit(id)}`:'';
  if(next!==mode){const priorReadOnly=readOnly;mode=next;readOnly=!!id&&!runtime.storage.canEdit(id);if(id)set(readOnly);else if(priorReadOnly)set(false);}
  // Native temporary editors restore a captured global read flag on close.
  // That restoration may never unlock an actual viewer attachment.
  if(readOnly)set(true);
 };
 const releaseAccess=runtime.storage.subscribeAccess(apply),releaseStore=store.subscribe?.(()=>{if(readOnly)set(true);});
 const find=()=>{if(disposed||router)return;const root=doc.getElementById('root');if(!root)return;for(const element of [root.firstElementChild,...Array.from(root.children||[])]){const found=props(element).map(p=>p.router??p.value?.router).find(r=>typeof r?.subscribe==='function'&&r.state?.location);if(found){router=found;routerRelease=router.subscribe(apply);observer?.disconnect();apply();return;}}};
 find();if(!router){observer=new surface.MutationObserver(find);observer.observe(doc.getElementById('root')??doc.body,{childList:true,subtree:true});}apply();
 const dispose=()=>{if(disposed)return;disposed=true;releaseAccess();releaseStore?.();routerRelease?.();observer?.disconnect();surface.removeEventListener('popstate',apply);surface.removeEventListener('pageshow',apply);if(readOnly)set(false);};
 surface.addEventListener('popstate',apply);surface.addEventListener('pageshow',apply);return dispose;
}
