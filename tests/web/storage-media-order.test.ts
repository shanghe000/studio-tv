import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=compiled.indexOf('function kme('),end=compiled.indexOf('const m_n=',start);if(start<0||end<0)throw new Error('Native media order seam changed');
const nativeOrder=new Function(compiled.slice(start,end)+';return {key:Tme,sort:Np};')();
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:data.revision?{ETag:'"'+data.revision+'"'}:{}});

function fixture(){
 let revision=1,signing='first',graph=encodeGraph({nodes:[],edges:[],meta:{name:'Order fixture'}});
 const signed=(id:string)=>'https://studio.invalid/storage/'+id+'?token='+signing+'&X-Amz-Signature=secret';
 const transport=vi.fn(async(path:string,options:any)=>{
  if(path==='/api/v1/projects/p')return json({id:'p',name:'Order fixture',ownerId:'owner',revision,updatedAt:'2026-10-06T00:00:00Z'});
  if(path==='/api/v1/projects/p/snapshot'){if(options.method==='PUT'){graph=JSON.parse(options.body).graph;revision++;}return json({projectId:'p',revision,graph,updatedAt:'2026-10-06T00:00:00Z'});}
  const id=path.match(/^\/api\/v1\/assets\/(asset_[123])$/)?.[1];if(id)return json({id,state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:signed(id)});
  throw new Error('Unexpected fixture request '+path);
 });const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 return{storage,execution,transport,signed,persisted:()=>graph,rotate:()=>{signing='second';}};
}

it.each(['imageOrder','videoOrder','audioOrder'])('persists %s as canonical native keys and retains exact selected order through reload and execution freeze',async orderField=>{
 const f=fixture();await f.storage.loadProject('p');await Promise.all(['asset_1','asset_2','asset_3'].map(id=>f.storage.resolveAsset('rhtv-asset:'+id)));
 const rows=[1,2,3].map(id=>({nodeId:'source_'+id,url:f.signed('asset_'+id)})),keys=[nativeOrder.key(rows[1]),nativeOrder.key(rows[0])];
 expect(keys[0]).toBe('source_2::'+f.signed('asset_2'));
 const native:NativeGraph={nodes:[...rows.map(row=>({id:row.nodeId,type:'rh-image',position:{x:0,y:0},data:{sourceObjects:[row.url]}})),{id:'target',type:'rh-image',position:{x:20,y:0},data:{[orderField]:keys,params:{[orderField]:keys}}}],edges:rows.map((row,index)=>({id:'edge_'+index,source:row.nodeId,target:'target',sourceHandle:null,targetHandle:null}))};
 await f.storage.save('p',native);const data=f.persisted().nodes.find(node=>node.id==='target')!.data;
 expect(data[orderField]).toEqual(['source_2::rhtv-asset:asset_2','source_1::rhtv-asset:asset_1']);expect(data.params[orderField]).toEqual(data[orderField]);expect(JSON.stringify(f.persisted())).not.toMatch(/token=|X-Amz-Signature|secret|https:\/\/studio.invalid/);
 f.storage.clear();f.rotate();await f.storage.loadProject('p');const reloaded=f.storage.fixture('p'),target=reloaded.nodes.find(node=>node.id==='target')!;
 expect(target.data[orderField]).toEqual(['source_2::'+f.signed('asset_2'),'source_1::'+f.signed('asset_1')]);
 const refreshed=rows.map((row,index)=>({...row,url:reloaded.nodes[index].data.sourceObjects[0]}));expect(nativeOrder.sort(refreshed,target.data[orderField]).map((row:any)=>row.nodeId)).toEqual(['source_2','source_1','source_3']);
 const before=structuredClone(reloaded),frozen=await f.execution.freezeGraph(reloaded,'p'),frozenTarget=frozen.nodes.find(node=>node.id==='target')!;
 expect(frozenTarget.data[orderField]).toEqual(data[orderField]);expect(frozenTarget.data.params[orderField]).toEqual(data[orderField]);expect(JSON.stringify(frozen)).not.toMatch(/token=|X-Amz-Signature|secret|https:\/\/studio.invalid/);expect(reloaded).toEqual(before);
});

it('maps only exact registered whole keys and leaves prose, unknown URLs and other compound grammars alone',async()=>{
 const f=fixture();await f.storage.resolveAsset('rhtv-asset:asset_1');const url=f.signed('asset_1');
 expect(f.storage.encodeAsset('source_1::'+url)).toBe('source_1::rhtv-asset:asset_1');expect(f.storage.decodeAsset('source_1::rhtv-asset:asset_1')).toBe('source_1::'+url);
 for(const value of ['Reference source_1::'+url,'source_1::'+url+' extra','invalid node::'+url,'::'+url,'source_1::https://unknown.invalid/image?token=unregistered','text::source_1','mention-text::asset_1'])expect(f.storage.encodeAsset(value)).toBe(value);
 expect(f.storage.decodeAsset('source_1::rhtv-asset:unknown')).toBe('source_1::rhtv-asset:unknown');expect(f.storage.decodeAsset('Reference source_1::rhtv-asset:asset_1')).toBe('Reference source_1::rhtv-asset:asset_1');f.storage.clear();expect(f.storage.encodeAsset('source_1::'+url)).toBe('source_1::'+url);
});
