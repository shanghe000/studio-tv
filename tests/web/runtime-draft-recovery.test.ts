import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {decodeGraph,encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {applyCanvasOperations} from '../../apps/web/src/service/canvas-operations';
import {verifiedAccess} from './collaboration-fixtures';

const {syncs,applied}=vi.hoisted(()=>({syncs:[] as any[],applied:vi.fn()}));
vi.mock('../../apps/web/src/config',()=>({config:{apiBase:'/api/v1',mode:'service'}}));
vi.mock('../../apps/web/src/api/auth',()=>({
 AuthSession:class {user:any=null;restore=async()=>false;onClear=()=>{};clear=vi.fn();},installNativeSessionBridge:()=>{},
}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));
// The native transaction/stream boundaries are ports. Storage, access events,
// draft capture, CAS requests and the ordinary execution adapter remain real.
vi.mock('../../apps/web/src/service/native-canvas-sync',()=>({
 REMOTE_CANVAS_ORIGIN:'remote',nativeCanvasSyncPort:(client:any)=>({available:()=>true,ready:()=>true,apply:(graph:NativeGraph)=>{applied(graph);client.graph=structuredClone(graph);return true;}}),
}));
vi.mock('../../apps/web/src/service/canvas-sync',()=>({CanvasSync:class {
 view:any;start=vi.fn();stop=vi.fn();constructor(_api:any,_storage:any,_id:string,view:any){this.view=view;syncs.push(this);}
}}));

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function localStore(){const rows=new Map<string,string>();return{rows,get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};}
const reply=(data:any,revision?:number)=>new Response(JSON.stringify({code:0,data}),{headers:revision?{ETag:'"'+revision+'"'}:{}});
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();syncs.length=0;applied.mockClear();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

async function setup(startNative=false){
 const journal=localStore(),listeners=new Map<string,EventListener>(),notice=vi.fn();
 const path={pathname:'/projects/',search:'',hash:'',replace:vi.fn()};
 const original:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{text:'Original'}}],edges:[],meta:{id:'p'}};
 let revision=1,serverGraph=encodeGraph(original);
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(serverGraph),updatedAt:'2026-11-02T06:00:00Z'});
 const cap={capabilityRef:'fixture-text',version:'1',kind:'LLM',available:true,testMode:false,executionKind:'MODEL',model:{providerRef:'fixture',modelRef:'text',title:'Protocol fixture',version:'1'},inputKinds:['TEXT'],outputKinds:['TEXT'],parameterSchemaVersion:'1',parameterSchema:{type:'object',properties:{},additionalProperties:false}};
 const transport=vi.fn(async(path:string,init:any={})=>{
  if(path==='/api/v2/collaboration/projects/p/access')return reply(verifiedAccess());
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){serverGraph=JSON.parse(init.body).graph;revision++;}
   return reply({projectId:'p',revision,graph:serverGraph,updatedAt:'2026-11-02T06:00:00Z'},revision);
  }
  if(path==='/api/v2/projects/p/canvas-operations'){const batch=JSON.parse(init.body);serverGraph=applyCanvasOperations(serverGraph,batch.operations);revision++;return reply({...snapshot(),batchId:batch.batchId,clientId:batch.clientId},revision);}
  if(path.startsWith('/api/v2/model-capabilities?'))return reply({items:[cap],nextCursor:null});
  if(path==='/api/v2/canvas-runs')return reply({id:'fixture-task',projectId:'p',state:'SUCCEEDED',revision:1,testMode:false,plans:[]});
  throw new Error('Unexpected protocol request '+path);
 });
 vi.stubGlobal('location',path);vi.stubGlobal('localStorage',journal);
 vi.stubGlobal('window',{fetch:transport,setTimeout,localStorage:journal,__RHTV_PREVIEW__:{notice},dispatchEvent:vi.fn(),addEventListener:vi.fn((name:string,callback:EventListener)=>{listeners.set(name,callback);})});
 vi.stubGlobal('document',{addEventListener:vi.fn()});
 const {serviceRuntime:runtime}=await import('../../apps/web/src/service/runtime');
 runtime.auth.user={id:'owner'} as any;runtime.api.setAccessToken('fixture-session-only');path.pathname='/project/canvas/p';
 runtime.storage.projects.set('p',{id:'p',ownerId:'owner',name:'Fixture'} as any);runtime.storage.rememberAccess(verifiedAccess());
 runtime.storage.acceptRemoteSnapshot('p',{projectId:'p',revision,graph:serverGraph,updatedAt:'2026-11-02T06:00:00Z'},'"1"');
 if(startNative){path.pathname='/projects/';await runtime.ready();path.pathname='/project/canvas/p';}
 let update!:()=>void;const unsubscribe=vi.fn();
 const client={roomId:'p',graph:structuredClone(original),ydoc:{on:vi.fn(),off:vi.fn()},getRemoteData(){return this.graph;},subscribe:vi.fn((callback:()=>void)=>{update=callback;return unsubscribe;}),flushOperationQueue:vi.fn()};
 runtime.attachCanvas('p',client);
 return{runtime,client,path,journal,transport,listeners,notice,unsubscribe,update:()=>update(),server:()=>decodeGraph(serverGraph),snapshot,remote:(change:(graph:NativeGraph)=>void)=>{const graph=decodeGraph(serverGraph);change(graph);serverGraph=encodeGraph(graph);revision++;return snapshot();}};
}

