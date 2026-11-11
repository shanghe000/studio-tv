import {installBrowserCompatibility} from '../browser-compat';
import {installStudioNavigation,embeddedEditorURL} from '../service/navigation';
import {installFeatureUi} from '../features/internal-ui';
import {resolveFeatures} from '../features/policy';
import {installStudioBrand} from '../brand/install';
import {nativeEditorBrand} from '../brand/palette';
// Keep embedded editors on the same local preview boundary as the canvas.
(()=>{
 const applicationBrand=nativeEditorBrand(new URL(location.href).pathname);
 // This script belongs to the three immutable application shells. A generated
 // work may carry the same script URL; never decorate or bridge that work.
 if(!applicationBrand)return;
 installBrowserCompatibility();
 let host=window.parent,runtime;
 localStorage.setItem('hyperframes-studio:telemetryDisabled','1');
 if(host===window){
  // Native editor documents can also be opened directly. Apply presentation
  // without inventing a host session, model catalogue or network bridge.
  let disposed=false,installed=false,brand,policy;
  const installDom=()=>{
   if(disposed||installed)return;if(!document.body)throw new Error('编辑器页面主体未能初始化。');installed=true;
   brand=installStudioBrand({frames:applicationBrand==='frames'});
   policy=installFeatureUi(window.__RHTV_CONFIG__?.features||resolveFeatures(),text=>window.dispatchEvent(new CustomEvent('rhtv:feature-notice',{detail:text})));
  };
  window.addEventListener('pagehide',()=>{disposed=true;document.removeEventListener('DOMContentLoaded',installDom);brand?.disconnect();policy?.disconnect();},{once:true});
  if(document.body)installDom();else if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installDom,{once:true});else installDom();
  return;
 }
 try{for(;;){runtime=host.__RHTV_PREVIEW__;if(runtime||host===host.parent)break;host=host.parent;}}catch(error){throw new Error('无法访问嵌入编辑器的 STUDIO 主页面运行环境。',{cause:error});}
 if(!runtime)throw new Error('嵌入编辑器未找到 STUDIO 主页面运行环境。');
 // Embedded native components receive the same in-memory session view, never a persisted token.
 if(runtime.mode==='service'){
  const sensitive=new Set(['Rh-Accesstoken','Rh-Refreshtoken','Rh-Identify','Rh-Expire-In','Rh-first-login','userId','userInfo']);
  const get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
  Storage.prototype.getItem=function(key){return this===localStorage&&sensitive.has(key)?host.localStorage.getItem(key):get.call(this,key);};
  Storage.prototype.setItem=function(key,value){if(this!==localStorage||!sensitive.has(key))set.call(this,key,value);};
  Storage.prototype.removeItem=function(key){if(this!==localStorage||!sensitive.has(key))remove.call(this,key);};
  let proto=Document.prototype,descriptor;
  while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'cookie');proto=Object.getPrototypeOf(proto);}
  if(descriptor?.get&&descriptor?.set)Object.defineProperty(document,'cookie',{configurable:true,get(){return host.document.cookie;},set(value){const key=String(value).split('=',1)[0].trim();if(!sensitive.has(key))descriptor.set.call(document,value);}});
 }
 // Head scripts run before body exists. Install session and network bridges now;
 // defer only the DOM policy and preview hooks until their body target is ready.
 const native=window.fetch.bind(window);
 window.XMLHttpRequest=host.XMLHttpRequest;
 window.WebSocket=host.WebSocket;
 window.EventSource=host.EventSource;
 navigator.sendBeacon=()=>true;
 window.fetch=(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url,document.baseURI),method=String(options.method||input?.method||'GET').toUpperCase();
  if(url.pathname.startsWith('/studio-api/')&&runtime.mode==='service')return host.fetch(input,options);
  if(url.pathname.startsWith('/studio-api/')){
   if(!['GET','HEAD'].includes(method)){runtime.notice('Studio Frames 创作服务待接入后端。');return Promise.resolve(new Response(JSON.stringify({error:'创作服务待接入后端。'}),{status:501,headers:{'content-type':'application/json'}}));}
   const path=url.pathname;let data={files:[],dir:null};
   if(path.endsWith('/registry/blocks'))data=[];
   else if(/\/fonts(\/google)?$/.test(path))data={fonts:[]};
   else if(path.includes('/files/'))data={content:''};
   else if(path.endsWith('/renders'))data={renders:[]};
   return Promise.resolve(new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}}));
  }
  if(url.origin!==location.origin||/runninghub\.ai$/.test(url.hostname)||/^\/(api|canvas|uc|task|pay|agent-platform|studio-api)\//.test(url.pathname))return host.fetch(input,options);
  return native(input,options);
 };
 {
  let disposed=false,installed=false,policy,brand,observer,disposeNavigation;
  const hydrate=element=>{if(disposed)return;if(element.tagName==='IFRAME'){const canonical=embeddedEditorURL(element.src,location.origin);if(canonical)element.src=canonical;}void runtime.studio.hydratePreview?.(element).catch(error=>{if(!disposed)runtime.notice(error.message);});};
  const installDom=()=>{
   if(disposed||installed)return;
   try{
    if(!document.body)throw new Error('嵌入编辑器页面主体未能初始化。');
    installed=true;
    brand=installStudioBrand({frames:applicationBrand==='frames',displayName:()=>runtime.auth?.user?.displayName});
    policy=installFeatureUi(runtime.api?.features||host.__RHTV_CONFIG__?.features||resolveFeatures(),text=>runtime.notice(text));
    if(runtime.mode!=='service')return;
    disposeNavigation=installStudioNavigation(runtime,runtime.notice,window);
    observer=new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')hydrate(record.target);for(const node of record.addedNodes)if(node.nodeType===1){hydrate(node);node.querySelectorAll?.('iframe,img,video,audio,source,a[href],hyperframes-player[src]').forEach(hydrate);}}});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href']});
    document.body.querySelectorAll('iframe,img,video,audio,source,a[href],hyperframes-player[src]').forEach(hydrate);
   }catch(error){runtime.notice(error instanceof Error?error.message:'嵌入编辑器界面初始化失败。');throw error;}
  };
  window.addEventListener('pagehide',()=>{disposed=true;document.removeEventListener('DOMContentLoaded',installDom);observer?.disconnect();policy?.disconnect();brand?.disconnect();disposeNavigation?.();},{once:true});
  if(document.body)installDom();else if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installDom,{once:true});else installDom();
 }
})();
