import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {CanvasHandoffSession,type HandoffHooks} from '../../apps/web/src/service/canvas-handoff';

const protocol='account-pages-v1';
type Peer={actor:string;term:string;ready:boolean;drained:boolean};
class AccountServer {
 revision=1;sequence=0;group?:string;request?:{id:string;actor:string;to:string;approved:boolean};
 peers=new Map<string,Peer>();requests:{actor:string;client:string;method:string;route:string;decision?:string;protocol:string}[]=[];
 grant(actor:string,client:string){this.group=actor;const p={actor,term:'lease_'+(++this.sequence),ready:false,drained:false};this.peers.set(client,p);return p;}
 status(actor:string,client:string){
  const mine=this.peers.get(client),incoming=this.request&&this.group===actor?[{requestId:this.request.id,userId:this.request.actor,displayName:this.request.actor,sameAccount:false,expiresAt:new Date(Date.now()+30000).toISOString(),drainRequired:this.request.approved}]:[];
  const common={projectId:'p',protocol,incoming,outgoing:this.request?.to===client?{requestId:this.request.id,state:'PENDING',sameAccount:false}:undefined};
  if(mine?.drained)return{...common,state:'OCCUPIED',accountHandoff:true};
  if(mine)return{...common,state:mine.ready?'HELD':'SYNC_REQUIRED',leaseId:mine.term,accountHandoff:this.request?.approved===true};
  if(!this.group||this.group===actor&&!this.request?.approved)return{...common,state:'FREE',canJoin:this.group===actor};
  return{...common,state:'OCCUPIED',holder:{userId:this.group,displayName:this.group},accountHandoff:this.group===actor&&this.request?.approved===true};
 }
 async handle(actor:string,path:string,o:any){
  const client=o.headers['X-STUDIO-Canvas-Session'],method=o.method??'GET',route=path.replace('/projects/p/edit-session',''),b=o.body;
  this.requests.push({actor,client,method,route,decision:b?.decision,protocol:o.headers['X-STUDIO-Canvas-Protocol']});
  const ok=(data:any)=>({data}),status=()=>this.status(actor,client);if(method==='GET')return ok(status());
  if(!route&&method==='DELETE'){const old=this.peers.get(client);if(old?.term===b.leaseId)this.peers.delete(client);return ok({released:true});}
  if(route==='/requests'){if(!this.request)this.request={id:b.requestId,actor,to:client,approved:false};return ok(status());}
  if(route.endsWith('/decision')){
   const mine=this.peers.get(client);if(!this.request||!mine||b.leaseId!==mine.term)throw Error('not authorized to approve');
   if(b.decision==='DECLINE'){this.request=undefined;return ok(status());}
   this.request.approved=true;mine.drained=true;
   if([...this.peers.values()].every(p=>p.drained)){const r=this.request;this.peers.clear();this.request=undefined;this.grant(r.actor,r.to);}
   return ok(status());
  }
  if(this.group&&this.group!==actor)throw new ApiError(409,'PROJECT_EDIT_OCCUPIED','occupied');
  const mine=this.peers.get(client)??this.grant(actor,client);
  if(route==='/ready'){if(b.revision!==this.revision)throw new ApiError(409,'CANVAS_SYNC_REQUIRED','stale');mine.ready=true;}
  return ok({projectId:'p',protocol,clientId:client,leaseId:mine.term,state:mine.ready?'HELD':'SYNC_REQUIRED',expiresAt:new Date(Date.now()+30000).toISOString(),ttlSeconds:30});
 }
}
const sessions:CanvasHandoffSession[]=[];
function page(s:AccountServer,actor:string,visible=true){
 const hooks={foreground:()=>visible,visible:()=>visible,beforeDrain:vi.fn(()=>true),prepare:vi.fn(async()=>{s.revision++;}),sync:vi.fn(async()=>s.revision),finish:vi.fn(async()=>{}),resume:vi.fn(async()=>'copied-old-token'),remember:vi.fn(),changed:vi.fn(),leaseChanged:vi.fn()} satisfies HandoffHooks;
 const api:any={requestV2:(path:string,o:any)=>s.handle(actor,path,o)};const c=new CanvasHandoffSession(api,'p',actor,()=>true,()=>true,()=>true,hooks);sessions.push(c);return{c,hooks};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{while(sessions.length)sessions.pop()!.stop();vi.useRealTimers();});