it('keeps the existing manager attached during a forced recovery access refresh',async()=>{
 const s=await setup(),detach=vi.spyOn(s.runtime,'detachCanvas'),access=vi.spyOn(s.runtime.storage,'refreshAccess');
 s.client.graph.nodes[0].data.text='Local draft';s.update();
 await s.runtime.recoverCanvasDraft();await Promise.resolve();
 expect(access).toHaveBeenCalledWith('p',true);
 expect(s.transport.mock.calls.filter(([path])=>path==='/api/v2/collaboration/projects/p/access')).toHaveLength(1);
 expect(detach).not.toHaveBeenCalled();expect(s.unsubscribe).not.toHaveBeenCalled();expect(s.client.ydoc.off).not.toHaveBeenCalled();expect(s.client.subscribe).toHaveBeenCalledOnce();
 expect(s.runtime.canvasAttachment()?.client).toBe(s.client);expect(applied).toHaveBeenCalledOnce();expect(syncs).toHaveLength(2);expect(syncs[0].stop).toHaveBeenCalledOnce();expect(syncs[1].start).toHaveBeenCalledOnce();expect(syncs[1].view.current()).toBe(true);
 expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.server().nodes[0].data.text).toBe('Local draft');
});

it('retries ordinary sync through the safe recovery port without supplying conflict choices',async()=>{
 const s=await setup();s.client.graph.nodes[0].data.text='Retained retry input';s.update();const resolve=vi.spyOn(s.runtime.storage,'resolveDraft');
 await s.runtime.retryCanvasSync();expect(resolve).toHaveBeenCalledWith('p',{},undefined);expect(s.runtime.storage.isBlocked('p')).toBe(false);expect(s.server().nodes[0].data.text).toBe('Retained retry input');expect(s.runtime.canvasAttachment()?.client).toBe(s.client);expect(s.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
});

it('retains a real overlapping edit on sync retry without choosing a version or writing a replacement',async()=>{
 const s=await setup();s.client.graph.nodes[0].data.text='Private local edit';s.update();const remote=s.remote(graph=>{graph.nodes[0].data.text='Private remote edit';});s.runtime.storage.acceptRemoteSnapshot('p',remote,'"2"');const before=s.transport.mock.calls.length;
 await expect(s.runtime.retryCanvasSync()).rejects.toMatchObject({code:'CANVAS_SYNC_PENDING',message:'部分修改尚未同步，内容已保留，请重试同步。'});expect(s.transport.mock.calls.slice(before).some(([,init])=>init?.method==='PUT')).toBe(false);expect(s.runtime.storage.isBlocked('p')).toBe(true);expect(s.runtime.storage.draft('p')!.nodes[0].data.text).toBe('Private local edit');expect(s.server().nodes[0].data.text).toBe('Private remote edit');expect(s.runtime.canvasAttachment()?.client).toBe(s.client);
});

it('backs up the native last debounced edit when leaving while recovery awaits, then fences the stale recovery completion',async()=>{
 const s=await setup(),started=deferred<void>(),completion=deferred<NativeGraph>();
 vi.spyOn(s.runtime.storage,'resolveDraft').mockImplementation(async()=>{started.resolve();return completion.promise;});
 const recovery=s.runtime.recoverCanvasDraft(),rejected=expect(recovery).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});await started.promise;
 s.client.flushOperationQueue.mockImplementation(()=>{s.client.graph.nodes[0].data.text='Native edit committed only on leaving';s.update();});
 s.runtime.setCanvasPageActive(false);
 expect(s.runtime.canvasAttachment()).toBeNull();expect(s.runtime.storage.hasDraft('p')).toBe(true);
 const backup=JSON.parse(s.runtime.storage.exportDraft('p'));expect(backup.graph.nodes[0].data.text).toBe('Native edit committed only on leaving');
 expect([...s.journal.rows.values()].some(text=>text.includes('Native edit committed only on leaving'))).toBe(true);
 completion.resolve(s.client.graph);await rejected;
 expect(syncs).toHaveLength(1);expect(applied).not.toHaveBeenCalled();expect(s.runtime.storage.hasDraft('p')).toBe(true);
 expect(s.transport.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
});

