import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {runNativeNodeGenerationAction} from '../../apps/web/src/service/native-storyboard-generation';
import captured from './fixtures/native-storyboard-node-command.json';

const profile:any={capabilityRef:'codex-image-edit-v1',kind:'IMAGE_TO_IMAGE',version:'3',parameterSchemaVersion:'3',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(options:{catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>}={}){
 const fixture:any=structuredClone(captured),graph=fixture.baseline,target=fixture.command.targetId,projectId=graph.meta.id,requests:any[]=[],notice=vi.fn(),manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[profile],nextCursor:null});
  if(path.startsWith('/api/v1/assets/'))return json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});
  if(path===`/api/v1/projects/${projectId}/snapshot`)return options.save?.(body)??json({projectId,revision:2,graph:body.graph,updatedAt:'2026-10-22T05:20:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'accepted',projectId,canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:target,executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,notice),adapter=new ExecutionAdapter(api,storage,async()=>{},notice);storage.acceptRemoteSnapshot(projectId,{projectId,revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-22T05:19:00Z'},'"1"');storage.attachNativeView(projectId,graph);adapter.attach(projectId,manager);
 const data=()=>graph.nodes.find((node:any)=>node.id===target).data,script=()=>graph.nodes.find((node:any)=>node.type==='rh-script'),action:any={currentModel:{modelCode:'codex-image-edit-v1',available:true,capabilityVersion:'3'},params:structuredClone(data().params),disabled:false,isGenerating:false,preflight:vi.fn(),onClick:vi.fn()},runtime:any={auth:{user:{id:'owner'}},inspect:()=>({id:projectId}),storage,execution:adapter},native:any={bt:()=>manager};
 return{fixture,graph,target,projectId,adapter,storage,requests,notice,manager,runtime,native,action,data,script,run:()=>runNativeNodeGenerationAction(runtime,native,notice,target,action),submitted:()=>requests.filter(row=>row.path==='/api/v2/canvas-runs')};
}

