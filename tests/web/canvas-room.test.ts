import {afterEach,expect,it,vi} from 'vitest';
import {CanvasRoom,roomProtocol} from '../../apps/web/src/service/canvas-room';
import {encodeRoomMoves,decodeRoomMoves} from '../../apps/web/src/service/canvas-room-moves';
import {ProductClient} from '../../apps/web/src/service/product-client';

class TestSocket {
 protocol=roomProtocol;
 bufferedAmount=0;
 sent:any[]=[];
 onopen:(()=>void)|null=null;
 onmessage:((e:{data:string|ArrayBuffer})=>void)|null=null;
 onclose:(()=>void)|null=null;
 send(raw:string|Uint8Array){this.sent.push(typeof raw==='string'?JSON.parse(raw):raw);}
 frame(payload:unknown){this.onmessage?.({data:JSON.stringify(payload)});}
 close=vi.fn();
}
const apiPath='/projects/p/canvas-operations';
const proof='p'.repeat(43);
const firstGrant='11111111-1111-4111-8111-111111111111', nextGrant='22222222-2222-4222-8222-222222222222';
const batch={schemaVersion:'1',clientId:'page',batchId:'b1',observedRevision:8,operations:[{type:'node.patch',nodeId:'n',set:[{path:['position','x'],value:32}],unset:[]}]};
const body={batchId:'b1',projectId:'p',revision:9};
const result={code:0,data:body};
const request={method:'POST',body:batch,headers:{'X-STUDIO-Canvas-Receipt':'delta-v1','X-STUDIO-Canvas-Base':'8'}};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

function setup(formats?:string[]){
 const socket=new TestSocket(),signal=new AbortController();
 const factory=vi.spyOn(CanvasRoom,'open').mockImplementation((_id,token,after,signal)=>new CanvasRoom(socket as any,token,after,signal,_id));
 const http=vi.fn(async(_path:string,_options:RequestInit)=>new Response(JSON.stringify(result),{headers:{etag:'"9"'}}));
 const api=new ProductClient('/api/v1',http as any);
 api.setAccessToken('login');api.setCanvasSession('p','page',proof,formats ? firstGrant : 'term');
 const room=api.openCanvasRoom('p','45',signal.signal)!;
 socket.onopen!();
 expect(factory).toHaveBeenCalledWith('p','login','45',signal.signal);
 expect(socket.sent).toEqual([{type:'join',token:'login',after:'45',formats:['move-v1']}]);
 socket.frame({type:'ready',formats});
 const stop=()=>api.releaseCanvasRoom('p',room);
 return {api,http,socket,room,signal,stop};
}

it('settles a durable receipt even while an inbound canvas edit is waiting for the editor',async()=>{
 const {api,http,room,socket,stop}=setup();
 try{
  await room.next();
  const pending=api.requestV2(apiPath,request);
  const write=socket.sent.at(-1);
  expect(write).toMatchObject({type:'write',body:batch,proof,lease:'term',baseRevision:8});
  socket.frame({type:'event',id:'46',event:'canvas.delta',data:{eventCursor:'46'}});
  socket.frame({type:'heartbeat'});
  socket.frame({type:'receipt',requestId:write.requestId,status:200,etag:'"9"',body:result});
  expect(await pending).toMatchObject({etag:'"9"',data:body});
  expect(await room.next()).toMatchObject({type:'event',value:{id:'46'}});
  expect(http).not.toHaveBeenCalled();
 }finally{stop();}
});

it.each(['disconnect','malformed'])('after a %s receipt retries the identical operation batch over HTTP with the original page grant',async cause=>{
 const {api,http,socket,stop}=setup();
 try{
  const pending=api.requestV2(apiPath,request);
  if(cause==='disconnect')socket.onclose!();
  else socket.frame({type:'receipt',requestId:socket.sent.at(-1).requestId,status:200,body:{}});
  expect((await pending).data).toEqual(body);
  const [target,options]=http.mock.calls[0];
  expect(target).toBe('/api/v2'+apiPath);
  expect(JSON.parse(String(options.body))).toEqual(socket.sent.at(-1).body);
  expect(new Headers(options.headers).get('X-STUDIO-Canvas-Lease')).toBe('term');
 }finally{stop();}
});

it.each(['grant','login','cancel'] as const)('stops a failed socket write instead of passing it to a replacement %s',async(boundary)=>{
 const {api,http,socket,stop}=setup(),signal=new AbortController();
 try{
  const pending=api.requestV2(apiPath,{...request,signal:signal.signal});
  const failed=expect(pending).rejects.toMatchObject(boundary==='cancel'?{name:'AbortError'}:{code:boundary==='login'?'SESSION_CHANGED':'EDIT_SESSION_EXPIRED'});
  if(boundary==='grant')api.setCanvasSession('p','fresh','a'.repeat(43),'term2');
  if(boundary==='login')api.clearRequests();
  if(boundary==='cancel')signal.abort();
  socket.onclose?.();await failed;expect(http).not.toHaveBeenCalled();
 }finally{stop();}
});

