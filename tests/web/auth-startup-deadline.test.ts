// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AuthSession} from '../../apps/web/src/api/auth';
import {ServiceLoginGate} from '../../apps/web/src/api/login-gate';
import {ProductClient} from '../../apps/web/src/service/product-client';

// Explicit disposable protocol fixtures; no production cookie, identity
// provider, native application, or model endpoint is accessed.
const user={id:'fixture-user',displayName:'Fixture user',avatarUrl:null,locale:'zh-CN',memberships:[],wallet:{currency:'CNY',amount:'0'},teamIds:[]};
const session={accessToken:'existing-fixture-token',tokenType:'Bearer' as const,expiresIn:900,user};
const json=(data:any,status=200)=>new Response(JSON.stringify(status===200?{code:0,data}:{error:data}),{status});
const success=()=>json({...session,accessToken:'renewed-fixture-token'});
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const release:Array<()=>void>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));vi.stubGlobal('navigator',{locks:undefined});document.body.innerHTML='<div id="root"><button>private fixture homepage</button></div>';window.sessionStorage.clear();});
afterEach(()=>{for(const cleanup of release.splice(0).reverse())cleanup();document.body.replaceChildren();vi.useRealTimers();vi.unstubAllGlobals();});
async function flush(){for(let index=0;index<32;index++)await Promise.resolve();}
type Call={path:string;headers:Headers;signal:AbortSignal};
function fixture(route:(call:Call)=>Response|Promise<Response>){
 const calls:Call[]=[],transport=vi.fn(async(path:any,init:any={})=>{const call={path:String(path),headers:new Headers(init.headers),signal:init.signal};calls.push(call);return route(call);}),api=new ProductClient('/api/v1',transport),auth=new AuthSession(api),cleared=vi.fn();
 api.onRevoked(()=>auth.clear());auth.onClear(()=>{cleared();api.clearRequests();});release.push(()=>auth.clear());return{api,auth,calls,transport,cleared};
}
const defaultResponse=(call:Call)=>call.path.endsWith('/csrf')?json({csrfToken:'fresh-csrf'}):call.path.endsWith('/refresh')?success():(()=>{throw new Error('Unexpected fixture route '+call.path);})();
function gateFixture(route:(call:Call)=>Response|Promise<Response>){
 const f=fixture(route),surface={location:{origin:'http://fixture.invalid',pathname:'/projects/',search:'',hash:'',replace:vi.fn(),reload:vi.fn()},history:{state:null,replaceState:vi.fn()},sessionStorage:window.sessionStorage,addEventListener:vi.fn(),removeEventListener:vi.fn()},gate=new ServiceLoginGate({api:f.api,auth:f.auth},{surface});
 f.api.onRevoked(error=>{gate.denied(error);f.auth.clear();});release.push(()=>gate.disconnect());return{...f,gate,surface};
}
const root=()=>document.getElementById('root')!;
const text=()=>document.getElementById('studio-tv-login-gate')?.textContent??'';