it.each(['capture exception','unfinished blob'] as const)('still protects beforeunload with %s',async mode=>{
 const s=await setup();s.client.graph.nodes[0].data.text='Unsaved edit';
 if(mode==='capture exception')vi.spyOn(s.runtime.storage,'captureDraft').mockImplementation(()=>{throw new Error('fixture backup storage failure');});
 else s.client.graph.nodes[0].data.imageUrl='blob:unfinished-local-upload';
 const event=new Event('beforeunload',{cancelable:true});
 // A browser listener may report an exception, but its finally block must
 // still cancel navigation and preserve the original manager's live input.
 try{s.listeners.get('beforeunload')!(event);}catch{/* The leave guard is the assertion. */}
 expect(event.defaultPrevented).toBe(true);expect(s.runtime.canvasAttachment()?.client).toBe(s.client);expect(s.client.graph.nodes[0].data.text).toBe('Unsaved edit');
 if(mode==='unfinished blob'){expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('memory-only');}
 expect(s.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
});

it('resumes ordinary saving before the next generation protocol submission after recovery',async()=>{
 const s=await setup();s.client.graph.nodes[0].data.text='Recovered edit';s.update();await s.runtime.recoverCanvasDraft();
 expect(s.runtime.storage.hasDraft('p')).toBe(false);const afterRecovery=s.transport.mock.calls.length;
 s.client.graph.nodes[0].data.text='Further edit after recovery';s.update();
 const result=await s.runtime.execution.isolated('LLM','Protocol only, no model invocation',[],'p',{},undefined,{capabilityRef:'fixture-text',capabilityVersion:'1'});
 expect(result.taskId).toBe('fixture-task');expect(s.server().nodes[0].data.text).toBe('Further edit after recovery');
 const next=s.transport.mock.calls.slice(afterRecovery),save=next.findIndex(([path,init])=>path==='/api/v1/projects/p/snapshot'&&init?.method==='PUT'),submit=next.findIndex(([path])=>path==='/api/v2/canvas-runs');
 expect(save).toBeGreaterThanOrEqual(0);expect(submit).toBeGreaterThan(save);expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(syncs[1].view.current()).toBe(true);
 await expect(s.runtime.waitForSave()).resolves.toBeUndefined();
});


it('keeps pending lease edits protected on unload and removes a departed page header',async()=>{
 const s=await setup();let pending=true;const flushPending=vi.fn(async()=>{pending=false;}),acquire=vi.fn(async()=>{});
 s.runtime.setCanvasPresence({projectId:'p',userId:'owner',clientId:'page-one',flushPending,acquire,hasPending:()=>pending});
 const event=new Event('beforeunload',{cancelable:true});s.listeners.get('beforeunload')!(event);expect(event.defaultPrevented).toBe(true);
 await s.runtime.flushCanvasMutations('p');await s.runtime.acquireCanvasNodes('p',['n']);expect(flushPending).toHaveBeenCalledOnce();expect(acquire).toHaveBeenCalledWith(['n']);
 await s.runtime.api.request('/projects/p/snapshot',{method:'PUT',body:{graph:encodeGraph(s.client.graph)}});
 expect(new Headers(s.transport.mock.calls.at(-1)![1].headers).get('X-STUDIO-Canvas-Session')).toBe('page-one');
 s.runtime.detachCanvas();await s.runtime.api.request('/projects/p/snapshot',{method:'PUT',body:{graph:encodeGraph(s.client.graph)}});
 expect(new Headers(s.transport.mock.calls.at(-1)![1].headers).get('X-STUDIO-Canvas-Session')).toBeNull();
});

it('automatically resumes a retained local save after live synchronization resolves its temporary block',async()=>{
 const s=await setup();s.client.graph.nodes[0].data.text='Retained edit';s.update();
 const sync=syncs.at(-1);let attempts=0;
 const original=s.runtime.storage.queueSave.bind(s.runtime.storage);
 vi.spyOn(s.runtime.storage,'queueSave').mockImplementation((id,graph)=>{attempts++;if(attempts===1)return Promise.reject(new TypeError('Temporary disconnection'));return original(id,graph);});
 const blocked=vi.spyOn(s.runtime.storage,'isBlocked').mockReturnValue(true);
 s.runtime.flush();await Promise.resolve();await Promise.resolve();await Promise.resolve();await vi.advanceTimersByTimeAsync(300);
 expect(attempts).toBe(1);blocked.mockRestore();
 sync.view.applied({nodeStates:[],graphRevision:1});await vi.advanceTimersByTimeAsync(200);await s.runtime.storage.wait('p');
 expect(attempts).toBe(2);expect(s.server().nodes[0].data.text).toBe('Retained edit');expect(s.runtime.storage.hasDraft('p')).toBe(false);
});

const casRefusal=()=>new Response(JSON.stringify({code:'VERSION_CONFLICT',message:'Fixture CAS refusal'}),{status:412});
const tick=async(milliseconds=0)=>{await vi.advanceTimersByTimeAsync(milliseconds);};
/** Deliver the coherent live head before the rejected HTTP response, exactly
 * the race where storage can already prove a refusal safe when runtime sees it.
 * Real storage still performs each bounded CAS merge/retry and keeps the draft. */
function refuseWithLiveProof(s:Awaited<ReturnType<typeof setup>>,options:{batches?:number;lateEdit?:boolean}={}){
 const transport=s.transport.getMockImplementation()!,puts:{at:number;etag:string|null;graph:NativeGraph}[]=[];
 s.transport.mockImplementation(async(path:string,init:any={})=>{
  if(path==='/api/v1/projects/p/snapshot'&&init.method==='PUT'){
   puts.push({at:Date.now(),etag:new Headers(init.headers).get('If-Match'),graph:decodeGraph(JSON.parse(init.body).graph)});
   expect(puts.at(-1)!.etag).toBe('"'+s.snapshot().revision+'"');
   if(puts.length<=(options.batches??1)*3){
    const remote=s.remote(graph=>{graph.nodes[0].data.serverTitle='Live observation '+puts.length;});
    s.runtime.storage.acceptRemoteSnapshot('p',remote,'"'+remote.revision+'"');
    if(options.lateEdit&&puts.length===3){s.client.graph.nodes[0].data.text='Latest edit while CAS failed';s.update();}
    return casRefusal();
   }
  }
  return transport(path,init);
 });
 return puts;
}

it.each([false,true])('retries a safely released 412 after one second with the newest durable local edit (late edit=%s)',async lateEdit=>{
 const s=await setup(),puts=refuseWithLiveProof(s,{lateEdit}),start=Date.now(),queued=vi.spyOn(s.runtime.storage,'queueSave');s.client.graph.nodes[0].data.text='Initial retained edit';s.update();await tick(150);
 expect(puts).toHaveLength(3);expect(queued).toHaveBeenCalledTimes(1);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'saved',conflicts:[]});const expected=lateEdit?'Latest edit while CAS failed':'Initial retained edit';expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe(expected);expect(s.server().nodes[0].data.text).toBe('Original');expect(applied).not.toHaveBeenCalled();
 await tick(999);expect(puts).toHaveLength(3);await tick(1);expect(queued).toHaveBeenCalledTimes(2);expect(puts).toHaveLength(4);expect(puts.map(put=>put.etag)).toEqual(['"1"','"2"','"3"','"4"']);expect(puts[3].at-start).toBe(1150);expect(puts[3].graph.nodes[0].data.text).toBe(expected);expect(s.server().nodes[0].data).toMatchObject({text:expected,serverTitle:'Live observation 3'});expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(applied).toHaveBeenCalledOnce();expect(s.client.graph.nodes[0].data).toMatchObject({text:expected,serverTitle:'Live observation 3'});await tick(5000);expect(puts).toHaveLength(4);
});

