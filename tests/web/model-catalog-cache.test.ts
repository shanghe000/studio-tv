import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const cap={capabilityRef:'internal-image',kind:'TEXT_TO_IMAGE',version:'1',parameterSchemaVersion:'1',available:true,testMode:false};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}));
function setup(route:(path:string,init:RequestInit)=>Response|Promise<Response>){
 const transport=vi.fn(route),api=new ProductClient('/api/v1',transport);api.setAccessToken('test-owner');
 const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 return{transport,adapter};
}
afterEach(()=>vi.useRealTimers());

it('shares one complete paginated catalog between concurrent menu requests',async()=>{
 let release!:(response:Response)=>void;
 const {transport,adapter}=setup(path=>path.includes('cursor=next')?json({items:[{...cap,capabilityRef:'second'}],nextCursor:null}):new Promise(resolve=>release=resolve));
 const first=adapter.handle('/canvas/model/list',{types:['TEXT_TO_IMAGE']}),second=adapter.handle('/canvas/model/group/list',{});
 expect(transport).toHaveBeenCalledTimes(1);release(json({items:[cap],nextCursor:'next'}));
 await Promise.all([first,second]);expect(transport).toHaveBeenCalledTimes(2);
 expect((await adapter.catalog()).map(item=>item.capabilityRef)).toEqual(['internal-image','second']);
 expect(transport).toHaveBeenCalledTimes(2);
});

it('expires menu metadata after 30 seconds and returns independent caller values',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1_000);
 let version='1';const {transport,adapter}=setup(()=>json({items:[{...cap,version}],nextCursor:null}));
 const first=await adapter.catalog();first[0].version='caller mutation';first.push({...cap,capabilityRef:'fake'});
 version='2';vi.setSystemTime(30_999);expect(await adapter.catalog()).toEqual([{...cap,version:'1'}]);
 expect(transport).toHaveBeenCalledTimes(1);vi.setSystemTime(31_000);
 expect(await adapter.catalog()).toEqual([{...cap,version:'2'}]);expect(transport).toHaveBeenCalledTimes(2);
});

it('never caches a failed or malformed catalog',async()=>{
 let call=0;const {transport,adapter}=setup(()=>++call===1?new Response(JSON.stringify({error:{code:'UPSTREAM_UNAVAILABLE',message:'offline'}}),{status:503}):call===2?json({items:null}):json({items:[cap]}));
 await expect(adapter.catalog()).rejects.toMatchObject({code:'UPSTREAM_UNAVAILABLE'});
 await expect(adapter.catalog()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 expect(await adapter.catalog()).toEqual([cap]);expect(transport).toHaveBeenCalledTimes(3);
});

it('aborts and fences old identity requests without deleting the new singleflight',async()=>{
 let oldResolve!:(response:Response)=>void,newResolve!:(response:Response)=>void,call=0;
 const {transport,adapter}=setup(()=>new Promise(resolve=>{if(++call===1)oldResolve=resolve;else newResolve=resolve;}));
 const old=adapter.catalog(),oldRejected=expect(old).rejects.toMatchObject({code:'SESSION_CHANGED'});
 adapter.clear();expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
 const fresh=adapter.catalog();oldResolve(json({items:[cap]}));await oldRejected;
 const same=adapter.catalog();expect(transport).toHaveBeenCalledTimes(2);
 newResolve(json({items:[{...cap,capabilityRef:'new-owner'}]}));
 expect(await fresh).toEqual([{...cap,capabilityRef:'new-owner'}]);expect(await same).toEqual(await fresh);
 adapter.clear();const next=adapter.catalog();expect(transport).toHaveBeenCalledTimes(3);newResolve(json({items:[]}));await next;
});

it('keeps kind-specific catalogs separate from the complete directory',async()=>{
 const {transport,adapter}=setup(path=>json({items:path.includes('kind=LLM')?[{...cap,kind:'LLM',capabilityRef:'text'}]:[cap],nextCursor:null}));
 expect(await adapter.catalog('LLM')).toEqual([{...cap,kind:'LLM',capabilityRef:'text'}]);
 expect(await adapter.catalog()).toEqual([cap]);expect(await adapter.catalog('LLM')).toHaveLength(1);
 expect(transport).toHaveBeenCalledTimes(2);
});
