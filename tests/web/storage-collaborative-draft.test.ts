import {expect,it,vi} from 'vitest';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {DraftJournal} from '../../apps/web/src/service/draft-journal';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';
import {MemoryDraftStorage} from './draft-journal-fixture';

const node=(id:string,text=id)=>({id,type:'rh-text',position:{x:0,y:0},data:{text,title:id}});
const graph=(nodes=[node('a'),node('b')]):NativeGraph=>({nodes,edges:[]});
const updatedAt='2026-11-02T12:00:00Z';
const reply=(data:any,status=200,etag?:string,code='VERSION_CONFLICT')=>new Response(JSON.stringify({code:status<400?0:code,message:status<400?'OK':code,data}),{status,headers:etag?{ETag:etag}:{}});
function server(initial=graph()){
 let current=encodeGraph(initial),revision=1;let hook:((method:string,body:any)=>Response|Promise<Response>|undefined)|undefined;
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(current),updatedAt});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p/snapshot'){
   const custom=hook?.(init.method??'GET',init.body?JSON.parse(init.body):undefined);if(custom)return custom;
   if(init.method==='PUT'){if(init.headers.get('If-Match')!=='"'+revision+'"')return reply({},412);current=JSON.parse(init.body).graph;revision++;}
   return reply(snapshot(),200,'"'+revision+'"');
  }
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'owner',name:'Project',revision,updatedAt});
  if(path==='/api/v2/collaboration/projects/p/access')return reply(verifiedAccess('p','EDITOR','owner'));
  throw new Error('Unexpected fixture request '+path);
 });
 return{transport,snapshot,read:()=>decodeGraph(current),remote:(next:NativeGraph)=>{current=encodeGraph(next);revision++;return snapshot();},hook:(fn:typeof hook)=>{hook=fn;}};
}
async function page(s:ReturnType<typeof server>,user='alice',disk=new MemoryDraftStorage()){
 const api=new ProductClient('/api/v1',s.transport);api.setAccessToken('fixture-only-'+user);
 const storage=new ServiceStorage(api,vi.fn(),()=>user,new DraftJournal(()=>disk));await storage.loadProject('p');
 const native=storage.fixture('p');storage.attachNativeView('p',native);return{storage,native,disk};
}
const puts=(s:ReturnType<typeof server>)=>s.transport.mock.calls.filter(([path,init])=>path.endsWith('/snapshot')&&init.method==='PUT');
const accept=(p:Awaited<ReturnType<typeof page>>,s:ReturnType<typeof server>)=>p.storage.acceptRemoteSnapshot('p',s.snapshot(),'"'+s.snapshot().revision+'"');

it.each(['alice','bob'])('saves disjoint nodes from two simultaneous tabs with second identity %s',async secondUser=>{
 const s=server(),disk=new MemoryDraftStorage(),a=await page(s,'alice',disk),b=await page(s,secondUser,disk);
 a.native.nodes[0].data.text='Alice edited A';b.native.nodes[1].data.text='Other tab edited B';
 a.storage.captureDraft('p',a.native);b.storage.captureDraft('p',b.native);
 await Promise.all([a.storage.queueSave('p',a.native),b.storage.queueSave('p',b.native)]);
 expect(s.read().nodes.map(row=>row.data.text)).toEqual(['Alice edited A','Other tab edited B']);
 expect([a.storage.isBlocked('p'),b.storage.isBlocked('p')]).toEqual([false,false]);
 expect([a.storage.hasDraft('p'),b.storage.hasDraft('p')]).toEqual([false,false]);
 expect(puts(s)).toHaveLength(3);expect(s.transport.mock.calls.every(([,init])=>init.method!=='POST')).toBe(true);
});

it('keeps independent pan and zoom from blocking two editors saving different nodes',async()=>{
 const s=server(),a=await page(s),b=await page(s,'bob');
 a.native.viewport={x:100,y:0,zoom:1};b.native.viewport={x:-500,y:50,zoom:.8};a.native.nodes[0].data.text='Alice edited A';b.native.nodes[1].data.text='Bob edited B';
 await Promise.all([a.storage.queueSave('p',a.native),b.storage.queueSave('p',b.native)]);
 expect(s.read().nodes.map(row=>row.data.text)).toEqual(['Alice edited A','Bob edited B']);expect(b.storage.isBlocked('p')).toBe(false);
 expect(a.storage.fixture('p').viewport).toEqual({x:100,y:0,zoom:1});expect(b.storage.fixture('p').viewport).toEqual({x:-500,y:50,zoom:.8});
});

