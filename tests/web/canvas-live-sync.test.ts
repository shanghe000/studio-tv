import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {CanvasSync,validCanvasCursor,compareCanvasCursor} from '../../apps/web/src/service/canvas-sync';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

const initial=():NativeGraph=>({nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{title:'Original',text:'Original'}}],edges:[],meta:{id:'p',name:'Fixture'}});
const json=(data:any,status=200)=>new Response(JSON.stringify(status<400?{code:0,data}:{code:data.code,message:data.message||'Failed'}),{status,headers:data.graphRevision?{ETag:'"'+data.graphRevision+'"'}:{}});
const live=(graph:NativeGraph,graphRevision=1,eventCursor='0')=>({schemaVersion:'1',projectId:'p',graph:encodeGraph(graph),graphRevision,eventCursor,updatedAt:'2026-10-06T00:00:00Z',nodeStates:[],nodeExecutionAvailable:false});
const nodeState=()=>({nodeId:'n',taskId:'task_n',executionId:'exec_n',state:'SUCCEEDED',applicationState:'APPLIED'});
const event=(sequence:string,baseRevision=1)=>({schemaVersion:'1',projectId:'p',sequence,occurredAt:'2026-10-06T00:00:00Z',type:'canvas.invalidated',source:{kind:'API'},data:{baseRevision,graphRevision:baseRevision+1,reason:'LEGACY_GRAPH_WRITE'}});
const page=(after:string,events:any[]=[],head=events.at(-1)?.sequence||after)=>({projectId:'p',events,nextCursor:events.at(-1)?.sequence||after,eventCursor:head,hasMore:(events.at(-1)?.sequence||after)!==head});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
function setup(handler:(path:string,options:any)=>Promise<Response>|Response){
 const transport=vi.fn(handler),api=new ProductClient('/api/v1',transport as any);api.setAccessToken('fixture-owner');
 const storage=new ServiceStorage(api,vi.fn());storage.projects.set('p',{id:'p',ownerId:'owner',name:'Fixture',revision:1} as any);storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(initial()),updatedAt:'2026-10-06T00:00:00Z'});
 let native=initial(),current=true,canApply=true;
 storage.attachNativeView('p',native);
 const apply=vi.fn((graph:NativeGraph)=>{if(!canApply)return false;native=structuredClone(graph);return true;}),error=vi.fn(),applied=vi.fn();
 const sync=new CanvasSync(api,storage,'p',{current:()=>current,read:()=>native,apply,applied,error});
 return{sync,api,storage,transport,apply,error,applied,native:()=>native,setNative:(value:NativeGraph)=>native=value,setCurrent:(value:boolean)=>current=value,setCanApply:(value:boolean)=>canApply=value};
}
afterEach(()=>{vi.useRealTimers();});

