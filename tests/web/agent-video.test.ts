import {expect,it,vi} from 'vitest';
import {h3InputError,h3Parameters,h3FileError} from '../../apps/web/src/service/h3-input';
import {launchAgentVideo} from '../../apps/web/src/service/agent-video';
import {modelKindLabel} from '../../apps/web/src/service/execution';
import {videoInputError,videoParameters,videoUploadAccept,videoUploadFileError} from '../../apps/web/src/service/video-input';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const cap=(mode='FIRST_FRAME',limits={IMAGE:1,AUDIO:0,VIDEO:0}):any=>({capabilityRef:'h3-test',version:'1',parameterSchemaVersion:'1',title:'H3 · 首帧视频',available:true,testMode:false,model:{modelRef:'h3'},outputKinds:['VIDEO'],parameterSchema:{'x-video-mode':mode,'x-media-limits':limits,properties:{outputPreset:{enum:['480p-landscape-5s'],default:'480p-landscape-5s'}}}});
it('requires visual inputs, exact frame counts and the advertised per-kind limits',()=>{
 expect(h3InputError(cap(),[])).toContain('1 张');expect(h3InputError(cap(),[{type:'image'}])).toBeNull();expect(h3InputError(cap(),[{type:'video'}])).toContain('不支持视频');
 expect(h3InputError(cap('FIRST_LAST_FRAME',{IMAGE:2,AUDIO:0,VIDEO:0}),[{type:'image'}])).toContain('2 张');
 const omni=cap('OMNI_REFERENCE',{IMAGE:9,AUDIO:3,VIDEO:1});expect(h3InputError(omni,[{type:'audio'}])).toContain('视觉参考');
 expect(h3InputError(omni,[...Array(8).fill({type:'image'}),...Array(3).fill({type:'audio'}),{type:'video'}])).toBeNull();
 expect(h3InputError(omni,[...Array(9).fill({type:'image'}),...Array(3).fill({type:'audio'}),{type:'video'}])).toContain('12');
 expect(h3InputError(cap(),[{type:'image',uploading:true}])).toContain('等待');expect(h3InputError({...cap(),available:false},[{type:'image'}])).toContain('可用');
});
it('uses only advertised parameter values and supported upload types/sizes',()=>{
 expect(h3Parameters(cap(),{})).toEqual({outputPreset:'480p-landscape-5s'});expect(()=>h3Parameters(cap(),{outputPreset:'1080p-15s'})).toThrow('支持');
 expect(h3Parameters(cap(),{fps:60,secret:'ignore'})).toEqual({outputPreset:'480p-landscape-5s'});
 expect(h3FileError({type:'image/png',size:10*1024*1024} as File)).toBeNull();expect(h3FileError({type:'video/mp4',size:65*1024*1024} as File)).toContain('64');expect(h3FileError({type:'image/gif',size:10} as File)).toContain('PNG');
});
function setup(c=cap('FIRST_LAST_FRAME',{IMAGE:2,AUDIO:0,VIDEO:0})){
 const graph={nodes:[] as any[],edges:[] as any[]},manager={getRemoteData:()=>graph,addNode:vi.fn(n=>graph.nodes.push(n)),addEdge:vi.fn(e=>graph.edges.push(e)),flushOperationQueue:vi.fn(),patchNodeData:vi.fn()},run=vi.fn(async()=>({taskId:'task',testMode:false})),runtime={auth:{user:{id:'user'}},inspect:()=>({id:'project'}),storage:{requirePermission:vi.fn(),resolveAsset:vi.fn(async(url:string)=>({id:url,kind:'IMAGE',fileName:url}))},execution:{catalog:vi.fn(async()=>[c]),run}},native={bt:()=>manager};return{graph,manager,runtime,native,run};
}
const request={capabilityRef:'h3-test',version:'1',prompt:'让橙球滚动',attachments:[{url:'first',type:'image',name:'首帧'},{url:'last',type:'image',name:'尾帧'}],parameters:{outputPreset:'480p-landscape-5s'}};
it('creates ordered reference nodes and submits the video through ordinary persistent node execution',async()=>{
 const s=setup(),result=await launchAgentVideo(s.runtime,s.native,request);
 expect(s.graph.nodes.map(n=>n.data.title)).toEqual(['首帧','尾帧','H3 · 首帧视频']);expect(s.graph.edges.map(e=>e.source)).toEqual(s.graph.nodes.slice(0,2).map(n=>n.id));
 expect(s.graph.nodes[2].data).toMatchObject({capabilityVersion:'1',subType:'start-end-video',params:{prompt:request.prompt,outputPreset:'480p-landscape-5s'},generateNum:1});
 expect(s.run).toHaveBeenCalledOnce();expect(s.run.mock.calls[0][0]).toMatchObject({projectId:'project',targetType:'NODE',targetId:result.nodeId});
});
it('rejects invalid parameters and a changed canvas before adding nodes or submitting a task',async()=>{
 const s=setup();await expect(launchAgentVideo(s.runtime,s.native,{...request,parameters:{outputPreset:'unsupported'}})).rejects.toThrow('支持');expect(s.manager.addNode).not.toHaveBeenCalled();
 s.runtime.storage.resolveAsset.mockImplementation(async(url:string)=>{s.runtime.auth.user.id='other';return{id:url,kind:'IMAGE',fileName:url};});await expect(launchAgentVideo(s.runtime,s.native,request)).rejects.toThrow('切换');expect(s.run).not.toHaveBeenCalled();expect(s.manager.addNode).not.toHaveBeenCalled();
});
it('keeps failed submissions visible on their own node without claiming success',async()=>{
 const s=setup();s.run.mockRejectedValue(new Error('service unavailable'));await expect(launchAgentVideo(s.runtime,s.native,request)).rejects.toThrow('unavailable');expect(s.manager.patchNodeData).toHaveBeenCalledWith(s.graph.nodes[2].id,{status:'failed',errorMsg:'service unavailable'});
});
it('renders readable group labels while preserving model identifiers',()=>{expect(modelKindLabel('OMNI_REFERENCE')).toBe('全能参考');expect(modelKindLabel('IMAGE_TO_VIDEO',true)).toBe('Image to video');expect(modelKindLabel('UNKNOWN_MODEL_KIND',true)).toBe('Unknown model kind');});

