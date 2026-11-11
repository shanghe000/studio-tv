import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
import type {Capability} from '../../apps/web/src/service/model-catalog';

const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=compiled.indexOf('const u1n='),end=compiled.indexOf('function WXr(',start);
if(start<0||end<0)throw new Error('Native graph normalization seam changed');
const normalize=new Function(compiled.slice(start,end)+';return oL;')() as (graph:NativeGraph)=>NativeGraph;
const cap=(version='2',ref='codex-6-1-text-v1'):Capability=>({capabilityRef:ref,version,kind:'LLM',available:true,testMode:false,executionKind:'AGENT',parameterSchemaVersion:version,parameterSchema:{type:'object',properties:version==='2'?{reasoningEffort:{type:'string',enum:['low','high'],default:'low'}}:{},additionalProperties:false},inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'codex',modelRef:'model-6.1',title:'Codex 6.1',version:'6.1'}});
const graph=(version?:string,ref='codex-6-1-text-v1',taskId?:string):NativeGraph=>({nodes:[{id:'n',type:'rh-text',position:{x:30,y:40},data:{modelCode:ref,...(version?{capabilityRef:ref,capabilityVersion:version,parameterSchemaVersion:version}:{}),subType:'text-text',params:{prompt:'Original <role>USER</role>',reasoning_effort:'high'},...(taskId?{taskId}:{}),status:'idle'}}],edges:[],meta:{name:'Owned fixture'}});
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{ETag:'"'+(data?.revision||1)+'"'}});
function fixture(initial:NativeGraph,receipt?:any){
 let snapshot:any=encodeGraph(initial),revision=1;const calls:any[]=[];
 const transport=vi.fn(async(path:string,options:any)=>{
  if(path==='/api/v1/projects/p')return json({id:'p',name:'Owned fixture',ownerId:'owner',revision});
  if(path==='/api/v1/projects/p/snapshot'){
   if(options.method==='PUT'){snapshot=JSON.parse(options.body).graph;revision++;calls.push(snapshot);}
   return json({projectId:'p',revision,graph:snapshot,updatedAt:'2026-10-06T00:00:00Z'});
  }
  if(path.startsWith('/api/v2/tasks/')){if(receipt instanceof Response)return receipt;return json(receipt??{id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:'codex-6-1-text-v1',capabilityVersion:'1'}]});}
  if(path.startsWith('/api/v2/model-capability-version?')){const query=new URL(path,'https://fixture.invalid').searchParams;return json(cap(query.get('version')!,query.get('ref')!));}
  if(path.includes('/model-capabilities?'))return json({items:[cap(),cap('2','codex-6-text-v1')],nextCursor:null});
  if(path==='/api/v2/canvas-runs'){const bound=JSON.parse(options.body).expectedRevision!==undefined;return json({id:'new-task',projectId:'p',state:'SUCCEEDED',plans:bound?[{nodeId:'n',executionId:'new-execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[{id:'fixture-output',type:'TEXT',text:'isolated model selection fixture'}]}]:[],testMode:false,...(bound?{canvasManaged:true}:{})},202);}
  throw new Error('Unexpected fixture request '+path);
 });const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,vi.fn().mockResolvedValue(undefined),vi.fn());
 return{storage,execution,transport,calls,snapshot:()=>snapshot,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data};
}

it('reproduces frozen hydration loss and preserves saved @1 through native save, reload, original menu and exact execution',async()=>{
 const original=graph('1'),f=fixture(original);await f.storage.loadProject('p');
 const mounted=normalize(f.storage.fixture('p'));expect(mounted.nodes[0].data).not.toHaveProperty('capabilityVersion');expect(mounted.nodes[0].data.params).toEqual(original.nodes[0].data.params);
 mounted.nodes[0].data.params.prompt='Edited original USER prompt';await f.storage.save('p',mounted);
 expect(f.snapshot().nodes[0].data).toMatchObject({capabilityRef:cap().capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'Edited original USER prompt'}});
 f.storage.clear();await f.storage.loadProject('p');const reloaded=normalize(f.storage.fixture('p')),props={targetNode:reloaded.nodes[0],nodes:reloaded.nodes,edges:reloaded.edges,models:{'text-text':[capabilityModel(cap())]},onNodeDataPatch:vi.fn()},view=nativeModelProps(props,f.storage.modelBindingPort('p',()=>true));
 expect(view.targetNode.data.capabilityVersion).toBe('1');expect(view.models['text-text'][0].config.some((field:any)=>field.paramName==='reasoning_effort')).toBe(false);
 view.onNodeDataPatch('n',{modelCode:cap().capabilityRef,params:{prompt:'Same model edit'}});expect(props.onNodeDataPatch).toHaveBeenCalledWith('n',{modelCode:cap().capabilityRef,params:{prompt:'Same model edit'}});
 await f.execution.run({projectId:'p',targetType:'NODE',targetId:'n',graph:reloaded});expect(f.submitted()).toMatchObject({capabilityVersion:'1',parameterSchemaVersion:'1',routerParameters:{},params:{prompt:'Edited original USER prompt',reasoning_effort:'high'}});
 expect(reloaded.nodes[0].data).not.toHaveProperty('capabilityVersion');expect(original.nodes[0].data.params.prompt).toBe('Original <role>USER</role>');
});

it('records only a deliberate compatible model change before native discards its extension fields and preserves High @2',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');let mounted=normalize(f.storage.fixture('p'));const other=cap('2','codex-6-text-v1'),originalPatch=vi.fn((id:string,value:any)=>{mounted=normalize({...mounted,nodes:mounted.nodes.map(node=>node.id===id?{...node,data:{...node.data,...value}}:node)});});
 const view=nativeModelProps({targetNode:mounted.nodes[0],nodes:mounted.nodes,edges:mounted.edges,models:{'text-text':[capabilityModel(cap()),capabilityModel(other)]},onNodeDataPatch:originalPatch},f.storage.modelBindingPort('p',()=>true));
 view.onNodeDataPatch('n',{modelCode:other.capabilityRef,params:{prompt:'New original',reasoning_effort:'high'}});expect(mounted.nodes[0].data).not.toHaveProperty('capabilityVersion');
 await f.storage.save('p',mounted);await f.execution.run({projectId:'p',targetType:'NODE',targetId:'n',graph:mounted});expect(f.submitted()).toMatchObject({capabilityRef:other.capabilityRef,capabilityVersion:'2',parameterSchemaVersion:'2',routerParameters:{reasoningEffort:'high'}});expect(f.snapshot().nodes[0].data.capabilityVersion).toBe('2');
});