it.each([false,true])('applies a committed move directly from the room or reads a full snapshot on malformed delta (%s)',async malformed=>{
 vi.useFakeTimers();let snapshots=0,fallthrough=0;
 const remote=initial();remote.nodes[0].position={x:89,y:13};
 const packet={...live(remote,2,'1'),kind:'DELTA',fromRevision:1,delta:{upsertNodes:[],upsertEdges:[],removeNodeIds:[],removeEdgeIds:[],positions:[{id:malformed?'missing':'n',x:89,y:13}]}};
 delete (packet as any).graph;
 const f=setup((path,opt)=>{
  if(path.endsWith('/live-snapshot')){snapshots++;const r=json(snapshots===1?live(initial()):live(remote,2,'1'));r.headers.set('X-STUDIO-Canvas-Update','delta-v1');return r;}
  if(path.includes('/live-update?')){fallthrough++;return json(packet);}
  if(opt.headers.get('Accept')==='text/event-stream'){
   expect(opt.headers.get('X-STUDIO-Canvas-Update')).toBe('delta-v1');
   return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('id: 1\nevent: canvas.delta\ndata: '+JSON.stringify(packet)+'\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}});
  }
  return json(page('0'));
 });
 const work=f.sync.start();await vi.advanceTimersByTimeAsync(0);
 expect(f.sync.eventCursor).toBe('1');expect(f.native().nodes.find(n=>n.id==='n')?.position).toEqual({x:89,y:13});
 expect(snapshots).toBe(malformed?2:1);expect(fallthrough).toBe(malformed?1:0);expect(f.error).not.toHaveBeenCalled();
 f.sync.stop();await work;
});

it('wakes a quiet stream for fresh CAS proof even when its event cursor already reached the server head',async()=>{
 vi.useFakeTimers();let newer=false,snapshots=0;const canceled=vi.fn(),remote=initial();remote.nodes[0].data.title='Already committed remote title';
 const f=setup((path,options)=>{
  if(path.endsWith('/live-snapshot')){snapshots++;return json(live(newer?remote:initial(),newer?2:1,newer?'1':'0'));}
  if(new Headers(options.headers).get('Accept')==='text/event-stream')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: canvas.invalidated\ndata: {"schemaVersion":'));},cancel:canceled}),{headers:{'Content-Type':'text/event-stream'}});
  return json(page(newer?'1':'0'));
 });
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(0);expect(snapshots).toBe(1);
 f.native().nodes[0].data.text='Retain local input';f.storage.captureDraft('p',f.native());const state=(f.storage as any).drafts.get('p');newer=true;
 (f.storage as any).blockUncertain('p',state,1,true);f.storage.captureDraft('p',f.native());await vi.advanceTimersByTimeAsync(200);
 expect(canceled).toHaveBeenCalled();expect(snapshots).toBe(2);expect(f.storage.isBlocked('p')).toBe(false);expect(f.native().nodes[0].data).toMatchObject({title:'Already committed remote title',text:'Retain local input'});expect(f.storage.hasDraft('p')).toBe(true);expect(f.transport.mock.calls.every(([,options])=>!options.method||options.method==='GET')).toBe(true);expect(f.error).not.toHaveBeenCalled();
 f.sync.stop();await running;
});

it.each([false,true])('bounds unresolved proof reads and suppresses redundant event requests (native can apply=%s)',async canApply=>{
 vi.useFakeTimers();let snapshots=0;const f=setup(path=>{if(path.endsWith('/live-snapshot')){snapshots++;return json(live(initial()));}return json(page('0'));});f.setCanApply(canApply);
 const state=(f.storage as any).drafts.get('p');(f.storage as any).blockUncertain('p',state,1,true);
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(0);expect(snapshots).toBe(1);await vi.advanceTimersByTimeAsync(999);expect(snapshots).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(snapshots).toBe(2);expect(f.storage.isBlocked('p')).toBe(true);
 expect(f.transport.mock.calls.every(([path])=>path.endsWith('/live-snapshot'))).toBe(true);f.sync.stop();await running;const count=f.transport.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(f.transport).toHaveBeenCalledTimes(count);expect(f.transport.mock.calls.every(([,options])=>!options.method||options.method==='GET')).toBe(true);expect(f.error).not.toHaveBeenCalled();
});

it('cancels an in-flight proof read and fences its snapshot after stopping or switching pages',async()=>{
 const gate=deferred<Response>(),started=deferred<void>();let signal!:AbortSignal;
 const f=setup((_path,options)=>{signal=options.signal;started.resolve();return gate.promise;});const state=(f.storage as any).drafts.get('p');(f.storage as any).blockUncertain('p',state,1,true);
 const pending=f.sync.catchUp(),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});await started.promise;f.setCurrent(false);f.sync.stop();expect(signal.aborted).toBe(true);gate.resolve(json(live(initial(),2,'1')));await rejected;
 expect(f.storage.snapshots.get('p')?.revision).toBe(1);expect(f.apply).not.toHaveBeenCalled();expect(f.transport).toHaveBeenCalledOnce();
});

it('uses cancellable one-second JSON catch-up while a temporary account stream limit drains',async()=>{
 vi.useFakeTimers();let pollSignal!:AbortSignal;
 const f=setup((path,options)=>{
  if(path.endsWith('/live-snapshot'))return json(live(initial()));
  if(new Headers(options.headers).get('Accept')==='text/event-stream')return json({code:'EVENT_STREAM_LIMIT',message:'slots occupied'},429);
  pollSignal=options.signal;return new Promise<Response>((_resolve,reject)=>{pollSignal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
 });
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(0);expect(f.transport).toHaveBeenCalledTimes(2);expect(f.error).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(999);expect(f.transport).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1);expect(f.transport).toHaveBeenCalledTimes(3);expect(new Headers(f.transport.mock.calls[2][1].headers).get('Accept')).toBe('application/json');
 f.sync.stop();expect(pollSignal.aborted).toBe(true);await running;await vi.advanceTimersByTimeAsync(10000);expect(f.transport).toHaveBeenCalledTimes(3);expect(f.error).not.toHaveBeenCalled();
});

it('continues reporting unrelated rate limits instead of switching them into stream capacity fallback',async()=>{
 vi.useFakeTimers();const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial())):json({code:'OTHER_RATE_LIMIT',message:'upstream rate limit'},429));
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(0);expect(f.error).toHaveBeenCalledWith(expect.objectContaining({status:429,code:'OTHER_RATE_LIMIT'}));expect((f.sync as any).sse).toBe(true);f.sync.stop();await running;
});

it('keeps cursor strings exact beyond JavaScript safe integers and rejects invalid int64 values',()=>{
 expect(validCanvasCursor('9007199254740993')).toBe(true);expect(validCanvasCursor('9223372036854775807')).toBe(true);
 for(const value of [9007199254740993,'01','-1','9223372036854775808','1e3',' 1'])expect(validCanvasCursor(value)).toBe(false);
 expect(compareCanvasCursor('9007199254740993','9007199254740992')).toBe(1);expect(compareCanvasCursor('10','9')).toBe(1);
});

