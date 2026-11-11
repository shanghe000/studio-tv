import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

// Client-only submission fixtures: no model, Router, worker or real assets.
const capability:any={capabilityRef:'qwen-image-edit-2511-v1',version:'1',parameterSchemaVersion:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,inputKinds:['TEXT','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'comfy',modelRef:'qwen-image-edit-2511',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1],default:1}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};
function fixture(options:{rich?:boolean;historyText?:string;declaredText?:boolean}={}){
 const graph:NativeGraph={nodes:[{id:'image',type:'rh-image',position:{x:0,y:0},data:{modelCode:capability.capabilityRef,subType:'image-image',prompt:'captured prompt',params:{prompt:'captured prompt',imageUrls:['rhtv-asset:reference']}}}],edges:[]};
 const selected=structuredClone(capability);if(options.declaredText)selected.parameterSchema.properties.text={type:'string'};
 if(options.historyText!==undefined)graph.nodes[0].data.params.text=options.historyText;
 if(options.rich){graph.nodes.push({id:'upstream',type:'rh-text',position:{x:-400,y:0},data:{text:'<p>authored upstream text</p>',content:'stale cached text'}});graph.edges.push({id:'text-input',source:'upstream',target:'image',sourceHandle:'output',targetHandle:'input'});}
 const command=structuredClone(graph),requests:{path:string;body:any}[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 command.nodes[0].data.userPromptSnapshot={paramName:'prompt',value:'captured prompt'};
 if(options.rich){command.nodes[0].data.params.prompt='captured prompt\nauthored upstream text';command.nodes[0].data.prompt='captured prompt\nauthored upstream text';}
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities'))return json({items:[selected],nextCursor:null});
  if(path==='/api/v1/assets/reference')return json({id:'reference',kind:'IMAGE',state:'READY'});
  if(path==='/api/v1/projects/p/snapshot')return json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-11-02T00:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'task',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:'image',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  if(path==='/api/v2/generation-diagnostics')return json({logId:'audit-diagnostic'});
  throw Error('Unexpected capture audit route '+path);
 });
 api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),saved=vi.fn(async()=>{}),execution=new ExecutionAdapter(api,storage,saved,vi.fn());
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-02T00:00:00Z'},'"1"');storage.attachNativeView('p',graph);execution.attach('p',manager);
 return{graph,command,manager,storage,saved,execution,requests,submit:()=>execution.run({projectId:'p',targetType:'NODE',targetId:'image',graph:command}),submitted:()=>requests.filter(request=>request.path==='/api/v2/canvas-runs'),issue:()=>requests.find(request=>request.path==='/api/v2/generation-diagnostics')?.body.preflight.issues[0]};
}
const prompt=(graph:NativeGraph,value:string)=>{graph.nodes[0].data.prompt=value;graph.nodes[0].data.params.prompt=value;};

