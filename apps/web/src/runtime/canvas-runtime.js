import {assetReply} from './asset-runtime.js';
// Device-local canvas replay. The original editor owns rendering and interactions.
const PROJECTS='rhtv-preview-projects', DB='rhtv-preview-canvas-v1';
const graphs=new Map(), files=new Map(), liveUrls=new Map(), reverseUrls=new Map();
let mediaControlled=false;
const mediaUrl=(id,fileName)=>location.origin+'/__rhtv_media/'+encodeURIComponent(id)+'/'+encodeURIComponent(fileName||'attachment');
let db=null, manager=null, managerId=null, unsubscribe=null, updateListener=null, saveTimer;
const rows=()=>{try{return JSON.parse(localStorage.getItem(PROJECTS)||'[]');}catch{return[];}};
const putRows=value=>localStorage.setItem(PROJECTS,JSON.stringify(value));
const clone=value=>JSON.parse(JSON.stringify(value));
function transform(value,fn){if(typeof value==='string')return fn(value);if(Array.isArray(value))return value.map(v=>transform(v,fn));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,transform(v,fn)]));return value;}
const encode=value=>transform(value,s=>reverseUrls.has(s)?'rhtv-asset:'+reverseUrls.get(s):s);
const decode=value=>transform(value,s=>s.startsWith('rhtv-asset:')?liveUrls.get(s.slice(11))||'':s);
async function database(){try{return await new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{r.result.createObjectStore('graphs',{keyPath:'id'});r.result.createObjectStore('files',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}catch{return null;}}
function readAll(store){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function write(store,value){if(!db)return Promise.resolve();return new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});}
function erase(store,id){if(!db)return;db.transaction(store,'readwrite').objectStore(store).delete(id);}
function row(p){return{...p,canvasId:p.id,type:'CANVAS',cover:p.coverUrl||'',nodesCount:graphs.get(p.id)?.nodes?.length||0,createTime:p.createTime||p.createdAt,updateTime:p.updateTime||p.updatedAt};}
function page(records,b={}){const size=Math.min(100,Math.max(1,Number(b.size)||20)),current=Math.max(1,Number(b.page||b.current)||1);return{records:records.slice((current-1)*size,current*size),current,size,total:records.length,pages:Math.ceil(records.length/size),hasNext:current*size<records.length};}
function persistGraph(id,data){const safe=encode({...data,meta:{...data.meta,id}});graphs.set(id,safe);const list=rows(),p=list.find(p=>p.id===id);if(p){p.name=safe.meta?.name||p.name;p.updateTime=Date.now();p.updatedAt=new Date().toISOString();p.nodesCount=safe.nodes.length;putRows(list);}write('graphs',{id,graph:safe}).catch(()=>window.__RHTV_PREVIEW__?.notice('浏览器存储空间不足，当前画布未能保存。'));}
function create(name='Untitled',graph=null){const id=String(BigInt(Date.now())*1000000n+BigInt(crypto.getRandomValues(new Uint32Array(1))[0]%1000000));const now=new Date().toISOString();putRows([{id,name:name||'Untitled',createdAt:now,updatedAt:now,createTime:Date.now(),updateTime:Date.now(),pinned:false},...rows()]);persistGraph(id,graph||{nodes:[],edges:[],meta:{id,name:name||'Untitled'}});return id;}
function ensure(id){id=String(id);let p=rows().find(x=>x.id===id);if(!p){const now=new Date().toISOString();p={id,name:'Untitled',createdAt:now,updatedAt:now,createTime:Date.now(),updateTime:Date.now(),pinned:false};putRows([p,...rows()]);}return p;}
export const canvasRuntime={
 async ready(){db=await database();if(db&&'serviceWorker' in navigator){try{await navigator.serviceWorker.register('/media-worker.js',{scope:'/'});await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>{navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});setTimeout(resolve,4000);});mediaControlled=!!navigator.serviceWorker.controller;}catch{}}if(db){const [storedGraphs,storedFiles]=await Promise.all([readAll('graphs'),readAll('files')]);for(const x of storedGraphs)graphs.set(x.id,x.graph);for(const x of storedFiles){files.set(x.id,x);const url=mediaControlled?mediaUrl(x.id,x.fileName):URL.createObjectURL(x.file);liveUrls.set(x.id,url);reverseUrls.set(url,x.id);if(x.lastUrl)reverseUrls.set(x.lastUrl,x.id);}}},
 canvasFixture(id){if(String(id).startsWith('e2e-'))return null;const p=ensure(id),g=graphs.get(String(id));return g?decode(clone(g)):{nodes:[],edges:[],meta:{id:String(id),name:p.name}};},
 attachCanvas(id,client){if(manager&&updateListener)manager.ydoc?.off('update',updateListener);unsubscribe?.();clearTimeout(saveTimer);manager=client;managerId=String(id);const save=()=>{const g=client.getRemoteData();if(g&&manager===client)persistGraph(String(id),g);};const queue=()=>{clearTimeout(saveTimer);saveTimer=setTimeout(save,180);};unsubscribe=client.subscribe(queue);updateListener=queue;client.ydoc?.on('update',queue);canvasRuntime.flush=save;},
 async uploadFile(file,options){if(!mediaControlled||!db)throw new Error('当前浏览器无法持久保存素材，请启用浏览器存储后重试。');const id=crypto.randomUUID(),url=mediaControlled?mediaUrl(id,file.name):URL.createObjectURL(file);const record={id,file,lastUrl:url,fileName:file.name||'attachment',mimeType:file.type,createdAt:Date.now()};files.set(id,record);liveUrls.set(id,url);reverseUrls.set(url,id);await write('files',record);options?.onProgress?.(100);return url;},
 flush(){},
 encodeAsset:encode,
 decodeAsset:decode,
 inspect(){return{id:managerId,graph:manager?.getRemoteData()||null,projects:rows(),assets:files.size};},
 handle(path,b,success,notice){
  if(path==='/canvas/list'){let list=rows();const q=String(b.keyword||'').toLowerCase();if(q)list=list.filter(p=>p.name.toLowerCase().includes(q));list.sort((a,z)=>Number(z.pinned)-Number(a.pinned)+(a.pinned===z.pinned?Number(z.updateTime)-Number(a.updateTime):0));return success(page(list.map(row),b));}
  if(path==='/canvas/create')return success({id:create(b.name)});
  if(path==='/canvas/checkUserIdByCanvasId'){ensure(b.canvasId);return success({caseFlag:true,permission:new URLSearchParams(location.search).has('shared')?'read_only':'read_write',canvasLocked:false,yjsGeneration:null,yjsGenerationRequired:false});}
  if(path==='/canvas/detail/byCanvasId'||path==='/canvas/getCanvasDetail'){const p=ensure(b.id||b.canvasId),g=canvasRuntime.canvasFixture(p.id);return success({...row(p),canvas_content:{nodes:g.nodes,edges:g.edges}});}
  if(path==='/canvas/rename'){const list=rows(),p=list.find(p=>p.id===String(b.id));if(p){p.name=String(b.name);p.updateTime=Date.now();putRows(list);const g=graphs.get(p.id)||{nodes:[],edges:[],meta:{id:p.id}};g.meta.name=p.name;persistGraph(p.id,g);if(managerId===p.id)manager?.ymap?.set('name',p.name);}return success(null);}
  if(path==='/canvas/delete'){const id=String(b.id);putRows(rows().filter(p=>p.id!==id));graphs.delete(id);erase('graphs',id);return success(null);}
  if(path==='/canvas/pin'||path==='/canvas/unpin'){const list=rows(),p=list.find(p=>p.id===String(b.id));if(p){p.pinned=path==='/canvas/pin';putRows(list);}return success(null);}
  if(path==='/canvas/share/link'){notice('此预览分享链接在当前浏览器中可查看；跨设备分享需接入后端。');return success({shareUrl:location.origin+'/project/canvas/'+encodeURIComponent(b.canvasId)+'?shared=1'});}
  if(path==='/canvas/share/clone'){const g=canvasRuntime.canvasFixture(String(b.shareId));return success({canvasId:create(g?.meta?.name,g)});}
  if(path==='/canvas/createFromCase'||path==='/canvas/saveLockedCopy'){let g=typeof b.canvas==='string'?JSON.parse(b.canvas):b.canvas;return success({id:create(b.name,g&&Array.isArray(g.nodes)?{...g,meta:{name:b.name||'Untitled'}}:null)});}
  if(path==='/canvas/task/run'||path==='/canvas/agent/cac'||path==='/canvas/agent/skill/file/content/optimize'||/\/(run|generate|submit|agent\/chat)$/.test(path)){notice('复刻预览：AI 生成尚未连接后端。');return{code:1,msg:'AI 生成尚未连接后端。'};}
  if(path==='/canvas/task/batchStatus')return success({tasks:[]});
  if(path==='/canvas/task/cancel')return success(null);
  if(path==='/canvas/price/estimate')return {code:1,msg:'价格服务待接入。',data:null};
  if(path==='/canvas/price/llm-sku-price')return success([]);
  if(path==='/canvas/hf/projects')return success({projects:[]});
  if(path==='/canvas/hf/projects/session/list'||path==='/canvas/openclaw/sessions/detail')return success({records:[],total:0,current:1,size:50,pages:0,hasNext:false});
  if(path.startsWith('/canvas/openclaw/')){notice('HyperFrames AI 助手待接入后端。');return {code:1,msg:'HyperFrames AI 助手待接入后端。',data:null};}
  if(path==='/canvas/node/tag/list')return success([]);
  if(path==='/canvas/node-history/page')return success({batches:[],pageNum:1,hasNext:false,resultCount:0,revision:'0'});
  if(path==='/canvas/user/detail'){let pref=null;try{pref=JSON.parse(localStorage.getItem('rhtv-canvas-shortcuts')||'null');}catch{}return success(pref?{shortcutKeyConfig:pref}:null);}
  if(path==='/canvas/user/update/shortcutKeyConfig'){localStorage.setItem('rhtv-canvas-shortcuts',JSON.stringify(b));return success(null);}
  if(path==='/canvas/folder/getConfig')return success({enabled:false});
  const asset=assetReply(path,b,{success,encode,decode,types:window.__RHTV_PREVIEW__?.assetTypes||[{id:'IMAGE',code:'IMAGE',name:'图片',nameEn:'Image'},{id:'VIDEO',code:'VIDEO',name:'视频',nameEn:'Video'},{id:'AUDIO',code:'AUDIO',name:'音频',nameEn:'Audio'},{id:'TEXT',code:'TEXT',name:'文本',nameEn:'Text'}]});if(asset!==undefined)return asset;
  return undefined;
 }
};
await canvasRuntime.ready();
window.addEventListener('pagehide',()=>canvasRuntime.flush());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')canvasRuntime.flush();});