it('rebases input still inside the autosave delay before applying an atomic live snapshot',async()=>{
 const remote=initial();remote.nodes.push({id:'agent',type:'rh-text',position:{x:100,y:0},data:{text:'Remote'}});
 const f=setup(()=>json(live(remote,2,'9007199254740993')));f.native().nodes[0].data.text='Unsaved local input';
 await f.sync.catchUp();
 expect(f.sync.eventCursor).toBe('9007199254740993');expect(f.native().nodes.map(node=>node.id)).toEqual(['n','agent']);expect(f.native().nodes[0].data.text).toBe('Unsaved local input');expect(f.storage.hasDraft('p')).toBe(true);expect(f.storage.isBlocked('p')).toBe(false);
 expect(f.transport).toHaveBeenCalledOnce();expect(f.transport.mock.calls[0][0]).toBe('/api/v2/projects/p/live-snapshot');
});

it('does not advance the applied cursor while a focused editor defers the native batch',async()=>{
 const remote=initial();remote.nodes[0].data.title='Remote title';const f=setup(()=>json(live(remote,2,'12')));f.setCanApply(false);
 expect(await f.sync.catchUp()).toBe(false);expect(f.sync.eventCursor).toBeNull();expect(f.sync.awaitingApply).toBe(true);expect(f.native().nodes[0].data.title).toBe('Original');
 f.native().nodes[0].data.text='Typed while focused';f.setCanApply(true);expect(await f.sync.catchUp()).toBe(true);
 expect(f.transport).toHaveBeenCalledOnce();expect(f.native().nodes[0].data).toMatchObject({text:'Typed while focused',title:'Remote title'});expect(f.sync.eventCursor).toBe('12');expect(f.applied).toHaveBeenCalledOnce();
});

it('delivers authoritative node states only after their coherent native graph has actually applied',async()=>{
 const remote=initial();remote.nodes[0].data={...remote.nodes[0].data,text:'Server result',taskId:'task_n',status:'success'};
 const snapshot={...live(remote,2,'12'),nodeExecutionAvailable:true,nodeStates:[nodeState()]},f=setup(()=>json(snapshot));f.setCanApply(false);
 expect(await f.sync.catchUp()).toBe(false);expect(f.applied).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();
 f.setCanApply(true);expect(await f.sync.catchUp()).toBe(true);
 expect(f.applied).toHaveBeenCalledExactlyOnceWith(snapshot);expect(f.native().nodes[0].data.text).toBe('Server result');expect(f.sync.eventCursor).toBe('12');expect(f.transport).toHaveBeenCalledOnce();
});

it('refreshes a state-only invalidation with the same graph content and an advanced project revision',async()=>{
 let snapshots=0;const queued={...nodeState(),state:'QUEUED',applicationState:'PENDING'},running={...queued,state:'RUNNING'};
 const f=setup(path=>path.endsWith('/live-snapshot')?json({...live(initial(),++snapshots,String(snapshots-1)),nodeExecutionAvailable:true,nodeStates:[snapshots===1?queued:running]}):json(page('0',[{...event('1'),data:{baseRevision:1,graphRevision:2,reason:'REVISION_ONLY'}}])));
 await f.sync.catchUp();await f.sync.catchUp();
 expect(f.applied.mock.calls.map(call=>call[0].nodeStates[0].state)).toEqual(['QUEUED','RUNNING']);expect(f.native().nodes).toEqual(initial().nodes);expect(f.native().edges).toEqual([]);expect(f.sync.eventCursor).toBe('1');expect(f.storage.hasDraft('p')).toBe(false);
});

it.each([
 ['unknown task state',{...nodeState(),state:'WAITING_TOOL'}],
 ['unknown application state',{...nodeState(),applicationState:'SUCCESS'}],
 ['a missing graph node',{...nodeState(),nodeId:'deleted'}],
 ['a missing task id',{...nodeState(),taskId:''}],
 ['a private field',{...nodeState(),providerToken:'private'}],
 ['an empty reason',{...nodeState(),reason:''}],
])('rejects %s in node-state evidence before applying or acknowledging the snapshot',async(_label,state)=>{
 const f=setup(()=>json({...live(initial(),2,'1'),nodeExecutionAvailable:true,nodeStates:[state]}));
 await expect(f.sync.catchUp()).rejects.toMatchObject({code:'INVALID_CANVAS_SYNC'});expect(f.apply).not.toHaveBeenCalled();expect(f.applied).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();
});

it.each([
 {nodeExecutionAvailable:true,nodeStates:[nodeState(),{...nodeState(),taskId:'second_task'}]},
 {nodeExecutionAvailable:false,nodeStates:[nodeState()]},
 {nodeExecutionAvailable:'true',nodeStates:[]},
])('rejects duplicate or unavailable node-state projections',async fields=>{
 const f=setup(()=>json({...live(initial(),2,'1'),...fields}));await expect(f.sync.catchUp()).rejects.toMatchObject({code:'INVALID_CANVAS_SYNC'});expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();
});

