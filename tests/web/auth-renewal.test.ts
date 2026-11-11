import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ApiClient,ApiError} from '../../apps/web/src/api/client';
import {AuthSession,installSessionRenewal} from '../../apps/web/src/api/auth';
import {createLoginRecovery} from '../../apps/web/src/api/feishu-ui';
import {ProductClient} from '../../apps/web/src/service/product-client';

const user={id:'actual-user',displayName:'Actual user',avatarUrl:null,locale:'zh-CN',memberships:[],wallet:{currency:'CNY',amount:'0'},teamIds:[]};
const session={accessToken:'server-token',tokenType:'Bearer' as const,expiresIn:900,user};
const response=(status:number,data:any)=>new Response(JSON.stringify(status===200?{code:0,data}:data),{status});
const error=(status:number,code:string)=>response(status,{error:{code,message:code}});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));vi.stubGlobal('navigator',{});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function environment(){const surface=new EventTarget(),doc=Object.assign(new EventTarget(),{visibilityState:'visible'});return{surface,doc};}
function setup(refresh:(count:number,init:any)=>Response){let count=0;const transport=vi.fn(async(path:string,init:any)=>path.endsWith('/csrf')?response(200,{csrfToken:'csrf-'+count}):refresh(++count,init)),api=new ProductClient('/api/v1',transport as any),auth=new AuthSession(api),cleared=vi.fn();api.onRevoked(()=>auth.clear());auth.onClear(cleared);return{api,auth,transport,cleared};}

