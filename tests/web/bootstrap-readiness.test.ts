// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {prepareServiceBootstrap,retryableBootstrapRead} from '../../apps/web/src/runtime/bootstrap-readiness';

beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
function fixture(){
 const controller=new AbortController(),surface=new EventTarget(),state={current:true,route:true,online:true},waiting=vi.fn(),attempting=vi.fn();
 const options={signal:controller.signal,current:()=>state.current,retryCurrent:()=>state.route,waiting,attempting,surface:surface as any,online:()=>state.online};
 return{controller,surface,state,waiting,attempting,options};
}
const outage=()=>new ApiError(503,'UPSTREAM_UNAVAILABLE','暂时不可用');

describe('initial bootstrap preparation recovery',()=>{
 it('automatically retries a completed transient failure without reloading the page',async()=>{
  const f=fixture(),work=vi.fn().mockRejectedValueOnce(outage()).mockResolvedValue(undefined),ready=prepareServiceBootstrap(work,f.options);await vi.advanceTimersByTimeAsync(0);expect(f.waiting).toHaveBeenCalledOnce();expect(work).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1000);await ready;expect(work).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
 it.each([[503,'DB_POOL_EXHAUSTED'],[504,'EDGE_GATEWAY_WAIT']] as const)('retries a decoded HTTP %s response with service-specific code %s and opens after recovery',async(status,code)=>{
  const f=fixture(),transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code:1,error:{code,message:'temporary service outage'}}),{status})).mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:{ready:true}}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');
  const work=vi.fn(async()=>{await api.requestV2('/collaboration/projects/p/access');}),ready=prepareServiceBootstrap(work,f.options);
  await vi.advanceTimersByTimeAsync(0);expect(f.waiting).toHaveBeenCalledOnce();expect(work).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1000);await ready;expect(work).toHaveBeenCalledTimes(2);expect(transport).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
 it('never overlaps an unresolved initial read even after a long wait or online event',async()=>{
  const f=fixture();let finish!:()=>void;const work=vi.fn(()=>new Promise<void>(resolve=>finish=resolve)),ready=prepareServiceBootstrap(work,f.options);await vi.advanceTimersByTimeAsync(120000);f.surface.dispatchEvent(new Event('online'));expect(work).toHaveBeenCalledOnce();expect(f.waiting).not.toHaveBeenCalled();finish();await ready;
 });
 it('waits quietly offline and retries as soon as connectivity returns',async()=>{
  const f=fixture();f.state.online=false;const work=vi.fn().mockRejectedValueOnce(outage()).mockResolvedValue(undefined),ready=prepareServiceBootstrap(work,f.options);await vi.advanceTimersByTimeAsync(60000);expect(work).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);f.state.online=true;f.surface.dispatchEvent(new Event('online'));await ready;expect(work).toHaveBeenCalledTimes(2);
 });
 it('allows one immediate user retry and coalesces timer and online signals',async()=>{
  const f=fixture(),work=vi.fn().mockRejectedValueOnce(outage()).mockResolvedValue(undefined),ready=prepareServiceBootstrap(work,f.options);await vi.advanceTimersByTimeAsync(0);const retry=f.waiting.mock.calls[0][0];retry();retry();f.surface.dispatchEvent(new Event('online'));await ready;await vi.advanceTimersByTimeAsync(20000);expect(work).toHaveBeenCalledTimes(2);
 });
 it.each(['identity','route','abort'])('never retries after %s changes',async(kind)=>{
  const f=fixture(),work=vi.fn().mockRejectedValue(outage()),ready=prepareServiceBootstrap(work,f.options),rejected=expect(ready).rejects.toMatchObject({name:'AbortError'});await vi.advanceTimersByTimeAsync(0);if(kind==='identity')f.state.current=false;else if(kind==='route')f.state.route=false;else f.controller.abort();await vi.advanceTimersByTimeAsync(1000);await rejected;f.waiting.mock.calls[0][0]();f.surface.dispatchEvent(new Event('online'));expect(work).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('releases admission immediately on auth clear and ignores the late old request result',async()=>{
  const f=fixture();let finish!:()=>void;const work=vi.fn(()=>new Promise<void>(resolve=>finish=resolve)),ready=prepareServiceBootstrap(work,f.options),rejected=expect(ready).rejects.toMatchObject({name:'AbortError'});await vi.advanceTimersByTimeAsync(0);f.controller.abort();await rejected;finish();await vi.advanceTimersByTimeAsync(0);expect(work).toHaveBeenCalledOnce();expect(f.waiting).not.toHaveBeenCalled();
 });
 it('accepts a successful permission redirect but never retries on a different route',async()=>{
  const f=fixture();await prepareServiceBootstrap(async()=>{f.state.route=false;},f.options);expect(f.waiting).not.toHaveBeenCalled();
 });
 it.each([new ApiError(403,'FORBIDDEN','denied'),new ApiError(502,'INVALID_PROJECT_ACCESS','invalid role'),new ApiError(503,'INVALID_PROJECT_ACCESS','invalid role'),new ApiError(501,'FEATURE_UNAVAILABLE','not implemented'),new ApiError(502,'INVALID_RESPONSE','历史任务与当前作品不一致，不能确认模型版本。'),new Error('broken initializer'),new TypeError('Cannot read properties of undefined')])('does not retry a permission, schema or programming error',async error=>{
  const f=fixture(),work=vi.fn().mockRejectedValue(error);await expect(prepareServiceBootstrap(work,f.options)).rejects.toBe(error);expect(work).toHaveBeenCalledOnce();expect(f.waiting).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('distinguishes a proxy envelope failure and timeouts from malformed canvas data',()=>{
  expect(retryableBootstrapRead(new ApiError(502,'INVALID_RESPONSE','服务器返回了无法识别的响应。'))).toBe(true);expect(retryableBootstrapRead(new ApiError(504,'CANVAS_OPEN_TIMEOUT','timeout'))).toBe(true);expect(retryableBootstrapRead(new TypeError('Failed to fetch'))).toBe(true);
 });
});
