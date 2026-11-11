import {exportNodeAction} from './helpers/export-node-action';
import {frozenPortraitRequest} from './helpers/frozen-portrait-command';
import auditedCatalog from './fixtures/canvas-catalog-audit-20261104.json';
import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import type {NodeExecutionState} from '../../apps/web/src/service/canvas-sync';
import nativePromptlessCutout from './fixtures/native-promptless-cutout.json';
import nativeStyleCamera from './fixtures/native-style-camera.json';
import nativeStoryMount from './fixtures/native-story-model-mount.json';
import nativeEraseDefaults from './fixtures/native-erase-mounted-defaults.json';
import nativeEnhancePlaceholder from './fixtures/native-enhance-placeholder.json';
import nativeSeedEnhanceCommand from './fixtures/native-seed-enhance-command.json';

const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
const cap={capabilityRef:'mock-llm',kind:'LLM',version:'1',parameterSchemaVersion:'1',available:true,testMode:true,parameterSchema:{type:'object',properties:{scenario:{type:'string',default:'success'}}}};
const task=(state='SUCCEEDED',applicationState='APPLIED')=>({id:'t',projectId:'p',canvasManaged:true,state,revision:3,testMode:true,plans:[{nodeId:'n',executionId:'ex',state,canvasBinding:{applicationState},outputs:state==='SUCCEEDED'?[{id:'o',type:'TEXT',text:'verified response'}]:[]}]});
const state=(overrides:Partial<NodeExecutionState>={}):NodeExecutionState=>({nodeId:'n',taskId:'t',executionId:'ex',state:'SUCCEEDED',applicationState:'APPLIED',...overrides});
function setup(overrides?:{graph?:NativeGraph;route?:(path:string,init:any,control:any)=>Response|Promise<Response>|undefined}){
 const graph=overrides?.graph??{nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{params:{prompt:'original input'}}}],edges:[]};
 const notice=vi.fn(),patch=vi.fn(),flush=vi.fn(),manager={getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:flush};let control:any;
 const transport=vi.fn((path:string,init:any)=>{
  const response=overrides?.route?.(path,init,control);if(response)return response;
  if(path.includes('model-capabilities'))return json({items:[cap],nextCursor:null});
  if(path==='/api/v1/projects/p/snapshot')return json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-06T10:00:00Z'});
  if(path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/t')return json(task());
  throw new Error('unexpected route '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,notice),saved=vi.fn().mockResolvedValue(undefined),adapter=new ExecutionAdapter(api,storage,saved,notice);
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-06T09:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 control={graph,notice,patch,flush,manager,transport,storage,saved,adapter};return control;
}
const run=(control:ReturnType<typeof setup>)=>control.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:control.graph});
function nativeRunning(control:ReturnType<typeof setup>){
 let row:any={get:(key:string)=>key==='id'?'n':undefined},token={},active=true;const accepted=vi.fn();Object.assign(control.manager,{ynodes:{toArray:()=>[row]}});
 const capture=vi.fn(()=>{const captured=token;return{current:()=>active&&token===captured,accepted};}),disposePort=control.adapter.installNativeRunningPort({capture});
 return{mark:()=>{token={};active=true;},rebuild:()=>{row={get:(key:string)=>key==='id'?'n':undefined};},release:()=>{active=false;},active:()=>active,accepted,capture,disposePort};
}
afterEach(()=>{vi.useRealTimers();});
const imageEditV3={...cap,capabilityRef:'codex-image-edit-v1',kind:'IMAGE_TO_IMAGE',version:'3',parameterSchemaVersion:'3',testMode:false,inputKinds:['TEXT','IMAGE'],outputKinds:['IMAGE'],parameterSchema:{properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}};
const imageEditRoute=(path:string)=>path.includes('model-capabilities')?json({items:[imageEditV3],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}):undefined;

