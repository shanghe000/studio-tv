// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CanvasPresenceClient,type CanvasPresenceSnapshot} from '../../apps/web/src/service/canvas-presence';
import {guardNativePresenceMutations,installNativePresence,canvasTransform} from '../../apps/web/src/service/native-presence';
import {DraftJournal} from '../../apps/web/src/service/draft-journal';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ApiError} from '../../apps/web/src/api/client';
import {MemoryDraftStorage} from './draft-journal-fixture';

let dispose:(()=>void)|undefined;let disk:MemoryDraftStorage;beforeEach(()=>{disk=new MemoryDraftStorage();vi.stubGlobal('localStorage',disk);});
const cleanups:(()=>void)[]=[];
afterEach(()=>{dispose?.();dispose=undefined;for(const cleanup of cleanups.splice(0))cleanup();document.body.innerHTML='';disk.rows.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
// happy-dom aliases PageTransitionEvent to Event and omits persisted.
const pageTransition=(type:string,persisted=true)=>{const event=new Event(type);Object.defineProperty(event,'persisted',{value:persisted});return event;};
function fixture(options:{delay?:boolean;occupied?:boolean}={}){
 history.replaceState({},'', '/project/canvas/project');let generation=0,finish:(()=>void)|undefined,ownClient='',leases:CanvasPresenceSnapshot['leases']=[],stream:ReadableStreamDefaultController<Uint8Array>|undefined;
 const graph:any={nodes:[{id:'node',type:'rh-text',position:{x:100,y:100},data:{params:{prompt:'Original text'}}},{id:'neighbor',type:'rh-text',position:{x:600,y:100},data:{params:{prompt:'Other node'}}}],edges:[]},raw:any[]=[];
 const manager:any={getRemoteData:()=>graph,enqueue:vi.fn((operation:any)=>raw.push(operation)),flushOperationQueue:vi.fn(()=>{while(raw.length){const op=raw.shift(),node=graph.nodes.find((value:any)=>value.id===op.nodeId);if(op.kind==='patchNodeData')node.data={...node.data,...op.patch};if(op.kind==='moveNodes')for(const move of op.moves)graph.nodes.find((value:any)=>value.id===move.nodeId).position=move.position;}}),patchNodeData(id:string,patch:any){this.enqueue({kind:'patchNodeData',nodeId:id,patch});}};
 const settings=options;const originalEnqueue=manager.enqueue;const request=vi.fn(async(path:string,options:any={})=>{
  if(options.body?.clientId)ownClient=options.body.clientId;
  if(path.endsWith('/node-leases')&&options.method==='POST'){
   if(settings.delay)await new Promise<void>(resolve=>finish=resolve);
   if(settings.occupied)throw new ApiError(409,'NODE_EDIT_OCCUPIED','同事甲正在编辑，请稍候。');
   for(const nodeId of options.body.nodeIds)leases=[...leases.filter(lease=>lease.nodeId!==nodeId),{nodeId,clientId:options.body.clientId,userId:'user',displayName:'当前成员',expiresAt:new Date(Date.now()+15000).toISOString()}];
  }
  if(path.endsWith('/node-leases')&&options.method==='DELETE')leases=leases.filter(lease=>!options.body.nodeIds.includes(lease.nodeId));
  return{data:snapshot(),etag:null,status:200};
 });
 const snapshot=(patch:Partial<CanvasPresenceSnapshot>={}):CanvasPresenceSnapshot=>({schemaVersion:'1',projectId:'project',epoch:'boot',sequence:String(++generation),serverTime:new Date().toISOString(),presenceTtlMs:20000,leaseTtlMs:15000,members:[{clientId:ownClient||'page',userId:'user',displayName:'当前成员',role:'EDITOR',cursor:null,selectedNodeIds:[],lastSeenAt:new Date().toISOString()}],leases:structuredClone(leases),...patch});
 const api:any={requestV2:request,rawV2:vi.fn(async()=>new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'Content-Type':'text/event-stream'}})),reportV2Failure:vi.fn()};
 const authCallbacks=new Set<()=>void>();let attachment:any={id:'project',client:manager};
 const storage:any={snapshots:new Map([['project',{projectId:'project',revision:1,graph:encodeGraph(graph)}]]),encodeAsset:(value:string)=>value,refreshDraftBackups:vi.fn(),canEdit:()=>true,subscribeAccess:()=>()=>{},captureDraft:vi.fn(),draftRecoveryState:()=>({persistence:'saved'}),hasPending:()=>false};
 const state={selectedNodeIds:['node']},native:any={c5:{getState:()=>state,subscribe:()=>()=>{}},j:{}},runtime:any={api,auth:{user:{id:'user'},onClear:(callback:()=>void)=>{authCallbacks.add(callback);return()=>authCallbacks.delete(callback);}},storage,canvasAttachment:()=>attachment,setCanvasPresence:vi.fn((client:any)=>runtime.presence=client),waitForSave:vi.fn(async()=>{})};
 const emit=(value:CanvasPresenceSnapshot)=>stream!.enqueue(new TextEncoder().encode('event: presence.snapshot\ndata: '+JSON.stringify(value)+'\n\n'));
 return{runtime,native,manager,originalEnqueue,graph,storage,api,request,snapshot,emit,finish:()=>finish?.(),setDelay:(value:boolean)=>options.delay=value,setOccupied:(value:boolean)=>options.occupied=value,switchProject:()=>{attachment={id:'another',client:{}};window.dispatchEvent(new Event('rhtv:canvas-attachment'));}};
}
it('buffers native edits until the lease is granted, flushes them once, and keeps a recoverable backup meanwhile',async()=>{
 const f=fixture({delay:true}),notice=vi.fn(),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();
 const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,notice,()=>true);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'New local text'}});await turn();expect(f.graph.nodes[0].data.params.prompt).toBe('Original text');expect(guard.hasPending()).toBe(true);
 const backups=new DraftJournal(()=>window.localStorage).list('user','project');expect(backups).toHaveLength(1);expect(backups[0].graph.nodes[0].data.params.prompt).toBe('New local text');
 f.finish();await guard.flushPending();expect(f.graph.nodes[0].data.params.prompt).toBe('New local text');expect(f.originalEnqueue).toHaveBeenCalledTimes(1);expect(f.storage.captureDraft).toHaveBeenCalled();expect(guard.hasPending()).toBe(false);expect(new DraftJournal(()=>window.localStorage).list('user','project')).toHaveLength(0);
});
it('retains denied edits without mutating the shared graph or discarding the draft',async()=>{
 const f=fixture({occupied:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'Held draft'}});await expect(guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});expect(f.originalEnqueue).not.toHaveBeenCalled();expect(guard.hasPending()).toBe(true);expect(new DraftJournal(()=>window.localStorage).list('user','project')[0].graph.nodes[0].data.params.prompt).toBe('Held draft');
 f.setOccupied(false);await guard.flushPending();expect(f.graph.nodes[0].data.params.prompt).toBe('Held draft');
});
it('automatically resumes a known occupied edit when a presence update releases its node',async()=>{
 const f=fixture({occupied:true});dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const peer={nodeId:'node',clientId:'peer',userId:'other',displayName:'同事甲',expiresAt:new Date(Date.now()+15000).toISOString()};f.emit(f.snapshot({leases:[peer]}));await vi.waitFor(()=>expect(f.runtime.presence.holder('node')?.clientId).toBe('peer'));f.manager.patchNodeData('node',{params:{prompt:'Resume automatically'}});await vi.waitFor(()=>expect(f.runtime.presence.hasPending()).toBe(true));await turn();const acquisitions=()=>f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='POST').length,before=acquisitions();
 f.emit(f.snapshot({leases:[peer]}));await turn();expect(acquisitions()).toBe(before);expect(f.originalEnqueue).not.toHaveBeenCalled();f.setOccupied(false);f.setDelay(true);f.emit(f.snapshot({leases:[]}));await vi.waitFor(()=>expect(acquisitions()).toBe(before+1));for(let index=0;index<3;index++){f.emit(f.snapshot({leases:[]}));await turn();}expect(acquisitions()).toBe(before+1);expect(f.originalEnqueue).not.toHaveBeenCalled();f.finish();await vi.waitFor(()=>expect(f.graph.nodes[0].data.params.prompt).toBe('Resume automatically'));expect(f.originalEnqueue).toHaveBeenCalledTimes(1);expect(f.runtime.presence.hasPending()).toBe(false);expect(new DraftJournal(()=>window.localStorage).list('user','project')).toHaveLength(0);expect(f.storage.captureDraft).toHaveBeenCalled();
});
it('stops automatic resumption after a released lease exposes a real same-field conflict',async()=>{
 const f=fixture({occupied:true}),notice=vi.fn();dispose=installNativePresence(f.runtime,f.native,notice);await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.manager.patchNodeData('node',{params:{prompt:'Retain local intent'}});await turn();await turn();expect(f.runtime.presence.hasPending()).toBe(true);f.graph.nodes[0].data.params.prompt='A different peer edit';f.setOccupied(false);f.emit(f.snapshot({leases:[]}));await vi.waitFor(()=>expect(notice.mock.calls.some(([message])=>message.includes('同一节点的内容已更新'))).toBe(true));const acquisitions=()=>f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='POST').length,before=acquisitions();for(let index=0;index<3;index++){f.emit(f.snapshot({leases:[]}));await turn();}expect(acquisitions()).toBe(before);expect(f.graph.nodes[0].data.params.prompt).toBe('A different peer edit');expect(f.originalEnqueue).not.toHaveBeenCalled();expect(f.runtime.presence.hasPending()).toBe(true);expect(new DraftJournal(()=>window.localStorage).list('user','project')[0].graph.nodes[0].data.params.prompt).toBe('Retain local intent');expect(document.querySelector('.studio-presence-status')?.textContent).toContain('同一节点的内容已更新');
});
it('does not automatically retry an unknown network failure on later presence updates',async()=>{
 const f=fixture(),original=f.request.getMockImplementation()!;let acquisitions=0;f.request.mockImplementation(async(path,options:any={})=>{if(path.endsWith('/node-leases')&&options.method==='POST'&&++acquisitions===1)throw new TypeError('fixture network unavailable');return original(path,options);});dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.manager.patchNodeData('node',{params:{prompt:'Keep network draft'}});await turn();await turn();expect(f.runtime.presence.hasPending()).toBe(true);for(let index=0;index<3;index++){f.emit(f.snapshot({leases:[]}));await turn();}expect(acquisitions).toBe(1);expect(f.originalEnqueue).not.toHaveBeenCalled();expect(new DraftJournal(()=>window.localStorage).list('user','project')[0].graph.nodes[0].data.params.prompt).toBe('Keep network draft');await f.runtime.presence.flushPending();expect(acquisitions).toBe(2);expect(f.graph.nodes[0].data.params.prompt).toBe('Keep network draft');
});
it('does not resume a released-node intent after the project changes',async()=>{
 const f=fixture({occupied:true});dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const old=f.runtime.presence;f.manager.patchNodeData('node',{params:{prompt:'Original project only'}});await turn();await turn();const acquisitions=()=>f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='POST').length,before=acquisitions();f.setOccupied(false);f.switchProject();await turn();expect(old.state().status).toBe('offline');expect(f.originalEnqueue).not.toHaveBeenCalled();expect(acquisitions()).toBe(before);expect(new DraftJournal(()=>window.localStorage).list('user','project')[0].graph.nodes[0].data.params.prompt).toBe('Original project only');
});
it('keeps a released-node intent local after editing permission is revoked',async()=>{
 const f=fixture({occupied:true});dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.manager.patchNodeData('node',{params:{prompt:'Preserve after revoke'}});await turn();await turn();const before=f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='POST').length;f.storage.canEdit=()=>false;f.setOccupied(false);f.emit(f.snapshot({leases:[]}));await turn();await turn();expect(f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='POST')).toHaveLength(before);expect(f.originalEnqueue).not.toHaveBeenCalled();expect(f.runtime.presence.hasPending()).toBe(true);expect(new DraftJournal(()=>window.localStorage).list('user','project')[0].graph.nodes[0].data.params.prompt).toBe('Preserve after revoke');
});
it('does not replay an already applied edit after main-journal persistence temporarily fails',async()=>{
 const f=fixture(),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();f.storage.draftRecoveryState=()=>({persistence:'memory-only'});const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'Durable intent'}});await expect(guard.flushPending()).rejects.toMatchObject({code:'LOCAL_DRAFT_BACKUP_UNAVAILABLE'});expect(f.originalEnqueue).toHaveBeenCalledTimes(1);expect(guard.hasPending()).toBe(true);expect(new DraftJournal(()=>window.localStorage).list('user','project')).toHaveLength(1);
 f.storage.draftRecoveryState=()=>({persistence:'saved'});await guard.flushPending();expect(f.originalEnqueue).toHaveBeenCalledTimes(1);expect(guard.hasPending()).toBe(false);
});
it('leases every node in a multi-node move before touching their positions',async()=>{
 const f=fixture({delay:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);
 f.manager.enqueue({kind:'moveNodes',moves:[{nodeId:'node',position:{x:200,y:200}},{nodeId:'neighbor',position:{x:700,y:200}}]});await turn();expect(f.request.mock.calls.at(-1)![1].body.nodeIds).toEqual(['neighbor','node']);expect(f.graph.nodes[0].position).toEqual({x:100,y:100});f.finish();await guard.flushPending();expect(f.graph.nodes[0].position).toEqual({x:200,y:200});
});
it('preserves queued edits and fences their application after the project changes',async()=>{
 const f=fixture({delay:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();let current=true;const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>current);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'Original project draft'}});await turn();current=false;f.finish();await expect(guard.flushPending()).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});expect(f.graph.nodes[0].data.params.prompt).toBe('Original text');guard.dispose();expect(new DraftJournal(()=>window.localStorage).list('user','project')).toHaveLength(1);
});
it('renders stable cursor DOM under pan/zoom, labels the occupied node, and never inserts peer names as HTML',async()=>{
 const f=fixture();document.body.innerHTML='<div class="studio-collab-readonly"></div><div class="react-flow"><div class="react-flow__viewport" style="transform:matrix(2,0,0,2,40,60)"><div class="react-flow__node" data-id="node"><textarea></textarea></div></div></div>';
 const canvas=document.querySelector('.react-flow')!,node=document.querySelector('.react-flow__node')!;vi.spyOn(canvas,'getBoundingClientRect').mockReturnValue({left:10,top:20,right:1010,bottom:720,width:1000,height:700} as DOMRect);vi.spyOn(node,'getBoundingClientRect').mockReturnValue({left:250,top:280,right:550,bottom:480,width:300,height:200} as DOMRect);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const member={clientId:'peer-page',userId:'peer',displayName:'<img src=x onerror=alert(1)>',role:'EDITOR' as const,cursor:{x:100,y:100},selectedNodeIds:['node'],lastSeenAt:new Date().toISOString()};
 f.emit(f.snapshot({members:[member],leases:[{nodeId:'node',clientId:'peer-page',userId:'peer',displayName:member.displayName,expiresAt:new Date(Date.now()+15000).toISOString()}]}));await vi.waitFor(()=>expect(document.querySelector('.studio-presence-cursor')).not.toBeNull());
 const cursor=document.querySelector('.studio-presence-cursor')!;expect((cursor as HTMLElement).style.transform).toBe('translate(250px,280px)');expect(cursor.querySelector('img')).toBeNull();expect(cursor.textContent).toBe(member.displayName);expect(document.querySelector('.studio-presence-node')?.textContent).toContain('正在编辑');
 f.emit(f.snapshot({members:[{...member,cursor:{x:120,y:100}}],leases:[]}));await vi.waitFor(()=>expect((cursor as HTMLElement).style.transform).toBe('translate(290px,280px)'));expect(document.querySelector('.studio-presence-cursor')).toBe(cursor);
 expect(canvasTransform(document)!.canvas({x:290,y:280})).toEqual({x:120,y:100});
});
it('does not replay an expired pointer intent after a project switch',async()=>{
 const f=fixture({delay:true});document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="node"><button>编辑</button></div></div></div>';const action=vi.fn(),button=document.querySelector('button')!;button.addEventListener('click',action);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse'}));await turn();f.switchProject();f.finish();await turn();expect(action).not.toHaveBeenCalled();
});

