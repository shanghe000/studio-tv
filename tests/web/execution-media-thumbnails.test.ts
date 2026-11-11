import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

it.each([['VIDEO','video/mp4'],['AUDIO','audio/wav']] as const)('does not use the %s file as an image thumbnail',async(kind,mimeType)=>{
 const url='https://studio.invalid/storage/assets/output?token=grant',transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:0,data:{id:'output',kind,mimeType,state:'READY',downloadUrl:url,previewUrl:url}}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,vi.fn());
 const output=await adapter.output({id:'o',type:'ASSET',assetId:'output',mimeType});
 expect(output).toMatchObject({assetId:'output',url,originalUrl:url,mimeType});expect(output).not.toHaveProperty('thumbnailUrl');expect(transport).toHaveBeenCalledOnce();
});

it('continues to use an authorized image preview as its thumbnail',async()=>{
 const url='https://studio.invalid/storage/assets/image?token=grant',transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:0,data:{id:'image',kind:'IMAGE',mimeType:'image/png',state:'READY',downloadUrl:url,previewUrl:url}}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,vi.fn());
 expect(await adapter.output({id:'o',type:'ASSET',assetId:'image',mimeType:'image/png'})).toMatchObject({url,thumbnailUrl:url});
});