it('propagates a definite refusal with its request ID and never resends it with another transport',async()=>{
 const {api,http,socket,stop}=setup();try{
  const pending=api.requestV2(apiPath,request);
  socket.frame({type:'receipt',requestId:socket.sent.at(-1).requestId,status:409,body:{code:'PROJECT_EDIT_OCCUPIED',message:'held',requestId:'failure-id'}});
  await expect(pending).rejects.toMatchObject({status:409,code:'PROJECT_EDIT_OCCUPIED',requestId:'failure-id'});
  expect(http).not.toHaveBeenCalled();
 }finally{stop();}
});

it('uses bounded catch-up when a stalled reader falls too far behind or a live socket loses heartbeats',async()=>{
 vi.useFakeTimers();
 for(const cause of ['overrun','half-open']){
  const {socket,room,stop}=setup();
  try{
   await room.next();
   if(cause==='overrun')for(let i=1;i<=34;i++)socket.frame({type:'event',id:String(i),event:'canvas.delta',data:{}});
   else{
    await vi.advanceTimersByTimeAsync(15000);socket.frame({type:'heartbeat'});
    await vi.advanceTimersByTimeAsync(10000);expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11000);
   }
   await expect(room.next()).rejects.toThrow('transport unavailable');expect(socket.close).toHaveBeenCalledOnce();
  }finally{stop();}
 }
});

it('reports inbound liveness without turning heartbeats into graph events or accepting an invalid receipt',async()=>{
 const socket=new TestSocket(),signal=new AbortController(),room=new CanvasRoom(socket as any,'login','45',signal.signal,'p'),activity=vi.fn();
 const detach=room.onActivity(activity);
 try{
  socket.onopen!();expect(activity).not.toHaveBeenCalled();
  socket.frame({type:'ready'});await expect(room.next()).resolves.toMatchObject({type:'ready'});expect(activity).toHaveBeenCalledTimes(1);
  const inbound=vi.fn();const reading=room.next().then(inbound).catch(()=>{});
  socket.frame({type:'heartbeat'});await Promise.resolve();expect(activity).toHaveBeenCalledTimes(2);expect(inbound).not.toHaveBeenCalled();
  const writing=room.write(batch,{proof,lease:'term'},8);expect(activity).toHaveBeenCalledTimes(2);
  socket.frame({type:'receipt',requestId:socket.sent.at(-1).requestId,status:200,body:{}});
  await expect(writing).resolves.toBeNull();await reading;expect(activity).toHaveBeenCalledTimes(2);
  detach();
 }finally{room.close();}
});

it('detaches an inbound liveness observer while retaining room reads',async()=>{
 const {socket,room,stop}=setup(),activity=vi.fn();const detach=room.onActivity(activity);
 try{
  socket.frame({type:'heartbeat'});expect(activity).toHaveBeenCalledOnce();detach();socket.frame({type:'heartbeat'});expect(activity).toHaveBeenCalledOnce();
  await expect(room.next()).resolves.toMatchObject({type:'ready'});
 }finally{stop();}
});

const xy = {type:'node.patch',nodeId:'node_1',
 set:[{path:['position','x'],value:14.875},{path:['position','y'],value:-3.5}],unset:[]};
const moveBatch = {...batch,operations:[xy]};
const readM = (frame:Uint8Array) => {expect(frame[0]).toBe(0x4d);return JSON.parse(new TextDecoder().decode(frame.subarray(1)));};
const eventState = [{nodeId:'node_1',taskId:'task_2',executionId:'exe_3',state:'SUCCEEDED',applicationState:'APPLIED'}];
const date = '2026-11-05T01:00:00Z';
const encodeE = (x:unknown) => new TextEncoder().encode('E'+JSON.stringify(x)).buffer;

it('negotiates a lossless move and retries its exact canonical body and page grant over HTTP after a lost receipt',async()=>{
 const {api,http,socket,stop}=setup(['move-v1']);
 try {
  const original=structuredClone(moveBatch);
  const pending=api.requestV2(apiPath,{...request,body:moveBatch});
  expect(readM(socket.sent.at(-1))).toEqual(['1','b1','page',proof,firstGrant,8,null,8,false,[['node_1',14.875,-3.5]]]);
  socket.onclose!();
  expect((await pending).data).toEqual(body);
  const [path,options]=http.mock.calls[0];
  expect(path).toBe('/api/v2'+apiPath);
  expect(JSON.parse(String(options.body))).toEqual(original);
  expect(moveBatch).toEqual(original);
  const headers=new Headers(options.headers);expect(headers.get('X-STUDIO-Canvas-Proof')).toBe(proof);expect(headers.get('X-STUDIO-Canvas-Lease')).toBe(firstGrant);
 }finally{stop();}
});