it.each(['valid','prompt','text','singular-source','plural-source','other-tool','edge'])('checks the captured native enhance placeholder form: %s',async change=>{
 const fixture:any=structuredClone(nativeEnhancePlaceholder),target=fixture.command.canvas.nodes.find((node:any)=>node.id==='n').data,before=fixture.baseline.nodes.find((node:any)=>node.id==='n').data;
 if(change==='prompt')target.params.prompt='forged';if(change==='text')target.params.text='forged';if(change==='singular-source')before.params.imageUrl='rhtv-asset:foreign';if(change==='plural-source')target.params.imageUrls=['rhtv-asset:foreign'];if(change==='other-tool'){target.toolsType='image-light';before.toolsType='image-light';}if(change==='edge')fixture.command.canvas.edges[0].source='unknown';
 const c=setup({graph:fixture.baseline,route:imageEditRoute});try{const run=c.adapter.run(fixture.command);if(change!=='valid'){await expect(run).rejects.toMatchObject({code:change==='edge'?'GRAPH_INPUT_INVALID':'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);return;}await run;const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body),data=body.graph.nodes.find((node:any)=>node.id==='n').data;expect(data.params).toEqual({imageUrls:target.params.imageUrls,prompt:'',text:''});expect(data.toolsType).toBe('image-enhance');expect(body.graph.edges).toEqual(fixture.baseline.edges);}finally{c.adapter.clear();}
});

it.each(['IMAGE_GIGAPIXEL','IMAGE_HD'].flatMap(tool=>['valid','prompt','text','singular-source','plural-source','tool-source','edge','other-param','preset','history','policy'].map(change=>({tool,change}))))('checks the real promptless Seed native command: $tool / $change',async({tool,change})=>{
 const fixture:any=structuredClone(nativeSeedEnhanceCommand),targetId=fixture.targetId,before=fixture.before.nodes.find((node:any)=>node.id===targetId).data,submitted=fixture.command.nodes.find((node:any)=>node.id===targetId).data,nativeTool=tool.toLowerCase().replaceAll('_','-');
 before.toolsType=before.subType=submitted.toolsType=submitted.subType=nativeTool;
 if(change==='prompt')submitted.params.prompt='forged';if(change==='text')submitted.params.text='forged';if(change==='singular-source')before.params.imageUrl='rhtv-asset:foreign';if(change==='plural-source')submitted.params.imageUrls=['rhtv-asset:foreign'];if(change==='tool-source')submitted.toolsSourceUrl='rhtv-asset:foreign';if(change==='edge')fixture.command.edges[0].source='unknown';if(change==='other-param')submitted.params.outputPreset='4x';if(change==='preset')submitted.presetSelections=[{id:'forged'}];if(change==='history')submitted.nodeOutputHistory=[{id:'forged'}];
 const selected={capabilityRef:'seedvr2-image-enhance-v1',version:'1',kind:'IMAGE_ENHANCE',title:'SeedVR2 3B FP8 · 2×',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'comfyui',modelRef:'seedvr2-3b-fp8',title:'SeedVR2 3B FP8'},parameterSchemaVersion:'1',parameterSchema:{'x-prompt-policy':change==='policy'?'required':'ignored',properties:{outputPreset:{type:'string',enum:['2x'],default:'2x'}}}};
 const c=setup({graph:fixture.before,route:(path)=>{
  if(path.includes('model-capabilities'))return json({items:[selected],nextCursor:null});
  if(path.startsWith('/api/v1/assets/'))return json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});
  if(path==='/api/v2/canvas-runs')return json({...task('QUEUED','PENDING'),testMode:false,plans:[{nodeId:targetId,executionId:'ex',state:'QUEUED',canvasBinding:{applicationState:'PENDING'},outputs:[]}]});
 }});
 try{
  const run=c.adapter.run({projectId:'p',targetType:'NODE',targetId,graph:fixture.command});
  if(change!=='valid'){await expect(run).rejects.toMatchObject({code:change==='edge'?'GRAPH_INPUT_INVALID':change==='other-param'?'MODEL_PARAMETER_INVALID':change==='policy'?'MODEL_INPUT_UNSUPPORTED':'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);return;}
  await run;const request=c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!,body=JSON.parse(request[1].body),data=body.graph.nodes.find((node:any)=>node.id===targetId).data;
  expect(body.graph.edges).toEqual(fixture.before.edges.filter((edge:any)=>edge.target===targetId));expect(body.graph.nodes.map((node:any)=>node.id).sort()).toEqual([targetId,...body.graph.edges.map((edge:any)=>edge.source)].sort());expect(body.expectedRevision).toBe(2);expect(data.toolsType).toBe(nativeTool);expect(data.routerParameters).toEqual({outputPreset:'2x'});expect(data.params).toEqual({outputPreset:'2x',imageUrls:before.params.imageUrls,prompt:'',text:''});
 }finally{c.adapter.clear();}
});

it.each(['valid','preset','history','output','stored-history','source-output','unsubmitted-default'])('checks mounted native defaults during generated-image erase: %s',async change=>{
 const fixture:any=structuredClone(nativeEraseDefaults),target=fixture.current.nodes.find((node:any)=>node.id==='n').data;
 if(change==='preset')target.presetSelections=[{id:'later'}];if(change==='history')target.nodeOutputHistory=[{id:'later'}];if(change==='output')target.output=[{url:'rhtv-asset:later'}];if(change==='stored-history')target.historyStorage={id:'later'};if(change==='source-output')fixture.current.nodes.find((node:any)=>node.id==='repaint-source').data.output[0].url='rhtv-asset:later';if(change==='unsubmitted-default')delete fixture.command.canvas.nodes[0].data.presetSelections;
 let finish!:(response:Response)=>void;const c=setup({graph:fixture.baseline,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):imageEditRoute(path)});
 try{const run=c.adapter.run(fixture.command),rejected=change==='valid'?undefined:expect(run).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));c.graph.nodes=fixture.current.nodes;c.graph.edges=fixture.current.edges;finish(json({items:[imageEditV3],nextCursor:null}));if(rejected){await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);return;}await run;const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body);expect(body.graph.nodes.find((node:any)=>node.id==='n').data).toMatchObject({presetSelections:[],nodeOutputHistory:[]});expect(body.graph.edges).toEqual(fixture.baseline.edges);expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it.each(['valid','prompt','source','subtype','connections','extra-connection','different-model'])('checks the captured native quick-scene model mount: %s',async change=>{
 const fixture:any=structuredClone(nativeStoryMount),target=fixture.current.nodes.find((node:any)=>node.id==='n').data;
 if(change==='prompt')target.params.prompt='later input';if(change==='source')target.params.imageUrls=['rhtv-asset:foreign'];if(change==='subtype')target.subType='text-image';if(change==='connections')target.maxConnect.image=4;if(change==='extra-connection')target.maxConnect.other=null;if(change==='different-model')target.modelCode='different';
 let finish!:(response:Response)=>void;const c=setup({graph:fixture.baseline,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):imageEditRoute(path)});
 try{const run=c.adapter.run(fixture.command),rejected=change==='valid'?undefined:expect(run).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));c.graph.nodes=fixture.current.nodes;c.graph.edges=fixture.current.edges;finish(json({items:[{...imageEditV3,model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'}}],nextCursor:null}));if(rejected){await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);return;}await run;const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body),data=body.graph.nodes.find((node:any)=>node.id==='n').data;expect(data).toMatchObject({modelCode:'codex-image-edit-v1',subType:'image-image',maxConnect:{image:null,text:null,video:null},params:{prompt:''}});expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it.each(['valid','foreign-reference','reordered-reference','missing-style','forged-prompt','changed-source','changed-edge'])('checks the captured native style + camera + filter command: %s',async change=>{
 const fixture:any=structuredClone(nativeStyleCamera),target=fixture.command.canvas.nodes.find((node:any)=>node.id==='n').data;
 if(change==='foreign-reference')target.params.imageUrls[1]='rhtv-asset:foreign';if(change==='reordered-reference')target.params.imageUrls.reverse();if(change==='missing-style')target.params.imageUrls.pop();if(change==='forged-prompt')target.params.prompt+=' forged';if(change==='changed-source')fixture.command.canvas.nodes.find((node:any)=>node.id==='source').data.output[0].url='rhtv-asset:foreign';if(change==='changed-edge')fixture.command.canvas.edges[0].targetHandle='changed';
 const c=setup({graph:fixture.baseline,route:path=>path==='/api/v2/catalog/media/materialize'?json({asset:{byteSize:2048,mimeType:'image/png',id:'style-owned',kind:'IMAGE',state:'READY'}}):imageEditRoute(path)});
 try{const run=c.adapter.run(fixture.command);if(change!=='valid'){await expect(run).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);return;}await run;const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body),data=body.graph.nodes.find((node:any)=>node.id==='n').data;expect(data.params.imageUrls).toEqual(['rhtv-asset:owned','rhtv-asset:style-owned']);expect(data.params.prompt).toBe(target.userPromptSnapshot.value);expect(data.params.text).toBe(target.userPromptSnapshot.value);expect(data.presetSelections).toEqual(target.presetSelections);expect(data.cameraControl).toEqual(target.cameraControl);expect(body.graph.edges).toEqual(fixture.baseline.edges);}finally{c.adapter.clear();}
});

it('submits the captured promptless native cutout with W8 empty defaults and actual transparent output enabled',async()=>{
 const fixture=structuredClone(nativePromptlessCutout),c=setup({graph:fixture.baseline,route:imageEditRoute});
 try{await c.adapter.run(fixture.command);const requests=c.transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs');expect(requests).toHaveLength(1);const body=JSON.parse(requests[0][1].body),target=body.graph.nodes.find((node:any)=>node.id==='n');expect(body.graph.edges).toEqual(fixture.baseline.edges);expect(target.data.routerParameters.transparentBackground).toBe(true);expect(target.data.params.prompt).toBeUndefined();expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it('preserves same-asset upload metadata from the actual save receipt when the mounted image omits it',async()=>{
 const fixture=structuredClone(nativePromptlessCutout),c=setup({graph:fixture.baseline,route:(path,init)=>path==='/api/v1/projects/p/snapshot'?json({projectId:'p',revision:3,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-07T00:00:00Z'}):imageEditRoute(path)}),authoritative=structuredClone(fixture.baseline);
 Object.assign(authoritative.nodes.find(node=>node.id==='source')!.data,{assetIds:['owned'],isUpload:true});
 c.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:2,graph:encodeGraph(authoritative),updatedAt:'2026-10-07T00:00:00Z'},'"2"');c.storage.attachNativeView('p',fixture.baseline);
 try{await c.adapter.run(fixture.command);const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body),saved=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v1/projects/p/snapshot')![1].body);expect(body.graph.nodes.find((node:any)=>node.id==='source').data).toEqual(saved.graph.nodes.find((node:any)=>node.id==='source').data);expect(body.graph.nodes.find((node:any)=>node.id==='source').data).toMatchObject({assetIds:['owned'],isUpload:true});expect(fixture.baseline.nodes.find(node=>node.id==='source')!.data).not.toHaveProperty('assetIds');}finally{c.adapter.clear();}
});

it.each(['different-asset','extra-asset','false-upload','source-image','source-prompt','target-prompt','edge'])('rejects changed execution save receipt input: %s',async change=>{
 const fixture=structuredClone(nativePromptlessCutout),c=setup({graph:fixture.baseline,route:(path,init)=>{
  if(path!=='/api/v1/projects/p/snapshot')return imageEditRoute(path);
  const graph=JSON.parse(init.body).graph,source=graph.nodes.find((node:any)=>node.id==='source').data,target=graph.nodes.find((node:any)=>node.id==='n').data;
  Object.assign(source,{assetIds:['owned'],isUpload:true});if(change==='different-asset')source.assetIds=['foreign'];if(change==='extra-asset')source.assetIds.push('foreign');if(change==='false-upload')source.isUpload=false;if(change==='source-image')source.sourceObjects=['rhtv-asset:foreign'];if(change==='source-prompt')source.params={prompt:'changed'};if(change==='target-prompt')target.params.prompt='changed';if(change==='edge')graph.edges[0].targetHandle='different';
  return json({projectId:'p',revision:2,graph,updatedAt:'2026-10-07T00:00:00Z'});
 }});
 try{await expect(c.adapter.run(fixture.command)).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it.each(['new-preset','new-history','existing-preset','existing-history','stored-history','existing-output'])('rejects promptless native cutout metadata changes: %s',async change=>{
 const fixture:any=structuredClone(nativePromptlessCutout),before=fixture.baseline.nodes.find((node:any)=>node.id==='n').data,submitted=fixture.command.canvas.nodes.find((node:any)=>node.id==='n').data;
 if(change==='new-preset')submitted.presetSelections=[{key:'filter',id:'forged'}];if(change==='new-history')submitted.nodeOutputHistory=[{outputId:'forged'}];if(change==='existing-preset')before.presetSelections=[{key:'filter',id:'saved'}];if(change==='existing-history')before.nodeOutputHistory=[{outputId:'saved'}];if(change==='stored-history')before.historyStorage={id:'saved'};if(change==='existing-output')before.output=[{url:'rhtv-asset:owned'}];
 const c=setup({graph:fixture.baseline,route:imageEditRoute});try{await expect(c.adapter.run(fixture.command)).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});
const recoveredTask=(state='SUCCEEDED',binding='DETACHED')=>({...task(state,binding),kind:'CANVAS',targetType:'NODE',targetId:'n'});

it.each(['estimate-only','cache-only'])('verifies and releases a remembered detached run after reload with %s lookup evidence',async hint=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{status:'idle',...(hint==='estimate-only'?{estimateTaskId:'t'}:{})}}],edges:[]},c=setup({graph,route:path=>path==='/api/v2/tasks/t'?json(recoveredTask()):undefined}),running=nativeRunning(c),settled=vi.fn(update=>{expect(update.current()).toBe(true);running.release();}),done=vi.fn();c.adapter.onSettled(settled);c.adapter.onTerminal(done);
 try{expect(c.adapter.recoverNativeRunning('n',c.manager,'t',45000)).toBe(true);await vi.waitFor(()=>expect(settled).toHaveBeenCalledOnce());expect(settled.mock.calls[0][0]).toMatchObject({kind:'DETACHED',nodeId:'n',taskId:'t'});expect(done).not.toHaveBeenCalled();expect(running.active()).toBe(false);expect(c.patch).not.toHaveBeenCalled();expect(c.flush).not.toHaveBeenCalled();expect(c.graph).toEqual(graph);expect(c.transport.mock.calls.map(([path])=>path)).toEqual(['/api/v2/tasks/t']);}finally{c.adapter.clear();}
});

it.each(['id','project','node','duplicate-plan','legacy','binding','execution','kind','target-type','target-id','404','403'])('leaves the restored overlay alone when owner task verification fails: %s',async mismatch=>{
 const response:any=recoveredTask();if(mismatch==='id')response.id='foreign';if(mismatch==='project')response.projectId='q';if(mismatch==='node')response.plans[0].nodeId='foreign';if(mismatch==='duplicate-plan')response.plans.push(response.plans[0]);if(mismatch==='legacy')response.canvasManaged=false;if(mismatch==='binding')delete response.plans[0].canvasBinding;if(mismatch==='execution')delete response.plans[0].executionId;if(mismatch==='kind')response.kind='APP';if(mismatch==='target-type')response.targetType='GROUP';if(mismatch==='target-id')response.targetId='foreign';
 const c=setup({route:path=>path==='/api/v2/tasks/t'?['404','403'].includes(mismatch)?new Response(JSON.stringify({error:{code:'NOT_AVAILABLE',message:'not available'}}),{status:Number(mismatch)}):json(response):undefined}),running=nativeRunning(c),settled=vi.fn(),done=vi.fn();c.adapter.onSettled(settled);c.adapter.onTerminal(done);
 try{c.adapter.recoverNativeRunning('n',c.manager,'t',45000);await vi.waitFor(()=>expect((c.adapter as any).recoveredRuns.size).toBe(0));expect(settled).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();expect(running.active()).toBe(true);expect(c.patch).not.toHaveBeenCalled();expect(c.flush).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['mark','row','project','task','estimate','clear','dispose'])('fences a late verified detached recovery after a newer %s',async replacement=>{
 let finish!:(value:Response)=>void;const c=setup({route:path=>path==='/api/v2/tasks/t'?new Promise(resolve=>finish=resolve):undefined}),running=nativeRunning(c),settled=vi.fn();c.adapter.onSettled(settled);
 try{c.adapter.recoverNativeRunning('n',c.manager,'t',45000);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));if(replacement==='mark')running.mark();if(replacement==='row')running.rebuild();if(replacement==='project')c.adapter.attach('q',c.manager);if(replacement==='task')c.graph.nodes[0].data.taskId='foreign';if(replacement==='estimate')c.graph.nodes[0].data.estimateTaskId='foreign';if(replacement==='clear')c.adapter.clear();if(replacement==='dispose')running.disposePort();finish(json(recoveredTask()));await vi.waitFor(()=>expect((c.adapter as any).recoveredRuns.size).toBe(0));expect(settled).not.toHaveBeenCalled();expect(running.active()).toBe(true);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('polls a verified remembered run until detached and respects the original recovery TTL',async()=>{
 vi.useFakeTimers();let reads=0;const c=setup({route:path=>path==='/api/v2/tasks/t'?json(++reads===1?recoveredTask('QUEUED','PENDING'):reads===2?recoveredTask('RUNNING','PENDING'):recoveredTask()):undefined}),running=nativeRunning(c),settled=vi.fn(()=>running.release());c.adapter.onSettled(settled);
 try{c.adapter.recoverNativeRunning('n',c.manager,'t',45000);await vi.advanceTimersByTimeAsync(2000);expect(reads).toBe(3);expect(settled).toHaveBeenCalledOnce();expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('keeps a verified detached settlement until the idle snapshot applies and rechecks listeners against a new mark',async()=>{
 let finish!:(value:Response)=>void;const c=setup({route:path=>path==='/api/v2/tasks/t'?new Promise(resolve=>finish=resolve):undefined}),running=nativeRunning(c),first=vi.fn(()=>running.mark()),second=vi.fn();c.adapter.onSettled(first);c.adapter.onSettled(second);
 try{c.adapter.recoverNativeRunning('n',c.manager,'t',45000);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));Object.assign(c.graph.nodes[0].data,{status:'processing',taskId:'t'});finish(json(recoveredTask()));await vi.waitFor(()=>expect(c.notice).toHaveBeenCalled());expect(first).not.toHaveBeenCalled();Object.assign(c.graph.nodes[0].data,{status:'idle',taskId:''});c.adapter.syncApplied('p',c.manager,[],4);expect(first).toHaveBeenCalledOnce();expect(second).not.toHaveBeenCalled();expect(running.active()).toBe(true);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('does not manufacture a terminal notification from a recovered APPLIED task without a coherent snapshot',async()=>{
 const c=setup({route:path=>path==='/api/v2/tasks/t'?json(recoveredTask('SUCCEEDED','APPLIED')):undefined}),running=nativeRunning(c),settled=vi.fn(),done=vi.fn();c.adapter.onSettled(settled);c.adapter.onTerminal(done);
 try{c.adapter.recoverNativeRunning('n',c.manager,'t',45000);await vi.waitFor(()=>expect((c.adapter as any).recoveredRuns.size).toBe(0));expect(settled).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();expect(running.active()).toBe(true);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('reuses only a previously applied coherent terminal notification after a late native hydration mark',async()=>{
 const c=setup({route:path=>path==='/api/v2/tasks/t'?json(recoveredTask('SUCCEEDED','APPLIED')):undefined}),running=nativeRunning(c),done=vi.fn(()=>running.release()),settled=vi.fn();c.adapter.onTerminal(done);c.adapter.onSettled(settled);
 try{Object.assign(c.graph.nodes[0].data,{taskId:'t',status:'finished'});c.adapter.syncApplied('p',c.manager,[state()],3);expect(done).toHaveBeenCalledOnce();running.mark();expect(c.adapter.recoverNativeRunning('n',c.manager,'t',45000)).toBe(true);await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2));expect(settled).not.toHaveBeenCalled();expect(running.active()).toBe(false);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['current','expired-token'])('recovers an accepted existing %s attempt after its normal status poll failed',async source=>{
 let reads=0;const c=setup({route:path=>path==='/api/v2/canvas-runs'?json(task('QUEUED','PENDING')):path==='/api/v2/tasks/t'?++reads===1?new Response(JSON.stringify({error:{code:'TEMPORARY',message:'temporary lookup failure'}}),{status:503}):json(recoveredTask()):undefined}),running=nativeRunning(c),settled=vi.fn(()=>running.release());c.adapter.onSettled(settled);
 try{await run(c);await vi.waitFor(()=>expect((c.adapter as any).polls.size).toBe(0));expect(running.capture).toHaveBeenCalledOnce();if(source==='expired-token')running.mark();expect(c.adapter.recoverNativeRunning('n',c.manager,'t',45000)).toBe(true);await vi.waitFor(()=>expect(settled).toHaveBeenCalledOnce());expect(running.capture).toHaveBeenCalledTimes(source==='current'?1:2);expect(running.active()).toBe(false);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['row','project','task','attempt'])('binds an accepted managed receipt to a lease whose %s ownership remains guarded',async change=>{
 const c=setup(),running=nativeRunning(c);try{await run(c);expect(running.accepted).toHaveBeenCalledExactlyOnceWith('t',expect.any(Function));const ownerCurrent=running.accepted.mock.calls[0][1];expect(ownerCurrent()).toBe(true);
  if(change==='row')running.rebuild();if(change==='project')c.adapter.attach('q',c.manager);if(change==='task'){Object.assign(c.graph.nodes[0].data,{taskId:'new-task',status:'processing'});c.adapter.syncApplied('p',c.manager,[state({taskId:'new-task',state:'RUNNING',applicationState:'PENDING'})],3);}if(change==='attempt'){running.mark();c.saved.mockRejectedValue(new Error('preflight stop'));await expect(run(c)).rejects.toThrow('preflight stop');}expect(ownerCurrent()).toBe(false);
 }finally{c.adapter.clear();}
});

it.each(['rh-text','rh-image'])('saves the captured native %s command projection and recalculates it for a second prompt',async type=>{
 const selected=type==='rh-text'?cap:{...cap,capabilityRef:'mock-image',kind:'TEXT_TO_IMAGE'},graph:NativeGraph={nodes:[{id:'n',type,position:{x:0,y:0},data:{modelCode:selected.capabilityRef,subType:type==='rh-text'?'text-text':'text-image',...(type==='rh-text'?{textModelListType:'multimodal-text'}:{prompt:'P1'}),params:{prompt:'P1'},width:300,height:268}}],edges:[]};
 let finish!:(response:Response)=>void,saves=1;const c=setup({graph,route:(path,init)=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):path==='/api/v1/projects/p/snapshot'?json({projectId:'p',revision:++saves,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-06T10:00:00Z'}):undefined});
 const command=(prompt:string)=>{const value=structuredClone(graph),data=value.nodes[0].data;Object.assign(data,{userPromptSnapshot:{paramName:'prompt',value:prompt},modelType:type==='rh-text'?'LLM':'OPENAPI'});if(type==='rh-text')Object.assign(data,{subType:'multimodal-text',textModelListType:'multimodal-text',textUiCategory:'text-text'});else Object.assign(data,{params:{...data.params,text:prompt},presetSelections:[],nodeOutputHistory:[]});return value;};
 try{
  const first=c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command('P1')});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));Object.assign(graph.nodes[0].data,{width:480,height:320,opResize:true,title:'current title'});graph.nodes.push({id:'other',type:'rh-text',position:{x:5,y:6},data:{text:'current unrelated edit'}});finish(json({items:[selected],nextCursor:null}));await first;
  let save=c.transport.mock.calls.filter(([path])=>path==='/api/v1/projects/p/snapshot').at(-1)!,persisted=JSON.parse(save[1].body).graph.nodes.find((node:any)=>node.id==='n');expect(persisted.data).toMatchObject({userPromptSnapshot:{paramName:'prompt',value:'P1'},modelType:type==='rh-text'?'LLM':'OPENAPI',width:480,height:320,opResize:true,title:'current title'});expect(JSON.parse(save[1].body).graph.nodes.some((node:any)=>node.id==='other')).toBe(true);
  const firstCreate=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body);expect(firstCreate.expectedRevision).toBe(2);for(const key of ['params','subType','textModelListType','textUiCategory','userPromptSnapshot','modelType','presetSelections','nodeOutputHistory'])expect(persisted.data[key]).toEqual(firstCreate.graph.nodes.find((node:any)=>node.id==='n').data[key]);
  graph.nodes[0].data={...persisted.data,params:{...persisted.data.params,prompt:'P2'},...(type==='rh-image'?{prompt:'P2'}:{subType:'text-text'})};await c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command('P2')});
  save=c.transport.mock.calls.filter(([path])=>path==='/api/v1/projects/p/snapshot').at(-1)!;persisted=JSON.parse(save[1].body).graph.nodes.find((node:any)=>node.id==='n');expect(persisted.data.userPromptSnapshot).toEqual({paramName:'prompt',value:'P2'});expect(persisted.data.params.prompt).toBe('P2');if(type==='rh-image')expect(persisted.data.params.text).toBe('P2');expect(c.patch).not.toHaveBeenCalled();
 }finally{c.adapter.clear();}
});

it.each(['prompt','subType','snapshot','modelType','textAlias','preset'])('rejects a forged native command %s while preserving the actual mounted input',async change=>{
 const selected={...cap,capabilityRef:'mock-image',kind:'TEXT_TO_IMAGE'},graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode:selected.capabilityRef,subType:'text-image',prompt:'original input',params:{prompt:'original input'}}}],edges:[]},c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):undefined}),command=structuredClone(graph),data=command.nodes[0].data;
 Object.assign(data,{userPromptSnapshot:{paramName:'prompt',value:'original input'},modelType:'OPENAPI',params:{prompt:'original input',text:'original input'},presetSelections:[],nodeOutputHistory:[]});
 if(change==='prompt')data.params.prompt='forged input';if(change==='subType')data.subType='image-image';if(change==='snapshot')data.userPromptSnapshot.value='forged input';if(change==='modelType')data.modelType='LLM';if(change==='textAlias')data.params.text='forged input';if(change==='preset')data.presetSelections=[{promptCode:'forged-preset'}];
 try{await expect(c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command})).rejects.toMatchObject({code:change==='subType'?'MODEL_INPUT_UNSUPPORTED':'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);expect(graph.nodes[0].data.params.prompt).toBe('original input');expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('guards later prompt edits against the captured actual baseline while accepting the original native text projection',async()=>{
 let finish!:(response:Response)=>void;const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{modelCode:cap.capabilityRef,subType:'text-text',textModelListType:'multimodal-text',params:{prompt:'original input'}}}],edges:[]},c=setup({graph,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):undefined}),command=structuredClone(graph);Object.assign(command.nodes[0].data,{subType:'multimodal-text',textUiCategory:'text-text',modelType:'LLM',userPromptSnapshot:{paramName:'prompt',value:'original input'}});
 try{const pending=c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));graph.nodes[0].data.params.prompt='later edit';finish(json({items:[cap],nextCursor:null}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['model','history','output','preset'])('does not rebase a later %s input change while validating native derived fields',async change=>{
 let finish!:(response:Response)=>void;const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{modelCode:cap.capabilityRef,subType:'text-text',textModelListType:'multimodal-text',params:{prompt:'original input'}}}],edges:[]},c=setup({graph,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):undefined}),command=structuredClone(graph);Object.assign(command.nodes[0].data,{subType:'multimodal-text',textUiCategory:'text-text',modelType:'LLM',userPromptSnapshot:{paramName:'prompt',value:'original input'}});
 try{const pending=c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=graph.nodes[0].data;if(change==='model')data.modelCode='new-model';if(change==='history')data.historyStorage={source:'remote',schemaVersion:1,historyId:'new-history'};if(change==='output')data.output=[{text:'new user content'}];if(change==='preset')data.presetSelections=[{promptCode:'new-user-preset'}];finish(json({items:[cap],nextCursor:null}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['default','explicit'])('saves the %s model and exact parameters before enabling server writeback, without patching result fields',async selection=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{params:{prompt:'original input'},...(selection==='explicit'?{modelCode:cap.capabilityRef}:{})}}],edges:[]},c=setup({graph});try{
  await expect(run(c)).resolves.toEqual({taskId:'t',testMode:true});
  const save=c.transport.mock.calls.find(([path])=>path==='/api/v1/projects/p/snapshot')!,create=c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!;
  const persisted=JSON.parse(save[1].body).graph.nodes.find((node:any)=>node.id==='n'),submitted=JSON.parse(create[1].body);
  expect(persisted.data).toMatchObject({modelCode:'mock-llm',capabilityRef:'mock-llm',capabilityVersion:'1',parameterSchemaVersion:'1',routerParameters:{scenario:'success'},params:{prompt:'original input'}});
  expect(submitted).toMatchObject({expectedRevision:2,graph:{nodes:[expect.objectContaining({data:persisted.data})]}});expect(save[1].headers.get('If-Match')).toBe('"1"');expect(c.transport.mock.calls.indexOf(save)).toBeLessThan(c.transport.mock.calls.indexOf(create));
  expect(c.patch).not.toHaveBeenCalled();expect(c.graph.nodes[0].data).not.toHaveProperty('output');
  // Unknown routing/version fields absent from the native view do not become
  // a draft reverting the saved exact execution selection.
  c.storage.observeNativeDraft('p',c.graph);expect(c.storage.hasDraft('p')).toBe(false);
 }finally{c.adapter.clear();}
});

it('uses its actual save receipt revision even after a newer shared snapshot arrives',async()=>{
 const c=setup(),original=c.storage.saveForExecution.bind(c.storage);
 vi.spyOn(c.storage,'saveForExecution').mockImplementation(async(...args)=>{const receipt=await original(...args);c.storage.acceptRemoteSnapshot('p',{...receipt,revision:9},'"9"');return receipt;});
 try{await run(c);const create=c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!;expect(JSON.parse(create[1].body).expectedRevision).toBe(2);expect(c.storage.snapshots.get('p')!.revision).toBe(9);}finally{c.adapter.clear();}
});

it.each(['prompt','asset','edge'])('rejects a %s change during the exact save before submitting a model',async change=>{
 let finish!:(response:Response)=>void,body:any;const c=setup({route:(path,init)=>path==='/api/v1/projects/p/snapshot'?(body=JSON.parse(init.body),new Promise(resolve=>finish=resolve)):undefined});
 const pending=run(c),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 if(change==='prompt')c.graph.nodes[0].data.params.prompt='later user input';
 if(change==='asset')c.graph.nodes[0].data.sourceObjects=['rhtv-asset:new-input'];
 if(change==='edge'){c.graph.nodes.push({id:'upstream',type:'rh-text',position:{x:3,y:4},data:{text:'new reference'}});c.graph.edges.push({id:'new-edge',source:'upstream',target:'n'});}
 finish(json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-10-06T10:00:00Z'}));await rejected;
 expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);expect(c.patch).not.toHaveBeenCalled();c.adapter.clear();
});

it('rejects a deletion and same-ID recreation even with identical visible inputs during an exact save',async()=>{
 let finish!:(response:Response)=>void,body:any;const c=setup({route:(path,init)=>path==='/api/v1/projects/p/snapshot'?(body=JSON.parse(init.body),new Promise(resolve=>finish=resolve)):undefined});
 const row=()=>({get:(key:string)=>key==='id'?'n':undefined});let currentRow=row();Object.assign(c.manager,{ynodes:{toArray:()=>[currentRow]}});
 const pending=run(c),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));currentRow=row();c.graph.nodes[0]=structuredClone(c.graph.nodes[0]);
 finish(json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-10-06T10:00:00Z'}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);c.adapter.clear();
});

it('rejects a project switch while the exact save is pending before submitting a model',async()=>{
 let finish!:(response:Response)=>void,body:any;const c=setup({route:(path,init)=>path==='/api/v1/projects/p/snapshot'?(body=JSON.parse(init.body),new Promise(resolve=>finish=resolve)):undefined});
 const pending=run(c),rejected=expect(pending).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));c.adapter.attach('q',{...c.manager});
 finish(json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-10-06T10:00:00Z'}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);expect(c.patch).not.toHaveBeenCalled();c.adapter.clear();
});

