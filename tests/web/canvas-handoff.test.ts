import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {CanvasHandoffSession} from '../../apps/web/src/service/canvas-handoff';

const later=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const close:Array<()=>void>=[];
afterEach(()=>{while(close.length)close.pop()!();vi.useRealTimers();});
type Peer={id:string; user:string; proof:string};
type Req={id:string; owner:string; from:Peer; to:Peer; state:string; readyAt:number};
class Server {
 term=0;revision=1;
 writer?:Peer;lease='';needsSync=true;
 peers=new Map<string,Peer>();requests=new Map<string,Req>();log:any[]=[];
 next(owner:Peer){this.writer=owner;this.lease='lease-'+(++this.term);this.needsSync=true;}
 receipt(id:string){return{projectId:'p',clientId:id,leaseId:this.lease,state:this.needsSync?'SYNC_REQUIRED':'HELD',ttlSeconds:30,expiresAt:new Date(Date.now()+30000).toISOString(),resumeToken:'resume-'+this.lease};}
 status(p:Peer){
  const rows=[...this.requests.values()],out=rows.filter(q=>q.to.id===p.id).at(-1);
  const describe=(r:Req)=>({retryAfterMs:Math.max(0,r.readyAt-Date.now()),requestId:r.id,state:r.state,sameAccount:r.from.user===r.to.user,userId:r.to.user,displayName:r.to.user,expiresAt:new Date(r.readyAt+60000).toISOString(),availableAt:new Date(r.readyAt).toISOString()});
  return{projectId:'p',state:!this.writer?'FREE':this.writer.id!==p.id?'OCCUPIED':this.needsSync?'SYNC_REQUIRED':'HELD',
   leaseId:this.writer?.id===p.id?this.lease:undefined,
   holder:this.writer&&{userId:this.writer.user,displayName:this.writer.user},outgoing:out&&describe(out),
   incoming:rows.filter(q=>q.state==='PENDING'&&q.from.id===p.id&&q.owner===this.lease).map(describe)};
 }
 handle(user:string,path:string,options:any){
  const url=path.slice('/projects/p/edit-session'.length),method=options.method,body=options.body,id=options.headers['X-STUDIO-Canvas-Session'];
  const proof=options.headers['X-STUDIO-Canvas-Proof'];let peer=this.peers.get(id);if(!peer){peer={user,id,proof};this.peers.set(id,peer);}
  this.log.push({url,method,id,body});
  if(method!=='GET'&&(peer.proof!==body?.pageProof||body.clientId!==id))throw Error('bad document proof');
  if(method==='GET')return this.status(peer);
  if(!url&&method==='POST'){
   if(body.leaseId&&(this.writer?.id!==id||this.lease!==body.leaseId))throw new ApiError(409,'EDIT_SESSION_EXPIRED','旧会话');
   if(!this.writer)this.next(peer);
   if(this.writer?.id!==id)throw new ApiError(409,'PROJECT_EDIT_OCCUPIED','已占用');
   return this.receipt(id);
  }
  if(!url&&method==='DELETE'){if(this.writer?.id===id&&this.lease===body.leaseId)this.writer=undefined;return{};}
  if(url==='/ready'){
   if(this.writer?.id!==id||this.lease!==body.leaseId||body.revision!==this.revision)throw new ApiError(409,'CANVAS_SYNC_REQUIRED','画布有新提交');
   this.needsSync=false;return this.receipt(id);
  }
  if(url==='/requests'){
   let req=this.requests.get(body.requestId);
   if(!req&&body.onlyIfFree&&this.writer)return this.status(peer);
   if(!req&&!this.writer){this.next(peer);return this.status(peer);}
   if(!req&&this.writer){req={id:body.requestId,from:this.writer,to:peer,state:'PENDING',owner:this.lease,readyAt:Date.now()+30000};this.requests.set(req.id,req);}
   else if(req?.state==='PENDING'&&req.from.user===peer.user&&Date.now()>=req.readyAt){this.next(peer);req.state='TRANSFERRED';}
   return this.status(peer);
  }
  const req=this.requests.get(url.split('/')[2])!;
  if(method==='DELETE'){if(req?.state==='PENDING'&&req.to.id===id)req.state='CANCELED';return this.status(peer);}
  if(req.state!=='PENDING'||this.writer?.id!==id||this.lease!==body.leaseId)throw new ApiError(409,'EDIT_REQUEST_EXPIRED','申请已过期');
  if(body.decision==='DEFER'){req.readyAt=Date.now()+30000;return this.status(peer);}
  if(body.decision==='DECLINE'&&req.from.user===req.to.user)throw new ApiError(409,'SELF_HANDOFF_AUTOMATIC','同账号自动切换');
  if(body.decision==='DECLINE')req.state='DECLINED';else{req.state='TRANSFERRED';this.next(req.to);}
  return this.status(peer);
 }
}
function page(s:Server,user:string){
 let front=true,current=true,mayEdit=true;const saved:string[]=[];
 const hooks={foreground:()=>front,visible:()=>true,beforeDrain:vi.fn(()=>true),prepare:vi.fn(async(_signal:AbortSignal)=>{s.revision++;}),
  sync:vi.fn(async(_signal:AbortSignal)=>s.revision),finish:vi.fn(async(_signal:AbortSignal)=>{}),resume:vi.fn(async():Promise<string|undefined>=>undefined),remember:(token:string)=>saved.push(token),changed:vi.fn(),leaseChanged:vi.fn<(id?:string)=>void>()};
 const api:any={requestV2:vi.fn(async(path:string,opts:any)=>({data:s.handle(user,path,opts)}))};
 const editor=new CanvasHandoffSession(api,'p',user,()=>current,()=>mayEdit,()=>true,hooks);
 close.push(()=>{editor.stop();current=false;});return{editor,hooks,api,saved,revoke:()=>{mayEdit=false;},foreground:()=>{front=true;editor.activate();},background:()=>{front=false;editor.background();}};
}
const settle=async()=>{await vi.advanceTimersByTimeAsync(10);};
it('hands off between the active tabs of one account after saving and applying the latest revision, without a focus ping-pong',async()=>{
 vi.useFakeTimers();const server=new Server(),a=page(server,'alice'),b=page(server,'alice');
 await a.editor.start();expect(a.editor.holds()).toBe(true);a.background();await b.editor.start();
 expect(b.editor.state().outgoing).toMatchObject({state:'PENDING',sameAccount:true});
 const drain=later<void>();a.hooks.prepare.mockImplementation(async()=>{await drain.promise;server.revision++;});
 a.editor.wake();await settle();expect(a.editor.holds()).toBe(false);expect(a.editor.ownsLease()).toBe(true);expect(b.editor.holds()).toBe(false);
 const install=later<void>();b.hooks.finish.mockImplementation(()=>install.promise);
 drain.resolve();await settle();b.editor.wake();await settle();
 expect(b.hooks.sync).toHaveBeenCalledOnce();expect(server.revision).toBe(2);expect(b.editor.ownsLease()).toBe(true);expect(b.editor.holds()).toBe(false);
 install.resolve();await settle();expect(b.editor.holds()).toBe(true);expect(a.editor.holds()).toBe(false);
 expect(a.editor.pageProof).not.toBe(b.editor.pageProof);expect(a.editor.clientId).not.toBe(b.editor.clientId);
 // A second visible but inactive window must not renew the old lease or re-request merely because timers fire.
 await vi.advanceTimersByTimeAsync(22000);expect(server.writer?.id).toBe(b.editor.clientId);expect(server.requests.size).toBe(1);
 b.background();a.foreground();await settle();b.editor.wake();await settle();a.editor.wake();await settle();
 expect(a.editor.holds()).toBe(true);expect(b.editor.holds()).toBe(false);expect(server.requests.size).toBe(2);
});
it('keeps other accounts in view mode until their explicit request is approved and supports decline, retry and cancellation',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'bob');await a.editor.start();await b.editor.start();expect(s.requests.size).toBe(0);
 await b.editor.requestEdit();a.editor.wake();await settle();expect(a.editor.state().incoming).toMatchObject({displayName:'bob',sameAccount:false});
 await a.editor.decision('DECLINE');b.editor.wake();await settle();expect(b.editor.state().outgoing?.state).toBe('DECLINED');expect(b.editor.state().message).toContain('暂未同意');
 b.foreground();await vi.advanceTimersByTimeAsync(3000);expect(s.requests.size).toBe(1);
 await b.editor.requestEdit();await b.editor.cancelRequest();expect(b.editor.holds()).toBe(false);
 await b.editor.requestEdit();a.editor.wake();await settle();await a.editor.decision('APPROVE');b.editor.wake();await settle();
 expect(b.editor.holds()).toBe(true);expect(a.editor.state().status).toBe('occupied');
 await vi.advanceTimersByTimeAsync(30000);expect(s.requests.size).toBe(3);expect(s.writer?.id).toBe(b.editor.clientId);
});
it('cancels an automatic focus request when the recipient goes into the background before approval',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice');await a.editor.start();await b.editor.start();b.background();await settle();
 expect([...s.requests.values()][0].state).toBe('CANCELED');a.editor.wake();await settle();expect(a.hooks.prepare).not.toHaveBeenCalled();expect(a.editor.holds()).toBe(true);
});
it('does not grant editing or keep the lease alive forever when applying the fresh snapshot is suspended',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),wait=later<number>();a.hooks.sync.mockImplementation(()=>wait.promise);
 const first=a.editor.start().catch(e=>e);await settle();expect(a.editor.holds()).toBe(false);
 await vi.advanceTimersByTimeAsync(20000);await first;expect(a.editor.state().status).toBe('offline');expect(s.writer).toBeUndefined();
 wait.resolve(9);await settle();expect(a.editor.holds()).toBe(false);expect(s.log.filter(r=>r.url==='/ready')).toEqual([]);
});
it('does not save over another device or auto-request when a disconnected former writer simply reconnects',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice');await a.editor.start();a.editor.offline();
 s.next({id:'other',user:'alice',proof:'other-proof'});a.editor.online();await settle();
 expect(a.editor.state().status).toBe('occupied');expect(s.requests.size).toBe(0);expect(a.editor.holds()).toBe(false);
});
it('keeps the writer while dragging, then saves and transfers only after the gesture has finished',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice');await a.editor.start();a.background();
 await b.editor.start();a.hooks.beforeDrain.mockReturnValue(false);a.editor.wake();await settle();
 expect(a.editor.holds()).toBe(true);expect(a.hooks.prepare).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(46000);
 expect(s.writer?.id).toBe(a.editor.clientId);expect(b.editor.holds()).toBe(false);
 expect(s.log.filter(r=>r.body?.decision==='DEFER').length).toBeGreaterThan(1);
 a.hooks.beforeDrain.mockReturnValue(true);a.editor.wake();await settle();b.editor.wake();await settle();
 expect(b.editor.holds()).toBe(true);
});