it('replays one completed tap after acquisition without a second click or a duplicate native click',async()=>{
 const f=fixture({delay:true});document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="node"><button>编辑</button></div></div></div>';const button=document.querySelector('button')!,action=vi.fn();button.addEventListener('click',action);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));
 button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse'}));await turn();window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,buttons:0,pointerId:1,pointerType:'mouse'}));button.click();expect(action).not.toHaveBeenCalled();f.finish();await vi.waitFor(()=>expect(action).toHaveBeenCalledTimes(1));button.click();expect(action).toHaveBeenCalledTimes(1);
});
it('cancels a waiting gesture on blur instead of replaying a stale action',async()=>{
 const f=fixture({delay:true});document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="node"><button>编辑</button></div></div></div>';const button=document.querySelector('button')!,action=vi.fn();button.addEventListener('mousedown',action);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse'}));await turn();window.dispatchEvent(new Event('blur'));f.finish();await turn();expect(action).not.toHaveBeenCalled();
});
it('completes a first touch tap when its lease arrives before the finger is lifted',async()=>{
 const f=fixture({delay:true});document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="node"><button>编辑</button></div></div></div>';const button=document.querySelector('button')!,action=vi.fn();button.addEventListener('click',action);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));
 button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:3,pointerType:'touch',clientX:20,clientY:20}));await turn();f.finish();await vi.waitFor(()=>expect(f.runtime.presence.owns(['node'])).toBe(true));expect(action).not.toHaveBeenCalled();
 window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,buttons:0,pointerId:3,pointerType:'touch',clientX:20,clientY:20}));button.click();expect(action).toHaveBeenCalledTimes(1);
});
it('does not advance native history before acquiring all affected nodes',async()=>{
 const f=fixture({delay:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();const state:any={historyIndex:1,historyStack:[{nodes:structuredClone(f.graph.nodes),edges:[]},{nodes:structuredClone(f.graph.nodes),edges:[]}]};state.historyStack[1].nodes[0].data.params.prompt='Edited';const undo=vi.fn(()=>state.historyIndex--);state.undo=undo;f.native.fA={getState:()=>state,setState:(patch:any)=>Object.assign(state,patch)};
 const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);state.undo();await turn();expect(state.historyIndex).toBe(1);expect(undo).not.toHaveBeenCalled();f.finish();await guard.flushPending();expect(undo).toHaveBeenCalledTimes(1);expect(state.historyIndex).toBe(0);
});
it('keeps service journal undo behind node leases even when native menu history is only a count projection',async()=>{
 const f=fixture({delay:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();
 const undo=vi.fn();Object.assign(f.manager,{localOnly:true,undoManager:{},undo});const state:any={historyIndex:1,historyStack:[null,null],undo:vi.fn()};f.native.fA={getState:()=>state,setState:(patch:any)=>Object.assign(state,patch)};
 const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);state.undo();await turn();expect(undo).not.toHaveBeenCalled();f.finish();await guard.flushPending();expect(undo).toHaveBeenCalledTimes(1);
});

it('preserves unrelated newer params when a whole native form waits for a lease',async()=>{
 const f=fixture({occupied:true});f.graph.nodes[0].data.params={prompt:'Original text',strength:1};f.storage.snapshots.set('project',{projectId:'project',revision:1,graph:encodeGraph(f.graph)});
 const client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'Local text',strength:1}});await expect(guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 f.graph.nodes[0].data.params.strength=2;f.setOccupied(false);await guard.flushPending();
 expect(f.graph.nodes[0].data.params).toEqual({prompt:'Local text',strength:2});
});
it('clears pending intent only after its exact journal version was consumed by successful recovery',async()=>{
 const f=fixture({occupied:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'First waiting edit'}});await expect(guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 const journal=new DraftJournal(()=>window.localStorage),first=journal.list('user','project')[0];
 f.manager.patchNodeData('node',{params:{prompt:'Newest waiting edit'}});await expect(guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});const latest=journal.list('user','project')[0];
 journal.markResolved(first);expect(guard.hasPending()).toBe(true);expect(journal.isResolved(latest)).toBe(false);
 journal.markResolved(latest);expect(guard.hasPending()).toBe(false);await guard.flushPending();expect(f.originalEnqueue).not.toHaveBeenCalled();expect(journal.list('user','project')).toEqual([]);
});
it('does not interpret deleting a pending backup as choosing to discard the in-memory edit',async()=>{
 const f=fixture({occupied:true}),client=new CanvasPresenceClient(f.api,'project','user',()=>true,()=>true);cleanups.push(()=>client.stop());await client.start();const guard=guardNativePresenceMutations(f.runtime,f.native,f.manager,client,vi.fn(),()=>true);cleanups.push(guard.dispose);
 f.manager.patchNodeData('node',{params:{prompt:'Waiting edit'}});await expect(guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 disk.rows.clear();expect(guard.hasPending()).toBe(true);
});

it('cleans up a completed page on pagehide and rebuilds a fresh client on BFCache restore',async()=>{
 const f=fixture();dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const first=f.runtime.presence,oldId=first.clientId,streamSignal=f.api.rawV2.mock.calls[0][1].signal;
 window.dispatchEvent(pageTransition('pagehide'));expect(streamSignal.aborted).toBe(true);expect(first.state().status).toBe('offline');expect(document.querySelector<HTMLElement>('.studio-presence-panel')!.hidden).toBe(true);expect(f.request.mock.calls.filter(([path])=>path==='/projects/project/presence/'+oldId)).toHaveLength(1);
 window.dispatchEvent(pageTransition('pageshow'));await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));expect(f.runtime.presence.clientId).not.toBe(oldId);expect(f.runtime.presence.owns(['node'])).toBe(false);expect(f.request.mock.calls.filter(([path])=>path==='/projects/project/presence/'+f.runtime.presence.clientId)).toHaveLength(0);
});
it.each([false,true])('does not let an old hidden save release a fresh foreground lease (hidden again: %s)',async hiddenAgain=>{
 const f=fixture();let visibility:DocumentVisibilityState='visible',finish!:()=>void;vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
 const saved=new Promise<void>(resolve=>finish=resolve);f.runtime.waitForSave.mockReturnValueOnce(saved).mockReturnValue(new Promise<void>(()=>{}));dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));
 visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));expect(f.runtime.waitForSave).toHaveBeenCalledTimes(1);
 visibility='visible';document.dispatchEvent(new Event('visibilitychange'));await f.runtime.presence.acquire(['node']);expect(f.runtime.presence.owns(['node'])).toBe(true);
 if(hiddenAgain){visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));expect(f.runtime.waitForSave).toHaveBeenCalledTimes(2);}
 finish();await turn();expect(f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='DELETE')).toHaveLength(0);expect(f.runtime.presence.owns(['node'])).toBe(true);
});
it('releases a hidden page lease after its save finishes when there was no newer activity',async()=>{
 const f=fixture();let visibility:DocumentVisibilityState='visible',finish!:()=>void;vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
 const saved=new Promise<void>(resolve=>finish=resolve);f.runtime.waitForSave.mockReturnValue(saved);dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));await f.runtime.presence.acquire(['node']);
 visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));expect(f.request.mock.calls.some(([path,options])=>path.endsWith('/node-leases')&&options.method==='DELETE')).toBe(false);finish();
 await vi.waitFor(()=>expect(f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='DELETE')).toHaveLength(1));expect(f.runtime.presence.owns(['node'])).toBe(false);
});
it('retains a lease when an accepted background edit arrives while the hidden save is pending',async()=>{
 const f=fixture();let visibility:DocumentVisibilityState='visible',finish!:()=>void;vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
 const saved=new Promise<void>(resolve=>finish=resolve);f.runtime.waitForSave.mockReturnValue(saved);dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));await f.runtime.presence.acquire(['node']);
 visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));f.manager.patchNodeData('node',{params:{prompt:'New background edit'}});f.manager.flushOperationQueue(true);expect(f.graph.nodes[0].data.params.prompt).toBe('New background edit');finish();await turn();
 expect(f.request.mock.calls.filter(([path,options])=>path.endsWith('/node-leases')&&options.method==='DELETE')).toHaveLength(0);expect(f.runtime.presence.owns(['node'])).toBe(true);
});
it.each(['queued-edit','pending-save'])('preserves %s leases until expiry when the page is suspended',async pending=>{
 const f=fixture({delay:pending==='queued-edit'});dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const old=f.runtime.presence;
 if(pending==='queued-edit'){f.manager.patchNodeData('node',{params:{prompt:'Keep this local draft'}});await turn();expect(old.hasPending()).toBe(true);}else f.storage.hasPending=()=>true;
 window.dispatchEvent(pageTransition('pagehide'));expect(old.state().status).toBe('offline');expect(f.request.mock.calls.some(([path])=>path==='/projects/project/presence/'+old.clientId)).toBe(false);if(pending==='queued-edit')expect(new DraftJournal(()=>window.localStorage).list('user','project')).toHaveLength(1);
});
it('keeps an accepted pending edit in memory across BFCache and fences the old client reply',async()=>{
 const f=fixture({delay:true}),notice=vi.fn();dispose=installNativePresence(f.runtime,f.native,notice);await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const old=f.runtime.presence;
 f.manager.patchNodeData('node',{params:{prompt:'Uncommitted local input'}});await turn();window.dispatchEvent(pageTransition('pagehide'));window.dispatchEvent(pageTransition('pageshow'));await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));expect(f.runtime.presence.clientId).not.toBe(old.clientId);expect(f.runtime.presence.hasPending()).toBe(true);
 f.finish();await turn();expect(f.graph.nodes[0].data.params.prompt).toBe('Original text');expect(f.originalEnqueue).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();f.setDelay(false);await f.runtime.presence.flushPending();expect(f.graph.nodes[0].data.params.prompt).toBe('Uncommitted local input');expect(f.originalEnqueue).toHaveBeenCalledTimes(1);expect(f.runtime.presence.hasPending()).toBe(false);
});
it('can leave a detached old route but never sends the old user leave under a new identity',async()=>{
 const f=fixture();dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const oldId=f.runtime.presence.clientId;f.switchProject();expect(f.request.mock.calls.some(([path])=>path==='/projects/project/presence/'+oldId)).toBe(true);dispose();dispose=undefined;
 const other=fixture();dispose=installNativePresence(other.runtime,other.native,vi.fn());await vi.waitFor(()=>expect(other.runtime.presence?.state().status).toBe('connected'));const oldUserId=other.runtime.presence.clientId;other.runtime.auth.user={id:'different-user'};window.dispatchEvent(new Event('rhtv:canvas-attachment'));expect(other.request.mock.calls.some(([path])=>path==='/projects/project/presence/'+oldUserId)).toBe(false);
});
it('aggregates people after refresh while keeping another own page cursor and lease explicit',async()=>{
 const f=fixture();document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport" style="transform:matrix(1,0,0,1,0,0)"><div class="react-flow__node" data-id="node"></div></div></div>';vi.spyOn(document.querySelector('.react-flow')!,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:1000,bottom:700,width:1000,height:700} as DOMRect);vi.spyOn(document.querySelector('.react-flow__node')!,'getBoundingClientRect').mockReturnValue({left:100,top:100,right:300,bottom:300,width:200,height:200} as DOMRect);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const own=f.snapshot().members[0],another={...own,clientId:'own-another-page',cursor:{x:100,y:100},lastSeenAt:new Date(f.runtime.presence.joinedAt+1).toISOString()},peer={...own,clientId:'peer-one',userId:'peer',displayName:'另一位同事'};
 f.emit(f.snapshot({members:[own,another,peer,{...peer,clientId:'peer-two'}],leases:[{nodeId:'node',clientId:another.clientId,userId:'user',displayName:own.displayName,expiresAt:new Date(Date.now()+15000).toISOString()}]}));await vi.waitFor(()=>expect(document.querySelector('.studio-presence-toggle')?.textContent).toContain('在线 2 人'));
 expect(document.querySelectorAll('[data-presence-member]')).toHaveLength(2);expect(document.querySelectorAll('.studio-presence-avatar')).toHaveLength(1);expect(document.querySelector('[data-presence-user="user"]')?.textContent).toContain('2 个页面');expect(document.querySelector('.studio-presence-cursor')?.textContent).toContain('你·另一页面');expect(document.querySelector('.studio-presence-node')?.textContent).toContain('你·另一页面');expect(f.runtime.presence.owns(['node'])).toBe(false);
});