it('checks changed input after save preparation and discards an unsent exact-selection save',async()=>{
 const c=setup(),original=c.storage.prepareGraph.bind(c.storage);let calls=0,finish!:()=>void;
 vi.spyOn(c.storage,'prepareGraph').mockImplementation(async graph=>{await original(graph);if(++calls===3)await new Promise<void>(resolve=>finish=resolve);});
 const pending=run(c),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));c.graph.nodes[0].data.params.prompt='new draft';finish();await rejected;
 expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);expect(c.storage.hasPending()).toBe(false);c.adapter.clear();
});

it('keeps a target move and unrelated edits while preparing a version-bound generation',async()=>{
 let catalog!:(response:Response)=>void;const c=setup({route:path=>path.includes('model-capabilities')?new Promise(resolve=>catalog=resolve):undefined});
 try{
  const pending=run(c);await vi.waitFor(()=>expect(catalog).toBeTypeOf('function'));c.graph.nodes[0].position={x:90,y:120};c.graph.nodes.push({id:'unrelated',type:'rh-text',position:{x:4,y:5},data:{params:{prompt:'independent user edit'}}});catalog(json({items:[cap],nextCursor:null}));await pending;
  const save=c.transport.mock.calls.find(([path])=>path==='/api/v1/projects/p/snapshot')!,persisted=JSON.parse(save[1].body).graph;expect(persisted.nodes.find((node:any)=>node.id==='n').position).toEqual({x:90,y:120});expect(persisted.nodes.find((node:any)=>node.id==='unrelated').data.params.prompt).toBe('independent user edit');expect(c.patch).not.toHaveBeenCalled();
 }finally{c.adapter.clear();}
});

