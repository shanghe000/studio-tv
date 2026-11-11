// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {guardNativePresenceMutations} from '../../apps/web/src/service/native-presence';
import {DraftJournal} from '../../apps/web/src/service/draft-journal';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';
import {MemoryDraftStorage} from './draft-journal-fixture';

const initial=():NativeGraph=>({nodes:[{id:'a',type:'rh-text',position:{x:0,y:0},data:{text:'A original'}},{id:'b',type:'rh-text',position:{x:200,y:0},data:{text:'B original'}}],edges:[]});
const disposers:(()=>void)[]=[];
afterEach(()=>{for(const dispose of disposers.splice(0))dispose();vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(){
 const disk=new MemoryDraftStorage();vi.stubGlobal('localStorage',disk);
 let graph=initial(),occupied=true;const raw:any[]=[],snapshots=new Map([['p',{projectId:'p',revision:1,graph:encodeGraph(graph)}]]);
 const manager={getRemoteData:()=>graph,enqueue:vi.fn((op:any)=>raw.push(op)),flushOperationQueue:()=>{while(raw.length){const op=raw.shift(),node=graph.nodes.find(node=>node.id===op.nodeId);if(op.kind==='patchNodeData'&&node)node.data={...node.data,...op.patch};}}};
 const client:any={projectId:'p',userId:'user',clientId:'page',owns:()=>false,acquire:async()=>{if(occupied)throw new ApiError(409,'NODE_EDIT_OCCUPIED','Other editor holds A');}};
 const runtime:any={storage:{snapshots,canEdit:()=>true,encodeAsset:(value:string)=>value,refreshDraftBackups:vi.fn(),captureDraft:vi.fn(),draftRecoveryState:()=>({persistence:'saved'}),hasPending:()=>false}};
 const guard=guardNativePresenceMutations(runtime,{},manager,client,vi.fn(),()=>true);disposers.push(guard.dispose);
 return{disk,manager,runtime,guard,setOccupied:(value:boolean)=>occupied=value,setNative:(next:NativeGraph)=>graph=next,setRemote:(next:NativeGraph)=>snapshots.set('p',{projectId:'p',revision:2,graph:encodeGraph(next)})};
}

it('keeps untouched newer remote nodes when restoring a lease buffer captured before native sync applies',async()=>{
 const f=setup(),remote=initial();remote.nodes[1].data.text='B edited remotely';remote.nodes.push({id:'remote-only',type:'rh-text',position:{x:400,y:0},data:{text:'Remote created'}});f.setRemote(remote);
 f.manager.enqueue({kind:'patchNodeData',nodeId:'a',patch:{text:'A buffered local'}});await expect(f.guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 const backup=new DraftJournal(()=>f.disk).list('user','p')[0];expect(backup).toBeDefined();
 const restored=mergeCanvasDraft(backup.base!,backup.graph,remote);
 expect(restored.graph.nodes.find(node=>node.id==='b')?.data.text).toBe('B edited remotely');expect(restored.graph.nodes.some(node=>node.id==='remote-only')).toBe(true);expect(restored.graph.nodes.find(node=>node.id==='a')?.data.text).toBe('A buffered local');
});

it('does not silently replay a stale same-field buffered patch after another editor changes the native node',async()=>{
 const f=setup();f.manager.enqueue({kind:'patchNodeData',nodeId:'a',patch:{text:'A buffered local'}});await expect(f.guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 const remote=initial();remote.nodes[0].data.text='A later remote input';f.setRemote(remote);f.setNative(remote);f.setOccupied(false);
 await f.guard.flushPending().catch(()=>{});
 expect(f.manager.getRemoteData().nodes[0].data.text).toBe('A later remote input');
 expect(f.guard.hasPending()).toBe(true);
 const backup=new DraftJournal(()=>f.disk).list('user','p')[0];expect(backup.graph.nodes[0].data.text).toBe('A buffered local');
});

it('keeps later edits to a remotely created node while an older node edit is still buffered',async()=>{
 const f=setup();f.manager.enqueue({kind:'patchNodeData',nodeId:'a',patch:{text:'A buffered local'}});await expect(f.guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 const remote=initial();remote.nodes.push({id:'new',type:'rh-text',position:{x:400,y:0},data:{text:'Remote-created input'}});f.setRemote(remote);f.setNative(remote);
 f.manager.enqueue({kind:'patchNodeData',nodeId:'new',patch:{text:'My new node edit'}});await expect(f.guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});
 const backup=new DraftJournal(()=>f.disk).list('user','p')[0];expect(backup.graph.nodes.find(node=>node.id==='new')?.data.text).toBe('My new node edit');
 f.setOccupied(false);await f.guard.flushPending();expect(f.manager.getRemoteData().nodes.find(node=>node.id==='new')?.data.text).toBe('My new node edit');
});
