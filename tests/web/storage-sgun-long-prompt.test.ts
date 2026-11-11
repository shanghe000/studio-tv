import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('const u1n='),end=frozen.indexOf('function WXr(',start);
if(start<0||end<0)throw new Error('Reviewed frozen native projection changed');
const normalize=new Function(frozen.slice(start,end)+';return oL;')() as (graph:NativeGraph)=>NativeGraph;
const prompt=('A continuous shot of the same woman beside a bookstore. Preserve her face, coat, closed umbrella, camera axis, quiet traffic and natural movement.\n').repeat(34);
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id==='video')!;
const graph=():NativeGraph=>({nodes:[{id:'video',type:'rh-video',position:{x:0,y:0},data:{title:'Long video',status:'finished',prompt,params:{prompt,text:prompt,imageUrls:['rhtv-asset:reference'],outputPreset:'landscape-480p-30s'},modelCode:'h3-sgun-long-reference-v1',capabilityRef:'h3-sgun-long-reference-v1',capabilityVersion:'1',parameterSchemaVersion:'1',taskId:'task',testMode:false,output:[{assetId:'video-asset',outputId:'output',url:'rhtv-asset:video-asset',mimeType:'video/mp4',outputType:'video/mp4',durationMs:29959,width:864,height:480}],videoUrl:'rhtv-asset:video-asset',historyStorage:{source:'remote',historyId:'execution',revision:'6',resultCount:1,schemaVersion:1},userPromptSnapshot:{paramName:'prompt',value:prompt},routerParameters:{outputPreset:'landscape-480p-30s'}}},{id:'other',type:'rh-text',position:{x:500,y:0},data:{text:'Keep this node'}}],edges:[]});
const json=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',message:status<400?'OK':'conflict',data}),{status,headers:etag?{ETag:etag}:{}});
async function setup(initial=graph()){
 let revision=1,stored=encodeGraph(initial);const snapshot=()=>({projectId:'p',revision,graph:structuredClone(stored),updatedAt:'2026-10-22T00:00:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p')return json({id:'p',name:'Long prompt test',ownerId:'owner',revision,updatedAt:'2026-10-22T00:00:00Z'});
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){if(init.headers.get('If-Match')!=='"'+revision+'"')return json({},412);stored=JSON.parse(init.body).graph;revision++;}
   return json(snapshot(),200,'"'+revision+'"');
  }
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1);return json({id,state:'READY',kind:id==='reference'?'IMAGE':'VIDEO',mimeType:id==='reference'?'image/png':'video/mp4',downloadUrl:'https://owned.invalid/'+id});}
  throw new Error('Unexpected request '+path);
 });
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport),vi.fn());await storage.loadProject('p');
 return{storage,transport,current:()=>decodeGraph(stored),remote:(next:NativeGraph)=>{stored=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');}};
}
const puts=(transport:any)=>transport.mock.calls.filter(([path,init]:any[])=>path.endsWith('/snapshot')&&init.method==='PUT');

it.each(['attach','remoteApply'] as const)('retains the complete completed SGUN receipt through exact native truncation at %s',async seam=>{
 const f=await setup(),native=normalize(f.storage.fixture('p')),data=target(native).data;
 expect(prompt.length).toBeGreaterThan(4000);expect(data.prompt).toBe(prompt.slice(0,4000));expect(data.params.prompt).toBe(prompt);expect(data.params.text).toBe(prompt);expect(data).not.toHaveProperty('testMode');expect(data).not.toHaveProperty('routerParameters');
 if(seam==='attach')f.storage.attachNativeView('p',native);else f.storage.remoteNativeViewApplied('p',native);
 f.storage.observeNativeDraft('p',native);expect(f.storage.hasDraft('p')).toBe(false);
 data.title='Chosen continuous shot';target(native).position={x:50,y:60};await f.storage.queueSave('p',native);
 expect(target(f.current())).toMatchObject({position:{x:50,y:60},data:{title:'Chosen continuous shot',prompt,params:{prompt,text:prompt},testMode:false,routerParameters:{outputPreset:'landscape-480p-30s'},userPromptSnapshot:{paramName:'prompt',value:prompt}}});expect(f.storage.isBlocked('p')).toBe(false);expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"1"');
});

it('allows ordinary deletion of the same completed SGUN video after frozen native projection',async()=>{
 const f=await setup(),native=normalize(f.storage.fixture('p'));f.storage.attachNativeView('p',native);native.nodes=native.nodes.filter(node=>node.id!=='video');await f.storage.queueSave('p',native);
 expect(f.current().nodes.map(node=>node.id)).toEqual(['other']);expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.hasDraft('p')).toBe(false);
});