it.each(['catalog','save'])('allows display geometry changes on the target and its ancestors while the %s is pending',async phase=>{
 let finish!:(response:Response)=>void,savedBody:any;
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{params:{prompt:'original input'},width:300,height:268}},{id:'upstream',type:'rh-text',position:{x:1,y:2},data:{text:'reference input',width:300,height:268}}],edges:[{id:'input',source:'upstream',target:'n'}]};
 const c=setup({graph,route:(path,init)=>phase==='catalog'&&path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):phase==='save'&&path==='/api/v1/projects/p/snapshot'?(savedBody=JSON.parse(init.body),new Promise(resolve=>finish=resolve)):undefined});
 try{
  const pending=run(c);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));for(const node of graph.nodes)Object.assign(node.data,{width:480,height:320,opResize:true});
  finish(phase==='catalog'?json({items:[cap],nextCursor:null}):json({projectId:'p',revision:2,graph:savedBody.graph,updatedAt:'2026-10-06T10:00:00Z'}));
  await expect(pending).resolves.toEqual({taskId:'t',testMode:true});const create=c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!;expect(JSON.parse(create[1].body).expectedRevision).toBe(2);expect(c.patch).not.toHaveBeenCalled();
  if(phase==='catalog'){const save=c.transport.mock.calls.find(([path])=>path==='/api/v1/projects/p/snapshot')!;for(const node of JSON.parse(save[1].body).graph.nodes.filter((value:any)=>['n','upstream'].includes(value.id)))expect(node.data).toMatchObject({width:480,height:320,opResize:true});}
 }finally{c.adapter.clear();}
});

it.each(['catalog','save'])('allows native receipt timing on the target and ancestors while the %s is pending, preserving the latest display fields',async phase=>{
 let finish!:(response:Response)=>void,savedBody:any;const graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{params:{prompt:'original input'}}},{id:'upstream',type:'rh-text',position:{x:1,y:2},data:{text:'reference input'}}],edges:[{id:'input',source:'upstream',target:'n'}]},selected={...cap,capabilityRef:'mock-image',kind:'TEXT_TO_IMAGE'};
 const c=setup({graph,route:(path,init)=>path.includes('model-capabilities')?phase==='catalog'?new Promise(resolve=>finish=resolve):json({items:[selected],nextCursor:null}):phase==='save'&&path==='/api/v1/projects/p/snapshot'?(savedBody=JSON.parse(init.body),new Promise(resolve=>finish=resolve)):undefined});
 try{const pending=run(c);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));for(const node of graph.nodes)Object.assign(node.data,{estimateTaskId:'previous-task',generationStartedAt:1791297866546,estimatedSeconds:120});finish(phase==='catalog'?json({items:[selected],nextCursor:null}):json({projectId:'p',revision:2,graph:savedBody.graph,updatedAt:'2026-10-06T10:00:00Z'}));await expect(pending).resolves.toEqual({taskId:'t',testMode:true});expect(c.patch).not.toHaveBeenCalled();
  if(phase==='catalog'){const save=c.transport.mock.calls.find(([path])=>path==='/api/v1/projects/p/snapshot')!;for(const node of JSON.parse(save[1].body).graph.nodes.filter((value:any)=>['n','upstream'].includes(value.id)))expect(node.data).toMatchObject({estimateTaskId:'previous-task',generationStartedAt:1791297866546,estimatedSeconds:120});}
 }finally{c.adapter.clear();}
});