it('lets a retired foreground page explicitly take a FREE canvas without ever allowing its background poll to re-acquire',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice');
 await a.editor.start();a.background();await b.editor.start();a.editor.wake();await settle();b.editor.wake();await settle();
 expect(b.editor.holds()).toBe(true);b.editor.stop();await settle();
 await vi.advanceTimersByTimeAsync(15000);expect(s.writer).toBeUndefined();
 const at=s.log.length;a.foreground();await settle();expect(a.editor.holds()).toBe(true);
 expect(s.log.slice(at).map(row=>row.url)).toContain('/requests');
 expect(s.log.slice(at).filter(row=>row.method==='POST'&&!row.url)).toHaveLength(0);
});
it('continues immediately after a reload token expired while the previous page release was in flight',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice');a.hooks.resume.mockResolvedValue('old-token');
 const request=a.api.requestV2.getMockImplementation()!;
 a.api.requestV2.mockImplementation((path:string,options:any)=>{if(options.body?.resumeToken)throw new ApiError(409,'EDIT_RESUME_INVALID','expired');return request(path,options);});
 await a.editor.start();expect(a.editor.holds()).toBe(true);expect(a.hooks.resume).toHaveBeenCalledOnce();
});
it('rechecks the installed revision after /ready refused a stale snapshot and only unlocks after local recovery',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'a');a.hooks.sync.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
 const base=a.api.requestV2.getMockImplementation()!;let stale=true;
 a.api.requestV2.mockImplementation((path:string,opts:any)=>{if(path.endsWith('/ready')&&stale){stale=false;s.revision++;}return base(path,opts);});
 await a.editor.start();expect(a.editor.holds()).toBe(true);expect(a.hooks.sync).toHaveBeenCalledTimes(2);expect(a.hooks.finish).toHaveBeenCalledOnce();
});
it('explicitly rejects a request when outgoing changes cannot be saved and a late completion never grants approval',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'a'),b=page(s,'b');await a.editor.start();await b.editor.start();await b.editor.requestEdit();a.editor.wake();await settle();
 const slow=later<void>();a.hooks.prepare.mockImplementation(()=>slow.promise);const decision=a.editor.decision('APPROVE').catch(e=>e);await settle();
 expect(a.editor.holds()).toBe(false);await vi.advanceTimersByTimeAsync(20500);await decision;
 expect(a.editor.state().status).toBe('offline');slow.resolve();await settle();b.editor.wake();await settle();expect(b.editor.holds()).toBe(false);
 expect([...s.requests.values()][0].state).toBe('DECLINED');expect(s.log.filter(r=>r.body?.decision==='APPROVE')).toHaveLength(0);
});
it('releases a newly granted automatic transfer if focus moved during snapshot hydration',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'a'),b=page(s,'a');await a.editor.start();a.background();await b.editor.start();a.editor.wake();await settle();
 const slow=later<number>();b.hooks.sync.mockImplementation(()=>slow.promise);b.editor.wake();await settle();b.background();slow.resolve(s.revision);await settle();
 expect(b.editor.holds()).toBe(false);expect(s.writer).toBeUndefined();
});
it('uses the same pending request to recover from an unresponsive same-account holder, even when the server clock is ahead',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'a'),b=page(s,'a');await a.editor.start();a.editor.offline();
 const original=b.api.requestV2.getMockImplementation()!;
 b.api.requestV2.mockImplementation(async(path:string,opts:any)=>{
  const res=await original(path,opts);if(res.data.outgoing?.state==='PENDING')res.data.outgoing.availableAt=new Date(Date.now()+3600000).toISOString();
  return res;
 });
 await b.editor.start();const req=[...s.requests.keys()][0];expect(b.editor.holds()).toBe(false);
 await vi.advanceTimersByTimeAsync(33000);expect(b.editor.holds()).toBe(true);
 const posted=s.log.filter(r=>r.url==='/requests'&&r.id===b.editor.clientId).map(r=>r.body.requestId);
 expect(posted.length).toBeGreaterThanOrEqual(2);expect(new Set(posted)).toEqual(new Set([req]));
});

