import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

// Sanitized full graph captured at the native drama -> action autosave failure.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-h3-model-switch-receipt.json',import.meta.url),'utf8'));
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id===fixture.targetId)!;
const reply=(data:any,revision?:number)=>new Response(JSON.stringify({code:0,data}),{headers:revision?{ETag:'"'+revision+'"'}:{}});
function setup(){
 let revision=1,graph=encodeGraph(structuredClone(fixture.acknowledged));
 const snapshot=()=>({projectId:fixture.projectId,revision,graph:structuredClone(graph),updatedAt:'2026-10-21T12:00:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path.endsWith('/snapshot')&&init.method==='PUT'){expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;return reply(snapshot(),revision);}
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1);return reply({id,state:'READY',downloadUrl:'https://owned.invalid/'+id+'?signature=fixture'});}
  throw new Error('Unexpected request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn());storage.acceptRemoteSnapshot(fixture.projectId,snapshot(),'"1"');
 return{storage,transport,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot(fixture.projectId,snapshot(),'"'+revision+'"');}};
}

it.each(['attach','remoteApply'] as const)('restores the same displayed receipt at %s and saves the real drama -> action model switch',async seam=>{
 const f=setup(),native=structuredClone(fixture.base);
 if(seam==='attach')f.storage.attachNativeView(fixture.projectId,native);else f.storage.remoteNativeViewApplied(fixture.projectId,native);
 f.storage.observeNativeDraft(fixture.projectId,native);expect(f.storage.hasDraft(fixture.projectId)).toBe(false);
 const local=structuredClone(fixture.local);f.storage.rememberModelBinding(fixture.projectId,target(local),{capabilityRef:'h3-action-reference-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 f.storage.observeNativeDraft(fixture.projectId,local);expect(f.storage.mergedNativeView(fixture.projectId).conflicts).toEqual([]);
 await f.storage.queueSave(fixture.projectId,local);
 expect(target(f.current()).data).toMatchObject({modelCode:'h3-action-reference-v1',params:target(local).data.params});
 expect(target(f.current()).data.routerParameters).toBeUndefined();expect(f.storage.hasDraft(fixture.projectId)).toBe(false);
});

it('compares the same owned output and reference after native download URL hydration',async()=>{
 const f=setup(),ids=[...new Set(JSON.stringify(fixture.base).match(/ast_[a-f0-9]+/g)??[])];await Promise.all(ids.map(id=>f.storage.resolveAsset(id)));
 const native=decodeGraph(encodeGraph(fixture.base),f.storage.decodeAsset);expect(target(native).data.videoUrl).toContain('https://owned.invalid/');
 f.storage.attachNativeView(fixture.projectId,native);f.storage.observeNativeDraft(fixture.projectId,native);expect(f.storage.hasDraft(fixture.projectId)).toBe(false);
 expect((f.storage as any).drafts.get(fixture.projectId).observed.nodes.find((node:any)=>node.id===fixture.targetId).data.routerParameters).toEqual({outputPreset:'landscape-480p-5s'});
});

it('does not restore frozen parameters over a same-model native parameter edit',()=>{
 const f=setup(),native=structuredClone(fixture.base);f.storage.attachNativeView(fixture.projectId,native);
 target(native).data.params.outputPreset='portrait-768p-10s';f.storage.observeNativeDraft(fixture.projectId,native);
 const merged=target(f.storage.mergedNativeView(fixture.projectId).graph).data;
 expect(merged.params.outputPreset).toBe('portrait-768p-10s');expect(merged.routerParameters).toBeUndefined();
});

it.each([null,{}])('preserves explicit native receipt values %j rather than treating them as omitted',value=>{
 const f=setup(),native=structuredClone(fixture.base);target(native).data.routerParameters=value;target(native).data.userPromptSnapshot=value;f.storage.attachNativeView(fixture.projectId,native);
 const data=(f.storage as any).drafts.get(fixture.projectId).observed.nodes.find((node:any)=>node.id===fixture.targetId).data;
 expect(data.routerParameters).toEqual(value);expect(data.userPromptSnapshot).toEqual(value);
});

it.each(['task','history','output','version','model','selection'])('does not recover metadata for changed %s identity',field=>{
 const f=setup(),native=structuredClone(fixture.base),data=target(native).data;
 if(field==='task')data.taskId='tsk_other';if(field==='history')data.historyStorage.historyId='exe_other';if(field==='output')data.output[0].outputId='out_other';if(field==='version')data.capabilityVersion='2';if(field==='model')data.modelCode='h3-action-reference-v1';if(field==='selection')data.selectedHistoryOutputId='other';
 f.storage.remoteNativeViewApplied(fixture.projectId,native);const observed=target((f.storage as any).drafts.get(fixture.projectId).observed).data;
 expect(observed.routerParameters).toBeUndefined();expect(observed.userPromptSnapshot).toBeUndefined();
});

it.each(['parameters','version'])('retains a real concurrent %s conflict against a local model switch',field=>{
 const f=setup(),native=structuredClone(fixture.base);f.storage.attachNativeView(fixture.projectId,native);
 const local=structuredClone(fixture.local);f.storage.rememberModelBinding(fixture.projectId,target(local),{capabilityRef:'h3-action-reference-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});f.storage.observeNativeDraft(fixture.projectId,local);
 const remote=structuredClone(fixture.acknowledged);if(field==='parameters')target(remote).data.routerParameters.outputPreset='portrait-768p-10s';else target(remote).data.capabilityVersion='2';
 expect(f.remote(remote).conflicts.some(conflict=>conflict.reason==='MODEL_PARAMETERS')).toBe(true);expect(f.storage.isBlocked(fixture.projectId)).toBe(true);
});