it('joins three documents of the same account without transferring or consuming copied reload credentials',async()=>{
 const server=new AccountServer(),a=page(server,'owner'),b=page(server,'owner'),hidden=page(server,'owner',false);
 await a.c.start();a.c.background();await Promise.all([b.c.start(),hidden.c.start()]);
 expect([a,b,hidden].map(p=>p.c.holds())).toEqual([true,true,true]);
 expect(new Set([a,b,hidden].map(p=>p.c.editTenure())).size).toBe(3);
 expect(new Set([a,b,hidden].map(p=>p.c.pageProof)).size).toBe(3);
 for(const p of [a,b,hidden]){expect(p.hooks.resume).not.toHaveBeenCalled();expect(p.hooks.prepare).not.toHaveBeenCalled();expect(p.hooks.sync).toHaveBeenCalledOnce();}
 await vi.advanceTimersByTimeAsync(12500);b.c.stop();await vi.advanceTimersByTimeAsync(2000);
 expect([a.c.holds(),hidden.c.holds()]).toEqual([true,true]);expect(server.peers.size).toBe(2);
 expect(server.requests.some(r=>r.route==='/requests')).toBe(false);expect(server.requests.every(r=>r.protocol===protocol)).toBe(true);
});
it('keeps an outsider read-only until the holder approves and every other writable page drains',async()=>{
 const s=new AccountServer(),a=page(s,'A'),b=page(s,'A'),edge=page(s,'A'),other=page(s,'B');
 await a.c.start();await b.c.start();await edge.c.start();await other.c.start();
 expect(other.c.state()).toMatchObject({status:'occupied',holder:{userId:'A'}});expect(s.request).toBeUndefined();
 await other.c.requestEdit();a.c.wake();await vi.advanceTimersByTimeAsync(10);
 expect(other.c.holds()).toBe(false);await a.c.decision('APPROVE');
 expect(a.c.holds()).toBe(false);expect(a.c.state()).toMatchObject({accountHandoff:true});
 let finish!:()=>void;b.hooks.prepare.mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;}));
 b.c.background();b.c.wake();edge.c.wake();await vi.advanceTimersByTimeAsync(10);
 expect(b.hooks.prepare).toHaveBeenCalledOnce();expect(edge.hooks.prepare).toHaveBeenCalledOnce();expect(other.c.holds()).toBe(false);
 finish();await vi.advanceTimersByTimeAsync(10);other.c.wake();await vi.advanceTimersByTimeAsync(10);
 expect(other.c.holds()).toBe(true);expect([a,b,edge].map(p=>p.c.holds())).toEqual([false,false,false]);
 expect(s.requests.filter(r=>r.decision==='APPROVE')).toHaveLength(3);
});
it('automatically rejoins an empty canvas after a business write reports that the only page expired',async()=>{
 const s=new AccountServer(),a=page(s,'A');await a.c.start();
 const term=a.c.editTenure();s.peers.clear();s.group=undefined;
 a.c.invalidate(new ApiError(409,'EDIT_SESSION_EXPIRED','old writer term'));expect(a.c.holds()).toBe(false);
 await vi.advanceTimersByTimeAsync(1600);
 expect(a.c.holds()).toBe(true);expect(a.c.editTenure()).not.toBe(term);expect(a.hooks.finish).toHaveBeenCalledTimes(2);
 expect(s.requests.filter(r=>r.route==='/requests')).toEqual([]);
});
it('keeps the confirmed lease during a failed status read or renewal timeout and retries within the original deadline',async()=>{
 const s=new AccountServer(),a=page(s,'A');await a.c.start();const term=a.c.editTenure(),handle=s.handle.bind(s);let failed=false;
 s.handle=async(actor,path,o)=>{
  if(o.method==='GET'&&!failed){failed=true;throw new TypeError('one missed poll');}
  if(o.body?.leaseId&&!path.endsWith('/ready')&&Date.now()<start+16000)return new Promise(()=>{});
  return handle(actor,path,o);
 };
 const start=Date.now();await vi.advanceTimersByTimeAsync(15500);
 expect(a.c.editTenure()).toBe(term);expect(a.hooks.finish).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(17500);
 expect(a.c.editTenure()).toBe(term);expect(a.hooks.finish).toHaveBeenCalledOnce();
});
it('fences at the last confirmed deadline and never takes the new holder’s seat after a missed heartbeat',async()=>{
 const s=new AccountServer(),a=page(s,'A');await a.c.start();const handle=s.handle.bind(s);
 s.handle=async(actor,path,o)=>{
  if(o.body?.leaseId&&!path.endsWith('/ready'))throw new TypeError('renewal unavailable');
  return handle(actor,path,o);
 };
 await vi.advanceTimersByTimeAsync(29500);expect(a.c.holds()).toBe(true);
 s.peers.clear();s.grant('B','other-device');
 await vi.advanceTimersByTimeAsync(2600);
 expect(a.c.holds()).toBe(false);expect(a.c.state()).toMatchObject({status:'occupied',holder:{userId:'B'}});
 expect(s.requests.some(r=>r.route==='/requests')).toBe(false);
});
it('uses the remaining server drain window even if the sender clock differs from PostgreSQL',async()=>{
 const s=new AccountServer(),a=page(s,'A');await a.c.start();const handle=s.handle.bind(s);
 s.handle=async(actor,path,o)=>{
  const res=await handle(actor,path,o);
  if(o.body?.leaseId&&!path.endsWith('/ready'))Object.assign(res.data,{expiresInMs:3000,expiresAt:new Date(Date.now()+3600000).toISOString()});
  return res;
 };
 await vi.advanceTimersByTimeAsync(10500);expect(a.c.holds()).toBe(true);
 s.peers.clear();s.group='B';await vi.advanceTimersByTimeAsync(3000);
 expect(a.c.holds()).toBe(false);expect(s.requests.some(r=>r.route==='/requests')).toBe(false);
});
it('immediately fences an authoritative heartbeat whose remaining drain time elapsed in transit',async()=>{
 const s=new AccountServer(),a=page(s,'A');await a.c.start();const handle=s.handle.bind(s);
 s.handle=async(actor,path,o)=>{
  const res=await handle(actor,path,o);
  if(o.body?.leaseId&&!path.endsWith('/ready'))Object.assign(res.data,{expiresInMs:60});
  return res;
 };
 await vi.advanceTimersByTimeAsync(10001);expect(a.c.holds()).toBe(false);
});

