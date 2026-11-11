import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';

// Captured ack152: removing the video from a failed Wan card reset it to idle
// and omitted taskId, but kept the same failed estimate and frozen request.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-wan-failed-estimate-input-edit.json',import.meta.url),'utf8'));
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id===fixture.targetId)!;
const reply=(data:any,revision:number)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+revision+'"'}});
function setup(initial=fixture){
 let revision=initial.revision,graph=encodeGraph(structuredClone(initial.acknowledged));
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt:'2026-11-01T13:00:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p/snapshot'&&init.method==='PUT'){
   expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;return reply(snapshot(),revision);
  }
  throw new Error('Unexpected request '+path);
 });
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport),vi.fn());storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');
 return{storage,transport,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');}};
}
function choose(storage:ServiceStorage,local:NativeGraph,ref:string){
 storage.rememberModelBinding('p',target(local),{capabilityRef:ref,capabilityVersion:'4',parameterSchemaVersion:'4'});
 storage.observeNativeDraft('p',local);
}

it.each(['attach','remoteApply','capturedObserved','nativeAttach','nativeApply'] as const)('saves the captured failed Wan input edit/model switches at %s without changing CAS',async seam=>{
 const f=setup(),base=structuredClone(fixture.base),local=structuredClone(fixture.local);
 expect(base.edges.filter(edge=>edge.target==='n')).toHaveLength(1);expect(target(base).data.taskId).toBeUndefined();
 if(seam.startsWith('native'))for(const key of ['capabilityRef','capabilityVersion','parameterSchemaVersion'])delete target(base).data[key];
 const bound=structuredClone(local);Object.assign(target(bound).data,{capabilityRef:'h3-reference-v1',capabilityVersion:'4',parameterSchemaVersion:'4'});
 expect(mergeCanvasDraft(fixture.base,bound,fixture.acknowledged).conflicts).toContainEqual({path:'/nodes/n/data/modelSelection',reason:'MODEL_PARAMETERS'});
 if(seam==='attach'||seam==='nativeAttach')f.storage.attachNativeView('p',base);
 else if(seam==='remoteApply'||seam==='nativeApply')f.storage.remoteNativeViewApplied('p',base);
 else (f.storage as any).drafts.get('p').observed=base;
 choose(f.storage,local,'h3-reference-v1');expect(f.storage.mergedNativeView('p').conflicts).toEqual([]);expect(f.storage.isBlocked('p')).toBe(false);
 await f.storage.queueSave('p',local);
 let data=target(f.current()).data;expect(data.modelCode).toBe('h3-reference-v1');
 for(const key of ['routerParameters','userPromptSnapshot','promptSelection'])expect(data[key]).toBeUndefined();
 const next=structuredClone(fixture.nextLocal);choose(f.storage,next,'h3-first-last-frame-v1');await f.storage.queueSave('p',next);
 data=target(f.current()).data;expect(data).toMatchObject({modelCode:'h3-first-last-frame-v1',params:target(next).data.params});
 for(const key of ['routerParameters','userPromptSnapshot','promptSelection'])expect(data[key]).toBeUndefined();
 expect(f.current().edges).toHaveLength(1);expect(f.transport).toHaveBeenCalledTimes(2);expect(f.storage.hasDraft('p')).toBe(false);expect(f.storage.isBlocked('p')).toBe(false);
});

it.each(['estimate','started','task','status','model','version','schema','params','prompt','error','output','history','unknown'] as const)('does not restore a changed failed estimate %s view',field=>{
 const f=setup(),base=structuredClone(fixture.base),data=target(base).data;
 if(field==='estimate')data.estimateTaskId='other';if(field==='started')data.generationStartedAt++;if(field==='task')data.taskId=data.estimateTaskId;if(field==='status')data.status='running';
 if(field==='model')data.modelCode='h3-reference-v1';if(field==='version')data.capabilityVersion='2';if(field==='schema')data.parameterSchemaVersion='2';
 if(field==='params')data.params.outputPreset='portrait-480p-5s';if(field==='prompt')data.prompt='Changed description';if(field==='error')data.errorMsg='';
 if(field==='output')data.output=[];if(field==='history')data.historyStorage={source:'remote'};if(field==='unknown')data.extraSemanticInput=true;
 f.storage.attachNativeView('p',base);const observed=target((f.storage as any).drafts.get('p').observed).data;
 expect(observed.routerParameters).toBeUndefined();expect(observed.userPromptSnapshot).toBeUndefined();expect(observed.promptSelection).toBeUndefined();
});

it.each(['routerParameters','capabilityVersion','params','promptSelection'] as const)('retains real remote %s conflicts against the local switch',field=>{
 const f=setup();f.storage.attachNativeView('p',structuredClone(fixture.base));choose(f.storage,structuredClone(fixture.local),'h3-reference-v1');
 const remote=structuredClone(fixture.acknowledged),data=target(remote).data;
 if(field==='routerParameters')data.routerParameters.outputPreset='portrait-480p-5s';if(field==='capabilityVersion')data.capabilityVersion='2';if(field==='params')data.params.outputPreset='portrait-480p-5s';
 if(field==='promptSelection')data.promptSelection.referenceBindings[0].assetId='different-image';
 expect(f.remote(remote).conflicts.length).toBeGreaterThan(0);expect(f.storage.isBlocked('p')).toBe(true);expect(f.transport).not.toHaveBeenCalled();
});

