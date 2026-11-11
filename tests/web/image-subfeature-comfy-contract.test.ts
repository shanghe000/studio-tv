import {frozenQuickSceneSubmit} from './helpers/frozen-quick-scene';
import catalog from './fixtures/canvas-catalog-audit-20261104.json';
import {exportNodeAction} from './helpers/export-node-action';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {nativeImageToolbarProps,nativeQuickSceneAlias,quickSceneCodes} from '../../apps/web/src/service/image-quick-scenes';
import {nativePortraitAlias,nativePanoramaAlias} from '../../apps/web/src/service/image-semantic-tools';

const qwen:any=catalog.find(c=>c.capabilityRef==='qwen-image-edit-2511-v1')!;
const textImage=catalog.find(c=>c.capabilityRef==='z-image-turbo-generate-v1')!;
const json=(data:any)=>new Response(JSON.stringify({code:0,data}));
function fixture(){
 const transport=vi.fn(async(path:string,init?:any)=>{
  if(path.includes('/model-capabilities?'))return json({items:[textImage,qwen],nextCursor:null});
  if(path.startsWith('/api/v1/assets/'))return json({id:path.split('/').at(-1),state:'READY',kind:'IMAGE',byteSize:4096,width:512,height:512,mimeType:'image/png'});
  if(path==='/api/v2/canvas-runs'){exportNodeAction(init);return json({id:'task',state:'SUCCEEDED',plans:[],testMode:false});}
  throw new Error('Unexpected request: '+path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn(),{allowTestMode:false});
 return{adapter,transport,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes.find((node:any)=>node.id==='result').data};
}
const source={id:'source',type:'rh-image',position:{x:0,y:0},data:{isUpload:true,assetIds:['owned'],sourceObjects:['rhtv-asset:owned']}};
const graph=(data:any)=>({nodes:[source,{id:'result',type:'rh-image',position:{x:400,y:0},data}],edges:[{source:'source',target:'result'}]});

it.each([...quickSceneCodes])('freezes the single selected source and actual Qwen profile for quick-scene %s',async sceneCode=>{
 const f=fixture(),model=capabilityModel(qwen),models={'image-image':[model]},view=nativeImageToolbarProps({targetNode:source,nodes:[source],edges:[],models,toolbarContext:{canvasId:'project',canvasName:'Tool audit',models},onNodeDataPatch:vi.fn()},'N2r');
 const run=frozenQuickSceneSubmit('result',body=>f.adapter.run(body));
 expect(await run(view.toolbarContext,source,'rhtv-asset:owned',{sceneCode,titleKey:'tool',paramOverrides:{resolution:'2k'}})).toBe(true);
 expect(f.submitted()).toMatchObject({capabilityRef:qwen.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',sceneCode,toolsSourceUrl:'rhtv-asset:owned',params:{prompt:'',imageUrls:['rhtv-asset:owned'],resolution:'2k'},routerParameters:{outputPreset:'1024-square'}});
 expect(f.submitted().routerParameters).not.toHaveProperty('resolution');
});

it.each(['IMAGE_MULTIANGLE','IMAGE_MULTI_ANGLE','IMAGE_LIGHT','IMAGE_MULTI_ANGLE_LIGHT','IMAGE_CUTOUT_TEXT','IMAGE_ENHANCE'])('offers actual reference editing, never a text-only generator, for %s',async type=>{
 const f=fixture(),rows=await f.adapter.handle('/canvas/model/list',{types:[type]});
 expect(rows[0].modelList.map((model:any)=>model.capabilityRef)).toEqual([qwen.capabilityRef]);
 const model=rows[0].modelList[0],params={...model.params,imageUrls:['rhtv-asset:owned'],...(type==='IMAGE_ENHANCE'?{prompt:'retain the expression'}:{})};
 await f.adapter.run({projectId:'project',targetType:'NODE',targetId:'result',graph:graph({modelCode:model.modelCode,capabilityRef:model.capabilityRef,capabilityVersion:model.capabilityVersion,toolsType:type.toLowerCase().replaceAll('_','-'),toolsSourceUrl:'rhtv-asset:owned',generateNum:1,params})});
 expect(f.submitted()).toMatchObject({capabilityRef:qwen.capabilityRef,routerParameters:{outputPreset:'1024-square'},params});
});

it('keeps unsupported mask/transparency tools outside the single-reference Qwen profile',async()=>{
 const rows=await fixture().adapter.handle('/canvas/model/list',{types:['IMAGE_REDRAW','IMAGE_ERASE','IMAGE_EXPAND','IMAGE_CUTOUT','IMAGE_LAYER_DECOMPOSITION','IMAGE_GIGAPIXEL','IMAGE_HD']});
 for(const row of rows)expect(row.modelList).toEqual([]);
});

it('opens quick-scene/portrait compatibility views with Qwen while leaving the public model names and catalog untouched',()=>{
 const model=capabilityModel(qwen),models={'image-image':[model],'text-image':[capabilityModel(textImage)]},props={targetNode:source,nodes:[source],edges:[],toolbarContext:{canvasId:'project',models},models};
 const view=nativeImageToolbarProps(props,'N2r');
 for(const alias of [nativeQuickSceneAlias,nativePortraitAlias,nativePanoramaAlias])expect(view.toolbarContext.models['image-image'].find((row:any)=>row.modelCode===alias)).toMatchObject({capabilityRef:qwen.capabilityRef,modelName:model.modelName,config:model.config});
 expect(view.models).toBe(models);expect(models['image-image']).toHaveLength(1);expect(model.modelCode).toBe(qwen.capabilityRef);
});

it('preserves a named portrait condition when its exact native command uses the actual Qwen editor',async()=>{
 const f=fixture(),presetSelections=[{key:'age',id:'studio-portrait-930-v1',promptCode:'studio-portrait-930-v1'}],data={modelCode:nativePortraitAlias,toolsType:'image-image',isPortraitAdjustResult:true,presetSelections,toolsSourceUrl:'rhtv-asset:owned',generateNum:1,params:{prompt:'基于@图片1，按上述要求调整',imageUrls:['rhtv-asset:owned']}};
 await f.adapter.run({projectId:'project',targetType:'NODE',targetId:'result',graph:graph(data)});
 expect(f.submitted()).toMatchObject({capabilityRef:qwen.capabilityRef,presetSelections,params:data.params,routerParameters:{outputPreset:'1024-square'}});
});

it.each(['IMAGE_HD','IMAGE_GIGAPIXEL'])('validates the actual SeedVR2 catalog, source dimensions and STUDIO request for %s',async toolsType=>{
 const model=catalog.find(c=>c.capabilityRef==='seedvr2-image-enhance-v1')!;
 for(const width of [1024,1025]){
  let posted:any;const api=new ProductClient('/api/v1',async(path:string,init:any)=>{
   if(path.includes('/model-capabilities?'))return json({items:[model],nextCursor:null});
   if(path.startsWith('/api/v1/assets/'))return json({id:'owned',state:'READY',kind:'IMAGE',width,height:512,byteSize:4096});
   if(path==='/api/v2/canvas-runs'){exportNodeAction(init);posted=JSON.parse(init.body);return json({id:'task',state:'SUCCEEDED',plans:[]});}
   if(path==='/api/v2/generation-diagnostics')return json({logId:'test-diagnostic'});throw Error(path);
  });api.setAccessToken('fixture');const ex=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn(),{allowTestMode:false});
  const run=ex.run({canvasId:'p',targetId:'result',targetType:'NODE',graph:graph({modelCode:model.capabilityRef,toolsType:toolsType.toLowerCase().replaceAll('_','-'),toolsSourceUrl:'rhtv-asset:owned',params:{imageUrls:['rhtv-asset:owned'],outputPreset:'2x'}})});
  try{if(width===1024){await run;expect(posted.graph.nodes[1].data).toMatchObject({capabilityRef:model.capabilityRef,routerParameters:{outputPreset:'2x'}});}else{await expect(run).rejects.toThrow();expect(posted).toBeUndefined();}}finally{ex.clear();}
 }
});

it.each([{}, {sceneCode:'canvas-image-quick-create-not-registered'}])('keeps the user prompt mandatory for ordinary Qwen and unknown scenes',async extra=>{
 const f=fixture();await expect(f.adapter.run({projectId:'p',targetId:'result',targetType:'NODE',graph:graph({subType:'image-image',modelCode:qwen.capabilityRef,params:{imageUrls:['rhtv-asset:owned'],prompt:''},...extra})})).rejects.toThrow('填写画面描述');
 expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
});