it('keeps project, node type and current selected ref isolated without inferring versions from a v1 suffix',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');const mounted=normalize(graph()),restored=f.storage.restoreModelBindings('p',mounted);expect(restored.nodes[0].data.capabilityVersion).toBe('1');
 expect(f.storage.restoreModelBindings('other-project',mounted)).toBe(mounted);expect(f.storage.restoreModelBindings('p',{...mounted,nodes:[{...mounted.nodes[0],type:'rh-image'}]}).nodes[0].data).not.toHaveProperty('capabilityVersion');
 const changed=normalize(graph(undefined,'codex-6-text-v1'));expect(f.storage.restoreModelBindings('p',changed)).toBe(changed);await f.execution.run({projectId:'q',targetType:'NODE',targetId:'n',graph:mounted});expect(f.submitted().capabilityVersion).toBe('2');
});

it('restores version metadata in freezeGraph and never mutates the native graph',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p')),before=structuredClone(mounted);expect((await f.execution.freezeGraph(mounted,'p')).nodes[0].data.capabilityVersion).toBe('1');expect(mounted).toEqual(before);
});

it('invalidates cached render views when native mutates the same node/data and keeps nested live params intact',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p')),port=f.storage.modelBindingPort('p',()=>true),first=port.node(mounted.nodes[0]);expect(port.node(mounted.nodes[0])).toBe(first);
 mounted.nodes[0].data.taskId='new-receipt';mounted.nodes[0].data.params={prompt:'Edited by native',reasoning_effort:'high'};const next=port.node(mounted.nodes[0]);expect(next).not.toBe(first);expect(next.data).toMatchObject({taskId:'new-receipt',params:{prompt:'Edited by native'},capabilityVersion:'1'});mounted.nodes[0].data.params.prompt='Nested live edit';expect(port.node(mounted.nodes[0]).data.params.prompt).toBe('Nested live edit');
});

it('forgets deleted nodes before a same-id node can be recreated with a new unversioned selection',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');f.storage.reconcileModelBindings('p',{nodes:[],edges:[]});const recreated=normalize(graph());expect(f.storage.restoreModelBindings('p',recreated)).toBe(recreated);await f.execution.run({projectId:'p',targetType:'NODE',targetId:'n',graph:recreated});expect(f.submitted().capabilityVersion).toBe('2');
});

it('does not resurrect a deleted binding when an older queued save executes after deletion',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');const queued=f.storage.queueSave('p',normalize(f.storage.fixture('p')));f.storage.reconcileModelBindings('p',{nodes:[],edges:[]});await queued;const recreated=normalize(graph());expect(f.storage.restoreModelBindings('p',recreated)).toBe(recreated);
});

it('records a successful latest selection for later native saves without writing unknown fields into the manager',async()=>{
 const f=fixture(graph());await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p'));f.execution.attach('p',{getRemoteData:()=>mounted,patchNodeData:vi.fn()});await f.execution.run({projectId:'p',targetType:'NODE',targetId:'n',graph:mounted});await f.storage.save('p',mounted);expect(f.snapshot().nodes[0].data).toMatchObject({capabilityVersion:'2',parameterSchemaVersion:'2'});expect(mounted.nodes[0].data).not.toHaveProperty('capabilityVersion');
});

