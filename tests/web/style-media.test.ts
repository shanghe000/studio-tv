import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {builtinStyleMedia} from '../../apps/web/src/service/style-media';

it('materializes the native builtin reference before execution and keeps definitions unchanged',async()=>{
 const asset={id:'owned-style',state:'READY',kind:'IMAGE',downloadUrl:'/api/v1/assets/owned-style/content'};
 const calls:any[]=[];
 const api=new ProductClient('/api/v1',vi.fn(async(path,init)=>{calls.push({path,body:init?.body&&JSON.parse(String(init.body))});return new Response(JSON.stringify({code:0,data:String(path).includes('materialize')?{asset}:asset}),{status:200});}));
 api.setAccessToken('test');const storage=new ServiceStorage(api,vi.fn()),entry=builtinStyleMedia[0];
 const graph={nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{params:{imageUrls:[entry.url]},presetSelections:[{key:'styleLibrary',id:entry.reference.resourceId,referenceImageUrl:entry.url}]}}],edges:[]};
 const before=structuredClone(graph);await storage.prepareGraph(graph);
 expect(calls.find(call=>call.path==='/api/v2/catalog/media/materialize')?.body).toEqual(entry.reference);
 expect(storage.encodeAsset(entry.url)).toBe('rhtv-asset:owned-style');expect(graph).toEqual(before);
 await storage.prepareGraph(graph);expect(calls.filter(call=>call.path.includes('materialize'))).toHaveLength(1);
 storage.clear();expect(storage.encodeAsset(entry.url)).toBe(entry.url);await storage.prepareGraph(graph);
 expect(calls.filter(call=>call.path.includes('materialize'))).toHaveLength(2);
});

it('does not materialize cover metadata alone or arbitrary URLs',async()=>{
 const transport=vi.fn(),api=new ProductClient('/api/v1',transport),storage=new ServiceStorage(api,vi.fn());
 await storage.prepareGraph({nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{presetSelections:[{referenceImageUrl:builtinStyleMedia[0].url}],params:{imageUrls:['https://untrusted.invalid/a.webp']}}}],edges:[]});
 expect(transport).not.toHaveBeenCalled();await expect(storage.resolveAsset('https://untrusted.invalid/a.webp')).rejects.toMatchObject({code:'ASSET_REFERENCE_REQUIRED'});
});
