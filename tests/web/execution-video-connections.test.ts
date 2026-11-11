import {readFileSync,writeFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import h3 from './fixtures/router-h3-capabilities.json';
import official from './fixtures/router-official-video-capabilities.json';
import motion from './fixtures/router-motion-source-capabilities.json';
import legacyMotion from './fixtures/router-motion-capabilities.json';
import {savedVideoModeProps} from '../../apps/web/src/service/native-video-mode';

const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
function captured(source:string,name:string,end='function '){const marker='function '+name+'(',start=source.indexOf(marker),to=source.indexOf(end,start+marker.length);if(start<0||to<0)throw Error('Frozen connection seam changed: '+name);return source.slice(start,to);}
const body=(name:string,end?:string)=>captured(compiled,name,end),url=(value:any)=>typeof value==='string'?value:value?.url,outputs=(value:any)=>Array.isArray(value)?value:value?[value]:[];
const declarations=[body('MCe','function dNn('),body('lNn','function cNn('),body('cNn','function MCe('),body('sNn'),...['ADe','dJ','Wc','cJ','j8','oNn','rNn','Np','Tme','kme','tDe','D7','dh','u_n','L7','Tv','eJ','q_'].map(name=>body(name))].join('\n');
// Real q_/MCe/eJ plus native history preparation, with only browser/catalog
// plumbing stubbed. The test transport never invokes an external provider.
const nativeProject=runInNewContext(declarations+';q_',{
 W5:(value:any)=>JSON.parse(JSON.stringify(value)),dw:()=>[],nNn:()=> 'prompt',sd:(id:string,nodes:any[],edges:any[])=>edges.filter(edge=>edge.target===id).map(edge=>nodes.find(node=>node.id===edge.source)),As:(type:string)=>type==='rh-text',Vut:(value:string)=>value.trim(),PA:(data:any)=>data.mentionAssets??[],uJ:()=>[],aNn:()=>{},oft:()=>false,rft:()=>false,eft:()=>false,
 Ar:(type:string)=>type==='rh-image',no:(type:string)=>type==='rh-video',Ga:(type:string)=>type==='rh-audio',vy:()=>true,Ns:outputs,ja:outputs,Mo:(value:any)=>url(outputs(value)[0]),U1e:(value:any)=>url(outputs(value)[0]),_c:(value:any)=>JSON.stringify(outputs(value).map(url).sort()),f_n:(value:any)=>value,Gut:(value:any)=>typeof value==='string'?value.trim():value,
 Q0:()=>[],sft:(value:any)=>value,Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,x4e:()=>false,dNn:(value:any)=>value,hM:()=>null,J1e:()=>false,fNn:runInNewContext(compiled.match(/fNn=(new Set\(\[[^\]]+\]\))/)![1]),
 _t:{PROMPT:'prompt',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls',FIRST_IMAGE_URL:'firstImageUrl',FIRST_FRAME_URL:'firstFrameUrl',LAST_IMAGE_URL:'lastImageUrl',LAST_FRAME_URL:'lastFrameUrl',IMAGE_PROMPT:'imagePrompt',SREF:'sref',IMAGE_REF:'imageRef',VIDEO_URL:'videoUrl',VIDEO_URLS:'videoUrls',AUDIO_URL:'audioUrl',AUDIO_URLS:'audioUrls',RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio'},
});
const remoteStorage=runInNewContext(body('oee')+';oee');
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
function fixture(options:{aliasType?:string;mode?:'image'|'text'|'motion';connection?:'current'|'none'|'text';native?:boolean;catalog?:()=>Promise<Response>;sourceData?:any;imageByteLimit?:number;asset?:(id:string)=>Response|undefined}={}){
 const mode=options.mode??'image',cap:any={...structuredClone((mode==='image'?h3:mode==='motion'?motion:official).find(value=>value.capabilityRef===(mode==='image'?'h3-first-frame-v1':mode==='motion'?'h3-motion-transfer-v1':'h3-official-text-to-video-v1'))!),available:true,testMode:false};
 if(options.imageByteLimit)cap.parameterSchema['x-input-media-constraints']={schemaVersion:'1',kinds:{IMAGE:{maxBytes:options.imageByteLimit}}};const model=capabilityModel(cap);
 const data:any={title:'Synthetic repeat video',modelCode:cap.capabilityRef,subType:mode==='image'?'start-video':'text-video',params:{prompt:'Move gently.',text:'Earlier text cache.',outputPreset:cap.parameterSchema.properties.outputPreset.default,imageUrls:['rhtv-asset:old-image'],videoUrls:[],audioUrls:[]},generateNum:1,presetSelections:[],output:[{url:'rhtv-asset:old-result',historyOutputId:'old-output'}],videoUrl:'rhtv-asset:old-result',historyStorage:{source:'remote',schemaVersion:1,historyId:'old-batch',revision:'4',resultCount:1},nodeOutputHistory:[{id:'old-cache',outputs:[{url:'rhtv-asset:old-result'}]}],selectedHistoryBatchId:'old-batch',selectedHistoryOutputId:'old-output',selectedOutputHistoryId:'old-cache',selectedOutputHistoryIndex:0};
 if(mode==='motion'){Object.assign(data,{subType:'multimodal-video',prompt:'',capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,params:{prompt:' ',imageUrls:'',videoUrls:'',outputPreset:'landscape-768p-source'}});for(const key of ['presetSelections','nodeOutputHistory','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex'])delete data[key];}
 const target={id:'target',type:'rh-video',position:{x:500,y:0},data},source=(id:string)=>({id,type:'rh-image',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:'+id]}}),text={id:'text',type:'rh-text',position:{x:0,y:300},data:{text:'Current text direction.',content:'Earlier text content.'}};
 const graph:any={nodes:[source('old-image'),source('current-image'),text,target],edges:options.connection==='none'?[]:[{id:'current-edge',source:options.connection==='text'?'text':'current-image',target:'target',sourceHandle:'output',targetHandle:'input'}]};
 if(mode==='motion'){graph.nodes.push({id:'current-video',type:'rh-video',position:{x:0,y:500},data:{isUpload:true,sourceObjects:['rhtv-asset:current-video']}});if(options.connection!=='none')graph.edges.push({id:'current-video-edge',source:'current-video',target:'target',sourceHandle:'output',targetHandle:'input'});}
 if(options.aliasType){
  graph.nodes=graph.nodes.filter((n:any)=>n.id==='target'||n.id==='current-image');
  const image=graph.nodes.find((n:any)=>n.id==='current-image');image.type=options.aliasType;image.data={imageUrl:'rhtv-asset:a-image'};
  Object.assign(data.params,{imageUrls:[],videoUrls:[],audioUrls:[]});
  data.output=[{url:'rhtv-asset:a-video',historyOutputId:'old-output'}];data.videoUrl='rhtv-asset:a-video';data.nodeOutputHistory=[{id:'old-cache',outputs:[{url:'rhtv-asset:a-video'}]}];
 }
 if(options.sourceData)graph.nodes.find((node:any)=>node.id==='current-image').data={...graph.nodes.find((node:any)=>node.id==='current-image').data,...options.sourceData};
 let revision=1;const requests:any[]=[],manager={localOnly:options.native!==false,getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()},api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[cap],nextCursor:null});
  if(path==='/api/v2/model-capability-version?ref=h3-motion-transfer-v1&version=1')return json({...structuredClone(legacyMotion[0]),available:true,testMode:false});
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1)!;return options.asset?.(id)??json({id,projectId:'p',state:'READY',kind:['old-result','current-video','a-video'].includes(id)?'VIDEO':'IMAGE',mimeType:['old-result','current-video','a-video'].includes(id)?'video/mp4':'image/png',width:1024,height:1024,byteSize:1024,...(['old-result','current-video','a-video'].includes(id)?{durationSeconds:3}:{})});}
  if(path==='/api/v1/projects/p/snapshot')return json({projectId:'p',revision:++revision,graph:body.graph,updatedAt:'2026-11-03T09:00:00Z'});
  if(path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/task')return json({id:'task',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:1,testMode:false,plans:[{nodeId:'target',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  if(path==='/api/v2/generation-diagnostics')return json({logId:'diagnostic'});throw Error('Unexpected connection fixture route: '+path);
 });api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 // The acknowledged graph already includes the disconnect/reconnect. Correct
 // behavior must not depend on an older unsaved topology for provenance.
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-03T08:59:00Z'},'"1"');storage.attachNativeView('p',graph);execution.attach('p',manager);
 const command=()=>{
  const projected=savedVideoModeProps({targetNode:target,visible:true,references:[],models:{'video-motion-transfer':[model]},videoModelGroups:[]}).targetNode;const result=nativeProject('target',graph.nodes.map((node:any)=>node.id===target.id?projected:node),graph.edges,{modelConfig:model.config});result.nodes[0].data.modelType=model.modelType;
  const W8=runInNewContext(captured(shell,'W8','function q8(')+';W8',{kk:()=>true,ia:()=>false,Fe:()=>({getFullNodesByIds:()=>new Map([['target',target]])}),_f:remoteStorage,ag:outputs,BT:()=>{throw Error('Unexpected embedded history');}});
  W8({nodeId:'target',nodeType:'rh-video',fallbackData:data,runData:result.nodes[0].data,onNodeDataPatch:()=>{throw Error('Remote history must not patch native');}});return result;
 };
 return{cap,graph,target,text,storage,execution,requests,command,submit:(value=command())=>execution.run({projectId:'p',targetType:'NODE',targetId:'target',graph:value}),submitted:()=>requests.filter(row=>row.path==='/api/v2/canvas-runs')};
}
const historyFields=['output','videoUrl','historyStorage','nodeOutputHistory','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex'];
it('blocks a disconnected image-to-video input before creating a task, even with old input caches and a previous result',async()=>{
 const f=fixture({connection:'none'}),before=structuredClone(f.graph);
 try{const readiness=await f.execution.inspectGeneration('p',['target'],f.graph);expect(readiness.status).toBe('blocked');expect(readiness.issues[0].message).toMatch(/图片|首帧/);await expect(f.submit()).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(f.submitted()).toHaveLength(0);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});
it('submits a repeated image-to-video generation with the newly connected image and retains the complete previous result',async()=>{
 const f=fixture(),before=structuredClone(f.graph);
 try{expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');const native=f.command();expect(native.nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:current-image']);await f.submit(native);expect(f.submitted()).toHaveLength(1);const data=f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='target').data;expect(data.params.imageUrls).toEqual(['rhtv-asset:current-image']);for(const key of historyFields)expect(data[key],key).toEqual(before.nodes.find((node:any)=>node.id==='target').data[key]);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});