it.each(['focus','online','pageshow'])('does not start a cold anonymous refresh when the page wakes via %s',async(name)=>{
 const f=setup(()=>response(200,session)),env=environment(),dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);
 env.surface.dispatchEvent(new Event(name));env.doc.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(3600000);
 expect(f.transport).not.toHaveBeenCalled();expect(f.auth.user).toBeNull();expect(f.api.getAccessToken()).toBeNull();expect(vi.getTimerCount()).toBe(0);dispose();
});
it('leaves a cold recovery 503 to the admission gate rather than repeating it on pageshow',async()=>{
 const f=setup(()=>error(503,'IPAC_UNAVAILABLE')),env=environment(),dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);
 await expect(f.auth.restore()).rejects.toMatchObject({status:503});expect(f.transport).toHaveBeenCalledTimes(2);
 for(const name of ['focus','online','pageshow'])env.surface.dispatchEvent(new Event(name));await vi.advanceTimersByTimeAsync(3600000);
 expect(f.transport).toHaveBeenCalledTimes(2);expect(f.auth.user).toBeNull();expect(vi.getTimerCount()).toBe(0);dispose();
});
it('does not restore a signed-out identity from a later focus, online, or bfcache wake',async()=>{
 const f=setup(()=>response(200,session)),env=environment();f.auth.accept(session);const dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);
 await f.auth.signOut();const calls=f.transport.mock.calls.length;expect(f.auth.user).toBeNull();expect(f.api.getAccessToken()).toBeNull();
 for(const name of ['focus','online','pageshow'])env.surface.dispatchEvent(new Event(name));env.doc.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(24*3600000);
 expect(f.transport).toHaveBeenCalledTimes(calls);expect(f.auth.user).toBeNull();expect(f.transport.mock.calls.some(call=>call[0].endsWith('/refresh'))).toBe(false);expect(vi.getTimerCount()).toBe(0);dispose();
});
it('renews an in-use page before the actual short Bearer expiry while keeping one real identity',async()=>{
 const f=setup(()=>response(200,{...session,accessToken:'rotated-token'})),env=environment();f.auth.accept(session);const dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);
 await vi.advanceTimersByTimeAsync(839999);expect(f.transport).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);
 expect(f.transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/auth/csrf','/api/v1/auth/sessions/refresh']);expect(f.api.getAccessToken()).toBe('rotated-token');expect(f.auth.user?.id).toBe(user.id);expect(f.cleared).not.toHaveBeenCalled();dispose();expect(vi.getTimerCount()).toBe(0);
});
it('uses a verified-response expiry conservatively and never changes or persists the token claims',()=>{
 const f=setup(()=>response(200,session)),expiry=Math.floor(Date.now()/1000)+120,token=btoa('{}')+'.'+btoa(JSON.stringify({sub:user.id,exp:expiry}))+'.signature';f.auth.accept({...session,accessToken:token});expect(f.auth.renewalDueAt).toBe(Date.now()+108000);expect(f.api.getAccessToken()).toBe(token);expect(f.transport).not.toHaveBeenCalled();
});
it.each(['focus','online','pageshow'])('silently recovers an expired memory token when a sleeping page wakes via %s',async(name)=>{
 const f=setup(()=>response(200,{...session,accessToken:'awake-token'})),env=environment();f.auth.accept(session);const dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);env.doc.visibilityState='hidden';env.doc.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(24*3600000);expect(f.transport).not.toHaveBeenCalled();env.doc.visibilityState='visible';env.surface.dispatchEvent(new Event(name));env.surface.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(f.api.getAccessToken()).toBe('awake-token');expect(f.transport.mock.calls.filter(call=>call[0].endsWith('/refresh'))).toHaveLength(1);dispose();
});
it('pauses a bfcache page on pagehide and clears renewal work after signout or hook disposal',async()=>{
 const f=setup(()=>response(200,session)),env=environment();f.auth.accept(session);const dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);env.surface.dispatchEvent(new Event('pagehide'));await vi.advanceTimersByTimeAsync(3600000);expect(f.transport).not.toHaveBeenCalled();env.surface.dispatchEvent(new Event('pageshow'));await vi.advanceTimersByTimeAsync(0);expect(f.transport).toHaveBeenCalledTimes(2);f.auth.clear();await vi.advanceTimersByTimeAsync(3600000);expect(f.transport).toHaveBeenCalledTimes(2);dispose();env.surface.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(f.transport).toHaveBeenCalledTimes(2);
});
it('keeps an existing identity on a temporary renewal 503 and retries with bounded backoff',async()=>{
 const f=setup(count=>count===1?error(503,'IPAC_UNAVAILABLE'):response(200,{...session,accessToken:'recovered-token'})),env=environment();f.auth.accept(session);const dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);await vi.advanceTimersByTimeAsync(840000);expect(f.api.getAccessToken()).toBe('server-token');expect(f.cleared).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(4999);expect(f.transport.mock.calls.filter(call=>call[0].endsWith('/refresh'))).toHaveLength(1);await vi.advanceTimersByTimeAsync(1);expect(f.api.getAccessToken()).toBe('recovered-token');expect(f.cleared).not.toHaveBeenCalled();dispose();
});
it('stops renewal and clears identity when the server enforces the hard session deadline',async()=>{
 const f=setup(()=>error(401,'REFRESH_REVOKED')),env=environment();f.auth.accept(session);const dispose=installSessionRenewal(f.auth,env.surface as any,env.doc as any);await vi.advanceTimersByTimeAsync(840000);expect(f.auth.user).toBeNull();expect(f.api.getAccessToken()).toBeNull();expect(f.cleared).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);dispose();
});
it('waits once for another HTTP tab to install its shared refresh cookie without revoking or fabricating a successful old-token refresh',async()=>{
 const f=setup(count=>count===1?error(401,'REFRESH_RACE_RETRY'):response(200,{...session,accessToken:'shared-cookie-token'}));f.auth.accept(session);const pending=f.auth.restore();await vi.advanceTimersByTimeAsync(0);expect(f.api.getAccessToken()).toBe('server-token');expect(f.cleared).not.toHaveBeenCalled();expect(f.transport).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(999);expect(f.transport).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1);expect(await pending).toBe(true);expect(f.api.getAccessToken()).toBe('shared-cookie-token');expect(f.transport).toHaveBeenCalledTimes(4);expect(f.cleared).not.toHaveBeenCalled();
});
it('recovers two independent HTTP tabs using the rotated shared cookie after a real concurrent refresh collision',async()=>{
 let cookie='old-cookie',consumed=false,installCookie!:()=>void;
 const transport=vi.fn(async(path:string)=>{
  if(path.endsWith('/csrf'))return response(200,{csrfToken:'valid-csrf'});
  if(cookie==='old-cookie'){
   if(consumed)return error(401,'REFRESH_RACE_RETRY');consumed=true;
   return new Promise<Response>(resolve=>{installCookie=()=>{cookie='new-cookie';resolve(response(200,{...session,accessToken:'first-tab-token'}));};});
  }
  return response(200,{...session,accessToken:'second-tab-token'});
 });
 const firstApi=new ProductClient('/api/v1',transport as any),secondApi=new ProductClient('/api/v1',transport as any),first=new AuthSession(firstApi),second=new AuthSession(secondApi),clear=vi.fn();
 firstApi.onRevoked(()=>first.clear());secondApi.onRevoked(()=>second.clear());first.onClear(clear);second.onClear(clear);first.accept(session);second.accept(session);
 const a=first.restore(),b=second.restore();await vi.advanceTimersByTimeAsync(0);expect(firstApi.getAccessToken()).toBe('server-token');expect(secondApi.getAccessToken()).toBe('server-token');expect(clear).not.toHaveBeenCalled();installCookie();expect(await a).toBe(true);await vi.advanceTimersByTimeAsync(1000);expect(await b).toBe(true);expect(firstApi.getAccessToken()).toBe('first-tab-token');expect(secondApi.getAccessToken()).toBe('second-tab-token');expect(transport.mock.calls.filter(call=>call[0].endsWith('/refresh'))).toHaveLength(3);expect(clear).not.toHaveBeenCalled();
});
it('does not retry a collided refresh after its identity epoch has been cleared',async()=>{
 const f=setup(()=>error(401,'REFRESH_RACE_RETRY'));f.auth.accept(session);const pending=f.auth.restore();await vi.advanceTimersByTimeAsync(0);f.auth.clear();await vi.advanceTimersByTimeAsync(1000);expect(await pending).toBe(false);expect(f.transport).toHaveBeenCalledTimes(2);expect(f.api.getAccessToken()).toBeNull();
});
it('turns a repeated narrowly marked refresh collision into a recoverable failure after only one retry',async()=>{
 const f=setup(()=>error(401,'REFRESH_RACE_RETRY'));f.auth.accept(session);const pending=f.auth.restore(),rejected=expect(pending).rejects.toMatchObject({status:503,code:'SESSION_RECOVERY_PENDING'});await vi.advanceTimersByTimeAsync(1000);await rejected;expect(f.transport).toHaveBeenCalledTimes(4);expect(f.auth.user?.id).toBe(user.id);expect(f.cleared).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('does not apply the refresh-collision exception to a business API 401',async()=>{
 const transport=vi.fn(async()=>error(401,'REFRESH_RACE_RETRY')),api=new ProductClient('/api/v1',transport as any),revoke=vi.fn();api.setAccessToken('real-token');api.onRevoked(revoke);await expect(api.request('/projects/p',{anonymous:true})).rejects.toMatchObject({status:401});expect(revoke).toHaveBeenCalledOnce();
});
it('refreshes a cached 24-hour CSRF value after sleep/503 without clearing identity or offering OAuth',async()=>{
 const f=setup(count=>count===1?error(503,'IPAC_UNAVAILABLE'):count===2?error(403,'CSRF_INVALID'):response(200,session));f.auth.accept(session);await expect(f.auth.restore()).rejects.toMatchObject({status:503});vi.setSystemTime(Date.now()+24*3600000);expect(await f.auth.restore()).toBe(true);const calls=f.transport.mock.calls.filter(call=>call[0].endsWith('/refresh'));expect(calls.map(call=>call[1].headers.get('X-CSRF-Token'))).toEqual(['csrf-0','csrf-0','csrf-2']);expect(f.cleared).not.toHaveBeenCalled();
});
it('retries an expired logout CSRF exactly once without refreshing the login or bypassing its protection',async()=>{
 let count=0,csrf=0;const transport=vi.fn(async(path:string)=>path.endsWith('/csrf')?response(200,{csrfToken:'csrf-'+(++csrf)}):++count===1?error(403,'CSRF_INVALID'):response(200,{accepted:true})),api=new ProductClient('/api/v1',transport as any),auth=new AuthSession(api);auth.accept(session);await auth.signOut();expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/auth/csrf','/api/v1/auth/session','/api/v1/auth/csrf','/api/v1/auth/session']);const calls=transport.mock.calls as any[];expect(calls.filter(call=>call[0].endsWith('/session')).map(call=>call[1].headers.get('X-CSRF-Token'))).toEqual(['csrf-1','csrf-2']);expect(auth.user).toBeNull();
});
it('does not silently retry an unrelated 403 as a CSRF error',async()=>{
 const f=setup(()=>error(403,'PROJECT_READ_ONLY'));f.auth.accept(session);await expect(f.auth.restore()).rejects.toMatchObject({status:403});expect(f.transport).toHaveBeenCalledTimes(2);expect(f.auth.user?.id).toBe(user.id);
});
it('recovers an original native login prompt silently and coalesces repeated prompts without opening OAuth',async()=>{
 let complete!:(value:boolean)=>void;const restore=vi.fn(()=>new Promise<boolean>(resolve=>complete=resolve)),recovered=vi.fn(),login=vi.fn().mockResolvedValue(undefined),retry=vi.fn(),open=createLoginRecovery({restore,recovered},login,retry);const first=open(),second=open();expect(first).toBe(second);complete(true);await first;expect(restore).toHaveBeenCalledOnce();expect(recovered).toHaveBeenCalledOnce();expect(login).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();
});
it('offers only recovery retry on transient identity-service failure, then silently resumes when it recovers',async()=>{
 const restore=vi.fn().mockRejectedValueOnce(new ApiError(503,'IPAC_UNAVAILABLE','Unavailable')).mockResolvedValueOnce(true),recovered=vi.fn(),login=vi.fn().mockResolvedValue(undefined),retry=vi.fn(),open=createLoginRecovery({restore,recovered},login,retry);await open();expect(retry).toHaveBeenCalledOnce();expect(login).not.toHaveBeenCalled();await open();expect(recovered).toHaveBeenCalledOnce();expect(login).not.toHaveBeenCalled();
});
it('offers real Feishu login only after the actual refresh session has expired or been revoked',async()=>{
 const login=vi.fn().mockResolvedValue(undefined),retry=vi.fn(),open=createLoginRecovery({restore:vi.fn().mockResolvedValue(false)},login,retry);await open();expect(login).toHaveBeenCalledOnce();expect(retry).not.toHaveBeenCalled();
});
it('clears every identity-bound owner even if a renewal listener fails during revocation',()=>{
 const f=setup(()=>response(200,session));f.auth.accept(session);const other=vi.fn();f.auth.onSession(()=>{throw new Error('broken renewal hook');});f.auth.onSession(other);expect(()=>f.auth.clear()).toThrow(AggregateError);expect(f.auth.user).toBeNull();expect(f.api.getAccessToken()).toBeNull();expect(f.cleared).toHaveBeenCalledOnce();expect(other).toHaveBeenCalledOnce();
});
