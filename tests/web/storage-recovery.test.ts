import {expect,it,vi} from 'vitest';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {DraftJournal} from '../../apps/web/src/service/draft-journal';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';
import {MemoryDraftStorage} from './draft-journal-fixture';

const node=(id:string,text=id)=>({id,type:'rh-text',position:{x:0,y:0},data:{text,title:id}});
const graph=(nodes:any[]):NativeGraph=>({nodes,edges:[],viewport:{x:0,y:0,zoom:1}});
const response=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:status<400?0:status,error:status<400?undefined:{code:'VERSION_CONFLICT',message:'fixture conflict'},data}),{status,headers:etag?{ETag:etag}:{}});
function server(initial=graph([node('a','base')])){
 let revision=1,current=encodeGraph(initial),role:'OWNER'|'VIEWER'='OWNER';let beforePut:undefined|((body:any)=>Response|Promise<Response>|undefined);
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){
    const hooked=beforePut?.(JSON.parse(init.body));if(hooked)return hooked;
    if(init.headers.get('If-Match')!=='"'+revision+'"')return response({},412);current=JSON.parse(init.body).graph;revision++;
   }
   return response({projectId:'p',revision,graph:structuredClone(current),updatedAt:'2026-11-02T00:00:00Z'},200,'"'+revision+'"');
  }
  if(path==='/api/v1/projects/p')return response({id:'p',ownerId:'u',name:'Project',revision,updatedAt:'2026-11-02T00:00:00Z'});
  if(path==='/api/v2/collaboration/projects/p/access')return response(verifiedAccess('p',role,'u'));
  throw new Error('Unexpected fixture request '+path);
 });
 return{transport,get:()=>decodeGraph(current),remote:(next:NativeGraph)=>{current=encodeGraph(next);revision++;},setRole:(next:'OWNER'|'VIEWER')=>{role=next;},hook:(fn:typeof beforePut)=>{beforePut=fn;}};
}
async function client(s:ReturnType<typeof server>,disk:MemoryDraftStorage,user='u'){
 let identity=user;const api=new ProductClient('/api/v1',s.transport);api.setAccessToken('fixture-only');
 const storage=new ServiceStorage(api,vi.fn(),()=>identity,new DraftJournal(()=>disk));await storage.loadProject('p');
 const native=storage.fixture('p');storage.attachNativeView('p',native);
 return{storage,native,identity:(next:string)=>{identity=next;}};
}
const changes=(storage:ServiceStorage)=>Object.fromEntries(storage.draftConflictDetails('p').map(row=>[row.path,'local' as const]));
const puts=(s:ReturnType<typeof server>)=>s.transport.mock.calls.filter(([path,init])=>path.endsWith('/snapshot')&&init.method==='PUT');

