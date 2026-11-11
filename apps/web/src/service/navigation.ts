/** Canonical editor directories also avoid previously cached permanent redirects. */
export function embeddedEditorURL(source:string,origin:string){
 try{const url=new URL(source,origin);if(url.origin!==origin||url.username||url.password||!['/labs/rhhyperframes','/hyperframes-studio','/opencut'].includes(url.pathname))return undefined;url.pathname+='/';return url.href;}catch{return undefined;}
}

/** Native Studio output tabs need a persisted, scoped URL before ordinary navigation. */
export function installStudioNavigation(runtime:any,notice:(text:string)=>void,surface:any=window){
 const original=surface.open,opened=new Set<any>();let epoch=0,disposed=false;
 const native=(value:unknown)=>{if(typeof value!=='string')return false;try{const url=new URL(value,surface.location.href);return url.origin===surface.location.origin&&!url.username&&!url.password&&!url.hash&&/^\/studio-api\/projects\/[^/]+\/(?:preview(?:\/.*)?|renders\/file\/[^/]+)$/.test(url.pathname);}catch{return false;}};
 const open=function(url?:string|URL,target?:string,features?:string){
  if(disposed||!native(url)||target&&target!=='_blank')return original.call(surface,url,target,features);
  if(!runtime.auth.user){notice('请先登录。');return null;}
  const popup=original.call(surface,'about:blank',target,features);if(!popup)return null;
  opened.add(popup);const current=epoch;
  void runtime.studio.resolveNavigation(String(url)).then((resolved:string|undefined)=>{
   if(disposed||current!==epoch||popup.closed)return;
   if(!resolved)throw new Error('Studio 导航未返回已保存的素材地址。');
   // A user may navigate the newly opened tab while authorization is loading.
   if(popup.location.href!=='about:blank')return;
   popup.opener=null;popup.location.replace(resolved);
  }).catch((error:unknown)=>{if(!popup.closed)popup.close();if(!disposed&&current===epoch)notice(error instanceof Error?error.message:'Studio 导航失败。');}).finally(()=>opened.delete(popup));
  return popup;
 };
 surface.open=open;
 const remove=runtime.auth.onClear(()=>{epoch++;for(const popup of opened)if(!popup.closed)popup.close();opened.clear();});
 return()=>{disposed=true;epoch++;remove?.();for(const popup of opened)if(!popup.closed)popup.close();opened.clear();if(surface.open===open)surface.open=original;};
}
