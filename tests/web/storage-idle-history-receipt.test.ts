import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

// Synthetic local React/Yjs QA capture: a detached idle motion result has no
// taskId, and the native view omits its frozen router parameters. Opening its
// legacy toolbar then changed model. No production prompt or media is stored.
const captured=JSON.parse(readFileSync(new URL('./fixtures/native-idle-motion-model-switch.json',import.meta.url),'utf8'));
const fixture={...captured,base:captured.pending[0].base,local:captured.pending[0].local};
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id===fixture.targetId)!;
const reply=(data:any,revision?:number)=>new Response(JSON.stringify({code:0,data}),{headers:revision?{ETag:'"'+revision+'"'}:{}});
function setup(){
 let revision=fixture.revision,graph=encodeGraph(structuredClone(fixture.acknowledged));
 const snapshot=()=>({projectId:fixture.projectId,revision,graph:structuredClone(graph),updatedAt:'2026-11-03T07:00:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path.endsWith('/snapshot')&&init.method==='PUT'){expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;return reply(snapshot(),revision);}
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1);return reply({id,state:'READY',downloadUrl:'https://fixture.invalid/owned/'+id});}
  throw Error('Unexpected idle receipt fixture route: '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn());storage.acceptRemoteSnapshot(fixture.projectId,snapshot(),'"'+revision+'"');for(const ref of new Set(JSON.stringify(fixture).match(/rhtv-asset:[A-Za-z0-9_-]+/g)??[])){const id=ref.slice(11);storage.registerAsset({id,state:'READY',downloadUrl:'https://fixture.invalid/owned/'+id} as any);}
 return{storage,transport,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot(fixture.projectId,snapshot(),'"'+revision+'"');}};
}

it('captures the actual false model/parameter conflict caused by an omitted idle receipt',()=>{
 expect(mergeCanvasDraft(fixture.base,fixture.local,fixture.acknowledged).conflicts).toContainEqual({path:'/nodes/qa_video/data/modelSelection',reason:'MODEL_PARAMETERS'});
});

it.each(['attach','remoteApply'] as const)('keeps the same idle receipt in the %s baseline before a local model change',async seam=>{
 const f=setup(),base=structuredClone(fixture.base);
 if(seam==='attach')f.storage.attachNativeView(fixture.projectId,base);else f.storage.remoteNativeViewApplied(fixture.projectId,base);
 f.storage.observeNativeDraft(fixture.projectId,base);expect(f.storage.hasDraft(fixture.projectId)).toBe(false);
 const observed=(f.storage as any).drafts.get(fixture.projectId).observed;expect(target(observed).data.routerParameters).toEqual({outputPreset:'landscape-768p-source'});
 const local=structuredClone(fixture.local);f.storage.captureDraft(fixture.projectId,local);expect(f.storage.mergedNativeView(fixture.projectId).conflicts).toEqual([]);
 await f.storage.queueSave(fixture.projectId,local);expect(f.storage.isBlocked(fixture.projectId)).toBe(false);expect(f.storage.hasDraft(fixture.projectId)).toBe(false);
 expect(target(f.current()).data.modelCode).toBe('h3-video-reference-v1');expect(target(f.current()).data.routerParameters).toBeUndefined();expect(target(f.current()).data.historyStorage).toEqual(target(fixture.acknowledged).data.historyStorage);
 expect(f.current().nodes.find(node=>node.id==='qa_source_video')!.data.sourceObjects).toEqual(['rhtv-asset:qa_source_video']);
});

it('retains legacy pending entries whose older native receipt baseline cannot be proven',async()=>{
 const f=setup(),state=(f.storage as any).drafts.get(fixture.projectId);state.pending=structuredClone(fixture.pending);state.observed=structuredClone(fixture.local);
 expect(f.storage.mergedNativeView(fixture.projectId).conflicts).toContainEqual({path:'/nodes/qa_video/data/modelSelection',reason:'MODEL_PARAMETERS'});
 await expect(f.storage.queueSave(fixture.projectId,structuredClone(fixture.local))).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});expect(target(f.storage.draft(fixture.projectId)!).data.modelCode).toBe('h3-video-reference-v1');expect(f.transport.mock.calls.some(([,options])=>options.method==='PUT')).toBe(false);
});

it('preserves a real newer router change when its snapshot arrives before the old native observation is applied',()=>{
 const f=setup(),state=(f.storage as any).drafts.get(fixture.projectId);
 // An older page can retain D1n's missing receipt. Accepting a new head does
 // not mean that graph has reached the mounted view or its observation base.
 state.observed=structuredClone(fixture.base);const remote=structuredClone(fixture.acknowledged);target(remote).data.routerParameters.outputPreset='portrait-768p-source';f.remote(remote);
 f.storage.captureDraft(fixture.projectId,structuredClone(fixture.local));
 expect(state.pending[0].initialEtag).toBe('"5"');expect(target(state.pending[0].base).data.routerParameters).toBeUndefined();
 expect(f.storage.mergedNativeView(fixture.projectId).conflicts).toContainEqual({path:'/nodes/qa_video/data/modelSelection',reason:'MODEL_PARAMETERS'});expect(f.storage.isBlocked(fixture.projectId)).toBe(true);expect(f.transport).not.toHaveBeenCalled();
});

it.each(['different-etag','unknown-base'])('does not infer a legacy receipt baseline with %s',variant=>{
 const f=setup(),state=(f.storage as any).drafts.get(fixture.projectId);state.pending=structuredClone(fixture.pending.slice(0,1));
 if(variant==='different-etag')state.pending[0].initialEtag='"3"';else state.pending[0].requiresBaseDecision=true;
 expect(f.storage.mergedNativeView(fixture.projectId).conflicts.length).toBeGreaterThan(0);expect(f.storage.isBlocked(fixture.projectId)).toBe(true);expect(f.transport).not.toHaveBeenCalled();
});

it.each(['routerParameters','params','version'])('keeps a real concurrent %s conflict after an idle result model switch',field=>{
 const f=setup();f.storage.attachNativeView(fixture.projectId,structuredClone(fixture.base));f.storage.captureDraft(fixture.projectId,structuredClone(fixture.local));const remote=structuredClone(fixture.acknowledged);
 if(field==='routerParameters')target(remote).data.routerParameters.outputPreset='portrait-768p-source';if(field==='params')target(remote).data.params.outputPreset='portrait-768p-source';if(field==='version')target(remote).data.capabilityVersion='3';
 expect(f.remote(remote).conflicts.some(conflict=>conflict.reason==='MODEL_PARAMETERS')).toBe(true);expect(f.storage.isBlocked(fixture.projectId)).toBe(true);expect(target(f.storage.draft(fixture.projectId)!).data.modelCode).toBe('h3-video-reference-v1');
});

it.each(['params','output','history','model','version','selection','task'])('does not inherit an idle receipt after changing %s',field=>{
 const f=setup(),base=structuredClone(fixture.base),data=target(base).data;
 if(field==='params')data.params.outputPreset='portrait-768p-source';if(field==='output')data.output[0].outputId='another-output';if(field==='history')data.historyStorage.historyId='another-history';if(field==='model')data.modelCode='h3-video-reference-v1';if(field==='version')data.capabilityVersion='3';if(field==='selection')data.selectedHistoryOutputId='another-output';if(field==='task')data.taskId='another-task';
 f.storage.attachNativeView(fixture.projectId,base);expect(target((f.storage as any).drafts.get(fixture.projectId).observed).data.routerParameters).toBeUndefined();
});