it('recovers after a fresh page instance and retains a new local node plus remote generation writeback',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);a.native.nodes.push(node('new','not yet saved'));a.storage.captureDraft('p',a.native);
 expect(a.storage.draftRecoveryState('p')).toMatchObject({persistence:'saved',backups:[{currentPage:true}]});
 const remote=s.get();Object.assign(remote.nodes[0].data,{status:'finished',taskId:'task',output:[{assetId:'asset',outputType:'text',text:'generated'}]});s.remote(remote);
 const b=await client(s,disk);b.storage.refreshDraftBackups('p');const backup=b.storage.draftRecoveryState('p').backups[0];expect(backup.currentPage).toBe(false);
 const restored=await b.storage.restoreDraft('p',backup.id);expect(restored.conflicts).toEqual([]);expect(restored.graph.nodes.map(row=>row.id)).toEqual(['a','new']);expect(restored.graph.nodes[0].data.taskId).toBe('task');
 b.storage.remoteNativeViewApplied('p',restored.graph);await b.storage.resolveDraft('p',{});
 expect(s.get().nodes.map(row=>row.id)).toEqual(['a','new']);expect(b.storage.hasDraft('p')).toBe(false);expect(b.storage.isBlocked('p')).toBe(false);
 const c=await client(s,disk);c.storage.refreshDraftBackups('p');expect(c.storage.draftRecoveryState('p').backups).toEqual([]);
});
it('keeps two pages separate, requires a same-field decision and preserves unrelated remote additions',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk),b=await client(s,disk);
 a.native.nodes[0].data.text='page A';a.storage.captureDraft('p',a.native);b.native.nodes.push(node('new','page B node'));b.storage.captureDraft('p',b.native);
 b.storage.refreshDraftBackups('p');expect(b.storage.draftRecoveryState('p').backups).toHaveLength(2);
 s.remote(graph([node('a','remote'),node('remote-only')]));
 const restored=await a.storage.restoreDraft('p',a.storage.draftRecoveryState('p').backups[0].id);
 expect(restored.conflicts).toContainEqual({path:'/nodes/a/data/text',reason:'FIELD_CHANGED'});expect(a.storage.draftConflictDetails('p')[0]).toMatchObject({localValue:'page A',serverValue:'remote'});
 const saved=await a.storage.resolveDraft('p',changes(a.storage));expect(saved.nodes[0].data.text).toBe('page A');expect(saved.nodes.some(row=>row.id==='remote-only')).toBe(true);
 b.storage.refreshDraftBackups('p');expect(b.storage.draftRecoveryState('p').backups.some(row=>row.currentPage)).toBe(true);
});
it('leaves both local edits and new remote fields intact on a CAS race and requires renewed decisions',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);a.native.nodes[0].data.text='local';a.storage.captureDraft('p',a.native);
 s.remote(graph([node('a','remote')]));a.storage.refreshDraftBackups('p');await a.storage.restoreDraft('p',a.storage.draftRecoveryState('p').backups[0].id);
 s.hook(()=>{s.hook(undefined);const next=s.get();next.nodes.push(node('arrived-during-save'));s.remote(next);return response({},412);});
 await expect(a.storage.resolveDraft('p',changes(a.storage))).rejects.toMatchObject({code:'DRAFT_REMOTE_CHANGED'});
 expect(a.storage.draft('p')!.nodes[0].data.text).toBe('local');expect(a.storage.draft('p')!.nodes.some(row=>row.id==='arrived-during-save')).toBe(true);expect(s.get().nodes[0].data.text).toBe('remote');
 await a.storage.resolveDraft('p',changes(a.storage));expect(s.get().nodes[0].data.text).toBe('local');expect(s.get().nodes.some(row=>row.id==='arrived-during-save')).toBe(true);
});
it('retains edits captured while recovery is saving as a pending descendant',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);a.native.nodes[0].data.text='first';a.storage.captureDraft('p',a.native);
 let finish!:(value:Response)=>void,submitted:any;const started=vi.fn();s.hook(body=>{submitted=body;started();return new Promise(resolve=>{finish=resolve;});});
 const saving=a.storage.resolveDraft('p',{});await vi.waitFor(()=>expect(started).toHaveBeenCalled());
 const next=a.storage.fixture('p');next.nodes.push(node('during-save'));a.storage.captureDraft('p',next);s.hook(undefined);s.remote(decodeGraph(submitted.graph));
 finish(response({projectId:'p',revision:2,graph:submitted.graph,updatedAt:'2026-11-02T00:00:00Z'},200,'"2"'));await saving;
 expect(a.storage.draft('p')!.nodes.some(row=>row.id==='during-save')).toBe(true);await a.storage.resolveDraft('p',changes(a.storage));expect(s.get().nodes.some(row=>row.id==='during-save')).toBe(true);
});
it('keeps an immutable pre-decision backup if the page disappears during the save request',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);a.native.nodes[0].data.text='precious local';a.storage.captureDraft('p',a.native);
 s.remote(graph([node('a','server')]));a.storage.refreshDraftBackups('p');await a.storage.restoreDraft('p',a.storage.draftRecoveryState('p').backups.find(row=>row.currentPage)!.id);
 let finish!:(value:Response)=>void;const started=vi.fn();s.hook(()=>new Promise(resolve=>{finish=resolve;started();}));
 const choices=Object.fromEntries(a.storage.draftConflictDetails('p').map(row=>[row.path,'server' as const])),saving=a.storage.resolveDraft('p',choices);await vi.waitFor(()=>expect(started).toHaveBeenCalled());
 const afterCrash=new DraftJournal(()=>disk).list('u','p');expect(afterCrash.some(row=>row.graph.nodes[0].data.text==='precious local')).toBe(true);
 finish(response({},503));await expect(saving).rejects.toBeInstanceOf(Error);expect(a.storage.draft('p')!.nodes[0].data.text).toBe('precious local');
});
it('exports on storage failure, expires that confirmation after editing, and never claims failed persistence was saved',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);disk.fail=true;a.native.nodes[0].data.text='local';a.storage.captureDraft('p',a.native);
 expect(a.storage.draftRecoveryState('p').persistence).toBe('memory-only');const exported=a.storage.exportDraft('p');expect(JSON.parse(exported).graph.nodes[0].data.text).toBe('local');
 a.native.nodes[0].data.text='later';a.storage.captureDraft('p',a.native);
 await expect(a.storage.resolveDraft('p',{}, {exportedBackup:true})).rejects.toMatchObject({code:'DRAFT_BACKUP_UNAVAILABLE'});expect(puts(s)).toHaveLength(0);
 a.storage.exportDraft('p');await a.storage.resolveDraft('p',{}, {exportedBackup:true});expect(s.get().nodes[0].data.text).toBe('later');expect(a.storage.hasDraft('p')).toBe(false);
});
it('requires current edit permission and keeps another identity from exporting or restoring this page state',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);a.native.nodes[0].data.text='private draft';a.storage.captureDraft('p',a.native);s.setRole('VIEWER');
 await expect(a.storage.resolveDraft('p',{})).rejects.toMatchObject({code:'READ_ONLY'});expect(a.storage.exportDraft('p')).toContain('private draft');expect(puts(s)).toHaveLength(0);
 a.identity('different-user');expect(()=>a.storage.exportDraft('p')).toThrow('原账号');expect(a.storage.draft('p')).toBeUndefined();expect(a.storage.draftRecoveryState('p').backups).toEqual([]);
});
it('imports a legacy unknown-base backup without deleting unrelated server nodes',async()=>{
 const disk=new MemoryDraftStorage(),s=server(graph([node('server-only')])),a=await client(s,disk);
 const file={format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId:'u',projectId:'p',createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',graph:graph([node('legacy-local')])};
 const restored=await a.storage.importDraft('p',JSON.stringify(file));expect(restored.conflicts).toContainEqual({path:'/',reason:'BASE_UNKNOWN'});expect(restored.graph.nodes.map(row=>row.id)).toEqual(['server-only','legacy-local']);
 await a.storage.resolveDraft('p',changes(a.storage));expect(s.get().nodes.map(row=>row.id)).toEqual(['server-only','legacy-local']);
});
it('requires unknown-base confirmation even when an imported pending entry happens to have the current ETag',async()=>{
 const disk=new MemoryDraftStorage(),s=server(graph([node('server-only')])),a=await client(s,disk),local=graph([node('legacy-local')]);
 const file={format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId:'u',projectId:'p',createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',graph:local,pending:[{base:graph([]),local,initialEtag:'"1"',unknownBase:true}]};
 const restored=await a.storage.importDraft('p',JSON.stringify(file));expect(restored.conflicts).toContainEqual({path:'/',reason:'BASE_UNKNOWN'});expect(restored.graph.nodes.map(row=>row.id)).toEqual(['server-only','legacy-local']);
});
it('keeps a missing-base capture recoverable instead of throwing before leave-page protection',()=>{
 const disk=new MemoryDraftStorage(),api=new ProductClient('/api/v1',vi.fn()),storage=new ServiceStorage(api,vi.fn(),()=> 'u',new DraftJournal(()=>disk));
 expect(()=>storage.captureDraft('p',graph([node('unacknowledged','new text')]))).not.toThrow();expect(storage.hasDraft('p')).toBe(true);expect(storage.draftRecoveryState('p').persistence).toBe('memory-only');
 const exported=JSON.parse(storage.exportDraft('p'));expect(exported.graph.nodes[0].data.text).toBe('new text');expect(exported.pending[0].requiresBaseDecision).toBe(true);
});
it('keeps local text and uploaded-state recovery when a real blob reference cannot be serialized',async()=>{
 const disk=new MemoryDraftStorage(),s=server(),a=await client(s,disk);a.native.nodes[0].data.text='text typed beside an upload';
 a.native.nodes.push({id:'upload',type:'rh-image',position:{x:300,y:0},data:{imageUrl:'blob:https://fixture.invalid/local-file',title:'upload'}});
 expect(()=>a.storage.captureDraft('p',a.native)).not.toThrow();expect(a.storage.hasDraft('p')).toBe(true);expect(a.storage.draftRecoveryState('p')).toMatchObject({persistence:'memory-only',error:expect.stringContaining('不要刷新')});
 expect(a.storage.draft('p')!.nodes[0].data.text).toBe('text typed beside an upload');
 const file=JSON.parse(a.storage.exportDraft('p'));expect(file.unresolvedMedia).toBe(1);expect(file.graph.nodes[0].data.text).toBe('text typed beside an upload');expect(JSON.stringify(file)).not.toContain('blob:');expect(JSON.stringify([...disk.rows.values()])).not.toContain('blob:');
 await expect(a.storage.resolveDraft('p',{})).rejects.toMatchObject({code:'DRAFT_MEDIA_PENDING'});expect(puts(s)).toHaveLength(0);
 a.native.nodes=a.native.nodes.filter(row=>row.id!=='upload');a.storage.captureDraft('p',a.native);expect(a.storage.draftRecoveryState('p').persistence).toBe('saved');
 await a.storage.resolveDraft('p',{});expect(s.get().nodes[0].data.text).toBe('text typed beside an upload');
});