it.each(['params','routerParameters','output'].flatMap(field=>['estimateTaskId','generationStartedAt','estimatedSeconds'].map(key=>[field,key])))('keeps nested %s.%s sensitive while excluding only native display timing',async(field,key)=>{
 let finish!:(response:Response)=>void;const timing={estimateTaskId:'previous-task',generationStartedAt:1000,estimatedSeconds:120},graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{params:{prompt:'original input',...timing},routerParameters:{scenario:'success',...timing},output:[{text:'existing output',...timing}]}}],edges:[]},c=setup({graph,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):undefined});
 try{const pending=run(c),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const value=field==='output'?graph.nodes[0].data.output[0]:graph.nodes[0].data[field];value[key]=key==='estimateTaskId'?'later-task':value[key]+1;finish(json({items:[cap],nextCursor:null}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['params','routerParameters','output'].flatMap(field=>['width','height'].map(dimension=>[field,dimension])))('keeps %s.%s changes sensitive while ignoring only top-level display dimensions',async(field,dimension)=>{
 let finish!:(response:Response)=>void;const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{params:{prompt:'original input',width:100,height:200},routerParameters:{scenario:'success',width:100,height:200},output:[{text:'existing output',width:100,height:200}],width:300,height:268}}],edges:[]};
 const c=setup({graph,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):undefined});
 try{
  const pending=run(c),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const value=field==='output'?graph.nodes[0].data.output[0]:graph.nodes[0].data[field];value[dimension]++;
  finish(json({items:[cap],nextCursor:null}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);expect(c.patch).not.toHaveBeenCalled();
 }finally{c.adapter.clear();}
});

it('rejects a supplied ordinary node that was already deleted without falling back to legacy generation',async()=>{
 const c=setup(),supplied=structuredClone(c.graph);c.graph.nodes=[];
 try{await expect(c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:supplied})).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot'||path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it('requires a saved base for a loaded project instead of silently sending an unprotected legacy task',async()=>{
 const c=setup();c.storage.snapshots.delete('p');c.storage.projects.set('p',{id:'p'} as any);
 try{await expect(run(c)).rejects.toMatchObject({code:'BASE_UNKNOWN'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it('only notifies a managed completion after that server result has reached the current native graph',async()=>{
 const c=setup(),terminal=vi.fn();c.adapter.onTerminal(terminal);try{
  await run(c);c.adapter.syncApplied('p',c.manager,[state()]);expect(terminal).not.toHaveBeenCalled();
  Object.assign(c.graph.nodes[0].data,{taskId:'t',status:'finished',text:'verified response',output:[{text:'verified response'}]});
  c.adapter.syncApplied('p',{...c.manager},[state()]);expect(terminal).not.toHaveBeenCalled();c.adapter.syncApplied('p',c.manager,[state()]);c.adapter.syncApplied('p',c.manager,[state()]);
  expect(terminal).toHaveBeenCalledExactlyOnceWith({nodeId:'n',taskId:'t',projectId:'p',manager:c.manager,status:'SUCCESS'});expect(c.patch).not.toHaveBeenCalled();const restored=vi.fn();c.adapter.onTerminal(restored);expect(restored).toHaveBeenCalledOnce();
  c.graph.nodes[0].data.taskId='newer-task';const late=vi.fn();c.adapter.onTerminal(late);expect(late).not.toHaveBeenCalled();c.adapter.syncApplied('p',c.manager,[state()]);expect(terminal).toHaveBeenCalledOnce();
 }finally{c.adapter.clear();}
});

it('rechecks node ownership between terminal listeners when an earlier listener replaces the task',async()=>{
 const c=setup(),second=vi.fn();c.adapter.onTerminal(()=>{c.graph.nodes[0].data.taskId='new-task';});c.adapter.onTerminal(second);
 try{await run(c);Object.assign(c.graph.nodes[0].data,{taskId:'t',status:'finished'});c.adapter.syncApplied('p',c.manager,[state()],3);expect(second).not.toHaveBeenCalled();expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('polls a restored managed receipt without writing its outputs or claiming success before live sync',async()=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{taskId:'t',status:'processing',text:'current user content'}}],edges:[]},c=setup({graph}),terminal=vi.fn();c.adapter.onTerminal(terminal);
 try{await vi.waitFor(()=>expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/t')).toBe(true));expect(c.patch).not.toHaveBeenCalled();expect(terminal).not.toHaveBeenCalled();expect(graph.nodes[0].data.text).toBe('current user content');}finally{c.adapter.clear();}
});

it('uses a remote RUNNING binding for cancellation after another tab starts a new task',async()=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{taskId:'t',status:'processing'}}],edges:[]};
 const c=setup({graph,route:path=>path==='/api/v2/tasks/remote/cancel'?json({...task('CANCELED'),id:'remote'}):undefined});
 try{await vi.waitFor(()=>expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/t')).toBe(true));Object.assign(graph.nodes[0].data,{taskId:'remote',status:'processing'});c.adapter.syncApplied('p',c.manager,[state({taskId:'remote',executionId:'remote-ex',state:'RUNNING',applicationState:'PENDING'})],3);await c.adapter.cancelNode('n');expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/remote/cancel')).toBe(true);expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/t/cancel')).toBe(false);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('keeps one real terminal notification when the result snapshot arrives before its POST receipt',async()=>{
 let accept!:(response:Response)=>void;const c=setup({route:path=>path==='/api/v2/canvas-runs'?new Promise(resolve=>accept=resolve):undefined}),terminal=vi.fn();c.adapter.onTerminal(terminal);
 try{
  const pending=run(c);await vi.waitFor(()=>expect(accept).toBeTypeOf('function'));Object.assign(c.graph.nodes[0].data,{taskId:'t',status:'finished',text:'verified response'});c.adapter.syncApplied('p',c.manager,[state()],3);expect(terminal).toHaveBeenCalledOnce();
  accept(json(task('QUEUED','PENDING')));await pending;await vi.waitFor(()=>expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/t')).toBe(true));c.adapter.syncApplied('p',c.manager,[state()],3);expect(terminal).toHaveBeenCalledOnce();expect(c.patch).not.toHaveBeenCalled();const restored=vi.fn();c.adapter.onTerminal(restored);expect(restored).toHaveBeenCalledOnce();
 }finally{c.adapter.clear();}
});

it('does not let an older delayed receipt replace the authoritative task started in another tab',async()=>{
 let accept!:(response:Response)=>void;const c=setup({route:path=>path==='/api/v2/canvas-runs'?new Promise(resolve=>accept=resolve):path==='/api/v2/tasks/remote/cancel'?json({...task('CANCELED'),id:'remote'}):undefined}),terminal=vi.fn();c.adapter.onTerminal(terminal);
 try{
  const pending=run(c);await vi.waitFor(()=>expect(accept).toBeTypeOf('function'));Object.assign(c.graph.nodes[0].data,{taskId:'remote',status:'finished',text:'remote result'});c.adapter.syncApplied('p',c.manager,[state({taskId:'remote',executionId:'remote-ex'})],4);
  accept(json(task('QUEUED','PENDING')));await pending;await c.adapter.cancelNode('n');expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/remote/cancel')).toBe(true);expect(terminal).toHaveBeenCalledOnce();expect(c.patch).not.toHaveBeenCalled();expect(c.graph.nodes[0].data.text).toBe('remote result');const restored=vi.fn();c.adapter.onTerminal(restored);expect(restored).toHaveBeenCalledOnce();
 }finally{c.adapter.clear();}
});

it('does not replace a newly accepted binding with a snapshot from its saved input revision',async()=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{taskId:'old',status:'finished',params:{prompt:'new input'}}}],edges:[]};
 const c=setup({graph,route:path=>path==='/api/v2/canvas-runs'?json(task('QUEUED','PENDING')):path==='/api/v2/tasks/t/cancel'?json(task('CANCELED')):undefined});
 try{await run(c);c.adapter.syncApplied('p',c.manager,[state({taskId:'old',executionId:'old-ex'})],2);await c.adapter.cancelNode('n');expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/tasks/t/cancel')).toBe(true);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('preserves detached real results in history and deduplicates the notice without overwriting user edits',async()=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/t/cancel'?json({...task('SUCCEEDED','DETACHED'),plans:[{...task().plans[0],canvasBinding:{applicationState:'DETACHED',reason:'INPUT_CHANGED'}}]}):undefined});
 try{await run(c);await c.adapter.cancel('t');expect(c.notice).toHaveBeenCalledOnce();expect(c.notice).toHaveBeenCalledWith('画布已更改，本次生成结果保留在历史记录中。');expect(c.patch).not.toHaveBeenCalled();expect(c.graph.nodes[0].data.params.prompt).toBe('original input');}finally{c.adapter.clear();}
});

