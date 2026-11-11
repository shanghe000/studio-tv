import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

const edge=(id='original-edge')=>({id,source:'image',target:'video',sourceHandle:'output',targetHandle:'input'});
const initial=():NativeGraph=>({nodes:[{id:'image',type:'rh-image',position:{x:0,y:0},data:{title:'Reference'}},{id:'video',type:'rh-video',position:{x:500,y:0},data:{title:'Video',modelCode:'h3-first-frame-v1',params:{prompt:'Keep the authored input.'}}}],edges:[edge()]});
const updatedAt='2026-11-03T15:00:00Z';
const reply=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',message:status<400?'OK':'conflict',data}),{status,headers:etag?{ETag:etag}:{}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}

async function fixture(){
 let revision=1,graph=encodeGraph(initial()),mounted=initial(),writes=0;const first=deferred<Response>(),started=deferred<void>();let committed:any;
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'owner',name:'Single editor',revision,updatedAt});
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){
    if(init.headers.get('If-Match')!=='"'+revision+'"')return reply({},412);
    graph=JSON.parse(init.body).graph;revision++;
    if(++writes===1){committed=snapshot();started.resolve();return first.promise;}
   }
   return reply(snapshot(),200,'"'+revision+'"');
  }
  throw Error('Unexpected single-editor fixture request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn());await storage.loadProject('p');storage.attachNativeView('p',mounted);
 return{storage,transport,started,read:()=>mounted,replace:(next:NativeGraph)=>{mounted=next;},snapshot,current:()=>decodeGraph(graph),release:()=>first.resolve(reply(committed,200,'"'+committed.revision+'"'))};
}

it.each(['before-receipt','deferred-before-receipt','after-receipt'] as const)('keeps a single editor reconnect through its own disconnect echo %s',async timing=>{
 const f=await fixture();f.read().edges=[];f.storage.captureDraft('p',f.read());const saving=f.storage.queueSave('p',f.read());await f.started.promise;
 f.read().edges=[edge('reconnected-edge')];f.storage.captureDraft('p',f.read());
 const echo=async()=>{
  await f.storage.receiveLiveSnapshot('p',f.snapshot(),'"2"',f.read,()=>true,new AbortController().signal);
  if(timing!=='deferred-before-receipt'){f.replace(f.storage.mergedNativeView('p').graph);f.storage.remoteNativeViewApplied('p',f.read());}
 };
 if(timing==='after-receipt'){f.release();await saving;await echo();}else{await echo();f.release();await saving;}
 expect(f.storage.draftRecoveryState('p')).toMatchObject({blocked:false,conflicts:[]});expect(f.storage.mergedNativeView('p').graph.edges).toEqual([edge('reconnected-edge')]);
 await f.storage.queueSave('p',f.read());expect(f.current().edges).toEqual([edge('reconnected-edge')]);expect(f.storage.hasDraft('p')).toBe(false);expect(f.storage.isBlocked('p')).toBe(false);
});

it('keeps disconnect and reconnect after remounting while the first page save receipt is in flight',async()=>{
 const f=await fixture();f.read().edges=[];f.storage.captureDraft('p',f.read());const saving=f.storage.queueSave('p',f.read());await f.started.promise;
 const reopened=f.storage.fixture('p');f.replace(reopened);f.storage.attachNativeView('p',reopened);reopened.edges=[edge('remounted-edge')];f.storage.captureDraft('p',reopened);
 f.storage.acceptRemoteSnapshot('p',f.snapshot(),'"2"');f.release();await saving;
 expect(f.storage.isBlocked('p')).toBe(false);await f.storage.queueSave('p',f.read());expect(f.current().edges).toEqual([edge('remounted-edge')]);expect(f.storage.hasDraft('p')).toBe(false);
});

it.each([false,true])('uses already accepted live proof after exhausted CAS refusal and retains later edits (late edit=%s)',async lateEdit=>{
 let revision=1,graph=encodeGraph(initial()),refuse=true,puts=0,storage!:ServiceStorage,mounted!:NativeGraph;
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'owner',name:'Single editor',revision,updatedAt});
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){
    puts++;
    if(refuse){
     const newer=decodeGraph(graph);newer.nodes[0].data.title='Newer observation '+puts;graph=encodeGraph(newer);revision++;
     // Live delivery wins the race with the failed HTTP response. Its cursor
     // can already be at this head, so there need never be another event.
     storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');
     if(lateEdit&&puts===3){mounted.nodes[1].data.params.prompt='Typed while the refusal was arriving.';storage.captureDraft('p',mounted);}
     return reply({},412);
    }
    expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;
   }
   return reply(snapshot(),200,'"'+revision+'"');
  }
  throw Error('Unexpected CAS proof fixture request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');storage=new ServiceStorage(api,vi.fn());await storage.loadProject('p');mounted=storage.fixture('p');storage.attachNativeView('p',mounted);mounted.edges=[];
 await expect(storage.queueSave('p',mounted)).rejects.toMatchObject({status:412});expect(puts).toBe(3);expect(storage.snapshots.get('p')?.revision).toBe(4);
 expect(storage.draftRecoveryState('p')).toMatchObject({blocked:false,conflicts:[]});expect(storage.draft('p')?.edges).toEqual([]);
 refuse=false;mounted.edges=[edge('reconnected-edge')];await storage.queueSave('p',mounted);expect(decodeGraph(graph).edges).toEqual([edge('reconnected-edge')]);expect(storage.hasDraft('p')).toBe(false);
 expect(decodeGraph(graph).nodes[1].data.params.prompt).toBe(lateEdit?'Typed while the refusal was arriving.':'Keep the authored input.');
});

it('does not reuse old proof to release a preceding unknown write outcome',async()=>{
 const f=await fixture(),state=(f.storage as any).drafts.get('p');
 // This represents a page already retaining an unknown outcome. An earlier
 // coherent graph is not proof obtained after that unknown write completed.
 (f.storage as any).blockUncertain('p',state,0,true);
 (f.storage as any).blockRefusedSave('p',state,0);
 f.read().edges=[];f.storage.captureDraft('p',f.read());
 expect(f.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'CAS_UNCERTAIN',conflicts:[]});
 const rejected=f.storage.queueSave('p',f.read());await expect(rejected).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});expect(f.transport.mock.calls.some(([,init])=>init.method==='PUT')).toBe(false);expect(f.storage.draft('p')?.edges).toEqual([]);
});
