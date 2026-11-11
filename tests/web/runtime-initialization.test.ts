import {afterEach,beforeEach,expect,it,vi} from 'vitest';

const {restoreState,runtimeConfig}=vi.hoisted(()=>({restoreState:{error:null as Error|null},runtimeConfig:{apiBase:'/api/v1',edition:'internal',features:{community:false,billing:false,publicSharing:false,marketing:false,externalLinks:false}}}));
vi.mock('../../apps/web/src/config',()=>({config:runtimeConfig}));
vi.mock('../../apps/web/src/api/auth',()=>({
 AuthSession:class {user:any=null;restore=async()=>{if(restoreState.error)throw restoreState.error;return false;};onClear=()=>{};clear=()=>{};signOut=async()=>{};},
 installNativeSessionBridge:()=>{},
}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));

beforeEach(()=>{restoreState.error=null;vi.resetModules();runtimeConfig.edition='internal';runtimeConfig.features.externalLinks=false;});
afterEach(()=>{vi.unstubAllGlobals();});

async function runtime(){
 const transport=vi.fn(),notice=vi.fn();
 vi.stubGlobal('location',{pathname:'/projects/',search:'',hash:''});
 vi.stubGlobal('window',{fetch:transport,addEventListener:vi.fn(),__RHTV_PREVIEW__:{notice}});
 vi.stubGlobal('document',{addEventListener:vi.fn()});
 const {serviceRuntime}=await import('../../apps/web/src/service/runtime');
 await serviceRuntime.ready();
 return{serviceRuntime,transport,notice};
}

it('rejects retired internal mount probes before authentication without fabricating config or identity',async()=>{
 const {serviceRuntime,transport,notice}=await runtime();
 for(const path of ['/api/system/getConfig','/uc/client/ipAndCountry']){
  await expect(serviceRuntime.handle(path,{})).rejects.toMatchObject({status:403,code:'FEATURE_DISABLED'});
 }
 expect(serviceRuntime.auth.user).toBeNull();expect(transport).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();
});

it('keeps the same explicit disabled result when a real internal user is already signed in',async()=>{
 const {serviceRuntime,transport}=await runtime();serviceRuntime.auth.user={id:'actual-owner'} as any;
 for(const path of ['/api/system/getConfig','/uc/client/ipAndCountry'])await expect(serviceRuntime.handle(path,{})).rejects.toMatchObject({status:403,code:'FEATURE_DISABLED'});
 expect(await serviceRuntime.handle('/uc/getUserInfo',{})).toMatchObject({code:0,data:{id:'actual-owner'}});
 expect(transport).not.toHaveBeenCalled();
});

it('preserves authentication and explicit missing-service failures outside the internal edition',async()=>{
 runtimeConfig.edition='external';const {serviceRuntime,transport}=await runtime();
 for(const path of ['/api/system/getConfig','/uc/client/ipAndCountry'])await expect(serviceRuntime.handle(path,{})).rejects.toMatchObject({status:401,code:'UNAUTHORIZED'});
 serviceRuntime.auth.user={id:'actual-owner'} as any;
 for(const path of ['/api/system/getConfig','/uc/client/ipAndCountry'])await expect(serviceRuntime.handle(path,{})).rejects.toMatchObject({status:501,code:'NOT_IMPLEMENTED'});
 expect(transport).not.toHaveBeenCalled();
});

it('does not suppress unrelated initialization failures with the retired-probe policy',async()=>{
 const {serviceRuntime}=await runtime();
 await expect(serviceRuntime.handle('/api/system/anotherConfig',{})).rejects.toMatchObject({status:401,code:'UNAUTHORIZED'});
 serviceRuntime.auth.user={id:'actual-owner'} as any;
 await expect(serviceRuntime.handle('/api/system/anotherConfig',{})).rejects.toMatchObject({status:501,code:'NOT_IMPLEMENTED'});
});

