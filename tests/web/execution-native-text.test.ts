import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import captured from './fixtures/native-text-main-command.json';
const profile:any={capabilityRef:'codex-6-1-text-v1',kind:'LLM',version:'2',parameterSchemaVersion:'2',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'codex',modelRef:'codex-6-1',title:'gpt-6.1-sol',version:'1'},parameterSchema:{type:'object',properties:{reasoningEffort:{type:'string',enum:['low','high'],default:'low'}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(options:{catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>;cap?:any}={}){
 const fixture=structuredClone(captured),graph:any=fixture.baseline,target=graph.nodes[0].id,requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{requests.push({path,body:init?.body?JSON.parse(init.body):undefined});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[options.cap??profile,{...profile,capabilityRef:'other-real-v1'}],nextCursor:null});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(JSON.parse(init.body))??json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-22T02:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'t',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:target,executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected test route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-22T01:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 return{fixture,graph,target,adapter,storage,requests,submit:(value:any=fixture.command)=>adapter.run({projectId:'p',targetType:'NODE',targetId:target,graph:value}),submitted:()=>requests.filter(value=>value.path==='/api/v2/canvas-runs')};
}
it('submits the captured real native text command, retaining prompt and exact model/category bindings',async()=>{
 const c=setup();try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,data=body.graph.nodes[0].data;expect(body.expectedRevision).toBe(2);expect(data.params).toEqual(c.fixture.command.nodes[0].data.params);expect(data).toMatchObject({modelCode:profile.capabilityRef,subType:'multimodal-text',textModelListType:'multimodal-text',textUiCategory:'text-text',modelType:'LLM'});expect(data).not.toHaveProperty('prompt');expect(data).not.toHaveProperty('maxConnect');expect(c.graph.nodes[0].data.prompt).toBe(c.graph.nodes[0].data.params.prompt);}finally{c.adapter.clear();}
});
it.each(['forged-command-prompt','different-baseline-prompt','changed-params','changed-model','changed-category','changed-list','extra-connections','limited-connections','nonplain','test-model','missing-model'])('keeps actual text input differences guarded: %s',async change=>{
 const cap=structuredClone(profile);if(change==='test-model')cap.testMode=true;if(change==='missing-model')delete cap.model;const c=setup({cap}),before=c.graph.nodes[0].data,after:any=c.fixture.command.nodes[0].data;
 if(change==='forged-command-prompt')after.prompt='forged';if(change==='different-baseline-prompt')before.prompt='different';if(change==='changed-params')after.params.prompt='changed';if(change==='changed-model')after.modelCode='other-real-v1';if(change==='changed-category')after.textUiCategory='text-lyrics';if(change==='changed-list')after.textModelListType='text-lyrics';if(change==='extra-connections')before.maxConnect.other=null;if(change==='limited-connections')before.maxConnect.image=1;if(change==='nonplain')before.hidePromptInput=true;
 try{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['native-omission','prompt','parameter','connection','model','category','deleted'])('checks pending native text input while catalog resolves: %s',async change=>{
 let finish!:(value:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(),rejected=change==='native-omission'?undefined:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=c.graph.nodes[0].data;
  if(change==='native-omission'){delete data.prompt;delete data.maxConnect;}if(change==='prompt')data.prompt='later';if(change==='parameter')data.params.prompt='later';if(change==='connection')data.maxConnect.image=1;if(change==='model')data.modelCode='other-real-v1';if(change==='category')data.textUiCategory='text-lyrics';if(change==='deleted')c.graph.nodes=[];
  finish(json({items:[profile],nextCursor:null}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);}
 }finally{c.adapter.clear();}
});
it.each(['native-omission','parameter'])('keeps input guards while saving text execution: %s',async change=>{
 let finish!:(value:Response)=>void,saved:any;const c=setup({save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.submit(),rejected=change==='native-omission'?undefined:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));delete c.graph.nodes[0].data.prompt;delete c.graph.nodes[0].data.maxConnect;if(change==='parameter')c.graph.nodes[0].data.params.prompt='later';finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-10-22T02:00:00Z'}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.storage.isBlocked('p')).toBe(false);}
 }finally{c.adapter.clear();}
});

it('runs the real frozen q_/tP text projection after the native pane has written its duplicate prompt',async()=>{
 const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),slice=(source:string,start:string,end:string)=>{const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Frozen text seam changed');return source.slice(a,b);};
 const c=setup(),model=capabilityModel(profile),render:any=structuredClone(c.fixture.command);for(const key of ['userPromptSnapshot','modelType','textUiCategory'])delete render.nodes[0].data[key];
 const node=render.nodes[0],type={PROMPT:'prompt'},clone=(value:any)=>structuredClone(value),project=runInNewContext(slice(index,'function q_(','function tQr(')+';q_',{
  ADe:clone,dw:()=>[],nNn:()=> 'prompt',sd:()=>[],As:()=>false,cJ:()=>[],j8:()=>({images:[],videos:[],audios:[]}),uJ:()=>[],Q0:()=>[],aNn:vi.fn(),oft:()=>false,rft:()=>false,Ar:()=>false,no:()=>false,MCe:(params:any)=>({...params}),dNn:(params:any)=>params,hM:()=>false,sft:(value:any)=>value,J1e:()=>false,fNn:new Set(),_t:type,
 });
 const submitted:any[]=[],nativeRun=runInNewContext(slice(shell,'async function tP(','function jr(')+';tP',{
  cT:()=>false,uT:(_id:string,nodes:any[],ctx:any)=>nodes.map(item=>({...item,data:{...item.data,modelCode:ctx.modelCode,params:ctx.params,generateNum:ctx.generateNum}})),vk:()=>false,fT:()=>false,pT:()=>false,hT:()=>false,er:()=>false,Os:()=>false,Gy:()=>[],mT:()=>null,yT:()=>model,K8:(value:any)=>value,fg:()=>false,Yy:()=>false,CT:()=>null,Bt:type,wu:()=>true,NT:project,IT:()=>false,zT:'unused',ja:{TEXT_LYRICS:'text-lyrics',MULTIMODAL_TEXT:'multimodal-text',TEXT_TEXT:'text-text'},TT:()=> 'multimodal-text',ET:()=> 'multimodal-text',Lh:(params:any)=>params,jT:()=>null,OT:()=>null,PT:()=>null,D8:async()=>null,ft:{getState:()=>({markLocalRunning:vi.fn(),unmarkLocalRunning:vi.fn()})},Xy:{getState:()=>({save:vi.fn()})},LT:(_model:any,params:any)=>params,mg:async(body:any)=>{submitted.push(structuredClone(body));return c.adapter.run(body);},AS:()=>false,J8:()=>false,RS:vi.fn(),Q8:()=>false,Ie:{error:vi.fn()},
 });
 try{expect(await nativeRun({canvasId:'p',nodeId:c.target,subType:'multimodal-text',nodes:render.nodes,edges:[],models:{'multimodal-text':[model]},onNodeDataPatch:(_id:string,patch:any)=>Object.assign(c.graph.nodes[0].data,patch),extractTaskId:(value:any)=>value.taskId,t:(key:string)=>key,prompt:node.data.params.prompt,ctx:{modelCode:model.modelCode,params:node.data.params,generateNum:1}})).toBe(true);expect(submitted).toHaveLength(1);expect(submitted[0].canvas.nodes[0].data).toMatchObject(c.fixture.command.nodes[0].data);expect(c.submitted()).toHaveLength(1);}finally{c.adapter.clear();}
});