it('keeps same-field local input and marks its draft conflict instead of submitting an automatic resolution',async()=>{
 const remote=initial();remote.nodes[0].data.text='Remote input';const f=setup(()=>json(live(remote,2,'2')));f.native().nodes[0].data.text='Local input';
 await f.sync.catchUp();expect(f.native().nodes[0].data.text).toBe('Local input');expect(f.storage.isBlocked('p')).toBe(true);expect(f.transport).toHaveBeenCalledOnce();expect(f.storage.draft('p')?.nodes[0].data.text).toBe('Local input');
});

it('supplements a finite page with a coherent snapshot and never treats the page head as consumed',async()=>{
 let snapshots=0;const remote=initial();remote.nodes.push({id:'late',type:'rh-text',position:{x:10,y:0},data:{text:'Included in snapshot'}});
 const f=setup(path=>path.endsWith('/live-snapshot')?json(++snapshots===1?live(initial(),1,'9007199254740992'):live(remote,3,'9007199254740994')):json(page('9007199254740992',[event('9007199254740993')],'9007199254740994')));
 await f.sync.catchUp();await f.sync.catchUp();
 expect(f.transport.mock.calls[1][0]).toBe('/api/v2/projects/p/events?after=9007199254740992&limit=100');expect(f.sync.eventCursor).toBe('9007199254740994');expect(f.native().nodes.some(node=>node.id==='late')).toBe(true);
});

it('rejects a skipped sequence before advancing the cursor or changing the native graph',async()=>{
 const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial(),1,'0')):json(page('0',[event('2')])));await f.sync.catchUp();f.apply.mockClear();
 await expect(f.sync.catchUp()).rejects.toMatchObject({code:'CANVAS_EVENT_GAP'});expect(f.sync.eventCursor).toBe('0');expect(f.apply).not.toHaveBeenCalled();
});

it.each(['projectId','nextCursor','hasMore'])('rejects an inconsistent %s in the event page',async field=>{
 const response:any=page('0');response[field]=field==='projectId'?'other':field==='nextCursor'?'5':true;
 const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial())):json(response));await f.sync.catchUp();await expect(f.sync.catchUp()).rejects.toMatchObject({code:'INVALID_CANVAS_SYNC'});expect(f.sync.eventCursor).toBe('0');
});

it('loads remote canonical media before applying it and observes local edits made while media awaits',async()=>{
 const asset=deferred<Response>(),started=deferred<void>(),remote=initial();remote.nodes.push({id:'image',type:'rh-image',position:{x:50,y:0},data:{sourceObjects:['rhtv-asset:ast_1']}});
 const f=setup(path=>{if(path.endsWith('/live-snapshot'))return json(live(remote,2,'1'));started.resolve();return asset.promise;});
 const catchup=f.sync.catchUp();await started.promise;expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();f.native().nodes[0].data.text='Input during media load';asset.resolve(json({assets:[{id:'ast_1',state:'READY',downloadUrl:'https://studio.invalid/storage/ast_1'}]}));await catchup;
 expect(f.native().nodes[1].data.sourceObjects).toEqual(['https://studio.invalid/storage/ast_1']);expect(f.native().nodes[0].data.text).toBe('Input during media load');expect(f.storage.encodeAsset('https://studio.invalid/storage/ast_1')).toBe('rhtv-asset:ast_1');
});

it('does not apply or repopulate an old account asset returned after clear',async()=>{
 const asset=deferred<Response>(),started=deferred<void>(),remote=initial();remote.nodes[0].data.sourceObjects=['rhtv-asset:old'];
 const f=setup(path=>{if(path.endsWith('/live-snapshot'))return json(live(remote,2,'1'));started.resolve();return asset.promise;});const catchup=f.sync.catchUp(),rejected=expect(catchup).rejects.toMatchObject({code:'SESSION_CHANGED'});await started.promise;f.storage.clear();f.setCurrent(false);asset.resolve(json({id:'old',state:'READY',downloadUrl:'https://studio.invalid/old'}));await rejected;
 expect(f.storage.assets.size).toBe(0);expect(f.storage.snapshots.size).toBe(0);expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();
});

it('retains the previous base and cursor when a media lookup fails',async()=>{
 const remote=initial();remote.nodes[0].data.sourceObjects=['rhtv-asset:deleted'];const f=setup(path=>path.endsWith('/live-snapshot')?json(live(remote,2,'1')):json({code:'ASSET_NOT_FOUND'},404));await expect(f.sync.catchUp()).rejects.toMatchObject({status:404});expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();expect(f.storage.etags.get('p')).toBe('"1"');
});