it('does not blindly retry a 412 whose latest snapshot cannot prove a newer coherent base',async()=>{
 const s=await setup(),transport=s.transport.getMockImplementation()!,puts:any[]=[];s.transport.mockImplementation(async(path:string,init:any={})=>{if(path==='/api/v1/projects/p/snapshot'&&init.method==='PUT'){puts.push(JSON.parse(init.body));return casRefusal();}return transport(path,init);});
 s.client.graph.nodes[0].data.text='Keep blocked draft';s.update();await tick(150);expect(puts).toHaveLength(1);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'CAS_UNCERTAIN',persistence:'saved'});s.runtime.storage.acceptRemoteSnapshot('p',s.snapshot(),'"1"');await tick(10000);
 expect(puts).toHaveLength(1);expect(s.server().nodes[0].data.text).toBe('Original');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Keep blocked draft');expect([...s.journal.rows.values()].some(text=>text.includes('Keep blocked draft'))).toBe(true);
});

it('bounds safely released 412 automatic retries to three delays without discarding the draft',async()=>{
 const s=await setup(),puts=refuseWithLiveProof(s,{batches:4}),start=Date.now(),queued=vi.spyOn(s.runtime.storage,'queueSave');s.client.graph.nodes[0].data.text='Retain after CAS exhaustion';s.update();await tick(150);expect(puts).toHaveLength(3);
 for(const delay of [1000,2000,5000]){const count=puts.length;await tick(delay-1);expect(puts).toHaveLength(count);await tick(1);expect(puts).toHaveLength(count+3);}
 expect(queued).toHaveBeenCalledTimes(4);expect(puts.filter((_put,index)=>index%3===0).map(put=>put.at-start)).toEqual([150,1150,3150,8150]);await tick(10000);expect(puts).toHaveLength(12);expect(queued).toHaveBeenCalledTimes(4);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'saved',conflicts:[]});expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Retain after CAS exhaustion');expect(s.server().nodes[0].data.text).toBe('Original');
});