it('bounds ignored Web Lock queuing, cancels without stealing, and allows a fresh retry while its old callback remains fenced',async()=>{
 let oldCallback!:()=>Promise<boolean>,lockSignal!:AbortSignal;
 const request=vi.fn((_name:string,options:any,callback:()=>Promise<boolean>)=>{oldCallback=callback;lockSignal=options.signal;return new Promise<boolean>(()=>{});});vi.stubGlobal('navigator',{locks:{request}});
 const f=fixture(defaultResponse);f.auth.accept(session);const pending=f.auth.restore(),rejected=expect(pending).rejects.toMatchObject({status:503,code:'SESSION_RECOVERY_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(9999);expect(f.transport).not.toHaveBeenCalled();expect(lockSignal.aborted).toBe(false);await vi.advanceTimersByTimeAsync(1);await rejected;
 expect(request.mock.calls[0][0]).toBe('rhtv:auth-refresh');expect(Object.keys(request.mock.calls[0][1])).toEqual(['signal']);expect(lockSignal.aborted).toBe(true);expect(f.api.getAccessToken()).toBe(session.accessToken);expect(f.auth.user?.id).toBe(user.id);expect(f.cleared).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 request.mockImplementation((_name,options,callback)=>callback());expect(await f.auth.restore()).toBe(true);expect(f.api.getAccessToken()).toBe('renewed-fixture-token');const calls=f.calls.length;
 await expect(oldCallback()).rejects.toMatchObject({code:'SESSION_RECOVERY_TIMEOUT'});expect(f.calls).toHaveLength(calls);expect(f.api.getAccessToken()).toBe('renewed-fixture-token');
});

it('releases an acquired Web Lock at the deadline even when its network operation ignores abort',async()=>{
 const held=deferred<Response>(),unlocked=vi.fn(),request=vi.fn(async(_name:string,_options:any,callback:()=>Promise<boolean>)=>{try{return await callback();}finally{unlocked();}});vi.stubGlobal('navigator',{locks:{request}});
 const f=fixture(()=>held.promise),pending=f.auth.restore(),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_RECOVERY_TIMEOUT'});await flush();expect(f.calls).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(10000);await rejected;expect(unlocked).toHaveBeenCalledOnce();expect(f.calls[0].signal.aborted).toBe(true);held.resolve(json({csrfToken:'late-csrf'}));await flush();expect(f.auth.user).toBeNull();expect(f.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
});

it.each(['csrf','refresh'] as const)('bounds a hung %s request for every coalesced waiter, preserves identity, and refuses late success after retry',async stage=>{
 const held=deferred<Response>();let waiting=true;const f=fixture(call=>waiting&&call.path.endsWith('/'+stage)?held.promise:defaultResponse(call));f.auth.accept(session);
 const first=f.auth.restore(),second=f.auth.restore(),firstError=expect(first).rejects.toMatchObject({status:503,code:'SESSION_RECOVERY_TIMEOUT'}),secondError=expect(second).rejects.toMatchObject({code:'SESSION_RECOVERY_TIMEOUT'});await flush();const abandoned=f.calls.at(-1)!;
 await vi.advanceTimersByTimeAsync(10000);await firstError;await secondError;expect(abandoned.signal.aborted).toBe(true);expect(f.api.getAccessToken()).toBe(session.accessToken);expect(f.cleared).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 waiting=false;expect(await f.auth.restore()).toBe(true);held.resolve(stage==='csrf'?json({csrfToken:'late-abandoned-csrf'}):json({...session,accessToken:'late-abandoned-token'}));await flush();
 expect(f.api.getAccessToken()).toBe('renewed-fixture-token');expect(f.auth.user?.id).toBe(user.id);expect(f.cleared).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 expect(await f.auth.restore()).toBe(true);expect(f.calls.filter(call=>call.path.endsWith('/refresh')).at(-1)!.headers.get('X-CSRF-Token')).toBe('fresh-csrf');
});

it('uses one total 10s budget across lock wait, CSRF and refresh instead of granting each stage another timeout',async()=>{
 const request=vi.fn((_name:string,_options:any,callback:()=>Promise<boolean>)=>new Promise<boolean>((resolve,reject)=>setTimeout(()=>{callback().then(resolve,reject);},7000)));vi.stubGlobal('navigator',{locks:{request}});
 const f=fixture(call=>call.path.endsWith('/csrf')?new Promise<Response>(resolve=>setTimeout(()=>resolve(json({csrfToken:'csrf'})),2000)):new Promise<Response>(()=>{})),pending=f.auth.restore(),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_RECOVERY_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(8999);expect(f.calls).toHaveLength(1);await vi.advanceTimersByTimeAsync(1);expect(f.calls).toHaveLength(2);await vi.advanceTimersByTimeAsync(1000);await rejected;expect(f.calls.at(-1)!.signal.aborted).toBe(true);expect(f.auth.user).toBeNull();expect(vi.getTimerCount()).toBe(0);
});

it('includes the narrow refresh-race delay in the same budget and cancels its delayed retry without logging out',async()=>{
 const f=fixture(call=>call.path.endsWith('/csrf')?json({csrfToken:'csrf'}):new Promise<Response>(resolve=>setTimeout(()=>resolve(json({code:'REFRESH_RACE_RETRY',message:'fixture collision'},401)),9500)));f.auth.accept(session);
 const pending=f.auth.restore(),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_RECOVERY_TIMEOUT'});await vi.advanceTimersByTimeAsync(9500);expect(f.calls).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(500);await rejected;await vi.advanceTimersByTimeAsync(2000);expect(f.calls).toHaveLength(2);expect(f.api.getAccessToken()).toBe(session.accessToken);expect(f.cleared).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it('cancels on clear immediately and never lets an old finally remove the replacement flight',async()=>{
 const old=deferred<Response>(),next=deferred<Response>();let refreshes=0;
 const f=fixture(call=>call.path.endsWith('/csrf')?json({csrfToken:'csrf'}):++refreshes===1?old.promise:next.promise);f.auth.accept(session);const first=f.auth.restore();await flush();const oldSignal=f.calls.at(-1)!.signal;
 f.auth.clear();f.auth.accept({...session,accessToken:'new-actor-token',user:{...user,id:'new-actor'}});const replacement=f.auth.restore();await flush();expect(await first).toBe(false);expect(oldSignal.aborted).toBe(true);
 const shared=f.auth.restore();await flush();expect(refreshes).toBe(2);old.resolve(json({...session,accessToken:'old-response-token'}));await flush();expect(f.api.getAccessToken()).toBe('new-actor-token');expect(f.auth.user?.id).toBe('new-actor');
 next.resolve(json({...session,accessToken:'fresh-new-actor-token',user:{...user,id:'new-actor'}}));expect(await Promise.all([replacement,shared])).toEqual([true,true]);expect(f.api.getAccessToken()).toBe('fresh-new-actor-token');expect(vi.getTimerCount()).toBe(0);
});

it.each(['same-user','different-user'] as const)('fences pending recovery when an explicit fresh %s session is accepted',async change=>{
 const old=deferred<Response>(),f=fixture(call=>call.path.endsWith('/csrf')?json({csrfToken:'csrf'}):old.promise);f.auth.accept(session);const pending=f.auth.restore();await flush();
 const fresh={...session,accessToken:'explicit-fresh-token',user:{...user,id:change==='same-user'?user.id:'fresh-identity'}};f.auth.accept(fresh);expect(await pending).toBe(false);expect(f.calls.at(-1)!.signal.aborted).toBe(true);
 old.resolve(json({...session,accessToken:'stale-token'}));await flush();expect(f.api.getAccessToken()).toBe(fresh.accessToken);expect(f.auth.user?.id).toBe(fresh.user.id);expect(vi.getTimerCount()).toBe(0);
});

it('accepts a legitimate user replacement from its own restore atomically, without canceling itself or adding delay',async()=>{
 const replacement={...session,accessToken:'replacement-token',user:{...user,id:'replacement-user'}},f=fixture(call=>call.path.endsWith('/csrf')?json({csrfToken:'csrf'}):json(replacement));f.auth.accept(session);
 const cleanup=vi.fn(()=>{expect(f.auth.user).toBeNull();expect(f.api.getAccessToken()).toBeNull();});f.auth.onClear(cleanup);const started=Date.now();expect(await f.auth.restore()).toBe(true);expect(Date.now()).toBe(started);expect(cleanup).toHaveBeenCalledOnce();expect(f.auth.user?.id).toBe('replacement-user');expect(f.api.getAccessToken()).toBe('replacement-token');expect(vi.getTimerCount()).toBe(0);
});

it('rejects a late successful response after wall-clock expiry even before a suspended timer can run',async()=>{
 const old=deferred<Response>(),f=fixture(call=>call.path.endsWith('/csrf')?json({csrfToken:'csrf'}):old.promise);f.auth.accept(session);const pending=f.auth.restore(),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_RECOVERY_TIMEOUT'});await flush();
 vi.setSystemTime(Date.now()+10001);old.resolve(success());await rejected;expect(f.api.getAccessToken()).toBe(session.accessToken);expect(f.auth.user?.id).toBe(user.id);expect(f.cleared).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it('bounds the protected admission read, keeps the existing identity, and does not admit a late success until a real retry succeeds',async()=>{
 const old=deferred<Response>();let initial=true;const f=gateFixture(call=>call.path.includes('/projects?')?initial?old.promise:json({items:[]}):(()=>{throw new Error('Unexpected auth redirect or refresh '+call.path);})());f.auth.accept(session);
 const admitted=vi.fn();void f.gate.waitForSession().then(admitted);const entering=f.gate.enter();await flush();expect(f.calls).toHaveLength(1);await vi.advanceTimersByTimeAsync(9999);expect(text()).toContain('正在恢复登录');
 await vi.advanceTimersByTimeAsync(1);expect(await entering).toBe(false);expect(f.calls[0].signal.aborted).toBe(true);expect(text()).toContain('重试恢复');expect(root().hidden).toBe(true);expect(f.auth.user?.id).toBe(user.id);expect(f.api.getAccessToken()).toBe(session.accessToken);expect(f.cleared).not.toHaveBeenCalled();expect(f.surface.location.replace).not.toHaveBeenCalled();expect(admitted).not.toHaveBeenCalled();
 old.resolve(json({items:[]}));await flush();expect(root().hidden).toBe(true);expect(admitted).not.toHaveBeenCalled();initial=false;expect(await f.gate.enter()).toBe(true);await flush();expect(admitted).toHaveBeenCalledOnce();expect(root().hidden).toBe(false);expect(f.calls).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);
});

it('checks a replacement identity after canceling its old pending grant and ignores the abandoned success',async()=>{
 const old=deferred<Response>(),next=deferred<Response>();let reads=0;const f=gateFixture(call=>call.path.includes('/projects?')?++reads===1?old.promise:next.promise:(()=>{throw new Error(call.path);})());f.auth.accept(session);
 const admitted=vi.fn();void f.gate.waitForSession().then(admitted);await flush();const oldSignal=f.calls[0].signal;f.auth.accept({...session,accessToken:'new-actor-token',user:{...user,id:'new-actor'}});await flush();
 expect(oldSignal.aborted).toBe(true);expect(reads).toBe(2);expect(f.calls[1].headers.get('Authorization')).toBe('Bearer new-actor-token');old.resolve(json({items:[]}));await flush();expect(root().hidden).toBe(true);expect(admitted).not.toHaveBeenCalled();
 next.resolve(json({items:[]}));await flush();expect(admitted).toHaveBeenCalledOnce();expect(root().hidden).toBe(false);expect(f.auth.user?.id).toBe('new-actor');expect(f.surface.location.replace).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it('checks the real protected grant with an explicitly accepted same-user session instead of redirecting its canceled recovery to Feishu',async()=>{
 const old=deferred<Response>(),f=gateFixture(call=>call.path.endsWith('/csrf')?json({csrfToken:'csrf'}):call.path.endsWith('/refresh')?old.promise:call.path.includes('/projects?')?json({items:[]}):(()=>{throw new Error('Unexpected login route '+call.path);})());f.auth.accept(session);vi.setSystemTime(Date.now()+16*60*1000);
 const admitted=f.gate.waitForSession();await flush();const canceled=f.calls.at(-1)!.signal;expect(f.calls.at(-1)!.path.endsWith('/refresh')).toBe(true);
 f.auth.accept({...session,accessToken:'explicit-fresh-token'});await admitted;expect(canceled.aborted).toBe(true);const protectedReads=f.calls.filter(call=>call.path.includes('/projects?'));expect(protectedReads).toHaveLength(1);expect(protectedReads[0].headers.get('Authorization')).toBe('Bearer explicit-fresh-token');expect(f.surface.location.replace).not.toHaveBeenCalled();expect(root().hidden).toBe(false);
 old.resolve(json({...session,accessToken:'late-old-token'}));await flush();expect(f.api.getAccessToken()).toBe('explicit-fresh-token');expect(vi.getTimerCount()).toBe(0);
});

it('cancels a hanging grant on disposal immediately and never repaints or redirects from its late result',async()=>{
 const old=deferred<Response>(),f=gateFixture(()=>old.promise);f.auth.accept(session);const entering=f.gate.enter();await flush();f.gate.disconnect();expect(await entering).toBe(false);expect(f.calls[0].signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);old.resolve(json({items:[]}));await flush();expect(document.getElementById('studio-tv-login-gate')).toBeNull();expect(f.surface.location.replace).not.toHaveBeenCalled();expect(f.surface.location.reload).not.toHaveBeenCalled();
});

it('keeps explicit signout visible when it cancels a hanging grant, without replacing it with a timeout or another Feishu login',async()=>{
 const old=deferred<Response>(),f=gateFixture(()=>old.promise);f.auth.accept(session);const entering=f.gate.enter();await flush();await f.gate.signOut(async()=>{f.auth.clear();});expect(await entering).toBe(false);expect(text()).toContain('已退出工作台');expect(root().hidden).toBe(true);old.resolve(json({items:[]}));await flush();expect(text()).toContain('已退出工作台');expect(f.surface.location.replace).not.toHaveBeenCalled();expect(f.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
});