it.each([null,{}])('preserves explicit failed estimate metadata %j',value=>{
 const f=setup(),base=structuredClone(fixture.base);target(base).data.routerParameters=value;target(base).data.userPromptSnapshot=value;
 f.storage.attachNativeView('p',base);const data=target((f.storage as any).drafts.get('p').observed).data;
 expect(data.routerParameters).toEqual(value);expect(data.userPromptSnapshot).toEqual(value);
});

// CI24 had already normalized the observation, but an earlier DRAFT entry's
// local graph still omitted the receipt. Replaying both captured entries is
// essential: the first silently deletes routerParameters, the second conflicts.
const queuedFixture=JSON.parse(readFileSync(new URL('./fixtures/native-wan-failed-estimate-pending.json',import.meta.url),'utf8'));
function capturedQueue(storage:ServiceStorage,phase?:'DRAFT'|'FAILED'){
 const state=(storage as any).drafts.get('p');state.observed=structuredClone(queuedFixture.observed);
 state.pending=structuredClone(queuedFixture.pending);if(phase)for(const row of state.pending)row.phase=phase;
 return state;
}
it('reproduces the exact CI24 full pending replay before queue normalization',()=>{
 let graph=structuredClone(queuedFixture.acknowledged),conflicts:any[]=[];
 for(const entry of queuedFixture.pending){const merged=mergeCanvasDraft(entry.base,entry.local,graph);graph=merged.graph;conflicts.push(...merged.conflicts);}
 expect(conflicts).toEqual(queuedFixture.conflicts);
 expect(target(graph).data.modelCode).toBe(target(queuedFixture.capturedGraph).data.modelCode);
 // These presentation omissions alone are harmless; the first pending local's
 // metadata deletion is what creates a parameter difference for the second.
 expect(mergeCanvasDraft(queuedFixture.pending[1].base,queuedFixture.pending[1].local,queuedFixture.acknowledged).conflicts).toEqual([]);
});
it('replays both actual CI24 pending entries then saves two model choices with their exact CAS revisions',async()=>{
 const f=setup(queuedFixture);capturedQueue(f.storage);
 expect(f.storage.mergedNativeView('p').conflicts).toEqual([]);expect(f.storage.isBlocked('p')).toBe(false);
 const local=structuredClone(queuedFixture.pending[1].local);choose(f.storage,local,'h3-reference-v1');await f.storage.queueSave('p',local);
 for(const key of ['routerParameters','userPromptSnapshot','promptSelection'])expect(target(f.current()).data[key]).toBeUndefined();
 const next=structuredClone(fixture.nextLocal);choose(f.storage,next,'h3-first-last-frame-v1');await f.storage.queueSave('p',next);
 expect(target(f.current()).data.modelCode).toBe('h3-first-last-frame-v1');expect(f.transport).toHaveBeenCalledTimes(2);
 expect(f.transport.mock.calls.map(([,init])=>init.headers.get('If-Match'))).toEqual(['"168"','"169"']);expect(f.storage.hasDraft('p')).toBe(false);
});
it.each(['DRAFT','FAILED'] as const)('normalizes the same captured local projections while compacting a %s prefix',async phase=>{
 const f=setup(queuedFixture);capturedQueue(f.storage,phase);const local=structuredClone(queuedFixture.pending[1].local);
 // DRAFT compacts in observeNativeDraft; FAILED goes straight to save's retry
 // compaction, with no observation pass to repair the captured queue first.
 if(phase==='DRAFT')choose(f.storage,local,'h3-reference-v1');
 else f.storage.rememberModelBinding('p',target(local),{capabilityRef:'h3-reference-v1',capabilityVersion:'4',parameterSchemaVersion:'4'});
 expect(f.storage.mergedNativeView('p').conflicts).toEqual([]);
 await f.storage.queueSave('p',local);expect(target(f.current()).data.modelCode).toBe('h3-reference-v1');expect(f.storage.isBlocked('p')).toBe(false);expect(f.storage.hasDraft('p')).toBe(false);
});
it.each(['routerParameters','params','capabilityVersion'] as const)('uses each pending own base and still blocks a real latest remote %s change',field=>{
 const f=setup(queuedFixture);capturedQueue(f.storage);const remote=structuredClone(queuedFixture.acknowledged),data=target(remote).data;
 if(field==='routerParameters')data.routerParameters.outputPreset='portrait-480p-5s';if(field==='params')data.params.outputPreset='portrait-480p-5s';if(field==='capabilityVersion')data.capabilityVersion='2';
 const merged=f.remote(remote);expect(merged.conflicts.some(value=>value.reason==='MODEL_PARAMETERS')).toBe(true);expect(f.storage.isBlocked('p')).toBe(true);expect(f.transport).not.toHaveBeenCalled();
});
it.each(['testMode','metadata','estimate'] as const)('does not turn a real captured local %s change into a native omission',field=>{
 const f=setup(queuedFixture),state=capturedQueue(f.storage),data=target(state.pending[0].local).data;
 if(field==='testMode')data.testMode=true;if(field==='metadata')data.routerParameters=null;if(field==='estimate')data.estimateTaskId='another-task';
 const original=structuredClone(data);
 expect(f.storage.mergedNativeView('p').conflicts.length).toBeGreaterThan(0);expect(f.storage.isBlocked('p')).toBe(true);expect(target(state.pending[0].local).data).toEqual(original);expect(f.transport).not.toHaveBeenCalled();
});
