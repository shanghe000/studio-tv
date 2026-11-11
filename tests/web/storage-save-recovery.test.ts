import {expect,it,vi} from 'vitest';
import {ApiClient,ApiError} from '../../apps/web/src/api/client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
const initial=():NativeGraph=>({nodes:[{id:'a',type:'rh-text',position:{x:0,y:0},data:{title:'Original',text:'Prompt',status:'IDLE'}}],edges:[]});
const updatedAt='2026-10-06T12:00:00Z';
const reply=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',message:status<400?'OK':'conflict',data}),{status,headers:etag?{ETag:etag}:{}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
async function setup(hook?:(path:string,init:any)=>Response|Promise<Response>|undefined){
 let revision=1,graph=encodeGraph(initial());
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt});
 const transport=vi.fn(async(path:string,init:any)=>{
  const custom=hook?.(path,init);if(custom)return custom;
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){if(init.headers.get('If-Match')!=='"'+revision+'"')return reply({},412);graph=JSON.parse(init.body).graph;revision++;}
   return reply(snapshot(),200,'"'+revision+'"');
  }
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'u',name:'Project',revision,updatedAt});
  throw new Error('Unexpected request '+path);
 });
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());await storage.loadProject('p');
 return{storage,transport,snapshot,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;}};
}
const puts=(transport:any)=>transport.mock.calls.filter(([path,init]:any[])=>path.endsWith('/snapshot')&&init.method==='PUT');
const gets=(transport:any)=>transport.mock.calls.filter(([path,init]:any[])=>path.endsWith('/snapshot')&&init.method!=='PUT');
const edit=(title:string)=>{const graph=initial();graph.nodes[0].data.title=title;return graph;};
const running=()=>{const graph=initial();Object.assign(graph.nodes[0].data,{status:'RUNNING',taskId:'task',executionStartedAt:'2026-10-06T12:00:01Z'});return graph;};

it('rebases native autosave onto unseen RUNNING writeback once and leaves later editing enabled',async()=>{
 const f=await setup();f.remote(running());await f.storage.queueSave('p',edit('Local title'));
 expect(puts(f.transport).map(([,init]:any[])=>init.headers.get('If-Match'))).toEqual(['"1"','"2"']);
 expect(puts(f.transport).map(([,init]:any[])=>JSON.parse(init.body).graph.nodes[0].data)).toEqual([expect.objectContaining({title:'Local title',status:'IDLE'}),expect.objectContaining({title:'Local title',status:'RUNNING',taskId:'task'})]);
 expect(f.current().nodes[0].data).toMatchObject({title:'Local title',status:'RUNNING',taskId:'task',executionStartedAt:'2026-10-06T12:00:01Z'});
 expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.hasDraft('p')).toBe(false);
 await f.storage.queueSave('p',edit('Next title'));expect(f.current().nodes[0].data).toMatchObject({title:'Next title',status:'RUNNING',taskId:'task'});expect(puts(f.transport)).toHaveLength(3);
});

it('preserves a later queued local descendant while recovering the rejected save',async()=>{
 const reading=deferred<void>(),latest=deferred<Response>();let loaded=false;
 const f=await setup((path,init)=>loaded&&path.endsWith('/snapshot')&&init.method!=='PUT'?(reading.resolve(),latest.promise):undefined);loaded=true;f.remote(running());
 const first=f.storage.queueSave('p',edit('First title'));await reading.promise;
 const second=f.storage.queueSave('p',edit('Latest title'));latest.resolve(reply(f.snapshot(),200,'"2"'));await Promise.all([first,second]);
 expect(puts(f.transport).map(([,init]:any[])=>init.headers.get('If-Match'))).toEqual(['"1"','"2"','"3"']);expect(f.current().nodes[0].data).toMatchObject({title:'Latest title',status:'RUNNING',taskId:'task'});expect(f.storage.hasDraft('p')).toBe(false);
});

