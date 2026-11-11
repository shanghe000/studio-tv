// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {AuthSession} from '../../apps/web/src/api/auth';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceLoginGate,safeLoginReturnTo} from '../../apps/web/src/api/login-gate';

// Local protocol fixtures only. No identity provider, production API, or model
// is called, and these test responses are never installed in service mode.
const user={id:'fixture-user',displayName:'Fixture user',avatarUrl:null,locale:'zh-CN',memberships:[],wallet:{currency:'CNY',amount:'0'},teamIds:[]};
const session={accessToken:'fixture-memory-token',tokenType:'Bearer' as const,expiresIn:900,user};
const configuration={provider:'IPAC_FEISHU',configured:true,loginUrl:'/api/v1/auth/feishu/login',unavailableReason:null};
const json=(status:number,data:unknown)=>new Response(JSON.stringify(status===200?{code:0,data}:data),{status,headers:{'Content-Type':'application/json'}});
const failure=(status:number,code:string)=>json(status,{error:{code,message:'Local test failure'}});
const dispose:Array<()=>void>=[];
beforeEach(()=>{document.body.innerHTML='<div id="root"><button>首页内容</button></div>';document.head.innerHTML='';window.sessionStorage.clear();});
afterEach(()=>{for(const release of dispose.splice(0))release();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules();});
function surface(path='/projects/'){
 const url=new URL(path,'http://studio.fixture'),location={origin:url.origin,pathname:url.pathname,search:url.search,hash:url.hash,replace:vi.fn(),reload:vi.fn()};
 const history={state:{fixture:true},replaceState:vi.fn((_state:unknown,_title:string,path:string)=>{const next=new URL(path,location.origin);Object.assign(location,{pathname:next.pathname,search:next.search,hash:next.hash});})};
 return{location,history,sessionStorage:window.sessionStorage,addEventListener:vi.fn(),removeEventListener:vi.fn()} as any;
}
function fixture(options:{path?:string;refresh?:()=>Response|Promise<Response>;projects?:()=>Response|Promise<Response>;config?:()=>Response|Promise<Response>;tab?:ReturnType<typeof surface>}={}){
 const transport=vi.fn(async(path:string,_init?:RequestInit)=>{
  if(path==='/api/v1/auth/csrf')return json(200,{csrfToken:'fixture-csrf'});
  if(path==='/api/v1/auth/sessions/refresh')return options.refresh?options.refresh():failure(401,'REFRESH_REVOKED');
  if(path==='/api/v1/projects?page=1&pageSize=1')return options.projects?options.projects():json(200,{items:[],page:1,pageSize:1,total:0});
  if(path==='/api/v1/auth/config')return options.config?options.config():json(200,configuration);
  if(path==='/api/v1/auth/session')return json(200,{revoked:true});
  throw new Error('Unregistered local fixture route: '+path);
 });
 const api=new ProductClient('/api/v1',transport as any),auth=new AuthSession(api),tab=options.tab??surface(options.path),gate=new ServiceLoginGate({api,auth},{surface:tab});
 api.onRevoked(error=>{gate.denied(error);auth.clear();});dispose.push(()=>gate.disconnect());
 auth.onClear(()=>api.clearRequests());
 return{api,auth,gate,tab,transport};
}
async function settle(){for(let index=0;index<12;index++)await Promise.resolve();}
const gateText=()=>document.getElementById('studio-tv-login-gate')?.textContent??'';