it.each([403,404])('rechecks authority and recovers a temporary control-route %s without a role change or browser refresh',async status=>{
 const s=new AccountServer(),a=page(s,'A'),handle=s.handle.bind(s);let rejected=false;
 const recheck=vi.fn(async()=>{});Object.assign(a.hooks,{recheckAccess:recheck});
 s.handle=async(actor,path,o)=>{if(!rejected){rejected=true;throw new ApiError(status,'NOT_FOUND','暂时无法访问');}return handle(actor,path,o);};
 await expect(a.c.start()).rejects.toMatchObject({status});expect(a.c.holds()).toBe(false);
 await vi.advanceTimersByTimeAsync(8001);
 expect(recheck).toHaveBeenCalledOnce();expect(a.c.holds()).toBe(true);expect(a.hooks.finish).toHaveBeenCalledOnce();
});

it('keeps a genuinely revoked project fenced and does not try to acquire after an access recheck denial',async()=>{
 const s=new AccountServer(),a=page(s,'A');
 const recheck=vi.fn(async()=>{throw new ApiError(403,'PROJECT_ACCESS_REQUIRED','项目权限已撤销');});Object.assign(a.hooks,{recheckAccess:recheck});
 s.handle=async()=>{throw new ApiError(403,'PROJECT_ACCESS_REQUIRED','项目权限已撤销');};
 await expect(a.c.start()).rejects.toMatchObject({status:403});await vi.advanceTimersByTimeAsync(65000);
 expect(recheck).toHaveBeenCalled();expect(a.c.holds()).toBe(false);expect(a.c.state().status).toBe('readonly');
 expect(a.hooks.sync).not.toHaveBeenCalled();expect(a.hooks.finish).not.toHaveBeenCalled();expect(s.peers.size).toBe(0);
 a.c.stop();const calls=recheck.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(recheck).toHaveBeenCalledTimes(calls);
});

it('finishes a progressing 45-second snapshot without restarting or granting edits before readiness',async()=>{
 const s=new AccountServer(),a=page(s,'A');
 a.hooks.sync.mockImplementation((_signal:AbortSignal,progress:()=>void)=>new Promise<number>(resolve=>{
  const pulse=setInterval(progress,1000);setTimeout(()=>{clearInterval(pulse);resolve(s.revision);},45000);
 }));
 const admission=a.c.start();await vi.advanceTimersByTimeAsync(40000);
 expect(a.c.holds()).toBe(false);expect(a.hooks.sync).toHaveBeenCalledOnce();expect(a.hooks.finish).not.toHaveBeenCalled();
 expect(s.requests.filter(r=>r.method==='POST'&&!r.route).length).toBeGreaterThan(2);
 await vi.advanceTimersByTimeAsync(5001);await admission;
 expect(a.c.holds()).toBe(true);expect(a.hooks.sync).toHaveBeenCalledOnce();expect(a.hooks.finish).toHaveBeenCalledOnce();
});

it('does not mistake successful admission heartbeats for snapshot progress',async()=>{
 const s=new AccountServer(),a=page(s,'A');a.hooks.sync.mockImplementation(()=>new Promise(()=>{}));
 const admission=a.c.start().catch(error=>error);await vi.advanceTimersByTimeAsync(20001);
 expect(await admission).toMatchObject({code:'EDIT_HANDOFF_TIMEOUT'});expect(a.c.holds()).toBe(false);expect(a.hooks.finish).not.toHaveBeenCalled();expect(s.peers.size).toBe(0);
});

it('does not let a late unconfirmed heartbeat undo a completed ready receipt',async()=>{
 const s=new AccountServer(),a=page(s,'A'),handle=s.handle.bind(s);let release!:(value:any)=>void;
 s.handle=async(actor,path,o)=>{
  const result=await handle(actor,path,o);
  if(o.body?.leaseId&&!path.endsWith('/ready')&&result.data.state==='SYNC_REQUIRED')return new Promise(resolve=>{release=()=>resolve(result);});
  return result;
 };
 a.hooks.sync.mockImplementation((_signal:AbortSignal,progress:()=>void)=>new Promise<number>(resolve=>setTimeout(()=>{progress();resolve(s.revision);},11000)));
 const admission=a.c.start();await vi.advanceTimersByTimeAsync(11001);await admission;expect(a.c.holds()).toBe(true);
 release(undefined);await vi.advanceTimersByTimeAsync(1);expect(a.c.holds()).toBe(true);expect(a.hooks.sync).toHaveBeenCalledOnce();
});
