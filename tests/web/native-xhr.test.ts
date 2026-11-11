import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {shouldAnnounceNativeFailure} from '../../apps/web/src/service/unsupported-operation';

// Run the actual owned adapter class, without executing bootstrap or changing
// a real browser transport, session, native module, or preview fixture.
const source=readFileSync(new URL('../../apps/web/src/runtime/native-bootstrap.js',import.meta.url),'utf8'),start=source.indexOf('class PreviewXHR extends EventTarget{'),end=source.indexOf('Object.assign(PreviewXHR,',start);
if(start<0||end<0)throw new Error('Native XHR adapter boundary changed');
const factory=new Function('config','reply','window','location','EventTarget','Event','setTimeout','clearTimeout','shouldAnnounceNativeFailure',source.slice(start,end)+';return PreviewXHR;');
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
afterEach(()=>vi.useRealTimers());
function setup(mode:'service'|'preview'='service',reply=vi.fn(async(_url:string,_body:any,_method:string)=>({code:0,data:{real:'server-result'}}))){
 vi.useFakeTimers();const notice=vi.fn(),XHR=factory({mode},reply,{__RHTV_PREVIEW__:{notice}},{href:'http://fixture.invalid/projects/'},EventTarget,Event,setTimeout,clearTimeout,shouldAnnounceNativeFailure),xhr=new XHR(),events:string[]=[];
 for(const event of ['readystatechange','load','loadend','abort'])xhr.addEventListener(event,()=>events.push(event));
 xhr.open('POST','/canvas/list');return{xhr,reply,notice,events};
}

it('dispatches service requests on the next task without a fixed 60ms wait, retaining real asynchronous completion',async()=>{
 const pending=deferred<any>(),f=setup('service',vi.fn(()=>pending.promise)),onload=vi.fn();f.xhr.onload=onload;f.xhr.responseType='json';f.xhr.send({page:1});
 expect(f.reply).not.toHaveBeenCalled();expect(f.xhr.readyState).toBe(1);expect(f.xhr.status).toBe(0);await vi.advanceTimersByTimeAsync(0);
 expect(f.reply).toHaveBeenCalledExactlyOnceWith('/canvas/list',{page:1},'POST');expect(f.xhr.readyState).toBe(1);expect(f.xhr.status).toBe(0);expect(onload).not.toHaveBeenCalled();
 const actual={code:0,data:{records:[{id:'actual-project'}]}};pending.resolve(actual);await vi.advanceTimersByTimeAsync(0);
 expect(f.xhr.response).toEqual(actual);expect(f.xhr.status).toBe(200);expect(f.xhr.readyState).toBe(4);expect(f.xhr.responseURL).toBe('http://fixture.invalid/canvas/list');expect(f.events).toEqual(['readystatechange','readystatechange','load','loadend']);expect(onload).toHaveBeenCalledOnce();
});

it('retains the original 60ms preview scheduling without changing its result',async()=>{
 const f=setup('preview');f.xhr.send('preview-body');await vi.advanceTimersByTimeAsync(59);expect(f.reply).not.toHaveBeenCalled();expect(f.xhr.status).toBe(0);
 await vi.advanceTimersByTimeAsync(1);expect(f.reply).toHaveBeenCalledOnce();expect(f.xhr.status).toBe(200);expect(JSON.parse(f.xhr.responseText)).toEqual({code:0,data:{real:'server-result'}});
});

it.each(['service','preview'] as const)('allows immediate abort before %s dispatch and emits no completion',async mode=>{
 const f=setup(mode),onabort=vi.fn();f.xhr.onabort=onabort;f.xhr.send('body');f.xhr.abort();await vi.advanceTimersByTimeAsync(100);
 expect(f.reply).not.toHaveBeenCalled();expect(f.xhr.status).toBe(0);expect(f.xhr.responseText).toBeUndefined();expect(f.events).toEqual(['readystatechange','abort']);expect(onabort).toHaveBeenCalledOnce();expect(f.notice).not.toHaveBeenCalled();
});

