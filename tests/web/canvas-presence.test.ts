import {afterEach,expect,it,vi} from 'vitest';
import {CanvasPresenceClient,presencePeople,validatePresenceSnapshot,type CanvasPresenceSnapshot} from '../../apps/web/src/service/canvas-presence';
import {ApiError} from '../../apps/web/src/api/client';

const clients:CanvasPresenceClient[]=[];
afterEach(()=>{for(const client of clients)client.stop();clients.length=0;vi.useRealTimers();});
function fixture(sameIdentity?:()=>boolean,clock?:()=>number){
 let time=Date.parse('2026-11-02T10:00:00Z'),current=true,sequence=0,leases:CanvasPresenceSnapshot['leases']=[],stream:ReadableStreamDefaultController<Uint8Array>|undefined;
 const now=()=>clock?.()??time;
 const request=vi.fn(async(path:string,options:any)=>{
  if(path.endsWith('/node-leases')){const ids=options.body.nodeIds as string[];if(options.method==='DELETE')leases=leases.filter(lease=>!ids.includes(lease.nodeId));else for(const nodeId of ids)if(!leases.some(lease=>lease.nodeId===nodeId))leases.push({nodeId,clientId:client.clientId,userId:'user',displayName:'测试成员',expiresAt:new Date(now()+15000).toISOString()});}
  return{data:snapshot(),status:200,etag:null};
 });
 const api:any={requestV2:request,rawV2:vi.fn(async()=>new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'Content-Type':'text/event-stream'}})),reportV2Failure:vi.fn()};
 const client=new CanvasPresenceClient(api,'project','user',()=>true,()=>current,now,sameIdentity);clients.push(client);
 const snapshot=(patch:Partial<CanvasPresenceSnapshot>={}):CanvasPresenceSnapshot=>({schemaVersion:'1',projectId:'project',epoch:'boot1',sequence:String(++sequence),serverTime:new Date(now()).toISOString(),presenceTtlMs:20000,leaseTtlMs:15000,members:[{clientId:client.clientId,userId:'user',displayName:'测试成员',role:'EDITOR',cursor:null,selectedNodeIds:[],lastSeenAt:new Date(now()).toISOString()}],leases:structuredClone(leases),...patch});
 const emit=(value:CanvasPresenceSnapshot)=>stream!.enqueue(new TextEncoder().encode('event: presence.snapshot\ndata: '+JSON.stringify(value)+'\n\n'));
 return{client,api,request,snapshot,emit,advance:(ms:number)=>time+=ms,clearIdentity:()=>current=false,setLeases:(value:typeof leases)=>leases=value};
}
it('joins before acquiring and sends only transient cursor, selection and client identity',async()=>{
 const f=fixture();await f.client.start();await f.client.acquire(['node']);
 expect(f.request.mock.calls[0]).toMatchObject(['/projects/project/presence',{body:{clientId:f.client.clientId,cursor:null,selectedNodeIds:[]}}]);expect(f.client.owns(['node'])).toBe(true);
 const body=JSON.stringify(f.request.mock.calls.map(([,options])=>options.body));expect(body).not.toMatch(/prompt|graph|accessToken|displayName/);
 await f.client.release(['node']);expect(f.client.owns(['node'])).toBe(false);
});
it('does not let a delayed HTTP snapshot rewind newer stream state or extend expired leases',async()=>{
 const f=fixture();await f.client.start();await f.client.acquire(['node']);const older=f.snapshot({sequence:'1'});
 f.emit(f.snapshot({sequence:'50',leases:[]}));await vi.waitFor(()=>expect(f.client.state().snapshot?.sequence).toBe('50'));
 (f.client as any).accept(older);expect(f.client.owns(['node'])).toBe(false);expect(f.client.state().snapshot?.sequence).toBe('50');
});
it('accepts a new server epoch and ignores late responses from the replaced server',async()=>{
 const f=fixture();await f.client.start();f.emit(f.snapshot({epoch:'boot2',sequence:'1'}));await vi.waitFor(()=>expect(f.client.state().snapshot?.epoch).toBe('boot2'));
 f.emit(f.snapshot({epoch:'boot1',sequence:'999'}));await new Promise(resolve=>setTimeout(resolve,0));expect(f.client.state().snapshot?.epoch).toBe('boot2');
});
it('expires ownership from server facts even when the local wall clock has a different origin',async()=>{
 const f=fixture();await f.client.start();await f.client.acquire(['node']);expect(f.client.owns(['node'])).toBe(true);f.advance(15001);expect(f.client.owns(['node'])).toBe(false);expect(f.client.holder('node')).toBeUndefined();
});
it('never extends a lease by the time spent waiting for a slow response',async()=>{
 const f=fixture();await f.client.start();const base=f.request.getMockImplementation()!;f.request.mockImplementation(async(path,options)=>{const result=await base(path,options);if(path.endsWith('/node-leases')&&options.method==='POST')f.advance(16000);return result;});
 await expect(f.client.acquire(['node'])).rejects.toMatchObject({code:'NODE_LEASE_EXPIRED'});expect(f.client.owns(['node'])).toBe(false);
});
it('rejects another verified user as an owner even if the client identifier matches',async()=>{
 const f=fixture();await f.client.start();f.emit(f.snapshot({leases:[{nodeId:'node',clientId:f.client.clientId,userId:'other',displayName:'同事',expiresAt:'2026-11-02T10:00:15Z'}]}));await vi.waitFor(()=>expect(f.client.holder('node')?.userId).toBe('other'));expect(f.client.owns(['node'])).toBe(false);
});
it('releases only newly acquired chunks when a later chunk is occupied',async()=>{
 const f=fixture();await f.client.start();await f.client.acquire(['existing']);const base=f.request.getMockImplementation()!;let acquisitions=0;
 f.request.mockImplementation(async(path,options)=>{if(path.endsWith('/node-leases')&&options.method==='POST'&&++acquisitions===2)throw new ApiError(409,'NODE_EDIT_OCCUPIED','同事正在编辑。');return base(path,options);});
 const ids=Array.from({length:40},(_,i)=>'node-'+i);await expect(f.client.acquire(ids)).rejects.toMatchObject({code:'NODE_EDIT_OCCUPIED'});expect(f.client.owns(['existing'])).toBe(true);expect(f.client.owns([ids[0]])).toBe(false);
});
it('coalesces pointer updates and never sends more than one outstanding heartbeat',async()=>{
 vi.useFakeTimers();const f=fixture();await f.client.start();for(let i=0;i<30;i++)f.client.setCursor({x:i,y:-i});
 await vi.advanceTimersByTimeAsync(120);expect(f.request).toHaveBeenCalledTimes(2);expect(f.request.mock.calls.at(-1)![1].body.cursor).toEqual({x:29,y:-29});
});
it('fences delayed replies after identity or project attachment changes',async()=>{
 const f=fixture();await f.client.start();f.clearIdentity();await expect(f.client.acquire(['node'])).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});expect(f.client.owns(['node'])).toBe(false);
});
it('validates hostile, unbounded and malformed awareness before rendering it',()=>{
 const f=fixture(),valid=f.snapshot();expect(()=>validatePresenceSnapshot(valid,'project')).not.toThrow();
 for(const patch of [{projectId:'other'},{sequence:'-1'},{members:[{...valid.members[0],cursor:{x:Infinity,y:0}}]},{leases:[{nodeId:'node',clientId:'page',userId:'other',displayName:'同事',expiresAt:'invalid'}]},{members:Array(65).fill(valid.members[0])}])expect(()=>validatePresenceSnapshot({...valid,...patch},'project')).toThrowError(expect.objectContaining({code:'INVALID_CANVAS_PRESENCE'}));
});

