import {expect,it,vi} from 'vitest';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {verifiedAccess} from './collaboration-fixtures';
import {ApiError} from '../../apps/web/src/api/client';
import type {Snapshot} from '../../apps/web/src/api/types';
import {applyCanvasOperations} from '../../apps/web/src/service/canvas-operations';
import {DraftJournal,type DraftJournalRecord} from '../../apps/web/src/service/draft-journal';
import {decodeGraph,encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {legacyRecoveryOrder,recoverLegacyEdit} from '../../apps/web/src/service/legacy-canvas-edits';
import {MemoryDraftStorage} from './draft-journal-fixture';

const timestamp=(minute:number)=>`2026-11-04T15:${String(minute).padStart(2,'0')}:00.000Z`;
function graph(text:string,other='unchanged'):NativeGraph {
 return {nodes:[{id:'node',type:'rh-text',position:{x:0,y:0},data:{text,other}}],edges:[]};
}
function row(id:string,base:NativeGraph,local:NativeGraph,rev?:number,minute=1):DraftJournalRecord {
 return {format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',id,tabId:'tab_'+id,userId:'artist',projectId:'canvas',createdAt:timestamp(minute),updatedAt:timestamp(minute),base,graph:local,baseRevision:rev};
}
function pending(base:NativeGraph,local:NativeGraph,initialEtag:string){return {base,local,initialEtag,unknownBase:false};}
type Body=Parameters<Parameters<typeof recoverLegacyEdit>[4]>[0];
function server(document:NativeGraph,revision=7){
 const state={snapshot:{projectId:'canvas',revision,graph:encodeGraph(document),updatedAt:timestamp(0)} as Snapshot,commits:0};
 const receipts=new Map<string,{revision:number;payload:string}>();
 const send=vi.fn(async(body:Body)=>{
  const payload=JSON.stringify([body.observedRevision,body.operations]);const prior=receipts.get(body.batchId);
  if(prior&&prior.payload!==payload)throw new Error('Batch ID reused with different edits');
  if(!prior){
   if(body.receiptOnly)throw new ApiError(409,'CANVAS_BATCH_NOT_APPLIED','No existing receipt');
   if(body.baseRevision!==state.snapshot.revision)throw new ApiError(412,'CANVAS_RECOVERY_RECHECK','The compared base changed');
   state.snapshot={...state.snapshot,revision:state.snapshot.revision+1,graph:applyCanvasOperations(state.snapshot.graph,body.operations)};state.commits++;
   receipts.set(body.batchId,{revision:state.snapshot.revision,payload});
  }
  return {...state.snapshot,batchId:body.batchId,acceptedRevision:receipts.get(body.batchId)!.revision};
 });
 const accept=vi.fn();
 const restore=(record:DraftJournalRecord,current=state.snapshot)=>recoverLegacyEdit(record,current,'admitted_page',encodeGraph,send,accept);
 return {state,send,accept,restore,text:()=>decodeGraph(state.snapshot.graph).nodes[0].data};
}
function sorted(records:DraftJournalRecord[],resolved=(_r:DraftJournalRecord)=>false){return legacyRecoveryOrder(records,resolved).map(({row,baseRevision})=>({...row,baseRevision}));}

it('recovers edits across two rotated journal rows in dependency order despite reversed clocks and shell identity/label changes',async()=>{
 const a=graph('initial');const b=graph('first edit');const bInSecondTab={...b,meta:{id:'canvas',name:'Renamed in another tab'}};const c=graph('final edit');c.meta=bInSecondTab.meta;
 const first=row('first',a,b,7,40),second=row('second',bInSecondTab,c,undefined,10);
 const plan=sorted([second,first]);expect(plan.map(candidate=>[candidate.id,candidate.baseRevision])).toEqual([['first',7],['second',7]]);
 const api=server(graph('initial','independent remote edit'),11);
 for(const candidate of plan)expect(await api.restore(candidate)).toBe('saved');
 expect(api.send.mock.calls.map(([body])=>[body.observedRevision,body.baseRevision])).toEqual([[7,11],[7,12]]);
 expect(api.text()).toMatchObject({text:'final edit',other:'independent remote edit'});expect(api.state.commits).toBe(2);
 expect(api.send.mock.calls.every(([body])=>!Object.hasOwn(body,'graph'))).toBe(true);
});

it('recognizes an already resolved predecessor as evidence without resending it',async()=>{
 const a=graph('a'),b=graph('b'),c=graph('c');const first=row('first',a,b,7,40),second=row('second',b,c,undefined,2);
 const plan=sorted([second,first],candidate=>candidate.id===first.id);expect(plan.map(r=>[r.id,r.baseRevision])).toEqual([['second',7]]);
 const api=server(b,10);expect(await api.restore(plan[0])).toBe('saved');expect(api.text().text).toBe('c');expect(api.state.commits).toBe(1);
});

it('uses the original pending strong ETag for a single unnumbered row and only writes its explicit local edit',async()=>{
 const base=graph('old'),local=graph('my edit'),display=graph('my edit','an unrelated server value once displayed');
 const record={...row('single',base,display),pending:[pending(base,local,'"7"')]};const [candidate]=sorted([record]);expect(candidate.baseRevision).toBe(7);
 const api=server(graph('old','new unrelated edit'),14);expect(await api.restore(candidate)).toBe('saved');
 expect(api.send.mock.calls[0][0]).toMatchObject({observedRevision:7,baseRevision:14});expect(api.text()).toMatchObject({text:'my edit',other:'new unrelated edit'});
});

it('does not overwrite a newer edit to the same field and leaves the original browser journal intact',async()=>{
 const storage=new MemoryDraftStorage(),journal=new DraftJournal(()=>storage),original=row('row',graph('original'),graph('mine'),6);
 journal.write(original,'oldtab');const [saved]=journal.list('artist','canvas'),bytes=[...storage.rows.entries()];const api=server(graph('theirs'),9);
 expect(await api.restore(saved)).toBe('retained');expect(api.send.mock.calls[0][0]).toMatchObject({receiptOnly:true});expect(api.send.mock.calls[0][0]).not.toHaveProperty('baseRevision');
 expect(api.state.commits).toBe(0);expect(api.accept).not.toHaveBeenCalled();expect(api.text().text).toBe('theirs');expect([...storage.rows.entries()]).toEqual(bytes);expect(journal.isResolved(saved)).toBe(false);
});

it('rechecks the exact CAS if another writer wins between comparison and submit',async()=>{
 const api=server(graph('old'),7),record=row('cas',graph('old'),graph('mine'),7);const read=api.state.snapshot;
 api.state.snapshot={...read,revision:8,graph:encodeGraph(graph('concurrent'))};await expect(api.restore(record,read)).rejects.toMatchObject({code:'CANVAS_RECOVERY_RECHECK'});
 expect(api.send.mock.calls[0][0].baseRevision).toBe(7);expect(api.accept).not.toHaveBeenCalled();expect(await api.restore(record)).toBe('retained');expect(api.state.commits).toBe(0);expect(api.text().text).toBe('concurrent');
});

it('replays a lost response under the original batch ID, even when a new page matches the original field again',async()=>{
 const api=server(graph('old'),7),record=row('recoverable',graph('old'),graph('mine'),7);
 await expect(recoverLegacyEdit(record,api.state.snapshot,'tab_first',encodeGraph,async body=>{await api.send(body);throw new TypeError('reply lost');},api.accept)).rejects.toThrow('reply lost');
 expect(api.state.commits).toBe(1);const savedBatch=api.send.mock.calls[0][0];
 api.state.snapshot={...api.state.snapshot,graph:encodeGraph(graph('old','edit after commit')),revision:9};
 expect(await api.restore(structuredClone(record))).toBe('saved');expect(api.send.mock.calls[1][0]).toMatchObject({batchId:savedBatch.batchId,operations:savedBatch.operations,observedRevision:7,clientId:'admitted_page'});
 expect(api.state.commits).toBe(1);expect(api.state.snapshot.revision).toBe(9);expect(api.text()).toMatchObject({text:'old',other:'edit after commit'});
});

it('retains an unnumbered child with two equally possible predecessors',async()=>{
 const b=graph('same content'),first=row('earlier',graph('1'),b,2,30),other=row('later',graph('2'),b,7,31),child=row('unproven',b,graph('new'),undefined,2);
 const plan=sorted([first,other,child]);const record=plan.find(r=>r.id==='unproven')!;expect(record.baseRevision).toBeUndefined();const api=server(b,9);expect(await api.restore(record)).toBe('retained');expect(api.send).not.toHaveBeenCalled();
});

it.each(['missing base','unknown base','requires manual baseline','weak ETag','invalid ETag','wrong pending base','unresolved local media'] as const)('retains %s without a write or confirmation',async variant=>{
 const base=graph('old'),local=graph('local'),record=row('unverified',base,local);record.pending=[pending(base,local,'"7"')];
 if(variant==='missing base')delete record.base;
 if(variant==='unknown base'){record.baseRevision=7;record.pending[0].unknownBase=true;}
 if(variant==='requires manual baseline'){record.baseRevision=7;record.pending[0].requiresBaseDecision=true;}
 if(variant==='weak ETag')record.pending[0].initialEtag='W/"7"';
 if(variant==='invalid ETag')record.pending[0].initialEtag='7';
 if(variant==='wrong pending base')record.pending[0].base=graph('not the envelope base');
 if(variant==='unresolved local media'){record.baseRevision=7;record.unresolvedMedia=1;}
 const [candidate]=sorted([record]);const api=server(base,9);expect(await api.restore(candidate)).toBe('retained');expect(api.send).not.toHaveBeenCalled();expect(api.accept).not.toHaveBeenCalled();
});

it('recovers two continuous unknown-ETag field edits with observed revision one and an exact current CAS',async()=>{
 const a=graph('a'),b=graph('b'),c=graph('b','local second field');
 const record={...row('anonymous',a,c),pending:[pending(a,b,'unknown'),pending(b,c,'unknown')]};const [candidate]=sorted([record]);expect(candidate.baseRevision).toBeUndefined();
 const api=server(a,21);expect(await api.restore(candidate)).toBe('saved');const req=api.send.mock.calls[0][0];expect(req).toMatchObject({observedRevision:1,baseRevision:21});expect(req.operations.every(op=>op.type==='node.patch')).toBe(true);expect(api.text()).toEqual(c.nodes[0].data);
});

it('retains anonymous field edits when the server confirms their node identity was superseded',async()=>{
 const a=graph('a'),b=graph('b'),record={...row('superseded',a,b),pending:[pending(a,b,'unknown')]};const api=server(a,22);
 const send=vi.fn(async(body:Body)=>({...api.state.snapshot,batchId:body.batchId,acceptedRevision:22,supersededOperations:1}));
 expect(await recoverLegacyEdit(record,api.state.snapshot,'current',encodeGraph,send,api.accept)).toBe('retained');expect(send.mock.calls[0][0]).toMatchObject({observedRevision:1,baseRevision:22});expect(api.text().text).toBe('a');
});

it.each(['structural edit','discontinuous before/after'] as const)('never applies an anonymous %s',async variant=>{
 const a=graph('a'),b=graph('b'),c=graph('c');if(variant==='structural edit')c.nodes.push({...c.nodes[0],id:'new'});
 const record={...row('unknown',a,c),pending:[pending(a,b,'unknown'),pending(variant==='structural edit'?b:graph('not earlier result'),c,'unknown')]};const api=server(a,10);
 expect(await api.restore(record)).toBe('retained');expect(api.send).not.toHaveBeenCalled();
});

it('leaves an ambiguous but otherwise patchable record in its original journal when a new writer finishes admission',async()=>{
 const memory=new MemoryDraftStorage(),journal=new DraftJournal(()=>memory),a=graph('a'),b=graph('b'),c=graph('c');const first=row('prior1',a,b,4,32),second=row('prior2',graph('other'),b,7,31);
 for(const predecessor of [first,second]){const saved=new DraftJournal(()=>memory).write(predecessor,predecessor.id);journal.markResolved(saved);}
 const child=journal.write({...row('ambiguous',b,c,undefined,1),pending:[pending(b,c,'unknown')]},'ambiguous');const original=[...memory.rows.entries()];
 expect(legacyRecoveryOrder(journal.list('artist','canvas',true),r=>journal.isResolved(r)).find(r=>r.row.id===child.id)?.ambiguous).toBe(true);
 const api=server(b,17),requestV2=vi.fn(async(_url:string,init:any)=>({data:await api.send(init.body),etag:'"17"',status:200}));const store=new ServiceStorage({requestV2} as any,vi.fn(),()=>'artist',journal);
 store.rememberAccess(verifiedAccess('canvas','OWNER','artist'));store.acceptRemoteSnapshot('canvas',api.state.snapshot,'"17"');store.enableCanvasOperations('canvas',{userId:'artist',clientId:'approved_page',permitsObservedRevision:()=>true,ensure:async()=>{}},b);
 expect(await store.recoverHandoffOperations('canvas','approved_page',()=>{})).toBe(false);expect(requestV2).not.toHaveBeenCalled();expect(api.text().text).toBe('b');expect(journal.isResolved(child)).toBe(false);expect([...memory.rows.entries()]).toEqual(original);
});
