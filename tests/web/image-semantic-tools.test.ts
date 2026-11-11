import catalog from './fixtures/canvas-catalog-audit-20261104.json';
import {exportNodeAction} from './helpers/export-node-action';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {nativePortraitAlias,nativePanoramaAlias,semanticImageModel} from '../../apps/web/src/service/image-semantic-tools';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
import {imageBatchPlan} from '../../apps/web/src/service/image-batch-output';
const cap=(kind='IMAGE_TO_IMAGE'):any=>catalog.find(c=>c.capabilityRef===(kind==='IMAGE_TO_IMAGE'?'codex-image-edit-v1':'codex-image-generate-v1'))!;
const source={id:'source',type:'rh-image',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:owned']}};
const response=(data:any)=>new Response(JSON.stringify({code:0,data}));
function setup(){const transport=vi.fn(async(path:string,init?:any)=>{
 if(path.includes('/model-capabilities?'))return response({items:[cap(),cap('TEXT_TO_IMAGE')],nextCursor:null});
 if(path.startsWith('/api/v2/model-capability-version?'))return new Response(JSON.stringify({code:'MODEL_NOT_FOUND'}),{status:404});
 if(path.startsWith('/api/v1/assets/'))return response({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),state:'READY',kind:'IMAGE'});
 if(path==='/api/v2/canvas-runs'){exportNodeAction(init);return response({id:'task',state:'SUCCEEDED',plans:[],testMode:false});}
 throw new Error(path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');return{transport,adapter:new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn())};}
it.each(['IMAGE_MULTIANGLE','IMAGE_LIGHT','IMAGE_CUTOUT_TEXT'])('exposes %s only as an actual reference editor with honest controls',async type=>{
 const f=setup(),rows=await f.adapter.handle('/canvas/model/list',{types:[type]}),model=rows[0].modelList[0];expect(model.capabilityRef).toBe(cap().capabilityRef);expect(model.kind).toBe('IMAGE_TO_IMAGE');expect(model.generateNum).toEqual([1]);expect(model.description).toBeTruthy();expect(model.config.some((field:any)=>field.type==='prompt')).toBe(false);
 if(type==='IMAGE_MULTIANGLE')expect(model.config.filter((field:any)=>['int','float'].includes(field.type)).map((field:any)=>field.paramName)).toEqual(['horizontal_angle','vertical_angle','zoom']);
 if(type==='IMAGE_LIGHT')expect(model.config.find((field:any)=>field.paramName==='light_color_hex').type).toBe('colorHex');
 const fields={...model.params,imageUrls:['rhtv-asset:owned']};await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[source,{id:'n',type:'rh-image',position:{x:400,y:0},data:{modelCode:model.modelCode,toolsType:type.toLowerCase().replaceAll('_','-'),toolsSourceUrl:'rhtv-asset:owned',...(type!=='IMAGE_CUTOUT_TEXT'?{subType:'image-image'}:{}),params:fields,generateNum:1}}],edges:[{source:'source',target:'n'}]}});
 const data=JSON.parse(f.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body).graph.nodes.find((n:any)=>n.id==='n').data;expect(data).toMatchObject({capabilityRef:cap().capabilityRef,capabilityVersion:'3',routerParameters:{count:1,transparentBackground:false},params:fields});
});
it.each(['IMAGE_HD','IMAGE_GIGAPIXEL','IMAGE_LAYER_DECOMPOSITION'])('does not silently advertise %s as ordinary editing',async type=>{
 const f=setup(),rows=await f.adapter.handle('/canvas/model/list',{types:[type]});expect(rows[0].modelList).toEqual([]);
});
it.each(['portrait','panorama'])('routes exact native %s toolbar commands through the public capability',async tool=>{
 const f=setup(),data:any={modelCode:tool==='portrait'?nativePortraitAlias:nativePanoramaAlias,toolsType:'image-image',generateNum:1,toolsSourceUrl:'rhtv-asset:owned',params:{prompt:'',imageUrls:['rhtv-asset:owned']},...(tool==='portrait'?{isPortraitAdjustResult:true,presetSelections:[{key:'age',id:'studio-portrait-930-v1',promptCode:'studio-portrait-930-v1'}]}:{panorama:{isPanoramaNode:true,locked:true},sceneCode:'canvas-image-panorama-image'})};
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[source,{id:'n',type:'rh-image',position:{x:400,y:0},data}],edges:[{source:'source',target:'n'}]}});
 expect(JSON.parse(f.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body).graph.nodes.find((n:any)=>n.id==='n').data.capabilityRef).toBe(cap().capabilityRef);
});
it.each([nativePortraitAlias,nativePanoramaAlias])('rejects %s outside its native feature boundary',async modelCode=>{
 const f=setup();await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-image',position:{x:0,y:0},data:{modelCode,subType:'image-image',params:{prompt:'user',imageUrls:['rhtv-asset:owned']}}}],edges:[]}})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});
});
it.each(['1','2'])('keeps saved @%s image menus on that version when the current catalog is @3',version=>{
 const model=capabilityModel(cap()),node={id:'n',type:'rh-image',data:{modelCode:model.modelCode,capabilityVersion:version,params:{}}},props={targetNode:node,nodes:[node],edges:[],models:{'image-image':[model]}};
 const view=nativeModelProps(props).models['image-image'][0];expect(view.capabilityVersion).toBe(version);expect(view.config.some((field:any)=>field.paramName==='transparentBackground')).toBe(false);expect(view.generateNum).toEqual(version==='1'?[1]:[1,2,4]);
});
it('applies the independent image-node output projection to versions2 and3 only',()=>{
 for(const version of ['1','2','3','4'])expect(imageBatchPlan({capabilityRef:cap().capabilityRef,capabilityVersion:version})).toBe(['2','3'].includes(version));
});


