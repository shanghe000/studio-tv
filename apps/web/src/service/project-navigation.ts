const projectList=/^\/projects\/canvas\/(?:me|team)\/?$/;
const folderPath=(search:string):string[]|null=>{
 const raw=new URLSearchParams(search).get('folderPath');if(!raw)return[];
 try{const value=JSON.parse(raw);if(!Array.isArray(value)||value.length>3||value.some(row=>!row||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(row.id)))return null;return value.map(row=>row.id);}catch{return null;}
};
const locationURL=(location:any,origin:string)=>new URL(String(location.pathname||'/')+String(location.search||'')+String(location.hash||''),origin);
const destination=(to:any,current:URL)=>{
 if(typeof to==='string')return new URL(to,current);
 if(to&&typeof to==='object')return new URL(String(to.pathname??current.pathname)+String(to.search??'')+String(to.hash??''),current.origin);
 return null;
};

/** The inspected native React Router owns history keys, indices and POP events.
 * Change only its folder navigation option; never synthesize browser state. */
export function installProjectFolderRouter(router:any,native:any,origin:string){
 const react=native.r,originalNavigate=router.navigate,patched:Array<{route:any;element:any;replacement:any}>=[];
 const Route=({element}:{element:any})=>{
  const location=native.ac(),previous=react.useRef({pathname:location.pathname,search:location.search,epoch:0}),before=previous.current;
  // Native folder/search state is initialized once. Remount this route's list
  // on folder changes and query-only POPs so URL and local state agree again.
  if(before.pathname===location.pathname&&before.search!==location.search&&router.state.historyAction==='POP')before.epoch++;
  before.pathname=location.pathname;before.search=location.search;
  return react.cloneElement(element,{key:JSON.stringify([location.pathname,folderPath(location.search),before.epoch])});
 };
 const visit=(routes:any[])=>{for(const route of routes){
  if(['canvas/me','canvas/team'].includes(route.path)&&typeof route.element?.type==='function'&&['me','team'].includes(route.element.props?.mode)){
   const element=route.element,replacement=react.createElement(Route,{element});patched.push({route,element,replacement});route.element=replacement;
  }
  if(Array.isArray(route.children))visit(route.children);
 }};
 visit(router.routes);
 if(!patched.length)return()=>{};
 const navigate=function(this:any,to:any,options:any={}){
  let push=false;
  if(options.replace===true&&typeof to!=='number'){
   try{
    const current=locationURL(router.state.location,origin),next=destination(to,current),before=folderPath(current.search),after=next&&folderPath(next.search);
    push=!!(next&&next.origin===current.origin&&next.pathname===current.pathname&&projectList.test(current.pathname)&&before&&after&&JSON.stringify(before)!==JSON.stringify(after));
   }catch{/* Invalid or unrelated navigation retains the framework's behavior. */}
  }
  return originalNavigate.call(router,to,push?{...options,replace:false}:options);
 };
 router.navigate=navigate;
 // Publish the route wrapper even when installation follows the first render.
 router.revalidate();
 return()=>{
  if(router.navigate===navigate)router.navigate=originalNavigate;
  for(const {route,element,replacement}of patched)if(route.element===replacement)route.element=element;
 };
}

/** RouterProvider exposes the existing router in its native React props. Wait
 * for that real seam to mount instead of creating a second routing system. */
export function installNativeProjectFolderNavigation(native:any,props:(element:any)=>any[],surface:any=window,doc:any=document){
 if(typeof native.r?.createElement!=='function'||typeof native.r?.cloneElement!=='function'||typeof native.r?.useRef!=='function'||typeof native.ac!=='function')return()=>{};
 let disposed=false,release:(()=>void)|undefined,observer:any;
 const attach=()=>{
  if(disposed||release)return;
  const root=doc.getElementById('root');if(!root)return;
  for(const element of [root.firstElementChild,...Array.from(root.children||[])]){
   const router=props(element).map(row=>row.router??row.value?.router).find(value=>value&&typeof value.navigate==='function'&&typeof value.revalidate==='function'&&Array.isArray(value.routes)&&value.state?.location);
   if(router){release=installProjectFolderRouter(router,native,surface.location.origin);observer?.disconnect();return;}
  }
 };
 attach();
 if(!release){observer=new surface.MutationObserver(attach);observer.observe(doc.getElementById('root')??doc.body,{childList:true,subtree:true});}
 const pagehide=(event:any)=>{if(!event.persisted)dispose();};
 const dispose=()=>{disposed=true;observer?.disconnect();release?.();surface.removeEventListener('pagehide',pagehide);};
 // A bfcache document resumes without reinstalling native integrations.
 surface.addEventListener('pagehide',pagehide);return dispose;
}