it('does not recreate a deleted project from a live snapshot that returns late',async()=>{
 const response=deferred<Response>(),started=deferred<void>();const f=setup((path,options)=>{if(options.method==='DELETE')return json({});started.resolve();return response.promise;});
 const loading=f.sync.catchUp(),rejected=expect(loading).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});await started.promise;await f.storage.delete('p');response.resolve(json(live(initial(),2,'1')));await rejected;
 expect(f.storage.projects.size).toBe(0);expect(f.storage.snapshots.size).toBe(0);expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBeNull();
});

it('applies split UTF-8 SSE frames with exact ids and keeps listening until the page leaves',async()=>{
 const remote=initial();remote.nodes[0].data.title='远端';let snapshots=0;const cancel=vi.fn(),frame=`: heartbeat\n\nid: 9007199254740993\nevent: canvas.invalidated\ndata: ${JSON.stringify(event('9007199254740993'))}\n\n`,bytes=new TextEncoder().encode(frame);
 const f=setup((path,options)=>path.endsWith('/live-snapshot')?json(++snapshots===1?live(initial(),1,'9007199254740992'):live(remote,2,'9007199254740993')):new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,17));controller.enqueue(bytes.slice(17));},cancel}),{headers:{'Content-Type':'text/event-stream'}}));
 await f.sync.catchUp();const stream=(f.sync as any).stream();await vi.waitFor(()=>expect(f.sync.eventCursor).toBe('9007199254740993'));expect(f.native().nodes[0].data.title).toBe('远端');expect(cancel).not.toHaveBeenCalled();const ended=expect(stream).rejects.toMatchObject({name:'AbortError'});f.sync.stop();await ended;expect(cancel).toHaveBeenCalledOnce();const request=f.transport.mock.calls[1][1];expect(request.headers.get('Authorization')).toBe('Bearer fixture-owner');expect(request.headers.get('Accept')).toBe('text/event-stream');expect(f.transport.mock.calls[1][0]).not.toContain('fixture-owner');
});

it('ignores duplicate delivered sequences and reports a mismatched SSE id without acknowledgement',async()=>{
 const frame=`id: 7\nevent: canvas.invalidated\ndata: ${JSON.stringify(event('6'))}\n\n`;
 const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial(),1,'5')):new Response(frame,{headers:{'Content-Type':'text/event-stream'}}));await f.sync.catchUp();await expect((f.sync as any).stream()).rejects.toMatchObject({code:'INVALID_CANVAS_SYNC'});expect(f.sync.eventCursor).toBe('5');
});

it('stops and cancels a reader after attachment change even when rawV2 headers have already returned',async()=>{
 const cancel=vi.fn();let controller!:ReadableStreamDefaultController;const stream=new ReadableStream({start(value){controller=value;},cancel});
 const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial())):new Response(stream,{headers:{'Content-Type':'text/event-stream'}}));await f.sync.catchUp();f.apply.mockClear();const reading=(f.sync as any).stream(),rejected=expect(reading).rejects.toMatchObject({name:'AbortError'});await vi.waitFor(()=>expect(stream.locked).toBe(true));f.setCurrent(false);f.sync.stop();await rejected;expect(cancel).toHaveBeenCalledOnce();expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBe('0');
});

it('reports stream.error 503 without turning it into canvas data or a consumed cursor',async()=>{
 const control='event: stream.error\ndata: '+JSON.stringify({status:503,code:'PROJECT_EVENTS_UNAVAILABLE',message:'Temporary',retryable:true})+'\n\n';const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial())):new Response(control,{headers:{'Content-Type':'text/event-stream'}}));await f.sync.catchUp();f.apply.mockClear();await expect((f.sync as any).stream()).rejects.toMatchObject({status:503,code:'PROJECT_EVENTS_UNAVAILABLE'});expect(f.apply).not.toHaveBeenCalled();expect(f.sync.eventCursor).toBe('0');
});

it('backs off repeated stream failures even while finite supplement requests succeed',async()=>{
 vi.useFakeTimers();const control='event: stream.error\ndata: '+JSON.stringify({status:503,code:'PROJECT_EVENTS_UNAVAILABLE',message:'Temporary',retryable:true})+'\n\n';let streams=0;
 const f=setup((path,options)=>{if(path.endsWith('/live-snapshot'))return json(live(initial()));if(options.headers.get('Accept')==='text/event-stream'){streams++;return new Response(control,{headers:{'Content-Type':'text/event-stream'}});}return json(page('0'));});
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(6999);expect(streams).toBe(3);expect(f.error).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1);expect(streams).toBe(4);f.sync.stop();await running;expect(f.sync.eventCursor).toBe('0');
});