it('renders only the duration choices advertised for that mode with readable labels',async()=>{
 const {capabilityModel}=await import('../../apps/web/src/service/execution');
 const first=cap(),long=cap('FIRST_LAST_FRAME',{IMAGE:2,AUDIO:0,VIDEO:0});long.version='2';long.parameterSchemaVersion='2';long.parameterSchema.properties.outputPreset={type:'string',enum:['480p-landscape-5s','480p-landscape-10s','480p-landscape-15s'],default:'480p-landscape-5s',title:'时长（横屏 480p / 24fps）','x-enum-labels':{'480p-landscape-5s':'5 秒','480p-landscape-10s':'10 秒','480p-landscape-15s':'15 秒'}};
 const field=capabilityModel(long).config.find(f=>f.paramName==='outputPreset');expect(field?.optionValue?.map((v:any)=>v.labelCn)).toEqual(['5 秒','10 秒','15 秒']);
 expect(h3Parameters(long,{outputPreset:'480p-landscape-15s'})).toEqual({outputPreset:'480p-landscape-15s'});expect(()=>h3Parameters(first,{outputPreset:'480p-landscape-10s'})).toThrow('支持');
 const s=setup(long);await launchAgentVideo(s.runtime,s.native,{...request,version:'2',parameters:{outputPreset:'480p-landscape-10s'}});
 expect(s.graph.nodes[2].data).toMatchObject({capabilityVersion:'2',parameterSchemaVersion:'2',routerParameters:{outputPreset:'480p-landscape-10s'}});
});

