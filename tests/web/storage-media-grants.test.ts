import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import type {Asset,Snapshot} from '../../apps/web/src/api/types';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const now=Date.parse('2026-10-08T04:00:00Z');
const firstUrl='https://studio.invalid/storage/assets/ast_one?token=first';
const nextUrl='https://studio.invalid/storage/assets/ast_one?token=next';
const asset=(overrides:Partial<Asset>&{checksumSha256?:string}={}):Asset&{checksumSha256?:string}=>({id:'ast_one',projectId:'p',fileName:'video.mp4',kind:'VIDEO',mimeType:'video/mp4',byteSize:1024,state:'READY',downloadUrl:firstUrl,previewUrl:firstUrl,urlsExpireAt:new Date(now+15*60000).toISOString(),checksumSha256:'a'.repeat(64),...overrides});
const json=(data:unknown,status=200)=>new Response(JSON.stringify({code:status<400?0:'DENIED',data,message:'Denied'}),{status});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
function storageFor(route:(path:string)=>Response|Promise<Response>){const transport=vi.fn().mockImplementation(async(path:string)=>{const response=await route(path);if(path==='/api/v2/assets/resolve-batch'&&response.ok){const body=await response.json();return json({assets:[body.data]});}return response;}),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture');const storage=new ServiceStorage(api,vi.fn());return{storage,transport};}
const snapshot=(revision:number):Snapshot=>({projectId:'p',revision,updatedAt:new Date(now).toISOString(),graph:{schemaVersion:'1',nodes:[{id:'video',type:'rh-video',position:{x:0,y:0},data:{output:[{url:'rhtv-asset:ast_one',outputType:'video/mp4'}]}}],edges:[],viewport:{x:0,y:0,zoom:1}}});

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());

describe('authorized media grant stability',()=>{
 it('checks metadata for both live snapshots while keeping unchanged video src and fresh descriptive metadata',async()=>{
  let reads=0;
  const {storage,transport}=storageFor(()=>json(++reads===1?asset():asset({fileName:'renamed.mp4',downloadUrl:nextUrl,previewUrl:nextUrl,urlsExpireAt:new Date(now+16*60000).toISOString()})));
  storage.acceptRemoteSnapshot('p',snapshot(1),'"1"');
  const readNative=()=>storage.mergedNativeView('p').graph,signal=new AbortController().signal;
  await storage.receiveLiveSnapshot('p',snapshot(1),'"1"',readNative,()=>true,signal,true);
  const first=storage.readOnlyNativeView('p').nodes[0].data.output[0].url;
  await storage.receiveLiveSnapshot('p',snapshot(2),'"2"',readNative,()=>true,signal,true);
  expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v2/assets/resolve-batch','/api/v2/assets/resolve-batch']);
  expect(first).toBe(firstUrl);expect(storage.readOnlyNativeView('p').nodes[0].data.output[0].url).toBe(firstUrl);
  expect(storage.assets.get('ast_one')).toMatchObject({fileName:'renamed.mp4',downloadUrl:firstUrl,previewUrl:firstUrl,urlsExpireAt:asset().urlsExpireAt});
 });

 it('returns the retained grant to output callers as well as the graph mapping',async()=>{
  const {storage,transport}=storageFor(()=>json(asset()));await storage.resolveAsset('ast_one');
  transport.mockResolvedValueOnce(json(asset({downloadUrl:nextUrl,previewUrl:nextUrl,fileName:'updated.mp4'})));
  const fresh=await storage.resolveAsset('rhtv-asset:ast_one');
  expect(fresh.downloadUrl).toBe(firstUrl);expect(fresh.fileName).toBe('updated.mp4');expect(transport).toHaveBeenCalledTimes(2);
 });

 it.each([
  ['near expiry',{urlsExpireAt:new Date(now+60000).toISOString()},{}],
  ['expired',{urlsExpireAt:new Date(now-1).toISOString()},{}],
  ['missing expiry',{urlsExpireAt:null},{}],
  ['invalid expiry',{urlsExpireAt:'unverified'},{}],
  ['different bytes',{}, {checksumSha256:'b'.repeat(64)}],
  ['missing checksum',{checksumSha256:undefined}, {checksumSha256:undefined}],
  ['different kind',{}, {kind:'AUDIO',mimeType:'audio/wav'}],
  ['different mime type',{}, {mimeType:'video/webm'}],
 ] as const)('adopts the newly authorized URL for %s',async(_reason,oldChanges,newChanges)=>{
  const {storage,transport}=storageFor(()=>json(asset(oldChanges as Partial<Asset>)));await storage.resolveAsset('ast_one');
  const next=asset({...newChanges,downloadUrl:nextUrl,previewUrl:nextUrl,urlsExpireAt:new Date(now+20*60000).toISOString()} as Partial<Asset>);
  transport.mockResolvedValueOnce(json(next));const fresh=await storage.resolveAsset('ast_one');
  expect(fresh.downloadUrl).toBe(nextUrl);expect(storage.decodeAsset('rhtv-asset:ast_one')).toBe(nextUrl);expect(fresh.urlsExpireAt).toBe(next.urlsExpireAt);
 });

 it('forgets grants on identity cleanup even when an asset ID is reused',async()=>{
  const {storage,transport}=storageFor(()=>json(asset()));await storage.resolveAsset('ast_one');storage.clear();
  expect(storage.decodeAsset('rhtv-asset:ast_one')).toBe('');expect(storage.encodeAsset(firstUrl)).toBe(firstUrl);
  transport.mockResolvedValueOnce(json(asset({downloadUrl:nextUrl,previewUrl:nextUrl})));expect((await storage.resolveAsset('ast_one')).downloadUrl).toBe(nextUrl);
 });

 it('never falls back to a retained grant after access denial and checks a later request again',async()=>{
  const {storage,transport}=storageFor(()=>json(asset()));await storage.resolveAsset('ast_one');
  transport.mockResolvedValueOnce(json(null,403));await expect(storage.resolveAsset('ast_one')).rejects.toMatchObject({status:403});
  transport.mockResolvedValueOnce(json(null,404));await expect(storage.resolveAsset('ast_one')).rejects.toMatchObject({status:404});
  expect(transport).toHaveBeenCalledTimes(3);
 });

 it('rejects live snapshot denial before advancing its graph revision',async()=>{
  const {storage,transport}=storageFor(()=>json(asset()));storage.acceptRemoteSnapshot('p',snapshot(1),'"1"');await storage.resolveAsset('ast_one');
  transport.mockResolvedValueOnce(json(null,403));
  await expect(storage.receiveLiveSnapshot('p',snapshot(2),'"2"',()=>storage.mergedNativeView('p').graph,()=>true,new AbortController().signal,true)).rejects.toMatchObject({status:403});
  expect(storage.snapshots.get('p')?.revision).toBe(1);
 });
});