it('keeps native edits made during the recovery read as an unqueued draft after the retry succeeds',async()=>{
 const reading=deferred<void>(),latest=deferred<Response>();let loaded=false;
 const f=await setup((path,init)=>loaded&&path.endsWith('/snapshot')&&init.method!=='PUT'?(reading.resolve(),latest.promise):undefined);loaded=true;
 const view=f.storage.fixture('p');f.storage.attachNativeView('p',view);view.nodes[0].data.title='First title';f.remote(running());
 const first=f.storage.queueSave('p',view);await reading.promise;view.nodes[0].data.title='During recovery';f.storage.observeNativeDraft('p',view);
 latest.resolve(reply(f.snapshot(),200,'"2"'));await first;
 expect(f.current().nodes[0].data.title).toBe('First title');expect(f.storage.draft('p')?.nodes[0].data).toMatchObject({title:'During recovery',status:'RUNNING',taskId:'task'});expect(f.storage.isBlocked('p')).toBe(false);
 await f.storage.queueSave('p',view);expect(f.current().nodes[0].data).toMatchObject({title:'During recovery',status:'RUNNING'});expect(f.storage.hasDraft('p')).toBe(false);
});

it('pauses a real same-field conflict without retrying the PUT and preserves both local and remote differences',async()=>{
 const f=await setup(),remote=running();remote.nodes[0].data.title='Remote title';f.remote(remote);
 await expect(f.storage.queueSave('p',edit('Local title'))).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 expect(puts(f.transport)).toHaveLength(1);expect(f.storage.isBlocked('p')).toBe(true);expect(f.storage.mergedNativeView('p').conflicts.length).toBeGreaterThan(0);expect(f.storage.draft('p')?.nodes[0].data).toMatchObject({title:'Local title',status:'RUNNING',taskId:'task'});expect(f.current().nodes[0].data.title).toBe('Remote title');
});

it('stops retrying when a second 412 cannot be proven against a newer snapshot',async()=>{
 const f=await setup((path,init)=>path.endsWith('/snapshot')&&init.method==='PUT'?reply({},412):undefined);f.remote(running());
 await expect(f.storage.queueSave('p',edit('Keep local'))).rejects.toMatchObject({status:412});
 expect(puts(f.transport)).toHaveLength(2);expect(gets(f.transport)).toHaveLength(3);expect(f.storage.isBlocked('p')).toBe(true);expect(f.storage.draft('p')?.nodes[0].data).toMatchObject({title:'Keep local',status:'RUNNING'});
 await expect(f.storage.queueSave('p',edit('Newest local'))).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});expect(puts(f.transport)).toHaveLength(2);expect(f.storage.draft('p')?.nodes[0].data.title).toBe('Newest local');
});

it('does not recover a rejected ETag-only replacement whose original base is unknown',async()=>{
 const transport=vi.fn(async()=>reply({},412)),storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());storage.etags.set('p','"1"');
 await expect(storage.queueSave('p',edit('Keep local'))).rejects.toMatchObject({status:412});
 expect(transport).toHaveBeenCalledTimes(1);expect(storage.isBlocked('p')).toBe(true);expect(storage.draft('p')?.nodes[0].data.title).toBe('Keep local');
});

it.each(['project','etag'] as const)('rejects recovery snapshot %s mismatch before retry or acknowledged-base mutation',async mismatch=>{
 let loaded=false;const f=await setup((path,init)=>{
  if(!loaded||!path.endsWith('/snapshot')||init.method==='PUT')return;
  const snapshot=f.snapshot();return reply({...snapshot,projectId:mismatch==='project'?'other':'p'},200,mismatch==='etag'?'"3"':'"2"');
 });loaded=true;f.remote(running());
 await expect(f.storage.queueSave('p',edit('Keep local'))).rejects.toMatchObject({code:mismatch==='project'?'INVALID_RESPONSE':'SNAPSHOT_REVISION_MISMATCH'});
 expect(puts(f.transport)).toHaveLength(1);expect(f.storage.etags.get('p')).toBe('"1"');expect(f.storage.isBlocked('p')).toBe(true);expect(f.storage.draft('p')?.nodes[0].data.title).toBe('Keep local');
});

