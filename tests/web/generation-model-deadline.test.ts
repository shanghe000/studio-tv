import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

afterEach(()=>vi.useRealTimers());
const cap={capabilityRef:'generate',version:'1',parameterSchemaVersion:'1',kind:'TEXT_TO_IMAGE',available:true,testMode:false,model:{providerRef:'fixture',modelRef:'generate',title:'图片生成',version:'1'},inputKinds:['TEXT'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt'],additionalProperties:false}};
const reply=(data:unknown)=>new Response(JSON.stringify({code:0,data}));
function fixture(route:'catalog'|'version'){
 let stalled=true,release:(value:Response)=>void=()=>{};const calls:{path:string;signal?:AbortSignal}[]=[];
 const api=new ProductClient('/api/v1',async(path,options)=>{
  calls.push({path,signal:options?.signal as AbortSignal});
  const catalog=path.includes('/model-capabilities?'),version=path.includes('/model-capability-version?');
  if((route==='catalog'&&catalog||route==='version'&&version)&&stalled){stalled=false;return new Promise<Response>(resolve=>{release=resolve;});}
  if(catalog)return reply({items:[route==='version'?{...cap,version:'2',parameterSchemaVersion:'2'}:cap],nextCursor:null});
  if(version)return reply(cap);throw Error('Unexpected model-read request '+path);
 });api.setAccessToken('fixture-only');
 const graph={nodes:[{id:'image',type:'rh-image',position:{x:0,y:0},data:{modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',subType:'text-image',params:{prompt:'A mountain'}}}],edges:[]};
 const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn()),manager={localOnly:true,getRemoteData:()=>graph,patchNodeData:vi.fn()};
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-05T00:00:00Z'},'"1"');storage.attachNativeView('p',graph);execution.attach('p',manager);
 return{execution,manager,calls,graph,release:(value:Response)=>release(value)};
}
it.each(['catalog','version'] as const)('releases a stalled %s read and checks the same unchanged input after recovery',async route=>{
 vi.useFakeTimers();const f=fixture(route),before=structuredClone(f.graph);
 try{
  const pending=f.execution.inspectGeneration('p',['image']);await vi.advanceTimersByTimeAsync(15001);
  expect(await pending).toMatchObject({status:'blocked',issues:[{code:'CANVAS_REQUEST_TIMEOUT',retryable:true}]});
  expect(await f.execution.inspectGeneration('p',['image'])).toEqual({status:'ready',issues:[]});
  expect(f.calls.filter(call=>call.path.includes(route==='catalog'?'/model-capabilities?':'/model-capability-version?'))).toHaveLength(2);
  expect(f.calls.every(call=>!call.path.includes('/canvas-runs')&&!call.path.includes('diagnostics'))).toBe(true);expect(f.graph).toEqual(before);expect(f.manager.patchNodeData).not.toHaveBeenCalled();
  // An abort-ignoring transport may finish late. Its stale response cannot
  // replace the successful current catalog or invalidate the current check.
  f.release(reply(route==='catalog'?{items:[],nextCursor:null}:{...cap,version:'wrong'}));await vi.advanceTimersByTimeAsync(0);
  expect(await f.execution.inspectGeneration('p',['image'])).toEqual({status:'ready',issues:[]});
 }finally{f.execution.clear();}
});
it.each(['catalog','version'] as const)('cancels a pending %s read on identity clear without waiting for its ignored abort',async route=>{
 vi.useFakeTimers();const f=fixture(route);
 try{
  const pending=f.execution.inspectGeneration('p',['image']);await vi.advanceTimersByTimeAsync(0);
  const read=f.calls.find(call=>call.path.includes(route==='catalog'?'/model-capabilities?':'/model-capability-version?'));expect(read).toBeDefined();
  f.execution.clear();expect(read!.signal?.aborted).toBe(true);expect(await pending).toMatchObject({status:'blocked',issues:[{code:'SESSION_CHANGED'}]});
  f.execution.attach('p',f.manager);expect(await f.execution.inspectGeneration('p',['image'])).toEqual({status:'ready',issues:[]});
 }finally{f.execution.clear();}
});
it('deduplicates concurrent catalog consumers, then releases the shared failed read for a new attempt',async()=>{
 vi.useFakeTimers();const f=fixture('catalog');
 try{
  const one=f.execution.catalog().catch(error=>error),two=f.execution.catalog().catch(error=>error);expect(f.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15001);expect(await one).toMatchObject({code:'CANVAS_REQUEST_TIMEOUT'});expect(await two).toMatchObject({code:'CANVAS_REQUEST_TIMEOUT'});
  expect(await f.execution.catalog()).toEqual([cap]);expect(f.calls).toHaveLength(2);
 }finally{f.execution.clear();}
});