it('does not persist pan-only autosaves or replace the first stored viewport',async()=>{
 const s=server(),a=await page(s),original=s.read().viewport;
 for(let step=1;step<=3;step++){a.native.viewport={x:100*step,y:20,zoom:.8};a.native.meta={...a.native.meta,viewport:a.native.viewport};a.storage.captureDraft('p',a.native);await a.storage.queueSave('p',a.native);}
 expect(puts(s)).toHaveLength(0);expect(a.storage.hasDraft('p')).toBe(false);expect(s.read().viewport).toEqual(original);expect(a.storage.fixture('p').viewport).toEqual({x:300,y:20,zoom:.8});
 const legacy=s.read();legacy.viewport={x:900,y:300,zoom:2};legacy.nodes[1].data.text='Legacy remote update';s.remote(legacy);accept(a,s);
 expect(a.storage.fixture('p').viewport).toEqual({x:300,y:20,zoom:.8});expect(a.storage.fixture('p').nodes[1].data.text).toBe('Legacy remote update');expect(a.storage.isBlocked('p')).toBe(false);
});

it('still preserves a real node coordinate conflict while each page has its own viewport',async()=>{
 const s=server(),a=await page(s),b=await page(s,'bob');a.native.viewport={x:100,y:0,zoom:1};b.native.viewport={x:-500,y:50,zoom:.8};a.native.nodes[0].position.x=10;b.native.nodes[0].position.x=20;
 await a.storage.queueSave('p',a.native);await expect(b.storage.queueSave('p',b.native)).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 expect(b.storage.draftConflictDetails('p')).toContainEqual({path:'/nodes/a/position',reason:'FIELD_CHANGED',localValue:{x:20,y:0},serverValue:{x:10,y:0}});expect(b.storage.fixture('p').viewport).toEqual({x:-500,y:50,zoom:.8});
});

it('keeps a real same-field conflict and the latest local value through further unrelated writes',async()=>{
 const s=server(),a=await page(s),b=await page(s,'bob');a.native.nodes[0].data.text='Alice text';b.native.nodes[0].data.text='Bob text';await b.storage.queueSave('p',b.native);
 await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 a.native.nodes[1].data.title='Unrelated local title';a.storage.captureDraft('p',a.native);
 const remote=s.read();remote.nodes[1].data.text='Unrelated remote text';s.remote(remote);accept(a,s);
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'MERGE_CONFLICT',persistence:'saved'});
 expect(a.storage.draftConflictDetails('p')).toContainEqual({path:'/nodes/a/data/text',reason:'FIELD_CHANGED',localValue:'Alice text',serverValue:'Bob text'});
 expect(a.storage.draft('p')!.nodes[1].data).toMatchObject({title:'Unrelated local title',text:'Unrelated remote text'});
 expect(s.read().nodes[0].data.text).toBe('Bob text');
});

it('automatically releases a known-base conflict when a new coherent server snapshot converges',async()=>{
 const s=server(),a=await page(s),b=await page(s,'bob');a.native.nodes[0].data.text='Converged';b.native.nodes[0].data.text='Other';await b.storage.queueSave('p',b.native);
 await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 const remote=s.read();remote.nodes[0].data.text='Converged';Object.assign(remote.nodes[1].data,{status:'finished',taskId:'existing-task'});remote.nodes.push(node('server-only'));s.remote(remote);accept(a,s);
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:false,conflicts:[]});
 await a.storage.queueSave('p',a.native);expect(a.storage.hasDraft('p')).toBe(false);expect(s.read().nodes.map(row=>row.id)).toEqual(['a','b','server-only']);expect(s.read().nodes[1].data.taskId).toBe('existing-task');
});

it('releases an undone same-field edit after remote view application without dropping other local or server changes',async()=>{
 const s=server(),a=await page(s),b=await page(s,'bob');a.native.nodes[0].data.text='First local';a.storage.captureDraft('p',a.native);
 b.native.nodes[0].data.text='Remote text';b.native.nodes.push(node('server-only'));await b.storage.queueSave('p',b.native);accept(a,s);
 const rendered=a.storage.mergedNativeView('p').graph;a.storage.remoteNativeViewApplied('p',rendered);
 rendered.nodes[0].data.text='a';rendered.nodes[1].data.title='Local title';a.storage.captureDraft('p',rendered);
 expect(a.storage.isBlocked('p')).toBe(false);expect(a.storage.draft('p')!.nodes[0].data.text).toBe('Remote text');
 await a.storage.queueSave('p',rendered);expect(s.read().nodes[0].data.text).toBe('Remote text');expect(s.read().nodes[1].data.title).toBe('Local title');expect(s.read().nodes.some(row=>row.id==='server-only')).toBe(true);
});

