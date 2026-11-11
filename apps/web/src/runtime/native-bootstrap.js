import {config} from '../config';
import {blockedApi,INTERNAL_FEATURE_MESSAGE} from '../features/policy';
import {ApiError} from '../api/client';
import {installNativeProfile} from '../api/native-profile';
import {installStudioNavigation,embeddedEditorURL} from '../service/navigation';
import {NATIVE_ENTRY} from './service-shell-loading';
import {shouldAnnounceNativeFailure} from '../service/unsupported-operation';
// Preserve the native UI while selecting exactly one preview or STUDIO service data source.
if(location.pathname==='/')history.replaceState({},'', '/projects/');
if(!document.cookie.includes('userLanguage='))document.cookie='userLanguage=false; Path=/; SameSite=Lax';if(!document.cookie.includes('rh_locale='))document.cookie='rh_locale=zh-CN; Path=/; SameSite=Lax';
const nativeFetch=window.fetch.bind(window);
const {canvasRuntime}=config.mode==='preview'?await import('./canvas-runtime.js'):{canvasRuntime:(await import('../service/runtime')).serviceRuntime};
const nativeProfile=config.mode==='service'?installNativeProfile(canvasRuntime.auth):null;
const [fixtures,mediaMap]=config.mode==='preview'?await Promise.all([nativeFetch('/fixtures.json').then(r=>r.json()),nativeFetch('/media-map.json').then(r=>r.json())]):[[],{}];
const decodeBody=x=>{try{return typeof x==='string'?JSON.parse(x):x||{};}catch{return{};}};
const success=data=>({code:0,msg:'success',errorMessages:null,data});
const pageData=records=>({records,current:1,size:60,total:records.length,pages:1,hasNext:false});
const storageKey='rhtv-preview-projects';
const projects=()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'[]');}catch{return[];}};
const demoUser={id:'rhtv-preview',userId:'rhtv-preview',nickName:'Personal',nickname:'Personal',userName:'Personal',name:'Personal',displayName:'Personal',userRegion:'en_US',walletInfo:{currency:'USD',currencySymbol:'$',balance:0},memberInfo:{},balance:0};
const fixture=(p,b)=>fixtures.find(x=>new URL(x.url).pathname===p&&['type','productType','webappId','dataId','workflowId','compositionId','templateId','rang'].every(k=>b[k]===undefined||String(decodeBody(x.requestBody)[k])===String(b[k])));
const paginate=(records,b)=>{const size=Math.min(100,Math.max(1,Number(b.size)||30)),current=Math.max(1,Number(b.current||b.page)||1);return{records:records.slice((current-1)*size,current*size),current,size,total:records.length,pages:Math.ceil(records.length/size),hasNext:current*size<records.length,hasPrevious:current>1,nextCursor:null};};
const priceKey=b=>JSON.stringify({skuId:String(b.skuId||''),priceFactors:(b.priceFactors||[]).map(x=>({key:x.fieldKey,value:x.fieldValue})).sort((a,z)=>a.key.localeCompare(z.key))});
const webapps=[...new Map(fixtures.filter(x=>new URL(x.url).pathname==='/api/webapp/list').sort((a,z)=>Number(!!decodeBody(a.requestBody).tags)-Number(!!decodeBody(z.requestBody).tags)).flatMap(x=>x.body.data?.records||[]).map(x=>[String(x.id),x])).values()];
const arrayData=(p)=>fixture(p,{})?.body?.data?.records||[];
const notice=text=>{let n=document.getElementById('replica-notice');if(!n){n=document.createElement('div');n.id='replica-notice';n.setAttribute('role','status');n.style.cssText='position:fixed;top:82px;left:50%;transform:translateX(-50%);background:#232323;color:#eee;border:1px solid #454545;border-radius:9px;padding:13px 22px;font:14px system-ui;z-index:100000;box-shadow:0 8px 32px #0008';document.body.append(n);}n.textContent=text;clearTimeout(notice.timer);notice.timer=setTimeout(()=>n.remove(),4500);};
function previewReply(url,payload){const p=new URL(url,location.href).pathname,b=decodeBody(payload);
  window.__replicaRequests??=[];window.__replicaRequests.push({path:p,method:'local',time:Date.now()});
  if(/^\/pay\//.test(p)||/login|oauth|send.*code|verify.*code|recharge|payment|checkout|purchase/i.test(p))return {code:1,msg:'复刻预览：登录与支付尚未接入原站服务。'};
  if(p==='/uc/getUserInfo')return success(demoUser);
  if(p.includes('unreadCount'))return success({officialMessageCount:0});
  if(p==='/canvas/config/queryByTypes'){const records=fixtures.filter(x=>new URL(x.url).pathname===p).flatMap(x=>Array.isArray(x.body.data)?x.body.data:[]);return success(records.filter(x=>!b.types||b.types.includes(x.type)));}
  if(p==='/api/portal/v2/getDictConfig'){const records=fixtures.filter(x=>new URL(x.url).pathname===p).flatMap(x=>Array.isArray(x.body.data)?x.body.data:[]);return success(records.filter(x=>!b.dictTypes||b.dictTypes.includes(x.detailName)));}
  if(p==='/canvas/character-library/list'){let records=arrayData(p);const q=String(b.keyword||'').toLowerCase();const liked=new Set(config.mode==='preview'?JSON.parse(localStorage.getItem('rhtv-character-favorites')||'[]'):[]);records=records.map(r=>({...r,favorite:liked.has(String(r.id))}));if(q)records=records.filter(r=>(r.name+' '+r.description).toLowerCase().includes(q));if(b.favoriteOnly)records=records.filter(r=>r.favorite);for(const filter of b.filters||[])records=records.filter(r=>!filter.optionCodes?.length||filter.optionCodes.includes(r.attributes?.[filter.categoryCode]?.optionCode));const size=Number(b.size)||20,current=Number(b.page)||1;return success({records:records.slice((current-1)*size,current*size),current,size,total:records.length,pages:Math.ceil(records.length/size),hasNext:current*size<records.length});}
  if(p==='/canvas/character-library/favorite'){const liked=new Set(config.mode==='preview'?JSON.parse(localStorage.getItem('rhtv-character-favorites')||'[]'):[]);b.action===1?liked.add(String(b.id)):liked.delete(String(b.id));localStorage.setItem('rhtv-character-favorites',JSON.stringify([...liked]));return success(null);}
  if(p==='/canvas/price/calculate'||p==='/api/area/price/calculate'){const f=fixtures.find(x=>new URL(x.url).pathname===p&&priceKey(decodeBody(x.requestBody))===priceKey(b));return f?structuredClone(f.body):{code:1,msg:'此参数组合的价格服务待接入。',data:null};}
  if(p==='/api/webapp/list'||p==='/api/likeOrCollect/webapp/list'||p==='/api/webapp/user/list'){let records=webapps.slice();const liked=new Set(config.mode==='preview'?JSON.parse(localStorage.getItem('rhtv-webapp-favorites')||'[]'):[]);if(p.includes('/likeOrCollect/'))records=records.filter(x=>liked.has(String(x.id)));if(p==='/api/webapp/user/list')records=[];const q=String(b.search||'').toLowerCase();if(q)records=records.filter(x=>[x.name,x.owner?.name,x.id].join(' ').toLowerCase().includes(q));if(b.tags?.length)records=records.filter(x=>x.tags?.some(t=>b.tags.map(String).includes(String(t.id))));if(b.days)records=records.filter(x=>Number(x.publishTime)>Date.now()-Number(b.days)*86400000);if(b.sort==='NEWEST')records.sort((a,z)=>Number(z.publishTime)-Number(a.publishTime));if(b.sort==='HOTTEST')records.sort((a,z)=>Number(z.statisticsInfo?.useCount)-Number(a.statisticsInfo?.useCount));if(b.sort==='REPUTATION')records.sort((a,z)=>Number(z.statisticsInfo?.collectCount)-Number(a.statisticsInfo?.collectCount));return success(paginate(records.map(x=>({...x,collect:liked.has(String(x.id))?1:0})),b));}
  if(p==='/api/likeOrCollect/webapp'){const liked=new Set(config.mode==='preview'?JSON.parse(localStorage.getItem('rhtv-webapp-favorites')||'[]'):[]);b.action===0?liked.delete(String(b.webappId||b.id)):liked.add(String(b.webappId||b.id));localStorage.setItem('rhtv-webapp-favorites',JSON.stringify([...liked]));return success(null);}
  if(p==='/api/workflow/webapp-price-estimate')return {code:1,msg:'应用计费服务待接入。',data:null};
  if(p==='/canvas/config/query'){const f=fixture(p,b);if(f)return f.body;return success({content:null});}
  if(p==='/canvas/home/highlight/query')return success([]);
  if(config.mode==='preview'){const local=canvasRuntime.handle(p,b,success,notice);if(local!==undefined)return local;}
  if(/reportEvent|\/logs\/|playCount|\/play$/.test(p))return success(null);
  if(p==='/canvas/community/composition/detail'){const r=arrayData('/canvas/community/composition/list').find(x=>String(x.id)===String(b.compositionId));const d=fixture(p,b)?.body?.data;if(r)return success({...r,compositionPlay:true,allowClone:false});}
  if(p==='/canvas/community/composition/recommended/list')return success(arrayData('/canvas/community/composition/list').filter(x=>x.id!==b.compositionId).slice(0,20));
  if(p==='/task/quick-creation/inspiration/template/detail'){return success(arrayData('/task/quick-creation/inspiration/templates').find(x=>String(x.templateId||x.id)===String(b.templateId||b.id))||null);}
  if(/\/like$|\/favorite$|\/collect$/.test(p))return success({liked:b.action!==0});
  const f=fixture(p,b);if(f){const copy=structuredClone(f.body);if(copy.data?.records){const q=String(b.name||b.keyword||b.query||b.searchText||b.search||'').toLowerCase();if(q)copy.data.records=copy.data.records.filter(r=>JSON.stringify(r).toLowerCase().includes(q));if(b.page>1)copy.data.records=[];copy.data.total=copy.data.records.length;copy.data.pages=1;copy.data.hasNext=false;}return copy;}
  if(/\/tags$|\/types$|\/type\/list$|\/category\/list$|\/groups$/.test(p))return success([]);
  if(/\/list$|\/templates$/.test(p))return success(pageData([]));
  if(/\/skill\/.*detail|\/detail$|\/query$/.test(p))return success(null);
  return success({});
}
async function reply(url,payload,method='POST'){
 const policyPath=new URL(url,location.href).pathname;
 if(config.mode==='service'&&!config.features.billing&&['/api/cost/average','/api/user/task/work/valid','/task/third-party/config'].includes(policyPath))throw new ApiError(403,'FEATURE_DISABLED',INTERNAL_FEATURE_MESSAGE);
 if(blockedApi(policyPath,config.features))throw new ApiError(403,'FEATURE_DISABLED',INTERNAL_FEATURE_MESSAGE);
 if(config.mode==='preview')return previewReply(url,payload);
 const parsed=new URL(url,location.href),path=parsed.pathname,body={...Object.fromEntries(parsed.searchParams),...decodeBody(payload)};
 const service=await canvasRuntime.handle(path,body,method);
 if(service!==undefined)return service;
 throw new ApiError(501,'NOT_IMPLEMENTED','此功能的 STUDIO 服务接口尚未接入。');
}
class PreviewXHR extends EventTarget{
 constructor(){super();this.upload=new EventTarget();this.readyState=0;this.status=0;this.statusText='';this.responseType='';this.timeout=0;this.withCredentials=false;this._headers={};}
 open(method,url,async=true){this._method=method;this._url=url;this.readyState=1;this._emit('readystatechange');}
 setRequestHeader(k,v){this._headers[k]=v;}
 getResponseHeader(k){return k.toLowerCase()==='content-type'?'application/json':null;}
 getAllResponseHeaders(){return 'content-type: application/json\r\n';}
 overrideMimeType(){}
 _emit(name){const e=new Event(name);this.dispatchEvent(e);this['on'+name]?.(e);}
 send(body){this._aborted=false;this._timer=setTimeout(async()=>{if(this._aborted)return;let result,status=200,failure;try{result=await reply(this._url,body,this._method);}catch(error){status=error.status||503;result={code:status,msg:error.message||'服务请求失败。',data:null};failure=error;}if(this._aborted)return;this.status=status;if(failure&&shouldAnnounceNativeFailure(new URL(this._url,location.href).pathname,this._method,failure))window.__RHTV_PREVIEW__?.notice(result.msg);this.statusText=this.status===200?'OK':'Internal Server Error';this.responseURL=new URL(this._url,location.href).href;this.responseText=JSON.stringify(result);this.response=this.responseType==='json'?result:this.responseType==='blob'?new Blob([this.responseText],{type:'application/json'}):this.responseText;this.readyState=4;this._emit('readystatechange');this._emit('load');this._emit('loadend');},config.mode==='service'?0:60);}
 abort(){this._aborted=true;clearTimeout(this._timer);this._emit('abort');}
}
Object.assign(PreviewXHR,{UNSENT:0,OPENED:1,HEADERS_RECEIVED:2,LOADING:3,DONE:4});window.XMLHttpRequest=PreviewXHR;
window.fetch=async(input,options={})=>{try{
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url,u=new URL(url,location.href);
 const method=String(options.method||(typeof input==='object'?input.method:'GET')||'GET').toUpperCase();
 if(config.mode==='service'){
  const own=await canvasRuntime.fetch(input,options);if(own!==undefined)return own;
  if(u.origin===location.origin&&/^\/api\/v[12]\//.test(u.pathname))throw new ApiError(403,'RAW_API_NOT_ALLOWED','原生页面必须通过 STUDIO 产品适配器访问。');
 }
 if(u.origin===location.origin&&!/^\/(canvas|api|uc|task|pay|agent-platform|studio-api|media|openapi)\//.test(u.pathname))return nativeFetch(input,options);
 if(/runninghub\.ai$/.test(u.hostname)||/^\/(canvas|api|uc|task|pay|agent-platform|studio-api|media|openapi)\//.test(u.pathname))return new Response(JSON.stringify(await reply(url,options.body,method)),{status:200,headers:{'content-type':'application/json'}});
 const headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));headers.delete('Authorization');headers.delete('Rh-Accesstoken');
 return nativeFetch(input,{...options,headers,credentials:u.origin===location.origin?'same-origin':'omit'});
 }catch(error){return new Response(JSON.stringify({code:error.status||503,msg:error.message||'服务请求失败。',data:null}),{status:error.status||503,headers:{'content-type':'application/json'}});}};
navigator.sendBeacon=()=>true;
// Preview sockets are disconnected; service sockets use persisted assistant REST events.
class PreviewWebSocket extends EventTarget{
 constructor(url){super();this.url=String(url);this.readyState=0;this.bufferedAmount=0;this.protocol='';this.extensions='';this.binaryType='arraybuffer';window.__replicaBlockedSockets??=[];window.__replicaBlockedSockets.push(this.url);setTimeout(()=>{if(this.readyState===3)return;this.readyState=3;const e=new Event('error');this.dispatchEvent(e);this.onerror?.(e);const c=new CloseEvent('close',{code:1008,reason:'Backend is not connected in this local preview',wasClean:true});this.dispatchEvent(c);this.onclose?.(c);},60);}
 send(){throw new DOMException('The preview has no service WebSocket.','InvalidStateError');}
 close(){this.readyState=3;}
}
Object.assign(PreviewWebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});Object.assign(PreviewWebSocket.prototype,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});if(config.mode==='preview')window.WebSocket=PreviewWebSocket;else window.WebSocket=class {constructor(url){const socket=canvasRuntime.socket(String(url));if(socket){socket.url=String(url);return socket;}throw new ApiError(501,'SOCKET_NOT_SUPPORTED','此原生实时协议尚未接入 STUDIO。');}};if(config.mode==='service'){Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});Object.assign(window.WebSocket.prototype,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});}
class PreviewEventSource extends EventTarget{
 constructor(url){super();this.url=String(url);this.readyState=2;this.withCredentials=false;setTimeout(()=>{const e=new Event('error');this.dispatchEvent(e);this.onerror?.(e);},60);}
 close(){this.readyState=2;}
}
Object.assign(PreviewEventSource,{CONNECTING:0,OPEN:1,CLOSED:2});Object.assign(PreviewEventSource.prototype,{CONNECTING:0,OPEN:1,CLOSED:2});if(config.mode==='preview')window.EventSource=PreviewEventSource;else{const {ServiceEventSource}=await import('../service/rest-events');ServiceEventSource.connect=(url,options)=>canvasRuntime.fetch(url,options);window.EventSource=ServiceEventSource;}
if(config.mode==='preview'){const token=btoa(JSON.stringify({alg:'none'}))+'.'+btoa(JSON.stringify({sub:'rhtv-preview',exp:4102444800}))+'.preview';
localStorage.setItem('Rh-Accesstoken',token);
document.cookie='Rh-Accesstoken='+token+'; Path=/; SameSite=Lax';document.cookie='userId=rhtv-preview; Path=/; SameSite=Lax';}
const patchImage=el=>{if(el instanceof HTMLIFrameElement){const canonical=embeddedEditorURL(el.src,location.origin);if(canonical)el.src=canonical;}if(config.mode==='service'&&el instanceof Element){void canvasRuntime.studio.hydratePreview?.(el).catch(error=>notice(error.message));}if(el instanceof HTMLImageElement&&el.src&&!el.src.startsWith(location.origin)){try{const u=new URL(el.src);const value=mediaMap[el.src]||mediaMap[u.origin+u.pathname];if(value&&el.getAttribute('src')!==value)el.src=value;}catch{}}};
new MutationObserver(records=>{for(const r of records){if(r.type==='attributes')patchImage(r.target);else{if(r.removedNodes.length)nativeProfile?.prune();for(const n of r.addedNodes)if(n.nodeType===1){patchImage(n);n.querySelectorAll?.('img,iframe,video,audio,source,a[href],hyperframes-player[src]').forEach(patchImage);nativeProfile?.mount(n);}}}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href']});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(b&&/Google 登录/.test(b.textContent)){e.stopImmediatePropagation();e.preventDefault();notice(config.mode==='preview'?'复刻预览：Google 登录尚未接入。':'请使用公司飞书账号登录。');}},true);
window.__RHTV_PREVIEW__={notice,projects:config.mode==='preview'?projects:()=>[...canvasRuntime.storage.projects.values()],fixtures:fixtures.length,assetTypes:config.mode==='preview'?fixture('/canvas/asset/type/list',{})?.body?.data||[]:undefined,mode:config.mode,catalogSource:config.mode==='service'?'studio-backend':'sample-snapshot',...canvasRuntime};
if(config.mode==='service')installStudioNavigation(canvasRuntime,notice);
const nativeEntry=NATIVE_ENTRY;
// Load immutable public modules through a script boundary so Vite never rewrites their imports.
await new Promise((resolve,reject)=>{const script=document.createElement('script');script.type='module';script.src=nativeEntry;script.addEventListener('load',resolve,{once:true});script.addEventListener('error',()=>reject(new Error('原生界面资源未能加载。')),{once:true});document.body.append(script);});
window.dispatchEvent(new Event('rhtv:native-ready'));
nativeProfile?.mount();
if(config.mode==='service')await canvasRuntime.installNative();
const toolDefinitions=[{
 name:'read_homepage_state',title:'查看首页状态',description:'Read the visible creation prompt, gallery search and current route.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(input&&Object.keys(input).length)throw new Error('No input fields accepted.');return{route:location.pathname,prompt:document.querySelector('.composer-input')?.innerText||'',search:document.querySelector('input[type="search"],input[placeholder*="搜索作品"],input[placeholder*="Search"]')?.value||''};}
},{
 name:'stage_creation_prompt',title:'填写创作想法',description:'Fill and focus the same creation prompt as the visible homepage; does not submit or start generation.',inputSchema:{type:'object',properties:{prompt:{type:'string',minLength:1,maxLength:20000}},required:['prompt'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(input){if(!input||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000||Object.keys(input).some(x=>x!=='prompt'))throw new Error('A prompt of 1–20000 characters is required.');const box=document.querySelector('.composer-input');if(!box)throw new Error('Open the homepage before staging a prompt.');box.focus();box.textContent=input.prompt;box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:input.prompt}));await new Promise(resolve=>requestAnimationFrame(resolve));return{staged:true,prompt:box.innerText};}
}];
window.__replicaTools=Object.fromEntries(toolDefinitions.map(t=>[t.name,t]));
window.__replicaToolRegistrations=[];
if(document.modelContext?.registerTool){const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});for(const t of toolDefinitions){try{await document.modelContext.registerTool(t,{signal:lifecycle.signal});window.__replicaToolRegistrations.push({name:t.name,inputSchema:t.inputSchema,annotations:t.annotations});}catch{}}}
