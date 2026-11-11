import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';
const scope='a'.repeat(32),id='p',asset=(i:number)=>'rhtv-asset:ast_'+i;
const input=(count:number)=>({nodes:[{id:'image',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:count?[asset(0)]:[],nodeOutputHistory:Array.from({length:count},(_,i)=>({id:'h'+i,outputs:[asset(i)]})),mediaOrder:count?['image::'+asset(0)]:[]}}],edges:[]});
const snap=(count:number,revision:number)=>({projectId:id,graph:encodeGraph(input(count)),revision,updatedAt:'2026-11-04T10:00:00Z'});
it.each([0,18,225,501])('opens and syncs a graph with %i references independently of unreadable history; actual selected media still checks permission',async count=>{
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path.endsWith('/snapshot')){expect(init.headers.get('X-STUDIO-Canvas-Media')).toBe('lazy-v1');return Response.json({code:0,data:snap(count,1)},{headers:{ETag:'"1"','X-STUDIO-Canvas-Media':scope}});}
  if(path==='/api/v1/projects/p')return Response.json({code:0,data:{id,name:'Example',ownerId:'owner',revision:1,coverAssetId:'cover'}});
  if(path==='/api/v1/assets/ast_0')return Response.json({code:'ASSET_NOT_FOUND',message:'素材不存在。'},{status:404});
  throw Error('unexpected request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture');const storage=new ServiceStorage(api,()=>{});
 await storage.loadProject(id);const view=storage.fixture(id);
 await storage.receiveLiveSnapshot(id,snap(count,2),'"2"',()=>view,()=>true,new AbortController().signal,true);
 expect(transport).toHaveBeenCalledTimes(2);expect(storage.snapshots.get(id)?.revision).toBe(2);
 const native=storage.readOnlyNativeView(id);expect(encodeGraph(native,storage.encodeAsset).nodes[0]).toEqual(snap(count,2).graph.nodes[0]);
 if(count){const url=native.nodes[0].data.sourceObjects[0];expect(url).toContain('/storage/canvas-media/'+scope+'/ast_0');const moved=structuredClone(native);moved.nodes[0].position.x=10;
  storage.enableCanvasOperations(id,{userId:'o',clientId:'page',ensure:async()=>{}},native);storage.captureDraft(id,moved);expect(storage.draft(id)?.nodes[0].data.sourceObjects[0]).toBe(url);
  await expect(storage.resolveAsset(url)).rejects.toMatchObject({status:404});expect(transport).toHaveBeenCalledTimes(3);
  storage.clear();expect(storage.encodeAsset(url)).toBe(url);
 }
});
