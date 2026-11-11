import {ApiError} from '../api/client';

interface CanvasRoutePort {
 auth:{user:{id:string}|null;onClear(callback:()=>void):()=>void};
 storage:{loadProject(id:string,options?:{signal?:AbortSignal}):Promise<unknown>};
}
const abortError=()=>new DOMException('画布导航已取消。','AbortError');

/** React Router's public routes are the same data-route objects used by its
 * manifest. patchRoutes appends children; it cannot replace an existing route.
 * Install a real loader so route effects cannot request a fake empty graph. */
export function installCanvasRouterLoader(router:any,runtime:CanvasRoutePort,native:any){
 const patched:Array<{route:any;loader:any;revalidate:any;errorElement:any;boundary:any;installed:any;error:any}>=[],pending=new Set<AbortController>();let disposed=false,epoch=0;
 const alwaysRevalidate=()=>true;
 const clear=()=>{epoch++;for(const controller of pending)controller.abort();pending.clear();};
 const releaseIdentity=runtime.auth.onClear(clear);
 const visit=(routes:any[])=>{for(const route of routes){
  if(route.path==='/project/canvas/:id'){
   const original=route.loader,revalidate=route.shouldRevalidate,errorElement=route.errorElement,boundary=route.hasErrorBoundary;
   const loader=async(args:any)=>{
    if(disposed)throw abortError();
    const identity=runtime.auth.user?.id;if(!identity)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
    const id=args.params?.id;if(typeof id!=='string'||!id||id.includes('/'))throw new ApiError(400,'INVALID_PROJECT_ID','项目标识无效。');
    const generation=epoch,controller=new AbortController(),external=args.request?.signal;
    const aborted=()=>controller.abort();if(external?.aborted)aborted();else external?.addEventListener('abort',aborted,{once:true});pending.add(controller);
    const check=()=>{if(disposed||controller.signal.aborted)throw abortError();if(generation!==epoch||runtime.auth.user?.id!==identity)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次画布导航已取消。');};
    let rejectAbort!:(error:Error)=>void;const canceled=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const cancelWait=()=>rejectAbort(abortError());controller.signal.addEventListener('abort',cancelWait,{once:true});
    try{
     check();
     // Cancellation stops this waiter, never every caller sharing a real
     // same-identity load. Storage owns authorization, CAS and fill epochs.
     await Promise.race([runtime.storage.loadProject(id,{signal:controller.signal}),canceled]);check();
     const value=original?await Promise.race([Promise.resolve(original(args)),canceled]):null;check();return value;
    }finally{external?.removeEventListener('abort',aborted);controller.signal.removeEventListener('abort',cancelWait);pending.delete(controller);}
   };
   const ErrorPage=()=>native.r.createElement('main',{className:'route-status-page',role:'alert'},
    native.r.createElement('h1',null,'项目暂时无法打开'),native.r.createElement('p',null,'项目内容尚未成功恢复，请重试。'),
    native.r.createElement('div',null,native.r.createElement('button',{type:'button',onClick:()=>router.revalidate()},'重试恢复'),native.r.createElement('button',{type:'button',onClick:()=>router.navigate('/projects/canvas/me/')},'返回项目')));
   const error=typeof native.r?.createElement==='function'?native.r.createElement(ErrorPage):errorElement;
   route.loader=loader;route.shouldRevalidate=alwaysRevalidate;
   if(error){route.errorElement=error;route.hasErrorBoundary=true;}
   patched.push({route,loader:original,revalidate,errorElement,boundary,installed:loader,error});
  }
  if(Array.isArray(route.children))visit(route.children);
 }};
 visit(router.routes);
 if(!patched.length){releaseIdentity();throw new Error('未找到画布路由，无法安全恢复项目内容。');}
 return()=>{
  if(disposed)return;disposed=true;clear();releaseIdentity();
  for(const row of patched){if(row.route.loader===row.installed)row.route.loader=row.loader;if(row.route.shouldRevalidate===alwaysRevalidate)row.route.shouldRevalidate=row.revalidate;if(row.route.errorElement===row.error){row.route.errorElement=row.errorElement;row.route.hasErrorBoundary=row.boundary;}}
 };
}

/** Discover the already mounted RouterProvider instead of wrapping history or
 * throwing a Promise from the immutable canvas's useEffect. Cold bootstrap
 * retains its own ready() load before this integration can be discovered. */
export function installCanvasRouteLoader(runtime:CanvasRoutePort,native:any,props:(element:any)=>any[],surface:any=window,doc:any=document){
 let disposed=false,release:(()=>void)|undefined,observer:any;
 const attach=()=>{
  if(disposed||release)return;const root=doc.getElementById('root');if(!root)return;
  for(const element of [root.firstElementChild,...Array.from(root.children||[])]){
   const router=props(element).map(row=>row.router??row.value?.router).find(value=>value&&Array.isArray(value.routes)&&typeof value.revalidate==='function'&&value.state?.location);
   if(router){release=installCanvasRouterLoader(router,runtime,native);observer?.disconnect();return;}
  }
 };
 const dispose=()=>{if(disposed)return;disposed=true;observer?.disconnect();release?.();surface.removeEventListener('pagehide',hide);};
 const hide=(event:any)=>{if(!event.persisted)dispose();};surface.addEventListener('pagehide',hide);
 attach();if(!release){observer=new surface.MutationObserver(attach);observer.observe(doc.getElementById('root')??doc.body,{childList:true,subtree:true});}
 return dispose;
}