describe('service login admission',()=>{
 it.each(['/','/projects/','/projects/canvas/me/?folder=fixture','/project/canvas/fixture?tab=edit#node','/community/'])('blocks %s and redirects an anonymous session to the same-origin Feishu login',async(path)=>{
  const f=fixture({path});expect(document.getElementById('root')!.hidden).toBe(true);
  expect(await f.gate.enter()).toBe(false);expect(f.tab.location.replace).toHaveBeenCalledOnce();
  const destination=new URL(f.tab.location.replace.mock.calls[0][0],f.tab.location.origin),original=new URL(path,f.tab.location.origin);
  expect(destination.origin).toBe(f.tab.location.origin);expect(destination.pathname).toBe('/api/v1/auth/feishu/login');expect(destination.searchParams.get('returnTo')).toBe(original.pathname+original.search);expect(destination.hash).toBe('');
  expect(f.transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/auth/csrf','/api/v1/auth/sessions/refresh','/api/v1/auth/config']);expect(f.auth.user).toBeNull();expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it('admits a real restored identity only after the protected tv.access read, without another refresh',async()=>{
  let finish!:(value:Response)=>void;const protectedRead=new Promise<Response>(resolve=>finish=resolve),f=fixture({refresh:()=>json(200,session),projects:()=>protectedRead});
  const admitted=vi.fn(),waiting=f.gate.waitForSession().then(admitted);await settle();expect(f.auth.user?.id).toBe(user.id);expect(document.getElementById('root')!.hidden).toBe(true);expect(admitted).not.toHaveBeenCalled();
  finish(json(200,{items:[]}));await waiting;expect(admitted).toHaveBeenCalledOnce();expect(document.getElementById('root')!.hidden).toBe(false);expect(document.querySelector('#studio-tv-login-gate')).toBeNull();expect(f.tab.location.replace).not.toHaveBeenCalled();
  expect(f.transport.mock.calls.filter(call=>call[0].endsWith('/refresh'))).toHaveLength(1);expect(f.transport.mock.calls.filter(call=>call[0].includes('/projects?'))).toHaveLength(1);expect(f.api.getAccessToken()).toBe(session.accessToken);
 });
 it('keeps a callback failure in a manual retry state instead of repeating its automatic login',async()=>{
  const tab=surface('/project/canvas/fixture?tab=edit#node'),first=fixture({tab});await first.gate.enter();first.gate.disconnect();tab.location.replace.mockClear();
  const returned=fixture({tab});expect(await returned.gate.enter()).toBe(false);expect(tab.location.replace).not.toHaveBeenCalled();expect(gateText()).toContain('登录未完成');expect(returned.transport.mock.calls.some(call=>call[0].endsWith('/auth/config'))).toBe(false);
  document.querySelector<HTMLButtonElement>('#studio-tv-login-gate button')!.click();await settle();expect(tab.location.replace).toHaveBeenCalledOnce();
 });
 it('restores a tab fragment after a successful callback without sending the fragment to OAuth',async()=>{
  const tab=surface('/project/canvas/fixture?tab=edit#node-4'),first=fixture({tab});await first.gate.enter();first.gate.disconnect();tab.location.hash='';tab.location.replace.mockClear();
  const returned=fixture({tab,refresh:()=>json(200,session)});expect(await returned.gate.enter()).toBe(true);expect(tab.history.replaceState).toHaveBeenCalledWith({fixture:true},'','/project/canvas/fixture?tab=edit#node-4');expect(tab.location.hash).toBe('#node-4');expect(window.sessionStorage.getItem('studiotv-login-transition')).toBeNull();
 });
 it('keeps the original fragment through an unsuccessful callback and an explicit second login attempt',async()=>{
  const tab=surface('/project/canvas/fixture?tab=edit#node-4'),first=fixture({tab});await first.gate.enter();first.gate.disconnect();tab.location.hash='';tab.location.replace.mockClear();
  const failed=fixture({tab});await failed.gate.enter();expect(gateText()).toContain('登录未完成');document.querySelector<HTMLButtonElement>('#studio-tv-login-gate button')!.click();await vi.waitFor(()=>expect(tab.location.replace).toHaveBeenCalledOnce());failed.gate.disconnect();
  const returned=fixture({tab,refresh:()=>json(200,session)});expect(await returned.gate.enter()).toBe(true);expect(tab.history.replaceState).toHaveBeenCalledWith({fixture:true},'','/project/canvas/fixture?tab=edit#node-4');expect(tab.location.hash).toBe('#node-4');
 });
 it.each(['/login/','/auth/callback?code=fixture','/api/v1/auth/feishu/callback?error=access_denied','/projects/?error=access_denied'])('never auto-redirects an authentication failure route %s',async(path)=>{
  const f=fixture({path});await f.gate.enter();expect(f.tab.location.replace).not.toHaveBeenCalled();expect(gateText()).toContain('登录未完成');expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it.each([503,'network'])('keeps a temporary %s refresh failure separate from an anonymous 401',async(kind)=>{
  const f=fixture({path:'/project/canvas/fixture?tab=edit',refresh:()=>{if(kind==='network')throw new TypeError('Fixture network offline');return failure(503,'IPAC_UNAVAILABLE');}});
  expect(await f.gate.enter()).toBe(false);expect(f.tab.location.replace).not.toHaveBeenCalled();expect(f.transport.mock.calls.some(call=>call[0].endsWith('/auth/config'))).toBe(false);expect(gateText()).toContain('暂时无法恢复登录');expect(f.tab.location.pathname).toBe('/project/canvas/fixture');expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it('retries recovery after an outage and admits the original page once the real checks succeed',async()=>{
  let unavailable=true;const f=fixture({refresh:()=>unavailable?failure(503,'IPAC_UNAVAILABLE'):json(200,session)});await f.gate.enter();unavailable=false;document.querySelector<HTMLButtonElement>('#studio-tv-login-gate button')!.click();await f.gate.waitForSession();expect(f.auth.user?.id).toBe(user.id);expect(document.getElementById('root')!.hidden).toBe(false);expect(f.tab.location.replace).not.toHaveBeenCalled();
 });
 it.each(['IPAC_PERMISSION_DENIED','ACCOUNT_DISABLED'])('does not convert an authoritative %s refresh denial into anonymous auto-login',async(code)=>{
  const f=fixture({refresh:()=>failure(403,code)});expect(await f.gate.enter()).toBe(false);expect(f.auth.user).toBeNull();expect(f.tab.location.replace).not.toHaveBeenCalled();expect(gateText()).toContain('无法进入工作台');expect(f.transport.mock.calls.some(call=>call[0].endsWith('/auth/config'))).toBe(false);
 });
 it('preserves a protected-read 403 before ProductClient clears identity and does not begin an OAuth loop',async()=>{
  const f=fixture({refresh:()=>json(200,session),projects:()=>failure(403,'IPAC_PERMISSION_DENIED')});expect(await f.gate.enter()).toBe(false);await settle();expect(f.auth.user).toBeNull();expect(f.api.getAccessToken()).toBeNull();expect(gateText()).toContain('没有使用工作台的权限');expect(f.tab.location.replace).not.toHaveBeenCalled();expect(f.transport).toHaveBeenCalledTimes(3);
  document.querySelector<HTMLButtonElement>('#studio-tv-login-gate button')!.click();await settle();expect(f.tab.location.replace).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it('does not clear an established identity or redirect when the application permission service is temporarily unavailable',async()=>{
  const f=fixture({refresh:()=>json(200,session),projects:()=>failure(503,'IPAC_AUTHORIZATION_UNAVAILABLE')});expect(await f.gate.enter()).toBe(false);expect(f.auth.user?.id).toBe(user.id);expect(f.api.getAccessToken()).toBe(session.accessToken);expect(f.tab.location.replace).not.toHaveBeenCalled();expect(gateText()).toContain('暂时无法恢复登录');expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it('renews a short expired Bearer after a long admission outage instead of repeating Feishu for a valid refresh session',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));let unavailable=true,refreshes=0;
  const f=fixture({refresh:()=>json(200,{...session,accessToken:'fixture-token-'+(++refreshes)}),projects:()=>unavailable?failure(503,'IPAC_AUTHORIZATION_UNAVAILABLE'):json(200,{items:[]})});
  expect(await f.gate.enter()).toBe(false);expect(f.auth.user?.id).toBe(user.id);vi.setSystemTime(new Date('2026-10-07T00:16:00Z'));unavailable=false;
  expect(await f.gate.enter()).toBe(true);expect(refreshes).toBe(2);expect(f.api.getAccessToken()).toBe('fixture-token-2');expect(f.tab.location.replace).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(false);
 });
 it('checks the replacement identity after an aborted old admission read without OAuth or a permanently pending gate',async()=>{
  let finish!:(value:Response)=>void,calls=0;const oldRead=new Promise<Response>(resolve=>finish=resolve),f=fixture({projects:()=>++calls===1?oldRead:json(200,{items:[]})});f.auth.accept(session);
  const waiting=f.gate.waitForSession();await settle();expect(calls).toBe(1);const oldSignal=(f.transport.mock.calls[0][1] as RequestInit).signal!;
  f.auth.accept({...session,accessToken:'fixture-user-b-token',user:{...user,id:'fixture-user-b'}});expect(oldSignal.aborted).toBe(true);finish(json(200,{items:[]}));await waiting;
  expect(calls).toBe(2);const projectCalls=f.transport.mock.calls.filter(call=>call[0].includes('/projects?'));expect(new Headers(projectCalls[1][1]!.headers).get('Authorization')).toBe('Bearer fixture-user-b-token');expect(f.tab.location.replace).not.toHaveBeenCalled();expect(f.tab.location.reload).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(false);expect(f.auth.user?.id).toBe('fixture-user-b');
 });
 it('rechecks a newly accepted identity when the previous identity\'s refresh is still pending',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));let finish!:(value:Response)=>void;
  const refresh=new Promise<Response>(resolve=>finish=resolve),f=fixture({refresh:()=>refresh});f.auth.accept(session);vi.setSystemTime(new Date('2026-10-07T00:16:00Z'));
  const waiting=f.gate.waitForSession();await vi.waitFor(()=>expect(f.transport.mock.calls.some(call=>call[0].endsWith('/refresh'))).toBe(true));
  f.auth.accept({...session,accessToken:'fixture-user-b-token',user:{...user,id:'fixture-user-b'}});finish(json(200,session));await waiting;
  expect(f.auth.user?.id).toBe('fixture-user-b');expect(f.api.getAccessToken()).toBe('fixture-user-b-token');expect(f.transport.mock.calls.filter(call=>call[0].includes('/projects?'))).toHaveLength(1);expect(f.transport.mock.calls.some(call=>call[0].endsWith('/auth/config'))).toBe(false);expect(f.tab.location.replace).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(false);
 });
 it('reloads a previously admitted native document after an identity change rather than showing the old user\'s DOM',async()=>{
  const f=fixture({refresh:()=>json(200,session)});await f.gate.enter();document.getElementById('root')!.textContent='Fixture previous-user graph';f.auth.accept({...session,accessToken:'fixture-user-b-token',user:{...user,id:'fixture-user-b'}});
  expect(document.getElementById('root')!.hidden).toBe(true);await vi.waitFor(()=>expect(f.tab.location.reload).toHaveBeenCalledOnce());expect(f.tab.location.replace).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(true);expect(document.querySelector('#studio-tv-login-gate')).not.toBeNull();
 });
 it('fails closed when the login configuration is unavailable or points outside STUDIO',async()=>{
  const f=fixture({config:()=>json(200,{...configuration,loginUrl:'https://external.fixture/login'})});await f.gate.enter();expect(f.tab.location.replace).not.toHaveBeenCalled();expect(gateText()).toContain('暂时无法恢复登录');expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it('offers manual login if the browser cannot persist its automatic-loop guard',async()=>{
  const tab=surface();tab.sessionStorage={getItem:()=>null,setItem:()=>{throw new Error('Fixture storage denied');},removeItem:()=>{}};const f=fixture({tab});await f.gate.enter();expect(tab.location.replace).not.toHaveBeenCalled();expect(gateText()).toContain('使用飞书登录');
 });
 it('immediately hides an already mounted page when renewal clears the session and returns to the current SPA route',async()=>{
  const f=fixture({refresh:()=>json(200,session)});await f.gate.enter();Object.assign(f.tab.location,{pathname:'/projects/team/assets',search:'?folder=second',hash:'#item'});f.gate.denied(new ApiError(401,'IPAC_SESSION_REVOKED','Fixture expired'));f.auth.clear();expect(document.getElementById('root')!.hidden).toBe(true);await settle();expect(new URL(f.tab.location.replace.mock.calls[0][0],f.tab.location.origin).searchParams.get('returnTo')).toBe('/projects/team/assets?folder=second');
 });
 it('blocks newly mounted portals and leaves a live 403 denial on the current route',async()=>{
  const f=fixture({refresh:()=>json(200,session)});await f.gate.enter();f.gate.denied(new ApiError(403,'IPAC_PERMISSION_DENIED','Fixture revoked'));f.auth.clear();const portal=document.createElement('div');portal.textContent='Old signed-in portal';document.body.append(portal);await settle();expect(portal.hidden).toBe(true);expect(portal.inert).toBe(true);expect(gateText()).toContain('无法进入工作台');expect(f.tab.location.replace).not.toHaveBeenCalled();
 });
 it('preserves explicit signout without automatic login on clear or a subsequent page reload',async()=>{
  const f=fixture({refresh:()=>json(200,session)});await f.gate.enter();await f.gate.signOut(()=>f.auth.signOut());await settle();expect(gateText()).toContain('已退出工作台');expect(document.getElementById('root')!.hidden).toBe(true);expect(f.tab.location.replace).not.toHaveBeenCalled();f.gate.disconnect();
  const reload=fixture({tab:f.tab});await reload.gate.enter();expect(gateText()).toContain('已退出工作台');expect(f.tab.location.replace).not.toHaveBeenCalled();
 });
 it('does not hide or sign out a real identity when the explicit logout request fails',async()=>{
  const f=fixture({refresh:()=>json(200,session)});await f.gate.enter();await expect(f.gate.signOut(async()=>{throw new ApiError(503,'UPSTREAM_UNAVAILABLE','Fixture outage');})).rejects.toMatchObject({status:503});expect(f.auth.user?.id).toBe(user.id);expect(document.getElementById('root')!.hidden).toBe(false);expect(window.sessionStorage.getItem('studiotv-login-transition')).toBeNull();
 });
 it('fences a configuration response after disposal and never navigates from an abandoned gate',async()=>{
  let finish!:(value:Response)=>void;const config=new Promise<Response>(resolve=>finish=resolve),f=fixture({config:()=>config});const entering=f.gate.enter();await settle();f.gate.disconnect();finish(json(200,configuration));await entering;expect(f.tab.location.replace).not.toHaveBeenCalled();expect(document.querySelector('#studio-tv-login-gate')).toBeNull();expect(document.getElementById('root')!.hidden).toBe(false);
 });
});

describe('login return boundary',()=>{
 it.each(['https://external.fixture/','//external.fixture/','/\\external.fixture/','/%2f%2fexternal.fixture/','/%5cexternal.fixture/','/projects/\r\nheader','/%0d%0a','/projects/#node','/api/v1/auth/feishu/login','/api/v1/auth/feishu/callback?code=fixture','/login/','/auth/refresh','/project/../auth/callback','/'+'a'.repeat(4096)])('rejects an unsafe backend return target %s',raw=>{expect(safeLoginReturnTo(raw)).toBe(false);});
 it.each(['/','/projects/?folder=fixture&sort=NEWEST','/project/canvas/fixture?tab=edit','/projects/?search=%E5%9B%A2%E9%98%9F'])('accepts the original safe path and query %s',raw=>{expect(safeLoginReturnTo(raw)).toBe(true);});
});

describe('bootstrap ordering',()=>{
 function mockBootstrap(f:ReturnType<typeof fixture>,features:(flags:any,notice:(message:string)=>void)=>{blocked:boolean},native:()=>unknown,ready=vi.fn(async()=>{})){
  document.getElementById('root')!.replaceChildren();f.gate.disconnect();let installed!:ServiceLoginGate;
  vi.spyOn(window.location,'replace').mockImplementation(()=>{});
  vi.doMock('../../apps/web/src/config',()=>({config:{mode:'service',apiBase:'/api/v1',features:{community:false,billing:false,publicSharing:false,marketing:false,externalLinks:false}}}));
  vi.doMock('../../apps/web/src/api/login-gate',()=>({ServiceLoginGate,safeLoginReturnTo}));
  vi.doMock('../../apps/web/src/service/runtime',()=>({serviceRuntime:{api:f.api,auth:f.auth,ready,bindLoginGate:(gate:ServiceLoginGate)=>{installed=gate;dispose.push(()=>gate.disconnect());f.api.onRevoked(error=>{gate.denied(error);f.auth.clear();});}}}));
  vi.doMock('../../apps/web/src/features/internal-ui',()=>({installFeatureUi:features}));
  vi.doMock('../../apps/web/src/brand/install',()=>({installStudioBrand:vi.fn()}));
  vi.doMock('../../apps/web/src/brand/pet',()=>({installStudioPet:vi.fn()}));
  vi.doMock('../../apps/web/src/browser-compat',async()=>{const actual=await vi.importActual<any>('../../apps/web/src/browser-compat');return{...actual,installBrowserCompatibility:vi.fn()};});
  vi.doMock('../../apps/web/src/canvas/minimap-navigation',()=>({installMinimapNavigation:vi.fn()}));
  vi.doMock('../../apps/web/src/runtime/native-bootstrap.js',async()=>{await native();return{};});
  return{get installed(){return installed;},ready};
 }
 function mountFixtureNativePage(){const main=document.createElement('main');main.textContent='Local fixture mounted workbench';document.getElementById('root')!.replaceChildren(main);}
 it.each(['anonymous','denied','unavailable'])('does not mount feature policy or native UI before %s admission succeeds',async(kind)=>{
  let recovered=false;
  const f=fixture({refresh:()=>!recovered&&kind==='anonymous'?failure(401,'REFRESH_REVOKED'):!recovered&&kind==='unavailable'?failure(503,'IPAC_UNAVAILABLE'):json(200,session),projects:()=>!recovered&&kind==='denied'?failure(403,'IPAC_PERMISSION_DENIED'):json(200,{items:[]})});
  const features=vi.fn(()=>({blocked:false})),native=vi.fn(mountFixtureNativePage),boot=mockBootstrap(f,features,native);
  const startup=import('../../apps/web/src/bootstrap');await vi.waitFor(()=>expect(boot.installed).toBeDefined());await vi.waitFor(()=>expect(f.transport.mock.calls.length).toBeGreaterThanOrEqual(kind==='denied'?3:2));await settle();
  expect(features).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();expect(boot.ready).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(true);expect(document.getElementById('root')!.childElementCount).toBe(0);
  recovered=true;expect(await boot.installed.enter()).toBe(true);await startup;
  expect(boot.ready).toHaveBeenCalledOnce();expect(features).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledOnce();expect(document.getElementById('root')!.hidden).toBe(false);expect(document.getElementById('root')!.textContent).toBe('Local fixture mounted workbench');expect(document.getElementById('studio-tv-shell-loading')).toBeNull();
 });
 it('shows the actual disabled-feature aside without waiting for an empty React root or a loading timeout',async()=>{
  const previous=window.location.pathname+window.location.search+window.location.hash;window.history.replaceState({},'','/projects/canvas/camp');
  const {installFeatureUi}=await vi.importActual<typeof import('../../apps/web/src/features/internal-ui')>('../../apps/web/src/features/internal-ui');
  const oldOpen=window.open,oldPush=window.history.pushState,oldReplace=window.history.replaceState;
  const documentEvents=vi.spyOn(document,'addEventListener'),windowEvents=vi.spyOn(window,'addEventListener');
  dispose.push(()=>{for(const [type,listener,options]of documentEvents.mock.calls)document.removeEventListener(type,listener,options);for(const [type,listener,options]of windowEvents.mock.calls)window.removeEventListener(type,listener,options);window.open=oldOpen;window.history.pushState=oldPush;window.history.replaceState=oldReplace;oldReplace.call(window.history,{},'',previous);});
  const features=vi.fn((flags:any,notice:any)=>{const policy=installFeatureUi(flags,notice);dispose.push(policy.disconnect);return policy;}),native=vi.fn(),f=fixture({refresh:()=>json(200,session)}),boot=mockBootstrap(f,features,native);
  const frame=vi.spyOn(window,'requestAnimationFrame');await import('../../apps/web/src/bootstrap');
  expect(boot.ready).toHaveBeenCalledOnce();expect(features).toHaveBeenCalledOnce();expect(native).not.toHaveBeenCalled();expect(frame).not.toHaveBeenCalled();expect(document.getElementById('root')!.childElementCount).toBe(0);
  const aside=document.getElementById('rhtv-feature-blocked')!;expect(aside.tagName).toBe('ASIDE');expect(aside.textContent).toContain('此功能未启用');expect(aside.hidden).toBe(false);expect(aside.inert).toBe(false);expect(document.getElementById('studio-tv-shell-loading')).toBeNull();expect(document.getElementById('studio-tv-login-gate')).toBeNull();
 });
 it('retains loading through a delayed native import and removes it only after a real root commit and the next paint',async()=>{
  let finishNative!:()=>void;const pendingNative=new Promise<void>(resolve=>finishNative=resolve),native=vi.fn(async()=>{await pendingNative;mountFixtureNativePage();}),features=vi.fn(()=>({blocked:false})),f=fixture({refresh:()=>json(200,session)}),boot=mockBootstrap(f,features,native);
  const frames=new Map<number,FrameRequestCallback>();let nextFrame=0;vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.set(++nextFrame,callback);return nextFrame;});vi.spyOn(window,'cancelAnimationFrame').mockImplementation(id=>{frames.delete(id);});
  const settled=vi.fn(),startup=import('../../apps/web/src/bootstrap').then(settled);await vi.waitFor(()=>expect(native).toHaveBeenCalledOnce());
  expect(boot.ready).toHaveBeenCalledOnce();expect(f.auth.user?.id).toBe(user.id);expect(document.getElementById('studio-tv-login-gate')).toBeNull();expect(document.getElementById('root')!.childElementCount).toBe(0);expect(document.getElementById('studio-tv-shell-loading')?.textContent).toContain('正在加载工作台');expect(settled).not.toHaveBeenCalled();expect(frames.size).toBe(0);
  finishNative();await vi.waitFor(()=>expect(frames.size).toBe(1));expect(document.getElementById('root')!.textContent).toBe('Local fixture mounted workbench');expect(document.getElementById('studio-tv-shell-loading')).not.toBeNull();expect(settled).not.toHaveBeenCalled();
  const paint=[...frames.values()];frames.clear();for(const callback of paint)callback(0);await startup;
  expect(settled).toHaveBeenCalledOnce();expect(document.getElementById('studio-tv-shell-loading')).toBeNull();expect(document.getElementById('root')!.hidden).toBe(false);expect(document.getElementById('root')!.inert).toBe(false);expect(window.location.replace).not.toHaveBeenCalled();
 });
 it('finishes a native import that arrives after the 60-second recovery option without reloading',async()=>{
  vi.useFakeTimers();
  let finishNative!:()=>void;const pendingNative=new Promise<void>(resolve=>finishNative=resolve),native=vi.fn(async()=>{await pendingNative;mountFixtureNativePage();}),f=fixture({refresh:()=>json(200,session)}),boot=mockBootstrap(f,()=>({blocked:false}),native);
  const reload=vi.spyOn(window.location,'reload').mockImplementation(()=>{}),startup=import('../../apps/web/src/bootstrap');await vi.waitFor(()=>expect(boot.ready).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(native).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(60000);expect(document.getElementById('studio-tv-shell-loading')?.textContent).toContain('重新加载');expect(reload).not.toHaveBeenCalled();
  finishNative();await vi.waitFor(()=>expect(document.getElementById('root')!.textContent).toBe('Local fixture mounted workbench'));await vi.advanceTimersByTimeAsync(32);await startup;expect(reload).not.toHaveBeenCalled();expect(document.getElementById('studio-tv-shell-loading')).toBeNull();
 });
 it('retries initial canvas preparation in place after repeated transient failures',async()=>{
  const {ApiError:BootstrapApiError}=await import('../../apps/web/src/api/client');
  const ready=vi.fn().mockRejectedValueOnce(new BootstrapApiError(503,'UPSTREAM_UNAVAILABLE','initial outage')).mockRejectedValueOnce(new BootstrapApiError(502,'INVALID_RESPONSE','服务器返回了无法识别的响应。')).mockResolvedValue(undefined),f=fixture({refresh:()=>json(200,session)}),native=vi.fn(mountFixtureNativePage);mockBootstrap(f,()=>({blocked:false}),native,ready);
  const reload=vi.spyOn(window.location,'reload').mockImplementation(()=>{}),startup=import('../../apps/web/src/bootstrap');await vi.waitFor(()=>expect(document.getElementById('studio-tv-shell-loading')?.textContent).toContain('立即重试'));expect(native).not.toHaveBeenCalled();document.querySelector<HTMLButtonElement>('#studio-tv-shell-loading button')!.click();await vi.waitFor(()=>expect(ready).toHaveBeenCalledTimes(2));await vi.waitFor(()=>expect(document.querySelector<HTMLButtonElement>('#studio-tv-shell-loading button')?.disabled).toBe(false));document.querySelector<HTMLButtonElement>('#studio-tv-shell-loading button')!.click();await startup;expect(ready).toHaveBeenCalledTimes(3);expect(native).toHaveBeenCalledOnce();expect(reload).not.toHaveBeenCalled();expect(document.getElementById('studio-tv-shell-loading')).toBeNull();
 });
});
