import {expect,it,vi} from 'vitest';
import {applyCanvasOperations,CanvasOperationSession,diffCanvasOperations,MAX_CANVAS_OPERATION_BYTES,validateCanvasOperations,type CanvasOperation,type CanvasOperationJournal} from '../../apps/web/src/service/canvas-operations';
import type {GraphNode,ProjectGraph} from '../../apps/web/src/api/types';
import {encodeGraph,decodeGraph} from '../../apps/web/src/service/graph';

const node=(id='target',data:any={prompt:'Initial',params:{outputPreset:'square',steps:20}}):GraphNode=>({id,type:'rh-image',position:{x:10,y:20},data});
const initial=():ProjectGraph=>({schemaVersion:'1',nodes:[node('source',{sourceObjects:['rhtv-asset:synthetic']}),node()],edges:[],viewport:{x:0,y:0,zoom:1}});
const edge=(id='edge',source='source',target='target')=>({id,source,target,sourceHandle:'output',targetHandle:'input'});
const snapshot=(graph:ProjectGraph,revision=1,projectId='project')=>({projectId,revision,graph});
function journal(){const rows=new Map<string,string>();return{rows,get length(){return rows.size;},key:(index:number)=>[...rows.keys()][index]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};}
function session(storage?:CanvasOperationJournal,clientId='page_a',createBatchId?:()=>string,userId='user',projectId='project'){
 let sequence=0;return new CanvasOperationSession({userId,projectId,clientId,storage,createBatchId:createBatchId??(()=>clientId+'_batch_'+(++sequence)),now:()=>1000});
}
const changed=(text:string)=>{const graph=initial();graph.nodes[1].data.prompt=text;return graph;};

it('diffs nested leaf edits and unset fields with arrays atomic, without mutating observations',()=>{
 const before=initial(),next=structuredClone(before);next.nodes[1].data.params.steps=30;delete next.nodes[1].data.params.outputPreset;next.nodes[1].data.references=['b','a'];next.viewport.zoom=2;
 const untouched=structuredClone(before),ops=diffCanvasOperations(before,next);expect(ops).toContainEqual({type:'node.patch',nodeId:'target',set:[{path:['data','params','steps'],value:30},{path:['data','references'],value:['b','a']}],unset:[['data','params','outputPreset']]});expect(ops).toContainEqual({type:'graph.patch',set:[{path:['viewport','zoom'],value:2}],unset:[]});expect(applyCanvasOperations(before,ops)).toEqual(next);expect(before).toEqual(untouched);
});

it('uses leaf paths for a newly added object so unrelated server fields survive',()=>{
 const before=initial(),next=structuredClone(before);next.nodes[1].data.options={quality:'high'};const remote=structuredClone(before);remote.nodes[1].data.options={seed:17};const ops=diffCanvasOperations(before,next);
 expect(ops).toEqual([{type:'node.patch',nodeId:'target',set:[{path:['data','options','quality'],value:'high'}],unset:[]}]);expect(applyCanvasOperations(remote,ops).nodes[1].data.options).toEqual({seed:17,quality:'high'});
});

it.each(['rh-image','rh-video'])('captures a new %s and its first connection in one immutable batch',type=>{
 const storage=journal(),s=session(storage);s.acceptSnapshot(snapshot(initial()));const next=initial();next.nodes.push({...node('new_target',{status:'idle'}),type});next.edges=[edge('new_edge','source','new_target')];const batch=s.observe(next)!;
 expect(batch.operations.map(op=>op.type)).toEqual(['node.create','edge.create']);expect(s.projected()).toEqual(next);expect(s.pendingCount).toBe(1);expect(storage.rows.size).toBe(1);const record=JSON.parse([...storage.rows.values()][0]);expect(record.format).toBe('OPERATION_OUTBOX');expect(record).not.toHaveProperty('graph');expect(record).not.toHaveProperty('base');expect(record).not.toHaveProperty('local');expect(record).not.toHaveProperty('remote');expect(s.observe(next)).toBeUndefined();expect(s.head()!.batchId).toBe(batch.batchId);
});

it('replaces a changed connection by deletion and creation without an independent whole graph',()=>{
 const before=initial();before.nodes.push(node('other'));before.edges=[edge()];const next=structuredClone(before);next.edges=[edge('edge','source','other')];const ops=diffCanvasOperations(before,next);expect(ops).toEqual([{type:'edge.delete',edgeId:'edge'},{type:'edge.create',edge:next.edges[0]}]);expect(applyCanvasOperations(before,ops)).toEqual(next);
});