it('hides a same-user refresh cursor that has not advanced beyond this page join while retaining its lease and other users',async()=>{
 const f=fixture();document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="node"></div></div></div>';vi.spyOn(document.querySelector('.react-flow')!,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:1000,bottom:700,width:1000,height:700} as DOMRect);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const baseline=f.runtime.presence.joinedAt,own=f.snapshot().members[0],stale={...own,clientId:'old-refresh-page',cursor:{x:10,y:20},lastSeenAt:new Date(baseline).toISOString()},other={...stale,clientId:'different-user-page',userId:'other',displayName:'另一位成员'},lease={nodeId:'node',clientId:stale.clientId,userId:'user',displayName:own.displayName,expiresAt:new Date(Date.now()+15000).toISOString()};
 f.emit(f.snapshot({members:[own,stale,other],leases:[lease]}));await vi.waitFor(()=>expect(f.runtime.presence.state().snapshot.members).toHaveLength(3));expect(document.querySelectorAll('.studio-presence-cursor')).toHaveLength(1);expect(document.querySelector('.studio-presence-cursor')?.textContent).toBe('另一位成员');expect(document.querySelector('.studio-presence-node')?.textContent).toContain('你·另一页面');expect(f.runtime.presence.holder('node')?.clientId).toBe(stale.clientId);expect(f.runtime.presence.owns(['node'])).toBe(false);expect(document.querySelectorAll('[data-presence-member]')).toHaveLength(2);
});
it('reveals a genuine same-user other page once its heartbeat or cursor activity passes the join baseline',async()=>{
 const f=fixture();document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="node"></div></div></div>';vi.spyOn(document.querySelector('.react-flow')!,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:1000,bottom:700,width:1000,height:700} as DOMRect);
 dispose=installNativePresence(f.runtime,f.native,vi.fn());await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const baseline=f.runtime.presence.joinedAt,own=f.snapshot().members[0],peer={...own,clientId:'live-other-page',cursor:{x:10,y:20},lastSeenAt:new Date(baseline-1).toISOString()},lease={nodeId:'node',clientId:peer.clientId,userId:'user',displayName:own.displayName,expiresAt:new Date(Date.now()+15000).toISOString()};
 f.emit(f.snapshot({members:[own,peer],leases:[lease]}));await vi.waitFor(()=>expect(f.runtime.presence.state().snapshot.members).toHaveLength(2));expect(document.querySelector('.studio-presence-cursor')).toBeNull();f.emit(f.snapshot({members:[own,{...peer,lastSeenAt:new Date(baseline+1).toISOString(),cursor:{x:30,y:40}}],leases:[lease]}));await vi.waitFor(()=>expect(document.querySelector('.studio-presence-cursor')?.textContent).toContain('你·另一页面'));expect(document.querySelector<HTMLElement>('.studio-presence-cursor')?.style.transform).toBe('translate(30px,40px)');expect(f.runtime.presence.holder('node')?.clientId).toBe(peer.clientId);expect(f.runtime.presence.owns(['node'])).toBe(false);expect(document.querySelector('.studio-presence-toggle')?.textContent).toContain('在线 1 人');
});