it('stops a scheduled safe-CAS retry if the next refusal becomes uncertain',async()=>{
 const s=await setup(),safe=refuseWithLiveProof(s),transport=s.transport.getMockImplementation()!,queued=vi.spyOn(s.runtime.storage,'queueSave');let uncertain=0;s.transport.mockImplementation(async(path:string,init:any={})=>{if(path==='/api/v1/projects/p/snapshot'&&init.method==='PUT'&&safe.length===3){uncertain++;return casRefusal();}return transport(path,init);});s.client.graph.nodes[0].data.text='Retain through uncertain retry';s.update();await tick(150);expect(safe).toHaveLength(3);await tick(1000);
 expect(uncertain).toBe(1);expect(queued).toHaveBeenCalledTimes(2);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:true,blockedReason:'CAS_UNCERTAIN',persistence:'saved'});await tick(10000);expect(uncertain).toBe(1);expect(queued).toHaveBeenCalledTimes(2);expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Retain through uncertain retry');
});

it('cancels a safe-CAS retry on departure, flushes its final barrier, and saves the next project separately',async()=>{
 const s=await setup(),puts=refuseWithLiveProof(s),transport=s.transport.getMockImplementation()!;const qGraph:NativeGraph={nodes:[{id:'q-node',type:'rh-text',position:{x:0,y:0},data:{text:'Original q'}}],edges:[],meta:{id:'q'}};let qServer=encodeGraph(qGraph),qRevision=1,qUpdate!:()=>void;const qPuts:any[]=[];
 s.transport.mockImplementation(async(path:string,init:any={})=>{if(path==='/api/v2/collaboration/projects/q/access')return reply(verifiedAccess('q'));if(path==='/api/v1/projects/q/snapshot'){if(init.method==='PUT'){expect(new Headers(init.headers).get('If-Match')).toBe('"'+qRevision+'"');qPuts.push(JSON.parse(init.body));qServer=JSON.parse(init.body).graph;qRevision++;}return reply({projectId:'q',revision:qRevision,graph:qServer,updatedAt:'2026-11-03T00:00:00Z'},qRevision);}return transport(path,init);});
 s.client.graph.nodes[0].data.text='Old project final draft';s.update();await tick(150);expect(puts).toHaveLength(3);s.runtime.setCanvasPageActive(false);await s.runtime.storage.wait('p');expect(puts).toHaveLength(4);expect(s.server().nodes[0].data.text).toBe('Old project final draft');
 s.runtime.storage.projects.set('q',{id:'q',ownerId:'owner',name:'Next project'} as any);s.runtime.storage.rememberAccess(verifiedAccess('q'));s.runtime.storage.acceptRemoteSnapshot('q',{projectId:'q',revision:1,graph:qServer,updatedAt:'2026-11-03T00:00:00Z'},'"1"');const qClient={roomId:'q',graph:structuredClone(qGraph),getRemoteData(){return this.graph;},subscribe:(callback:()=>void)=>{qUpdate=callback;return()=>{};},flushOperationQueue:vi.fn(),ydoc:{on:vi.fn(),off:vi.fn()}};s.path.pathname='/project/canvas/q';s.runtime.setCanvasPageActive(true);s.runtime.attachCanvas('q',qClient);qClient.graph.nodes[0].data.text='Only the next project';qUpdate();await tick(150);await tick(10000);
 expect(puts).toHaveLength(4);expect(qPuts).toHaveLength(1);expect(decodeGraph(qServer).nodes[0].data.text).toBe('Only the next project');expect(qPuts[0].graph.nodes[0].id).toBe('q-node');expect(s.runtime.canvasAttachment()?.id).toBe('q');expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.runtime.storage.hasDraft('q')).toBe(false);
});

it('cancels a scheduled safe-CAS retry on edit permission revocation and retains the backup',async()=>{
 const s=await setup(),puts=refuseWithLiveProof(s);s.client.graph.nodes[0].data.text='Keep after access revoke';s.update();await tick(150);expect(puts).toHaveLength(3);s.runtime.storage.rememberAccess(verifiedAccess('p','VIEWER','owner',2));await tick(10000);expect(puts).toHaveLength(3);expect(s.runtime.storage.canEdit('p')).toBe(false);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Keep after access revoke');
});