it('deletes incident canonical edges idempotently and does not resurrect a remotely deleted patched node',()=>{
 const remote=initial();remote.nodes.push(node('remote'));remote.edges=[edge(),edge('new_remote_edge','remote','target')];const ops:CanvasOperation[]=[{type:'node.delete',nodeId:'target'},{type:'node.patch',nodeId:'target',set:[{path:['data','prompt'],value:'Retained intent'}],unset:[]}];const result=applyCanvasOperations(remote,ops);expect(result.nodes.map(row=>row.id)).toEqual(['source','remote']);expect(result.edges).toEqual([]);expect(applyCanvasOperations(result,ops)).toEqual(result);
});

it('keeps a canonical row when an unknown-outcome create is already present',()=>{
 const canonical=initial();canonical.nodes[1].data.progress=75;const result=applyCanvasOperations(canonical,[{type:'node.create',node:node()},{type:'edge.create',edge:edge()},{type:'edge.create',edge:edge()}]);expect(result.nodes).toHaveLength(2);expect(result.nodes[1].data.progress).toBe(75);expect(result.edges).toEqual([edge()]);
});

it('reorders only listed rows and retains server-only rows in the backend order',()=>{
 const canonical=initial();canonical.nodes.splice(1,0,node('remote_a'));canonical.nodes.push(node('remote_b'));canonical.edges=[edge('a'),edge('b'),edge('server_edge')];const result=applyCanvasOperations(canonical,[{type:'nodes.order',nodeIds:['target','source']},{type:'edges.order',edgeIds:['b','a']}]);expect(result.nodes.map(row=>row.id)).toEqual(['target','source','remote_a','remote_b']);expect(result.edges.map(row=>row.id)).toEqual(['b','a','server_edge']);
});

it('projects pending intent over remote progress and unrelated newly created content',()=>{
 const s=session();s.acceptSnapshot(snapshot(initial()));s.observe(changed('Retained edit'));const canonical=initial();canonical.nodes[0].data.progress=100;canonical.nodes.push(node('remote'));s.acceptSnapshot(snapshot(canonical,2));const projected=s.projected();expect(projected.nodes[1].data.prompt).toBe('Retained edit');expect(projected.nodes[0].data.progress).toBe(100);expect(projected.nodes[2].id).toBe('remote');
});

it('keeps later input after a late acknowledgement and does not regress a newer canonical snapshot',()=>{
 const storage=journal(),s=session(storage);s.acceptSnapshot(snapshot(initial()));const first=s.observe(changed('First edit'))!,second=s.observe(changed('Later edit'))!;const canonical=changed('First edit');canonical.nodes[0].data.progress=60;s.acceptSnapshot(snapshot(canonical,3));s.acknowledge(first.batchId,snapshot(changed('First edit'),2));expect(s.revision).toBe(3);expect(s.pending().map(batch=>batch.batchId)).toEqual([second.batchId]);expect(s.projected().nodes[1].data.prompt).toBe('Later edit');expect(s.projected().nodes[0].data.progress).toBe(60);expect(storage.rows.size).toBe(1);
});

it('reloads immutable intent under a new edit-session client and confirms an unknown outcome once',()=>{
 const storage=journal(),first=session(storage);first.acceptSnapshot(snapshot(initial()));const created=initial();created.nodes.push(node('new_target'));const batch=first.observe(created)!;const bytes=[...storage.rows.values()][0];
 const reloaded=session(storage,'page_b');const canonical=structuredClone(created);canonical.nodes.find(row=>row.id==='new_target')!.data.progress=80;reloaded.acceptSnapshot(snapshot(canonical,3));expect(reloaded.head()).toEqual({...batch,clientId:'page_b'});expect([...storage.rows.values()][0]).toBe(bytes);expect(reloaded.projected().nodes.filter(row=>row.id==='new_target')).toHaveLength(1);expect(reloaded.projected().nodes.find(row=>row.id==='new_target')!.data.progress).toBe(80);
 reloaded.acknowledge(batch.batchId,snapshot(created,2));expect(reloaded.pendingCount).toBe(0);expect(reloaded.revision).toBe(3);expect(storage.rows.size).toBe(0);expect(reloaded.projected()).toEqual(canonical);
});

it('preserves authored order across reload when the system clock moves backwards between edits',()=>{
 const storage=journal();let clock=5000,sequence=0;
 const s=new CanvasOperationSession({userId:'user',projectId:'project',clientId:'page_a',storage,now:()=>clock,createBatchId:()=>`clock_${++sequence}`});
 s.acceptSnapshot(snapshot(initial()));const first=s.observe(changed('First edit'))!;clock=1000;const second=s.observe(changed('Later edit after time correction'))!;
 const persisted=[...storage.rows.entries()].reverse();storage.rows.clear();for(const [key,value]of persisted)storage.rows.set(key,value);
 const reloaded=session(storage,'page_b');reloaded.acceptSnapshot(snapshot(initial()));
 expect(reloaded.pending().map(batch=>batch.batchId)).toEqual([first.batchId,second.batchId]);
 expect(reloaded.projected().nodes[1].data.prompt).toBe('Later edit after time correction');
 expect(reloaded.pending().map(batch=>batch.operations)).toEqual(s.pending().map(batch=>batch.operations));
});