it('resumes the same save call when a failed edit is undone while already blocked',async()=>{
 const s=server(),a=await page(s),remote=s.read();remote.nodes[0].data.text='Remote';s.remote(remote);a.native.nodes[0].data.text='Local';
 await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 a.native.nodes[0].data.text='a';await a.storage.queueSave('p',a.native);
 expect(a.storage.isBlocked('p')).toBe(false);expect(a.storage.hasDraft('p')).toBe(false);expect(s.read().nodes[0].data.text).toBe('Remote');
});

it('requires fresh strictly newer proof after exhausted CAS retries, then keeps execution writeback and editing enabled',async()=>{
 const s=server(),a=await page(s);let attempts=0;
 s.hook(method=>{if(method!=='PUT')return;attempts++;const remote=s.read();Object.assign(remote.nodes[1].data,{taskId:'task',status:'running',progress:attempts*20});s.remote(remote);return reply({},412);});
 a.native.nodes[0].data.text='Retain through execution';await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({status:412});
 expect(attempts).toBe(3);expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'CAS_UNCERTAIN'});
 a.native.nodes[0].data.text='a';a.storage.captureDraft('p',a.native);a.storage.mergedNativeView('p');expect(a.storage.isBlocked('p')).toBe(true);
 const old=a.storage.snapshots.get('p')!;a.storage.acceptRemoteSnapshot('p',old,'"'+old.revision+'"');expect(a.storage.isBlocked('p')).toBe(true);
 s.hook(undefined);const completed=s.read();Object.assign(completed.nodes[1].data,{status:'finished',progress:100,output:[{outputType:'text',text:'Existing task output'}]});s.remote(completed);accept(a,s);
 expect(a.storage.isBlocked('p')).toBe(false);a.native.nodes[0].data.text='Continue';await a.storage.queueSave('p',a.native);
 expect(s.read().nodes[0].data.text).toBe('Continue');expect(s.read().nodes[1].data).toMatchObject({taskId:'task',status:'finished',output:[{outputType:'text',text:'Existing task output'}]});expect(a.storage.hasDraft('p')).toBe(false);
});

it('does not release an uncertain CAS lock through a failed recovery read, local convergence, or an unchanged snapshot',async()=>{
 const s=server(),a=await page(s),old=s.snapshot(),remote=s.read();remote.nodes[1].data.status='running';s.remote(remote);
 s.hook(method=>method!=='PUT'?reply({},503):undefined);a.native.nodes[0].data.text='Local';await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({status:503});
 a.native.nodes[0].data.text='a';a.storage.captureDraft('p',a.native);a.storage.acceptRemoteSnapshot('p',old,'"1"');expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'CAS_UNCERTAIN'});
 s.hook(undefined);accept(a,s);expect(a.storage.isBlocked('p')).toBe(false);await a.storage.queueSave('p',a.native);expect(s.read().nodes[1].data.status).toBe('running');
});

it('requires a coherent snapshot at least as new as every valid revision claimed by a mismatched successful response',async()=>{
 const s=server(),a=await page(s);s.hook((method,body)=>method==='PUT'?reply({projectId:'p',revision:2,graph:body.graph,updatedAt},200,'"3"'):undefined);
 a.native.nodes[0].data.text='Keep local';await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({code:'SNAPSHOT_REVISION_MISMATCH'});
 s.hook(undefined);s.remote(s.read());accept(a,s);expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'CAS_UNCERTAIN'});
 const latest=s.read();latest.nodes[1].data.title='Unrelated remote';s.remote(latest);accept(a,s);expect(a.storage.isBlocked('p')).toBe(false);
 await a.storage.queueSave('p',a.native);expect(s.read().nodes[0].data.text).toBe('Keep local');expect(s.read().nodes[1].data.title).toBe('Unrelated remote');
});

it('retains an explicit unknown-base decision even when the imported graph equals the server',async()=>{
 const s=server(),a=await page(s),file={format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId:'alice',projectId:'p',createdAt:updatedAt,updatedAt,graph:s.read()};
 await a.storage.importDraft('p',JSON.stringify(file));s.remote(s.read());accept(a,s);a.storage.captureDraft('p',a.storage.fixture('p'));
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'BASE_UNKNOWN',conflicts:expect.arrayContaining([{path:'/',reason:'BASE_UNKNOWN'}])});
 await expect(a.storage.queueSave('p',a.storage.fixture('p'))).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});expect(puts(s)).toHaveLength(0);
});