it('does not display historical request decisions after this page has just given Bob the canvas',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'Alice'),b=page(s,'Bob');await a.editor.start();
 const old=s.writer!;s.requests.set('historical',{id:'historical',owner:'previous',from:old,to:old,state:'EXPIRED',readyAt:0});
 await b.editor.start();await b.editor.requestEdit();a.editor.wake();await settle();await a.editor.decision('APPROVE');b.editor.wake();await settle();
 a.editor.wake();await settle();expect(a.editor.state()).toMatchObject({status:'occupied',holder:{displayName:'Bob'}});
 expect(a.editor.state().message).toBeUndefined();expect(b.editor.holds()).toBe(true);
});

it('rotates the business writer term on an A to B to A switch and installs it before each finish hook can submit retained operations',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'a'),b=page(s,'a');const bound=()=>a.hooks.leaseChanged.mock.calls.at(-1)?.[0];
 const finishTerms:string[]=[];a.hooks.finish.mockImplementation(async()=>{expect(a.editor.holds()).toBe(false);expect(bound()).toBe(s.lease);finishTerms.push(bound()!);});
 await a.editor.start();const first=bound();a.background();await b.editor.start();
 const drain=later<void>();a.hooks.prepare.mockImplementation(async()=>{expect(bound()).toBe(first);await drain.promise;});
 a.editor.wake();await settle();expect(bound()).toBe(first);drain.resolve();await settle();expect(bound()).toBeUndefined();
 b.editor.wake();await settle();b.background();a.foreground();await settle();b.editor.wake();await settle();a.editor.wake();await settle();
 expect(a.editor.holds()).toBe(true);expect(finishTerms).toEqual([first,bound()]);expect(first).not.toBe(bound());
 a.editor.offline();expect(bound()).toBeUndefined();
});