it('does not replay records from a different actor or project',()=>{
 const storage=journal(),owner=session(storage);owner.acceptSnapshot(snapshot(initial()));owner.observe(changed('Private intent'));expect(session(storage,'page_b',undefined,'other_user').pendingCount).toBe(0);expect(session(storage,'page_b',undefined,'user','other_project').pendingCount).toBe(0);expect(storage.rows.size).toBe(1);
});

it('keeps independently created records from two pages and removes only the acknowledged batch key',()=>{
 const storage=journal(),a=session(storage,'page_a'),b=session(storage,'page_b');a.acceptSnapshot(snapshot(initial()));b.acceptSnapshot(snapshot(initial()));const first=a.observe(changed('Page A'))!,second=b.observe(changed('Page B'))!;expect(storage.rows.size).toBe(2);a.acknowledge(first.batchId,snapshot(changed('Page A'),2));expect(storage.rows.size).toBe(1);expect(JSON.parse([...storage.rows.values()][0]).batchId).toBe(second.batchId);expect(b.pendingCount).toBe(1);expect(session(storage,'page_c').pending().map(batch=>batch.batchId)).toEqual([second.batchId]);
});

it('does not delete a later page record when two reloads confirm the same earlier batch',()=>{
 const storage=journal(),original=session(storage,'page_a');original.acceptSnapshot(snapshot(initial()));const first=original.observe(changed('First intent'))!,a=session(storage,'page_b'),b=session(storage,'page_c');a.acceptSnapshot(snapshot(changed('First intent'),2));b.acceptSnapshot(snapshot(changed('First intent'),2));a.acknowledge(first.batchId,snapshot(changed('First intent'),2));const second=a.observe(changed('Later intent'))!;b.acknowledge(first.batchId,snapshot(changed('First intent'),2));expect(storage.rows.size).toBe(1);expect(JSON.parse([...storage.rows.values()][0]).batchId).toBe(second.batchId);
});

it('observes applied native data without turning a remote update into a new user operation',()=>{
 const s=session();s.acceptSnapshot(snapshot(initial()));const remote=initial();remote.nodes.push(node('remote'));s.acceptSnapshot(snapshot(remote,2));s.reobserve(remote);expect(s.observe(remote)).toBeUndefined();expect(s.pendingCount).toBe(0);
});

it('keeps operation IDs and values immutable across caller mutation and repeated transport reads',()=>{
 const s=session();s.acceptSnapshot(snapshot(initial()));const next=changed('Immutable intent'),batch=s.observe(next)!;next.nodes[1].data.prompt='Mutated caller';(batch.operations[0] as any).set[0].value='Mutated returned batch';(s.head()!.operations[0] as any).set[0].value='Mutated head';expect((s.pending()[0].operations[0] as any).set[0].value).toBe('Immutable intent');expect(s.head()!.batchId).toBe(batch.batchId);
});

it('retains in-memory intent and reports a failed durable write without claiming it is safe to close',()=>{
 const storage=journal();vi.spyOn(storage,'setItem').mockImplementation(()=>{throw Error('Quota exceeded');});const s=session(storage);s.acceptSnapshot(snapshot(initial()));const batch=s.observe(changed('In memory'))!;expect(s.storageError).toContain('保持此页面打开');expect(s.hasPending()).toBe(true);expect(s.head()!.batchId).toBe(batch.batchId);expect(s.projected().nodes[1].data.prompt).toBe('In memory');expect(storage.rows.size).toBe(0);
});

it('clears a temporary persistence warning only after every in-memory edit has a server receipt',()=>{
 const storage=journal(),write=vi.spyOn(storage,'setItem').mockImplementation(()=>{throw Error('Quota exceeded');}),s=session(storage);
 s.acceptSnapshot(snapshot(initial()));const first=s.observe(changed('First in memory'))!,second=s.observe(changed('Latest in memory'))!;
 write.mockRestore();s.acknowledge(first.batchId,snapshot(changed('First in memory'),2));expect(s.storageError).toBeTruthy();expect(s.hasPending()).toBe(true);
 s.acknowledge(second.batchId,snapshot(changed('Latest in memory'),3));expect(s.storageError).toBeUndefined();expect(s.hasPending()).toBe(false);
});

