import {expect,it,vi} from 'vitest';
import {ApiClient} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
const project={id:'p',ownerId:'u',name:'Demo',revision:1,updatedAt:'2026-10-06T00:00:00Z'};
const node=(id:string,text=id)=>({id,type:'rh-text',position:{x:0,y:0},data:{text,title:id}});
const native=(nodes:any[]):NativeGraph=>({nodes,edges:[],viewport:{x:0,y:0,zoom:1}});
const reply=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',message:status<400?'OK':'conflict',data}),{status,headers:etag?{ETag:etag}:{}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
async function setup(initial=native([node('a')]),hook?:(path:string,init:any)=>Response|Promise<Response>|undefined){
 let revision=1,graph=encodeGraph(initial);
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt:project.updatedAt});
 const transport=vi.fn(async(path:string,init:any)=>{
  const custom=hook?.(path,init);if(custom)return custom;
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){if(init.headers.get('If-Match')!=='"'+revision+'"')return reply({},412);graph=JSON.parse(init.body).graph;revision++;}
   return reply(snapshot(),200,'"'+revision+'"');
  }
  if(path==='/api/v1/projects/p'||path==='/api/v1/projects/p/pin')return reply({...project,revision});
  throw new Error('Unexpected request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('current-user');const storage=new ServiceStorage(api,vi.fn());await storage.loadProject('p');
 return{storage,transport,snapshot,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return snapshot();}};
}
const puts=(transport:any)=>transport.mock.calls.filter(([path,init]:any[])=>path==='/api/v1/projects/p/snapshot'&&init.method==='PUT');

it('keeps unsaved differences bound to their original view across repeated remote applies',async()=>{
 const f=await setup(),first=f.storage.fixture('p');f.storage.attachNativeView('p',first);first.nodes[0].data.text='First unsaved';f.storage.observeNativeDraft('p',first);
 f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a'),node('remote')])),'"2"');
 const rendered=f.storage.mergedNativeView('p').graph;f.storage.remoteNativeViewApplied('p',rendered);rendered.nodes[0].data.text='Second unsaved';f.storage.observeNativeDraft('p',rendered);
 f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a')])),'"3"');const next=f.storage.mergedNativeView('p');
 expect(next.graph.nodes.map(value=>value.id)).toEqual(['a']);expect(next.graph.nodes[0].data.text).toBe('Second unsaved');expect(next.conflicts).toEqual([]);
 f.storage.remoteNativeViewApplied('p',next.graph);await f.storage.queueSave('p',next.graph);expect(f.current().nodes).toHaveLength(1);expect(f.current().nodes[0].data.text).toBe('Second unsaved');expect(f.storage.hasDraft('p')).toBe(false);
});

it('captures edits made while an unqueued draft is already in flight into a separate descendant',async()=>{
 const first=deferred<Response>(),started=deferred<void>();let saves=0,captured:any;
 const f=await setup(undefined,(path,init)=>{if(path.endsWith('/snapshot')&&init.method==='PUT'&&++saves===1){captured=JSON.parse(init.body).graph;started.resolve();return first.promise;}});
 const rendered=f.storage.fixture('p');f.storage.attachNativeView('p',rendered);rendered.nodes[0].data.text='First';f.storage.observeNativeDraft('p',rendered);const saving=f.storage.queueSave('p',rendered);await started.promise;
 rendered.nodes[0].data.text='During save';f.storage.observeNativeDraft('p',rendered);f.remote(decodeGraph(captured));first.resolve(reply(f.snapshot(),200,'"2"'));await saving;
 expect(f.storage.draft('p')?.nodes[0].data.text).toBe('During save');await f.storage.queueSave('p',rendered);expect(f.current().nodes[0].data.text).toBe('During save');expect(f.storage.hasDraft('p')).toBe(false);
});

it('bounds settled drafts across many remote applies without absorbing remote-only nodes',async()=>{
 const f=await setup();let rendered=f.storage.fixture('p');f.storage.attachNativeView('p',rendered);
 for(let index=0;index<40;index++){
  rendered.nodes[0].data.text='Local '+index;f.storage.observeNativeDraft('p',rendered);
  f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a'),node('remote-'+index)])));
  rendered=f.storage.mergedNativeView('p').graph;f.storage.remoteNativeViewApplied('p',rendered);
 }
 expect((f.storage as any).drafts.get('p').pending.length).toBeLessThanOrEqual(2);expect(rendered.nodes.map(value=>value.id)).toEqual(['a','remote-39']);expect(rendered.nodes[0].data.text).toBe('Local 39');expect(f.storage.isBlocked('p')).toBe(false);
 await f.storage.queueSave('p',rendered);expect(f.storage.hasDraft('p')).toBe(false);expect(f.current().nodes.map(value=>value.id)).toEqual(['a','remote-39']);
});