it.each(['IMAGE_REDRAW','IMAGE_ERASE','IMAGE_EXPAND','IMAGE_CUTOUT'])('projects %s only for v3 and enforces actual transparency for cutout',async type=>{
 const f=setup(),rows=await f.adapter.handle('/canvas/model/list',{types:[type]}),model=rows[0].modelList[0];expect(model.capabilityVersion).toBe('3');expect(model.description).toBeTruthy();expect(model.generateNum).toEqual([1,2,4]);
 if(type==='IMAGE_EXPAND'){expect(model.description).toContain('所选尺寸用于画布参考');expect(model.description).toContain('输出像素尺寸由模型决定');expect(model.config.some((field:any)=>['width','height','resolution'].includes(field.paramName))).toBe(false);}else expect(model.description).not.toContain('所选尺寸');
 const media=type==='IMAGE_CUTOUT'?'rhtv-asset:owned':'rhtv-asset:guide';
 const data:any={modelCode:model.modelCode,toolsType:type.toLowerCase().replaceAll('_','-'),toolsSourceUrl:media,sourceNodeId:'source',params:{imageUrls:[media],...(type==='IMAGE_REDRAW'?{prompt:'change marked region'}:{})},generateNum:1,routerParameters:{transparentBackground:false}};
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:['rhtv-asset:owned']}},{id:'n',type:'rh-image',position:{x:400,y:0},data}],edges:[{source:'source',target:'n'}]}});
 const value=JSON.parse(f.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body).graph.nodes.find((node:any)=>node.id==='n').data;expect(value.routerParameters.transparentBackground).toBe(type==='IMAGE_CUTOUT');expect(value.toolsSourceUrl).toBe(media);
 if(type==='IMAGE_EXPAND')expect(value.params).toEqual(data.params);
});
it('names generative repair separately from unavailable resolution upscalers',async()=>{
 const f=setup(),rows=await f.adapter.handle('/canvas/model/list',{types:['IMAGE_ENHANCE','IMAGE_HD','IMAGE_GIGAPIXEL']});expect(rows[0].modelList[0].modelName).toContain('生成式画质修复');expect(rows[0].modelList[0].description).toContain('不保证');expect(rows[1].modelList).toEqual([]);expect(rows[2].modelList).toEqual([]);
});
it('grays an old image result with a removed portrait preset and sends no run from the same graph',async()=>{
 const f=setup(),data={modelCode:cap().capabilityRef,subType:'image-image',isPortraitAdjustResult:true,
  presetSelections:[{key:'age',id:'studio-portrait-age-adult-v1',promptCode:'studio-portrait-age-adult-v1'}],toolsSourceUrl:'rhtv-asset:owned',params:{prompt:'变更外观',imageUrls:['rhtv-asset:owned']}};
 const graph={nodes:[source,{id:'n',type:'rh-image',position:{x:400,y:0},data}],edges:[{id:'line',source:'source',target:'n'}]};
 f.adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:vi.fn()});
 try{
  const readiness=await f.adapter.inspectGeneration('p',['n'],graph);expect(readiness.status).toBe('blocked');expect(JSON.stringify(readiness)).toContain('studio-portrait-age-adult-v1');
  f.adapter.attach('',null);await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph})).rejects.toThrow('第 1 项图片预设');
  expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
 }finally{f.adapter.clear();}
});