it('captures the mounted baseline after the pending leased form intent has applied',async()=>{
 const f=fixture(),gate=deferred(),newPrompt='the same queued form intent';prompt(f.command,newPrompt);f.command.nodes[0].data.userPromptSnapshot.value=newPrompt;
 const flushPending=vi.fn(async()=>{await gate.promise;prompt(f.graph,newPrompt);});f.execution.setCanvasLeasePort({flushPending,acquire:vi.fn(async()=>{})});
 try{const pending=f.submit();await vi.waitFor(()=>expect(flushPending).toHaveBeenCalledOnce());expect(f.submitted()).toHaveLength(0);gate.resolve();await pending;expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe(newPrompt);expect(f.graph.nodes[0].data.params.prompt).toBe(newPrompt);}finally{f.execution.clear();}
});
it('generates the mounted node only after its accepted lease-buffered input has settled',async()=>{
 const f=fixture(),gate=deferred(),next='queued input before direct generation',flushPending=vi.fn(async()=>{await gate.promise;prompt(f.graph,next);});f.execution.setCanvasLeasePort({flushPending,acquire:vi.fn(async()=>{})});
 try{const pending=f.execution.generate('image');await vi.waitFor(()=>expect(flushPending).toHaveBeenCalledOnce());expect(f.submitted()).toHaveLength(0);gate.resolve();expect(await pending).toBe(true);expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe(next);expect(f.graph.nodes[0].data.params.prompt).toBe(next);expect(f.issue()).toBeUndefined();}finally{f.execution.clear();}
});
it('flushes native debounced changes before capturing the direct generate command',async()=>{
 const f=fixture();f.manager.flushOperationQueue.mockImplementation(()=>prompt(f.graph,'latest native field patch'));
 try{expect(await f.execution.generate('image')).toBe(true);expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe('latest native field patch');expect(f.issue()).toBeUndefined();}finally{f.execution.clear();}
});
it.each(['project','account','storage-session','deleted','rebuilt','revoked'] as const)('cancels a waiting direct generate when its %s changes',async change=>{
 const f=fixture(),gate=deferred(),flushPending=vi.fn(()=>gate.promise),rows=[{get:(key:string)=>key==='id'?'image':undefined}];Object.assign(f.manager,{ynodes:{toArray:()=>rows}});f.execution.setCanvasLeasePort({flushPending,acquire:vi.fn(async()=>{})});
 try{const pending=f.execution.generate('image');await vi.waitFor(()=>expect(flushPending).toHaveBeenCalledOnce());if(change==='project')f.execution.attach('other',{getRemoteData:()=>({nodes:[],edges:[]})});if(change==='account')f.execution.clear();if(change==='storage-session')f.storage.clear();if(change==='deleted'){f.graph.nodes=[];rows.splice(0);}if(change==='rebuilt'){f.graph.nodes[0]=structuredClone(f.graph.nodes[0]);rows[0]={get:(key:string)=>key==='id'?'image':undefined};}if(change==='revoked')vi.spyOn(f.storage,'requirePermission').mockImplementation(()=>{throw new ApiError(403,'READ_ONLY','编辑权限已撤销。');});gate.resolve();expect(await pending).toBe(false);expect(f.submitted()).toHaveLength(0);expect(f.manager.flushOperationQueue).not.toHaveBeenCalled();expect(f.manager.patchNodeData).not.toHaveBeenCalled();expect(f.requests.some(request=>request.path==='/api/v1/projects/p/snapshot')).toBe(false);}finally{f.execution.clear();}
});
it('checks generation permission before trying to flush an accepted pending edit',async()=>{
 const f=fixture(),flushPending=vi.fn(async()=>{});f.execution.setCanvasLeasePort({flushPending,acquire:vi.fn(async()=>{})});vi.spyOn(f.storage,'requirePermission').mockImplementation(()=>{throw new ApiError(403,'READ_ONLY','编辑权限已撤销。');});
 try{expect(await f.execution.generate('image')).toBe(false);expect(flushPending).not.toHaveBeenCalled();expect(f.submitted()).toHaveLength(0);expect(f.manager.flushOperationQueue).not.toHaveBeenCalled();}finally{f.execution.clear();}
});
it('still guards edits arriving after the direct generate command has been captured',async()=>{
 const f=fixture(),gate=deferred(),acquire=vi.fn(()=>gate.promise);f.execution.setCanvasLeasePort({flushPending:vi.fn(async()=>{}),acquire});
 try{const pending=f.execution.generate('image');await vi.waitFor(()=>expect(acquire).toHaveBeenCalledOnce());prompt(f.graph,'later input after command capture');gate.resolve();expect(await pending).toBe(false);expect(f.submitted()).toHaveLength(0);expect(f.graph.nodes[0].data.params.prompt).toBe('later input after command capture');expect(f.issue()).toMatchObject({field:'inputs.snapshot',component:'PROMPT'});}finally{f.execution.clear();}
});

it('never adopts a different prompt that arrives while the initial lease flush is pending',async()=>{
 const f=fixture(),gate=deferred(),flushPending=vi.fn(()=>gate.promise);f.execution.setCanvasLeasePort({flushPending,acquire:vi.fn(async()=>{})});
 try{const pending=f.submit(),refusal=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(flushPending).toHaveBeenCalledOnce());prompt(f.graph,'later author edit');gate.resolve();await refusal;expect(f.submitted()).toHaveLength(0);expect(f.issue()).toMatchObject({field:'inputs.command',reason:'COMMAND_MISMATCH',component:'PROMPT'});expect(f.graph.nodes[0].data.params.prompt).toBe('later author edit');}finally{f.execution.clear();}
});

it('guards a late prompt during target lease acquisition against the already captured input',async()=>{
 const f=fixture(),gate=deferred(),acquire=vi.fn(()=>gate.promise);f.execution.setCanvasLeasePort({flushPending:vi.fn(async()=>{}),acquire});
 try{const pending=f.submit(),refusal=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(acquire).toHaveBeenCalledOnce());prompt(f.graph,'later edit during acquire');gate.resolve();await refusal;expect(f.submitted()).toHaveLength(0);expect(f.issue()).toMatchObject({field:'inputs.snapshot',reason:'INPUT_CHANGED',component:'PROMPT'});expect(f.graph.nodes[0].data.params.prompt).toBe('later edit during acquire');}finally{f.execution.clear();}
});