it.each([1,2])('keeps an ETag-only draft when its first full snapshot arrives at revision %s',async revision=>{
 const transport=vi.fn(async(_path:string,init:any)=>reply({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:project.updatedAt},200,'"2"'));
 const storage=new ServiceStorage(new ApiClient('/api/v1',transport),vi.fn());storage.etags.set('p','"1"');
 const queued=storage.queueSave('p',native([node('a','Local')]));
 const completed=revision===1?expect(queued).resolves.toBeUndefined():expect(queued).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision,graph:encodeGraph(native([node('a','Original')])),updatedAt:project.updatedAt},'"'+revision+'"');
 await completed;
 if(revision===1){expect(JSON.parse(transport.mock.calls[0][1].body).graph.nodes[0].data.text).toBe('Local');expect(storage.isBlocked('p')).toBe(false);}
 else{expect(transport).not.toHaveBeenCalled();expect(storage.draft('p')?.nodes[0].data.text).toBe('Local');}
});

it('serializes incremental local descendants against their own acknowledged revisions',async()=>{
 const f=await setup(),first=native([node('a','First')]),last=native([node('a','Last')]);
 const q1=f.storage.queueSave('p',first),q2=f.storage.queueSave('p',last);await Promise.all([q1,q2]);
 expect(puts(f.transport).map(([,init]:any[])=>init.headers.get('If-Match'))).toEqual(['"1"','"2"']);expect(f.current().nodes[0].data.text).toBe('Last');expect(f.storage.draft('p')).toBeUndefined();
});
it('rebases a queued save onto a remote addition before the queued request starts',async()=>{
 const f=await setup(),queued=f.storage.queueSave('p',native([node('a','Local')]));
 const merged=f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a'),node('b')])),'"2"');
 expect(merged.conflicts).toEqual([]);await queued;
 expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"2"');expect(f.current().nodes.map(row=>[row.id,row.data.text])).toEqual([['a','Local'],['b','b']]);
});
it('preserves unseen remote nodes across a fixture read and another edit from the old mounted native view',async()=>{
 const f=await setup(),view=f.storage.fixture('p');f.storage.attachNativeView('p',view);view.nodes[0].data.text='First';await f.storage.queueSave('p',view);
 f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a','First'),node('b')])),'"3"');
 expect(f.storage.fixture('p').nodes.map(row=>row.id)).toEqual(['a','b']);
 view.nodes[0].data.text='Second';await f.storage.queueSave('p',view);
 expect(f.current().nodes.map(row=>[row.id,row.data.text])).toEqual([['a','Second'],['b','b']]);
});
it('pauses same-field conflicts while retaining the newest local text and disjoint remote additions',async()=>{
 const f=await setup(),queued=f.storage.queueSave('p',native([node('a','Local')])),rejected=expect(queued).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 const accepted=f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a','Remote'),node('b')])),'"2"');
 expect(accepted.conflicts.length).toBeGreaterThan(0);await rejected;
 await expect(f.storage.queueSave('p',native([node('a','Latest local')]))).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 expect(puts(f.transport)).toHaveLength(0);expect(f.storage.draft('p')?.nodes.map(row=>[row.id,row.data.text])).toEqual([['a','Latest local'],['b','b']]);expect(f.current().nodes[0].data.text).toBe('Remote');
});
it('retains a local edit when a refreshed remote snapshot deleted that node',async()=>{
 const f=await setup(),queued=f.storage.queueSave('p',native([node('a','Keep me')])),rejected=expect(queued).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 f.storage.acceptRemoteSnapshot('p',f.remote(native([])),'"2"');await rejected;
 expect(f.storage.draft('p')?.nodes[0].data.text).toBe('Keep me');expect(f.current().nodes).toEqual([]);
});
it('recovers a stale graph from a complete snapshot instead of pairing it with a newer public ETag',async()=>{
 const f=await setup();f.remote(native([node('a'),node('b')]));f.storage.etags.set('p','"2"');
 await f.storage.queueSave('p',native([node('a','Local')]));
 expect(puts(f.transport).map(([,init]:any[])=>init.headers.get('If-Match'))).toEqual(['"1"','"2"']);expect(f.current().nodes.map(row=>[row.id,row.data.text])).toEqual([['a','Local'],['b','b']]);expect(f.storage.draft('p')).toBeUndefined();expect(f.storage.isBlocked('p')).toBe(false);
});
it('binds graph and revision after an asynchronous media preparation and concurrent project refresh',async()=>{
 const importing=deferred<Response>(),started=deferred<void>(),url='https://catalog.invalid/image.png';
 const asset={id:'asset',state:'READY',downloadUrl:'https://studio.invalid/asset',previewUrl:null};
 const f=await setup(undefined,(path)=>{if(path==='/api/v2/catalog/media/materialize'){started.resolve();return importing.promise;}if(path==='/api/v1/assets/asset')return reply(asset);});
 f.storage.registerCatalogMedia(url,{family:'characters',resourceId:'c',revision:1,path:'/images/0/url'});
 const local=native([{...node('a'),data:{text:'Local',params:{imageUrls:[url]}}}]),queued=f.storage.queueSave('p',local);await started.promise;
 f.remote(native([node('a'),node('b')]));await f.storage.loadProject('p');importing.resolve(reply({asset},201));await queued;
 expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"2"');expect(f.current().nodes.map(row=>row.id)).toEqual(['a','b']);expect(f.current().nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:asset']);
});
it('refreshes metadata’s real graph before sending an edit queued during the metadata request',async()=>{
 const mutation=deferred<Response>(),started=deferred<void>();
 const f=await setup(undefined,(path,init)=>{if(path==='/api/v1/projects/p/pin'&&init.method==='PUT'){started.resolve();return mutation.promise;}});
 const pin=f.storage.pin('p',true);await started.promise;
 const queued=f.storage.queueSave('p',native([node('a','Local')]));f.remote(native([node('a'),node('b')]));mutation.resolve(reply({...project,pinned:true,revision:2}));
 await Promise.all([pin,queued]);expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"2"');expect(f.current().nodes.map(row=>row.id)).toEqual(['a','b']);
});
it('keeps same-tab rename followed by adding a node coherent through its own revision event',async()=>{
 const f=await setup(),view=f.storage.fixture('p');f.storage.attachNativeView('p',view);await f.storage.rename('p','New name');view.meta={...view.meta,name:'New name'};view.nodes.push(node('added','After rename'));await f.storage.queueSave('p',view);const saved=f.snapshot();f.storage.acceptRemoteSnapshot('p',saved,'"'+saved.revision+'"');
 expect(f.storage.isBlocked('p')).toBe(false);expect(f.current().nodes.map(row=>row.id)).toEqual(['a','added']);expect(f.current().meta?.name).toBe('New name');expect(puts(f.transport)[0][1].headers.get('If-Match')).toBe('"1"');view.nodes[1].data.text='Continued';await f.storage.queueSave('p',view);expect(f.current().nodes[1].data.text).toBe('Continued');expect(f.storage.isBlocked('p')).toBe(false);
});
it('keeps a newer remote base when an older own save response arrives after it',async()=>{
 const response=deferred<Response>(),started=deferred<void>();let first=true,captured:any;
 const f=await setup(undefined,(path,init)=>{if(path.endsWith('/snapshot')&&init.method==='PUT'&&first){first=false;captured=JSON.parse(init.body).graph;started.resolve();return response.promise;}});
 const q1=f.storage.queueSave('p',native([node('a','First')])),q2=f.storage.queueSave('p',native([node('a','Second')]));await started.promise;
 f.remote(decodeGraph(captured));const newest=f.remote(native([node('a','First'),node('b')]));f.storage.acceptRemoteSnapshot('p',newest,'"3"');
 response.resolve(reply({projectId:'p',revision:2,graph:captured,updatedAt:project.updatedAt},200,'"2"'));await Promise.all([q1,q2]);
 expect(puts(f.transport)[1][1].headers.get('If-Match')).toBe('"3"');expect(f.current().nodes.map(row=>[row.id,row.data.text])).toEqual([['a','Second'],['b','b']]);expect(f.storage.etags.get('p')).toBe('"4"');
});
it('retries transient failed predecessor changes together with the next local edit using the original CAS',async()=>{
 let first=true;const f=await setup(undefined,(path,init)=>{if(path.endsWith('/snapshot')&&init.method==='PUT'&&first){first=false;return reply({},503);}});
 const q1=f.storage.queueSave('p',native([node('a','First')])),rejected=expect(q1).rejects.toMatchObject({status:503});
 const final=native([{...node('a','First'),data:{text:'First',title:'Latest title'}}]),q2=f.storage.queueSave('p',final);await rejected;await q2;
 expect(puts(f.transport).map(([,init]:any[])=>init.headers.get('If-Match'))).toEqual(['"1"','"1"']);expect(f.current().nodes[0].data).toEqual({text:'First',title:'Latest title'});expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.draft('p')).toBeUndefined();
});
it('retains the complete local draft if the successful HTTP response has inconsistent version metadata',async()=>{
 const f=await setup(undefined,(path,init)=>path.endsWith('/snapshot')&&init.method==='PUT'?reply({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:project.updatedAt},200,'"3"'):undefined);
 await expect(f.storage.queueSave('p',native([node('a','Keep local')]))).rejects.toMatchObject({code:'SNAPSHOT_REVISION_MISMATCH'});
 expect(f.storage.draft('p')?.nodes[0].data.text).toBe('Keep local');expect(f.storage.etags.get('p')).toBe('"1"');expect(f.storage.isBlocked('p')).toBe(true);
});
it('rejects inconsistent remote ETags before changing any acknowledged graph or queue',async()=>{
 const f=await setup(),before=f.storage.snapshots.get('p');
 expect(()=>f.storage.acceptRemoteSnapshot('p',{...f.snapshot(),revision:2,graph:encodeGraph(native([node('b')]))},'"3"')).toThrow('同步内容尚未确认');
 expect(f.storage.snapshots.get('p')).toEqual(before);expect(f.storage.etags.get('p')).toBe('"1"');expect(f.storage.isBlocked('p')).toBe(false);
});
it('keeps legacy recovered model bindings outside raw acknowledged snapshots through metadata refresh',async()=>{
 const initial=native([{...node('a'),data:{modelCode:'M',taskId:'t'}}]);
 const f=await setup(initial,path=>path==='/api/v2/tasks/t'?reply({id:'t',projectId:'p',plans:[{nodeId:'a',capabilityRef:'M',capabilityVersion:'1'}]}):path.startsWith('/api/v2/model-capability-version?')?reply({capabilityRef:'M',version:'1',parameterSchemaVersion:'1'}):undefined);
 expect(f.storage.snapshots.get('p')?.graph.nodes[0].data.capabilityVersion).toBeUndefined();await f.storage.pin('p',true);expect(f.storage.fixture('p').nodes[0].data.capabilityVersion).toBe('1');
});
it('refreshes exact remote model sidecars without making a stale native title edit revert the model version',async()=>{
 const initial=native([{...node('a'),data:{title:'a',modelCode:'M',capabilityRef:'M',capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'same'}}}]),f=await setup(initial),view=f.storage.fixture('p');
 for(const key of ['capabilityRef','capabilityVersion','parameterSchemaVersion'])delete view.nodes[0].data[key];f.storage.attachNativeView('p',view);
 const remote=structuredClone(initial);remote.nodes[0].data.capabilityVersion='2';remote.nodes[0].data.parameterSchemaVersion='2';f.storage.acceptRemoteSnapshot('p',f.remote(remote),'"2"');
 expect(f.storage.restoreModelBindings('p',view).nodes[0].data.capabilityVersion).toBe('2');view.nodes[0].data.title='Local title';await f.storage.queueSave('p',view);
 expect(f.current().nodes[0].data).toMatchObject({title:'Local title',capabilityVersion:'2',parameterSchemaVersion:'2'});
});
it('clears only successfully acknowledged local model selections so later remote versions can refresh sidecars',async()=>{
 const initial=native([{...node('a'),data:{modelCode:'M',capabilityRef:'M',capabilityVersion:'1',parameterSchemaVersion:'1'}}]),f=await setup(initial),view=f.storage.fixture('p');
 for(const key of ['capabilityRef','capabilityVersion','parameterSchemaVersion'])delete view.nodes[0].data[key];f.storage.attachNativeView('p',view);f.storage.rememberModelBinding('p',view.nodes[0],initial.nodes[0].data);await f.storage.queueSave('p',view);
 const remote=structuredClone(initial);remote.nodes[0].data.capabilityVersion='2';remote.nodes[0].data.parameterSchemaVersion='2';f.storage.acceptRemoteSnapshot('p',f.remote(remote),'"3"');expect(f.storage.restoreModelBindings('p',view).nodes[0].data.capabilityVersion).toBe('2');
});
it('does not restore a project cache from a load response returned after that project was deleted',async()=>{
 const late=deferred<Response>();let delayed=false;
 const f=await setup(undefined,(path,init)=>delayed&&path==='/api/v1/projects/p'&&init.method==='GET'?late.promise:undefined);
 delayed=true;const loading=f.storage.loadProject('p'),rejected=expect(loading).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});await f.storage.delete('p');late.resolve(reply(project));await rejected;
 expect(f.storage.projects.size).toBe(0);expect(f.storage.snapshots.size).toBe(0);expect(f.storage.etags.size).toBe(0);
});
it('requires an explicit settled discard to resume after a conflict and keeps the remote graph',async()=>{
 const f=await setup(),queued=f.storage.queueSave('p',native([node('a','Local')])),rejected=expect(queued).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a','Remote')])),'"2"');
 expect(()=>f.storage.discardDraft('p')).toThrow('当前保存');await rejected;f.storage.discardDraft('p');expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.fixture('p').nodes[0].data.text).toBe('Remote');
});
it('refreshes the accepted newer remote binding when a saved local selection is acknowledged out of order',async()=>{
 const response=deferred<Response>(),started=deferred<void>();let captured:any;
 const initial=native([{...node('a'),data:{modelCode:'M',capabilityRef:'M',capabilityVersion:'1',parameterSchemaVersion:'1'}}]);
 const f=await setup(initial,(path,init)=>{if(path.endsWith('/snapshot')&&init.method==='PUT'){captured=JSON.parse(init.body).graph;started.resolve();return response.promise;}}),view=f.storage.fixture('p');
 for(const key of ['capabilityRef','capabilityVersion','parameterSchemaVersion'])delete view.nodes[0].data[key];f.storage.attachNativeView('p',view);f.storage.rememberModelBinding('p',view.nodes[0],initial.nodes[0].data);
 const queued=f.storage.queueSave('p',view);await started.promise;f.remote(decodeGraph(captured));const remote=structuredClone(initial);remote.nodes[0].data.capabilityVersion='2';remote.nodes[0].data.parameterSchemaVersion='2';f.storage.acceptRemoteSnapshot('p',f.remote(remote),'"3"');
 response.resolve(reply({projectId:'p',revision:2,graph:captured,updatedAt:project.updatedAt},200,'"2"'));await queued;
 expect(f.storage.etags.get('p')).toBe('"3"');expect(f.storage.restoreModelBindings('p',view).nodes[0].data.capabilityVersion).toBe('2');expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.draft('p')).toBeUndefined();
});
it('coalesces prolonged blocked typing into a bounded retained draft and never writes it',async()=>{
 const f=await setup(),queued=f.storage.queueSave('p',native([node('a','Local')])),rejected=expect(queued).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});f.storage.acceptRemoteSnapshot('p',f.remote(native([node('a','Remote')])),'"2"');await rejected;
 for(let i=0;i<100;i++)await expect(f.storage.queueSave('p',native([node('a','Local '+i)]))).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 expect(f.storage.draft('p')?.nodes[0].data.text).toBe('Local 99');expect((f.storage as any).drafts.get('p').pending.length).toBeLessThanOrEqual(2);expect(puts(f.transport)).toHaveLength(0);
});
it('bounds repeated transient failed saves and later retries their complete latest draft',async()=>{
 let failing=true;const f=await setup(undefined,(path,init)=>failing&&path.endsWith('/snapshot')&&init.method==='PUT'?reply({},503):undefined);
 for(let i=0;i<20;i++)await expect(f.storage.queueSave('p',native([node('a','Local '+i)]))).rejects.toMatchObject({status:503});
 expect((f.storage as any).drafts.get('p').pending.length).toBeLessThanOrEqual(2);expect(f.storage.draft('p')?.nodes[0].data.text).toBe('Local 19');failing=false;await f.storage.queueSave('p',native([node('a','Local 19')]));expect(f.current().nodes[0].data.text).toBe('Local 19');expect(f.storage.draft('p')).toBeUndefined();
});
it('keeps local media preflight failure in the immediate save barrier so execution cannot use an older graph',async()=>{
 const f=await setup(),invalid=native([{...node('a'),data:{url:'blob:unuploaded'}}]);
 const queued=f.storage.queueSave('p',invalid),barrier=f.storage.wait('p');expect(barrier).toBe(queued);
 await Promise.all([expect(queued).rejects.toThrow('未上传'),expect(barrier).rejects.toThrow('未上传')]);expect(puts(f.transport)).toHaveLength(0);
});
it('keeps a missing-version preflight failure in the immediate save barrier',async()=>{
 const storage=new ServiceStorage(new ApiClient('/api/v1',vi.fn()),vi.fn()),queued=storage.queueSave('p',native([])),barrier=storage.wait('p');expect(barrier).toBe(queued);
 await Promise.all([expect(queued).rejects.toThrow('画布还在加载'),expect(barrier).rejects.toThrow('画布还在加载')]);
});