it.each([
 ['OUTPUT_UNAVAILABLE','生成结果的素材已不可用，本次结果未能写回画布。'],
 ['INPUT_UNAVAILABLE','生成输入已不可用，本次结果未能写回画布。'],
 ['RESULT_TOO_LARGE','生成结果超过画布大小限制，本次结果未能写回画布，可在历史记录中查看。'],
])('explains %s without blaming a canvas edit or duplicating a synced notice',async(reason,message)=>{
 const detached={...task('SUCCEEDED','DETACHED'),plans:[{...task().plans[0],canvasBinding:{applicationState:'DETACHED',reason}}]},c=setup({route:path=>path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/t/cancel'?json(detached):undefined}),terminal=vi.fn();c.adapter.onTerminal(terminal);
 try{await run(c);await c.adapter.cancel('t');Object.assign(c.graph.nodes[0].data,{taskId:'t',status:'processing'});c.adapter.syncApplied('p',c.manager,[state({applicationState:'DETACHED',reason})],3);expect(c.notice).toHaveBeenCalledExactlyOnceWith(message);expect(c.patch).not.toHaveBeenCalled();expect(terminal).not.toHaveBeenCalled();expect(c.graph.nodes[0].data.params.prompt).toBe('original input');}finally{c.adapter.clear();}
});

const detachedTask=()=>({...task('SUCCEEDED','DETACHED'),plans:[{...task().plans[0],canvasBinding:{applicationState:'DETACHED',reason:'INPUT_CHANGED'}}]});

it('settles only the local overlay for a verified detached task without fabricating a model terminal state',async()=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/t/cancel'?json(detachedTask()):undefined}),running=nativeRunning(c),settled=vi.fn((update:any)=>{expect(update.current()).toBe(true);running.release();}),terminal=vi.fn();c.adapter.onSettled(settled);c.adapter.onTerminal(terminal);
 try{await run(c);await c.adapter.cancel('t');expect(settled).toHaveBeenCalledOnce();expect(settled.mock.calls[0][0]).toMatchObject({kind:'DETACHED',nodeId:'n',taskId:'t',projectId:'p',manager:c.manager,reason:'INPUT_CHANGED'});expect(terminal).not.toHaveBeenCalled();expect(c.patch).not.toHaveBeenCalled();expect(c.flush).toHaveBeenCalledExactlyOnceWith(true);expect(c.graph.nodes[0].data).not.toHaveProperty('output');expect(running.active()).toBe(false);}finally{c.adapter.clear();}
});

it('waits for the idle graph after a terminal receipt and settles even when the applied snapshot has no node states',async()=>{
 const c=setup({route:(path,_init,control)=>path==='/api/v2/canvas-runs'?(Object.assign(control.graph.nodes[0].data,{taskId:'t',status:'processing'}),json(detachedTask())):undefined}),running=nativeRunning(c),settled=vi.fn(()=>running.release()),terminal=vi.fn();c.adapter.onSettled(settled);c.adapter.onTerminal(terminal);
 try{await run(c);expect(settled).not.toHaveBeenCalled();Object.assign(c.graph.nodes[0].data,{taskId:'',status:'idle'});c.adapter.syncApplied('p',c.manager,[],3);c.adapter.syncApplied('p',c.manager,[],3);expect(settled).toHaveBeenCalledOnce();expect(terminal).not.toHaveBeenCalled();expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['mark','row','task','project'])('does not settle an old detached overlay after a later %s replaces its owner',async replace=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'?json(task('QUEUED','PENDING')):path==='/api/v2/tasks/t'?new Promise(()=>{}):path==='/api/v2/tasks/t/cancel'?json(detachedTask()):undefined}),running=nativeRunning(c),settled=vi.fn();c.adapter.onSettled(settled);
 try{await run(c);if(replace==='mark')running.mark();if(replace==='row')running.rebuild();if(replace==='task')c.graph.nodes[0].data.taskId='new-task';if(replace==='project')c.adapter.attach('q',c.manager);await c.adapter.cancel('t');c.adapter.syncApplied('p',c.manager,[],3);expect(settled).not.toHaveBeenCalled();expect(running.active()).toBe(true);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('rechecks the native run token between settlement listeners before releasing an overlay marked by a later run',async()=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'?json(task('QUEUED','PENDING')):path==='/api/v2/tasks/t'?new Promise(()=>{}):path==='/api/v2/tasks/t/cancel'?json(detachedTask()):undefined}),running=nativeRunning(c),second=vi.fn();c.adapter.onSettled(()=>running.mark());c.adapter.onSettled(second);
 try{await run(c);await c.adapter.cancel('t');expect(second).not.toHaveBeenCalled();expect(running.active()).toBe(true);expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('registers a later local attempt before its save await so an old detached task cannot release it',async()=>{
 let finish!:()=>void,creates=0;const c=setup({route:path=>path==='/api/v2/canvas-runs'?json({...task('QUEUED','PENDING'),id:++creates===1?'t':'new-task'}):path==='/api/v2/tasks/t'||path==='/api/v2/tasks/new-task'?new Promise(()=>{}):path==='/api/v2/tasks/t/cancel'?json(detachedTask()):undefined}),running=nativeRunning(c),settled=vi.fn();c.adapter.onSettled(settled);
 c.graph.nodes[0].data.modelCode=cap.capabilityRef;
 try{await run(c);running.mark();c.saved.mockImplementation(()=>new Promise<void>(resolve=>finish=resolve));const newer=run(c);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));await c.adapter.cancel('t');expect(settled).not.toHaveBeenCalled();expect(running.active()).toBe(true);finish();await newer;expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['preflight','later-mark','post-unknown'])('releases a definitely unsubmitted attempt only when safe: %s',async mode=>{
 let finish!:(value?:any)=>void;const c=setup({route:path=>mode==='post-unknown'&&path==='/api/v2/canvas-runs'?new Response(JSON.stringify({error:{code:'SERVER_ERROR',message:'unknown submission'}}),{status:502}):undefined}),running=nativeRunning(c),settled=vi.fn(()=>running.release()),terminal=vi.fn();c.adapter.onSettled(settled);c.adapter.onTerminal(terminal);
 if(mode!=='post-unknown')c.saved.mockImplementation(()=>new Promise((_resolve,reject)=>{finish=reject;}));
 try{const pending=run(c),rejected=expect(pending).rejects.toBeInstanceOf(Error);if(mode!=='post-unknown'){await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));if(mode==='later-mark')running.mark();finish(new Error('explicit preflight failure'));}await rejected;expect(settled).toHaveBeenCalledTimes(mode==='preflight'?1:0);if(mode==='preflight')expect(settled.mock.calls[0][0]).toMatchObject({kind:'NOT_SUBMITTED',nodeId:'n'});expect(running.active()).toBe(mode!=='preflight');expect(terminal).not.toHaveBeenCalled();expect(c.patch).not.toHaveBeenCalled();expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(mode==='post-unknown');}finally{c.adapter.clear();}
});

it('fails closed on an invalid server marker instead of silently performing legacy writeback',async()=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'?json({...task(),plans:[{...task().plans[0],canvasBinding:{applicationState:'UNKNOWN'}}]}):undefined});
 try{await expect(run(c)).rejects.toMatchObject({code:'INVALID_CANVAS_EXECUTION'});expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('rejects a missing server-writeback acknowledgement for a version-bound request',async()=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'?json({...task(),canvasManaged:undefined,plans:task().plans.map(({canvasBinding,...plan})=>plan)}):undefined});
 try{await expect(run(c)).rejects.toMatchObject({code:'INVALID_CANVAS_EXECUTION'});expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it.each(['project','node'])('rejects a version-bound acknowledgement for another %s',async mismatch=>{
 const c=setup({route:path=>path==='/api/v2/canvas-runs'?json({...task(),...(mismatch==='project'?{projectId:'q'}:{}),plans:task().plans.map(plan=>({...plan,...(mismatch==='node'?{nodeId:'other'}:{})}))}):undefined});
 try{await expect(run(c)).rejects.toMatchObject({code:'INVALID_CANVAS_EXECUTION'});expect(c.patch).not.toHaveBeenCalled();}finally{c.adapter.clear();}
});

it('keeps an existing script generation on its explicit legacy path',async()=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-script',position:{x:0,y:0},data:{params:{prompt:'script input'}}}],edges:[]},c=setup({graph,route:path=>path==='/api/v2/canvas-runs'?json({id:'t',projectId:'p',state:'SUCCEEDED',revision:2,plans:[],testMode:true}):undefined});
 try{await run(c);expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot')).toBe(false);const create=c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!;expect(JSON.parse(create[1].body)).not.toHaveProperty('expectedRevision');}finally{c.adapter.clear();}
});

it('keeps the special hidden native parser on its original-command legacy path after editor repair',async()=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{modelCode:cap.capabilityRef,subType:'multimodal-text',hidePromptInput:true,params:{prompt:'original <role>USER</role>'}}}],edges:[]},c=setup({graph,route:path=>path==='/api/v2/canvas-runs'?json({id:'t',projectId:'p',state:'SUCCEEDED',revision:2,plans:[],testMode:true}):undefined});
 c.saved.mockImplementation(async()=>{graph.nodes[0].data.params.prompt='editor normalized prompt';});
 try{await run(c);expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot')).toBe(false);const create=c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!,body=JSON.parse(create[1].body);expect(body).not.toHaveProperty('expectedRevision');expect(body.graph.nodes[0].data.params.prompt).toBe('original <role>USER</role>');}finally{c.adapter.clear();}
});


it.each(['style','camera','combined','role'])('normalizes the exact native %s image prompt into editable user text and separate conditions',async kind=>{
 const selected={...cap,capabilityRef:'mock-image',kind:'TEXT_TO_IMAGE'},raw=kind==='role'?'fox\n\n【角色设计开始】\nsmile\n【角色设计结束】':'fox';
 const presets=kind==='role'?[{key:'roleDesign:face:expression',promptCode:'studio-role-face-smile-v1'}]:kind==='style'||kind==='combined'?[{key:'filter',id:'kodak_portra',prompt:'warm film'}]:[];
 const camera=kind==='camera'||kind==='combined'?{chunk:'camera intent',presetId:'default',selection:{cameraId:'c'}}:undefined;
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode:selected.capabilityRef,subType:'text-image',params:{prompt:raw},presetSelections:presets,...(camera?{cameraControl:camera}:{})}}],edges:[]};
 const composed=[presets.some(row=>'prompt' in row)?'warm film':'','fox',camera?'camera intent':''].filter(Boolean).join('\n'),command=structuredClone(graph);
 Object.assign(command.nodes[0].data,{params:{prompt:composed,text:composed},prompt:composed,modelType:'OPENAPI',userPromptSnapshot:{paramName:'prompt',value:raw},nodeOutputHistory:[]});
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):undefined});
 try{await c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command});const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body),data=body.graph.nodes.find((node:any)=>node.id==='n').data;expect(data.params.prompt).toBe(raw);expect(data.params.text).toBe(raw);expect(data.prompt).toBe(raw);expect(data.presetSelections).toEqual(presets);expect(data.cameraControl).toEqual(camera);expect(graph.nodes[0].data.params.prompt).toBe(raw);}finally{c.adapter.clear();}
});