it('falls back to bounded JSON polling when the stream quota is full',async()=>{
 const f=fixture();f.api.rawV2.mockRejectedValueOnce(new ApiError(429,'PRESENCE_STREAM_LIMIT','stream quota'));
 await f.client.start();await vi.waitFor(()=>expect(f.request.mock.calls.some(([path,options])=>path.includes('/presence?')&&!options.method)).toBe(true));
 expect(f.client.state().status).toBe('connected');await f.client.acquire(['node']);expect(f.client.owns(['node'])).toBe(true);expect(f.api.rawV2).toHaveBeenCalledTimes(1);
});
it.each(['PRESENCE_STREAM_LIMIT','EVENT_STREAM_LIMIT'])('returns to realtime presence after a temporary %s while keeping heartbeats available',async code=>{
 vi.useFakeTimers();const f=fixture(undefined,()=>Date.now());f.api.rawV2.mockRejectedValueOnce(new ApiError(429,code,'temporary stream quota'));await f.client.start();await vi.advanceTimersByTimeAsync(0);
 expect(f.request.mock.calls.filter(([path])=>path.includes('/presence?'))).toHaveLength(1);await vi.advanceTimersByTimeAsync(1999);expect(f.api.rawV2).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(f.api.rawV2).toHaveBeenCalledTimes(2);
 const polls=f.request.mock.calls.filter(([path])=>path.includes('/presence?')).length;await vi.advanceTimersByTimeAsync(3000);expect(f.request.mock.calls.filter(([path])=>path.includes('/presence?'))).toHaveLength(polls);expect(f.request.mock.calls.filter(([path,options])=>path.endsWith('/presence')&&options.method==='POST')).toHaveLength(2);expect(f.api.reportV2Failure).not.toHaveBeenCalled();
});
it('backs off presence quota probes at two, four, eight, sixteen and at most thirty seconds while polling once a second',async()=>{
 vi.useFakeTimers();const f=fixture(undefined,()=>Date.now()),start=Date.now(),probes:number[]=[];f.api.rawV2.mockImplementation(async()=>{probes.push(Date.now()-start);throw new ApiError(429,'PRESENCE_STREAM_LIMIT','active pages');});await f.client.start();
 await vi.advanceTimersByTimeAsync(89999);expect(probes).toEqual([0,2000,6000,14000,30000,60000]);await vi.advanceTimersByTimeAsync(1);expect(probes).toEqual([0,2000,6000,14000,30000,60000,90000]);expect(f.request.mock.calls.filter(([path])=>path.includes('/presence?')).length).toBeGreaterThanOrEqual(90);expect(f.client.state().status).toBe('connected');expect(f.api.reportV2Failure).not.toHaveBeenCalled();
});
it.each([[406,'STREAM_UNSUPPORTED'],[415,'STREAM_UNSUPPORTED'],[501,'PRESENCE_STREAM_TRANSPORT_UNAVAILABLE'],[501,'PRESENCE_STREAM_AUTH_UNAVAILABLE']] as const)('stays in finite polling after a quota probe becomes permanently unsupported (%s %s)',async(status,code)=>{
 vi.useFakeTimers();const f=fixture(undefined,()=>Date.now());f.api.rawV2.mockRejectedValueOnce(new ApiError(429,'PRESENCE_STREAM_LIMIT','temporary stream quota')).mockRejectedValue(new ApiError(status,code,'use finite polling'));await f.client.start();await vi.advanceTimersByTimeAsync(6000);
 expect(f.api.rawV2).toHaveBeenCalledTimes(2);const polls=f.request.mock.calls.filter(([path])=>path.includes('/presence?')).length;expect(polls).toBeGreaterThanOrEqual(6);expect(polls).toBeLessThanOrEqual(8);expect(f.client.state().status).toBe('connected');expect(f.api.reportV2Failure).not.toHaveBeenCalled();
});
it('resets the quota backoff after a successful presence stream rotation',async()=>{
 vi.useFakeTimers();const f=fixture(undefined,()=>Date.now());f.api.rawV2.mockRejectedValueOnce(new ApiError(429,'PRESENCE_STREAM_LIMIT','temporary stream quota')).mockResolvedValueOnce(new Response('',{headers:{'Content-Type':'text/event-stream'}})).mockRejectedValueOnce(new ApiError(429,'PRESENCE_STREAM_LIMIT','slot briefly occupied'));
 await f.client.start();await vi.advanceTimersByTimeAsync(4099);expect(f.api.rawV2).toHaveBeenCalledTimes(3);await vi.advanceTimersByTimeAsync(1);expect(f.api.rawV2).toHaveBeenCalledTimes(4);expect(f.api.reportV2Failure).not.toHaveBeenCalled();
});
it('clears all peer and lease state after live authorization is revoked',async()=>{
 const f=fixture();f.api.rawV2.mockRejectedValueOnce(new ApiError(403,'PROJECT_ACCESS_DENIED','access revoked'));await f.client.start();await vi.waitFor(()=>expect(f.client.state().snapshot).toBeNull());expect(f.client.owns(['node'])).toBe(false);expect(f.api.reportV2Failure).toHaveBeenCalled();
});

