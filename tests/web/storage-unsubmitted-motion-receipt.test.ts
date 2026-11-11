import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';

// Sanitized real idle/no-task ack126, observed H3 input and pending Wan switch.
// H3 preflight stopped after the freeze PUT; the native form omits its metadata.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-h3-unsubmitted-model-switch.json',import.meta.url),'utf8'));
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id===fixture.targetId)!;
const reply=(data:any,revision:number)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+revision+'"'}});
function setup(){
 let revision=fixture.revision,graph=encodeGraph(structuredClone(fixture.acknowledged));
 const snapshot=()=>({projectId:'p',revision,graph:structuredClone(graph),updatedAt:'2026-11-01T12:41:49Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path==='/api/v1/projects/p/snapshot'&&init.method==='PUT'){
   expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;return reply(snapshot(),revision);
  }
  throw new Error('Unexpected request '+path);
 });
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport),vi.fn());storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');
 return{storage,transport,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');}};
}
function chooseWan(storage:ServiceStorage,local:NativeGraph){
 storage.rememberModelBinding('p',target(local),{capabilityRef:'wan-animate2-motion-transfer-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 storage.observeNativeDraft('p',local);
}

it.each(['attach','remoteApply','capturedObserved','nativeAttach','nativeApply'] as const)('saves the captured idle/no-task H3 to Wan switch at %s with the actual CAS',async seam=>{
 const f=setup(),base=structuredClone(seam.startsWith('native')?fixture.nativeAfterReject:fixture.base),local=structuredClone(fixture.local);
 const boundLocal=structuredClone(local);Object.assign(target(boundLocal).data,{capabilityRef:'wan-animate2-motion-transfer-v1',capabilityVersion:'1',parameterSchemaVersion:'1'});
 expect(mergeCanvasDraft(base,boundLocal,fixture.acknowledged).conflicts).toContainEqual({path:'/nodes/n/data/modelSelection',reason:'MODEL_PARAMETERS'});
 if(seam==='attach'||seam==='nativeAttach')f.storage.attachNativeView('p',base);
 else if(seam==='remoteApply'||seam==='nativeApply')f.storage.remoteNativeViewApplied('p',base);
 else{const state=(f.storage as any).drafts.get('p');state.observed=base;state.pending=[structuredClone(fixture.priorPending)];}
 chooseWan(f.storage,local);expect(f.storage.mergedNativeView('p').conflicts).toEqual([]);expect(f.storage.isBlocked('p')).toBe(false);
 await f.storage.queueSave('p',local);
 expect(target(f.current()).data).toMatchObject({modelCode:'wan-animate2-motion-transfer-v1',params:target(local).data.params});
 expect(target(f.current()).data.routerParameters).toBeUndefined();expect(target(f.current()).data.userPromptSnapshot).toBeUndefined();
 expect(f.transport).toHaveBeenCalledTimes(1);expect(f.storage.hasDraft('p')).toBe(false);
});

it.each(['routerParameters','capabilityVersion','params'] as const)('still blocks a real concurrent %s mutation',field=>{
 const f=setup(),base=structuredClone(fixture.base);f.storage.attachNativeView('p',base);
 chooseWan(f.storage,structuredClone(fixture.local));const remote=structuredClone(fixture.acknowledged),data=target(remote).data;
 if(field==='routerParameters')data.routerParameters.outputPreset='portrait-480p-5s';
 if(field==='capabilityVersion')data.capabilityVersion='2';if(field==='params')data.params.outputPreset='portrait-480p-5s';
 expect(f.remote(remote).conflicts.some(value=>value.reason==='MODEL_PARAMETERS')).toBe(true);expect(f.storage.isBlocked('p')).toBe(true);expect(f.transport).not.toHaveBeenCalled();
});

it.each(['task','status','model','version','params','prompt','source','edge','unknown'] as const)('does not restore an unrelated idle %s input',field=>{
 const f=setup(),base=structuredClone(fixture.base),data=target(base).data;
 if(field==='task')data.taskId='another-task';if(field==='status')data.status='running';if(field==='model')data.modelCode='other-model';if(field==='version')data.capabilityVersion='2';
 if(field==='params')data.params.outputPreset='portrait-480p-5s';if(field==='prompt')data.prompt='New description';if(field==='unknown')data.unknownInput='changed';
 if(field==='source')base.nodes.find(node=>node.id==='image')!.data.sourceObjects=['rhtv-asset:another-image'];if(field==='edge')base.edges=base.edges.slice(1);
 f.storage.attachNativeView('p',base);const observed=target((f.storage as any).drafts.get('p').observed).data;
 expect(observed.routerParameters).toBeUndefined();expect(observed.userPromptSnapshot).toBeUndefined();
});

it.each([null,{}])('does not overwrite explicit idle metadata %j',value=>{
 const f=setup(),base=structuredClone(fixture.base);target(base).data.routerParameters=value;target(base).data.userPromptSnapshot=value;
 f.storage.attachNativeView('p',base);const observed=target((f.storage as any).drafts.get('p').observed).data;
 expect(observed.routerParameters).toEqual(value);expect(observed.userPromptSnapshot).toEqual(value);
});
