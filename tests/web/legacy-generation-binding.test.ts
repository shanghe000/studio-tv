import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {preflightContext} from '../../apps/web/src/service/preflight';

const cap=(version:string)=>({capabilityRef:'image',version,parameterSchemaVersion:version,kind:'TEXT_TO_IMAGE',available:true,testMode:false,model:{providerRef:'fixture',modelRef:'image',title:'图像',version},inputKinds:['TEXT'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{},additionalProperties:false}});
const node=(id:string)=>({id,type:'rh-image',position:{x:0,y:0},data:{title:id,modelCode:'image',taskId:'task-'+id,subType:'text-image',params:{prompt:'Draw a bird'}}});
const reply=(data:any,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify({code:status<400?0:'NOT_FOUND',data}),{status,headers});
const task=(id:string)=>({id:'task-'+id,projectId:'p',plans:[{nodeId:id,capabilityRef:'image',capabilityVersion:'1'}]});
async function fixture(lookup?:(path:string)=>Promise<Response>|Response|undefined){
 const requests:{path:string;body:any}[]=[],graph={nodes:[node('ok'),node('broken')],edges:[]};
 const snapshot=(revision:number)=>({projectId:'p',revision,graph:encodeGraph(graph),updatedAt:'2026-11-04T08:00:00Z'});
 let revision=1;
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'author',revision,name:'画布'});
  if(path==='/api/v1/projects/p/snapshot'){
   const snap=snapshot(body?++revision:revision);if(body)snap.graph=body.graph;
   return reply(snap,200,{ETag:'"'+revision+'"','X-STUDIO-Canvas-Media':'a'.repeat(32)});
  }
  if(path==='/api/v2/canvas-runs'||path==='/api/v2/tasks/accepted')return reply({id:'accepted',projectId:'p',canvasManaged:true,state:'SUCCEEDED',plans:[{nodeId:'ok',executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}],revision:1,testMode:false});
  if(path==='/api/v2/generation-diagnostics')return reply({logId:'test'});
  const custom=lookup?.(path);if(custom)return custom;
  if(path.includes('/model-capabilities?'))return reply({items:[cap('2')],nextCursor:null});
  if(path==='/api/v2/tasks/task-ok')return reply(task('ok'));
  if(path==='/api/v2/tasks/task-broken')return new Response('<html>down</html>',{status:502});
  if(path.includes('/model-capability-version?'))return reply(cap('1'));
  throw new Error('unexpected '+path);
 });
 api.setAccessToken('local-test');const storage=new ServiceStorage(api,vi.fn()),ex=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 await storage.loadProject('p');const manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 storage.attachNativeView('p',graph);ex.attach('p',manager);
 return{ex,storage,graph,requests,snapshot};
}
it('opens without reading history, then verifies only the target and submits its old exact version',async()=>{
 const f=await fixture();try{
  expect(f.requests.some(r=>r.path.includes('/tasks/')||r.path.includes('/model-capability-version?'))).toBe(false);
  const bad=await f.ex.inspectGeneration('p',['broken']);expect(bad).toMatchObject({status:'blocked',issues:[{nodeId:'broken',modelRef:'image',field:'model.kind',code:'INVALID_RESPONSE',retryable:true}]});
  expect(f.requests.filter(r=>r.path.includes('/canvas-runs'))).toHaveLength(0);
  expect(await f.ex.inspectGeneration('p',['ok'])).toMatchObject({status:'ready'});
  await f.ex.run({projectId:'p',targetType:'NODE',targetId:'ok',graph:f.graph});
  expect(f.requests.find(r=>r.path==='/api/v2/canvas-runs')?.body.graph.nodes.find((n:any)=>n.id==='ok').data).toMatchObject({capabilityRef:'image',capabilityVersion:'1',parameterSchemaVersion:'1'});
  expect(f.requests.filter(r=>r.path.includes('task-broken'))).toHaveLength(1);
 }finally{f.ex.clear();}
});
it.each([429,503])('preserves temporary historical lookup status %s and retries without a model reselection',async status=>{
 let calls=0;const f=await fixture(path=>path.endsWith('/tasks/task-ok')&&++calls===1?new Response(JSON.stringify({code:'TEMPORARY_HISTORY_ERROR',message:'稍后重试'}),{status}):undefined);
 try{
  let error:any;try{await f.storage.historicalGenerationModel('p',f.graph.nodes[0]);}catch(value){error=value;}
  expect(error).toMatchObject({status,code:'TEMPORARY_HISTORY_ERROR'});
  expect(preflightContext(error)).toMatchObject({capabilityRef:'image',issues:[{field:'model.kind',reason:'METADATA_MISSING',sourceNodeId:'ok'}]});
  expect(await f.ex.inspectGeneration('p',['ok'])).toMatchObject({status:'ready'});
  expect(calls).toBe(2);expect(f.requests.some(r=>r.path.includes('/canvas-runs'))).toBe(false);
 }finally{f.ex.clear();}
});
it('releases a hung historical lookup even when transport ignores abort, then retries the same node',async()=>{
 vi.useFakeTimers();let calls=0;const f=await fixture(path=>path.endsWith('/tasks/task-ok')&&++calls===1?new Promise<Response>(()=>{}):undefined);
 try{
  const pending=f.storage.historicalGenerationModel('p',f.graph.nodes[0]);
  const rejected=expect(pending).rejects.toMatchObject({status:504,code:'CANVAS_REQUEST_TIMEOUT'});
  await vi.advanceTimersByTimeAsync(15001);await rejected;
  expect(await f.ex.inspectGeneration('p',['ok'])).toMatchObject({status:'ready'});expect(calls).toBe(2);
 }finally{f.ex.clear();vi.useRealTimers();}
});
it('cancels a hung historical lookup immediately when the identity changes',async()=>{
 vi.useFakeTimers();const f=await fixture(path=>path.endsWith('/tasks/task-ok')?new Promise<Response>(()=>{}):undefined);
 try{
  const pending=f.storage.historicalGenerationModel('p',f.graph.nodes[0]),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
  f.storage.clear();await rejected;expect(vi.getTimerCount()).toBe(0);
 }finally{f.ex.clear();vi.useRealTimers();}
});
it('requires an explicit new selection when the matching historical plan was deleted, missing or ambiguous',async()=>{
 for(const receipt of [reply({},404),reply({...task('ok'),plans:[]}),reply({...task('ok'),plans:[...task('ok').plans,...task('ok').plans]})]){
  const f=await fixture(path=>path.endsWith('/tasks/task-ok')?receipt.clone():undefined);
  try{
   await expect(f.ex.run({projectId:'p',targetType:'NODE',targetId:'ok',graph:f.graph})).rejects.toMatchObject({code:'MODEL_VERSION_UNVERIFIED'});
   f.storage.rememberModelBinding('p',f.graph.nodes[0],{capabilityRef:'image',capabilityVersion:'2',parameterSchemaVersion:'2'});
   expect(await f.ex.inspectGeneration('p',['ok'])).toMatchObject({status:'ready'});
   expect(f.requests.filter(r=>r.path.includes('/tasks/task-ok'))).toHaveLength(1);expect(f.requests.some(r=>r.path.includes('/canvas-runs'))).toBe(false);
  }finally{f.ex.clear();}
 }
});
it.each(['new persisted task','different login','new local choice'])('discards late history after %s',async reason=>{
 let release!:(r:Response)=>void;const delayed=new Promise<Response>(resolve=>{release=resolve;});
 const f=await fixture(path=>path.endsWith('/tasks/task-ok')?delayed:undefined);
 try{
  const pending=f.storage.historicalGenerationModel('p',f.graph.nodes[0]);
  const rejected=expect(pending).rejects.toMatchObject({code:reason==='different login'?'SESSION_CHANGED':'STALE_EXECUTION_INPUT'});
  if(reason==='different login')f.storage.clear();
  if(reason==='new local choice')f.storage.rememberModelBinding('p',f.graph.nodes[0],{capabilityRef:'image',capabilityVersion:'2'});
  if(reason==='new persisted task'){
   const next=f.snapshot(2);next.graph.nodes[0].data.taskId='replacement';
   f.storage.acceptRemoteSnapshot('p',next,'"2"');
  }
  release(reply(task('ok')));await rejected;expect(f.requests.some(r=>r.path.includes('/model-capability-version?'))).toBe(false);
 }finally{f.ex.clear();}
});
