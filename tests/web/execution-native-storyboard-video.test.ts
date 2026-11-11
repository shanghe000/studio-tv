import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {encodeGraph,decodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import captured from './fixtures/native-storyboard-video-command.json';
import freshCaptured from './fixtures/native-storyboard-fresh-video-command.json';
import productionCaps from './fixtures/native-storyboard-h3-capabilities.json';
import saveReceipt from './fixtures/native-storyboard-h3-save-receipt.json';

// Legacy synthetic advertised-label compatibility; real production ratios are
// frozen separately in native-storyboard-h3-capabilities.json below.
const profile:any={capabilityRef:'h3-drama-reference-v1',kind:'OMNI_REFERENCE',version:'1',parameterSchemaVersion:'1',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED','IMAGE','VIDEO','AUDIO'],outputKinds:['VIDEO'],model:{providerRef:'minimax',modelRef:'h3',title:'MiniMax H3 drama',version:'1'},parameterSchema:{type:'object','x-video-mode':'OMNI_REFERENCE','x-media-limits':{IMAGE:4,VIDEO:1,AUDIO:1},'x-output-presets':[{value:'landscape-480p-5s',aspectRatio:'16:9',width:864,height:480,fps:24,durationSeconds:5}],properties:{count:{type:'integer',enum:[1],default:1},outputPreset:{type:'string',enum:['landscape-480p-5s'],default:'landscape-480p-5s'}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(options:{fixture?:any;ack?:any;cap?:any;catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>}={}){
 const fixture:any=structuredClone(options.fixture??captured),graph=fixture.baseline,target=fixture.command.targetId,requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[options.cap??profile],nextCursor:null});
  if(path.startsWith('/api/v1/assets/'))return json({id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(body)??json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-10-22T05:07:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'accepted',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:target,executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(options.ack??graph),updatedAt:'2026-10-22T05:06:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 const before=()=>graph.nodes.find((node:any)=>node.id===target).data,after=()=>fixture.command.canvas.nodes.find((node:any)=>node.id===target).data;
 return{fixture,graph,target,adapter,storage,requests,before,after,submit:(body:any=fixture.command)=>adapter.run({...body,canvasId:'p'}),submitted:()=>requests.filter(row=>row.path==='/api/v2/canvas-runs')};
}
it('submits the real S08 command preserving raw prompt and both ordered references, without transmitting redundant selectors',async()=>{
 const c=setup(),raw=structuredClone(c.fixture.command),prompt=c.before().params.prompt,refs=c.before().params.imageUrls;
 try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,target=body.graph.nodes.find((node:any)=>node.id===c.target);expect(body.expectedRevision).toBe(2);expect(target.data.params.prompt).toBe(prompt);expect(target.data.params.imageUrls).toEqual(refs);expect(target.data.routerParameters).toEqual({count:1,outputPreset:'landscape-480p-5s'});expect(target.data.params).not.toHaveProperty('rhModel');expect(target.data.params).not.toHaveProperty('aspectRatio');expect(target.data).not.toHaveProperty('maxConnect');expect(body.graph.nodes.map((node:any)=>node.id)).toEqual(c.graph.nodes.map((node:any)=>node.id));expect(c.fixture.command).toEqual(raw);expect(c.storage.isBlocked('p')).toBe(false);}finally{c.adapter.clear();}
});
it.each(['wrong-selector','explicit-selector','null-selector','wrong-ratio','explicit-ratio','missing-metadata','duplicate-metadata','invalid-dimensions','wrong-metadata-ratio','changed-output-preset','limited-connect','extra-connect','explicit-connect','wrong-mode','wrong-tool','not-storyboard','wrong-row','forged-prompt','wrong-reference','wrong-model','test-model','not-h3','declared-selector','declared-ratio'])('distinguishes cached S08 selectors from execution inputs: %s',async change=>{
 const cap=structuredClone(profile),c=setup({cap}),before=c.before(),after=c.after();
 if(change==='wrong-selector')before.params.rhModel='other';if(change==='explicit-selector')after.params.rhModel='other';if(change==='null-selector')after.params.rhModel=null;
 if(change==='wrong-ratio')before.params.aspectRatio='9:16';if(change==='explicit-ratio')after.params.aspectRatio='9:16';if(change==='missing-metadata')delete cap.parameterSchema['x-output-presets'];if(change==='duplicate-metadata')cap.parameterSchema['x-output-presets'].push(structuredClone(cap.parameterSchema['x-output-presets'][0]));if(change==='invalid-dimensions')cap.parameterSchema['x-output-presets'][0].width=0;if(change==='wrong-metadata-ratio')cap.parameterSchema['x-output-presets'][0].aspectRatio='9:16';
 if(change==='changed-output-preset')after.params.outputPreset='other';if(change==='limited-connect')before.maxConnect.image=2;if(change==='extra-connect')before.maxConnect.other=null;if(change==='explicit-connect')after.maxConnect={image:2,text:null,video:null};if(change==='wrong-mode')cap.parameterSchema['x-video-mode']='FIRST_FRAME';if(change==='wrong-tool')before.toolsType=after.toolsType='video-video';if(change==='not-storyboard')delete before.isStoryboard;if(change==='wrong-row')after.storyboardRowId='other';if(change==='forged-prompt')after.params.prompt='forged';if(change==='wrong-reference')after.params.imageUrls=['rhtv-asset:foreign'];if(change==='wrong-model')after.modelCode='other';if(change==='test-model')cap.testMode=true;if(change==='not-h3')cap.model.modelRef='other';if(change==='declared-selector')cap.parameterSchema.properties.rhModel={type:'string'};if(change==='declared-ratio')cap.parameterSchema.properties.aspectRatio={type:'string'};
 try{if(['wrong-selector','wrong-ratio','missing-metadata','duplicate-metadata','invalid-dimensions','wrong-metadata-ratio'].includes(change)){await c.submit();expect(c.submitted()).toHaveLength(1);expect(c.submitted()[0].body.graph.nodes.find((node:any)=>node.id===c.target).data.routerParameters).toEqual({count:1,outputPreset:before.params.outputPreset});}else{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}}finally{c.adapter.clear();}
});
it.each(['native-omissions','later-selector','later-ratio','later-connect','later-prompt','later-preset','later-reference','later-deleted'])('checks captured video ownership while catalog resolves: %s',async change=>{
 let finish!:(response:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(),rejected=change==='native-omissions'?undefined:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=c.before();
  if(change==='native-omissions'){delete data.params.rhModel;delete data.params.aspectRatio;delete data.maxConnect;}if(change==='later-selector')data.params.rhModel='other';if(change==='later-ratio')data.params.aspectRatio='9:16';if(change==='later-connect')data.maxConnect.image=1;if(change==='later-prompt')data.params.prompt='later';if(change==='later-preset')data.params.outputPreset='other';if(change==='later-reference')data.params.imageUrls=['rhtv-asset:foreign'];if(change==='later-deleted')c.graph.nodes=c.graph.nodes.filter((node:any)=>node.id!==c.target);
  finish(json({items:[profile],nextCursor:null}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);}
 }finally{c.adapter.clear();}
});
it.each(['native-omissions','later-prompt'])('keeps guards during execution input save: %s',async change=>{
 let finish!:(response:Response)=>void,saved:any;const c=setup({save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.submit(),rejected=change==='native-omissions'?undefined:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=c.before();delete data.params.rhModel;delete data.params.aspectRatio;delete data.maxConnect;if(change==='later-prompt')data.params.prompt='later';finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-10-22T05:08:00Z'}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.storage.isBlocked('p')).toBe(false);}
 }finally{c.adapter.clear();}
});
it('runs actual frozen tP through the captured S08 native projection into the guarded STUDIO submit',async()=>{
 const c=setup(),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),a=shell.indexOf('async function tP('),b=shell.indexOf('function jr(',a),model=capabilityModel(profile),submitted:any[]=[];
 const nativeRun=runInNewContext(shell.slice(a,b)+';tP',{
  cT:()=>false,uT:(_id:string,nodes:any[])=>nodes,vk:()=>false,fT:()=>false,pT:()=>false,hT:()=>false,er:()=>false,Os:()=>false,Gy:()=>[],mT:()=>null,yT:()=>model,K8:(value:any)=>value,fg:()=>false,Yy:()=>false,CT:()=>null,Bt:{PROMPT:'prompt'},wu:()=>false,NT:()=>structuredClone(c.fixture.command.canvas),IT:()=>false,zT:'unused',ja:{MULTIMODAL_TEXT:'multimodal-text',TEXT_TEXT:'text-text'},TT:()=> 'multimodal-video',ET:()=> 'multimodal-video',Lh:(params:any)=>params,jT:()=>null,OT:()=>null,PT:()=>null,D8:async()=>null,ft:{getState:()=>({markLocalRunning:vi.fn(),unmarkLocalRunning:vi.fn()})},Xy:{getState:()=>({save:vi.fn()})},LT:(_model:any,params:any)=>params,mg:async(body:any)=>{submitted.push(structuredClone(body));return c.submit(body);},AS:()=>false,J8:()=>false,RS:vi.fn(),Q8:()=>false,AT:vi.fn(),fd:vi.fn(),DT:(error:any)=>{throw error;},Ie:{error:vi.fn()},
 });
 try{expect(await nativeRun({canvasId:'p',nodeId:c.target,subType:'multimodal-video',nodes:c.graph.nodes,edges:c.graph.edges,models:{'multimodal-video':[model]},onNodeDataPatch:vi.fn(),extractTaskId:(task:any)=>task.taskId,t:(key:string)=>key,prompt:c.before().params.prompt,ctx:{modelCode:model.modelCode,params:c.before().params,generateNum:1}})).toBe(true);expect(submitted).toHaveLength(1);expect(c.submitted()).toHaveLength(1);}finally{c.adapter.clear();}
});