it('keeps both new official H3 reference profiles selectable with their exact output tuples',async()=>{
 const {capabilityModel}=await import('../../apps/web/src/service/execution');
 const {isH3,h3OutputPresets}=await import('../../apps/web/src/service/h3-input');
 for(const [ref,title]of [['h3-drama-reference-v1','MiniMax H3 · 单采极速文戏'],['h3-action-reference-v1','MiniMax H3 · 最强武戏']]){
  const c=cap('OMNI_REFERENCE',{IMAGE:6,AUDIO:1,VIDEO:1});c.capabilityRef=ref;c.kind='OMNI_REFERENCE';c.title=title;
  c.parameterSchema.properties.outputPreset={type:'string',enum:['portrait-10s','landscape-5s'],default:'portrait-10s'};
  c.parameterSchema['x-output-presets']=[{value:'portrait-10s',width:768,height:1376,aspectRatio:'9:16',durationSeconds:10,fps:24},{value:'landscape-5s',width:864,height:480,aspectRatio:'16:9',durationSeconds:5,fps:24},{value:'unsupported',width:3840,height:2160,aspectRatio:'16:9',durationSeconds:30,fps:60}];
  expect(isH3(c)).toBe(true);expect(h3OutputPresets(c)).toHaveLength(2);
  const menu=capabilityModel(c);expect(menu.modelName).toBe(title);
  expect(menu.config.find((f:any)=>f.paramName==='outputPreset')?.optionValue?.map((v:any)=>v.labelCn)).toEqual(['9:16 · 768×1376 · 10 秒 / 24fps','16:9 · 864×480 · 5 秒 / 24fps']);
  expect(()=>h3Parameters(c,{outputPreset:'unsupported'})).toThrow('支持');
 }
});

