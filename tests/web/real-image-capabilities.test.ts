import {frozenQuickSceneSubmit} from './helpers/frozen-quick-scene';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {nativeImageToolbarProps,nativeQuickSceneAlias,quickSceneCodes} from '../../apps/web/src/service/image-quick-scenes';
import type {Capability} from '../../apps/web/src/service/model-catalog';

const profile=(kind='IMAGE_TO_IMAGE'):Capability=>({capabilityRef:kind==='IMAGE_TO_IMAGE'?'codex-image-edit-v1':'codex-image-generate-v1',version:'1',parameterSchemaVersion:'1',available:true,testMode:false,kind,executionKind:'AGENT',parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1],default:1}},additionalProperties:false},inputKinds:['TEXT','STRUCTURED',...(kind==='IMAGE_TO_IMAGE'?['IMAGE']:[])],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'}});
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
const source={id:'source',type:'rh-image',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:owned'],output:[{assetId:'owned',outputType:'image/png'}]}};
const quick=(patch:any={})=>({id:'target',type:'rh-image',position:{x:400,y:0},data:{modelCode:nativeQuickSceneAlias,sceneCode:'canvas-image-quick-create-multi-camera-9-grid',toolsType:'image-image',toolsSourceUrl:'rhtv-asset:owned',generateNum:1,params:{prompt:'',imageUrls:['rhtv-asset:owned']},...patch}});
function fixture(){
 const caps=[profile('TEXT_TO_IMAGE'),profile(),{...profile(),capabilityRef:'codex-6-1-vision-text-v1',kind:'IMAGE_UNDERSTANDING',outputKinds:['TEXT']}],transport=vi.fn(async(path:string)=>{
  if(path.includes('/model-capabilities?'))return json({items:caps,nextCursor:null});
  if(path.startsWith('/api/v2/model-capability-version?'))return new Response(JSON.stringify({code:'MODEL_NOT_FOUND',message:'Unknown exact version'}),{status:404});
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1)!,kind=id==='video'?'VIDEO':id==='audio'?'AUDIO':id==='file'?'FILE':'IMAGE';return json({id,state:'READY',kind,byteSize:2048,mimeType:{IMAGE:'image/png',VIDEO:'video/mp4',AUDIO:'audio/wav',FILE:'application/octet-stream'}[kind]});}
  if(path==='/api/v2/generation-diagnostics')return json({logId:'diagnostic-log-id'},202);
  if(path==='/api/v2/canvas-runs')return json({id:'task',state:'SUCCEEDED',plans:[],testMode:false},202);
  throw new Error('Unexpected fixture request: '+path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,vi.fn().mockResolvedValue(undefined),vi.fn());
 return{adapter,transport,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes.find((node:any)=>node.id==='target').data};
}

it('uses the original 1x control and true kind-specific names without duplicate count or unsupported size parameters',async()=>{
 const f=fixture(),models=await f.adapter.handle('/canvas/model/list',{});
 expect(models.find((row:any)=>row.type==='TEXT_IMAGE').modelList.map((row:any)=>row.modelCode)).toEqual(['codex-image-generate-v1']);expect(models.find((row:any)=>row.type==='IMAGE_IMAGE').modelList.map((row:any)=>row.modelCode)).toEqual(['codex-image-edit-v1']);
 for(const kind of ['TEXT_TO_IMAGE','IMAGE_TO_IMAGE']){const model=capabilityModel(profile(kind));expect(model.modelName).toBe('Codex Image');expect(model.generateNum).toEqual([1]);expect(model.config.map(field=>field.paramName)).toEqual(kind==='TEXT_TO_IMAGE'?['prompt']:['prompt','imageUrls']);expect(model.config.some(field=>/size|aspect|width|height|reasoning|count/.test(field.paramName))).toBe(false);}
});

it.each(['TEXT_TO_IMAGE','IMAGE_TO_IMAGE'])('binds the real %s ref and single-count contract while preserving user prompt and native conditions',async kind=>{
 const f=fixture(),cap=profile(kind),data={modelCode:cap.capabilityRef,subType:kind==='TEXT_TO_IMAGE'?'text-image':'image-image',generateNum:1,params:{prompt:'Original USER description',...(kind==='IMAGE_TO_IMAGE'?{imageUrls:['rhtv-asset:owned']}:{})},presetSelections:[{id:'original-style',prompt:'original preset'}]},before=structuredClone(data);await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[{id:'target',type:'rh-image',position:{x:0,y:0},data}],edges:[]}});
 expect(f.submitted()).toMatchObject({capabilityRef:cap.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',routerParameters:{count:1},params:before.params,presetSelections:before.presetSelections});expect(data).toEqual(before);
});