it('does not request back on watch/heartbeat even if both same-account devices remain focused for several lease cycles',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice');await a.editor.start();await b.editor.start();
 a.editor.wake();await settle();b.editor.wake();await settle();expect(b.editor.holds()).toBe(true);
 const count=s.requests.size;await vi.advanceTimersByTimeAsync(75000);
 expect(s.writer?.id).toBe(b.editor.clientId);expect(s.requests.size).toBe(count);expect(a.editor.holds()).toBe(false);
});
it('does not treat expiry of an unresponsive foreground writer as a new foreground intent after another device took over',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice');await a.editor.start();
 s.next({id:'new-device',user:'alice',proof:'another-proof'});a.editor.invalidate(new TypeError('late heartbeat timeout'));
 a.editor.wake();await settle();await vi.advanceTimersByTimeAsync(40000);
 expect(s.writer?.id).toBe('new-device');expect(a.editor.holds()).toBe(false);expect(s.requests.size).toBe(0);
});
it('ignores a delayed sync after the account was downgraded to viewer',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),gate=later<number>();a.hooks.sync.mockImplementation(()=>gate.promise);
 const result=a.editor.start().catch(e=>e);await settle();a.revoke();gate.resolve(1);await result;
 expect(a.editor.state().status).toBe('readonly');expect(a.editor.holds()).toBe(false);expect(a.hooks.finish).not.toHaveBeenCalled();
 expect(s.log.some(r=>r.url==='/ready')).toBe(false);
});
it('cannot install an old document receipt which resolves after pagehide and another page acquired the writer',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice'),gate=later<any>();
 const initial=a.api.requestV2.getMockImplementation()!;
 a.api.requestV2.mockImplementation(async(path:string,opts:any)=>{
  const result=await initial(path,opts);if(path.endsWith('/ready')){await gate.promise;}return result;
 });
 const result=a.editor.start().catch(e=>e);await settle();a.editor.stop();await b.editor.start();
 gate.resolve(true);await result;await settle();expect(b.editor.holds()).toBe(true);expect(a.editor.holds()).toBe(false);
 expect(a.hooks.finish).not.toHaveBeenCalled();expect(a.hooks.leaseChanged.mock.calls.at(-1)?.[0]).toBeUndefined();
});