function generic(mode:string){
 const kind=mode==='TEXT_TO_VIDEO'?'TEXT_TO_VIDEO':mode==='MOTION_TRANSFER'?'VIDEO_TO_VIDEO':mode==='OMNI_REFERENCE'?'OMNI_REFERENCE':'IMAGE_TO_VIDEO',limits={IMAGE:mode==='TEXT_TO_VIDEO'?0:mode==='FIRST_LAST_FRAME'?2:1,VIDEO:mode==='MOTION_TRANSFER'?1:0,AUDIO:0};
 const c:any={capabilityRef:'official-'+mode,version:'1',parameterSchemaVersion:'1',title:'Video · '+mode,available:true,testMode:false,kind,model:{providerRef:'supplier',modelRef:'official',title:'Video',version:'1'},inputKinds:['TEXT','STRUCTURED',...(limits.IMAGE?['IMAGE']:[]),...(limits.VIDEO?['VIDEO']:[])],outputKinds:['VIDEO'],parameterSchema:{type:'object',required:['outputPreset'],additionalProperties:false,'x-video-mode':mode,'x-media-limits':limits,'x-media-total-limit':2,'x-video-parameter-metadata':{schemaVersion:'1',presets:[{value:'720p-5s',resolution:'720p',aspectRatio:'16:9',durationSeconds:5}]},properties:{outputPreset:{type:'string',enum:['720p-5s'],default:'720p-5s'}}}};
 c.parameterSchema['x-media-roles']=mode==='TEXT_TO_VIDEO'?[]:mode==='FIRST_LAST_FRAME'?[{role:'FIRST_FRAME',kind:'IMAGE',paramName:'imageUrls',index:0,minItems:1,maxItems:1,title:'首帧图片'},{role:'LAST_FRAME',kind:'IMAGE',paramName:'imageUrls',index:1,minItems:1,maxItems:1,title:'尾帧图片'}]:[{role:mode==='LAST_FRAME'?'LAST_FRAME':mode==='FIRST_FRAME'?'FIRST_FRAME':'REFERENCE_IMAGE',kind:'IMAGE',paramName:'imageUrls',minItems:1,maxItems:1,title:'参考图片'},...(limits.VIDEO?[{role:'MOTION_REFERENCE',kind:'VIDEO',paramName:'videoUrls',minItems:1,maxItems:1,title:'动作源视频'}]:[])];
 if(mode==='MOTION_TRANSFER'){c.parameterSchema['x-prompt-policy']='ignored';c.parameterSchema['x-subject-control']={mode:'MULTI',mappingRequired:true,maskRequirement:'AUTO_SAM3_REQUIRED'};c.parameterSchema.properties.subjectMapping={type:'array',minItems:1,maxItems:5,default:[{referenceSubjectIndex:0,sourceSubjectIndex:0}],items:{type:'object',required:['referenceSubjectIndex','sourceSubjectIndex'],additionalProperties:false,properties:{referenceSubjectIndex:{type:'integer',minimum:0,maximum:4},sourceSubjectIndex:{type:'integer',minimum:0,maximum:4}}}};}
 return c;
}
it.each([['TEXT_TO_VIDEO','text-video',[],[]],['FIRST_FRAME','start-video',['image'],['FIRST_FRAME']],['LAST_FRAME','end-video',['image'],['LAST_FRAME']],['FIRST_LAST_FRAME','start-end-video',['image','image'],['FIRST_FRAME','LAST_FRAME']],['MOTION_TRANSFER','video-motion-transfer',['image','video'],['REFERENCE_IMAGE','MOTION_REFERENCE']]])('launches the actual Agent %s entry through real execution serialization',async(mode,subType,kinds,roles)=>{
 const c=generic(mode),json=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200}),transport=vi.fn((path:string)=>Promise.resolve(path.includes('/model-capabilities')?json({items:[c],nextCursor:null}):path.includes('/assets/')?json({id:path.split('/').at(-1),kind:path.endsWith('/asset1')&&mode==='MOTION_TRANSFER'?'VIDEO':'IMAGE',state:'READY'}):json({id:'task',state:'SUCCEEDED',plans:[],testMode:false}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');
 const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn(),{allowTestMode:false}),graph={nodes:[] as any[],edges:[] as any[]},manager={getRemoteData:()=>graph,addNode:(n:any)=>graph.nodes.push(n),addEdge:(e:any)=>graph.edges.push(e),flushOperationQueue:vi.fn(),patchNodeData:vi.fn()},runtime={auth:{user:{id:'fixture-user'}},inspect:()=>({id:'p'}),storage,execution},native={bt:()=>manager};
 const parameters=mode==='MOTION_TRANSFER'?{subjectMapping:[{referenceSubjectIndex:0,sourceSubjectIndex:3}]}:{};
 await launchAgentVideo(runtime,native,{capabilityRef:c.capabilityRef,version:'1',prompt:mode==='MOTION_TRANSFER'?'':'move',attachments:(kinds as string[]).map((type,index)=>({url:'rhtv-asset:asset'+index,type,name:type})),parameters});
 const submitted=JSON.parse(String(transport.mock.calls.find(call=>String(call[0]).includes('/canvas-runs'))?.[1]?.body)),node=submitted.graph.nodes.find((node:any)=>node.data?.capabilityRef===c.capabilityRef);
 expect(node.data.subType).toBe(subType);expect(node.data.routerParameters.outputPreset).toBe('720p-5s');expect(node.data.promptSelection?.referenceBindings?.map((binding:any)=>binding.role)??[]).toEqual(roles);expect(submitted.graph.edges).toHaveLength((kinds as string[]).length);
 if(mode==='MOTION_TRANSFER'){expect(node.data.params.subjectMapping).toEqual(parameters.subjectMapping);expect(node.data.routerParameters.subjectMapping).toEqual(parameters.subjectMapping);expect(node.data.params.subjectMapping[0].sourceSubjectIndex).toBeTypeOf('number');}
 execution.clear();
});
it('requires removal of stale references after a mode switch and preserves explicit unavailable reasons',async()=>{
 expect(videoInputError(generic('TEXT_TO_VIDEO'),[{type:'image'}])).toContain('移除');expect(videoInputError(generic('FIRST_LAST_FRAME'),[{type:'image'}])).toContain('2 张');expect(videoInputError(generic('LAST_FRAME'),[])).toContain('尾帧');
 const c=generic('TEXT_TO_VIDEO'),s=setup(c);await expect(launchAgentVideo(s.runtime,s.native,{...request,capabilityRef:c.capabilityRef,attachments:request.attachments,parameters:{}})).rejects.toThrow('移除');expect(s.manager.addNode).not.toHaveBeenCalled();
 c.available=false;c.reason='缺少服务器密钥';await expect(launchAgentVideo(s.runtime,s.native,{...request,capabilityRef:c.capabilityRef,attachments:[],parameters:{}})).rejects.toThrow('缺少服务器密钥');expect(s.manager.addNode).not.toHaveBeenCalled();
 const motion=generic('MOTION_TRANSFER');expect(()=>videoParameters(motion,{subjectMapping:'[{"referenceSubjectIndex":0,"sourceSubjectIndex":0}]'})).toThrow('支持');expect(()=>videoParameters(motion,{subjectMapping:[{referenceSubjectIndex:0,sourceSubjectIndex:0},{referenceSubjectIndex:0,sourceSubjectIndex:1}]})).toThrow('配对');
});
it('uses the declared ANY_MEDIA/VISUAL reference requirement without inferring a vendor',()=>{
 const cap=generic('OMNI_REFERENCE');cap.parameterSchema['x-media-limits'].AUDIO=3;cap.parameterSchema['x-media-roles']=[];
 expect(videoInputError(cap,[{type:'audio'}])).toContain('视觉');cap.parameterSchema['x-reference-requirement']='ANY_MEDIA';expect(videoInputError(cap,[{type:'audio'}])).toBeNull();expect(videoInputError(cap,[])).toContain('音频参考');cap.parameterSchema['x-reference-requirement']='VISUAL';expect(videoInputError(cap,[{type:'audio'}])).toContain('视觉');
});
it('keeps subjectMapping as a typed array through the actual frozen Od and nk commit callback',()=>{
 const cap=generic('MOTION_TRANSFER'),model=capabilityModel(cap),mapping=[{referenceSubjectIndex:0,sourceSubjectIndex:3},{referenceSubjectIndex:1,sourceSubjectIndex:0}],patch=vi.fn();
 const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),odStart=source.indexOf('function Od('),odEnd=source.indexOf('function ',odStart+12),nk=source.indexOf('function nk('),start=source.indexOf('const j=d.useCallback(',nk)+'const j=d.useCallback('.length,end=source.indexOf(',[g,T,r,o,y,A,h,w,u])',start);
 const commit=runInNewContext(source.slice(odStart,odEnd)+';('+source.slice(start,end)+')',{g:'n',y:{modelCode:cap.capabilityRef,params:{}},T:[model],r:{'video-motion-transfer':[model]},o:[],A:model,u:undefined,w:'video-motion-transfer',X:{current:{}},u7e:()=>model,E3:vi.fn(),kR:'nativeUnused',Xu:{getState:()=>({save:vi.fn()})},Z_e:()=>({}),h:patch,Q0:()=>[],kx:{INT:'int',STRING:'string',ARRAY_INT:'arrayInt',ARRAY_STRING:'arrayString',BOOLEAN:'boolean',FLOAT:'float'}});
 commit({rhModel:cap.capabilityRef,generateNum:1,outputPreset:'720p-5s',subjectMapping:mapping});
 expect(model.config.find(field=>field.paramName==='subjectMapping')?.paramDataType).toBe('arrayObject');expect(patch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({params:{outputPreset:'720p-5s',subjectMapping:mapping}}));expect(Array.isArray(patch.mock.calls[0][0].params.subjectMapping)).toBe(true);expect(patch.mock.calls[0][0].params.subjectMapping[0].sourceSubjectIndex).toBeTypeOf('number');
});

it('filters attachment picking by the selected model and checks only its own byte limit',()=>{
 const selected=cap('OMNI_REFERENCE',{IMAGE:1,VIDEO:1,AUDIO:1});
 selected.parameterSchema['x-input-media-constraints']={schemaVersion:'1',kinds:{IMAGE:{maxBytes:6*1048576,mimeTypes:['image/png']},VIDEO:{mimeTypes:['video/mp4']},AUDIO:{mimeTypes:['audio/wav']}}};
 expect(videoUploadAccept(selected).split(',')).toEqual(['image/png','video/mp4','audio/wav','audio/x-wav']);
 expect(videoUploadFileError(selected,{type:'image/png',size:5*1048576} as File)).toBeNull();
 expect(videoUploadFileError(selected,{type:'image/png',size:7*1048576} as File)).toContain('6 MiB');
 expect(videoUploadFileError(selected,{type:'image/jpeg',size:10} as File)).toContain('image/png');
 expect(videoUploadFileError(selected,{type:'audio/aiff',size:10} as File)).toContain('画布不支持');
 expect(videoUploadFileError(selected,{type:'audio/x-wav',size:10} as File)).toBeNull();
});
