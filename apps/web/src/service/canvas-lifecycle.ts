export interface CanvasAttachment {id:string;client:any;identityId:string}
export interface CanvasLifecyclePort {
 canvasAttachment():CanvasAttachment|null;
 detachCanvas():void;
 setCanvasPageActive(active:boolean):void;
 attachCanvas(id:string,client:any,identityId?:string):void;
}

export function canvasProjectFromPath(pathname:string):string|null {
 const match=pathname.match(/^\/project\/canvas\/([^/]+)\/?$/);
 if(!match)return null;
 try{const id=decodeURIComponent(match[1]);return id&&!id.includes('/')?id:null;}catch{return null;}
}

/** Subscribe to the existing RouterProvider. Page suspension releases the
 * connection even for bfcache, whose React tree does not unmount. */
export function installCanvasLifecycle(runtime:CanvasLifecyclePort,props:(element:any)=>any[],surface:any=window,doc:any=document){
 let disposed=false,paused=false,suspended:CanvasAttachment|null=null,release:(()=>void)|undefined,observer:any;
 const changed=(state?:any)=>{
  if(disposed||paused)return;
  const attached=runtime.canvasAttachment(),pathname=state?.location?.pathname??surface.location.pathname;
  if(attached&&canvasProjectFromPath(pathname)!==attached.id)runtime.detachCanvas();
 };
 const attachRouter=()=>{
  if(disposed||release)return;
  const root=doc.getElementById('root');if(!root)return;
  for(const element of [root.firstElementChild,...Array.from(root.children||[])]){
   const router=props(element).map(row=>row.router??row.value?.router).find(value=>value&&typeof value.subscribe==='function'&&value.state?.location);
   if(router){release=router.subscribe(changed);changed(router.state);observer?.disconnect();return;}
  }
 };
 const pagehide=(event:any)=>{
  if(disposed)return;
  suspended=runtime.canvasAttachment();paused=true;runtime.setCanvasPageActive(false);
  if(!event.persisted){suspended=null;dispose();}
 };
 const pageshow=(event:any)=>{
  if(disposed)return;
  paused=false;runtime.setCanvasPageActive(true);
  const previous=suspended;suspended=null;
  if(event.persisted&&previous&&canvasProjectFromPath(surface.location.pathname)===previous.id&&previous.client.roomId===previous.id)runtime.attachCanvas(previous.id,previous.client,previous.identityId);
  changed();
 };
 const popstate=()=>changed();
 const dispose=()=>{
  if(disposed)return;
  disposed=true;suspended=null;observer?.disconnect();release?.();runtime.detachCanvas();
  surface.removeEventListener('pagehide',pagehide);surface.removeEventListener('pageshow',pageshow);surface.removeEventListener('popstate',popstate);
 };
 surface.addEventListener('pagehide',pagehide);surface.addEventListener('pageshow',pageshow);surface.addEventListener('popstate',popstate);
 attachRouter();
 if(!release){observer=new surface.MutationObserver(attachRouter);observer.observe(doc.getElementById('root')??doc.body,{childList:true,subtree:true});}
 changed();return dispose;
}