it('uses the unified refresh after a stream auth expiry and stops on a revoked project',async()=>{
 vi.useFakeTimers();let streams=0;const control='event: stream.error\ndata: '+JSON.stringify({status:401,code:'TOKEN_EXPIRED',message:'Expired',retryable:false})+'\n\n';
 const f=setup((path,options)=>{
  if(path.endsWith('/live-snapshot'))return json(live(initial()));
  if(options.headers.get('Accept')==='text/event-stream'){streams++;return new Response(control,{headers:{'Content-Type':'text/event-stream'}});}
  if(streams===0)return json(page('0'));if(options.headers.get('Authorization')==='Bearer fixture-owner')return json({code:'TOKEN_EXPIRED'},401);return json({code:'FORBIDDEN'},403);
 });const refresh=vi.fn(async()=>{f.api.setAccessToken('refreshed-owner');return true;});f.api.onRefresh(refresh);const running=f.sync.start();await vi.advanceTimersByTimeAsync(1000);await running;expect(refresh).toHaveBeenCalledOnce();expect(f.sync.eventCursor).toBe('0');expect(f.error).toHaveBeenLastCalledWith(expect.objectContaining({status:403}));
});

it('rejoins streaming after a refresh temporarily occupied its slot rather than staying in slow polling',async()=>{
 vi.useFakeTimers();let streams=0;const pending=new ReadableStream({start(){}});
 const f=setup((path,options)=>{if(path.endsWith('/live-snapshot'))return json(live(initial()));if(new Headers(options.headers).get('Accept')==='text/event-stream'){streams++;return streams===1?json({code:'EVENT_STREAM_LIMIT',message:'old page draining'},429):new Response(pending,{headers:{'Content-Type':'text/event-stream'}});}return json(page('0'));});
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(1999);expect(streams).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(streams).toBe(2);expect((f.sync as any).sse).toBe(true);expect(f.error).not.toHaveBeenCalled();f.sync.stop();await running;
});
it('backs off repeated stream quota probes while continuing one-second finite catch-up',async()=>{
 vi.useFakeTimers();let streams=0,polls=0;const f=setup((path,options)=>{if(path.endsWith('/live-snapshot'))return json(live(initial()));if(new Headers(options.headers).get('Accept')==='text/event-stream'){streams++;return json({code:'EVENT_STREAM_LIMIT',message:'two active pages'},429);}polls++;return json(page('0'));});
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(13999);expect(streams).toBe(3);expect(polls).toBeGreaterThan(10);await vi.advanceTimersByTimeAsync(1);expect(streams).toBe(4);expect(f.error).not.toHaveBeenCalled();f.sync.stop();await running;
});
it.each([406,415])('clears an expired quota probe when transport subsequently rejects SSE with %s',async status=>{
 vi.useFakeTimers();let streams=0,polls=0;const f=setup((path,options)=>{if(path.endsWith('/live-snapshot'))return json(live(initial()));if(new Headers(options.headers).get('Accept')==='text/event-stream'){streams++;return json({code:streams===1?'EVENT_STREAM_LIMIT':'TRANSPORT_UNAVAILABLE',message:'use finite pages'},streams===1?429:status);}polls++;return json(page('0'));});
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(6000);expect(streams).toBe(2);expect(polls).toBeGreaterThanOrEqual(5);expect(polls).toBeLessThanOrEqual(8);expect((f.sync as any).sse).toBe(false);expect((f.sync as any).quotaRetryAt).toBeUndefined();f.sync.stop();await running;
});

it('quietly recovers on the same stream when one snapshot is an HTML proxy refusal',async()=>{
 vi.useFakeTimers();let reads=0;
 const f=setup((path,options)=>{
  if(path.endsWith('/live-snapshot'))return ++reads===1?new Response('<html>gateway</html>',{status:403}):json(live(initial()));
  if(new Headers(options.headers).get('Accept')==='text/event-stream')return new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}});
  return json(page('0'));
 });
 const running=f.sync.start();await vi.advanceTimersByTimeAsync(1000);
 expect(reads).toBe(2);expect(f.sync.eventCursor).toBe('0');expect(f.apply).toHaveBeenCalledOnce();expect(f.error).not.toHaveBeenCalled();
 f.sync.stop();await running;
});

it('negotiates the bidirectional room, renders before opening another HTTP request and resumes SSE at the last applied cursor',async()=>{
 vi.useFakeTimers();
 const remote=initial();remote.nodes[0].position={x:55,y:67};
 const packet={...live(remote,2,'1'),kind:'DELTA',fromRevision:1,delta:{upsertNodes:[],removeNodeIds:[],upsertEdges:[],removeEdgeIds:[],positions:[{id:'n',x:55,y:67}]}};
 delete (packet as any).graph;
 const f=setup((path,options)=>{
  if(path.endsWith('/live-snapshot')){
   const snapshot=json(live(initial()));
   snapshot.headers.set('X-STUDIO-Canvas-Update','delta-v1');
   snapshot.headers.set('X-STUDIO-Canvas-Room','ws-v1');
   return snapshot;
  }
  expect(options.headers.get('Accept')).toBe('text/event-stream');
  expect(new URL(path,'https://test').searchParams.get('after')).toBe('1');
  return new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}});
 });
 const dropped=deferred<never>();
 const room={next:vi.fn().mockResolvedValueOnce({type:'ready'}).mockResolvedValueOnce({type:'event',value:{event:'canvas.delta',id:'1',data:packet}}).mockImplementation(()=>dropped.promise),close:vi.fn()};
 const opening=vi.spyOn(f.api,'openCanvasRoom').mockReturnValue(room as any);
 const running=f.sync.start();
 try{
  await vi.advanceTimersByTimeAsync(0);
  expect(opening).toHaveBeenCalledWith('p','0',expect.any(AbortSignal));
  expect(f.native().nodes[0].position).toEqual({x:55,y:67});
  expect(f.transport).toHaveBeenCalledOnce();
  dropped.resolve(Promise.reject(new TypeError('Dropped room')) as never);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect(f.sync.eventCursor).toBe('1');
  expect(f.error).not.toHaveBeenCalled();
 }finally{f.sync.stop();await running;}
});

