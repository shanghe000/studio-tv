import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {videoParameterSelection,selectVideoParameter} from '../../apps/web/src/service/video-parameter-options';
import {createH3ParameterControls} from '../../apps/web/src/service/h3-parameter-controls';
import {nativeVideoMenuProps} from '../../apps/web/src/service/video-model-menu';
import {videoPromptSelection} from '../../apps/web/src/service/video-reference-bindings';
import {createVideoSubjectControls,videoSubjectSelection} from '../../apps/web/src/service/video-subject-controls';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const presets=[{value:'wide-small-5',resolution:'720p',aspectRatio:'16:9',durationSeconds:5},{value:'wide-small-10',resolution:'720p',aspectRatio:'16:9',durationSeconds:10},{value:'wide-large-5',resolution:'1080p',aspectRatio:'16:9',durationSeconds:5},{value:'tall-small-5',resolution:'720p',aspectRatio:'9:16',durationSeconds:5}];
const capability=(mode='TEXT_TO_VIDEO',kind='TEXT_TO_VIDEO',available=true):any=>({capabilityRef:`official-${mode}`,version:'1',parameterSchemaVersion:'1',kind,available,reason:available?null:'尚未配置服务器 API Key',testMode:false,model:{providerRef:'official',modelRef:'model',title:'Video Model',version:'1'},inputKinds:['TEXT','IMAGE','VIDEO'],outputKinds:['VIDEO'],parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:presets.map(row=>row.value),default:presets[0].value}},'x-video-mode':mode,'x-video-parameter-metadata':{schemaVersion:'1',presets}}});
const field=(cap=capability())=>capabilityModel(cap).config.find(row=>row.paramName==='outputPreset')!;
const jsx=(type:any,props:any,key?:any)=>({type,key:key??null,props});
const react={createElement:(type:any,props:any,...children:any[])=>jsx(type,{...props,...(children.length?{children:children.length===1?children[0]:children}:{})},props?.key)};
const descendants=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(descendants):tree&&typeof tree==='object'?[tree,...descendants(tree.props?.children)]:[];