it.each(['forged','stale-preset','stale-camera'])('rejects %s image derived text before any generation submission',async kind=>{
 const selected={...cap,capabilityRef:'mock-image',kind:'TEXT_TO_IMAGE'},graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode:selected.capabilityRef,subType:'text-image',params:{prompt:'fox'},presetSelections:[{key:'filter',id:'kodak_portra',prompt:'warm film'}],cameraControl:{chunk:'camera intent'}}}],edges:[]},command=structuredClone(graph);
 Object.assign(command.nodes[0].data,{params:{prompt:'warm film\nfox\ncamera intent'},prompt:'warm film\nfox\ncamera intent',modelType:'OPENAPI',userPromptSnapshot:{paramName:'prompt',value:'fox'},nodeOutputHistory:[]});
 if(kind==='forged')command.nodes[0].data.params.prompt+='\nforged';if(kind==='stale-preset')command.nodes[0].data.presetSelections[0].prompt='changed';if(kind==='stale-camera')command.nodes[0].data.cameraControl.chunk='changed';
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):undefined});
 try{await expect(c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command})).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it.each(['image-multiangle','image-light','image-redraw','image-erase','image-expand','portrait'])('completes the frozen %s single-node envelope from captured source edges without weakening input checks',async tool=>{
 const selected={...cap,capabilityRef:'codex-image-edit-v1',kind:'IMAGE_TO_IMAGE',version:'3',parameterSchemaVersion:'3',testMode:false,model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},inputKinds:['TEXT','IMAGE'],outputKinds:['IMAGE'],parameterSchema:{properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}},data:any={modelCode:selected.capabilityRef,toolsType:tool==='portrait'?'image-image':tool,toolsSourceUrl:'rhtv-asset:guide',params:{imageUrls:['rhtv-asset:guide']},generateNum:1,...(tool==='portrait'?{isPortraitAdjustResult:true,presetSelections:[{key:'age',promptCode:'studio-portrait-930-v1'}]}:{})},graph:NativeGraph={nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:['rhtv-asset:owned']}},{id:'n',type:'rh-image',position:{x:400,y:0},data}],edges:[{id:'input',source:'source',target:'n'}]},command={nodes:[structuredClone(graph.nodes[1])],edges:[]};
 // Native W8 inserts these defaults for promptless image tools as well.
 command.nodes[0].data.presetSelections??=[];command.nodes[0].data.nodeOutputHistory=[];
 if(tool==='portrait')command.nodes[0].data.promptCodes=['studio-portrait-930-v1'];
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}):undefined});
 try{await c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command});const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body);expect(body.graph.edges).toEqual(graph.edges);expect(body.graph.nodes.find((node:any)=>node.id==='source').data.sourceObjects).toEqual(['rhtv-asset:owned']);expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it('rejects a later source change while completing a native image tool command',async()=>{
 let finish!:(response:Response)=>void;const selected={...cap,capabilityRef:'edit',kind:'IMAGE_TO_IMAGE',inputKinds:['TEXT','IMAGE']},graph:NativeGraph={nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:['rhtv-asset:owned']}},{id:'n',type:'rh-image',position:{x:400,y:0},data:{modelCode:'edit',toolsType:'image-light',toolsSourceUrl:'rhtv-asset:owned',params:{imageUrls:['rhtv-asset:owned']}}}],edges:[{source:'source',target:'n'}]},c=setup({graph,route:path=>path.includes('model-capabilities')?new Promise(resolve=>finish=resolve):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}):undefined});
 try{const pending=c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[structuredClone(graph.nodes[1])],edges:[]}}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));graph.nodes[0].data.sourceObjects=['rhtv-asset:changed'];finish(json({items:[selected],nextCursor:null}));await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it.each(['panorama','cutout','remove-text','quick-scene'])('submits the native %s command after restoring its captured full ancestry',async tool=>{
 const selected={...cap,capabilityRef:'codex-image-edit-v1',kind:'IMAGE_TO_IMAGE',version:'3',parameterSchemaVersion:'3',testMode:false,inputKinds:['TEXT','IMAGE'],outputKinds:['IMAGE'],parameterSchema:{properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}},data:any={modelCode:selected.capabilityRef,toolsType:tool==='cutout'?'image-cutout':tool==='remove-text'?'image-cutout-text':'image-image',toolsSourceUrl:'rhtv-asset:owned',params:{imageUrls:['rhtv-asset:owned'],prompt:''},generateNum:1,...(tool==='panorama'?{panorama:{isPanoramaNode:true},sceneCode:'canvas-image-panorama-image'}:tool==='quick-scene'?{sceneCode:'canvas-image-quick-create-character-tri-view'}:{})},graph:NativeGraph={nodes:[{id:'ancestor',type:'rh-text',position:{x:0,y:0},data:{text:'original ancestor'}},{id:'source',type:'rh-image',position:{x:100,y:0},data:{sourceObjects:['rhtv-asset:owned']}},{id:'n',type:'rh-image',position:{x:400,y:0},data}],edges:[{id:'prior',source:'ancestor',target:'source',sourceHandle:'output',targetHandle:'input'},{id:'input',source:'source',target:'n',sourceHandle:'output',targetHandle:'input'}]},command=tool==='panorama'?{nodes:[structuredClone(graph.nodes[2])],edges:[]}:{nodes:[structuredClone(graph.nodes[2]),structuredClone(graph.nodes[1])],edges:[{source:'source',target:'n'}]},c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}):undefined});
 try{await c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command});const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body);expect(body.graph.edges).toEqual(graph.edges);expect(body.graph.nodes.find((node:any)=>node.id==='ancestor').data.text).toBe('original ancestor');expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it.each(['source-data','source-edge','conditioned-edge'])('rejects submitted %s tampering when restoring a native uEt ancestry',async change=>{
 const selected={...cap,capabilityRef:'edit',kind:'IMAGE_TO_IMAGE',inputKinds:['TEXT','IMAGE']},graph:NativeGraph={nodes:[{id:'ancestor',type:'rh-text',position:{x:0,y:0},data:{text:'original ancestor'}},{id:'source',type:'rh-image',position:{x:100,y:0},data:{sourceObjects:['rhtv-asset:owned']}},{id:'n',type:'rh-image',position:{x:400,y:0},data:{modelCode:'edit',toolsType:'image-cutout-text',toolsSourceUrl:'rhtv-asset:owned',params:{imageUrls:['rhtv-asset:owned']}}}],edges:[{id:'prior',source:'ancestor',target:'source',sourceHandle:'output',targetHandle:'input'},{id:'input',source:'source',target:'n',sourceHandle:'output',targetHandle:'input'}]},command:any={nodes:[structuredClone(graph.nodes[2]),structuredClone(graph.nodes[1])],edges:[{source:'source',target:'n'}]};
 if(change==='source-data')command.nodes[1].data.sourceObjects=['rhtv-asset:forged'];if(change==='source-edge')command.edges[0].source='ancestor';if(change==='conditioned-edge')command.edges[0].conditioningRole='STYLE';
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}):undefined});
 try{await expect(c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command})).rejects.toMatchObject({code:change==='source-edge'?'GRAPH_INPUT_INVALID':'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it.each(['face','pose'])('flushes queued %s nodes and input edges before capturing the guarded execution baseline',async kind=>{
 const source={id:'source',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:['rhtv-asset:owned']}},guide={id:'pose',type:'rh-image',position:{x:400,y:0},data:{sourceObjects:['rhtv-asset:guide'],isPoseControlReference:true}};
 const node={id:'n',type:'rh-image',position:{x:800,y:0},data:{modelCode:'codex-image-edit-v1',toolsType:'image-image',toolsSourceUrl:'rhtv-asset:owned',isPortraitAdjustResult:true,params:{prompt:'adjust',imageUrls:kind==='pose'?['rhtv-asset:owned','rhtv-asset:guide']:['rhtv-asset:owned']},presetSelections:[{key:'protection',promptCode:'protect-style'}]}};
 const graph:NativeGraph={nodes:[source],edges:[]},command={nodes:[structuredClone(node)],edges:[]},c=setup({graph,route:imageEditRoute});
 c.flush.mockImplementationOnce(()=>{if(kind==='pose'){graph.nodes.push(guide);graph.edges.push({id:'guide-input',source:'pose',target:'n'});}graph.nodes.push(node);graph.edges.push({id:'source-input',source:'source',target:'n'});});
 try{await c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command});const body=JSON.parse(c.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body);expect(body.graph.edges).toEqual(graph.edges);expect(body.graph.nodes.map((n:any)=>n.id)).toContain('source');expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});
it('does not resurrect a submitted node absent after flushing its deletion',async()=>{
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode:'codex-image-edit-v1',isPortraitAdjustResult:true,toolsType:'image-image',toolsSourceUrl:'rhtv-asset:owned',params:{prompt:'adjust',imageUrls:['rhtv-asset:owned']}}}],edges:[]};const c=setup({graph,route:imageEditRoute}),command=structuredClone(c.graph);c.flush.mockImplementationOnce(()=>{c.graph.nodes.length=0;});
 try{await expect(c.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:command})).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});