it('keeps a viewer canvas readable when installing the new edit-session port without enabling operation writes',async()=>{
 const s=await setup();s.runtime.storage.projects.get('p')!.ownerId='project_owner';s.runtime.storage.rememberAccess(verifiedAccess('p','VIEWER','project_owner',2));const enable=vi.spyOn(s.runtime.storage,'enableCanvasOperations'),ensure=vi.fn(async()=>{});expect(()=>s.runtime.setCanvasEditSession({projectId:'p',userId:'owner',clientId:'viewer_page',current:()=>true,ensure})).not.toThrow();
 expect(s.runtime.storage.canRead('p')).toBe(true);expect(s.runtime.storage.canEdit('p')).toBe(false);expect(enable).not.toHaveBeenCalled();expect(s.runtime.storage.usesCanvasOperations('p')).toBe(false);expect(s.runtime.canvasAttachment()?.client).toBe(s.client);s.client.graph.nodes[0].data.text='Ignored read-only input';s.update();await s.runtime.waitForSave();expect(ensure).not.toHaveBeenCalled();expect(s.transport.mock.calls.some(([,init])=>init?.method==='PUT'||init?.method==='POST')).toBe(false);expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.server().nodes[0].data.text).toBe('Original');
});

it('enables owner operation saving through the new edit-session setter and retries without legacy recovery',async()=>{
 const s=await setup(),ensure=vi.fn(async()=>{}),recover=vi.spyOn(s.runtime,'recoverCanvasDraft'),resolve=vi.spyOn(s.runtime.storage,'resolveDraft');s.runtime.setCanvasEditSession({projectId:'p',userId:'owner',clientId:'owner_page',current:()=>true,ensure});expect(s.runtime.storage.usesCanvasOperations('p')).toBe(true);s.client.graph.nodes[0].data.text='Owner operation input';s.update();await s.runtime.retryCanvasSync();
 const posts=s.transport.mock.calls.filter(([path])=>path==='/api/v2/projects/p/canvas-operations');expect(posts).toHaveLength(1);expect(JSON.parse(posts[0][1].body).clientId).toBe('owner_page');expect(new Headers(posts[0][1].headers).get('X-STUDIO-Canvas-Session')).toBe('owner_page');expect(s.server().nodes[0].data.text).toBe('Owner operation input');expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(recover).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();expect(ensure).toHaveBeenCalled();expect(s.transport.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);expect(s.runtime.canvasAttachment()?.client).toBe(s.client);
});

it('keeps a stale native tab read-only until the latest server graph is applied, without turning its old view into edits',async()=>{
 const s=await setup();
 const port={projectId:'p',userId:'owner',clientId:'second_tab',current:()=>true,holds:()=>false,ownsLease:()=>true,ensure:vi.fn(async()=>{}),ensureForSave:vi.fn(async()=>{})};
 s.runtime.setCanvasEditSession(port);
 s.remote(g=>{g.nodes[0].data.text='Saved in first tab';g.nodes.push({id:'added',type:'rh-image',position:{x:30,y:5},data:{}});});
 expect(s.client.graph.nodes[0].data.text).toBe('Original');
 const revision=await s.runtime.syncCanvasHandoff('p',port.clientId);
 expect(revision).toBe(2);
 expect(s.client.getRemoteData().nodes.map(n=>[n.id,n.data.text])).toEqual([['n','Saved in first tab'],['added',undefined]]);
 await s.runtime.finishCanvasHandoff('p',port.clientId);
 expect(s.runtime.storage.hasDraft('p')).toBe(false);
 expect(s.transport.mock.calls.filter(([path])=>path.endsWith('canvas-operations'))).toHaveLength(0);
});