it('captures a queued save version before a later model change and does not let its completion roll back the active binding',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p')),saving=f.storage.queueSave('p',mounted),port=f.storage.modelBindingPort('p',()=>true),other=cap('2','codex-6-text-v1');
 port.record(mounted.nodes[0],{modelCode:other.capabilityRef,capabilityRef:other.capabilityRef,capabilityVersion:'2',parameterSchemaVersion:'2'});await saving;expect(f.snapshot().nodes[0].data.capabilityVersion).toBe('1');
 const changed=normalize(graph(undefined,other.capabilityRef));expect(f.storage.restoreModelBindings('p',changed).nodes[0].data.capabilityVersion).toBe('2');await f.storage.save('p',changed);expect(f.snapshot().nodes[0].data.capabilityVersion).toBe('2');
});

it('clears binding and stale native callbacks on logout or project change',async()=>{
 const f=fixture(graph('1'));await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p')),patch=vi.fn();let current=true;const port=f.storage.modelBindingPort('p',()=>current),view=nativeModelProps({targetNode:mounted.nodes[0],nodes:mounted.nodes,edges:[],models:{'text-text':[capabilityModel(cap('2','codex-6-text-v1'))]},onNodeDataPatch:patch},port);
 current=false;view.onNodeDataPatch('n',{modelCode:'codex-6-text-v1'});expect(patch).not.toHaveBeenCalled();current=true;f.storage.clear();view.onNodeDataPatch('n',{modelCode:'codex-6-text-v1'});expect(patch).not.toHaveBeenCalled();expect(f.storage.restoreModelBindings('p',mounted)).toBe(mounted);
});

it.each(['1','2'])('recovers already dropped metadata only from the actor-visible same node/ref task plan @%s',async version=>{
 const f=fixture(graph(undefined,cap().capabilityRef,'task'),{id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:cap().capabilityRef,capabilityVersion:version,parameters:version==='1'?{}:{reasoningEffort:'high'}}]});await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p'));
 await f.storage.save('p',mounted);await f.execution.run({projectId:'p',targetType:'NODE',targetId:'n',graph:mounted});expect(f.submitted()).toMatchObject({capabilityVersion:version,parameterSchemaVersion:version,routerParameters:version==='1'?{}:{reasoningEffort:'high'}});expect(f.snapshot().nodes[0].data.capabilityVersion).toBe(version);expect(f.transport.mock.calls.filter(call=>call[0].startsWith('/api/v2/tasks/'))).toHaveLength(1);
});

it.each([
 ['deleted task',new Response(JSON.stringify({code:'NOT_FOUND',message:'not visible'}),{status:404})],
 ['deleted history',{id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:cap().capabilityRef,capabilityVersion:'1',historyDeletedAt:'2026-10-06'}]}],
 ['different selected ref',{id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:'codex-6-text-v1',capabilityVersion:'1'}]}],
 ['different node',{id:'task',projectId:'p',plans:[{nodeId:'other-node',capabilityRef:cap().capabilityRef,capabilityVersion:'1'}]}],
])('does not resurrect or infer a historical binding for %s',async(_label,receipt)=>{
 const f=fixture(graph(undefined,cap().capabilityRef,'task'),receipt);await f.storage.loadProject('p');expect(f.storage.fixture('p').nodes[0].data).not.toHaveProperty('capabilityVersion');expect(f.transport.mock.calls.some(call=>call[0].includes('/model-capability-version?'))).toBe(false);
});

it.each([
 ['wrong task',{id:'other-task',projectId:'p',plans:[]}],['wrong project',{id:'task',projectId:'other-project',plans:[]}],['missing plans',{id:'task',projectId:'p'}],
 ['missing version',{id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:cap().capabilityRef}]}],
 ['duplicate node',{id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:cap().capabilityRef,capabilityVersion:'1'},{nodeId:'n',capabilityRef:cap().capabilityRef,capabilityVersion:'2'}]}],
])('fails closed on %s rather than silently selecting current2',async(_label,receipt)=>{
 const f=fixture(graph(undefined,cap().capabilityRef,'task'),receipt);await expect(f.storage.loadProject('p')).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(f.storage.projects.size).toBe(0);expect(f.storage.snapshots.size).toBe(0);
});

it.each(['task','exact'])('rejects late %s recovery after identity cleanup without restoring old bindings',async stage=>{
 let release!:(response:Response)=>void;const original=graph(undefined,cap().capabilityRef,'task'),transport=vi.fn(async(path:string)=>{
  if(path.endsWith('/snapshot'))return json({projectId:'p',revision:1,graph:encodeGraph(original)});
  if(path==='/api/v1/projects/p')return json({id:'p',ownerId:'owner'});
  if(path.startsWith('/api/v2/tasks/'))return stage==='task'?new Promise<Response>(done=>release=done):json({id:'task',projectId:'p',plans:[{nodeId:'n',capabilityRef:cap().capabilityRef,capabilityVersion:'1'}]});
  return new Promise<Response>(done=>release=done);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),pending=storage.loadProject('p'),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));storage.clear();release(stage==='task'?json({id:'task',projectId:'p',plans:[]}):json(cap('1')));await rejected;expect(storage.projects.size).toBe(0);expect(storage.restoreModelBindings('p',normalize(graph())).nodes[0].data).not.toHaveProperty('capabilityVersion');
});
