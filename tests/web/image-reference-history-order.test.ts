import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {nativeImageComposedReferences} from '../../apps/web/src/service/image-prompt-projection';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
function body(name:string,end='function '){const marker='function '+name+'(',start=compiled.indexOf(marker),to=compiled.indexOf(end,start+marker.length);if(start<0||to<0)throw Error('Frozen image reference seam changed: '+name);return compiled.slice(start,to);}
const declarations=[body('MCe','function dNn('),body('lNn','function cNn('),body('cNn','function MCe('),body('sNn'),...['ADe','dJ','Wc','ja','Xs','ms','Ddn','Pp','Ns','Mo','cJ','j8','oNn','rNn','Np','Tme','kme','tDe','D7','dh','u_n','L7','Tv','eJ','q_'].map(name=>body(name))].join('\n');
// Actual q_/oNn/Wc/Np/ja/Ns/Mo/eJ/MCe. Only browser/catalog plumbing and
// Wc's output digest are ports; both digest arguments use the same URL facts.
const nativeProject=runInNewContext(declarations+';q_',{
 W5:(value:any)=>JSON.parse(JSON.stringify(value)),dw:()=>[],nNn:()=> 'prompt',sd:(id:string,nodes:any[],edges:any[])=>edges.filter(edge=>edge.target===id).map(edge=>nodes.find(node=>node.id===edge.source)),As:(type:string)=>type==='rh-text',Vut:(value:string)=>value.trim(),PA:(data:any)=>data.mentionAssets??[],uJ:()=>[],aNn:()=>{},oft:()=>false,rft:()=>false,eft:()=>false,
 Ar:(type:string)=>type==='rh-image',no:(type:string)=>type==='rh-video',Ga:(type:string)=>type==='rh-audio',vy:()=>true,_c:(values:any[])=>JSON.stringify(values.map(value=>typeof value==='string'?value:value?.url).sort()),f_n:(value:any)=>value,Gut:(value:any)=>typeof value==='string'?value.trim():value,
 Q0:()=>[],sft:(value:any)=>value,Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,x4e:()=>false,dNn:(value:any)=>value,hM:()=>null,J1e:()=>false,fNn:new Set(),
 _t:{PROMPT:'prompt',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls',FIRST_IMAGE_URL:'firstImageUrl',FIRST_FRAME_URL:'firstFrameUrl',LAST_IMAGE_URL:'lastImageUrl',LAST_FRAME_URL:'lastFrameUrl',IMAGE_PROMPT:'imagePrompt',SREF:'sref',IMAGE_REF:'imageRef',VIDEO_URL:'videoUrl',VIDEO_URLS:'videoUrls',AUDIO_URL:'audioUrl',AUDIO_URLS:'audioUrls',RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio'},
});
const cap:any={capabilityRef:'qwen-image-edit-2511-v1',version:'1',parameterSchemaVersion:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,executionKind:'JOB',model:{providerRef:'comfy',modelRef:'qwen-image-edit-2511',title:'Qwen-Image-Edit-2511',version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['1024-square'],default:'1024-square'}},additionalProperties:false}};
function fixture(history:'remote'|'embedded'|'upload'='remote',order:any[]=['second','first']){
 const source=(id:string)=>({id,type:'rh-image',position:{x:0,y:0},data:history==='upload'?{isUpload:true,sourceObjects:['rhtv-asset:'+id]}:{modelCode:'qwen-image-edit-2511-v1',params:{imageUrls:['rhtv-asset:ancestor']},sourceObjects:['rhtv-asset:old-'+id],output:[{url:'rhtv-asset:old-'+id,historyOutputId:'old-'+id},{url:'rhtv-asset:'+id,historyOutputId:'selected-'+id}],...(history==='remote'?{selectedHistoryOutputId:'selected-'+id}:{selectedOutputHistoryId:'batch-'+id,selectedOutputHistoryIndex:1,nodeOutputHistory:[{id:'batch-'+id,outputs:[{url:'rhtv-asset:old-'+id},{url:'rhtv-asset:'+id}]}]})}});
 const target={id:'target',type:'rh-image',position:{x:500,y:0},data:{modelCode:cap.capabilityRef,subType:'image-image',params:{prompt:'A fox beside a blue cup.',imageUrls:[],outputPreset:'1024-square'},generateNum:1,imageOrder:order}},graph:any={nodes:[source('first'),source('second'),target],edges:['first','second'].map(source=>({id:'edge-'+source,source,target:'target',sourceHandle:'output',targetHandle:'input'}))};
 const model=capabilityModel(cap),command=()=>{const value=nativeProject('target',graph.nodes,graph.edges,{modelConfig:model.config});value.nodes[0].data.modelType=model.modelType;return value;};
 return{target,graph,command};
}
const orders=[['second::rhtv-asset:second','first::rhtv-asset:first'],['rhtv-asset:second','rhtv-asset:first'],['second','first'],[{nodeId:'second',url:'rhtv-asset:second'},{nodeId:'first',fileUrl:'rhtv-asset:first'}],[{_key:'second::rhtv-asset:second'},{_key:'first::rhtv-asset:first'}]];
it.each(['remote','embedded','upload'] as const)('matches real frozen image projection for selected %s results and every saved order grammar',history=>{
 for(const order of orders){const f=fixture(history,order),before=structuredClone(f.graph);expect(f.command().nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:second','rhtv-asset:first']);expect(nativeImageComposedReferences(f.target,f.graph,value=>value)).toEqual(f.command().nodes[0].data.params.imageUrls);expect(f.graph).toEqual(before);}
});
it('retains unmatched source order and appends a selected style after ordering',()=>{
 const f=fixture('remote',['second','second','unknown']);expect(nativeImageComposedReferences(f.target,f.graph,value=>value)).toEqual(f.command().nodes[0].data.params.imageUrls);(f.target.data as any).presetSelections=[{key:'styleLibrary',referenceImageUrl:'rhtv-asset:style'}];expect(nativeImageComposedReferences(f.target,f.graph,value=>value)).toEqual(['rhtv-asset:second','rhtv-asset:first','rhtv-asset:style']);
});
it.each(['unknown-remote','unknown-embedded','missing-index','missing-displayed-result','unsafe-result','wrong-port','duplicate-source'] as const)('keeps %s unresolved rather than borrowing an unrelated historical image',change=>{
 const f=fixture(change==='unknown-remote'?'remote':'embedded'),source:any=f.graph.nodes[0];if(change==='unknown-remote')source.data.selectedHistoryOutputId='not-displayed';if(change==='unknown-embedded')source.data.selectedOutputHistoryId='not-loaded';if(change==='missing-index')source.data.selectedOutputHistoryIndex=7;if(change==='missing-displayed-result')source.data.nodeOutputHistory[0].outputs[1].url='rhtv-asset:not-displayed';if(change==='unsafe-result')source.data.output[1].url=source.data.nodeOutputHistory[0].outputs[1].url='https://unowned.invalid/image';if(change==='wrong-port')f.graph.edges[0].sourceHandle='wrong';if(change==='duplicate-source')f.graph.edges.push({...f.graph.edges[0],id:'duplicate'});expect(nativeImageComposedReferences(f.target,f.graph,value=>value)).toBeUndefined();
});
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
it.each(['remote','embedded'] as const)('submits the actual ordered %s image command and rejects a forged reference without calling a provider',async history=>{
 for(const forged of [false,true]){const f=fixture(history),requests:any[]=[],api=new ProductClient('/api/v1',async(path,init:any)=>{const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});if(path.includes('model-capabilities'))return json({items:[cap],nextCursor:null});if(path.startsWith('/api/v1/assets/'))return json({id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});if(path.endsWith('/snapshot'))return json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-11-04T09:00:00Z'});if(path==='/api/v2/canvas-runs')return json({id:'task',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:1,testMode:false,plans:[{nodeId:'target',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});if(path==='/api/v2/generation-diagnostics')return json({logId:'diagnostic'});throw Error('Unexpected image reference route '+path);});api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(f.graph),updatedAt:'2026-11-04T08:00:00Z'},'"1"');storage.attachNativeView('p',f.graph);execution.attach('p',{getRemoteData:()=>f.graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()});
  try{const command=f.command();if(forged)command.nodes[0].data.params.imageUrls[0]='rhtv-asset:forged';const run=execution.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command});if(forged)await expect(run).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});else await run;expect(requests.filter(row=>row.path==='/api/v2/canvas-runs')).toHaveLength(forged?0:1);expect(storage.isBlocked('p')).toBe(false);}finally{execution.clear();}
 }
});