it('restores a fenced operation port only for the ready current writer and drains the original retained batch with its new proof and lease',async()=>{
 const s=await setup(),ensure=vi.fn(async()=>{});
 const proof='p'.repeat(32),lease='ready_writer_term';
 const port={projectId:'p',userId:'owner',clientId:'restored_page',pageProof:proof,current:()=>true,holds:()=>false,ownsLease:()=>true,ensure,ensureForSave:ensure};
 s.runtime.setCanvasEditSession(port);
 s.client.graph.nodes[0].data.text='Retained edit before the local port was fenced';
 s.runtime.storage.captureDraft('p',s.client.getRemoteData());
 const retained=[...s.journal.rows.values()].map(value=>JSON.parse(value)).find(value=>value.format==='OPERATION_OUTBOX');
 expect(retained).toBeDefined();
 s.runtime.storage.suspendCanvasOperations('p');
 s.runtime.api.setCanvasSession('p',port.clientId,proof,lease);
 expect(await s.runtime.syncCanvasHandoff('p',port.clientId)).toBe(1);
 await s.runtime.finishCanvasHandoff('p',port.clientId);
 const posts=s.transport.mock.calls.filter(([path])=>path==='/api/v2/projects/p/canvas-operations');
 expect(posts).toHaveLength(1);
 const request=JSON.parse(posts[0][1].body),headers=new Headers(posts[0][1].headers);
 expect(request.batchId).toBe(retained.batchId);expect(request.operations).toEqual(retained.operations);
 expect(request.clientId).toBe(port.clientId);
 expect(headers.get('X-STUDIO-Canvas-Proof')).toBe(proof);expect(headers.get('X-STUDIO-Canvas-Lease')).toBe(lease);
 expect(s.server().nodes[0].data.text).toBe('Retained edit before the local port was fenced');
 expect(s.client.getRemoteData().nodes[0].data.text).toBe('Retained edit before the local port was fenced');
 expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(ensure).toHaveBeenCalled();
 expect(s.transport.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
});

it('does not restore a fenced operation port for an unready term or an outgoing page',async()=>{
 const s=await setup();let ready=false;
 const port={projectId:'p',userId:'owner',clientId:'outgoing_page',pageProof:'a'.repeat(32),current:()=>true,holds:()=>false,ownsLease:()=>ready,ensure:vi.fn(async()=>{})};
 s.runtime.setCanvasEditSession(port);s.runtime.storage.suspendCanvasOperations('p');
 const enable=vi.spyOn(s.runtime.storage,'enableCanvasOperations');
 await expect(s.runtime.finishCanvasHandoff('p',port.clientId)).rejects.toMatchObject({code:'CANVAS_SESSION_PENDING'});
 expect(enable).not.toHaveBeenCalled();
 const next={...port,clientId:'new_page',pageProof:'b'.repeat(32),ownsLease:()=>true};
 s.runtime.setCanvasEditSession(next);enable.mockClear();ready=true;
 await expect(s.runtime.finishCanvasHandoff('p',port.clientId)).rejects.toMatchObject({name:'AbortError'});
 expect(enable).not.toHaveBeenCalled();
 expect(s.transport.mock.calls.some(([path])=>path.endsWith('canvas-operations'))).toBe(false);
});

it('requires a save receipt before an outgoing page can approve a handoff',async()=>{
 const s=await setup();
 const save=deferred<void>();
 const port={projectId:'p',userId:'owner',clientId:'first_tab',current:()=>true,holds:()=>true,ownsLease:()=>true,ensure:vi.fn(async()=>{}),ensureForSave:vi.fn(()=>save.promise)};
 s.runtime.setCanvasEditSession(port);
 s.client.graph.nodes[0].data.text='Last edit before changing tabs';
 s.update();
 let complete=false;
 const pending=s.runtime.prepareCanvasHandoff('p',port.clientId).then(()=>{complete=true;});
 await vi.waitFor(()=>expect(port.ensureForSave).toHaveBeenCalled());
 expect(complete).toBe(false);
 expect(s.server().nodes[0].data.text).toBe('Original');
 save.resolve();await pending;
 expect(s.server().nodes[0].data.text).toBe('Last edit before changing tabs');
 expect(s.runtime.storage.hasDraft('p')).toBe(false);
});

it('cancels a delayed incoming snapshot when its page loses its claim',async()=>{
 const s=await setup(), response=deferred<Response>(),abort=new AbortController();
 const port={projectId:'p',userId:'owner',clientId:'first_tab',current:()=>true,holds:()=>false,ensure:vi.fn(async()=>{})};
 s.runtime.setCanvasEditSession(port);
 s.transport.mockImplementationOnce(()=>response.promise);
 const pending=s.runtime.syncCanvasHandoff('p',port.clientId,abort.signal);
 abort.abort();
 response.resolve(reply(s.remote(g=>{g.nodes[0].data.text='After losing ownership';}),2));
 await expect(pending).rejects.toMatchObject({name:'AbortError'});
 expect(s.client.graph.nodes[0].data.text).toBe('Original');
});

it('rechecks the latest worker update before retrying an interrupted recovery',async()=>{
 const s=await setup();
 const {ApiError}=await import('../../apps/web/src/api/client');
 const port={projectId:'p',userId:'owner',clientId:'next_page',current:()=>true,holds:()=>false,ownsLease:()=>true,ensure:vi.fn(async()=>{})};
 s.runtime.setCanvasEditSession(port);
 const recovery=vi.spyOn(s.runtime.storage,'recoverHandoffOperations').mockRejectedValueOnce(new ApiError(412,'CANVAS_RECOVERY_RECHECK','Changed'));
 s.remote(graph=>{graph.nodes[0].data.text='Worker completed';});
 await s.runtime.finishCanvasHandoff('p',port.clientId);
 expect(recovery).toHaveBeenCalledTimes(2);
 expect(s.client.graph.nodes[0].data.text).toBe('Worker completed');
});

it('does not remount a paused document on an access revision or a native reattach while the snapshot is in flight',async()=>{
 const s=await setup(),response=deferred<Response>(),detach=vi.spyOn(s.runtime,'detachCanvas');
 const port={projectId:'p',userId:'owner',clientId:'page',current:()=>true,holds:()=>false,ensure:vi.fn(async()=>{})};
 s.runtime.setCanvasEditSession(port);
 s.transport.mockImplementationOnce(()=>response.promise);
 const syncing=s.runtime.syncCanvasHandoff('p',port.clientId);
 s.transport.mockImplementationOnce(async()=>reply(verifiedAccess('p','OWNER','owner',2)));
 await s.runtime.storage.refreshAccess('p');
 s.runtime.attachCanvas('p',s.client);
 expect(syncs).toHaveLength(1);expect(s.unsubscribe).not.toHaveBeenCalled();
 response.resolve(reply(s.snapshot(),1));
 await expect(syncing).resolves.toBe(1);
 expect(detach).not.toHaveBeenCalled();expect(syncs).toHaveLength(2);
 expect(s.client.subscribe).toHaveBeenCalledOnce();expect(syncs[1].view.current()).toBe(true);
});

it('keeps native edits pending and submits them once after a malformed periodic access response recovers',async()=>{
 const s=await setup(),port={projectId:'p',userId:'owner',clientId:'page',current:()=>true,holds:()=>true,ensure:vi.fn(async()=>{})};
 s.runtime.setCanvasEditSession(port);
 s.transport.mockImplementationOnce(async()=>new Response('<html>proxy</html>',{status:502}));
 await tick(15000);
 expect(s.runtime.storage.accessNeedsConfirmation('p')).toBe(true);
 expect(()=>s.runtime.storage.requirePermission('p','canRun')).toThrow('正在重新确认');
 s.client.graph.nodes[0].position.x=500;s.update();await tick(250);
 expect(s.runtime.storage.hasDraft('p')).toBe(true);
 expect(s.transport.mock.calls.some(([path])=>path.endsWith('/canvas-operations'))).toBe(false);
 await tick(1000);await s.runtime.waitForSave();
 expect(s.server().nodes[0].position.x).toBe(500);
 expect(s.transport.mock.calls.filter(([path])=>path.endsWith('/canvas-operations'))).toHaveLength(1);
 expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.notice).not.toHaveBeenCalled();
 expect(syncs).toHaveLength(1);expect(s.unsubscribe).not.toHaveBeenCalled();
});