it('never resurrects a retired tab from a timer after the other device took the canvas and left while this tab slept',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice');await a.editor.start();a.editor.offline();a.editor.offline();
 s.writer=undefined;
 const api=a.api.requestV2.getMockImplementation()!;
 a.api.requestV2.mockImplementation((path:string,opts:any)=>{
  if(path.endsWith('/edit-session')&&opts.method==='POST')throw new ApiError(409,'EDIT_SESSION_EXPIRED','retired');
  return api(path,opts);
 });
 a.editor.online();await settle();await vi.advanceTimersByTimeAsync(40000);
 expect(a.editor.holds()).toBe(false);expect(s.writer).toBeUndefined();expect(s.log.some(r=>r.url==='/requests')).toBe(false);
 a.foreground();await settle();expect(a.editor.holds()).toBe(true);
});

it('takes over from a real pointer intent in an embedded visible viewer without document focus, and consumes the intent once',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice');await b.editor.start();
 a.background();await a.editor.start();await vi.advanceTimersByTimeAsync(4000);expect(s.requests.size).toBe(0);
 a.editor.activate(true);await settle();b.editor.wake();await settle();a.editor.wake();await settle();
 expect(a.editor.holds()).toBe(true);expect(b.editor.holds()).toBe(false);
 b.editor.activate(true);await settle();a.editor.wake();await settle();b.editor.wake();await settle();
 await vi.advanceTimersByTimeAsync(60000);expect(b.editor.holds()).toBe(true);expect(s.requests.size).toBe(2);
});
it('drops embedded pointer intent on a real blur before the old page approves',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice'),b=page(s,'alice');await a.editor.start();
 b.background();await b.editor.start();b.editor.activate(true);await settle();b.editor.background();await settle();a.editor.wake();await settle();
 expect(a.editor.holds()).toBe(true);expect(b.editor.holds()).toBe(false);expect([...s.requests.values()][0].state).toBe('CANCELED');
});