it('authenticates the STUDIO team probe and returns only real STUDIO memberships without enabling external features',async()=>{
 const {serviceRuntime,transport,notice}=await runtime();
 await expect(serviceRuntime.handle('/uc/team/my-teams',{})).rejects.toMatchObject({status:401,code:'UNAUTHORIZED'});expect(transport).not.toHaveBeenCalled();
 serviceRuntime.auth.user={id:'actual-owner'} as any;
 serviceRuntime.api.setAccessToken('studio-user');
 transport.mockResolvedValue(new Response(JSON.stringify({code:0,data:{items:[{id:'real-team',ownerId:'other',name:'Real STUDIO team',role:'VIEWER',revision:2}],page:1,pageSize:100,total:1,hasMore:false}}),{status:200}));
 expect(await serviceRuntime.handle('/uc/team/my-teams',{})).toMatchObject({code:0,data:[{teamId:'real-team',name:'Real STUDIO team',role:'VIEWER',isCurrent:false}]});expect(transport.mock.calls[0][0]).toBe('/api/v2/collaboration/teams?page=1&pageSize=100');expect(runtimeConfig.features.billing).toBe(false);expect(runtimeConfig.features.externalLinks).toBe(false);expect(notice).not.toHaveBeenCalled();
});

it('preserves a STUDIO team service failure instead of replacing it with an empty successful list',async()=>{
 runtimeConfig.features.externalLinks=true;const {serviceRuntime,transport}=await runtime();serviceRuntime.auth.user={id:'actual-owner'} as any;
 serviceRuntime.api.setAccessToken('studio-user');
 transport.mockResolvedValue(new Response(JSON.stringify({error:{code:'UPSTREAM_UNAVAILABLE',message:'Unavailable'}}),{status:503}));await expect(serviceRuntime.handle('/uc/team/my-teams',{})).rejects.toMatchObject({status:503,code:'UPSTREAM_UNAVAILABLE'});expect(transport).toHaveBeenCalledOnce();
});

it('keeps a cold identity-service 503 as a recoverable startup failure without redirecting a canvas to Feishu login',async()=>{
 restoreState.error=new Error('temporary IPAC outage');const events=vi.fn(),replace=vi.fn();vi.stubGlobal('location',{pathname:'/project/canvas/p',search:'',hash:''});vi.stubGlobal('history',{replaceState:replace});vi.stubGlobal('window',{fetch:vi.fn(),addEventListener:events,__RHTV_PREVIEW__:{notice:vi.fn()}});vi.stubGlobal('document',{addEventListener:vi.fn()});const {serviceRuntime}=await import('../../apps/web/src/service/runtime');await expect(serviceRuntime.ready()).rejects.toMatchObject({status:503,code:'SESSION_RECOVERY_UNAVAILABLE'});expect(replace).not.toHaveBeenCalled();expect(events.mock.calls.filter(call=>call[0]==='rhtv:native-ready')).toHaveLength(0);expect(location.pathname).toBe('/project/canvas/p');
});

it('opens the requested deep link after a single malformed canvas response without redirecting',async()=>{
 vi.useFakeTimers();
 try{
  const {serviceRuntime,notice}=await runtime(),replace=vi.fn();
  vi.stubGlobal('history',{replaceState:replace});location.pathname='/project/canvas/p';
  serviceRuntime.auth.user={id:'owner'} as any;
  const {ApiError}=await import('../../apps/web/src/api/client');
  const load=vi.spyOn(serviceRuntime.storage,'loadProject').mockRejectedValueOnce(new ApiError(502,'INVALID_RESPONSE','proxy')).mockResolvedValue({id:'p'} as any);
  const ready=serviceRuntime.ready();await vi.advanceTimersByTimeAsync(500);await ready;
  expect(load).toHaveBeenCalledTimes(2);expect(replace).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();expect(location.pathname).toBe('/project/canvas/p');
 }finally{vi.useRealTimers();}
});