it('does not silently replace an original command when save settlement mounts a merged prompt',async()=>{
 const f=fixture();f.saved.mockImplementation(async()=>{prompt(f.graph,'merged peer prompt');});
 try{await expect(f.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);expect(f.issue()).toMatchObject({field:'inputs.snapshot',reason:'INPUT_CHANGED',component:'PROMPT'});expect(f.graph.nodes[0].data.params.prompt).toBe('merged peer prompt');}finally{f.execution.clear();}
});

it('accepts an own saved prompt snapshot projection without treating it as a late authored edit',async()=>{
 const f=fixture();f.saved.mockImplementation(async()=>{f.graph.nodes[0].data.userPromptSnapshot=structuredClone(f.command.nodes[0].data.userPromptSnapshot);});
 try{await f.submit();expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe('captured prompt');}finally{f.execution.clear();}
});

it('does not let an old projection disposer clear a newer installed instance',async()=>{
 const f=fixture({rich:true}),old=vi.fn(()=> 'old frame text'),current=vi.fn(()=> 'authored upstream text');
 const disposeOld=f.execution.setNativeTextProjection(old),disposeCurrent=f.execution.setNativeTextProjection(current);disposeOld();
 try{await f.submit();expect(f.submitted()).toHaveLength(1);expect(old).not.toHaveBeenCalled();expect(current).toHaveBeenCalledWith('<p>authored upstream text</p>');expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe('captured prompt');}finally{disposeCurrent();f.execution.clear();}
});

it.each(['missing','disposed','throwing','non-string'] as const)('rejects rich text when the exact native projection is %s',async mode=>{
 const f=fixture({rich:true});
 if(mode==='disposed')f.execution.setNativeTextProjection(()=> 'authored upstream text')();
 if(mode==='throwing')f.execution.setNativeTextProjection(()=>{throw Error('detached native frame');});
 if(mode==='non-string')f.execution.setNativeTextProjection((()=>undefined) as any);
 try{await expect(f.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);expect(f.graph.nodes[1].data.text).toBe('<p>authored upstream text</p>');expect(f.issue()).toMatchObject({field:'inputs.command',component:'PROMPT'});}finally{f.execution.clear();}
});

it('retains a later upstream rich text edit during target lease acquisition',async()=>{
 const f=fixture({rich:true}),gate=deferred(),acquire=vi.fn(()=>gate.promise);f.execution.setNativeTextProjection(()=> 'authored upstream text');f.execution.setCanvasLeasePort({flushPending:vi.fn(async()=>{}),acquire});
 try{const pending=f.submit(),refusal=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(acquire).toHaveBeenCalledOnce());f.graph.nodes[1].data.text='<p>newer upstream edit</p>';gate.resolve();await refusal;expect(f.submitted()).toHaveLength(0);expect(f.graph.nodes[1].data.text).toBe('<p>newer upstream edit</p>');expect(f.issue()).toMatchObject({field:'inputs.snapshot',reason:'INPUT_CHANGED',component:'PROMPT',sourceNodeId:'upstream'});}finally{f.execution.clear();}
});

it('rejects a forged rich text projection despite having a valid native serializer',async()=>{
 const f=fixture({rich:true});f.execution.setNativeTextProjection(()=> 'authored upstream text');f.command.nodes[0].data.params.prompt+='\nforged command text';
 try{await expect(f.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);expect(f.graph.nodes[1].data.text).toBe('<p>authored upstream text</p>');}finally{f.execution.clear();}
});

it('omits only undeclared historical image text from the actual command',async()=>{
 const f=fixture({historyText:'old historical helper text'});delete f.command.nodes[0].data.params.text;
 try{await f.submit();expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params).not.toHaveProperty('text');expect(f.graph.nodes[0].data.params.text).toBe('old historical helper text');}finally{f.execution.clear();}
});

it.each(['explicit-forged','declared-omission','late-edit'] as const)('keeps historical text guarded for %s',async mode=>{
 const f=fixture({historyText:'old historical helper text',declaredText:mode==='declared-omission'});
 if(mode==='explicit-forged')f.command.nodes[0].data.params.text='forged new text';else delete f.command.nodes[0].data.params.text;
 if(mode==='late-edit')f.saved.mockImplementation(async()=>{f.graph.nodes[0].data.params.text='newer authored text';});
 try{await expect(f.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);if(mode==='late-edit')expect(f.graph.nodes[0].data.params.text).toBe('newer authored text');}finally{f.execution.clear();}
});