it('rejoins a recovered WebSocket even when the proxy permanently refuses HTTP streaming',async()=>{
 vi.useFakeTimers();
 const f=setup((path,opts)=>{
  if(path.endsWith('live-snapshot')){const r=json(live(initial()));r.headers.set('X-STUDIO-Canvas-Update','delta-v1');r.headers.set('X-STUDIO-Canvas-Room','ws-v1');return r;}
  if(opts.headers.get('Accept')==='text/event-stream')return json({code:'NOT_ACCEPTABLE'},406);
  return json(page('0'));
 });
 const closed=new TypeError('Upgrade temporarily unavailable');
 const broken={next:()=>Promise.reject(closed),close:vi.fn()};
 const active={next:vi.fn(),close:vi.fn()};
 const connect=vi.spyOn(f.api,'openCanvasRoom').mockImplementationOnce(()=>broken as any).mockImplementation((_id,_cursor,signal)=>{
  active.next.mockImplementationOnce(async()=>({type:'ready'})).mockImplementation(()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  return active as any;
 });
 const running=f.sync.start();
 try{
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2500);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(active.next).toHaveBeenCalledTimes(2);
  expect(f.error).not.toHaveBeenCalled();
 }finally{f.sync.stop();await running;}
});

it.each(['idle','interleaved-edit','deferred-view'] as const)('preserves live editing when applying a prepared move to an %s canvas',async mode=>{
 const f=setup(()=>json(live(initial())));
 await f.sync.catchUp();
 f.storage.enableCanvasOperations('p',{userId:'owner',clientId:'page',ensure:async()=>{}},f.native());
 (f.storage as any).canvasMediaScopes.set('p','a'.repeat(32));
 const remote=initial();remote.nodes[0].position={x:89,y:13};
 const fullMerge=vi.spyOn(f.storage,'mergedNativeView');
 if(mode==='interleaved-edit'){
  const accept=f.storage.acceptRemoteSnapshot.bind(f.storage);
  vi.spyOn(f.storage,'acceptRemoteSnapshot').mockImplementation((...args)=>{
   const merged=accept(...args);
   f.native().nodes[0].data.text='typed in current page';
   return merged;
  });
 }
 if(mode==='deferred-view')f.setCanApply(false);
 const moved=await (f.sync as any).snapshot({data:live(remote,2,'1'),etag:'"2"'},true);
 if(mode==='deferred-view'){
  expect(moved).toBe(false);expect(f.sync.eventCursor).toBe('0');
  f.native().nodes[0].data.text='typed in current page';f.setCanApply(true);
  expect(await f.sync.catchUp()).toBe(true);
 }else expect(moved).toBe(true);
 expect(f.sync.eventCursor).toBe('1');expect(f.native().nodes[0].position).toEqual({x:89,y:13});
 if(mode==='idle')expect(fullMerge).not.toHaveBeenCalled();
 else {expect(fullMerge).toHaveBeenCalled();expect(f.native().nodes[0].data.text).toBe('typed in current page');expect(f.storage.hasDraft('p')).toBe(true);}
});