it('restores an unfocused but visible genuine reload to a FREE canvas when the old page DELETE beat its resume attempt',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice');a.background();a.hooks.resume.mockResolvedValue('prior-editor-receipt');
 const orig=a.api.requestV2.getMockImplementation()!;
 a.api.requestV2.mockImplementation((path:string,opts:any)=>{if(opts.body?.resumeToken)throw new ApiError(409,'EDIT_RESUME_INVALID','previous release');return orig(path,opts);});
 await a.editor.start();expect(a.editor.holds()).toBe(true);expect(s.log.filter(r=>r.url==='/requests')).toHaveLength(0);
 expect(a.hooks.sync).toHaveBeenCalledOnce();
});
it('does not let an unfocused visible reload with an obsolete receipt request a different active same-account device',async()=>{
 vi.useFakeTimers();const s=new Server(),running=page(s,'alice'),reload=page(s,'alice');
 await running.editor.start();reload.background();reload.hooks.resume.mockResolvedValue('retired-token');
 const orig=reload.api.requestV2.getMockImplementation()!;
 reload.api.requestV2.mockImplementation((path:string,opts:any)=>{if(opts.body?.resumeToken)throw new ApiError(409,'EDIT_RESUME_INVALID','another holder');return orig(path,opts);});
 await reload.editor.start();await vi.advanceTimersByTimeAsync(15000);
 expect(running.editor.holds()).toBe(true);expect(reload.editor.holds()).toBe(false);expect(s.requests.size).toBe(0);
});
it('does not acquire a free canvas from an unfocused hidden reload even when the storage receipt is genuine',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'alice');a.background();a.hooks.visible=()=>false;a.hooks.resume.mockResolvedValue('prior-editor-receipt');
 await a.editor.start();await vi.advanceTimersByTimeAsync(12000);expect(s.writer).toBeUndefined();expect(s.log.every(r=>r.method==='GET')).toBe(true);
});