it('keeps emergency upload memory and text backups when a separate known-base conflict converges',async()=>{
 const s=server(),a=await page(s),remote=s.read();remote.nodes[0].data.text='Remote';s.remote(remote);a.native.nodes[0].data.text='Local';await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 a.native.nodes[1].data.text='Text beside upload';a.native.nodes.push({id:'upload',type:'rh-image',position:{x:0,y:0},data:{imageUrl:'blob:https://fixture.invalid/pending'}});a.storage.captureDraft('p',a.native);
 const converged=s.read();converged.nodes[0].data.text='Local';s.remote(converged);accept(a,s);
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'memory-only'});expect(a.storage.hasDraft('p')).toBe(true);expect(a.storage.draft('p')!.nodes[1].data.text).toBe('Text beside upload');
 const exported=JSON.parse(a.storage.exportDraft('p'));expect(exported.unresolvedMedia).toBe(1);expect(exported.graph.nodes[1].data.text).toBe('Text beside upload');expect(JSON.stringify(exported)).not.toContain('blob:');
 await expect(a.storage.resolveDraft('p',{})).rejects.toMatchObject({code:'DRAFT_MEDIA_PENDING'});
});

it('treats a node lease rejection as retryable and preserves bounded pending edits until release',async()=>{
 const s=server(),a=await page(s);s.hook(method=>method==='PUT'?reply({},409,undefined,'NODE_EDIT_OCCUPIED'):undefined);
 for(let i=0;i<10;i++){a.native.nodes[0].data.text='Waiting local '+i;await expect(a.storage.queueSave('p',a.native)).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});}
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'saved',retryableError:{code:'NODE_EDIT_OCCUPIED'}});expect((a.storage as any).drafts.get('p').pending.length).toBeLessThanOrEqual(2);expect(s.read().nodes[0].data.text).toBe('a');
 const remote=s.read();remote.nodes[1].data.text='Other editor';s.remote(remote);s.hook(undefined);await a.storage.queueSave('p',a.native);
 expect(s.read().nodes.map(row=>row.data.text)).toEqual(['Waiting local 9','Other editor']);expect(a.storage.draftRecoveryState('p').retryableError).toBeUndefined();expect(a.storage.hasDraft('p')).toBe(false);
});

it('does not drop the coupled group conflict merely because the unchanged child equals its old baseline',async()=>{
 const initial=graph([{...node('group'),type:'group',data:{nodeIds:['a']}},{...node('a'),parentId:'group'}]),s=server(initial),a=await page(s),remote=s.read();
 a.native.nodes[0].position.x=500;a.storage.captureDraft('p',a.native);remote.nodes[1].position.x=20;s.remote(remote);accept(a,s);
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:true,conflicts:expect.arrayContaining([{path:'/nodes/a/position',reason:'GROUP_POSITION'}])});expect(a.storage.draft('p')!.nodes[0].position.x).toBe(500);
});

it('retains the distinct base of edits to a remotely added node while compacting settled local history',async()=>{
 const s=server(),a=await page(s);a.native.nodes[0].data.text='Original local edit';a.storage.captureDraft('p',a.native);
 const remote=s.read();remote.nodes.push(node('new','Remote created'));s.remote(remote);accept(a,s);
 let rendered=a.storage.mergedNativeView('p').graph;a.storage.remoteNativeViewApplied('p',rendered);rendered.nodes.find(row=>row.id==='new')!.data.text='Edited remote node';a.storage.captureDraft('p',rendered);
 rendered=a.storage.mergedNativeView('p').graph;a.storage.remoteNativeViewApplied('p',rendered);rendered.nodes[1].data.title='Later local title';a.storage.captureDraft('p',rendered);
 expect(a.storage.draftRecoveryState('p')).toMatchObject({blocked:false,conflicts:[]});await a.storage.queueSave('p',rendered);
 expect(s.read().nodes.map(row=>row.data.text)).toEqual(['Original local edit','b','Edited remote node']);expect(s.read().nodes[1].data.title).toBe('Later local title');
});

it('retains a genuine conflict on a remotely added node through later history compaction',async()=>{
 const s=server(),a=await page(s);a.native.nodes[0].data.text='Original local edit';a.storage.captureDraft('p',a.native);
 const remote=s.read();remote.nodes.push(node('new','Remote created'));s.remote(remote);accept(a,s);
 let rendered=a.storage.mergedNativeView('p').graph;a.storage.remoteNativeViewApplied('p',rendered);rendered.nodes.find(row=>row.id==='new')!.data.text='My edit';a.storage.captureDraft('p',rendered);
 const next=s.read();next.nodes.find(row=>row.id==='new')!.data.text='Other editor';s.remote(next);accept(a,s);rendered=a.storage.mergedNativeView('p').graph;a.storage.remoteNativeViewApplied('p',rendered);
 rendered.nodes[1].data.title='Unrelated local title';a.storage.captureDraft('p',rendered);
 expect(a.storage.draftConflictDetails('p')).toContainEqual({path:'/nodes/new/data/text',reason:'FIELD_CHANGED',localValue:'My edit',serverValue:'Other editor'});expect(a.storage.isBlocked('p')).toBe(true);
});