it('recovers a silent fallback stream without offline events and keeps pending edits and the applied cursor',async()=>{
 vi.useFakeTimers();let streamReads=0,head=0;const canceled=vi.fn(),remote=initial();remote.nodes[0].data.title='After silence';
 const f=setup((path,opts)=>{
  if(path.endsWith('/live-snapshot'))return json(live(head?remote:initial(),head+1,String(head)));
  if(opts.headers.get('Accept')==='text/event-stream'){
   streamReads++;
   return new Response(new ReadableStream({start(c){if(streamReads===1)c.enqueue(new TextEncoder().encode('id: 1\nevent: canvas.delta\ndata: {'));},cancel:canceled}),{headers:{'Content-Type':'text/event-stream'}});
  }
  return json(page('0',head?[event('1')]:[]));
 });
 const run=f.sync.start();try{
  await vi.advanceTimersByTimeAsync(0);expect(streamReads).toBe(1);
  f.native().nodes[0].position.x=77;f.storage.captureDraft('p',f.native());head=1;
  await vi.advanceTimersByTimeAsync(24999);expect(f.sync.eventCursor).toBe('0');expect(canceled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(101);expect(canceled).toHaveBeenCalledOnce();expect(streamReads).toBe(2);
  expect(f.sync.eventCursor).toBe('1');expect(f.native().nodes[0]).toMatchObject({position:{x:77},data:{title:'After silence'}});expect(f.error).not.toHaveBeenCalled();
 }finally{f.sync.stop();await run;}
});

it('keeps a healthy quiet SSE stream alive with comment heartbeats and cancels its timers on stop',async()=>{
 vi.useFakeTimers();let writer!:ReadableStreamDefaultController;const canceled=vi.fn();
 const f=setup(path=>path.endsWith('/live-snapshot')?json(live(initial())):new Response(new ReadableStream({start(c){writer=c;},cancel:canceled}),{headers:{'Content-Type':'text/event-stream'}}));
 const run=f.sync.start();await vi.advanceTimersByTimeAsync(0);
 for(let i=0;i<6;i++){await vi.advanceTimersByTimeAsync(10000);writer.enqueue(new TextEncoder().encode(': heartbeat\n\n'));await vi.advanceTimersByTimeAsync(0);}
 expect(canceled).not.toHaveBeenCalled();expect(f.transport).toHaveBeenCalledTimes(2);expect(f.sync.eventCursor).toBe('0');
 f.sync.stop();await run;await vi.advanceTimersByTimeAsync(60000);expect(canceled).toHaveBeenCalledOnce();expect(f.transport).toHaveBeenCalledTimes(2);
});

it.each(['snapshot','event-page','stream-headers'] as const)('bounds a stalled %s request and quietly resumes its confirmed state',async blocked=>{
 vi.useFakeTimers();let hung=false;let aborted=0;
 const f=setup((path,opts)=>{
  const snapshot=path.endsWith('/live-snapshot'),sse=opts.headers.get('Accept')==='text/event-stream';
  const stall=blocked==='snapshot'?snapshot:blocked==='event-page'?!snapshot&&!sse:sse;
  if(stall&&!hung){hung=true;return new Promise<Response>((_,reject)=>opts.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Aborted','AbortError'));},{once:true}));}
  if(snapshot)return json(live(initial()));
  if(sse)return new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}});
  return json(page('0'));
 });
 if(blocked==='event-page')await f.sync.catchUp();
 const run=f.sync.start();try{
  await vi.advanceTimersByTimeAsync(14999);expect(aborted).toBe(0);
  await vi.advanceTimersByTimeAsync(1001);expect(aborted).toBe(1);expect(f.sync.eventCursor).toBe('0');expect(f.error).not.toHaveBeenCalled();
  expect(f.native().nodes).toEqual(initial().nodes);expect(f.native().edges).toEqual([]);
 }finally{f.sync.stop();await run;}
});

it('bounds an HTTP streaming error body which stalls after its headers',async()=>{
 vi.useFakeTimers();const canceled=vi.fn();let reads=0;
 const f=setup((path,opts)=>{
  if(path.endsWith('/live-snapshot'))return json(live(initial()));
  if(opts.headers.get('Accept')==='text/event-stream'){
   if(++reads===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"code":'));},cancel:canceled}),{status:503,headers:{'Content-Type':'application/json'}});
   return new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}});
  }
  return json(page('0'));
 });
 const run=f.sync.start();try{
  await vi.advanceTimersByTimeAsync(14999);expect(canceled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1001);expect(canceled).toHaveBeenCalledOnce();expect(reads).toBe(2);expect(f.sync.eventCursor).toBe('0');expect(f.error).not.toHaveBeenCalled();
 }finally{f.sync.stop();await run;}
});

it('allows a large snapshot that keeps making progress past the idle deadline',async()=>{
 vi.useFakeTimers();const full=JSON.stringify({code:0,data:live(initial())});let writer!:ReadableStreamDefaultController;
 const f=setup(path=>path.endsWith('/live-snapshot')?new Response(new ReadableStream({start(c){writer=c;}}),{headers:{'Content-Type':'application/json'}}):new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}}));
 const run=f.sync.start();try{
  await vi.advanceTimersByTimeAsync(0);
  for(const part of [full.slice(0,10),full.slice(10,30),full.slice(30)]){await vi.advanceTimersByTimeAsync(10000);writer.enqueue(new TextEncoder().encode(part));await vi.advanceTimersByTimeAsync(0);}
  writer.close();await vi.advanceTimersByTimeAsync(0);
  expect(f.sync.eventCursor).toBe('0');expect(f.native().nodes).toEqual(initial().nodes);expect(f.error).not.toHaveBeenCalled();expect(f.transport).toHaveBeenCalledTimes(2);
 }finally{f.sync.stop();await run;}
});
