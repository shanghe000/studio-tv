// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL as NodeURL} from 'node:url';
import {ApiError} from '../../apps/web/src/api/client';
import {guardNativePresenceMutations} from '../../apps/web/src/service/native-presence';
import {DraftJournal} from '../../apps/web/src/service/draft-journal';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {inspectCanvasConnection} from '../../apps/web/src/service/connection-readiness';
import {MemoryDraftStorage} from './draft-journal-fixture';

const disposers:(()=>void)[]=[];
afterEach(()=>{for(const dispose of disposers.splice(0))dispose();vi.restoreAllMocks();vi.unstubAllGlobals();});
const node=(id:string,type='rh-text')=>({id,type,position:{x:0,y:0},data:{text:id}});
const edge=(id:string,source:string,target:string)=>({id,source,target,sourceHandle:'output',targetHandle:'input'});
function setup(seed:NativeGraph={nodes:[node('a'),node('b'),node('c')],edges:[]}){
 const disk=new MemoryDraftStorage();vi.stubGlobal('localStorage',disk);let graph=structuredClone(seed),denied=false,wait:Promise<void>|undefined;const owned=new Set<string>(),pending:any[]=[],transactions:string[]=[];
 const flush=()=>{while(pending.length){const op=pending.shift();transactions.push(op.kind);if(op.kind==='pasteGraph'){
  for(const value of op.nodes)if(!graph.nodes.some(node=>node.id===value.id))graph.nodes.push(structuredClone(value));for(const value of op.edges)if(!graph.edges.some(edge=>edge.id===value.id)&&graph.nodes.some(node=>node.id===value.source)&&graph.nodes.some(node=>node.id===value.target))graph.edges.push(structuredClone(value));
 }else if(op.kind==='addNode'){if(!graph.nodes.some(node=>node.id===op.node.id))graph.nodes.push(structuredClone(op.node));
 }else if(op.kind==='patchNodeData'){const target=graph.nodes.find(node=>node.id===op.nodeId);if(target)target.data={...target.data,...structuredClone(op.patch)};
 }else if(op.kind==='addEdge'){if(graph.nodes.find(node=>node.id===op.edge.target)?.type==='rh-director')graph.edges=graph.edges.filter(edge=>edge.target!==op.edge.target||edge.source===op.edge.source);graph.edges.push(structuredClone(op.edge));
 }else if(op.kind==='removeEdge')graph.edges=graph.edges.filter(edge=>edge.id!==op.edgeId);}};
 const enqueue=vi.fn((operation:any,immediate=false)=>{pending.push(operation);if(immediate)flush();return true;}),manager:any={getRemoteData:()=>graph,enqueue,flushOperationQueue:flush,pasteGraph(nodes:any[],edges:any[],options:any={}){if(nodes.length)return this.enqueue({kind:'pasteGraph',nodes,edges},options.immediate);},patchNodeData(id:string,patch:any){return this.enqueue({kind:'patchNodeData',nodeId:id,patch});},addEdge(value:any,options:any={}){if(options.immediate){flush();pending.push({kind:'addEdge',edge:value});flush();return true;}return this.enqueue({kind:'addEdge',edge:value});},removeEdge(id:string){return this.enqueue({kind:'removeEdge',edgeId:id});}};
 const compiled=readFileSync(new NodeURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),a=compiled.indexOf('addNode(t){this.enqueue({kind:"addNode"'),b=compiled.indexOf('}removeNode(',a);if(a<0||b<0)throw Error('Frozen addNode seam changed');manager.addNode=new Function('thn','return function(t){'+compiled.slice(a+'addNode(t){'.length,b)+'}')( (_type:string,data:any)=>data );
 const holders=new Map<string,any>(),acquire=vi.fn(async(ids:string[])=>{if(wait)await wait;if(denied)throw new ApiError(409,'NODE_EDIT_OCCUPIED','其他成员正在编辑。');for(const id of ids)owned.add(id);}),client:any={projectId:'p',userId:'user',clientId:'page',owns:(ids:string[])=>ids.every(id=>owned.has(id)),acquire,state:()=>({status:'connected'}),holder:(id:string)=>holders.get(id)};
 const runtime:any={storage:{snapshots:new Map([['p',{projectId:'p',revision:1,graph:encodeGraph(seed)}]]),canEdit:()=>true,encodeAsset:(value:string)=>value,captureDraft:vi.fn(),refreshDraftBackups:vi.fn(),draftRecoveryState:()=>({persistence:'saved'})}};
 const notice=vi.fn(),guard=guardNativePresenceMutations(runtime,{},manager,client,notice,()=>true);disposers.push(guard.dispose);
 return{manager,guard,enqueue,acquire,owned,holders,notice,disk,transactions,runtime,graph:()=>graph,setGraph:(value:NativeGraph)=>{graph=structuredClone(value);},deny:(value:boolean)=>{denied=value;},wait:(value:Promise<void>)=>{wait=value;},backups:()=>new DraftJournal(()=>disk).list('user','p')};
}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}

