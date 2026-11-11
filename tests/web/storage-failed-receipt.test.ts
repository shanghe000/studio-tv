import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';

// Sanitized from the real Web acceptance failure: a stopped Flux1 attempt was
// FAILED, then choosing Flux2 created MODEL_PARAMETERS against the same rev11.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-comfy-failed-model-switch-receipt.json',import.meta.url),'utf8'));
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id===fixture.targetId)!;
const reply=(data:any,revision:number)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+revision+'"'}});
function setup(){
 let revision=fixture.revision,graph=encodeGraph(structuredClone(fixture.acknowledged));
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt:'2026-11-01T11:40:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p/snapshot'&&init.method==='PUT'){
   expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;return reply(snapshot(),revision);
  }
  throw new Error('Unexpected request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const storage=new ServiceStorage(api,vi.fn());storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');
 return{storage,transport,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');}};
}
function chooseFlux2(storage:ServiceStorage,local:NativeGraph){
 storage.rememberModelBinding('p',target(local),{capabilityRef:'flux2-klein-9b-generate-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 storage.observeNativeDraft('p',local);
}

it.each(['attach','remoteApply'] as const)('normalizes the same failed receipt at %s before the real Flux1 to Flux2 model switch',async seam=>{
 const f=setup(),base=structuredClone(fixture.base);
 // Keep the general three-way guard strict: without native normalization this
 // exact captured omission still looks like a concurrent parameter mutation.
 const boundBase=structuredClone(base),boundLocal=structuredClone(fixture.local);
 Object.assign(target(boundBase).data,{capabilityRef:'flux1-dev-generate-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 Object.assign(target(boundLocal).data,{capabilityRef:'flux2-klein-9b-generate-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 expect(mergeCanvasDraft(boundBase,boundLocal,fixture.acknowledged).conflicts).toContainEqual({path:'/nodes/n/data/modelSelection',reason:'MODEL_PARAMETERS'});
 if(seam==='attach')f.storage.attachNativeView('p',base);else{
  f.storage.attachNativeView('p',base);f.storage.remoteNativeViewApplied('p',base);
 }
 f.storage.observeNativeDraft('p',base);expect(f.storage.hasDraft('p')).toBe(false);
 const local=structuredClone(fixture.local);chooseFlux2(f.storage,local);
 expect(f.storage.mergedNativeView('p').conflicts).toEqual([]);expect(f.storage.isBlocked('p')).toBe(false);
 await f.storage.queueSave('p',local);
 const saved=target(f.current()).data;
 expect(saved).toMatchObject({modelCode:'flux2-klein-9b-generate-v1',capabilityRef:'flux2-klein-9b-generate-v1',params:target(local).data.params});
 expect(saved.routerParameters).toBeUndefined();expect(saved.userPromptSnapshot).toBeUndefined();
 expect(f.transport).toHaveBeenCalledTimes(1);expect(f.storage.hasDraft('p')).toBe(false);
});

it.each(['routerParameters','capabilityVersion','params'] as const)('still blocks a real concurrent %s mutation against the local model switch',field=>{
 const f=setup(),base=structuredClone(fixture.base);f.storage.attachNativeView('p',base);
 const local=structuredClone(fixture.local);chooseFlux2(f.storage,local);
 const remote=structuredClone(fixture.acknowledged);
 if(field==='routerParameters')target(remote).data.routerParameters.outputPreset='portrait';
 if(field==='capabilityVersion')target(remote).data.capabilityVersion='2';
 if(field==='params')target(remote).data.params.outputPreset='portrait';
 expect(f.remote(remote).conflicts.some(row=>row.reason==='MODEL_PARAMETERS')).toBe(true);expect(f.storage.isBlocked('p')).toBe(true);
 expect(target(f.storage.draft('p')!).data.modelCode).toBe('flux2-klein-9b-generate-v1');expect(f.transport).not.toHaveBeenCalled();
});

it.each(['task','status','model','version','params','prompt','source','output','history'] as const)('does not restore an unrelated or changed failed %s view',field=>{
 const f=setup(),native=structuredClone(fixture.base),data=target(native).data;
 Object.assign(data,{capabilityRef:'flux1-dev-generate-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 if(field==='task')data.taskId='another-task';if(field==='status')data.status='idle';if(field==='model')data.modelCode='new-model';if(field==='version')data.capabilityVersion='2';
 if(field==='params')data.params.outputPreset='portrait';if(field==='prompt')data.prompt='edited prompt';if(field==='source')data.sourceObjects=['rhtv-asset:other'];if(field==='output')data.output=[{url:'rhtv-asset:other'}];if(field==='history')data.historyStorage={source:'remote',historyId:'another-execution'};
 f.storage.attachNativeView('p',native);
 const observed=(f.storage as any).drafts.get('p').observed;
 expect(target(observed).data.routerParameters).toBeUndefined();expect(target(observed).data.userPromptSnapshot).toBeUndefined();
});

it.each([null,{}])('retains explicit failed receipt field values %j',value=>{
 const f=setup(),native=structuredClone(fixture.base);target(native).data.routerParameters=value;target(native).data.userPromptSnapshot=value;
 f.storage.attachNativeView('p',native);const observed=(f.storage as any).drafts.get('p').observed;
 expect(target(observed).data.routerParameters).toEqual(value);expect(target(observed).data.userPromptSnapshot).toEqual(value);
});
