import {describe,it,expect,vi} from 'vitest';
import {ApiClient,ApiError} from '../../apps/web/src/api/client';
function reply(status:number,data:any,etag?:string){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...(etag?{ETag:etag}:{})}});}
describe('API client',()=>{
 it('calls normal business APIs without adding an IPAC workspace selection header',async()=>{
  const transport=vi.fn().mockImplementation(async()=>reply(200,{code:0,data:{}}));
  const api=new ApiClient('/api/v1',transport);api.setAccessToken('real-session-token');
  for(const path of ['/projects','/assets','/asset-uploads'])await api.request(path);
  expect(transport.mock.calls.map(call=>call[1].headers.get('X-Workspace-Id'))).toEqual([null,null,null]);
 });
 it('uses Bearer in memory and preserves same logical mutation key across refresh retry',async()=>{
  const transport=vi.fn().mockResolvedValueOnce(reply(401,{code:'UNAUTHORIZED',message:'expired'})).mockResolvedValueOnce(reply(201,{code:0,data:{id:'server-id'}}));
  const api=new ApiClient('/api/v1',transport);api.setAccessToken('old');api.onRefresh(async()=>{api.setAccessToken('new');return true;});
  const result=await api.request('/projects',{method:'POST',body:{name:'Test'},idempotencyKey:'11ff4e0c-7a54-4026-a8ed-1e937e99ae22'});
  expect(result.data).toEqual({id:'server-id'});
  const first=transport.mock.calls[0][1],second=transport.mock.calls[1][1];
  expect(first.headers.get('Idempotency-Key')).toBe(second.headers.get('Idempotency-Key'));
  expect(second.headers.get('Authorization')).toBe('Bearer new');
  expect(second.credentials).toBe('same-origin');
 });
 it('makes version conflicts visible without automatic overwrite or success fallback',async()=>{
  const transport=vi.fn().mockResolvedValue(reply(412,{code:'VERSION_CONFLICT',message:'Changed elsewhere',requestId:'req_1'}));
  const api=new ApiClient('/api/v1',transport);
  await expect(api.request('/projects/p/snapshot',{method:'PUT',body:{graph:{}},etag:'"3"'})).rejects.toMatchObject({status:412,code:'VERSION_CONFLICT'});
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][1].headers.get('If-Match')).toBe('"3"');
 });
 it('does not turn invalid service responses into preview success',async()=>{
  const api=new ApiClient('/api/v1',vi.fn().mockResolvedValue(new Response('<html>',{status:503})));
  await expect(api.request('/me')).rejects.toBeInstanceOf(ApiError);
 });
});
