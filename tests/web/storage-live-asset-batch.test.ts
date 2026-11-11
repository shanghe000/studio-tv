import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';
const original=()=>({nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{}}],edges:[]});
const snapshot=(revision:number,ids:string[]=[])=>({projectId:'p',revision,updatedAt:'2026-11-03T00:00:00Z',graph:encodeGraph({nodes:[{...original().nodes[0],data:{sourceObjects:ids.map(id=>'rhtv-asset:'+id)}}],edges:[]})});
const asset=(id:string)=>({id,projectId:'p',fileName:'fixture.png',kind:'IMAGE',mimeType:'image/png',byteSize:1024,state:'READY',downloadUrl:'https://studio.invalid/'+id,previewUrl:null,urlsExpireAt:'2030-01-01T00:00:00Z'});
const json=(data:any,status=200)=>new Response(JSON.stringify(status===200?{code:0,data}:{code:'ASSET_DENIED',message:'Denied'}),{status});
function setup(handler:(ids:string[])=>Response|Promise<Response>){
 const transport=vi.fn(async(path:string,options:any)=>{expect(path).toBe('/api/v2/assets/resolve-batch');expect(options.method).toBe('POST');expect(options.headers.get('Authorization')).toBe('Bearer fixture');return handler(JSON.parse(options.body).assetIds);}),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture');const storage=new ServiceStorage(api,vi.fn());storage.acceptRemoteSnapshot('p',snapshot(1),'"1"');return{transport,storage,receive:(ids:string[])=>storage.receiveLiveSnapshot('p',snapshot(2,ids),'"2"',()=>original(),()=>true,new AbortController().signal,true)};
}
it('loads hundreds of distinct references through bounded authenticated batches before advancing the snapshot',async()=>{
 let active=0,maximum=0;const f=setup(async ids=>{active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;return json({assets:ids.map(asset)});}),ids=Array.from({length:501},(_,index)=>'asset_'+index);
 await f.receive([...ids,...ids.slice(0,4)]);expect(f.transport).toHaveBeenCalledTimes(6);expect(maximum).toBeLessThanOrEqual(4);expect(f.transport.mock.calls.map(([,options])=>JSON.parse(options.body).assetIds.length)).toEqual([100,100,100,100,100,1]);expect(f.storage.assets.size).toBe(501);expect(f.storage.snapshots.get('p')?.revision).toBe(2);
});
it.each(['missing','duplicate','foreign','unready','missing-url'])('rejects a %s batch result without caching a partial graph or asset set',async mode=>{
 const f=setup(ids=>{const assets:any[]=ids.map(asset);if(mode==='missing')assets.pop();if(mode==='duplicate')assets[1]=assets[0];if(mode==='foreign')assets[0].id='another_asset';if(mode==='unready')assets[0].state='PROCESSING';if(mode==='missing-url')assets[0].downloadUrl='';return json({assets});});
 await expect(f.receive(['first','second'])).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(f.storage.assets.size).toBe(0);expect(f.storage.snapshots.get('p')?.revision).toBe(1);expect(f.storage.etags.get('p')).toBe('"1"');
});
it.each([403,404,409])('does not advance a graph after any batch is denied with %s',async status=>{
 const f=setup(ids=>ids.includes('denied')?json(null,status):json({assets:ids.map(asset)}));await expect(f.receive([...Array.from({length:100},(_,index)=>'asset_'+index),'denied'])).rejects.toMatchObject({status});expect(f.storage.assets.size).toBe(0);expect(f.storage.snapshots.get('p')?.revision).toBe(1);
});
