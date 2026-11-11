import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {installNativeGenerationControls} from '../../apps/web/src/service/native-integration';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import captured from './fixtures/native-text-panorama-command.json';

const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
function slice(source:string,start:string,end:string){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Frozen submission seam changed');return source.slice(a,b);}
const profile:any={capabilityRef:'codex-image-generate-v1',kind:'TEXT_TO_IMAGE',version:'3',parameterSchemaVersion:'3',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
const refusal=(status=501,code='PROMPT_TEMPLATE_NOT_CONFIGURED',requestId:any='server-reject-trace')=>new Response(JSON.stringify({code:status,error:{code,message:'explicit rejection'},...(requestId===undefined?{}:{requestId})}),{status});

function fixture(post:()=>Response|Promise<Response>){
 vi.useFakeTimers();
 const files=new Map<string,string>(),sessionStorage={getItem:(key:string)=>files.get(key)??null,setItem:(key:string,value:string)=>files.set(key,value),removeItem:(key:string)=>files.delete(key)},f=structuredClone(captured),graph:any={nodes:[f.baseline],edges:[]},target=f.targetId,requests:string[]=[],notice=vi.fn();
 let row:any={get:(key:string)=>key==='id'?target:undefined};
 const manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn(),ynodes:{toArray:()=>[row]}};
 const transport=vi.fn(async(path:string,init:any)=>{
  requests.push(path);
  if(path.includes('model-capabilities'))return json({items:[profile],nextCursor:null});
  if(path==='/api/v1/projects/p/snapshot')return json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-22T04:00:00Z'});
  if(path==='/api/v2/canvas-runs')return post();
  if(path.startsWith('/api/v2/tasks/'))return new Promise<Response>(()=>{});
  throw new Error('Unexpected route '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,notice),adapter=new ExecutionAdapter(api,storage,async()=>{},notice);
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-22T03:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 const cacheSource=slice(index,'const Bxn=','let l1=null;');
 const cache=(withSubmit=false)=>runInNewContext(cacheSource+(withSubmit?slice(index,'function vMn(','async function bMn('):'')+';({eE:Gy,fp:bSe,fX:zXr,pending:Uxn,remember:VZ'+(withSubmit?',submit:$m':'')+'})',{
  window:{sessionStorage},Date,setTimeout:(fn:any,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:any)=>clearTimeout(id),console,
  Yy:()=>({}),Xd:(value:any)=>structuredClone(value),uhe:undefined,dhe:undefined,yMn:()=>null,jCe:(canvas:any)=>typeof canvas==='string'?JSON.parse(canvas):canvas,Sb:(body:any)=>({body,config:{}}),Sn:{post:async(_path:string,body:any)=>({data:await adapter.run(body)})},iv:(value:any)=>value,UNn:vi.fn(),U8:vi.fn(),T2:vi.fn(),
 });
 const nativeCache:any=cache(true);let nativeState:any={localRunningNodeIds:[]};
 const nativeMethods=runInNewContext('({'+slice(index,'markLocalRunning:',',setResizingNodeId:')+'})',{
  e:(patch:any)=>{nativeState={...nativeState,...(typeof patch==='function'?patch(nativeState):patch)};},t:()=>nativeState,uct:vi.fn(),Qoe:vi.fn(),wLe:vi.fn(),bH:vi.fn(),_x:new Map(),
 });
 nativeState={...nativeState,...nativeMethods};
 const native:any={...nativeCache,bt:()=>manager,le:vi.fn(),c5:{getState:()=>nativeState,setState:(patch:any)=>{nativeState={...nativeState,...patch};}}},runtime={auth:{user:{id:'owner'} as any},inspect:()=>({id:'p'}),execution:adapter};
 const style={id:'',textContent:'',remove:vi.fn()};vi.stubGlobal('document',{body:{},head:{append:vi.fn()},createElement:()=>style,querySelectorAll:()=>[],addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('MutationObserver',class{observe(){}disconnect(){}});
 const dispose=installNativeGenerationControls(runtime,notice,native),model=capabilityModel(profile),warnings=vi.fn(),nativeRun=runInNewContext(slice(shell,'function Q8(','function Lf(')+slice(shell,'async function tP(','function jr(')+';tP',{
  cT:()=>false,uT:()=>structuredClone(graph.nodes),vk:()=>false,fT:()=>false,pT:()=>false,hT:()=>false,er:()=>false,Os:()=>false,Gy:()=>[],mT:()=>null,yT:()=>model,K8:(value:any)=>value,fg:()=>false,Yy:()=>false,CT:()=>null,Bt:{PROMPT:'prompt'},wu:()=>false,NT:()=>({nodes:[structuredClone(f.command)],edges:[]}),IT:()=>false,Lh:(params:any)=>params,jT:()=>null,OT:()=>null,PT:()=>null,D8:async()=>null,ft:native.c5,Xy:{getState:()=>({save:vi.fn()})},LT:(_model:any,params:any)=>params,mg:nativeCache.submit,AS:()=>false,J8:()=>false,RS:vi.fn(),fd:nativeCache.eE,DT:(error:any)=>error.message,Ie:{error:vi.fn()},console:{warn:warnings},
 });
 const submit=()=>nativeRun({canvasId:'p',nodeId:target,nodes:structuredClone(graph.nodes),edges:[],models:{'text-image':[model]},onNodeDataPatch:vi.fn(),extractTaskId:(task:any)=>task.taskId,t:(key:string)=>key});
 return{adapter,api,storage,runtime,native,manager,graph,target,files,cache,requests,notice,warnings,submit,state:()=>nativeState,rebuild:()=>{row={get:(key:string)=>key==='id'?target:undefined};},stop:()=>{dispose();adapter.clear();}};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

it.each([{status:501,code:'PROMPT_TEMPLATE_NOT_CONFIGURED'},{status:501,code:'PROMPT_CONDITIONING_UNSUPPORTED'},{status:501,code:'MODEL_EXECUTION_DISABLED'},{status:422,code:'MEDIA_INPUT_INVALID'},{status:422,code:'VALIDATION_FAILED'},{status:422,code:'PROMPT_REFERENCE_REQUIRED'},{status:412,code:'VERSION_CONFLICT'},{status:501,code:'MODEL_ROUTER_NOT_CONFIGURED'}])('releases the real frozen tP/$m pending cache after a traced pre-create $status: $code',async({status,code})=>{
 const c=fixture(()=>refusal(status,code));
 try{expect(await c.submit()).toBe(status>=500);expect(c.requests.filter(path=>path==='/api/v2/canvas-runs')).toHaveLength(1);expect(c.graph.nodes[0].data.status).toBe('idle');expect(c.state().localRunningNodeIds).not.toContain(c.target);expect((c.adapter as any).localAttempts.has(c.target)).toBe(false);expect((c.adapter as any).submissions.size).toBe(0);expect(c.files.has('canvas-node-task-cache:v1:p')).toBe(false);
  // Reload the actual frozen native cache over the same sessionStorage bytes.
  const reload=c.cache(),restore=vi.fn();reload.fX('p',c.graph.nodes,restore);expect(restore).not.toHaveBeenCalled();expect(reload.fp('p',c.target)).toBeNull();expect(c.manager.patchNodeData).not.toHaveBeenCalled();expect(c.notice).toHaveBeenCalledExactlyOnceWith('explicit rejection');
 }finally{c.stop();}
});

it.each([
 ['missing-request-id',()=>new Response(JSON.stringify({error:{code:'PROMPT_TEMPLATE_NOT_CONFIGURED',message:'no server trace'}}),{status:501})],
 ['empty-request-id',()=>refusal(501,'PROMPT_TEMPLATE_NOT_CONFIGURED',' ')],
 ['invalid-request-id-type',()=>refusal(501,'PROMPT_TEMPLATE_NOT_CONFIGURED',5)],
 ['unknown-501',()=>refusal(501,'UNKNOWN_FAILURE')],
 ['known-code-502',()=>refusal(502)],
 ['storage-503',()=>refusal(503,'EXECUTION_STORAGE_UNAVAILABLE')],
 ['timeout-408',()=>refusal(408)],
 ['network',()=>{throw new TypeError('network response lost');}],
 ['invalid-response',()=>new Response('<html>proxy failure</html>',{status:501})],
] as const)('preserves uncertainty and the native reload pending record: %s',async(_name,post)=>{
 const c=fixture(post);
 try{await c.submit();expect(c.state().localRunningNodeIds).toContain(c.target);expect((c.adapter as any).localAttempts.get(c.target)?.submitted).toBe(true);const record=JSON.parse(c.files.get('canvas-node-task-cache:v1:p')!)[c.target];expect(record).toMatchObject({pending:true,taskId:''});const reload=c.cache(),restore=vi.fn();reload.fX('p',c.graph.nodes,restore);expect(restore).toHaveBeenCalledOnce();expect(reload.fp('p',c.target)).toBeNull();expect(c.notice).not.toHaveBeenCalledWith('explicit rejection');}finally{c.stop();}
});

it('does not classify an aborted transport as definitely unsubmitted, irrespective of the original native numeric-error policy',async()=>{
 const c=fixture(()=>{throw new DOMException('timeout','AbortError');}),settled=vi.fn();c.adapter.onSettled(settled);
 try{await c.submit();expect((c.adapter as any).localAttempts.get(c.target)?.submitted).toBe(true);expect(settled).not.toHaveBeenCalled();}finally{c.stop();}
});

it.each(['new-mark','new-node-identity','logout','different-project','adapter-cleared'])('does not release another owner or a newer native attempt after a traced refusal: %s',async change=>{
 let finish!:(value:Response)=>void;const c=fixture(()=>new Promise(resolve=>finish=resolve));
 try{const pending=c.submit();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));if(change==='new-mark')c.native.c5.getState().refreshLocalRunningBaseline(c.target,c.graph.nodes[0].data);if(change==='new-node-identity')c.rebuild();if(change==='logout')c.runtime.auth.user=null;if(change==='different-project')c.runtime.inspect=()=>({id:'q'});if(change==='adapter-cleared')c.adapter.clear();finish(refusal());await pending;expect(c.state().localRunningNodeIds).toContain(c.target);expect(JSON.parse(c.files.get('canvas-node-task-cache:v1:p')!)[c.target]).toMatchObject({pending:true,taskId:''});expect(c.notice).not.toHaveBeenCalledWith('explicit rejection');}finally{c.stop();}
});

it.each(['accepted','post-accept-failure'])('retains an accepted task even if later handling fails: %s',async mode=>{
 let c:ReturnType<typeof fixture>;c=fixture(()=>json({id:'accepted',projectId:'p',canvasManaged:true,state:'QUEUED',revision:3,testMode:false,plans:[{nodeId:c.target,executionId:'ex',state:'QUEUED',canvasBinding:{applicationState:'PENDING'},outputs:[]}]}));
 if(mode==='post-accept-failure')vi.spyOn(c.adapter as any,'apply').mockRejectedValueOnce(new ApiError(501,'PROMPT_TEMPLATE_NOT_CONFIGURED','later error','later-trace'));
 try{await c.submit();expect(c.state().localRunningNodeIds).toContain(c.target);expect((c.adapter as any).localAttempts.get(c.target)).toMatchObject({submitted:true,taskId:'accepted'});expect(c.files.has('canvas-node-task-cache:v1:p')).toBe(true);if(mode==='accepted'){expect(JSON.parse(c.files.get('canvas-node-task-cache:v1:p')!)[c.target]).toMatchObject({pending:false,taskId:'accepted'});expect(c.native.fp('p',c.target)).toBe('accepted');}}finally{c.stop();}
});