it.each(['success','error'] as const)('ignores a late %s while an already dispatched request is aborted, without status changes or notices',async outcome=>{
 const pending=deferred<any>(),f=setup('service',vi.fn(()=>pending.promise));f.xhr.send('body');await vi.advanceTimersByTimeAsync(0);expect(f.reply).toHaveBeenCalledOnce();f.xhr.abort();
 if(outcome==='success')pending.resolve({code:0,data:{private:'old-result'}});else pending.reject(new ApiError(503,'UNAVAILABLE','late error'));
 await vi.advanceTimersByTimeAsync(0);expect(f.xhr.status).toBe(0);expect(f.xhr.readyState).toBe(1);expect(f.xhr.responseText).toBeUndefined();expect(f.events).toEqual(['readystatechange','abort']);expect(f.notice).not.toHaveBeenCalled();
});

it.each([[401,'UNAUTHORIZED',true],[403,'FEATURE_DISABLED',false],[501,'NOT_IMPLEMENTED',true],[503,'UPSTREAM_UNAVAILABLE',true]] as const)('keeps a real %s error response and notice policy after removing service delay',async(status,code,announced)=>{
 const f=setup('service',vi.fn().mockRejectedValue(new ApiError(status,code,'actual service failure')));f.xhr.send('body');await vi.advanceTimersByTimeAsync(0);
 expect(f.xhr.status).toBe(status);expect(f.xhr.statusText).toBe('Internal Server Error');expect(f.xhr.readyState).toBe(4);expect(JSON.parse(f.xhr.responseText)).toEqual({code:status,msg:'actual service failure',data:null});expect(f.events).toEqual(['readystatechange','readystatechange','load','loadend']);
 if(announced)expect(f.notice).toHaveBeenCalledExactlyOnceWith('actual service failure');else expect(f.notice).not.toHaveBeenCalled();
});

it('maps an unexpected adapter failure to an honest 503 rather than a successful empty response',async()=>{
 const f=setup('service',vi.fn().mockRejectedValue(new Error('adapter failed')));f.xhr.send('body');await vi.advanceTimersByTimeAsync(0);
 expect(f.xhr.status).toBe(503);expect(JSON.parse(f.xhr.responseText)).toEqual({code:503,msg:'adapter failed',data:null});expect(f.notice).toHaveBeenCalledExactlyOnceWith('adapter failed');
});

it.each(['/canvas/remake/config/story-voice-presets','http://fixture.invalid/canvas/remake/config/story-voice-presets?language=zh'])('delivers the optional storyboard catalog rejection without a global action-failure toast: %s',async url=>{
 const f=setup('service',vi.fn().mockRejectedValue(new ApiError(501,'NOT_IMPLEMENTED','分镜配音预设尚未开放')));
 f.xhr.open('POST',url);f.xhr.responseType='json';f.xhr.send('{}');await vi.advanceTimersByTimeAsync(0);
 expect(f.xhr.status).toBe(501);expect(f.xhr.response).toEqual({code:501,msg:'分镜配音预设尚未开放',data:null});
 expect(f.events.slice(-3)).toEqual(['readystatechange','load','loadend']);expect(f.notice).not.toHaveBeenCalled();
});

it.each([
 ['/canvas/remake/config/story-voice-presets','POST',401,'UNAUTHORIZED'],
 ['/canvas/remake/config/story-voice-presets','POST',403,'FORBIDDEN'],
 ['/canvas/remake/config/story-voice-presets','POST',503,'UNAVAILABLE'],
 ['/canvas/remake/config/story-voice-presets','DELETE',501,'NOT_IMPLEMENTED'],
 ['/canvas/remake/config/story-voice-presets','POST',501,'OTHER_FAILURE'],
 ['/canvas/remake/shots/generate','POST',501,'NOT_IMPLEMENTED'],
 ['/canvas/task/run','POST',501,'NOT_IMPLEMENTED'],
] as const)('retains genuine failures for %s %s %s %s',async(path,method,status,code)=>{
 const f=setup('service',vi.fn().mockRejectedValue(new ApiError(status,code,'真实操作失败')));
 f.xhr.open(method,path);f.xhr.send('{}');await vi.advanceTimersByTimeAsync(0);
 expect(f.xhr.status).toBe(status);expect(f.notice).toHaveBeenCalledExactlyOnceWith('真实操作失败');
});