it('derives advertised tiers, ratios and constrained durations without inventing dimensions or combinations',()=>{
 const f=field(),before=structuredClone(f),view=videoParameterSelection(f,'wide-small-10')!;
 expect(view.ratios.map(row=>row.label)).toEqual(['16:9','9:16']);expect(view.resolutions.map(row=>row.id)).toEqual(['720p','1080p']);expect(view.durations).toEqual([5,10]);
 expect(selectVideoParameter(view,{resolution:'1080p'})).toBe('wide-large-5');expect(selectVideoParameter(view,{ratio:'9:16'})).toBe('tall-small-5');
 expect(selectVideoParameter(view,{resolution:'2k'})).toBeUndefined();expect(selectVideoParameter(view,{durationSeconds:7})).toBeUndefined();expect(selectVideoParameter(view,{ratio:'9:16',durationSeconds:10})).toBeUndefined();
 expect(videoParameterSelection(f,'wide-large-5')!.durations).toEqual([5]);expect(view.selected.preset).not.toHaveProperty('width');expect(f).toEqual(before);
});
it('rejects mismatched and malformed metadata while preserving the native field',()=>{
 for(const mutate of [(f:any)=>f.studioVideoParameterMetadata.presets.pop(),(f:any)=>f.optionValue.push({value:'invented'}),(f:any)=>f.studioVideoParameterMetadata.presets[0].durationSeconds=NaN,(f:any)=>f.studioVideoParameterMetadata.presets[0].width=1920,(f:any)=>f.studioVideoParameterMetadata.presets[0].aspectRatio='0:9',(f:any)=>f.studioVideoParameterMetadata.schemaVersion='2']){
  const f=structuredClone(field());mutate(f);const before=structuredClone(f);expect(videoParameterSelection(f,f.paramValue)).toBeUndefined();expect(f).toEqual(before);
 }
});
it('renders API-only presets with no fictional pixels and only actual parameter events',()=>{
 const f=field(),onChange=vi.fn(),tree=createH3ParameterControls(react)({field:f,value:'wide-small-10',onChange}),nodes=descendants(tree);
 expect(nodes.find(row=>row.props?.className==='studio-h3-output-summary')?.props.children).toBe('720P · 16:9 · 10秒');
 nodes.find(row=>row.props?.['data-h3-resolution']==='1080p').props.onClick();expect(onChange).toHaveBeenCalledExactlyOnceWith('outputPreset','wide-large-5');
 const adaptive=capability();adaptive.parameterSchema['x-video-parameter-metadata'].presets=[{value:'auto',resolution:'1080p',aspectRatio:'adaptive',durationSeconds:5}];adaptive.parameterSchema.properties.outputPreset={type:'string',enum:['auto'],default:'auto'};
 const adaptiveTree=createH3ParameterControls(react)({field:field(adaptive),value:'auto',onChange:vi.fn()});expect(descendants(adaptiveTree).some(row=>row.type==='span'&&row.props.children==='自动匹配参考素材')).toBe(true);
});
it('keeps a catalog auto duration as its exact sentinel and shows no numeric slider or invented seconds',()=>{
 const cap=capability('OMNI_REFERENCE','OMNI_REFERENCE');cap.parameterSchema['x-video-parameter-metadata'].presets=['480p','720p','1080p'].map(resolution=>({value:`${resolution}-adaptive-auto`,resolution,aspectRatio:'adaptive',durationSeconds:-1}));cap.parameterSchema.properties.outputPreset={type:'string',enum:['480p-adaptive-auto','720p-adaptive-auto','1080p-adaptive-auto'],default:'720p-adaptive-auto'};
 const f=field(cap),view=videoParameterSelection(f,'720p-adaptive-auto')!,onChange=vi.fn(),tree=createH3ParameterControls(react)({field:f,value:'720p-adaptive-auto',onChange}),nodes=descendants(tree);
 expect(view.durations).toEqual([-1]);expect(view.selected.preset.durationSeconds).toBe(-1);expect(nodes.some(node=>node.type==='input'&&node.props.type==='range')).toBe(false);expect(nodes.find(node=>node.type==='output')?.props.children).toBe('智能跟随');expect(nodes.find(node=>node.props?.className==='studio-h3-output-summary')?.props.children).toBe('720P · 自动匹配参考素材 · 智能跟随');
 nodes.find(node=>node.props?.['data-h3-resolution']==='1080p').props.onClick();expect(onChange).toHaveBeenCalledExactlyOnceWith('outputPreset','1080p-adaptive-auto');expect(selectVideoParameter(view,{durationSeconds:5})).toBeUndefined();
});
it('retains disabled official entries in only their true mode, while execution still rejects them',async()=>{
 const caps=[capability('TEXT_TO_VIDEO'),capability('FIRST_FRAME','IMAGE_TO_VIDEO',false),capability('FIRST_LAST_FRAME','IMAGE_TO_VIDEO',false),capability('OMNI_REFERENCE','OMNI_REFERENCE',false),capability('MOTION_TRANSFER','VIDEO_TO_VIDEO',false)];
 const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200}),transport=vi.fn(()=>Promise.resolve(json({items:caps,nextCursor:null}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('test-only');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn(),vi.fn(),{allowTestMode:false});
 const rows=await adapter.handle('/canvas/model/list',{types:['TEXT_VIDEO','START_VIDEO','START_END_VIDEO','MULTIMODAL_VIDEO','VIDEO_MOTION_TRANSFER','VIDEO_HD']});
 expect(rows.map((row:any)=>row.modelList.map((model:any)=>model.modelCode))).toEqual([['official-TEXT_TO_VIDEO'],['official-FIRST_FRAME'],['official-FIRST_LAST_FRAME'],['official-OMNI_REFERENCE'],['official-MOTION_TRANSFER'],[]]);
 expect(rows[1].modelList[0]).toMatchObject({available:false,disabled:true,reason:'尚未配置服务器 API Key',modelName:'Video Model'});
 await expect(adapter.run({projectId:'p',targetId:'n',graph:{nodes:[{id:'n',type:'rh-video',data:{modelCode:'official-FIRST_FRAME',subType:'start-video',params:{prompt:'move'}}}],edges:[]}})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});expect(transport.mock.calls.some(call=>String(call[0]).includes('/canvas-runs'))).toBe(false);adapter.clear();
});
it('feeds the real native cascade its disabled reason and blocks unavailable selection',()=>{
 const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=source.indexOf('function s2e('),end=source.indexOf('function ',start+12),native=runInNewContext(source.slice(start,end)+';s2e');
 const unavailable=capabilityModel(capability('FIRST_FRAME','IMAGE_TO_VIDEO',false)),available=capabilityModel(capability()),groups=[{modelGroupId:'root',modelGroupList:[{modelGroupId:'unavailable',nodeModelList:[{nodeType:'START_VIDEO',modelList:[unavailable]}]},{modelGroupId:'available',nodeModelList:[{nodeType:'TEXT_VIDEO',modelList:[available]}]}]}],onChange=vi.fn(),original=vi.fn(()=>undefined),props={groups,onChange,getDisabledReason:original};
 const projected=nativeVideoMenuProps(native,props);expect(projected.getDisabledReason(groups[0].modelGroupList[0])).toBe('尚未配置服务器 API Key');expect(projected.getDisabledReason(groups[0].modelGroupList[1])).toBeUndefined();expect(original).toHaveBeenCalledOnce();projected.onChange(unavailable.modelCode);expect(onChange).not.toHaveBeenCalled();projected.onChange(available.modelCode);expect(onChange).toHaveBeenCalledExactlyOnceWith(available.modelCode);
 const lookalike=function s2e(){return null;};expect(nativeVideoMenuProps(lookalike,props)).toBe(props);
});
it('serializes ordered first/last roles and targeted masks from actual STUDIO assets, rejecting missing and foreign media',()=>{
 const cap=capability('FIRST_LAST_FRAME','IMAGE_TO_VIDEO');cap.parameterSchema['x-media-roles']=[{role:'FIRST_FRAME',kind:'IMAGE',paramName:'imageUrls',index:0,minItems:1,maxItems:1,title:'首帧图片'},{role:'LAST_FRAME',kind:'IMAGE',paramName:'imageUrls',index:1,minItems:1,maxItems:1,title:'尾帧图片'},{role:'MASK',kind:'IMAGE',paramName:'referenceMask',targetParamName:'imageUrls',title:'参考图遮罩'}];
 const node:any={id:'n',type:'rh-video',data:{params:{imageUrls:['rhtv-asset:first','rhtv-asset:last'],referenceMask:'rhtv-asset:mask'},promptSelection:{schemaVersion:'1',conditions:{keep:'original'}}}},graph={nodes:[node],edges:[]};
 expect(videoPromptSelection(cap,node,graph)).toEqual({schemaVersion:'1',conditions:{keep:'original'},referenceBindings:[{assetId:'first',role:'FIRST_FRAME'},{assetId:'last',role:'LAST_FRAME'},{assetId:'mask',role:'MASK',targetAssetId:'first'}]});
 node.data.params.imageUrls=['rhtv-asset:first'];expect(()=>videoPromptSelection(cap,node,graph)).toThrowError(expect.objectContaining({code:'VIDEO_REFERENCE_REQUIRED'}));node.data.params.imageUrls=['https://example.com/foreign.png','rhtv-asset:last'];expect(()=>videoPromptSelection(cap,node,graph)).toThrowError(expect.objectContaining({code:'VIDEO_REFERENCE_REQUIRED'}));
});
it('submits declared motion roles and structured subject mapping through the real execution adapter',async()=>{
 const cap=capability('MOTION_TRANSFER','VIDEO_TO_VIDEO'),mapping=[{referenceSubjectIndex:0,sourceSubjectIndex:1}];
 cap.parameterSchema['x-media-limits']={IMAGE:1,VIDEO:1};cap.parameterSchema['x-media-roles']=[{role:'REFERENCE_IMAGE',kind:'IMAGE',paramName:'imageUrls',minItems:1,maxItems:1,title:'人物参考图片'},{role:'MOTION_REFERENCE',kind:'VIDEO',paramName:'videoUrls',minItems:1,maxItems:1,title:'动作源视频'}];cap.parameterSchema.properties.subjectMapping={type:'array',default:mapping,items:{type:'object',required:['referenceSubjectIndex','sourceSubjectIndex'],properties:{referenceSubjectIndex:{type:'integer',minimum:0,maximum:4},sourceSubjectIndex:{type:'integer',minimum:0,maximum:4}},additionalProperties:false}};
 const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200}),transport=vi.fn((path:string)=>Promise.resolve(path.includes('/model-capabilities')?json({items:[cap],nextCursor:null}):path.includes('/assets/')?json({id:path.split('/').at(-1),state:'READY',kind:path.endsWith('/motion')?'VIDEO':'IMAGE'}):json({id:'task',state:'SUCCEEDED',testMode:false,plans:[]}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn(),vi.fn(),{allowTestMode:false});
 const node={id:'n',type:'rh-video',data:{modelCode:cap.capabilityRef,subType:'video-motion-transfer',routerParameters:{outputPreset:presets[0].value,subjectMapping:[{referenceSubjectIndex:0,sourceSubjectIndex:0}]},params:{prompt:'original',outputPreset:presets[1].value,imageUrls:['rhtv-asset:reference'],videoUrls:['rhtv-asset:motion'],subjectMapping:mapping}}};
 await adapter.run({projectId:'p',targetId:'n',graph:{nodes:[node],edges:[]}});
 const submitted=JSON.parse(String(transport.mock.calls.find(call=>String(call[0]).includes('/canvas-runs'))?.[1]?.body)).graph.nodes[0].data;
 expect(submitted.promptSelection).toEqual({schemaVersion:'1',referenceBindings:[{assetId:'reference',role:'REFERENCE_IMAGE'},{assetId:'motion',role:'MOTION_REFERENCE'}]});expect(submitted.routerParameters).toEqual({outputPreset:presets[1].value,subjectMapping:mapping});expect(node.data).not.toHaveProperty('promptSelection');adapter.clear();
});
it.each(['text-stale-edge','first-last-extra-image'])('rejects incompatible actual canvas references without dropping them: %s',async scenario=>{
 const cap=capability(scenario==='text-stale-edge'?'TEXT_TO_VIDEO':'FIRST_LAST_FRAME',scenario==='text-stale-edge'?'TEXT_TO_VIDEO':'IMAGE_TO_VIDEO');cap.parameterSchema['x-media-limits']={IMAGE:scenario==='text-stale-edge'?0:2};
 const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200}),transport=vi.fn((path:string)=>Promise.resolve(path.includes('/model-capabilities')?json({items:[cap],nextCursor:null}):json({id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn(),vi.fn(),{allowTestMode:false});
 const target:any={id:'n',type:'rh-video',data:{modelCode:cap.capabilityRef,subType:scenario==='text-stale-edge'?'text-video':'start-end-video',params:{prompt:'move',...(scenario==='first-last-extra-image'?{imageUrls:['rhtv-asset:a','rhtv-asset:b','rhtv-asset:c']}:{})}}},graph=scenario==='text-stale-edge'?{nodes:[{id:'source',type:'rh-image',data:{sourceObjects:['rhtv-asset:a']}},target],edges:[{source:'source',target:'n'}]}:{nodes:[target],edges:[]},before=structuredClone(graph);
 await expect(adapter.run({projectId:'p',targetId:'n',graph})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED',message:expect.stringContaining('移除')});expect(graph).toEqual(before);expect(transport.mock.calls.some(call=>String(call[0]).includes('/canvas-runs'))).toBe(false);adapter.clear();
});

const mappingField=()=>({paramName:'subjectMapping',paramValue:[{referenceSubjectIndex:0,sourceSubjectIndex:0}],studioVideoSubjectMetadata:{control:{mode:'MULTI',mappingRequired:true,maskRequirement:'AUTO_SAM3_REQUIRED'},parameterSchema:{type:'array',minItems:1,maxItems:5,items:{type:'object',properties:{referenceSubjectIndex:{type:'integer',minimum:0,maximum:4},sourceSubjectIndex:{type:'integer',minimum:0,maximum:4}}}}}});
it('edits real SCAIL subject pairs as structured arrays with one-to-one zero-based identities',()=>{
 const field=mappingField(),onChange=vi.fn(),Component=createVideoSubjectControls(react),tree=Component({field,value:field.paramValue,onChange}),nodes=descendants(tree);
 nodes.find(row=>row.props?.className==='studio-video-subject-add').props.onClick();expect(onChange).toHaveBeenLastCalledWith('subjectMapping',[{referenceSubjectIndex:0,sourceSubjectIndex:0},{referenceSubjectIndex:1,sourceSubjectIndex:1}]);
 nodes.find(row=>row.type==='select'&&row.props['aria-label']==='配对 1 动作视频人物').props.onChange({currentTarget:{value:'3'}});expect(onChange).toHaveBeenLastCalledWith('subjectMapping',[{referenceSubjectIndex:0,sourceSubjectIndex:3}]);
 expect(videoSubjectSelection(field,[{referenceSubjectIndex:0,sourceSubjectIndex:0},{referenceSubjectIndex:0,sourceSubjectIndex:1}])).toBeUndefined();expect(videoSubjectSelection(field,[{referenceSubjectIndex:5,sourceSubjectIndex:0}])).toBeUndefined();expect(videoSubjectSelection(field,'[0,0]')).toBeUndefined();
 const otherMask=mappingField();otherMask.studioVideoSubjectMetadata.control.maskRequirement='INPUT_MASK';expect(videoSubjectSelection(otherMask,otherMask.paramValue)).toBeUndefined();
 const blocked=Component({field,value:field.paramValue,onChange,disabled:true}),count=onChange.mock.calls.length;descendants(blocked).find(row=>row.props?.className==='studio-video-subject-add').props.onClick();expect(onChange).toHaveBeenCalledTimes(count);
});
