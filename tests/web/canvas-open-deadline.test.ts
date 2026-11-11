import {afterEach,expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

const reply=(data:any)=>Response.json({code:0,data},{headers:{'X-STUDIO-Canvas-Media':'a'.repeat(32),ETag:'"'+(data.revision??1)+'"'}});
const graph=encodeGraph({nodes:[],edges:[]});
const snapshot=(revision:number)=>reply({projectId:'p',revision,graph,updatedAt:'2026-11-04T00:00:00Z'});
afterEach(()=>vi.useRealTimers());

it('aborts a stalled shared cold read, releases both waiters, and ignores a stale body arriving after successful retry',async()=>{
 vi.useFakeTimers();let late!:(r:Response)=>void,attempt=0;
 const signals:AbortSignal[]=[];
 const transport=vi.fn(async(path:string,init:any)=>{
  signals.push(init.signal);
  if(path.endsWith('/snapshot'))return ++attempt===1?new Promise<Response>(done=>{late=done;}):snapshot(2);
  return reply({id:'p',name:'canvas',ownerId:'owner',revision:2});
 });
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport as any),()=>{});
 const first=storage.loadProject('p'),other=storage.loadProject('p');
 const failures=Promise.all([expect(first).rejects.toMatchObject({code:'CANVAS_OPEN_TIMEOUT'}),expect(other).rejects.toMatchObject({status:504})]);
 expect(transport).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(20_000);await failures;
 expect(signals[1].aborted).toBe(true);expect(storage.snapshots.size).toBe(0);
 await storage.loadProject('p');expect(storage.snapshots.get('p')?.revision).toBe(2);
 late(snapshot(1));await vi.advanceTimersByTimeAsync(0);expect(storage.snapshots.get('p')?.revision).toBe(2);
 expect(transport).toHaveBeenCalledTimes(4);
});

it('an authoritative denial does not wait for a sibling snapshot body and a cleared login cancels a shared read immediately',async()=>{
 let revoked=true;const signals:AbortSignal[]=[];
 const transport=vi.fn(async(path:string,init:any)=>{
  signals.push(init.signal);
  if(!path.endsWith('/snapshot')&&revoked)return Response.json({code:'FORBIDDEN'},{status:403});
  return new Promise<Response>(()=>{});
 });
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport as any),()=>{});
 await expect(storage.loadProject('p')).rejects.toMatchObject({status:403});expect(signals[1].aborted).toBe(true);
 revoked=false;const next=storage.loadProject('p'),canceled=expect(next).rejects.toMatchObject({code:'SESSION_CHANGED'});storage.clear();await canceled;
 expect(signals.slice(2).every(s=>s.aborted)).toBe(true);expect(storage.snapshots.size).toBe(0);
});

it('opens a snapshot that streams for longer than 20 seconds without restarting healthy progress',async()=>{
 vi.useFakeTimers();let body!:ReadableStreamDefaultController<Uint8Array>;const encoder=new TextEncoder(),signals:AbortSignal[]=[];
 const content=JSON.stringify({code:0,data:{projectId:'p',revision:7,graph,updatedAt:'2026-11-04T00:00:00Z'}}),pieces=[content.slice(0,12),content.slice(12,24),content.slice(24,36),content.slice(36)];
 const stream=new ReadableStream<Uint8Array>({start(controller){body=controller;}});
 const transport=vi.fn(async(path:string,init:any)=>{signals.push(init.signal);return path.endsWith('/snapshot')?new Response(stream,{headers:{'X-STUDIO-Canvas-Media':'a'.repeat(32),ETag:'"7"'}}):reply({id:'p',name:'canvas',ownerId:'owner',revision:7});});
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport as any),()=>{}),loading=storage.loadProject('p');await vi.advanceTimersByTimeAsync(0);
 for(const piece of pieces){await vi.advanceTimersByTimeAsync(9000);body.enqueue(encoder.encode(piece));await vi.advanceTimersByTimeAsync(0);}
 body.close();await loading;expect(storage.snapshots.get('p')?.revision).toBe(7);expect(signals.every(signal=>!signal.aborted)).toBe(true);expect(transport).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
});

it('times out 20 seconds after the final byte and cancels the stalled response reader',async()=>{
 vi.useFakeTimers();let body!:ReadableStreamDefaultController<Uint8Array>;const cancel=vi.fn(),encoder=new TextEncoder();
 const stream=new ReadableStream<Uint8Array>({start(controller){body=controller;},cancel});
 const transport=vi.fn(async(path:string)=>path.endsWith('/snapshot')?new Response(stream):reply({id:'p',name:'canvas',ownerId:'owner',revision:2}));
 const storage=new ServiceStorage(new ProductClient('/api/v1',transport as any),()=>{}),loading=storage.loadProject('p'),failed=expect(loading).rejects.toMatchObject({code:'CANVAS_OPEN_TIMEOUT'});await vi.advanceTimersByTimeAsync(15000);body.enqueue(encoder.encode('{"code":0,'));await vi.advanceTimersByTimeAsync(19000);expect(cancel).not.toHaveBeenCalled();expect(storage.snapshots.size).toBe(0);await vi.advanceTimersByTimeAsync(1000);await failed;expect(cancel).toHaveBeenCalledOnce();expect(storage.snapshots.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