it('recognizes the frozen pasteGraph seam that connects a new result to an existing source',()=>{
 const compiled=readFileSync(new NodeURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');expect(compiled).toContain('pasteGraph(t,n,r){t.length&&this.enqueue({kind:"pasteGraph",nodes:t,edges:n},r?.immediate)}');expect(compiled).toContain('source:n.id,target:f,sourceHandle:"output",targetHandle:"input",type:"default"};Ln().pasteGraph([v],[x],{immediate:!0})');
});
it.each(['new-source','new-target'])('leases the existing endpoint before an atomic paste with %s',async direction=>{
 const f=setup(),wait=gate();f.wait(wait.promise);const result=node('result'),connection=direction==='new-source'?edge('connect','result','a'):edge('connect','a','result');f.manager.pasteGraph([result],[connection],{immediate:true});expect(f.enqueue).not.toHaveBeenCalled();expect(f.graph().nodes.some(node=>node.id==='result')).toBe(false);expect(f.graph().edges).toEqual([]);expect(f.acquire).toHaveBeenCalledWith(['a']);expect(f.guard.hasPending()).toBe(true);expect(f.backups()[0].graph.nodes.some(node=>node.id==='result')).toBe(true);expect(f.backups()[0].graph.edges).toEqual([connection]);wait.resolve();await f.guard.flushPending();expect(f.enqueue).toHaveBeenCalledTimes(1);expect(f.enqueue.mock.calls[0][1]).toBe(true);expect(f.transactions).toEqual(['pasteGraph']);expect(f.graph().edges).toEqual([connection]);expect(f.guard.hasPending()).toBe(false);expect(f.backups()).toEqual([]);
});
it('retains the entire denied paste in the lease journal without changing the production graph',async()=>{
 const f=setup();f.deny(true);const connection=edge('connect','a','result');f.manager.pasteGraph([node('result')],[connection],{immediate:true});await expect(f.guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});expect(f.enqueue).not.toHaveBeenCalled();expect(f.graph().nodes.map(node=>node.id)).toEqual(['a','b','c']);expect(f.graph().edges).toEqual([]);expect(f.backups()[0].graph.edges).toEqual([connection]);expect(f.backups()[0].graph.nodes.find(node=>node.id==='result')).toBeDefined();f.deny(false);await f.guard.flushPending();expect(f.transactions).toEqual(['pasteGraph']);expect(f.graph().edges).toEqual([connection]);expect(f.guard.hasPending()).toBe(false);
});
it('automatically resumes a paste only after every existing endpoint is available',async()=>{
 const f=setup();f.deny(true);f.manager.pasteGraph([node('new')],[edge('from-a','a','new'),edge('to-b','new','b')],{immediate:true});await expect(f.guard.flushPending()).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});f.deny(false);f.holders.set('a',{clientId:'peer-a',userId:'peer'});f.holders.set('b',{clientId:'peer-b',userId:'peer'});const before=f.acquire.mock.calls.length;expect(f.guard.resumeWaiting()).toBeUndefined();f.holders.delete('a');expect(f.guard.resumeWaiting()).toBeUndefined();expect(f.acquire).toHaveBeenCalledTimes(before);expect(f.enqueue).not.toHaveBeenCalled();f.holders.delete('b');await f.guard.resumeWaiting();expect(f.transactions).toEqual(['pasteGraph']);expect(f.guard.hasPending()).toBe(false);expect(f.backups()).toEqual([]);
});
it('acquires every existing endpoint of a pasted transaction before applying any node or edge',async()=>{
 const f=setup(),wait=gate();f.wait(wait.promise);const connections=[edge('a-new','a','new'),edge('new-b','new','b'),edge('old-pair','b','c')];f.manager.pasteGraph([node('new')],connections,{immediate:true});expect(f.acquire).toHaveBeenCalledWith(['a','b','c']);expect(f.transactions).toEqual([]);wait.resolve();await f.guard.flushPending();expect(f.transactions).toEqual(['pasteGraph']);expect(f.graph().edges).toEqual(connections);
});
it('leaves a wholly new self-contained paste independent of existing-node leases',()=>{
 const f=setup();f.deny(true);f.manager.pasteGraph([node('new-a'),node('new-b')],[edge('new-only','new-a','new-b')],{immediate:true});expect(f.acquire).not.toHaveBeenCalled();expect(f.transactions).toEqual(['pasteGraph']);expect(f.guard.hasPending()).toBe(false);expect(f.graph().nodes).toHaveLength(5);
});
it('does not overwrite ID collisions while retaining only the actual new pasted values',async()=>{
 const original=edge('original','a','b'),f=setup({nodes:[node('a'),node('b'),node('c')],edges:[original]});f.manager.pasteGraph([{...node('a'),data:{text:'Must not replace A'}},node('new')],[{...original,source:'c'},edge('new-edge','a','new')],{immediate:true});await f.guard.flushPending();expect(f.acquire).toHaveBeenCalledWith(['a']);expect(f.graph().nodes.find(node=>node.id==='a')?.data.text).toBe('a');expect(f.graph().edges).toEqual([original,edge('new-edge','a','new')]);
});
it('queues a follow-up edit of a pending pasted node until its creation transaction has applied',async()=>{
 const f=setup(),wait=gate();f.wait(wait.promise);f.manager.pasteGraph([node('new')],[edge('connect','a','new')],{immediate:true});f.manager.patchNodeData('new',{text:'Latest text on new node'});expect(f.enqueue).not.toHaveBeenCalled();expect(f.backups()[0].graph.nodes.find(node=>node.id==='new')?.data.text).toBe('Latest text on new node');wait.resolve();await f.guard.flushPending();expect(f.transactions).toEqual(['pasteGraph','patchNodeData']);expect(f.graph().nodes.find(node=>node.id==='new')?.data.text).toBe('Latest text on new node');expect(f.graph().edges).toEqual([edge('connect','a','new')]);
});
it('removes a pending pasted connection after creation instead of resurrecting a canceled edge',async()=>{
 const f=setup(),wait=gate();f.wait(wait.promise);f.manager.pasteGraph([node('new')],[edge('connect','a','new')],{immediate:true});f.manager.removeEdge('connect');expect(f.enqueue).not.toHaveBeenCalled();expect(f.backups()[0].graph.edges).toEqual([]);wait.resolve();await f.guard.flushPending();expect(f.transactions).toEqual(['pasteGraph','removeEdge']);expect(f.graph().nodes.some(node=>node.id==='new')).toBe(true);expect(f.graph().edges).toEqual([]);expect(f.guard.hasPending()).toBe(false);
});
it('rebases a buffered paste over unrelated remote edits without replacing the peer values',async()=>{
 const f=setup(),wait=gate();f.wait(wait.promise);f.manager.pasteGraph([node('new')],[edge('connect','a','new')],{immediate:true});const remote=structuredClone(f.graph());remote.nodes[1].data.text='Remote B edit';remote.nodes.push(node('remote-only'));f.setGraph(remote);wait.resolve();await f.guard.flushPending();expect(f.graph().nodes.find(node=>node.id==='b')?.data.text).toBe('Remote B edit');expect(f.graph().nodes.some(node=>node.id==='remote-only')).toBe(true);expect(f.graph().nodes.some(node=>node.id==='new')).toBe(true);expect(f.graph().edges).toEqual([edge('connect','a','new')]);
});
it.each(['add','remove','immediate-add'])('protects both existing endpoints before an %s edge operation',async operation=>{
 const original=edge('original','a','b'),f=setup({nodes:[node('a'),node('b'),node('c')],edges:operation==='remove'?[original]:[]}),wait=gate();f.wait(wait.promise);if(operation==='remove')f.manager.removeEdge('original');else f.manager.addEdge(original,{immediate:operation==='immediate-add'});expect(f.acquire).toHaveBeenCalledWith(['a','b']);expect(f.transactions).toEqual([]);wait.resolve();await f.guard.flushPending();expect(f.graph().edges).toEqual(operation==='remove'?[]:[original]);expect(f.guard.hasPending()).toBe(false);
});
it.each([false,true])('leases the old source too when a director input is replaced (immediate=%s)',async immediate=>{
 const f=setup({nodes:[node('a'),node('b'),node('director','rh-director')],edges:[edge('old-input','a','director')]}),wait=gate();f.owned.add('b');f.owned.add('director');f.wait(wait.promise);f.manager.addEdge(edge('replacement','b','director'),{immediate});expect(f.acquire).toHaveBeenCalledWith(['b','director','a']);expect(f.transactions).toEqual([]);expect(f.backups()[0].graph.edges).toEqual([edge('replacement','b','director')]);wait.resolve();await f.guard.flushPending();expect(f.graph().edges).toEqual([edge('replacement','b','director')]);expect(f.guard.hasPending()).toBe(false);
});

