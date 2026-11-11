import {describe,it,expect,vi} from 'vitest';
import {ApiClient,ApiError} from '../../apps/web/src/api/client';
import {AuthSession} from '../../apps/web/src/api/auth';
const user={id:'u',displayName:'Owner',avatarUrl:null,locale:'zh-CN',memberships:[],wallet:{currency:'USD',amount:'0.000000'},teamIds:[]};
const session={accessToken:'server-signed-token-value',tokenType:'Bearer',expiresIn:900,user};
const json=(status:number,data:any)=>new Response(JSON.stringify(data),{status});
describe('real session lifecycle',()=>{
 it('coalesces simultaneous restores and uses the exact refresh contract with a CSRF header',async()=>{
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(200,{code:0,data:session}));
  const auth=new AuthSession(new ApiClient('/api/v1',transport));
  expect(await Promise.all([auth.restore(),auth.restore()])).toEqual([true,true]);
  expect(transport.mock.calls.filter(call=>call[0]==='/api/v1/auth/sessions/refresh')).toHaveLength(1);
  const refresh=transport.mock.calls.find(call=>call[0]==='/api/v1/auth/sessions/refresh')![1];
  expect(refresh.headers.get('X-CSRF-Token')).toBe('csrf-context-value');
  expect(refresh.headers.get('Authorization')).toBeNull();
  expect(auth.user?.id).toBe('u');
 });
 it('clears real identity after the CSRF-protected session logout',async()=>{
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(200,{code:0,data:{accepted:true}}));
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  await auth.signOut();expect(auth.user).toBeNull();expect(api.getAccessToken()).toBeNull();
  const logout=transport.mock.calls.find(call=>call[0]==='/api/v1/auth/session')![1];expect(logout.method).toBe('DELETE');expect(logout.headers.get('X-CSRF-Token')).toBe('csrf-context-value');expect(logout.headers.get('Authorization')).toBe('Bearer '+session.accessToken);
 });
 it('does not restore an old identity from a refresh response arriving after logout',async()=>{
  let complete!:(response:Response)=>void,started!:()=>void;
  const refreshStarted=new Promise<void>(resolve=>started=resolve);
  const transport=vi.fn().mockImplementation(async(path:string)=>{
   if(path.endsWith('/csrf'))return json(200,{code:0,data:{csrfToken:'csrf-context-value'}});
   if(path.endsWith('/sessions/refresh')){started();return new Promise<Response>(resolve=>complete=resolve);}
   return json(200,{code:0,data:{accepted:true}});
  });
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  const cleared=vi.fn();auth.onClear(cleared);
  const restoring=auth.restore();await refreshStarted;
  await auth.signOut();complete(json(200,{code:0,data:{...session,accessToken:'late-old-session-token'}}));
  expect(await restoring).toBe(false);expect(auth.user).toBeNull();expect(api.getAccessToken()).toBeNull();expect(cleared).toHaveBeenCalledTimes(1);
 });
 it('keeps the current identity when logout fails and never refreshes to retry it',async()=>{
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(401,{error:{code:'LOGOUT_DENIED',message:'退出请求失败。'}}));
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  const cleared=vi.fn();auth.onClear(cleared);
  await expect(auth.signOut()).rejects.toMatchObject({status:401});
  expect(auth.user?.id).toBe(user.id);expect(api.getAccessToken()).toBe(session.accessToken);expect(cleared).not.toHaveBeenCalled();
  expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v1/auth/csrf','/api/v1/auth/session']);
 });
 it('discards cached canvas state when a shared restore reports a revoked session',async()=>{
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(401,{code:'IPAC_SESSION_REVOKED',message:'请重新登录。'}));
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  let canvas:string|null='project-old';
  const cleared=vi.fn(()=>{expect(auth.user).toBeNull();expect(api.getAccessToken()).toBeNull();canvas=null;});
  auth.onClear(cleared);
  expect(await Promise.all([auth.restore(),auth.restore()])).toEqual([false,false]);
  expect(cleared).toHaveBeenCalledTimes(1);expect(canvas).toBeNull();
 });
 it('keeps an existing identity on a temporary upstream failure',async()=>{
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(503,{code:'IPAC_UNAVAILABLE',message:'请稍后重试。'}));
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  const cleared=vi.fn();auth.onClear(cleared);
  await expect(auth.restore()).rejects.toMatchObject({status:503,code:'IPAC_UNAVAILABLE'} satisfies Partial<ApiError>);
  expect(auth.user?.id).toBe('u');expect(api.getAccessToken()).toBe(session.accessToken);expect(cleared).not.toHaveBeenCalled();
 });
 it('discards previous-user state before accepting an account changed in another tab',async()=>{
  const switched={...session,accessToken:'new-person-token',user:{...user,id:'new-person'}};
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(200,{code:0,data:switched}));
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  const previousGraphs=new Map([['project-old-person',{owner:'u'}]]);
  const cleared=vi.fn(()=>{expect(auth.user).toBeNull();expect(api.getAccessToken()).toBeNull();previousGraphs.clear();});
  auth.onClear(cleared);
  expect(await auth.restore()).toBe(true);expect(cleared).toHaveBeenCalledTimes(1);expect(previousGraphs.size).toBe(0);expect(auth.user?.id).toBe('new-person');expect(api.getAccessToken()).toBe('new-person-token');
 });
 it('refuses a replacement identity if previous-user state could not be cleared',()=>{
  const api=new ApiClient('/api/v1',vi.fn()),auth=new AuthSession(api);auth.accept(session);
  auth.onClear(()=>{throw new Error('test-only cache cleanup failure');});
  expect(()=>auth.accept({...session,accessToken:'new-person-token',user:{...user,id:'new-person'}})).toThrow('会话数据清理失败');
  expect(auth.user).toBeNull();expect(api.getAccessToken()).toBeNull();
 });
 it('reports cleanup failure while refusing a replacement identity from refresh',async()=>{
  const switched={...session,accessToken:'new-person-token',user:{...user,id:'new-person'}};
  const transport=vi.fn().mockImplementation(async(path:string)=>path.endsWith('/csrf')?json(200,{code:0,data:{csrfToken:'csrf-context-value'}}):json(200,{code:0,data:switched}));
  const api=new ApiClient('/api/v1',transport),auth=new AuthSession(api);auth.accept(session);
  auth.onClear(()=>{throw new Error('test-only cache cleanup failure');});
  await expect(auth.restore()).rejects.toThrow('会话数据清理失败');
  expect(auth.user).toBeNull();expect(api.getAccessToken()).toBeNull();
 });
 it('allows observers to unsubscribe and does not let one observer block other cleanup',()=>{
  const auth=new AuthSession(new ApiClient('/api/v1',vi.fn()));auth.accept(session);
  const stopped=vi.fn(),cleanup=vi.fn();const unsubscribe=auth.onClear(stopped);unsubscribe();
  auth.onClear(()=>{throw new Error('optional observer failed');});auth.onClear(cleanup);
  expect(()=>auth.clear()).toThrow('会话数据清理失败');expect(stopped).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledTimes(1);expect(auth.user).toBeNull();expect(auth.api.getAccessToken()).toBeNull();
 });
});
import {loginDestination,loginUnavailableMessage} from '../../apps/web/src/api/feishu-ui';
it('builds only a same-origin Feishu entry with a safe return path and no token',()=>{
 const configuration={provider:'IPAC_FEISHU' as const,configured:true,loginUrl:'/api/v1/auth/feishu/login',unavailableReason:null};
 const value=loginDestination(configuration,'/project/canvas/p?tab=edit','https://internal.example');
 expect(value).toBe('/api/v1/auth/feishu/login?returnTo=%2Fproject%2Fcanvas%2Fp%3Ftab%3Dedit');
 expect(()=>loginDestination(configuration,'//external.example','https://internal.example')).toThrow('返回地址');
 expect(()=>loginDestination({...configuration,loginUrl:'https://external.example/login'},'/projects/','https://internal.example')).toThrow('登录服务地址');
 expect(()=>loginDestination({...configuration,configured:false,unavailableReason:'缺少飞书接入配置'},'/projects/','https://internal.example')).toThrow('统一登录尚未配置');
});

it('maps operational Feishu reasons into user-facing language',()=>{expect(loginUnavailableMessage('IPAC_SESSION_STATUS_UNAVAILABLE')).toBe('统一登录服务暂时不可用，请稍后重试。');expect(loginUnavailableMessage('IPAC_NOT_CONFIGURED')).toBe('统一登录尚未配置，请联系管理员。');expect(loginUnavailableMessage('unknown internal detail')).not.toContain('internal');});

it('keeps a temporarily unavailable IPAC login disabled without exposing its protocol reason',()=>{
 const configuration={provider:'IPAC_FEISHU' as const,configured:false,loginUrl:'/api/v1/auth/feishu/login',unavailableReason:'IPAC_SESSION_STATUS_UNAVAILABLE'};
 expect(()=>loginDestination(configuration,'/projects/','https://internal.example')).toThrow('统一登录服务暂时不可用，请稍后重试。');
 expect(loginUnavailableMessage(null)).toBe('统一登录尚未配置，请联系管理员。');
});