it('leaves the original page once after its route detached while the verified auth user is unchanged',async()=>{
 const f=fixture(()=>true);await f.client.start();const clientId=f.client.clientId;f.clearIdentity();f.client.stop();f.client.stop();
 expect(f.request.mock.calls.filter(([path])=>path.includes('/presence/'))).toEqual([['/projects/project/presence/'+clientId,{method:'DELETE',keepalive:true}]]);expect(f.client.state()).toEqual({status:'offline',snapshot:null});expect(f.api.rawV2.mock.calls[0][1].signal.aborted).toBe(true);
});
it('never sends a previous user leave after auth identity changes, or releases protected pending leases',async()=>{
 let same=true;const f=fixture(()=>same);await f.client.start();await f.client.acquire(['node']);same=false;f.client.stop();expect(f.request.mock.calls.some(([path])=>path.includes('/presence/'))).toBe(false);
 const pending=fixture(()=>true);await pending.client.start();await pending.client.acquire(['node']);pending.client.stop({release:false});expect(pending.snapshot().leases).toHaveLength(1);expect(pending.request.mock.calls.some(([path])=>path.includes('/presence/'))).toBe(false);expect(pending.client.owns(['node'])).toBe(false);
});
it('keeps separate page identifiers instead of sharing another live page ownership',()=>{
 const first=fixture(),second=fixture();expect(first.client.clientId).not.toBe(second.client.clientId);
});
it('counts verified people once while retaining their independent pages and editing activity',()=>{
 const f=fixture(),own=f.snapshot().members[0],members=[own,{...own,clientId:'own-other-page',cursor:{x:40,y:50}},{...own,userId:'peer',clientId:'peer-one',displayName:'同事'},{...own,userId:'peer',clientId:'peer-two',displayName:'同事'}],lease={nodeId:'node',clientId:'own-other-page',userId:'user',displayName:'测试成员',expiresAt:'2026-11-02T10:00:15Z'},before=structuredClone(members),people=presencePeople(members,[lease],'user',f.client.clientId);
 expect(people).toHaveLength(2);expect(people.find(person=>person.isYou)).toMatchObject({hasCurrentPage:true,editing:true,pages:expect.any(Array)});expect(people.find(person=>person.isYou)!.pages).toHaveLength(2);expect(members).toEqual(before);
});

it('captures its first acknowledged join in server time and does not move the baseline on later heartbeats',async()=>{
 const f=fixture();expect(f.client.joinedAt).toBeUndefined();await f.client.start();const baseline=f.client.joinedAt;expect(baseline).toBe(Date.parse('2026-11-02T10:00:00Z'));f.advance(5000);await(f.client as any).post(true);expect(f.client.joinedAt).toBe(baseline);
});