describe('media metadata single-flight',()=>{
 it('shares only an in-flight request, then rechecks metadata on the next resolve',async()=>{
  const gate=deferred<Response>(),{storage,transport}=storageFor(()=>gate.promise);
  const first=storage.resolveAsset('ast_one'),second=storage.resolveAsset('rhtv-asset:ast_one');expect(transport).toHaveBeenCalledOnce();
  gate.resolve(json(asset()));expect(await first).toBe(await second);
  transport.mockResolvedValueOnce(json(asset()));await storage.resolveAsset('ast_one');expect(transport).toHaveBeenCalledTimes(2);
 });

 it('does not restore an old identity or remove a newer identity in-flight request',async()=>{
  const old=deferred<Response>(),current=deferred<Response>(),{storage,transport}=storageFor(()=>old.promise);
  const oldRead=storage.resolveAsset('ast_one'),rejected=expect(oldRead).rejects.toMatchObject({code:'SESSION_CHANGED'});
  storage.clear();transport.mockImplementation(()=>current.promise);
  const currentRead=storage.resolveAsset('ast_one');old.resolve(json(asset()));await rejected;
  expect(storage.assets.size).toBe(0);
  const joined=storage.resolveAsset('rhtv-asset:ast_one');expect(transport).toHaveBeenCalledTimes(2);
  current.resolve(json(asset({downloadUrl:nextUrl,previewUrl:nextUrl})));
  expect((await currentRead).downloadUrl).toBe(nextUrl);expect((await joined).downloadUrl).toBe(nextUrl);expect(storage.encodeAsset(firstUrl)).toBe(firstUrl);
 });

 it.each([
  ['mismatched ID',asset({id:'other'}),'INVALID_RESPONSE'],
  ['unready media',asset({state:'PROCESSING'}),'ASSET_NOT_READY'],
 ] as const)('rejects %s rather than caching it',async(_reason,value,code)=>{
  const {storage,transport}=storageFor(()=>json(value));
  await expect(Promise.all([storage.resolveAsset('ast_one'),storage.resolveAsset('ast_one')])).rejects.toMatchObject({code});
  expect(transport).toHaveBeenCalledOnce();expect(storage.assets.size).toBe(0);
  transport.mockResolvedValueOnce(json(asset()));await storage.resolveAsset('ast_one');expect(transport).toHaveBeenCalledTimes(2);
 });
});