it.each([2,4,0,-1,1.5,'1',null])('rejects visible native count %j ahead of the previous accepted count1',async count=>{
 const cap=profile(),f=fixture();expect(()=>routerParameters(cap,{generateNum:count,routerParameters:{count:1}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[{...quick(),data:{modelCode:cap.capabilityRef,subType:'image-image',generateNum:count,params:{prompt:'User',imageUrls:['rhtv-asset:owned']},routerParameters:{count:1}}}],edges:[]}})).rejects.toMatchObject({code:'MODEL_PARAMETER_INVALID'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('does not project count when the capability does not advertise it, and supports advertised non-image count without changing its panel',()=>{
 expect(routerParameters({...profile(),parameterSchema:{type:'object',properties:{},additionalProperties:false}},{generateNum:4,routerParameters:{count:1}})).toEqual({});const model=capabilityModel({...profile(),model:undefined,parameterSchema:{properties:{count:{type:'integer',default:1}}}});expect(model.config.find(field=>field.paramName==='count')?.type).toBe('int');
});

it('maps only the exact native quickscene default with one actor-owned IMAGE and freezes the public edit capability',async()=>{
 const f=fixture(),node=quick(),graph={nodes:[source,node],edges:[{source:'source',target:'target'}]},before=structuredClone(graph);await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph});expect(f.submitted()).toMatchObject({modelCode:profile().capabilityRef,capabilityRef:profile().capabilityRef,capabilityVersion:'1',sceneCode:node.data.sceneCode,toolsType:node.data.toolsType,toolsSourceUrl:'rhtv-asset:owned',routerParameters:{count:1},params:{prompt:'',imageUrls:['rhtv-asset:owned']}});expect(graph).toEqual(before);
});

it.each([
 ['unknown alias',{modelCode:'unknown-vendor-model'}],['other fixed vendor',{modelCode:'seedream-v5-pro-image-to-image'}],['unknown scene',{sceneCode:'canvas-image-quick-create-unknown'}],['wrong tool',{toolsType:'image-cutout'}],['explicit alias ref',{capabilityRef:nativeQuickSceneAlias}],['explicit version',{capabilityVersion:'1'}],['nonempty prompt',{params:{prompt:'User supplied prompt',imageUrls:['rhtv-asset:owned']}}],['missing image',{params:{prompt:'',imageUrls:[]}}],['different image',{params:{prompt:'',imageUrls:['rhtv-asset:other']}}],['multiple images',{params:{prompt:'',imageUrls:['rhtv-asset:owned','rhtv-asset:other']}}],['multiple count',{generateNum:2}],['VIDEO input',{toolsSourceUrl:'rhtv-asset:video',params:{prompt:'',imageUrls:['rhtv-asset:video']}}],
])('refuses %s without any generic legacy-image fallback',async(_label,patch)=>{
 const f=fixture();await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[quick(patch)],edges:[]}})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('does not drop additional upstream images to make a single-reference edit look supported',async()=>{
 const f=fixture(),extra={...source,data:{...source.data,output:[{assetId:'owned',outputType:'image/png'},{assetId:'other',outputType:'image/png'}]}};await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[extra,quick()],edges:[{source:'source',target:'target'}]}})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('rejects IMAGE conditioning for the real text-to-image profile rather than selecting edit silently',async()=>{
 const f=fixture();await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[{...quick(),data:{modelCode:profile('TEXT_TO_IMAGE').capabilityRef,subType:'text-image',params:{prompt:'Original',imageUrls:['rhtv-asset:owned']}}}],edges:[]}})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('runs the frozen LEr/uEt builders through the actual STUDIO boundary with the public image config and preserves exact scene/reference semantics',async()=>{
 const f=fixture(),cap=profile(),model=capabilityModel(cap),props={targetNode:source,nodes:[source],edges:[],models:{'image-image':[model]},toolbarContext:{canvasId:'p',canvasName:'Original project',models:{'image-image':[model]}},onNodeDataPatch:vi.fn()},view=nativeImageToolbarProps(props,'N2r'),run=frozenQuickSceneSubmit('target',body=>f.adapter.run(body));
 expect(await run(view.toolbarContext,source,'rhtv-asset:owned',{sceneCode:quick().data.sceneCode,titleKey:'original title',paramOverrides:{resolution:'2k'}})).toBe(true);expect(f.submitted()).toMatchObject({capabilityRef:cap.capabilityRef,sceneCode:quick().data.sceneCode,routerParameters:{count:1},params:{prompt:'',imageUrls:['rhtv-asset:owned'],resolution:'2k'}});
});


it.each([...quickSceneCodes])('accepts generated-image chaining for %s without replaying ancestor references',async sceneCode=>{
 const f=fixture(),parent={id:'parent',type:'rh-image',data:{isUpload:true,sourceObjects:['rhtv-asset:other']}},generated={...source,data:{...source.data,isUpload:false,params:{imageUrls:['rhtv-asset:other']},historyStorage:{historyId:'previous'}}};
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[parent,generated,quick({sceneCode})],edges:[{source:'parent',target:'source'},{source:'source',target:'target'}]}});
 expect(f.submitted()).toMatchObject({capabilityRef:'codex-image-edit-v1',sceneCode,params:{prompt:'',imageUrls:['rhtv-asset:owned']}});
});


it('reports a preflight rejection without prompt, reference URLs or arbitrary graph data',async()=>{
 const f=fixture();await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:{nodes:[quick({modelCode:'unknown-model',params:{prompt:'private text',imageUrls:['rhtv-asset:owned']}})],edges:[]}})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE',requestId:'diagnostic-log-id'});
 const call=f.transport.mock.calls.find(call=>call[0]==='/api/v2/generation-diagnostics')!;expect(JSON.parse(call[1].body)).toEqual({clientSnapshot:expect.objectContaining({targetType:'NODE',phase:'PREPARE',nodeCount:1}),projectId:'p',nodeId:'target',errorCode:'MODEL_UNAVAILABLE',sceneCode:quick().data.sceneCode,preflight:{schemaVersion:'1',capabilityRef:'unknown-model',requestedKind:'IMAGE_TO_IMAGE',inputKinds:['IMAGE'],issues:[{field:'model.kind',reason:'MODEL_UNAVAILABLE'}]}});expect(call[1].body).not.toContain('private text');expect(call[1].body).not.toContain('rhtv-asset:owned');
});