it.each(['empty','omitted-cache','removed-selection','changed-prompt'])('guards H3 regeneration with a cleared preset: %s',async change=>{
 const h3={...cap,capabilityRef:'h3-first-frame-v1',kind:'IMAGE_TO_VIDEO',testMode:false,model:{providerRef:'minimax',modelRef:'h3',title:'H3',version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['VIDEO'],parameterSchema:{properties:{outputPreset:{type:'string',enum:['480p-landscape-5s'],default:'480p-landscape-5s'}}}};
 const graph:NativeGraph={nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{imageUrl:'rhtv-asset:image'}},{id:'n',type:'rh-video',position:{x:450,y:0},data:{modelCode:h3.capabilityRef,subType:'image-video',params:{prompt:'original motion',imageUrls:[],outputPreset:'480p-landscape-5s'},presetSelections:null,nodeOutputHistory:[],videoUrl:'rhtv-asset:old',output:[{url:'rhtv-asset:old'}],historyStorage:{source:'remote',schemaVersion:1,historyId:'old-execution',revision:'1',resultCount:1}}}],edges:[{id:'edge',source:'source',target:'n',sourceHandle:'output',targetHandle:'input'}]};
 if(change==='removed-selection')graph.nodes[1].data.presetSelections=[{id:'selected'}];
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[h3],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:path.endsWith('/image')?'image/png':'video/mp4',id:path.split('/').at(-1),state:'READY',kind:path.endsWith('/image')?'IMAGE':'VIDEO'}):undefined});
 const command=structuredClone(graph);if(change==='omitted-cache')delete command.nodes[1].data.nodeOutputHistory;command.nodes[1].data.presetSelections=[];command.nodes[1].data.params.imageUrls=['rhtv-asset:image'];if(change==='changed-prompt')command.nodes[1].data.params.prompt='new prompt';
 try{const result=c.adapter.run({projectId:'p',targetId:'n',targetType:'NODE',graph:command});if(!['empty','omitted-cache'].includes(change)){await expect(result).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([p])=>p==='/api/v2/canvas-runs')).toBe(false);return;}await result;const sent=JSON.parse(c.transport.mock.calls.find(([p])=>p==='/api/v2/canvas-runs')![1].body),node=sent.graph.nodes.find((n:any)=>n.id==='n');expect(node.data.params.prompt).toBe('original motion');expect(node.data.params.imageUrls).toEqual(['rhtv-asset:image']);expect(node.data.videoUrl).toBe('rhtv-asset:old');expect(node.data.historyStorage.historyId).toBe('old-execution');expect(sent.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it.each(['valid','history','output','prompt','selection','nonempty-cache','batch-origin'])('guards regenerated image remote history projection: %s',async change=>{
 const image={...cap,capabilityRef:'codex-image-generate-v1',kind:'TEXT_TO_IMAGE',testMode:false,model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1],default:1}}}};
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode:image.capabilityRef,subType:'text-image',params:{prompt:'original composition'},nodeOutputHistory:[],selectedOutputHistoryIndex:0,sourceObjects:['rhtv-asset:old'],output:[{url:'rhtv-asset:old'}],historyStorage:{source:'remote',schemaVersion:1,historyId:'old-execution',revision:'5',resultCount:1,imageBatchOrigin:{executionId:'old-execution',index:0,count:1}}}}],edges:[]};
 graph.nodes[0].data.nodeOutputHistory=[{id:'saved-cache'}];
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[image],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),state:'READY',kind:'IMAGE'}):undefined});
 const command=structuredClone(graph),d=command.nodes[0].data;delete d.nodeOutputHistory;delete d.selectedOutputHistoryIndex;delete d.historyStorage.imageBatchOrigin;
 if(change==='history')d.historyStorage.historyId='different';if(change==='output')d.output=[{url:'rhtv-asset:changed'}];if(change==='prompt')d.params.prompt='different';if(change==='selection')d.selectedOutputHistoryIndex=1;if(change==='nonempty-cache')d.nodeOutputHistory=[{id:'forged-cache'}];if(change==='batch-origin')d.historyStorage.imageBatchOrigin={executionId:'forged'};
 try{const result=c.adapter.run({projectId:'p',targetId:'n',targetType:'NODE',graph:command});if(change!=='valid'){await expect(result).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([p])=>p==='/api/v2/canvas-runs')).toBe(false);return;}await result;const sent=JSON.parse(c.transport.mock.calls.find(([p])=>p==='/api/v2/canvas-runs')![1].body);expect(sent.graph.nodes[0].data).toMatchObject({nodeOutputHistory:[{id:'saved-cache'}],selectedOutputHistoryIndex:0,historyStorage:graph.nodes[0].data.historyStorage,params:{prompt:'original composition'}});expect(sent.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it.each(['valid','changed-default','changed-guide','missing-edge'])('reopens a completed redraw composer without changing actual input authority: %s',async change=>{
 const selected={...imageEditV3,parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}};
 const graph:NativeGraph={nodes:[{id:'ancestor',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:['rhtv-asset:ancestor']}},{id:'source',type:'rh-image',position:{x:400,y:0},data:{sourceObjects:['rhtv-asset:original']}},{id:'n',type:'rh-image',position:{x:800,y:0},data:{modelCode:selected.capabilityRef,capabilityVersion:'3',subType:'image-redraw',toolsType:'image-redraw',toolsSourceUrl:'rhtv-asset:guide',sourceNodeId:'source',params:{prompt:'redraw this region',imageUrls:['rhtv-asset:guide']},routerParameters:{count:1,transparentBackground:false},sourceObjects:['rhtv-asset:old'],output:[{url:'rhtv-asset:old'}],nodeOutputHistory:[],selectedOutputHistoryIndex:0,historyStorage:{source:'remote',schemaVersion:1,historyId:'old-execution',revision:'5',resultCount:1,imageBatchOrigin:{executionId:'old-execution',index:0,count:1}}}}],edges:[{id:'a',source:'ancestor',target:'source',sourceHandle:'output',targetHandle:'input'},{id:'b',source:'source',target:'n',sourceHandle:'output',targetHandle:'input'}]};
 const command={nodes:[structuredClone(graph.nodes[2]),structuredClone(graph.nodes[1])],edges:[{source:'source',target:'n'}]},d=command.nodes[0].data;
 delete d.nodeOutputHistory;delete d.selectedOutputHistoryIndex;delete d.historyStorage.imageBatchOrigin;d.params.transparentBackground=false;d.params.imageUrls=['rhtv-asset:original'];
 if(change==='changed-default')d.params.transparentBackground=true;if(change==='changed-guide')d.toolsSourceUrl='rhtv-asset:other';if(change==='missing-edge')command.edges=[];
 const c=setup({graph,route:path=>path.includes('model-capabilities')?json({items:[selected],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),state:'READY',kind:'IMAGE'}):undefined});
 try{const result=c.adapter.run({projectId:'p',targetId:'n',targetType:'NODE',graph:command});if(change!=='valid'){await expect(result).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([p])=>p==='/api/v2/canvas-runs')).toBe(false);return;}await result;const sent=JSON.parse(c.transport.mock.calls.find(([p])=>p==='/api/v2/canvas-runs')![1].body),target=sent.graph.nodes.find((n:any)=>n.id==='n');expect(sent.graph.edges).toEqual(graph.edges);expect(target.data.toolsSourceUrl).toBe('rhtv-asset:guide');expect(target.data.params.imageUrls).toEqual(['rhtv-asset:original']);expect(target.data.params.prompt).toBe('redraw this region');expect(target.data.historyStorage.historyId).toBe('old-execution');expect(sent.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});

it('retains the original target batch provenance through the save receipt before regeneration',async()=>{
 const image={...imageEditV3,capabilityRef:'codex-image-generate-v1',kind:'TEXT_TO_IMAGE',inputKinds:['TEXT','STRUCTURED']};
 const graph:NativeGraph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode:image.capabilityRef,subType:'text-image',params:{prompt:'original composition'},sourceObjects:['rhtv-asset:old'],output:[{url:'rhtv-asset:old'}],historyStorage:{source:'remote',historyId:'old-execution',revision:'5',resultCount:1}}}],edges:[]};
 const c=setup({graph,route:(path,init)=>path==='/api/v1/projects/p/snapshot'?json({projectId:'p',revision:3,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-10T00:00:00Z'}):path.includes('model-capabilities')?json({items:[image],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),state:'READY',kind:'IMAGE'}):undefined}),persisted=structuredClone(graph);
 Object.assign(persisted.nodes[0].data,{assetIds:['old'],batchOrigin:{executionId:'old-execution',sourceNodeId:'n',count:1,index:0}});
 c.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:2,graph:encodeGraph(persisted),updatedAt:'2026-10-06T09:00:00Z'},'"2"');c.storage.attachNativeView('p',graph);
 try{await c.adapter.run({projectId:'p',targetId:'n',targetType:'NODE',graph:structuredClone(graph)});const sent=JSON.parse(c.transport.mock.calls.find(([p])=>p==='/api/v2/canvas-runs')![1].body);expect(sent.graph.nodes[0].data).toMatchObject({assetIds:['old'],batchOrigin:persisted.nodes[0].data.batchOrigin,params:{prompt:'original composition'}});expect(sent.expectedRevision).toBe(3);}finally{c.adapter.clear();}
});

it.each(['unrelated-update','later-local-edit','remote-input-edit'])('reconciles an execution save CAS race without rejecting safe unrelated changes: %s',async change=>{
 let puts=0,gets=0;const remote:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{params:{prompt:'original input'}}},{id:'other',type:'rh-text',position:{x:800,y:0},data:{text:'Another collaborator added this'}}],edges:[]};
 const c=setup({route:(path,init,control)=>{
  if(path!=='/api/v1/projects/p/snapshot')return;
  if(init.method==='PUT'){
   puts++;if(puts===1)return new Response(JSON.stringify({code:'REVISION_CONFLICT',message:'Newer canvas'}),{status:412});
   return json({projectId:'p',revision:3,graph:JSON.parse(init.body).graph,updatedAt:'2026-11-03T10:00:00Z'});
  }
  gets++;if(change==='later-local-edit')control.graph.nodes[0].data.params.prompt='Local input edited while catching up';
  if(change==='remote-input-edit')remote.nodes[0].data.params.prompt='Remote input edited';
  return json({projectId:'p',revision:2,graph:encodeGraph(remote),updatedAt:'2026-11-03T09:59:00Z'});
 }});
 try{
  if(change==='unrelated-update'){
   await run(c);expect(puts).toBe(2);expect(gets).toBe(1);expect(c.storage.isBlocked('p')).toBe(false);
   const submits=c.transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs');expect(submits).toHaveLength(1);expect(JSON.parse(submits[0][1].body).expectedRevision).toBe(3);
   const saved=c.storage.snapshots.get('p')!.graph;expect(saved.nodes.find((node:any)=>node.id==='other')?.data.text).toBe('Another collaborator added this');
  }else{
   await expect(run(c)).rejects.toMatchObject({code:change==='later-local-edit'?'STALE_EXECUTION_INPUT':'LOCAL_DRAFT_CONFLICT'});expect(puts).toBe(1);expect(gets).toBe(1);expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
   expect(c.graph.nodes[0].data.params.prompt).toBe(change==='later-local-edit'?'Local input edited while catching up':'original input');
  }
 }finally{c.adapter.clear();}
});


it.each([
 ['face','emotion','studio-portrait-881-v1'],
 ['appearance','age','studio-portrait-930-v1'],
 ['makeup','makeup','studio-portrait-977-v1'],
])('submits the frozen %s single-node request after the panel has mounted its ports',async (panel,presetKey,presetId)=>{
 const {graph,command,owner}=await frozenPortraitRequest(panel,presetKey,presetId);
 const control=setup({graph,route:path=>{
  if(path.includes('model-capabilities'))return json({items:[auditedCatalog.find(cap=>cap.capabilityRef==='codex-image-edit-v1')],nextCursor:null});
  if(path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/t'){
   const ack=task();ack.plans[0].nodeId=owner.id;return json(ack);
  }
  return imageEditRoute(path);
 }});
 try{
  const request={projectId:'p',targetType:'NODE',targetId:owner.id,graph:command};
  expect(request.graph.nodes).toHaveLength(1);expect(request.graph.edges).toEqual([]);
  const mounted=graph.nodes[1].data;
  mounted.maxConnect={image:2,text:null,video:null};
  await expect(control.adapter.run(request)).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});
  expect(control.transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs')).toHaveLength(0);
  mounted.maxConnect={image:null,text:null,video:null};await control.adapter.run(request);
  const submitted=control.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1];
  const post=JSON.parse(submitted.body);exportNodeAction(submitted,{expectedAssetIds:['owned'],expectedPortraitRecipeId:presetId});
  expect(post.graph.edges).toEqual(graph.edges);
  const posted=post.graph.nodes.find((node:any)=>node.id===owner.id);
  expect(posted.data.maxConnect).toEqual(mounted.maxConnect);
  expect(posted.data.params.imageUrls).toEqual(['rhtv-asset:owned']);
 }finally{control.adapter.clear();}
});