it.each(['held','pending'])('publishes the real frozen addNode before outer connection inspection (%s source lease)',async state=>{
 const f=setup(),wait=gate();if(state==='held')f.owned.add('a');else f.wait(wait.promise);const nativeAdd=f.manager.addEdge;f.manager.addEdge=function(value:any,options:any){const check=inspectCanvasConnection(value,f.graph(),[]);if(!check.allowed)throw new ApiError(422,check.code!,check.reason!);return nativeAdd.call(this,value,options);};
 f.manager.addNode(node('new','rh-video'));expect(f.graph().nodes.some(node=>node.id==='new')).toBe(true);f.manager.addEdge(edge('new-connection','a','new'));if(state==='pending'){expect(f.graph().edges).toEqual([]);expect(f.acquire).toHaveBeenCalledWith(['a']);wait.resolve();await f.guard.flushPending();}else f.manager.flushOperationQueue(true);expect(f.graph().edges).toEqual([edge('new-connection','a','new')]);expect(f.acquire.mock.calls.flatMap(call=>call[0])).not.toContain('new');expect(f.guard.hasPending()).toBe(false);
});
it('still rejects a nonexistent connection target after publishing actual queued creations',()=>{
 const f=setup();f.manager.addNode(node('created','rh-video'));const check=inspectCanvasConnection(edge('forged','a','missing'),f.graph(),[]);expect(check).toMatchObject({allowed:false,code:'CONNECTION_NODE_MISSING'});expect(f.graph().edges).toEqual([]);
});

it('also leases a newly acknowledged endpoint when creation finishes during the first lease request',async()=>{
 const f=setup(),wait=gate();f.wait(wait.promise);f.manager.addNode(node('new','rh-video'));f.manager.addEdge(edge('after-creation','a','new'));expect(f.acquire).toHaveBeenCalledWith(['a']);f.runtime.storage.snapshots.set('p',{projectId:'p',revision:2,graph:encodeGraph(f.graph())});wait.resolve();await f.guard.flushPending();expect(f.acquire).toHaveBeenLastCalledWith(['a','new']);expect(f.graph().edges).toEqual([edge('after-creation','a','new')]);expect(f.guard.hasPending()).toBe(false);
});
