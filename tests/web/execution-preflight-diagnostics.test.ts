import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {modelSelections,type Capability} from '../../apps/web/src/service/model-catalog';
import {launchAgentVideo} from '../../apps/web/src/service/agent-video';

const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
const text:Capability={capabilityRef:'text-only-v1',version:'7',kind:'LLM',available:true,testMode:false,executionKind:'AGENT',parameterSchemaVersion:'1',parameterSchema:{properties:{}},inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'fixture',modelRef:'text-only',title:'文字模型',version:'7'}};
const vision:Capability={...text,capabilityRef:'vision-v1',kind:'IMAGE_UNDERSTANDING',inputKinds:['TEXT','STRUCTURED','IMAGE'],model:{...text.model!,modelRef:'vision',title:'图片理解模型'}};
const badNode=()=>({id:'bad-child',type:'rh-text',parentNode:'group',data:{modelCode:text.capabilityRef,capabilityVersion:text.version,sceneCode:'canvas-image-understanding',params:{prompt:'PRIVATE_USER_PROMPT',imageUrls:['rhtv-asset:image']}}});
const graph=()=>({nodes:[{id:'group',type:'rh-group',data:{}},badNode()],edges:[]});
function fixture(options:{saved?:()=>Promise<void>;diagnostics?:(body:any)=>Response|Promise<Response>;catalog?:()=>Response|Promise<Response>;post?:()=>Response|Promise<Response>}={}){
 const notice=vi.fn(),transport=vi.fn(async(path:string,init:any)=>{
  if(path.includes('/model-capabilities?'))return options.catalog?.()??json({items:[text,vision],nextCursor:null});
  if(path==='/api/v1/assets/image')return json({id:'image',state:'READY',kind:'IMAGE',fileName:'PRIVATE_FILE_NAME.png',downloadUrl:'https://cdn.invalid/private.png?signature=PRIVATE_SIGNATURE'});
  if(path==='/api/v1/assets/video')return json({id:'video',state:'READY',kind:'VIDEO'});
  if(path==='/api/v2/canvas-runs'&&options.post)return options.post();
  if(path==='/api/v2/generation-diagnostics')return options.diagnostics?.(JSON.parse(init.body))??json({logId:'diagnostic-log'},202);
  throw new Error('Unexpected fixture request: '+path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const storage=new ServiceStorage(api,notice),saved=vi.fn(options.saved??(async()=>{})),adapter=new ExecutionAdapter(api,storage,saved,notice);
 const diagnostics=()=>transport.mock.calls.filter(([path])=>path==='/api/v2/generation-diagnostics').map(([,init])=>JSON.parse(init.body));
 return{adapter,api,storage,transport,saved,notice,diagnostics};
}
afterEach(()=>modelSelections.clear());

it.each(['GROUP','CANVAS'])('records the actual failing child for a %s command with model, version and unsupported kind',async targetType=>{
 const f=fixture();
 try{
  const error=await f.adapter.run({projectId:'project-original',targetType,targetId:targetType==='GROUP'?'group':'',graph:graph()}).catch(error=>error);
  expect(error).toMatchObject({code:'MODEL_INPUT_UNSUPPORTED',requestId:'diagnostic-log'});
  expect(error.message).toContain('版本 7');expect(error.message).toContain('图片');
  expect(f.diagnostics()).toHaveLength(1);expect(f.diagnostics()[0]).toMatchObject({projectId:'project-original',nodeId:'bad-child',sceneCode:'canvas-image-understanding',errorCode:'MODEL_INPUT_UNSUPPORTED',preflight:{schemaVersion:'1',capabilityRef:text.capabilityRef,capabilityVersion:'7',requestedKind:'IMAGE_UNDERSTANDING',inputKinds:['IMAGE'],issues:expect.arrayContaining([expect.objectContaining({field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:'IMAGE',assetId:'image',sourceNodeId:'bad-child',expectedKinds:['TEXT','STRUCTURED']})])}});
  const payload=JSON.stringify(f.diagnostics()[0]);for(const secret of ['PRIVATE_USER_PROMPT','PRIVATE_FILE_NAME','PRIVATE_SIGNATURE','https://','fixture-owner'])expect(payload).not.toContain(secret);
  expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
 }finally{f.adapter.clear();}
});

it.each(['linked-only','projected-reference'])('identifies the uploaded asset and upstream source node without inventing a reference position: %s',async mode=>{
 const f=fixture(),target={...badNode(),data:{...badNode().data,params:{prompt:'PRIVATE_LINKED_PROMPT'}}};
 if(mode==='projected-reference')Object.assign(target.data.params,{imageUrls:['rhtv-asset:image']});
 const linked={nodes:[target,{id:'source-image',type:'rh-image',data:{isUpload:true,title:'PRIVATE_IMAGE_TITLE',params:{prompt:'PRIVATE_ANCESTOR_PROMPT'},sourceObjects:['rhtv-asset:image'],output:[{assetId:'image',type:'ASSET'}]}}],edges:[{id:'edge',source:'source-image',target:'bad-child'}]};
 try{
  await expect(f.adapter.run({projectId:'project-original',targetType:'NODE',targetId:'bad-child',graph:linked})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
  expect(f.diagnostics()).toHaveLength(1);const record=f.diagnostics()[0],issues=record.preflight.issues.filter((issue:any)=>issue.field==='inputs.kind');
  expect(issues).toEqual([{field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:'IMAGE',expectedKinds:['TEXT','STRUCTURED'],assetId:'image',sourceNodeId:'source-image'}]);
  for(const secret of ['PRIVATE_LINKED_PROMPT','PRIVATE_ANCESTOR_PROMPT','PRIVATE_IMAGE_TITLE','PRIVATE_SIGNATURE','https://'])expect(JSON.stringify(record)).not.toContain(secret);
  expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
 }finally{f.adapter.clear();}
});

it('keeps the submitted model and scene when the body and mounted manager change during save',async()=>{
 let finish!:()=>void;const f=fixture({saved:()=>new Promise(resolve=>{finish=resolve;})}),command:any={projectId:'project-original',targetType:'NODE',targetId:'bad-child',graph:graph()};
 let mounted=structuredClone(command.graph);const manager={getRemoteData:()=>mounted,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};f.adapter.attach('project-original',manager);
 try{
  const pending=f.adapter.run(command);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  command.graph.nodes[1].data={modelCode:vision.capabilityRef,capabilityVersion:'99',sceneCode:'canvas-later-scene',params:{prompt:'LATER_PRIVATE_INPUT'}};
  mounted={nodes:[{id:'bad-child',type:'rh-text',data:command.graph.nodes[1].data}],edges:[]};
  command.projectId='project-later';command.targetId='later-child';finish();
  await expect(pending).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
  expect(f.diagnostics()).toHaveLength(1);expect(f.diagnostics()[0]).toMatchObject({projectId:'project-original',nodeId:'bad-child',sceneCode:'canvas-image-understanding',preflight:{capabilityRef:text.capabilityRef,capabilityVersion:'7',inputKinds:['IMAGE']}});
  expect(JSON.stringify(f.diagnostics()[0])).not.toContain('LATER_PRIVATE_INPUT');
 }finally{f.adapter.clear();}
});

it('reports isolated image-style input guards before a canvas task exists',async()=>{
 const f=fixture();
 try{
  await expect(f.adapter.isolated('LLM','PRIVATE_STYLE_PROMPT',['rhtv-asset:video'],'project-original',{}, {schemaVersion:'1',featureCode:'image.style-extract'},{capabilityRef:vision.capabilityRef,capabilityVersion:'7'})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
  expect(f.diagnostics()).toHaveLength(1);expect(f.diagnostics()[0]).toMatchObject({projectId:'project-original',nodeId:expect.stringMatching(/^studio-tool-/),preflight:{capabilityRef:vision.capabilityRef,capabilityVersion:'7',inputKinds:['VIDEO'],issues:expect.arrayContaining([{field:'references.kind',reason:'KIND_UNSUPPORTED',inputKind:'VIDEO',inputIndex:0,assetId:'video',expectedKinds:['IMAGE']}])}});
  expect(JSON.stringify(f.diagnostics()[0])).not.toContain('PRIVATE_STYLE_PROMPT');expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
 }finally{f.adapter.clear();}
});

it('keeps the original unsupported-input error when diagnostic delivery fails',async()=>{
 const f=fixture({diagnostics:()=>new Response(JSON.stringify({code:503,error:{code:'DIAGNOSTIC_UNAVAILABLE',message:'report transport unavailable'}}),{status:503})});
 try{
  const error=await f.adapter.run({projectId:'project-original',targetType:'NODE',targetId:'bad-child',graph:graph()}).catch(error=>error);
  expect(error).toMatchObject({code:'MODEL_INPUT_UNSUPPORTED',requestId:undefined});expect(error.message).toContain('图片');expect(error.message).not.toContain('report transport unavailable');
  expect(f.diagnostics()).toHaveLength(1);expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);expect(f.notice).not.toHaveBeenCalled();
 }finally{f.adapter.clear();}
});

it('does not re-report an error with an unrecognized correlation ID',async()=>{
 const original=new ApiError(422,'MODEL_INPUT_UNSUPPORTED','已记录的服务端拒绝','server-request-id'),f=fixture({saved:async()=>{throw original;}});
 try{
  await expect(f.adapter.run({projectId:'project-original',targetType:'NODE',targetId:'bad-child',graph:graph()})).rejects.toBe(original);
  expect(f.diagnostics()).toEqual([]);expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
 }finally{f.adapter.clear();}
});

it('records the mounted model and bounded conflict symbols when readiness is blocked before model preparation',async()=>{
 const f=fixture(),mounted:any={nodes:[badNode()],edges:[]};f.adapter.attach('project-original',{getRemoteData:()=>mounted,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()});
 vi.spyOn(f.storage,'draftRecoveryState').mockReturnValue({projectId:'project-original',blocked:true,blockedReason:'MERGE_CONFLICT',generation:12,busy:false,persistence:'saved',backups:[],conflicts:[{path:'/nodes/bad-child/data/modelSelection',reason:'MODEL_PARAMETERS'},{path:'/nodes/bad-child/data/params/PRIVATE_CUSTOM_FIELD',reason:'FIELD_CHANGED'}]});
 try{
  await f.adapter.reportGenerationReadinessFailure('project-original',{nodeId:'bad-child',code:'LOCAL_DRAFT_CONFLICT',message:'Pending sync'});
  expect(f.diagnostics()).toHaveLength(1);expect(f.diagnostics()[0]).toMatchObject({preflight:{capabilityRef:text.capabilityRef,capabilityVersion:'7',sync:{blockedReason:'MERGE_CONFLICT',generation:12,conflicts:[{reason:'MODEL_PARAMETERS',component:'MODEL',sourceNodeId:'bad-child'},{reason:'FIELD_CHANGED',component:'PARAMETERS',sourceNodeId:'bad-child'}]}}});
  const serialized=JSON.stringify(f.diagnostics()[0]);for(const secret of ['PRIVATE_CUSTOM_FIELD','PRIVATE_USER_PROMPT','/nodes/'])expect(serialized).not.toContain(secret);
 }finally{f.adapter.clear();}
});

it('does not report an old caller failure after the authenticated adapter is cleared',async()=>{
 let finish!:()=>void;const f=fixture({saved:()=>new Promise(resolve=>{finish=resolve;})});
 const pending=f.adapter.run({projectId:'project-original',targetType:'NODE',targetId:'bad-child',graph:graph()});
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));f.adapter.clear();f.api.setAccessToken('different-user');finish();
 await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(f.diagnostics()).toEqual([]);
});

it('reports an Agent video input rejection before adding nodes or submitting a generation',async()=>{
 const video:Capability={...text,capabilityRef:'text-video-v1',version:'3',kind:'TEXT_TO_VIDEO',outputKinds:['VIDEO'],parameterSchema:{'x-video-mode':'TEXT_TO_VIDEO','x-video-parameter-metadata':{schemaVersion:'1'},'x-media-limits':{IMAGE:0,VIDEO:0,AUDIO:0}}},f=fixture({catalog:()=>json({items:[video],nextCursor:null})});
 const manager={getRemoteData:()=>({nodes:[],edges:[]}),addNode:vi.fn(),addEdge:vi.fn(),patchNodeData:vi.fn()},runtime={inspect:()=>({id:'project-original'}),auth:{user:{id:'owner'}},storage:f.storage,execution:f.adapter};
 try{
  await expect(launchAgentVideo(runtime,{bt:()=>manager},{capabilityRef:video.capabilityRef,version:'3',prompt:'PRIVATE_VIDEO_PROMPT',attachments:[{type:'image',url:'rhtv-asset:image',name:'PRIVATE_IMAGE_NAME'}],parameters:{}})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
  expect(f.diagnostics()).toHaveLength(1);expect(f.diagnostics()[0]).toMatchObject({projectId:'project-original',nodeId:expect.stringMatching(/^studio-video-/),preflight:{capabilityRef:video.capabilityRef,capabilityVersion:'3',inputKinds:['IMAGE'],issues:[{field:'references.total',reason:'REFERENCE_FORBIDDEN',actual:1,maximum:0}]}});
  expect(manager.addNode).not.toHaveBeenCalled();expect(manager.addEdge).not.toHaveBeenCalled();expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
  for(const privateValue of ['PRIVATE_VIDEO_PROMPT','PRIVATE_IMAGE_NAME'])expect(JSON.stringify(f.diagnostics()[0])).not.toContain(privateValue);
 }finally{f.adapter.clear();}
});


it('ties a sync rejection to the original UI state and previous HTTP request without changing its log ID',async()=>{
 const id='c92b96b7-989e-4c9d-b9a8-28655827fc45',failure=new ApiError(409,'EDIT_SESSION_BUSY','编辑会话正在切换',id);
 const f=fixture({saved:async()=>{throw failure;}}),g=graph();
 try{
  await expect(f.adapter.run({projectId:'project-original',targetType:'GROUP',targetId:'group',graph:g})).rejects.toBe(failure);
  expect(failure.requestId).toBe(id);
  expect(f.diagnostics()).toHaveLength(1);
  expect(f.diagnostics()[0]).toMatchObject({relatedRequestId:id,clientSnapshot:{targetType:'GROUP',phase:'SYNC',target:0,children:1,nodes:[{index:0,kind:'rh-group'},{index:1,kind:'rh-text',parent:0}]}});
 }finally{f.adapter.clear();}
});

it('preserves real submit failures with the clicked topology, including no-response transport failures',async()=>{
 const id='6a7c1f9c-595b-475a-986e-1fd7abd6ac8f';
 for(const network of [false,true]){
  const f=fixture({post:()=>{if(network)throw new TypeError('Synthetic connection reset');return new Response(JSON.stringify({code:422,requestId:id,error:{code:'MEDIA_INPUT_INVALID',message:'提交未通过'}}),{status:422});}});
  const input=badNode();input.data.params.imageUrls=[];input.data.sceneCode='canvas-text';const g={nodes:[input],edges:[]};
  try{
   const error=await f.adapter.run({projectId:'project-original',targetType:'NODE',targetId:'bad-child',graph:g}).catch(e=>e);
   expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(true);
   expect(f.diagnostics()).toHaveLength(1);
   expect(f.diagnostics()[0]).toMatchObject({errorCode:network?'CLIENT_SUBMISSION_ERROR':'MEDIA_INPUT_INVALID',clientSnapshot:{targetType:'NODE',control:'COMMAND',phase:'SUBMIT',nodes:[{index:0,hasModel:true}]}});
   if(network){expect(error).toBeInstanceOf(TypeError);expect(error.message).toContain('diagnostic-log');}
   else{expect(error.requestId).toBe(id);expect(f.diagnostics()[0].relatedRequestId).toBe(id);}
  }finally{f.adapter.clear();}
 }
});

it('captures a clicked portrait retry including selection, drag flags and current incident wires without content',async()=>{
 const f=fixture();const g:any={nodes:[{id:'group',type:'group',data:{}},{id:'portrait',type:'rh-image',parentId:'group',draggable:false,position:{x:32,y:48},data:{isPortraitAdjustResult:true,hidePromptInput:true,output:[{url:'https://PRIVATE_SIGNED'}],params:{prompt:'PRIVATE_PROMPT'},presetSelections:[{secret:'PRIVATE_PRESET'}],selectedHistoryOutputId:'PRIVATE_HISTORY'}}, {id:'ref',type:'rh-image',data:{title:'PRIVATE_NAME',sourceObjects:['data:image/png;base64,PRIVATE_BYTES']}}],edges:[{id:'private-edge',source:'ref',target:'portrait'}]};
 f.adapter.attach('p',{getRemoteData:()=>g,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()});
 const observe=vi.fn(()=>({host:true,generateVisible:false,busyOverlay:true,cancelVisible:true,draggable:false}));f.adapter.setDiagnosticDom(observe);
 try{
  await f.adapter.inspectGeneration('p',['portrait'],g);expect(observe).not.toHaveBeenCalled();expect(f.diagnostics()).toHaveLength(0);
  await f.adapter.reportGenerationReadinessFailure('p',{nodeId:'portrait',code:'MODEL_INPUT_UNSUPPORTED',message:'生成不可用'}, {targetType:'NODE',targetId:'portrait',control:'RETRY',selected:['portrait']},g);
  const d=f.diagnostics()[0];expect(d.clientSnapshot).toMatchObject({phase:'READINESS',control:'RETRY',target:1,links:[{source:2,target:1}],nodes:expect.arrayContaining([expect.objectContaining({index:1,parent:0,selected:true,draggable:false,x:32,y:48,portraitResult:true,promptHidden:true,historySelected:true,presets:1,outputs:1})])});
  expect(d.clientSnapshot.dom).toMatchObject({host:true,cancelVisible:true,busyOverlay:true,generateVisible:false});expect(observe).toHaveBeenCalledExactlyOnceWith('p','portrait');
  expect(JSON.stringify(d)).not.toMatch(/PRIVATE_|https?:|data:image|private-edge/);
 }finally{f.adapter.clear();}
});


it('a failed native POST consumes the attached click evidence, while direct run remains a command',async()=>{
 const f=fixture({post:()=>new Response(JSON.stringify({code:422,requestId:'6a7c1f9c-595b-475a-986e-1fd7abd6ac8f',error:{code:'INPUT_REJECTED',message:'提交未通过'}}),{status:422})});
 const input=badNode();input.data.params.imageUrls=[];input.data.sceneCode='canvas-text';const g={nodes:[input],edges:[]};
 const take=vi.fn(()=>({targetId:'bad-child',targetType:'NODE' as const,control:'RETRY' as const,click:{visible:true,disabled:false}}));f.adapter.setNativeSubmitIntent(take);
 const cmd={projectId:'project-original',targetId:'bad-child',targetType:'NODE',graph:g};
 try{
  await expect(f.adapter.handle('/canvas/task/run',cmd)).rejects.toMatchObject({code:'INPUT_REJECTED'});
  expect(f.diagnostics()[0].clientSnapshot).toMatchObject({phase:'SUBMIT',control:'RETRY',click:{visible:true,disabled:false}});
  await expect(f.adapter.run(cmd)).rejects.toMatchObject({code:'INPUT_REJECTED'});
  expect(f.diagnostics()[1].clientSnapshot.control).toBe('COMMAND');expect(f.diagnostics()[1].clientSnapshot).not.toHaveProperty('click');
 }finally{f.adapter.clear();}
});

it('identifies the selected unreadable reference before submission even with unrelated broken history on the canvas',async()=>{
 const f=fixture(),source={id:'source',type:'rh-image',data:{title:'片头图',sourceObjects:['rhtv-asset:image'],nodeOutputHistory:[{id:'old',outputs:['rhtv-asset:old_missing']}]}};const target={...badNode(),data:{...badNode().data,params:{prompt:'example'}}};
 const original=f.transport.getMockImplementation()!;f.transport.mockImplementation(async(path,init)=>path==='/api/v1/assets/image'?new Response(JSON.stringify({code:'ASSET_NOT_FOUND',message:'素材不存在。'}),{status:404}):original(path,init));
 try{const error=await f.adapter.run({projectId:'project-original',targetType:'NODE',targetId:target.id,graph:{nodes:[source,target],edges:[{id:'edge',source:'source',target:target.id}]}}).catch(error=>error);
 expect(error.message).toContain('片头图');expect(error.preflight.issues[0]).toMatchObject({assetId:'image',sourceNodeId:'source',component:'REFERENCES'});expect(f.transport.mock.calls.some(([path])=>path.includes('/canvas-runs')||path.includes('old_missing'))).toBe(false);
 }finally{f.adapter.clear();}
});
