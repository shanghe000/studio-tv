import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {DraftJournal} from '../../apps/web/src/service/draft-journal';
import {MemoryDraftStorage} from './draft-journal-fixture';
import {verifiedAccess} from './collaboration-fixtures';
import capabilities from './fixtures/router-h3-capabilities.json';

const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
function captured(source:string,start:string,end='function '){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Frozen remote-history seam changed: '+start);return source.slice(a,b);}
const slice=(start:string,end?:string)=>captured(index,start,end);
const types={RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls'};
// Execute the immutable q_/MCe and W8 bodies. Only unrelated text/media UI
// services are stubbed; history projection and its storage discriminator are real.
const declarations=[slice('function MCe(','function dNn('),slice('function lNn(','function cNn('),slice('function cNn(','function MCe('),slice('function sNn(')].join('\n');
const project=runInNewContext(declarations+slice('function ADe(')+slice('function q_(','function tQr(')+';q_',{
 W5:(value:any)=>JSON.parse(JSON.stringify(value)),dw:()=>[],nNn:()=> 'prompt',sd:()=>[],As:()=>false,cJ:()=>[],j8:()=>({images:[],videos:[],audios:[]}),uJ:()=>[],Q0:()=>[],aNn:vi.fn(),oft:()=>false,rft:()=>false,Ar:()=>false,no:()=>false,
 sft:(value:any)=>value,Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,dNn:(value:any)=>value,hM:()=>null,J1e:()=>false,fNn:new Set(),_t:types,
});
const remoteStorage=runInNewContext(slice('function oee(')+';oee');
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
type Kind='video'|'image';
type Cache='populated'|'empty'|'absent';
function fixture(options:{kind?:Kind;cache?:Cache;catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>}={}){
 const kind=options.kind??'video',cap:any=kind==='video'?{...structuredClone(capabilities.find(cap=>cap.capabilityRef==='h3-video-reference-v1')!),testMode:false}:{capabilityRef:'codex-image-generate-v1',version:'3',parameterSchemaVersion:'3',available:true,testMode:false,kind:'TEXT_TO_IMAGE',title:'Codex Image',model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1],default:1},transparentBackground:{type:'boolean',default:false}}}},model=capabilityModel(cap);
 const output={assetId:'old-'+kind,url:'rhtv-asset:old-'+kind,historyOutputId:'remote-output',outputType:kind==='video'?'video/mp4':'image/png',width:768,height:768,...(kind==='video'?{durationMs:5000}:{})};
 const data:any={title:'Synthetic remote history',modelCode:cap.capabilityRef,subType:kind==='video'?'multimodal-video':'text-image',params:kind==='video'?{prompt:'A fox turns toward the camera.',outputPreset:cap.parameterSchema.properties.outputPreset.default,imageUrls:['rhtv-asset:image'],videoUrls:[],audioUrls:[]}:{prompt:'A fox in natural light.',transparentBackground:false},generateNum:1,presetSelections:[],output:[output],historyStorage:{source:'remote',schemaVersion:1,historyId:'remote-batch',revision:'4',resultCount:1},selectedHistoryBatchId:'remote-batch',selectedHistoryOutputId:'remote-output',selectedOutputHistoryId:'local-cache',selectedOutputHistoryIndex:0};
 if(kind==='video')data.videoUrl='rhtv-asset:old-video';else{data.imageUrl='rhtv-asset:old-image';data.sourceObjects=['rhtv-asset:old-image'];}
 if(options.cache!=='absent')data.nodeOutputHistory=options.cache==='empty'?[]:[{version:2,id:'local-cache',params:{prompt:'Earlier recorded input'},outputs:[structuredClone(output)],nodeConfig:{modelCode:cap.capabilityRef,subType:data.subType,generateNum:1}}];
 const graph:any={nodes:[{id:'target',type:'rh-'+kind,position:{x:0,y:0},data}],edges:[]},manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const command=project('target',graph.nodes,graph.edges,{modelConfig:model.config});command.nodes[0].data.modelType=model.modelType;
 const embeddedHistory=vi.fn(()=>{throw Error('W8 must not append embedded history for a remote pointer');}),patch=vi.fn();
 const W8=runInNewContext(captured(shell,'function W8(','function q8(')+';W8',{
  kk:(type:string)=>type==='rh-video'||type==='rh-image',ia:()=>false,Fe:()=>({getFullNodesByIds:()=>new Map([['target',graph.nodes[0]]])}),_f:remoteStorage,ag:(value:any)=>value??[],BT:embeddedHistory,
 });
 W8({nodeId:'target',nodeType:'rh-'+kind,fallbackData:data,runData:command.nodes[0].data,onNodeDataPatch:patch});
 const requests:any[]=[],api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[cap],nextCursor:null});
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1)!;return json({id,state:'READY',kind:id==='old-video'?'VIDEO':'IMAGE',width:768,height:768,byteSize:1024,...(id==='old-video'?{durationSeconds:5}:{})});}
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(body)??json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-11-03T09:00:00Z'});
  if(path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/task')return json({id:'task',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:1,testMode:false,plans:[{nodeId:'target',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  if(path==='/api/v2/generation-diagnostics')return json({logId:'diagnostic'});
  throw Error('Unexpected remote-history fixture route: '+path);
 });api.setAccessToken('fixture-owner');const disk=new MemoryDraftStorage(),journal=new DraftJournal(()=>disk),storage=new ServiceStorage(api,vi.fn(),()=> 'owner',journal),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 storage.rememberAccess(verifiedAccess());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-03T08:59:00Z'},'"1"');storage.attachNativeView('p',graph);execution.attach('p',manager);
 return{cap,graph,command,requests,storage,execution,journal,embeddedHistory,patch,submit:()=>execution.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command}),submitted:()=>requests.filter(row=>row.path==='/api/v2/canvas-runs')};
}
const historyFields=['nodeOutputHistory','historyStorage','output','videoUrl','imageUrl','sourceObjects','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex'];
it.each((['video','image'] as Kind[]).flatMap(kind=>(['populated','empty','absent'] as Cache[]).map(cache=>({kind,cache}))))('submits the actual q_ → W8 $kind repeat with a $cache remote-history cache and preserves all history',async({kind,cache})=>{
 const f=fixture({kind,cache}),before=structuredClone(f.graph),projected=f.command.nodes[0].data;
 if(kind==='image')expect(projected.params).toEqual(before.nodes[0].data.params);
 expect(f.embeddedHistory).not.toHaveBeenCalled();expect(f.patch).not.toHaveBeenCalled();for(const key of ['nodeOutputHistory','selectedOutputHistoryId','selectedOutputHistoryIndex'])expect(projected).not.toHaveProperty(key);
 expect(projected.selectedHistoryBatchId).toBe('remote-batch');expect(projected.selectedHistoryOutputId).toBe('remote-output');
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const sent=f.submitted()[0].body,target=sent.graph.nodes.find((node:any)=>node.id==='target');for(const key of historyFields){expect(target.data[key],key).toEqual(before.nodes[0].data[key]);if(!Object.hasOwn(before.nodes[0].data,key))expect(target.data).not.toHaveProperty(key);}expect(sent.expectedRevision).toBe(2);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});
it.each(['history-id','revision','result-count','output','remote-batch','remote-output','explicit-local-selector','empty-local-selector','explicit-local-index','empty-cache','null-cache','different-cache'])('rejects an explicit %s change instead of the exact W8 omission',async change=>{
 const f=fixture(),data=f.command.nodes[0].data;
 if(change==='history-id')data.historyStorage.historyId='forged-batch';if(change==='revision')data.historyStorage.revision='5';if(change==='result-count')data.historyStorage.resultCount=2;
 if(change==='output')data.output=[{url:'rhtv-asset:image',historyOutputId:'remote-output'}];if(change==='remote-batch')data.selectedHistoryBatchId='other-batch';if(change==='remote-output')data.selectedHistoryOutputId='other-output';
 if(change==='explicit-local-selector')data.selectedOutputHistoryId='forged-local';if(change==='empty-local-selector')data.selectedOutputHistoryId='';if(change==='explicit-local-index')data.selectedOutputHistoryIndex=1;if(change==='empty-cache')data.nodeOutputHistory=[];if(change==='null-cache')data.nodeOutputHistory=null;if(change==='different-cache')data.nodeOutputHistory=[{id:'forged-local-cache'}];
 try{await expect(f.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);}finally{f.execution.clear();}
});
function lateEdit(data:any,change:string){if(change==='remote-selection')data.selectedHistoryOutputId='later-remote-output';if(change==='local-selection')data.selectedOutputHistoryId='later-local-selection';if(change==='local-index')data.selectedOutputHistoryIndex=1;if(change==='cache')data.nodeOutputHistory.push({id:'later-local-cache',outputs:[{url:'rhtv-asset:old-video'}]});}
it.each((['catalog','save'] as const).flatMap(phase=>['remote-selection','local-selection','local-index','cache'].map(change=>({phase,change}))))('rejects a real later $change during $phase while keeping the accepted local draft and creating no task',async({phase,change})=>{
 const gate=deferred<Response>();let saved:any;const f=fixture(phase==='catalog'?{catalog:()=>gate.promise}:{save:body=>{saved=body;return gate.promise;}});
 try{
  const pending=f.submit(),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(f.requests.some(row=>phase==='catalog'?row.path.includes('model-capabilities'):row.path==='/api/v1/projects/p/snapshot')).toBe(true));
  lateEdit(f.graph.nodes[0].data,change);f.storage.captureDraft('p',f.graph);const retained=structuredClone(f.graph.nodes[0].data);
  gate.resolve(phase==='catalog'?json({items:[f.cap],nextCursor:null}):json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-11-03T09:00:00Z'}));await rejected;
  expect(f.submitted()).toHaveLength(0);expect(f.graph.nodes[0].data).toEqual(retained);const draft=JSON.parse(f.storage.exportDraft('p')).graph.nodes.find((node:any)=>node.id==='target');for(const key of historyFields)expect(draft.data[key],key).toEqual(retained[key]);expect(f.journal.list('owner','p').length).toBeGreaterThan(0);
 }finally{f.execution.clear();}
});