it.each(['h3-drama-reference-v1','h3-action-reference-v1'] as const)('submits the fresh native S08 command with the actual %s output-preset pixel ratio',async ref=>{
 const fixture=structuredClone(freshCaptured),cap=structuredClone(productionCaps[ref]),target=fixture.command.targetId;
 for(const graph of [fixture.baseline,fixture.command.canvas]){const data=graph.nodes.find((n:any)=>n.id===target)!.data;data.modelCode=ref;if('rhModel' in data.params)data.params.rhModel=ref;}
 const c=setup({fixture,cap});
 try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,node=body.graph.nodes.find((n:any)=>n.id===c.target);expect(node.data.routerParameters).toEqual({outputPreset:'landscape-480p-5s'});expect(node.data.params).not.toHaveProperty('aspectRatio');expect(c.before().params.aspectRatio).toBe('16:9');expect(cap.parameterSchema['x-output-presets'][0]).toMatchObject({width:864,height:480,aspectRatio:'9:5'});expect(body.graph.nodes.map((n:any)=>n.id)).toEqual(c.graph.nodes.map((n:any)=>n.id));expect(body.expectedRevision).toBe(2);}finally{c.adapter.clear();}
});
it.each(['baseline-display','command-display','baseline-ratio','explicit-ratio','width','height','metadata-ratio','duration','fps','portrait-preset','736p-preset','other-label','declared-ratio'])('uses the declared output preset rather than cached ratio or display metadata: %s',async change=>{
 const cap:any=structuredClone(productionCaps['h3-drama-reference-v1']),c=setup({fixture:freshCaptured,cap}),before=c.before(),after=c.after(),preset=cap.parameterSchema['x-output-presets'][0];
 if(change==='baseline-display')before.aspectRatio='9:5';if(change==='command-display')after.aspectRatio='9:5';if(change==='baseline-ratio')before.params.aspectRatio='9:5';if(change==='explicit-ratio')after.params.aspectRatio='9:5';
 if(change==='width')preset.width=896;if(change==='height')preset.height=512;if(change==='metadata-ratio')preset.aspectRatio='16:10';if(change==='duration')preset.durationSeconds=6;if(change==='fps')preset.fps=30;
 if(change==='portrait-preset')before.params.outputPreset=after.params.outputPreset='portrait-768p-10s';if(change==='736p-preset')before.params.outputPreset=after.params.outputPreset='landscape-736p-10s';if(change==='other-label')before.aspectRatio=after.aspectRatio=before.params.aspectRatio='1:1';if(change==='declared-ratio')cap.parameterSchema.properties.aspectRatio={type:'string'};
 try{if(['baseline-ratio','width','height','metadata-ratio','duration','fps','portrait-preset','736p-preset','other-label'].includes(change)){await c.submit();expect(c.submitted()).toHaveLength(1);expect(c.submitted()[0].body.graph.nodes.find((node:any)=>node.id===c.target).data.routerParameters).toEqual({outputPreset:before.params.outputPreset});}else{await expect(c.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.submitted()).toHaveLength(0);}}finally{c.adapter.clear();}
});
it.each(['none','native-omission','ratio','preset','reference'])('guards the actual aligned-label command during catalog resolution: %s',async change=>{
 let finish!:(response:Response)=>void;const cap=structuredClone(productionCaps['h3-drama-reference-v1']),c=setup({fixture:freshCaptured,cap,catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(),rejected=['none','native-omission'].includes(change)?undefined:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='native-omission')delete c.before().params.aspectRatio;if(change==='ratio')c.before().params.aspectRatio='9:16';if(change==='preset')c.before().params.outputPreset='portrait-768p-10s';if(change==='reference')c.before().params.imageUrls=['rhtv-asset:other'];
  finish(json({items:[cap],nextCursor:null}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);}
 }finally{c.adapter.clear();}
});
it.each(['native-omission','ratio','source-output'])('guards the actual aligned-label command while saving: %s',async change=>{
 let finish!:(response:Response)=>void,saved:any;const cap=structuredClone(productionCaps['h3-drama-reference-v1']),c=setup({fixture:freshCaptured,cap,save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.submit(),rejected=change==='native-omission'?undefined:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='native-omission')delete c.before().params.aspectRatio;if(change==='ratio')c.before().params.aspectRatio='9:16';if(change==='source-output')c.graph.nodes.find((n:any)=>n.type==='rh-image').data.output[0].url='rhtv-asset:other';
  finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-10-22T05:57:00Z'}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.storage.isBlocked('p')).toBe(false);}
 }finally{c.adapter.clear();}
});
it('reproduces the immutable creator display ratio and declared-field omission with the real production model',()=>{
 const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),slice=(start:string,end='function ')=>{const a=index.indexOf(start),b=index.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Native ratio seam changed');return index.slice(a,b);},model=capabilityModel(productionCaps['h3-drama-reference-v1'] as any);
 const ratio=runInNewContext(['function SD(','function Id(','function i1(','function fl(','function af(','function Ff('].map(start=>slice(start)).join('\n')+';SD', {_t:{ASPECT_RATIO:'aspectRatio'}});
 const params=ratio({outputPreset:'landscape-480p-5s'},model,'16:9');expect(params).toEqual({outputPreset:'landscape-480p-5s',aspectRatio:'16:9'});expect(model.config.some((row:any)=>row.paramName==='aspectRatio')).toBe(false);
 const project=runInNewContext([slice('function MCe(','function dNn('),slice('function lNn(','function cNn('),slice('function cNn(','function MCe('),slice('function sNn(')].join('\n')+';MCe', {sft:(value:any)=>value,Q0:()=>[],Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,_t:{RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio'}});
 const projected=project(params,model.config);expect(projected.outputPreset).toBe('landscape-480p-5s');expect(projected).not.toHaveProperty('aspectRatio');expect(productionCaps['h3-drama-reference-v1'].parameterSchema['x-output-presets'][0]).toMatchObject({aspectRatio:'9:5',width:864,height:480});
});

it.each(['h3-drama-reference-v1','h3-action-reference-v1'] as const)('runs the full S08 storage save to one POST with the captured image receipt: %s',async ref=>{
 const fixture=structuredClone(freshCaptured),ack=decodeGraph(saveReceipt.snapshot.graph as any),target=fixture.command.targetId;
 for(const graph of [fixture.baseline,fixture.command.canvas,ack]){const data=graph.nodes.find((n:any)=>n.id===target)!.data;data.modelCode=ref;if('rhModel' in data.params)data.params.rhModel=ref;if('capabilityRef' in data)data.capabilityRef=ref;}
 const original=structuredClone(fixture),c=setup({fixture,ack,cap:structuredClone(productionCaps[ref])}),source=fixture.command.canvas.edges[0].source,prior=ack.nodes.find((n:any)=>n.id===source)!;
 try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,board=body.graph.nodes.find((n:any)=>n.id===source),video=body.graph.nodes.find((n:any)=>n.id===target);expect(body.expectedRevision).toBe(2);expect(board.data).toMatchObject({assetIds:prior.data.assetIds,batchOrigin:prior.data.batchOrigin,routerParameters:prior.data.routerParameters,historyStorage:prior.data.historyStorage,output:prior.data.output});expect(video.data.params.prompt).toBe(original.command.canvas.nodes.find((n:any)=>n.id===target)!.data.params.prompt);expect(video.data.params.imageUrls).toEqual(c.before().params.imageUrls);expect(video.data.routerParameters).toEqual({outputPreset:'landscape-480p-5s'});expect(body.graph.nodes.map((n:any)=>n.id)).toEqual(c.graph.nodes.map((n:any)=>n.id));expect(body.graph.edges).toEqual(c.graph.edges);expect(c.fixture).toEqual(original);expect(c.storage.isBlocked('p')).toBe(false);}finally{c.adapter.clear();}
});
it.each(['receipt-asset','receipt-origin','receipt-history','receipt-output','receipt-model','receipt-parameters','receipt-prompt-snapshot','command-asset','command-origin','live-reference','live-model','live-history'])('does not accept arbitrary source metadata during a real S08 save: %s',async change=>{
 const ack=decodeGraph(saveReceipt.snapshot.graph as any),source=freshCaptured.command.canvas.edges[0].source,c=setup({fixture:freshCaptured,ack,cap:structuredClone(productionCaps['h3-drama-reference-v1']),save:async body=>{
  const graph=structuredClone(body.graph),data=graph.nodes.find((n:any)=>n.id===source).data;
  if(change==='receipt-asset')data.assetIds=['foreign'];if(change==='receipt-origin')data.batchOrigin.taskId='foreign';if(change==='receipt-history')data.historyStorage.historyId='foreign';if(change==='receipt-output')data.output[0].url='rhtv-asset:foreign';if(change==='receipt-model')data.modelCode='other';if(change==='receipt-parameters')data.routerParameters.count=2;if(change==='receipt-prompt-snapshot')data.userPromptSnapshot={paramName:'prompt',value:'foreign'};
  if(change==='live-reference')c.before().params.imageUrls=['rhtv-asset:foreign'];if(change==='live-model')c.before().modelCode='other';if(change==='live-history')c.graph.nodes.find((n:any)=>n.id===source).data.historyStorage.historyId='foreign';
  return json({projectId:'p',revision:2,graph,updatedAt:'2026-10-22T06:09:00Z'});
 }});
 if(change==='command-asset')c.fixture.command.canvas.nodes.find((n:any)=>n.id===source).data.assetIds=['foreign'];if(change==='command-origin')c.fixture.command.canvas.nodes.find((n:any)=>n.id===source).data.batchOrigin={...ack.nodes.find((n:any)=>n.id===source)!.data.batchOrigin,taskId:'foreign'};
 try{await expect(c.submit()).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it('exposes cloned actual H3 preset metadata only on real H3 model projections',()=>{
 const cap=structuredClone(productionCaps['h3-drama-reference-v1']),model=capabilityModel(cap as any);expect(model.h3OutputPresets).toEqual(cap.parameterSchema['x-output-presets']);model.h3OutputPresets![0].width=1;expect(cap.parameterSchema['x-output-presets'][0].width).toBe(864);expect(capabilityModel({...cap,model:{...cap.model,modelRef:'other'}} as any)).not.toHaveProperty('h3OutputPresets');
});