const imageLimit=10*1024*1024;
const oversizedAsset=()=>json({id:'oversized',projectId:'p',state:'READY',kind:'IMAGE',mimeType:'image/png',width:1024,height:1024,byteSize:imageLimit+1});
function selectedSource(history:'remote'|'embedded',selectedOversized=false){
 const output=[{url:'rhtv-asset:oversized',historyOutputId:'oversized-output'},{url:'rhtv-asset:selected-image',historyOutputId:'valid-output'}],index=selectedOversized?0:1;
 return{isUpload:false,sourceObjects:['rhtv-asset:oversized'],imageUrl:'rhtv-asset:oversized',output,...(history==='remote'?{selectedHistoryOutputId:output[index].historyOutputId}:{selectedOutputHistoryId:'source-cache',selectedOutputHistoryIndex:index,nodeOutputHistory:[{id:'source-cache',outputs:structuredClone(output)}]})};
}
it.each(['remote','embedded'] as const)('validates only the selected %s source output against model size limits, while preserving an authorized oversized unselected result',async history=>{
 const f=fixture({sourceData:selectedSource(history),imageByteLimit:imageLimit,asset:id=>id==='oversized'?oversizedAsset():undefined}),before=structuredClone(f.graph);
 try{expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');const command=f.command();expect(command.nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:selected-image']);await f.submit(command);expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='target').data.params.imageUrls).toEqual(['rhtv-asset:selected-image']);expect(f.graph).toEqual(before);
  // Unselected history remains an identifier in the document; fetching bytes
  // or choosing it for a later run each requires its own live authorization.
  expect(f.requests.some(row=>row.path==='/api/v1/assets/oversized')).toBe(false);
 }finally{f.execution.clear();}
});
it.each(['remote','embedded'] as const)('blocks the actually selected oversized %s source output with a concrete limit before creating a task',async history=>{
 const f=fixture({sourceData:selectedSource(history,true),imageByteLimit:imageLimit,asset:id=>id==='oversized'?oversizedAsset():undefined}),before=structuredClone(f.graph);
 try{const readiness=await f.execution.inspectGeneration('p',['target'],f.graph);expect(readiness.status).toBe('blocked');expect(readiness.issues[0].message).toMatch(/10.*MiB/);await expect(f.submit()).rejects.toMatchObject({code:'MEDIA_INPUT_INVALID',message:expect.stringMatching(/10.*MiB/)});expect(f.submitted()).toHaveLength(0);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});
it('can submit with a deleted unselected result; selecting the deleted result is rejected before another task',async()=>{
 const f=fixture({sourceData:selectedSource('remote'),imageByteLimit:imageLimit,asset:id=>id==='oversized'?new Response(JSON.stringify({code:'ASSET_NOT_FOUND',message:'素材已删除。'}),{status:404}):undefined}),before=structuredClone(f.graph);
 try{expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');await f.submit();expect(f.submitted()).toHaveLength(1);expect(f.requests.some(row=>row.path==='/api/v1/assets/oversized')).toBe(false);expect(f.graph).toEqual(before);Object.assign(f.graph.nodes.find((n:any)=>n.id==='image')?.data??f.graph.nodes.find((n:any)=>n.data?.selectedHistoryOutputId)!.data,selectedSource('remote',true));await expect(f.submit()).rejects.toMatchObject({code:'ASSET_NOT_FOUND'});expect(f.submitted()).toHaveLength(1);}finally{f.execution.clear();}
});
it.each(['none','text'] as const)('repeats text-to-video using current %s connections without treating a previous result or image cache as input',async connection=>{
 const f=fixture({mode:'text',connection}),before=structuredClone(f.graph);
 try{expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');const command=f.command();expect(command.nodes[0].data.params).not.toHaveProperty('imageUrls');await f.submit(command);expect(f.submitted()).toHaveLength(1);const data=f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='target').data;expect(data.params.imageUrls).toEqual([]);expect(data.params.prompt).toBe('Move gently.');for(const key of historyFields)expect(data[key],key).toEqual(before.nodes.find((node:any)=>node.id==='target').data[key]);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});
it('continues generating on one mounted video after disconnecting and reconnecting a changed text source',async()=>{
 const f=fixture({mode:'text',connection:'text'}),before=structuredClone(f.target.data);
 try{
  await f.submit();f.graph.edges=[];f.storage.captureDraft('p',f.graph);await f.submit();
  f.text.data.text='The new connected direction.';f.graph.edges=[{id:'reconnected-text',source:'text',target:'target',sourceHandle:'output',targetHandle:'input'}];f.storage.captureDraft('p',f.graph);const command=f.command();expect(command.nodes[0].data.params.prompt).toBe('Move gently.\nThe new connected direction.');await f.submit(command);
  expect(f.submitted()).toHaveLength(3);for(const request of f.submitted()){const data=request.body.graph.nodes.find((node:any)=>node.id==='target').data;expect(data.params.prompt).toBe('Move gently.');for(const key of historyFields)expect(data[key],key).toEqual(before[key]);}
  expect(f.submitted()[2].body.graph.nodes.find((node:any)=>node.id==='text').data.text).toBe('The new connected direction.');expect(f.target.data).toEqual(before);
 }finally{f.execution.clear();}
});
it.each(['references','prompt','topology'] as const)('rejects an explicit command %s change instead of hiding it through native input projection',async change=>{
 const f=fixture(),command=f.command();if(change==='references')command.nodes[0].data.params.imageUrls=['rhtv-asset:forged-image'];if(change==='prompt')command.nodes[0].data.params.prompt='Forged input.';if(change==='topology'){command.edges[0].source='old-image';command.nodes.push(structuredClone(f.graph.nodes.find((node:any)=>node.id==='old-image')));}
 try{await expect(f.submit(command)).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);}finally{f.execution.clear();}
});
it.each(['topology','source-result','text'] as const)('retains a real later %s change while catalog lookup is pending and creates no stale task',async change=>{
 const gate=deferred<Response>(),f=fixture({mode:change==='text'?'text':'image',connection:change==='text'?'text':'current',catalog:()=>gate.promise});
 try{const pending=f.submit(),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(f.requests.some(row=>row.path.includes('model-capabilities'))).toBe(true));if(change==='topology')f.graph.edges=[];if(change==='source-result')f.graph.nodes.find((node:any)=>node.id==='current-image').data.sourceObjects=['rhtv-asset:new-late-image'];if(change==='text')f.text.data.text='Newer current text.';const retained=structuredClone(f.graph);gate.resolve(json({items:[f.cap],nextCursor:null}));await rejected;expect(f.submitted()).toHaveLength(0);expect(f.graph).toEqual(retained);}finally{f.execution.clear();}
});
it('keeps parameter-only image references for a non-native direct submission',async()=>{
 const f=fixture({native:false,connection:'none'});
 try{await f.submit(structuredClone(f.graph));expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='target').data.params.imageUrls).toEqual(['rhtv-asset:old-image']);}finally{f.execution.clear();}
});

it('reopens a legacy motion v2 result in its exact catalog mode and submits the real q_/W8 command without replacing the saved model',async()=>{
 const f=fixture({mode:'motion'}),before=structuredClone(f.graph);
 try{expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');const command=f.command();expect(command.nodes[0].data.subType).toBe('video-motion-transfer');await f.submit(command);expect(f.submitted()).toHaveLength(1);const data=f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='target').data;expect(data.modelCode).toBe('h3-motion-transfer-v1');expect(data.capabilityVersion).toBe('2');expect(data.params.imageUrls).toEqual(['rhtv-asset:current-image']);expect(data.params.videoUrls).toEqual(['rhtv-asset:current-video']);for(const key of historyFields)expect(data[key],key).toEqual(before.nodes.find((node:any)=>node.id==='target').data[key]);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it.each(['mode','model','version','schema','prompt','parameters','references','history'] as const)('does not use legacy motion compatibility to admit a changed command %s',async change=>{
 const f=fixture({mode:'motion'}),command=f.command(),data=command.nodes[0].data;
 if(change==='mode')data.subType='text-video';if(change==='model')data.modelCode='h3-video-reference-v1';if(change==='version')data.capabilityVersion='1';if(change==='schema')data.parameterSchemaVersion='1';
 if(change==='prompt')data.params.prompt='Injected authored direction';if(change==='parameters')data.params.outputPreset='portrait-768p-source';if(change==='references')data.params.imageUrls=['rhtv-asset:old-image'];if(change==='history')data.historyStorage={...data.historyStorage,historyId:'another-batch'};
 const before=structuredClone(f.graph);try{await expect(f.submit(command)).rejects.toMatchObject({code:change==='mode'?'MODEL_INPUT_UNSUPPORTED':change==='version'?'MODEL_PARAMETER_INVALID':'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it('reopens the canonical motion mode after a prior generation without changing its model or history',async()=>{
 const f=fixture({mode:'motion'});f.target.data.subType='video-motion-transfer';f.storage.captureDraft('p',f.graph);const before=structuredClone(f.graph);
 try{expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');await f.submit();expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='target').data.modelCode).toBe('h3-motion-transfer-v1');expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it('retains a later motion reference edit while catalog lookup waits instead of submitting the old command',async()=>{
 const gate=deferred<Response>(),f=fixture({mode:'motion',catalog:()=>gate.promise});
 try{const pending=f.submit(),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(f.requests.some(row=>row.path.includes('model-capabilities'))).toBe(true));f.graph.edges=f.graph.edges.filter((edge:any)=>edge.source!=='current-video');const retained=structuredClone(f.graph);gate.resolve(json({items:[f.cap],nextCursor:null}));await rejected;expect(f.submitted()).toHaveLength(0);expect(f.graph).toEqual(retained);}finally{f.execution.clear();}
});

it('retains the three canonical source types across the actual frozen image aliases and HTTP request bodies',async()=>{
 const rows:any[]=[];
 for(const type of ['rh-entity','rh-role','rh-scene']){
  const f=fixture({aliasType:type}),source=f.graph.nodes.find((n:any)=>n.id==='current-image')!;
  try{
   expect((await f.execution.inspectGeneration('p',['target'],f.graph)).status).toBe('ready');
   const projected=f.command(),alias=projected.nodes.find((n:any)=>n.id===source.id);expect(alias.type).toBe('rh-image');
   expect(projected.nodes.find((n:any)=>n.id==='target').data.params.imageUrls).toEqual(['rhtv-asset:a-image']);
   await f.submit(projected);expect(f.submitted()).toHaveLength(1);const body=f.submitted()[0].body;
   expect(body.graph.nodes.find((n:any)=>n.id===source.id)?.type).toBe(type);
   expect(body.graph.nodes.find((n:any)=>n.id==='target')?.data.params.imageUrls).toEqual(['rhtv-asset:a-image']);
   rows.push({name:type+' direct displayed image',model:'h3-first-frame-v1',expectedAssetIds:['a-image'],body});
  }finally{f.execution.clear();}
 }
 if(process.env.STUDIO_CANVAS_ALIAS_EXPORT)writeFileSync(process.env.STUDIO_CANVAS_ALIAS_EXPORT,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
});