it.each(['params','prompt','unknown','asset'])('retains DELETE_EDIT for a real remote %s edit after local SGUN deletion',async field=>{
 const f=await setup(),native=normalize(f.storage.fixture('p'));f.storage.attachNativeView('p',native);native.nodes=native.nodes.filter(node=>node.id!=='video');f.storage.observeNativeDraft('p',native);
 const remote=graph(),data=target(remote).data;if(field==='params')data.params.prompt='A new remote prompt';else if(field==='prompt')data.prompt='A new remote display prompt';else if(field==='asset')data.output[0].assetId='different';else data.unknownSemanticField='Do not discard';
 expect(f.remote(remote).conflicts).toContainEqual({path:'/nodes/video',reason:'DELETE_EDIT'});await expect(f.storage.queueSave('p',native)).rejects.toMatchObject({status:409,code:'LOCAL_DRAFT_CONFLICT'});expect(puts(f.transport)).toHaveLength(0);
});

it.each(['prompt','nonprefix','params-prompt','params-text','missing-text','params-other','model','version','schema','task','history','output','asset','status'])('does not inherit a preceding receipt after explicit %s changes',async field=>{
 const f=await setup(),native=normalize(f.storage.fixture('p')),data=target(native).data;
 if(field==='prompt')data.prompt='A different local prompt';if(field==='nonprefix')data.prompt='!'+data.prompt.slice(1);if(field==='params-prompt')data.params.prompt='A new local prompt';if(field==='params-text')data.params.text='A new local text';if(field==='missing-text')delete data.params.text;if(field==='params-other')data.params.outputPreset='landscape-480p-20s';if(field==='model')data.modelCode='h3-drama-reference-v1';if(field==='version')data.capabilityVersion='2';if(field==='schema')Object.assign(data,{capabilityRef:'h3-sgun-long-reference-v1',capabilityVersion:'1',parameterSchemaVersion:'2'});if(field==='task')data.taskId='new-task';if(field==='history')data.historyStorage.historyId='new-execution';if(field==='output')data.output[0].outputId='different';if(field==='asset')data.output[0].assetId='different';if(field==='status')data.status='processing';
 f.storage.attachNativeView('p',native);const observed=target((f.storage as any).drafts.get('p').observed).data;
 expect(observed.prompt).toBe(data.prompt);expect(observed).not.toHaveProperty('routerParameters');expect(observed).not.toHaveProperty('userPromptSnapshot');expect(observed).not.toHaveProperty('testMode');
});

it('keeps explicit native test mode and frozen receipt values',async()=>{
 const f=await setup(),native=normalize(f.storage.fixture('p')),data=target(native).data;data.testMode=true;data.routerParameters=null;data.userPromptSnapshot={explicit:'local'};f.storage.attachNativeView('p',native);
 expect(target((f.storage as any).drafts.get('p').observed).data).toMatchObject({testMode:true,routerParameters:null,userPromptSnapshot:{explicit:'local'}});
});

it('never restores an unrelated omitted semantic field just because the SGUN prompt was truncated',async()=>{
 const initial=graph();target(initial).data.unknownSemanticField={preserve:true};const f=await setup(initial),native=normalize(f.storage.fixture('p'));f.storage.attachNativeView('p',native);native.nodes=native.nodes.filter(node=>node.id!=='video');
 await expect(f.storage.queueSave('p',native)).rejects.toMatchObject({status:409,code:'LOCAL_DRAFT_CONFLICT'});expect(puts(f.transport)).toHaveLength(0);
});