it('retains native changes before the first controller exists and sends them only as operations once this page is admitted',async()=>{
 const s=await setup(true);expect(s.runtime.storage.usesCanvasOperations('p')).toBe(true);await expect(s.runtime.acquireCanvasNodes('p',['node'])).rejects.toMatchObject({code:'CANVAS_SESSION_PENDING'});
 s.client.graph.nodes[0].data.text='pre-admission local intent';s.update();await tick(300);
 expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.transport.mock.calls.filter(([,init])=>init.method==='PUT'||init.method==='POST')).toHaveLength(0);
 const port={projectId:'p',userId:'owner',clientId:'new_page',current:()=>true,holds:()=>true,ownsLease:()=>true,permitsObservedRevision:()=>true,ensure:async()=>{}};
 s.runtime.setCanvasEditSession(port);s.runtime.resumeCanvasOperations('p');await s.runtime.waitForSave();
 expect(s.server().nodes[0].data.text).toBe('pre-admission local intent');expect(s.transport.mock.calls.filter(([,init])=>init.method==='PUT')).toHaveLength(0);
 const posts=s.transport.mock.calls.filter(([url])=>url.endsWith('/canvas-operations'));expect(posts).toHaveLength(1);expect(JSON.parse(posts[0][1].body)).toMatchObject({clientId:'new_page',observedRevision:1});expect(s.runtime.storage.hasDraft('p')).toBe(false);
});
it('keeps a rejected write without raising the draft banner, and cannot invalidate a newer term because of an old response',async()=>{
 const s=await setup(true);let term='lease1';const invalidate=vi.fn();const port={projectId:'p',userId:'owner',clientId:'chrome_page',current:()=>true,holds:()=>true,ownsLease:()=>true,editTenure:()=>term,ensure:async()=>{},invalidate};s.runtime.setCanvasEditSession(port);
 const original=s.transport.getMockImplementation()!,batches:string[]=[];s.transport.mockImplementation(async(url,init={})=>{
  if(url.endsWith('/canvas-operations')){batches.push(JSON.parse(init.body).batchId);if(batches.length===1){term='lease2';return new Response(JSON.stringify({error:{code:'EDIT_SESSION_EXPIRED',message:'此页的编辑连接已失效，正在重新连接。'}}),{status:409});}}
  return original(url,init);
 });
 s.client.graph.nodes[0].data.text='once only';s.update();await expect(s.runtime.waitForSave()).rejects.toThrow();expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.runtime.storage.draftRecoveryState('p').blocked).toBe(false);expect(invalidate).not.toHaveBeenCalled();expect(s.notice.mock.calls.flat().join('')).not.toContain('编辑连接已失效');
 await s.runtime.retryCanvasSync();expect(batches).toHaveLength(2);expect(batches[0]).toBe(batches[1]);expect(s.server().nodes[0].data.text).toBe('once only');
});