it('automatically finishes opening after a bad snapshot even when ordinary reacquisition of the released page is refused',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner');
 a.hooks.sync.mockRejectedValueOnce(new TypeError('invalid json'));
 const orig=a.api.requestV2.getMockImplementation()!;
 a.api.requestV2.mockImplementation((path:string,opts:any)=>{
  if(s.term>0&&!s.writer&&path.endsWith('/edit-session')&&opts.method==='POST')throw new ApiError(409,'EDIT_SESSION_EXPIRED','retired');
  return orig(path,opts);
 });
 await expect(a.editor.start()).rejects.toThrow('invalid json');
 expect(a.editor.state().message).not.toMatch(/交接|保留|申请/);expect(a.editor.holds()).toBe(false);
 await vi.advanceTimersByTimeAsync(1500);expect(a.editor.holds()).toBe(true);
 expect(s.log.find(r=>r.url==='/requests')?.body.onlyIfFree).toBe(true);
});
it('keeps retrying revision churn with backoff and does not park a free private canvas or busy loop on wake events',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner');
 a.hooks.sync.mockImplementation(async()=>++s.revision-1);
 await expect(a.editor.start()).rejects.toMatchObject({code:'CANVAS_SYNC_REQUIRED'});
 for(let i=0;i<100;i++)a.editor.wake();
 expect(a.hooks.sync).toHaveBeenCalledTimes(3);
 await vi.advanceTimersByTimeAsync(12000);
 expect(a.hooks.sync.mock.calls.length).toBeGreaterThan(3);expect(a.hooks.sync.mock.calls.length).toBeLessThanOrEqual(14);
 a.hooks.sync.mockImplementation(async()=>s.revision);await vi.advanceTimersByTimeAsync(8500);expect(a.editor.holds()).toBe(true);
});
it('opens a visible embedded private canvas without relying on focus and only claims an empty canvas',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner');a.background();
 await a.editor.start();expect(a.editor.holds()).toBe(true);
 expect(s.log.find(r=>r.url==='/requests')?.body.onlyIfFree).toBe(true);
});
it('preserves the new holder when another writer arrives between an empty observation and the reserve call',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner');a.background();
 const orig=a.api.requestV2.getMockImplementation()!;
 a.api.requestV2.mockImplementation((path:string,opts:any)=>{
  if(path.endsWith('/requests')&&!s.writer)s.next({id:'other',user:'owner',proof:'second'});
  return orig(path,opts);
 });
 await a.editor.start();await vi.advanceTimersByTimeAsync(36000);
 expect(s.writer?.id).toBe('other');expect(s.requests.size).toBe(0);expect(a.hooks.sync).not.toHaveBeenCalled();
});

it('respects a real blur received while a reload receipt is still being read',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner'),gate=later<string>();
 a.hooks.resume.mockImplementation(()=>gate.promise);
 const start=a.editor.start();await settle();a.background();gate.resolve('old-reload-token');await start;
 expect(s.writer).toBeUndefined();expect(s.log.every(r=>r.method==='GET')).toBe(true);
});
it('automatically continues a foreground self-request when both its request and the prior holder expired during an outage',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner'),b=page(s,'owner');await a.editor.start();a.background();await b.editor.start();
 b.editor.offline();a.editor.stop();const old=[...s.requests.values()][0];old.state='EXPIRED';
 b.editor.online();await settle();expect(b.editor.holds()).toBe(true);expect(s.writer?.id).toBe(b.editor.clientId);
});

it('extends a late same-account handoff while its final edit is receiving its server receipt',async()=>{
 vi.useFakeTimers();const s=new Server(),a=page(s,'owner'),b=page(s,'owner');
 await a.editor.start();a.background();await b.editor.start();
 const req=[...s.requests.values()][0];req.readyAt=Date.now()+700;
 const finalSave=later<void>();a.hooks.prepare.mockImplementation(async()=>{await finalSave.promise;s.revision++;});
 a.editor.wake();await settle();expect(a.editor.state().status).toBe('saving');
 await vi.advanceTimersByTimeAsync(9500);expect(s.writer?.id).toBe(a.editor.clientId);expect(b.editor.holds()).toBe(false);
 finalSave.resolve();await settle();b.editor.wake();await settle();expect(b.editor.holds()).toBe(true);expect(s.revision).toBe(2);
});