it('keeps the real S06 native command rejected by the unchanged execution guard',async()=>{
 const c=setup();try{await expect(c.adapter.run({...c.fixture.command,canvasId:c.projectId})).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it('submits the same real S06 node from the current full graph, preserving its prompt, ordered refs and complete source receipt',async()=>{
 const c=setup(),original=structuredClone(c.graph),raw=c.data().params.prompt,refs=structuredClone(c.data().params.imageUrls),script=structuredClone(c.script());
 try{expect(await c.run()).toBe(true);expect(c.action.preflight).toHaveBeenCalledOnce();expect(c.action.onClick).not.toHaveBeenCalled();expect(c.manager.flushOperationQueue).toHaveBeenCalledWith(true);expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,node=body.graph.nodes.find((value:any)=>value.id===c.target),source=body.graph.nodes.find((value:any)=>value.id===script.id);expect(body.expectedRevision).toBe(2);expect(node.data.params.prompt).toBe(raw);expect(node.data.params.imageUrls).toEqual(refs);expect(source.data).toEqual(script.data);expect(Array.isArray(source.data.output)).toBe(false);expect(body.graph.nodes.map((value:any)=>value.id)).toEqual(original.nodes.map((value:any)=>value.id));expect(body.graph.edges).toEqual(original.edges);expect(c.storage.isBlocked(c.projectId)).toBe(false);}finally{c.adapter.clear();}
});
it('flushes pending visible edits before taking the owned full graph without calling the native receipt recompiler',async()=>{
 const c=setup();c.action.params.prompt='仅当前节点的新提示词';c.action.params.imageUrls=[...c.action.params.imageUrls].reverse();c.manager.flushOperationQueue.mockImplementation(()=>{c.data().params=structuredClone(c.action.params);});
 try{expect(await c.run()).toBe(true);expect(c.action.onClick).not.toHaveBeenCalled();const node=c.submitted()[0].body.graph.nodes.find((value:any)=>value.id===c.target);expect(node.data.params.prompt).toBe('仅当前节点的新提示词');expect(node.data.params.imageUrls).toEqual(c.action.params.imageUrls);}finally{c.adapter.clear();}
});
it.each(['disabled','running','unavailable','preflight'])('preserves native action gates before any flush or execution: %s',async change=>{
 const c=setup();if(change==='disabled')c.action.disabled=true;if(change==='running')c.action.isGenerating=true;if(change==='unavailable')c.action.currentModel.available=false;if(change==='preflight')c.action.preflight.mockReturnValue('请选择模型');
 try{expect(await c.run()).toBe(false);expect(c.manager.flushOperationQueue).not.toHaveBeenCalled();expect(c.action.onClick).not.toHaveBeenCalled();expect(c.submitted()).toHaveLength(0);if(change==='preflight')expect(c.notice).toHaveBeenCalledExactlyOnceWith('请选择模型');}finally{c.adapter.clear();}
});
it.each(['row-empty','row-duplicate','row-nonstring','row-id-missing','model-changed','model-not-available','version-changed','prompt-unsaved','reference-unsaved','removed-after-flush','changed-scene-after-flush','changed-row-id-after-flush','changed-row-ids-after-flush'])('rejects a changed or incomplete storyboard action before submitting: %s',async change=>{
 const c=setup();if(change==='row-empty')c.data().storyboardRowIds=[];if(change==='row-duplicate')c.data().storyboardRowIds=['studio-shot-1','studio-shot-1'];if(change==='row-nonstring')c.data().storyboardRowIds=[1];if(change==='row-id-missing')delete c.data().storyboardRowId;if(change==='model-changed')c.action.currentModel.modelCode='other';if(change==='model-not-available')delete c.action.currentModel.available;if(change==='version-changed')c.data().capabilityVersion='other';if(change==='prompt-unsaved')c.action.params.prompt='not saved';if(change==='reference-unsaved')c.action.params.imageUrls=['rhtv-asset:foreign'];if(change==='removed-after-flush')c.manager.flushOperationQueue.mockImplementation(()=>{c.graph.nodes=c.graph.nodes.filter((node:any)=>node.id!==c.target);});if(change==='changed-scene-after-flush')c.manager.flushOperationQueue.mockImplementation(()=>{c.data().sceneCode='other';});
 if(change==='changed-row-id-after-flush')c.manager.flushOperationQueue.mockImplementation(()=>{c.data().storyboardRowId='other__merge_other';});if(change==='changed-row-ids-after-flush')c.manager.flushOperationQueue.mockImplementation(()=>{c.data().storyboardRowIds.splice(0,1,'studio-shot-2');});
 try{await expect(c.run()).rejects.toMatchObject({code:change.startsWith('row-')||change.endsWith('after-flush')?'STORYBOARD_SELECTION_INVALID':'STALE_EXECUTION_INPUT'});expect(c.action.onClick).not.toHaveBeenCalled();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['identity','project','manager'])('keeps the original canvas and identity across the parameter flush: %s',async change=>{
 const c=setup();c.manager.flushOperationQueue.mockImplementation(()=>{if(change==='identity')c.runtime.auth.user={id:'other'};if(change==='project')c.runtime.inspect=()=>({id:'other'});if(change==='manager')c.native.bt=()=>({getRemoteData:()=>c.graph});});
 try{await expect(c.run()).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});expect(c.submitted()).toHaveLength(0);expect(c.action.onClick).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});
it.each(['ordinary-image','missing-flag','different-scene','script'])('leaves unrelated native generation callbacks intact: %s',async change=>{
 const c=setup();if(change==='ordinary-image'){delete c.data().isStoryboard;delete c.data().sceneCode;}if(change==='missing-flag')delete c.data().isStoryboard;if(change==='different-scene')c.data().sceneCode='image.edit';if(change==='script')c.graph.nodes.find((node:any)=>node.id===c.target).type='rh-script';
 try{await c.run();expect(c.action.onClick).toHaveBeenCalledExactlyOnceWith({cancel:expect.any(Function)});expect(c.manager.flushOperationQueue).not.toHaveBeenCalled();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it('does not add project, authentication or storage dependencies to an ordinary native callback',async()=>{
 const action={currentModel:{available:true},onClick:vi.fn(),preflight:vi.fn()},native={bt:()=>({getRemoteData:()=>({nodes:[{id:'ordinary',type:'rh-image',data:{}}]})})};await runNativeNodeGenerationAction({},native,vi.fn(),'ordinary',action);expect(action.onClick).toHaveBeenCalledExactlyOnceWith({cancel:expect.any(Function)});
});
it.each(['prompt','reference','model','row','source-output','deleted'])('keeps actual graph input changes guarded while catalog resolves: %s',async change=>{
 let finish!:(response:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.run();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));if(change==='prompt')c.data().params.prompt='later';if(change==='reference')c.data().params.imageUrls=['rhtv-asset:foreign'];if(change==='model')c.data().modelCode='other';if(change==='row')c.data().storyboardRowIds=['studio-shot-2'];if(change==='source-output')c.script().data.output.rows[0].storyboard_prompt='later';if(change==='deleted')c.graph.nodes=c.graph.nodes.filter((node:any)=>node.id!==c.target);finish(json({items:[profile],nextCursor:null}));expect(await pending).toBe(false);expect(c.submitted()).toHaveLength(0);expect(c.notice).toHaveBeenCalled();}finally{c.adapter.clear();}
});
it.each(['prompt','reference','source-output'])('keeps actual graph changes guarded while the execution snapshot saves: %s',async change=>{
 let finish!:(response:Response)=>void,saved:any;const c=setup({save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.run();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));if(change==='prompt')c.data().params.prompt='later';if(change==='reference')c.data().params.imageUrls=['rhtv-asset:foreign'];if(change==='source-output')c.script().data.output.rows[0].storyboard_prompt='later';finish(json({projectId:c.projectId,revision:2,graph:saved.graph,updatedAt:'2026-10-22T05:21:00Z'}));expect(await pending).toBe(false);expect(c.submitted()).toHaveLength(0);expect(c.notice).toHaveBeenCalled();}finally{c.adapter.clear();}
});
it('retains the existing treatment of task-only source metadata while the source content is unchanged',async()=>{
 let finish!:(response:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)}),source=structuredClone(c.script());
 try{const pending=c.run();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));c.script().data.taskId='later-runtime-task';finish(json({items:[profile],nextCursor:null}));expect(await pending).toBe(true);expect(c.submitted()).toHaveLength(1);expect(c.submitted()[0].body.graph.nodes.find((node:any)=>node.id===source.id).data).toEqual(source.data);}finally{c.adapter.clear();}
});
