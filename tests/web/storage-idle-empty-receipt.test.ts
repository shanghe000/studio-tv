import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {decodeGraph,encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

// The frozen idle form omits receipt metadata even without a task or result.
// This structural fixture contains only synthetic text and asset identifiers.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-idle-empty-reference-receipt.json',import.meta.url),'utf8'));
const target=(graph:NativeGraph)=>graph.nodes.find(node=>node.id===fixture.targetId)!;
const response=(data:any,revision?:number)=>new Response(JSON.stringify({code:0,data}),{headers:revision?{ETag:'"'+revision+'"'}:{}});
function setup(){
 let graph=encodeGraph(structuredClone(fixture.acknowledged)),revision=1;
 const snapshot=()=>({projectId:fixture.projectId,revision,graph:structuredClone(graph),updatedAt:'2026-11-04T06:55:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path.endsWith('/snapshot')&&init.method==='PUT'){expect(init.headers.get('If-Match')).toBe('"'+revision+'"');graph=JSON.parse(init.body).graph;revision++;return response(snapshot(),revision);}
  if(path==='/api/v1/assets/qa_image')return response({id:'qa_image',state:'READY',downloadUrl:'https://fixture.invalid/owned/qa_image'});
  throw Error('Unexpected synthetic idle-empty route: '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn());storage.acceptRemoteSnapshot(fixture.projectId,snapshot(),'"1"');
 return{storage,transport,current:()=>decodeGraph(graph),remote:(next:NativeGraph)=>{graph=encodeGraph(next);revision++;return storage.acceptRemoteSnapshot(fixture.projectId,snapshot(),'"'+revision+'"');}};
}
function modelChange(f:ReturnType<typeof setup>){const local=structuredClone(fixture.native);target(local).data.modelCode='h3-video-reference-v1';f.storage.rememberModelBinding(fixture.projectId,target(local),{capabilityRef:'h3-video-reference-v1',capabilityVersion:'4',parameterSchemaVersion:'4'});return local;}
function connectNewNode(local:NativeGraph,type:'rh-image'|'rh-video'){
 local.nodes.push({id:'qa_new',type,position:{x:800,y:0},data:{label:'Synthetic newly created node',status:'idle',subType:type==='rh-image'?'text-image':'multimodal-video'}});
 local.edges.push({id:'qa_new_edge',source:'qa_source',target:'qa_new',sourceHandle:'output',targetHandle:'input'});return local;
}

it.each(['attach','remoteApply'] as const)('retains an exact idle-empty receipt in the %s observation before a local model switch',async seam=>{
 const f=setup(),native=structuredClone(fixture.native);
 if(seam==='attach')f.storage.attachNativeView(fixture.projectId,native);else f.storage.remoteNativeViewApplied(fixture.projectId,native);
 f.storage.observeNativeDraft(fixture.projectId,native);expect(f.storage.hasDraft(fixture.projectId)).toBe(false);
 const observed=(f.storage as any).drafts.get(fixture.projectId).observed;expect(target(observed).data.routerParameters).toEqual({outputPreset:'landscape-480p-5s'});
 const local=modelChange(f);f.storage.captureDraft(fixture.projectId,local);expect(f.storage.mergedNativeView(fixture.projectId).conflicts).toEqual([]);await f.storage.queueSave(fixture.projectId,local);
 expect(f.storage.isBlocked(fixture.projectId)).toBe(false);expect(target(f.current()).data.modelCode).toBe('h3-video-reference-v1');expect(target(f.current()).data.routerParameters).toBeUndefined();expect(f.current().edges).toEqual(fixture.acknowledged.edges);
});

it.each(['rh-image','rh-video'] as const)('saves a new connected %s after an existing idle-empty node model change without a whole-canvas conflict',async type=>{
 const f=setup();f.storage.attachNativeView(fixture.projectId,structuredClone(fixture.native));const local=connectNewNode(modelChange(f),type);f.storage.captureDraft(fixture.projectId,local);
 expect(f.storage.mergedNativeView(fixture.projectId).conflicts).toEqual([]);await f.storage.queueSave(fixture.projectId,local);
 expect(f.storage.isBlocked(fixture.projectId)).toBe(false);expect(f.current().nodes.map(node=>node.id)).toEqual(['qa_source',fixture.targetId,'qa_new']);expect(f.current().edges).toEqual(local.edges);expect(target(f.current()).data.modelCode).toBe('h3-video-reference-v1');
});

it.each(['routerParameters','params'] as const)('preserves a real concurrent %s conflict and the newly connected local node',field=>{
 const f=setup();f.storage.attachNativeView(fixture.projectId,structuredClone(fixture.native));const local=connectNewNode(modelChange(f),'rh-image');f.storage.captureDraft(fixture.projectId,local);const remote=structuredClone(fixture.acknowledged);target(remote).data[field].outputPreset='portrait-480p-5s';
 expect(f.remote(remote).conflicts).toContainEqual({path:'/nodes/'+fixture.targetId+'/data/modelSelection',reason:'MODEL_PARAMETERS'});expect(f.storage.isBlocked(fixture.projectId)).toBe(true);expect(f.storage.draft(fixture.projectId)!.nodes.some(node=>node.id==='qa_new')).toBe(true);expect(f.storage.draft(fixture.projectId)!.edges).toContainEqual(local.edges[1]);expect(f.transport).not.toHaveBeenCalled();
});

it.each(['parameters','prompt','estimate','generation','cache','selection','task','execution','history','output','version','model'])('does not fill an idle-empty receipt after a real %s change',field=>{
 const f=setup(),native=structuredClone(fixture.native),data=target(native).data;
 if(field==='parameters')data.params.outputPreset='portrait-480p-5s';if(field==='prompt')data.prompt='A new synthetic input.';if(field==='estimate')data.estimateTaskId='qa_new_estimate';if(field==='generation')data.generationStartedAt=2000;if(field==='cache')data.nodeOutputHistory=[{id:'qa_other_result'}];if(field==='selection')data.selectedHistoryOutputId='qa_other_output';if(field==='task')data.taskId='qa_new_task';if(field==='execution')data.executionId='qa_new_execution';if(field==='history')data.historyStorage={source:'remote',schemaVersion:1,historyId:'qa_new_history'};if(field==='output')data.output=[{outputId:'qa_new_output',assetId:'qa_image'}];if(field==='version')data.capabilityVersion='5';if(field==='model')data.modelCode='another-video-model';
 f.storage.attachNativeView(fixture.projectId,native);const observed=target((f.storage as any).drafts.get(fixture.projectId).observed).data;expect(observed.routerParameters).toBeUndefined();expect(observed.userPromptSnapshot).toBeUndefined();
});

it('keeps explicit receipt values rather than treating them as native omissions',()=>{
 const f=setup(),native=structuredClone(fixture.native);target(native).data.routerParameters=null;target(native).data.userPromptSnapshot={paramName:'prompt',value:'Explicit synthetic input.'};f.storage.attachNativeView(fixture.projectId,native);
 const observed=target((f.storage as any).drafts.get(fixture.projectId).observed).data;expect(observed.routerParameters).toBeNull();expect(observed.userPromptSnapshot).toEqual(target(native).data.userPromptSnapshot);
});

it('never repairs an unproven legacy pending baseline from a newer acknowledged receipt',()=>{
 const f=setup(),state=(f.storage as any).drafts.get(fixture.projectId);state.observed=structuredClone(fixture.native);const remote=structuredClone(fixture.acknowledged);target(remote).data.routerParameters.outputPreset='portrait-480p-5s';f.remote(remote);const local=connectNewNode(modelChange(f),'rh-video');f.storage.captureDraft(fixture.projectId,local);
 expect(state.pending[0].initialEtag).toBe('"2"');expect(target(state.pending[0].base).data.routerParameters).toBeUndefined();expect(f.storage.mergedNativeView(fixture.projectId).conflicts.some(conflict=>conflict.reason==='MODEL_PARAMETERS')).toBe(true);expect(f.storage.isBlocked(fixture.projectId)).toBe(true);expect(f.storage.draft(fixture.projectId)!.nodes.some(node=>node.id==='qa_new')).toBe(true);expect(f.transport).not.toHaveBeenCalled();
});