it('does not reuse a completed image run after disconnect; keeps the selected inline reference or current replacement',async()=>{
 const f=fixture('upload');f.graph.edges=[];const data:any=f.target.data;
 data.params.imageUrls=['rhtv-asset:removed'];data.historyStorage={source:'remote',historyId:'old',schemaVersion:1,revision:'1',resultCount:1};data.output=[{url:'rhtv-asset:previous-result'}];
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  if(path.includes('model-capabilities'))return json({items:[cap],nextCursor:null});
  if(path.startsWith('/api/v1/assets/'))return json({id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});
  throw Error('Inspection must not create tasks: '+path);
 });
 api.setAccessToken("fixture-owner");const storage=new ServiceStorage(api,()=>{}),execution=new ExecutionAdapter(api,storage,async()=>{},()=>{});
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(f.graph),updatedAt:'2026-11-04T08:00:00Z'},'"1"');execution.attach('p',{localOnly:true,getRemoteData:()=>f.graph});
 try{
  const ready=()=>execution.inspectGeneration('p',['target'],f.graph);
  expect((await ready()).issues[0]?.message).toContain('参考图片');
  expect(nativeImageComposedReferences(f.target,f.graph,v=>v,true)).toEqual([]);
  data.mentionAssets=[{type:'IMAGE',url:'rhtv-asset:inline'}];expect((await ready()).status).toBe('ready');expect(nativeImageComposedReferences(f.target,f.graph,v=>v,true)).toEqual(['rhtv-asset:inline']);
  delete data.mentionAssets;f.graph.edges=[{id:'replacement',source:'second',target:'target'}];expect((await ready()).status).toBe('ready');expect(nativeImageComposedReferences(f.target,f.graph,v=>v,true)).toEqual(['rhtv-asset:second']);
  expect(data.output).toEqual([{url:'rhtv-asset:previous-result'}]);expect(data.params.imageUrls).toEqual(['rhtv-asset:removed']);
 }finally{execution.clear();}
});