it('does not clear an unreadable retained record warning when another valid batch is confirmed',()=>{
 const storage=journal(),key='studiotv:canvas-operations:1:user:project:damaged';storage.setItem(key,'not-json');const s=session(storage);s.acceptSnapshot(snapshot(initial()));
 const valid=s.observe(changed('Valid later edit'))!;s.acknowledge(valid.batchId,snapshot(changed('Valid later edit'),2));expect(s.storageError).toBeTruthy();expect(storage.getItem(key)).toBe('not-json');
});

it('preserves malformed retained records and surfaces an error instead of deleting them',()=>{
 const storage=journal(),key='studiotv:canvas-operations:1:user:project:damaged';storage.setItem(key,'not-json');const s=session(storage);expect(s.storageError).toBeTruthy();expect(storage.getItem(key)).toBe('not-json');
});
it('never rewrites an already retained metadata-patch batch while repairing new observations',()=>{
 const storage=journal(),canonical=initial(),native=decodeGraph(canonical),before=encodeGraph(native);native.edges.push({id:'native:edge:source-output-target-input',source:'source',target:'target',sourceHandle:'output',targetHandle:'input'});const actual=encodeGraph(native),oldOperations=diffCanvasOperations(before,actual);expect(oldOperations.some(op=>op.type==='node.patch'&&op.nodeId==='rhtv_meta_v1')).toBe(true);
 const record={format:'OPERATION_OUTBOX',schemaVersion:'1',userId:'user',projectId:'project',batchId:'original_unknown',createdAt:1000,order:1,operations:oldOperations},key='studiotv:canvas-operations:1:user:project:original_unknown',bytes=JSON.stringify(record);storage.setItem(key,bytes);const s=session(storage);s.acceptSnapshot(snapshot(canonical));s.reobserve(actual);native.nodes[1].data.prompt='Later input while original submission remains unknown';s.observe(encodeGraph(native));expect(s.head()).toEqual({schemaVersion:'1',clientId:'page_a',batchId:'original_unknown',operations:oldOperations});expect(storage.getItem(key)).toBe(bytes);expect(s.pending()).toHaveLength(2);expect(s.pending()[1].operations.some(op=>op.type==='node.create'&&op.node.id==='rhtv_meta_v1')).toBe(false);
});

it('rejects inconsistent snapshot identity and same-revision content without changing the canonical state',()=>{
 const s=session();s.acceptSnapshot(snapshot(initial()));expect(()=>s.acceptSnapshot(snapshot(initial(),2,'other'))).toThrow();expect(()=>s.acceptSnapshot(snapshot(changed('Wrong same revision')))).toThrow();expect(s.revision).toBe(1);expect(s.projected()).toEqual(initial());
});

it.each([['id'],['data','__proto__'],['data','constructor'],['data','prototype']])('rejects unsafe or identity mutation paths %j',location=>{
 expect(()=>validateCanvasOperations([{type:'node.patch',nodeId:'target',set:[{path:location,value:'invalid'}],unset:[]}])).toThrow();
});

it('rejects oversized intent without advancing its native observation or persisting an incomplete batch',()=>{
 const storage=journal(),s=session(storage);s.acceptSnapshot(snapshot(initial()));expect(()=>s.observe(changed('x'.repeat(MAX_CANVAS_OPERATION_BYTES)))).toThrow();expect(s.pendingCount).toBe(0);expect(storage.rows.size).toBe(0);expect(s.observe(changed('Small edit'))).toBeDefined();
});

it('does not replay a batch already preserved on this device by another tab',()=>{
 const store=journal(),original=session(store);
 original.acceptSnapshot(snapshot(initial()));
 const batch=original.observe(changed('Older offline text'))!;
 const next=session(store,'page_b');
 next.acceptSnapshot(snapshot(changed('Newer value'),2));
 next.preserveHead(batch.batchId);
 original.acceptSnapshot(snapshot(initial(),3));
 original.refreshOutbox();
 expect(original.hasPending()).toBe(false);
 expect([...store.rows.values()]).toHaveLength(1);
 expect(JSON.parse([...store.rows.values()][0]).batchId).toBe(batch.batchId);
});

it('preserves newer inputs when replay would replace a different parent field type',()=>{
 const s=session();s.acceptSnapshot(snapshot(initial()));
 const dirty=initial();dirty.nodes[1].data.preferences={note:'Offline edit'};s.observe(dirty);
 const canonical=initial();canonical.nodes[1].data.preferences='Another input format';
 s.acceptSnapshot(snapshot(canonical,2));
 expect(s.recoveryOptions()).toEqual({receiptOnly:true});
});
