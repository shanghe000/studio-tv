import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"1"'}});
function fixture(kind:'asset'|'task'|'capability'){
 const native={nodes:[{id:'node',type:'rh-image',position:{x:0,y:0},data:{modelCode:'model',taskId:'task',sourceObjects:['rhtv-asset:asset']}}],edges:[]};
 const project={id:'p',ownerId:'owner',name:'Synthetic legacy project',revision:1,coverAssetId:null};
 const value=(path:string)=>{
  if(path==='/api/v1/projects/p')return project;
  if(path.endsWith('/snapshot'))return{projectId:'p',revision:1,graph:encodeGraph(native),updatedAt:'2026-11-05T00:00:00Z'};
  if(path==='/api/v2/tasks/task')return{id:'task',projectId:'p',plans:[{nodeId:'node',capabilityRef:'model',capabilityVersion:'1'}]};
  if(path.startsWith('/api/v2/model-capability-version?'))return{capabilityRef:'model',version:'1',parameterSchemaVersion:'1'};
  if(path==='/api/v1/assets/asset')return{id:'asset',state:'READY',kind:'IMAGE',projectId:'p',downloadUrl:'https://fixture.invalid/asset'};
  throw Error('Unexpected legacy request '+path);
 };
 const matches=(path:string)=>kind==='asset'?path==='/api/v1/assets/asset':kind==='task'?path==='/api/v2/tasks/task':path.startsWith('/api/v2/model-capability-version?');
 let fail=true,slow=false;const transport=vi.fn(async(path:string,options:any={})=>{
  if(matches(path)&&fail)return new Promise<Response>(()=>{});
  if(matches(path)&&slow){
   const bytes=new TextEncoder().encode(JSON.stringify({code:0,data:value(path)}));
   return new Response(new ReadableStream<Uint8Array>({start(controller){
    for(let index=0;index<8;index++)setTimeout(()=>{controller.enqueue(bytes.subarray(Math.floor(index*bytes.length/8),Math.floor((index+1)*bytes.length/8)));if(index===7)controller.close();},index*5000);
   }}));
  }
  return json(value(path));
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('synthetic');const storage=new ServiceStorage(api,vi.fn());
 return{storage,transport,matches,recover:()=>{fail=false;},slow:()=>{fail=false;slow=true;}};
}

it.each(['asset','task','capability'] as const)('releases a stalled legacy %s read and permits a fresh successful load',async kind=>{
 const f=fixture(kind),loading=f.storage.loadProject('p'),failed=expect(loading).rejects.toMatchObject({code:'CANVAS_REQUEST_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(15001);await failed;expect(f.storage.projects.has('p')).toBe(false);
 const prior=f.transport.mock.calls.find(([path])=>f.matches(path))!;expect(prior[1].signal.aborted).toBe(true);
 f.recover();expect((await f.storage.loadProject('p')).id).toBe('p');expect(f.storage.snapshots.get('p')?.revision).toBe(1);
 expect(f.transport.mock.calls.filter(([path])=>f.matches(path))).toHaveLength(2);
});

it.each(['asset','task','capability'] as const)('accepts a continuously progressing legacy %s response longer than the idle deadline',async kind=>{
 const f=fixture(kind);f.slow();const loading=f.storage.loadProject('p');await vi.advanceTimersByTimeAsync(35001);
 expect((await loading).id).toBe('p');expect(f.transport.mock.calls.filter(([path])=>f.matches(path))).toHaveLength(1);
});

it('immediately cancels a stalled legacy asset load on identity cleanup without awaiting its network response',async()=>{
 const f=fixture('asset'),loading=f.storage.loadProject('p'),failed=expect(loading).rejects.toMatchObject({code:'SESSION_CHANGED'});
 await vi.advanceTimersByTimeAsync(0);expect(f.transport.mock.calls.some(([path])=>f.matches(path))).toBe(true);
 f.storage.clear();await failed;expect(f.storage.projects.size).toBe(0);expect(f.storage.assets.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