it('uses the binding acknowledged for this socket without adopting a different or delayed writer',async()=>{
 const {room,socket,stop}=setup(['move-v1']);
 const send=(batchId:string,page:string,lease:string)=>{
  const response=room.write({...moveBatch,clientId:page,batchId},{proof,lease},8);
  const tuple=readM(socket.sent.at(-1));
  return {response,tuple,ack:(bound:boolean)=>socket.frame({type:'receipt',requestId:tuple[0],status:200,etag:'"9"',bound,body:{code:0,data:{batchId}}})};
 };
 try{
  const old=send('one','page',firstGrant),other=send('two','other',nextGrant);
  expect(old.tuple.slice(2,5)).toEqual(['page',proof,firstGrant]);expect(other.tuple.slice(2,5)).toEqual(['other',proof,nextGrant]);
  other.ack(true);old.ack(false);await Promise.all([old.response,other.response]);
  const again=send('three','other',nextGrant);expect(again.tuple.slice(2,5)).toEqual([null,null,null]);again.ack(true);await again.response;
  const switched=send('four','page',firstGrant);expect(switched.tuple.slice(2,5)).toEqual(['page',proof,firstGrant]);switched.ack(true);await switched.response;
  const still=send('five','other',nextGrant);expect(still.tuple.slice(2,5)).toEqual([null,null,null]);still.ack(false);await still.response;
 }finally{stop();}
});

it('restores a remote position delta including the event cursor, execution availability, and pending/terminal node states',async()=>{
 const {room,socket,stop}=setup(['move-v1']);
 try{
  await room.next();
  socket.onmessage!({data:encodeE(['46',8,9,date,false,eventState,[['node_1',14.875,-3.5]]])});
  expect(await room.next()).toMatchObject({type:'event',value:{id:'46',event:'canvas.delta',data:{schemaVersion:'1',projectId:'p',
   graphRevision:9,eventCursor:'46',updatedAt:date,nodeStates:eventState,nodeExecutionAvailable:false,kind:'DELTA',fromRevision:8,
   delta:{positions:[{id:'node_1',x:14.875,y:-3.5}],upsertNodes:[],removeNodeIds:[],upsertEdges:[],removeEdgeIds:[]}}}});
 }finally{stop();}
});

it('keeps an unnegotiated, single-axis, mixed, ordered differently or extended patch on the original wire path',async()=>{
 const legacy=setup();try{const p=legacy.room.write(moveBatch,{proof,lease:'term'},8);expect(legacy.socket.sent.at(-1)).toMatchObject({type:'write',body:moveBatch});legacy.stop();await p;}finally{legacy.stop();}
 const nodePatch=(params:Record<string,unknown>)=>({...xy,...params});
 for(const b of [batch,{...moveBatch,version:2},{...moveBatch,operations:[xy,{type:'node.delete',nodeId:'n'}]},
   {...moveBatch,operations:[nodePatch({set:xy.set.slice().reverse()})]}, {...moveBatch,operations:[nodePatch({unset:[['data','key']]})]},
   {...moveBatch,operations:[nodePatch({set:[{...xy.set[0],unknown:'future'},xy.set[1]]})]},
   {...moveBatch,operations:[nodePatch({set:[{...xy.set[0],value:Infinity},xy.set[1]]})]}]){
  expect(encodeRoomMoves('q',b,proof,firstGrant,8)).toBeNull();
 }
 const special=encodeRoomMoves('r1',{...moveBatch,observedRevision:undefined,baseRevision:14,receiptOnly:true},proof,firstGrant)!;
 expect(readM(special.frame)).toEqual(['r1','b1','page',proof,firstGrant,null,14,null,true,[['node_1',14.875,-3.5]]]);
});

it('rejects invalid binary frames and cannot apply them on an unnegotiated connection',async()=>{
 const event=['46',8,9,date,true,eventState,[['node_1',4,8]]];
 const badBuffers=[new TextEncoder().encode('M'+JSON.stringify(event)).buffer,new Uint8Array([0x45,0xff]).buffer,
  encodeE([...event,'future']),encodeE([...event.slice(0,6),[['node_1',0,1],['node_1',0,1]]]),encodeE([...event.slice(0,6),[['node_1',null,1]]])];
 for(const b of badBuffers)expect(()=>decodeRoomMoves(b,'p')).toThrow();
 const {room,socket,stop}=setup();try{await room.next();socket.onmessage!({data:encodeE(event)});await expect(room.next()).rejects.toThrow();}finally{stop();}
});
