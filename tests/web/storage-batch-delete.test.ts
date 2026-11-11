import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {imageBatchNodeId} from '../../apps/web/src/service/image-batch-output';
import {CanvasSync} from '../../apps/web/src/service/canvas-sync';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('const u1n='),end=frozen.indexOf('function WXr(',start);
if(start<0||end<0)throw new Error('Reviewed frozen native projection changed');
const normalize=new Function(frozen.slice(start,end)+';return oL;')() as (graph:NativeGraph)=>NativeGraph;
const origin=(index:number)=>({taskId:'task',executionId:'execution',sourceNodeId:'source',outputId:'output-'+index,index,count:2});
const result=(index:number)=>({id:index===0?'source':imageBatchNodeId('task','execution','output-'+index),type:'rh-image',position:{x:index*400,y:0},data:{title:'Image '+index,status:'finished',output:[{assetId:'asset-'+index,url:'rhtv-asset:asset-'+index,outputType:'image/png',historyOutputId:'output-'+index}],sourceObjects:['rhtv-asset:asset-'+index],imageUrl:'rhtv-asset:asset-'+index,assetIds:['asset-'+index],batchOrigin:origin(index),testMode:false,params:{},generateNum:1,...(index===0?{modelCode:'z-image-turbo-generate-v1',capabilityRef:'z-image-turbo-generate-v1',capabilityVersion:'1',parameterSchemaVersion:'1',taskId:'task'}:{isUpload:true}),historyStorage:{imageBatchOrigin:origin(index)}}});
const graph=():NativeGraph=>({nodes:[result(0),result(1)],edges:[]});
const json=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',message:status<400?'OK':'conflict',data}),{status,headers:etag?{ETag:etag}:{}});

async function setup(initial=graph()){
 let revision=1,stored=encodeGraph(initial);const snapshot=()=>({projectId:'p',revision,graph:structuredClone(stored),updatedAt:'2026-10-22T00:00:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p')return json({id:'p',name:'Batch test',ownerId:'owner',revision,updatedAt:'2026-10-22T00:00:00Z'});
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){if(init.headers.get('If-Match')!=='"'+revision+'"')return json({},412);stored=JSON.parse(init.body).graph;revision++;}
   return json(snapshot(),200,'"'+revision+'"');
  }
  if(path==='/api/v2/assets/resolve-batch')return json({assets:JSON.parse(init.body).assetIds.map((id:string)=>({id,state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:'https://studio.invalid/'+id}))});
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1);return json({id,state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:'https://studio.invalid/'+id});}
  throw new Error('Unexpected request '+path);
 });
 const api=new ProductClient('/api/v1',transport),storage=new ServiceStorage(api,vi.fn());api.setAccessToken('fixture-owner');await storage.loadProject('p');
 return {api,storage,transport,current:()=>decodeGraph(stored),snapshot,remote:(next:NativeGraph)=>{stored=encodeGraph(next);revision++;return snapshot();}};
}
const puts=(transport:any)=>transport.mock.calls.filter(([path,init]:any[])=>path.endsWith('/snapshot')&&init.method==='PUT');

it.each([0,1])('allows ordinary deletion of displayed batch image %s after real native normalization',async index=>{
 const f=await setup(),mounted=normalize(f.storage.fixture('p'));
 expect(mounted.nodes[index].data).not.toHaveProperty('batchOrigin');expect(mounted.nodes[index].data).not.toHaveProperty('assetIds');expect(mounted.nodes[index].data).not.toHaveProperty('testMode');
 f.storage.attachNativeView('p',mounted);mounted.nodes=mounted.nodes.filter(node=>node.id!==result(index).id);
 await f.storage.queueSave('p',mounted);
 expect(f.current().nodes.map(node=>node.id)).toEqual([result(1-index).id]);expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.hasDraft('p')).toBe(false);
 expect(puts(f.transport)).toHaveLength(1);expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"1"');
});

it('records the same complete observed baseline after a remote batch projection',async()=>{
 const initial:NativeGraph={nodes:[],edges:[]},f=await setup(initial);f.storage.attachNativeView('p',initial);
 await f.storage.receiveLiveSnapshot('p',f.remote(graph()),'"2"',()=>initial,()=>true,new AbortController().signal);
 const mounted=normalize(f.storage.mergedNativeView('p').graph);f.storage.remoteNativeViewApplied('p',mounted);
 const child=result(1).id;mounted.nodes=mounted.nodes.filter(node=>node.id!==child);await f.storage.queueSave('p',mounted);
 expect(f.current().nodes.map(node=>node.id)).toEqual(['source']);expect(f.storage.isBlocked('p')).toBe(false);expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"2"');
});

