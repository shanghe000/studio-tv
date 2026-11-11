import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph,decodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import capabilities from './fixtures/router-h3-capabilities.json';

const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const slice=(start:string,end='function ')=>{const a=index.indexOf(start),b=index.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Frozen consistency seam changed: '+start);return index.slice(a,b);};
const types={RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls'};
const declarations=[slice('function MCe(','function dNn('),slice('function lNn(','function cNn('),slice('function cNn(','function MCe('),slice('function sNn(')].join('\n');
const project=runInNewContext(declarations+slice('function q_(','function tQr(')+';q_',{
 ADe:(value:any)=>structuredClone(value),dw:()=>[],nNn:()=> 'prompt',sd:()=>[],As:()=>false,cJ:()=>[],j8:()=>({images:[],videos:[],audios:[]}),uJ:()=>[],Q0:()=>[],aNn:vi.fn(),oft:()=>false,rft:()=>false,Ar:()=>false,no:()=>false,
 sft:(value:any)=>value,Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,dNn:(value:any)=>value,hM:()=>null,J1e:()=>false,fNn:new Set(),_t:types,
});
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function fixture(options:{catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>;storedText?:boolean;selectors?:boolean;withHistory?:boolean;cachedModel?:string;cachedRatio?:string;preset?:string;priorPromptSnapshot?:string}={}){
 const cap:any={...structuredClone(capabilities.find(cap=>cap.capabilityRef==='h3-video-reference-v1')!),testMode:false},model=capabilityModel(cap),preset=cap.parameterSchema['x-output-presets'].find((row:any)=>row.value===options.preset)??cap.parameterSchema['x-output-presets'][0];
 const graph:any={nodes:[{id:'video',type:'rh-video',position:{x:0,y:0},data:{title:'Reference video',modelCode:cap.capabilityRef,subType:'multimodal-video',prompt:'A fox turns toward the camera.',aspectRatio:preset.aspectRatio,maxConnect:{image:null,text:null,video:null},params:{prompt:'A fox turns toward the camera.',rhModel:options.cachedModel??cap.capabilityRef,outputPreset:preset.value,aspectRatio:options.cachedRatio??preset.aspectRatio,imageUrls:['rhtv-asset:image'],audioUrls:[],videoUrls:[]},generateNum:1}}],edges:[]};
 if(options.priorPromptSnapshot)graph.nodes[0].data.userPromptSnapshot={paramName:'prompt',value:options.priorPromptSnapshot};
 if(options.withHistory)Object.assign(graph.nodes[0].data,{output:[{url:'rhtv-asset:old-video',assetId:'old-video',width:768,height:768,durationMs:5000,outputType:'video/mp4'}],videoUrl:'rhtv-asset:old-video',historyStorage:{source:'remote',schemaVersion:1,historyId:'old-execution',revision:'4',resultCount:1},nodeOutputHistory:[{id:'old-result',params:{prompt:'Earlier recorded prompt',text:'Earlier recorded prompt',outputPreset:'square-1080p-5s'},outputs:[{url:'rhtv-asset:old-video',width:768,height:768,durationMs:5000,outputType:'video/mp4'}],nodeConfig:{subType:'multimodal-video',modelCode:cap.capabilityRef,generateNum:1}}],selectedOutputHistoryIndex:0});
 if(options.selectors===false){delete graph.nodes[0].data.params.rhModel;delete graph.nodes[0].data.params.aspectRatio;}if(options.storedText)graph.nodes[0].data.params.text='An earlier prompt retained by the previous result.';
 const command=project('video',graph.nodes,graph.edges,{modelConfig:model.config}),target=command.nodes[0].data;
 target.userPromptSnapshot={paramName:'prompt',value:graph.nodes[0].data.params.prompt};target.modelType=model.modelType;
 const requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[cap],nextCursor:null});
  if(path==='/api/v1/assets/old-video')return json({id:'old-video',state:'READY',kind:'VIDEO',width:768,height:768,durationSeconds:5});
  if(path==='/api/v1/assets/image')return json({id:'image',state:'READY',kind:'IMAGE'});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(body)??json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-11-02T09:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'task',projectId:'p',canvasManaged:true,state:'QUEUED',revision:1,testMode:false,plans:[{nodeId:'video',executionId:'execution',state:'QUEUED',canvasBinding:{applicationState:'PENDING'},outputs:[]}]});
  if(path==='/api/v2/tasks/task')return json({id:'task',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:2,testMode:false,plans:[{nodeId:'video',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  if(path==='/api/v2/generation-diagnostics')return json({logId:'diagnostic'},202);
  throw Error('Unexpected consistency fixture route: '+path);
 });api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-02T08:59:00Z'},'"1"');storage.attachNativeView('p',graph);execution.attach('p',manager);
 return{cap,model,graph,command,requests,manager,execution,submit:()=>execution.run({projectId:'p',targetType:'NODE',targetId:'video',graph:command}),submitted:()=>requests.filter(row=>row.path==='/api/v2/canvas-runs')};
}

it('submits an ordinary H3 node through the real frozen q_/MCe declared-parameter projection',async()=>{
 const f=fixture(),before=structuredClone(f.graph);
 expect(f.graph.nodes[0].data).not.toHaveProperty('isStoryboard');expect(f.command.nodes[0].data.params).not.toHaveProperty('rhModel');expect(f.command.nodes[0].data.params).not.toHaveProperty('aspectRatio');
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const sent=f.submitted()[0].body,target=sent.graph.nodes.find((node:any)=>node.id==='video');expect(sent.expectedRevision).toBe(2);expect(target.data.params.prompt).toBe(before.nodes[0].data.params.prompt);expect(target.data.params.imageUrls).toEqual(['rhtv-asset:image']);expect(target.data.routerParameters).toEqual({outputPreset:before.nodes[0].data.params.outputPreset});expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});


it('ignores undeclared historical text omitted by MCe while retaining the currently authored H3 prompt',async()=>{
 const f=fixture({storedText:true,selectors:false}),before=structuredClone(f.graph);
 expect(f.command.nodes[0].data.params).not.toHaveProperty('text');expect(before.nodes[0].data.params.text).not.toBe(before.nodes[0].data.params.prompt);
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const target=f.submitted()[0].body.graph.nodes.find((node:any)=>node.id==='video');expect(target.data.params.prompt).toBe(before.nodes[0].data.params.prompt);expect(target.data.routerParameters).toEqual({outputPreset:before.nodes[0].data.params.outputPreset});expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it('submits a native tP retry without a separate prompt argument using the current params.prompt',async()=>{
 const f=fixture({storedText:true,selectors:false}),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),a=shell.indexOf('async function tP('),b=shell.indexOf('function jr(',a),calls:any[]=[];
 const nativeRun=runInNewContext(shell.slice(a,b)+';tP',{
  cT:()=>false,uT:(_id:any,nodes:any)=>nodes,vk:()=>false,fT:()=>false,pT:()=>false,hT:()=>false,er:()=>false,Os:()=>false,Gy:()=>[],mT:()=>null,yT:()=>f.model,K8:(value:any)=>value,fg:()=>false,Yy:()=>false,CT:()=>null,Bt:{PROMPT:'prompt'},wu:()=>false,
  NT:(id:string,nodes:any,edges:any,options:any)=>project(id,nodes,edges,options),IT:()=>false,zT:'unused',ja:{MULTIMODAL_TEXT:'multimodal-text',TEXT_TEXT:'text-text'},TT:()=> 'multimodal-video',ET:()=> 'multimodal-video',Lh:(value:any)=>value,jT:()=>null,OT:()=>null,PT:()=>null,D8:async()=>null,
  ft:{getState:()=>({markLocalRunning:vi.fn(),unmarkLocalRunning:vi.fn()})},Xy:{getState:()=>({save:vi.fn()})},LT:(_model:any,value:any)=>value,
  mg:async(body:any)=>{calls.push(structuredClone(body));return f.execution.run({...body,canvasId:'p'});},AS:()=>false,J8:()=>false,RS:vi.fn(),Q8:()=>false,AT:vi.fn(),fd:vi.fn(),DT:(error:any)=>{throw error;},Ie:{error:vi.fn()},
 });
 try{
  expect(await nativeRun({canvasId:'p',nodeId:'video',subType:'multimodal-video',nodes:f.graph.nodes,edges:f.graph.edges,models:{'multimodal-video':[f.model]},onNodeDataPatch:vi.fn(),extractTaskId:(task:any)=>task.taskId,t:(key:string)=>key})).toBe(true);
  expect(calls).toHaveLength(1);expect(calls[0].canvas.nodes[0].data.params).not.toHaveProperty('text');expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe('A fox turns toward the camera.');
 }finally{f.execution.clear();}
});


it('flushes the pending native form patch before capturing a generation baseline',async()=>{
 const f=fixture({storedText:true,selectors:false}),node=f.graph.nodes[0],command=f.command.nodes[0],newPrompt='The fox nods once in natural light.';
 command.data.params.prompt=newPrompt;command.data.prompt=newPrompt;command.data.userPromptSnapshot={paramName:'prompt',value:newPrompt};
 f.manager.flushOperationQueue.mockImplementation(()=>{node.data.params.prompt=newPrompt;node.data.prompt=newPrompt;});
 try{await f.submit();expect(f.manager.flushOperationQueue).toHaveBeenCalled();expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe(newPrompt);expect(node.data.params.prompt).toBe(newPrompt);}finally{f.execution.clear();}
});

it('regenerates a video with prior output and history while using its newly authored prompt',async()=>{
 const f=fixture({storedText:true,selectors:false,withHistory:true}),before=structuredClone(f.graph);
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const node=f.submitted()[0].body.graph.nodes[0];expect(node.data.params.prompt).toBe(before.nodes[0].data.params.prompt);expect(node.data.historyStorage).toEqual(before.nodes[0].data.historyStorage);expect(node.data.output).toEqual(before.nodes[0].data.output);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it.each(['square-768p-5s','square-768p-10s','square-1080p-5s','square-1080p-10s'])('accepts the first click after a queued native preset change to %s',async outputPreset=>{
 const f=fixture({storedText:true,selectors:false,withHistory:true}),node=f.graph.nodes[0],command=f.command.nodes[0];
 command.data.params.outputPreset=outputPreset;command.data.aspectRatio='1:1';
 f.manager.flushOperationQueue.mockImplementation(()=>{node.data.params.outputPreset=outputPreset;node.data.aspectRatio='1:1';});
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const target=f.submitted()[0].body.graph.nodes[0];expect(target.data.routerParameters).toEqual({outputPreset});expect(target.data.params.prompt).toBe('A fox turns toward the camera.');expect(node.data.params.outputPreset).toBe(outputPreset);}finally{f.execution.clear();}
});

it('accepts node array reorder and unrelated node updates while keeping the selected reference and prompt',async()=>{
 let finish!:(response:Response)=>void;const f=fixture({selectors:false,catalog:()=>new Promise(resolve=>finish=resolve)}),source={id:'source',type:'rh-image',position:{x:-400,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:image']}},unrelated={id:'unrelated',type:'rh-text',position:{x:1000,y:0},data:{params:{prompt:'Independent draft'}}};
 f.graph.nodes.push(source,unrelated);f.graph.edges.push({id:'source-edge',source:'source',target:'video',sourceHandle:'output',targetHandle:'input'});
 f.command.nodes.push(structuredClone(source),structuredClone(unrelated));f.command.edges.push({id:'source-edge',source:'source',target:'video',sourceHandle:'output',targetHandle:'input'});
 try{const pending=f.submit();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));f.graph.nodes.reverse();unrelated.data.params.prompt='A newer independent draft';finish(json({items:[f.cap],nextCursor:null}));await pending;expect(f.submitted()).toHaveLength(1);const body=f.submitted()[0].body,target=body.graph.nodes.find((node:any)=>node.id==='video');expect(target.data.params.prompt).toBe('A fox turns toward the camera.');expect(target.data.params.imageUrls).toEqual(['rhtv-asset:image']);expect(f.graph.nodes.find((node:any)=>node.id==='unrelated').data.params.prompt).toBe('A newer independent draft');}finally{f.execution.clear();}
});


it.each([
 {name:'stale model selector',cachedModel:'previous-video-model',cachedRatio:undefined},
 {name:'stale aspect selector',cachedModel:undefined,cachedRatio:'9:16'},
])('accepts the real MCe omission of an undeclared $name cache',async({cachedModel,cachedRatio})=>{
 const f=fixture({cachedModel,cachedRatio}),before=structuredClone(f.graph);
 expect(f.command.nodes[0].data.params).not.toHaveProperty('rhModel');expect(f.command.nodes[0].data.params).not.toHaveProperty('aspectRatio');
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const node=f.submitted()[0].body.graph.nodes[0];expect(node.data.modelCode).toBe(f.cap.capabilityRef);expect(node.data.routerParameters).toEqual({outputPreset:before.nodes[0].data.params.outputPreset});expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it.each(['portrait-768p-10s','landscape-768p-10s'])('submits the first click after changing to %s despite an old undeclared ratio cache',async outputPreset=>{
 const f=fixture({cachedModel:'previous-video-model',cachedRatio:'1:1',preset:outputPreset}),before=structuredClone(f.graph),selected=f.cap.parameterSchema['x-output-presets'].find((row:any)=>row.value===outputPreset);
 expect(selected).toBeDefined();expect(selected.aspectRatio).not.toBe('1:1');
 try{await f.submit();expect(f.submitted()).toHaveLength(1);const target=f.submitted()[0].body.graph.nodes[0];expect(target.data.routerParameters).toEqual({outputPreset});expect(target.data.params.prompt).toBe(before.nodes[0].data.params.prompt);expect(target.data.params.imageUrls).toEqual(before.nodes[0].data.params.imageUrls);expect(f.graph).toEqual(before);}finally{f.execution.clear();}
});

it('accepts native removal of stale undeclared selectors while the execution snapshot is saving',async()=>{
 let finish!:(response:Response)=>void,saved:any;
 const f=fixture({cachedModel:'previous-video-model',cachedRatio:'9:16',save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=f.submit();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));delete f.graph.nodes[0].data.params.rhModel;delete f.graph.nodes[0].data.params.aspectRatio;finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-11-02T09:00:00Z'}));await pending;expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.modelCode).toBe(f.cap.capabilityRef);}finally{f.execution.clear();}
});

it.each(['rhModel','aspectRatio'])('rejects a command that explicitly supplies a different %s instead of the real MCe omission',async field=>{
 const f=fixture();f.command.nodes[0].data.params[field]=field==='rhModel'?'different-command-model':'9:16';
 try{
  await expect(f.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(f.submitted()).toHaveLength(0);
  const diagnostic=f.requests.find(row=>row.path==='/api/v2/generation-diagnostics')?.body;
  expect(diagnostic).toMatchObject({projectId:'p',nodeId:'video',errorCode:'STALE_EXECUTION_INPUT',preflight:{capabilityRef:f.cap.capabilityRef,capabilityVersion:'4',issues:[{field:'inputs.command',reason:'COMMAND_MISMATCH',component:'PARAMETERS',sourceNodeId:'video'}]}});
  const logged=JSON.stringify(diagnostic);expect(logged).not.toContain('different-command-model');expect(logged).not.toContain('9:16');expect(logged).not.toContain('A fox turns toward the camera.');
 }finally{f.execution.clear();}
});


it.each([{change:'prompt',component:'PROMPT'},{change:'reference',component:'REFERENCES'}])('retains a real later $change edit and records its exact guarded input component',async({change,component})=>{
 let finish!:(response:Response)=>void;const f=fixture({selectors:false,catalog:()=>new Promise(resolve=>finish=resolve)});
 try{
  const pending=f.submit(),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='prompt')f.graph.nodes[0].data.params.prompt='PRIVATE_LATER_USER_PROMPT';else f.graph.nodes[0].data.params.imageUrls=['rhtv-asset:private-later-reference'];
  finish(json({items:[f.cap],nextCursor:null}));await rejected;expect(f.submitted()).toHaveLength(0);
  const diagnostic=f.requests.find(row=>row.path==='/api/v2/generation-diagnostics')?.body;
  expect(diagnostic).toMatchObject({projectId:'p',nodeId:'video',errorCode:'STALE_EXECUTION_INPUT',preflight:{capabilityRef:f.cap.capabilityRef,capabilityVersion:'4',issues:[{field:'inputs.snapshot',reason:'INPUT_CHANGED',component,sourceNodeId:'video'}]}});
  const logged=JSON.stringify(diagnostic);for(const value of ['PRIVATE_LATER_USER_PROMPT','private-later-reference','A fox turns toward the camera.'])expect(logged).not.toContain(value);
  if(change==='prompt')expect(f.graph.nodes[0].data.params.prompt).toBe('PRIVATE_LATER_USER_PROMPT');else expect(f.graph.nodes[0].data.params.imageUrls).toEqual(['rhtv-asset:private-later-reference']);
 }finally{f.execution.clear();}
});


it('accepts its own execution save projection when live sync applies the PUT graph before the response',async()=>{
 let finish!:(response:Response)=>void,saved:any;const oldSnapshot='A previous saved description.';
 const f=fixture({storedText:true,withHistory:true,priorPromptSnapshot:oldSnapshot,save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}}),identity=f.graph.nodes[0];
 try{
  const pending=f.submit();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const persisted=decodeGraph(saved.graph),savedTarget=persisted.nodes.find((node:any)=>node.id==='video')!;
  expect(savedTarget.data.userPromptSnapshot).toEqual({paramName:'prompt',value:'A fox turns toward the camera.'});
  Object.assign(identity.data,structuredClone(savedTarget.data));expect(f.graph.nodes[0]).toBe(identity);
  finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-11-02T09:00:00Z'}));await pending;
  expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe('A fox turns toward the camera.');
  expect(identity.data.userPromptSnapshot).toEqual(savedTarget.data.userPromptSnapshot);expect(f.requests.some(row=>row.path==='/api/v2/generation-diagnostics')).toBe(false);
 }finally{f.execution.clear();}
});


it('waits for lease-buffered form edits before capturing the native generation baseline',async()=>{
 const f=fixture({selectors:false}),prompt='The fox steps into warm daylight.',events:string[]=[];
 f.command.nodes[0].data.params.prompt=prompt;f.command.nodes[0].data.prompt=prompt;f.command.nodes[0].data.userPromptSnapshot={paramName:'prompt',value:prompt};
 f.execution.setCanvasLeasePort({flushPending:async project=>{expect(project).toBe('p');await Promise.resolve();f.graph.nodes[0].data.params.prompt=prompt;f.graph.nodes[0].data.prompt=prompt;events.push('form-committed');},acquire:async(project,nodes)=>{expect(project).toBe('p');expect(nodes).toEqual(['video']);events.push('target-acquired');}});
 try{await f.submit();expect(events).toEqual(['form-committed','target-acquired']);expect(f.submitted()).toHaveLength(1);expect(f.submitted()[0].body.graph.nodes[0].data.params.prompt).toBe(prompt);}finally{f.execution.clear();}
});
it('does not submit a generation or change a draft when another page holds its node',async()=>{
 const f=fixture({selectors:false}),before=structuredClone(f.graph),denied=new ApiError(409,'NODE_EDIT_OCCUPIED','另一位成员正在编辑此节点。','lease-request');
 f.execution.setCanvasLeasePort({flushPending:()=>{},acquire:async()=>{throw denied;}});
 try{await expect(f.submit()).rejects.toBe(denied);expect(f.submitted()).toHaveLength(0);expect(f.graph).toEqual(before);expect(f.requests.some(row=>row.path==='/api/v1/projects/p/snapshot'&&row.body)).toBe(false);}finally{f.execution.clear();}
});