it('keeps a paused draft when the snapshot read needed to recover 412 fails',async()=>{
 let loaded=false;const f=await setup((path,init)=>loaded&&path.endsWith('/snapshot')&&init.method!=='PUT'?reply({},503):undefined);loaded=true;f.remote(running());
 await expect(f.storage.queueSave('p',edit('Keep local'))).rejects.toMatchObject({status:503});
 expect(puts(f.transport)).toHaveLength(1);expect(f.storage.isBlocked('p')).toBe(true);expect(f.storage.draft('p')?.nodes[0].data.title).toBe('Keep local');
});

it('discards a recovery read returned after account cleanup without retrying or restoring caches',async()=>{
 const reading=deferred<void>(),latest=deferred<Response>();let loaded=false;
 const f=await setup((path,init)=>loaded&&path.endsWith('/snapshot')&&init.method!=='PUT'?(reading.resolve(),latest.promise):undefined);loaded=true;f.remote(running());
 const saving=f.storage.queueSave('p',edit('Old account')),rejected=expect(saving).rejects.toMatchObject({code:'SESSION_CHANGED'});await reading.promise;f.storage.clear();latest.resolve(reply(f.snapshot(),200,'"2"'));await rejected;
 expect(puts(f.transport)).toHaveLength(1);expect(f.storage.projects.size).toBe(0);expect(f.storage.snapshots.size).toBe(0);expect(f.storage.etags.size).toBe(0);expect(f.storage.hasDraft('p')).toBe(false);
});

it('does not retry an execution save after its current-project guard changes during recovery',async()=>{
 const reading=deferred<void>(),latest=deferred<Response>();let loaded=false,current=true;
 const f=await setup((path,init)=>loaded&&path.endsWith('/snapshot')&&init.method!=='PUT'?(reading.resolve(),latest.promise):undefined);loaded=true;f.remote(running());
 const saving=f.storage.saveForExecution('p',edit('Frozen'),()=>edit('Frozen'),()=>{if(!current)throw new ApiError(409,'STALE_CANVAS_SESSION','Project switched');}),rejected=expect(saving).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});
 await reading.promise;current=false;latest.resolve(reply(f.snapshot(),200,'"2"'));await rejected;
 expect(puts(f.transport)).toHaveLength(1);expect(f.storage.etags.get('p')).toBe('"1"');expect(f.storage.isBlocked('p')).toBe(true);expect(f.storage.draft('p')?.nodes[0].data.title).toBe('Frozen');
});

it('keeps execution projection-base and actual retry receipt semantics without submitting a model request',async()=>{
 const f=await setup(),observed=initial();observed.nodes[0].data.subType='TEXT_TEXT';f.storage.attachNativeView('p',observed);f.remote(running());
 const frozen=structuredClone(observed);frozen.nodes[0].data.title='Frozen title';frozen.nodes[0].data.subType='MULTIMODAL_TEXT';
 const projectionBase=vi.fn((base:NativeGraph,ack:NativeGraph)=>{const graph=structuredClone(base);delete graph.nodes[0].data.subType;if(Object.hasOwn(ack.nodes[0].data,'subType'))graph.nodes[0].data.subType=ack.nodes[0].data.subType;return graph;});
 const receipt=await f.storage.saveForExecution('p',frozen,()=>observed,()=>{},projectionBase);
 expect(projectionBase).toHaveBeenCalledTimes(1);expect(receipt.revision).toBe(3);expect(receipt.graph.nodes[0].data).toMatchObject({title:'Frozen title',subType:'MULTIMODAL_TEXT',status:'RUNNING',taskId:'task'});expect(f.storage.hasDraft('p')).toBe(false);expect(f.transport.mock.calls.some(([,init])=>init.method==='POST')).toBe(false);
});