it('applies deferred batch results after editing a second node without losing either local input or remote children',async()=>{
 const waiting=result(0);waiting.data.status='processing';waiting.data.output=[];waiting.data.sourceObjects=[];waiting.data.imageUrl='';
 for(const key of ['assetIds','batchOrigin','historyStorage','testMode'])delete (waiting.data as any)[key];
 const initial={nodes:[waiting],edges:[]},f=await setup(initial);f.api.setAccessToken('fixture-owner');let mounted=normalize(f.storage.fixture('p')),focused=true;
 f.storage.attachNativeView('p',mounted);mounted.nodes.push({id:'next',type:'rh-image',position:{x:900,y:0},data:{title:'Second',prompt:'Before',params:{prompt:'Before'},status:'idle'}});
 const snapshot=f.remote(graph()),original=f.transport.getMockImplementation()!;
 f.transport.mockImplementation(async(path:string,init:any)=>path.endsWith('/live-snapshot')?json({schemaVersion:'1',projectId:'p',graphRevision:snapshot.revision,graph:snapshot.graph,eventCursor:'12',updatedAt:snapshot.updatedAt,nodeStates:[],nodeExecutionAvailable:false},200,'"2"'):original(path,init));
 const applied=vi.fn(),sync=new CanvasSync(f.api,f.storage,'p',{current:()=>true,read:()=>mounted,apply:value=>{if(focused)return false;mounted=normalize(value);return true;},applied,error:vi.fn()});
 expect(await sync.catchUp()).toBe(false);expect(sync.awaitingApply).toBe(true);expect(sync.eventCursor).toBeNull();expect(mounted.nodes).toHaveLength(2);
 mounted.nodes.find(node=>node.id==='next')!.data.prompt='Edited while focused';
 focused=false;expect(await sync.catchUp()).toBe(true);expect(sync.awaitingApply).toBe(false);expect(sync.eventCursor).toBe('12');
 expect(mounted.nodes.map(node=>node.id)).toEqual(['source','next',result(1).id]);expect(mounted.nodes.find(node=>node.id==='next')!.data.prompt).toBe('Edited while focused');expect(f.storage.isBlocked('p')).toBe(false);expect(applied).toHaveBeenCalledOnce();
 mounted.nodes=mounted.nodes.filter(node=>node.id!==result(1).id);await f.storage.queueSave('p',mounted);
 expect(f.current().nodes.map(node=>node.id)).toEqual(['source','next']);expect(f.storage.isBlocked('p')).toBe(false);
});

it('preserves image batch provenance when editing title or position through the native view',async()=>{
 const f=await setup(),mounted=normalize(f.storage.fixture('p'));f.storage.attachNativeView('p',mounted);mounted.nodes[1].data.title='Chosen result';mounted.nodes[1].position={x:50,y:60};await f.storage.queueSave('p',mounted);
 expect(f.current().nodes[1]).toMatchObject({position:{x:50,y:60},data:{title:'Chosen result',assetIds:['asset-1'],batchOrigin:origin(1),isUpload:true,testMode:false}});
});

it.each(['prompt','output','origin','unknown'])('retains DELETE_EDIT for a real remote %s edit after a local deletion',async change=>{
 const f=await setup(),mounted=normalize(f.storage.fixture('p'));f.storage.attachNativeView('p',mounted);mounted.nodes=mounted.nodes.filter(node=>node.id==='source');f.storage.observeNativeDraft('p',mounted);
 const remote=graph(),data:any=remote.nodes[1].data;
 if(change==='prompt')data.params={prompt:'A real remote edit'};
 else if(change==='output')data.output=[{assetId:'changed',url:'rhtv-asset:changed',outputType:'image/png'}];
 else if(change==='origin'){data.batchOrigin={...origin(1),executionId:'different'};data.historyStorage.imageBatchOrigin=data.batchOrigin;}
 else data.customSemanticField='A real remote edit';
 const accepted=f.storage.acceptRemoteSnapshot('p',f.remote(remote),'"2"');expect(accepted.conflicts).toContainEqual({path:'/nodes/'+result(1).id,reason:'DELETE_EDIT'});
 await expect(f.storage.queueSave('p',mounted)).rejects.toMatchObject({status:409,code:'LOCAL_DRAFT_CONFLICT'});expect(puts(f.transport)).toHaveLength(0);expect(f.current().nodes).toHaveLength(2);
});

it.each(['asset','origin','node-id','type','output','source','history','explicit-metadata'])('does not restore omitted batch metadata for mismatched %s identity',async change=>{
 const f=await setup(),mounted=normalize(f.storage.fixture('p')),child:any=mounted.nodes[1];
 if(change==='node-id')child.id='not-the-generated-id';
 else if(change==='type')child.type='rh-video';
 else if(change==='history')child.data.historyStorage.imageBatchOrigin.outputId='wrong';
 else if(change==='explicit-metadata')child.data.batchOrigin={...origin(1),executionId:'explicit-local-value'};
 if(change==='asset')child.data.output[0].assetId='different';
 if(change==='origin')delete child.data.historyStorage;
 if(change==='output')child.data.output=[];
 if(change==='source')child.data.sourceObjects=['rhtv-asset:other'];
 f.storage.attachNativeView('p',mounted);
 const observed=(f.storage as any).drafts.get('p').observed.nodes.find((node:any)=>node.id===child.id);
 expect(observed.data).not.toHaveProperty('assetIds');expect(observed.data).not.toHaveProperty('isUpload');
 if(change==='explicit-metadata')expect(observed.data.batchOrigin.executionId).toBe('explicit-local-value');
 else expect(observed.data).not.toHaveProperty('batchOrigin');
});

it('never treats unrelated omitted semantic fields as safe projection metadata',async()=>{
 const initial=graph();(initial.nodes[1].data as any).unknownServerField={important:true};const f=await setup(initial),mounted=normalize(f.storage.fixture('p'));f.storage.attachNativeView('p',mounted);mounted.nodes=mounted.nodes.filter(node=>node.id==='source');
 await expect(f.storage.queueSave('p',mounted)).rejects.toMatchObject({status:409,code:'LOCAL_DRAFT_CONFLICT'});expect(f.storage.isBlocked('p')).toBe(true);expect(puts(f.transport)).toHaveLength(0);
});
