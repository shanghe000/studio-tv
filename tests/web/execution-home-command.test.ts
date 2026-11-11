import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const prompt='A complete product photograph of an orange ceramic fox beside a blue glass vase, natural window lighting, no text.';
const profile:any={capabilityRef:'z-image-turbo-generate-v1',kind:'TEXT_TO_IMAGE',version:'1',parameterSchemaVersion:'1',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],model:{providerRef:'comfyui',modelRef:'z-image-turbo',title:'Z-Image-Turbo · BF16',version:'1'},parameterSchema:{type:'object','x-prompt-policy':'required',properties:{count:{type:'integer',enum:[1,2,4,8],default:1},outputPreset:{type:'string',enum:['1024-square'],default:'1024-square'}}}};
const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
function slice(source:string,start:string,end:string){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Frozen homepage seam changed');return source.slice(a,b);}
function fixture(){
 const graph:any={nodes:[],edges:[]},generated=vi.fn(),model=runInNewContext(slice(index,'function P0(','function ')+';P0')(capabilityModel(profile));
 // Execute the immutable direct-launch constructor, including its actual
 // autoSubmit callback. Only React/store/node-creation ports are substituted.
 const create=runInNewContext(slice(shell,'function _X(','async function NX(')+';_X',{
  TC:()=>({toolContext:{}}),pn:(select:Function)=>select({setPanelVisible:vi.fn(),activateSkill:vi.fn()}),Me:(select:Function)=>select({setPendingLaunch:vi.fn()}),As:(select:Function)=>select({agentMenuEnabled:false}),p:{useCallback:(callback:Function)=>callback},
  Fe:()=>({addNode:(node:any)=>graph.nodes.push(node),addEdge:(edge:any)=>graph.edges.push(edge)}),Jo:()=>({x:0,y:0}),Yi:{width:600},nl:420,Jm:100,xX:()=> 'text-image',cn:(type:string,position:any,options:any)=>({id:'n',type,position,data:{...options.data,generateNum:1}}),
  setTimeout:(callback:Function)=>{callback();return 1;},Ie:{success:vi.fn()},Et:{t:(key:string)=>key},console,
 });
 const launch=create({canvasId:'p',modelData:{'text-image':[model]},onGenerateNode:generated});
 return{graph,generated,launch,model};
}
async function home(){const f=fixture();await f.launch.handleLaunch({payload:{text:prompt,attachments:[],autoSubmit:true,prefs:{directMode:'image',directModel:f.model,directModelParams:{outputPreset:'1024-square'},directSubType:'text-image'}}});return f;}
function command(graph:any){
 const result=structuredClone(graph),data=result.nodes[0].data;
 // MCe's actual declared-field projection is what removes the selector.
 const project=runInNewContext([slice(index,'function MCe(','function dNn('),slice(index,'function lNn(','function cNn('),slice(index,'function cNn(','function MCe(')].join('\n')+';MCe',{
  sft:(value:any)=>value,Q0:()=>[],Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,_t:{RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio'},
 });
 data.params=project(data.params,capabilityModel(profile).config);data.modelType='OPENAPI';data.userPromptSnapshot={paramName:'prompt',value:prompt};return result;
}
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(graph:any,options:{cap?:any;ack?:any;catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>}={}){
 const selected=options.cap??profile,requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const transport=vi.fn((path:string,init:any)=>{requests.push({path,body:init?.body?JSON.parse(init.body):undefined});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[selected,{...profile,capabilityRef:'other-real-v1'}],nextCursor:null});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(JSON.parse(init.body))??json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-22T02:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'t',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:'n',executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected route '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(options.ack??graph),updatedAt:'2026-10-22T01:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 return{adapter,storage,requests,submit:(value:any)=>adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:value}),submitted:()=>requests.filter(value=>value.path==='/api/v2/canvas-runs')};
}

it.each([true,false])('submits the real frozen homepage T2I command against an ack with selector=%s',async ackHasSelector=>{
 const f=await home();expect(f.generated).toHaveBeenCalledExactlyOnceWith('n');expect(f.graph.nodes[0].data.params).toEqual({prompt,outputPreset:'1024-square',rhModel:profile.capabilityRef});
 const projected=command(f.graph);expect(projected.nodes[0].data.params).toEqual({prompt,outputPreset:'1024-square'});const ack=structuredClone(f.graph);if(!ackHasSelector)delete ack.nodes[0].data.params.rhModel;
 const c=setup(f.graph,{ack});try{await c.submit(projected);expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body;expect(body.expectedRevision).toBe(2);expect(body.graph.nodes[0].data).toMatchObject({modelCode:profile.capabilityRef,params:{prompt,outputPreset:'1024-square'},routerParameters:{count:1,outputPreset:'1024-square'}});expect(body.graph.nodes[0].data.params).not.toHaveProperty('rhModel');expect(f.graph.nodes[0].data.params.rhModel).toBe(profile.capabilityRef);}finally{c.adapter.clear();}
});

it.each(['wrong-baseline-selector','wrong-command-selector','null-command-selector','changed-command-model','changed-command-prompt','extra-param','wrong-subtype','tool','declared-selector','test-model','missing-model'])('rejects a changed or inapplicable homepage alias: %s',async change=>{
 const f=await home(),projected=command(f.graph),before=f.graph.nodes[0].data,after=projected.nodes[0].data,cap=structuredClone(profile);
 if(change==='wrong-baseline-selector')before.params.rhModel='other-real-v1';if(change==='wrong-command-selector')after.params.rhModel='other-real-v1';if(change==='null-command-selector')after.params.rhModel=null;
 if(change==='changed-command-model')after.modelCode='other-real-v1';if(change==='changed-command-prompt')after.params.prompt='a different input';if(change==='extra-param')before.params.otherInput='must not be silently dropped';
 if(change==='wrong-subtype')before.subType=after.subType='image-image';if(change==='tool')before.toolsType=after.toolsType='image-light';if(change==='declared-selector')cap.parameterSchema.properties.rhModel={type:'string'};
 if(change==='test-model')cap.testMode=true;if(change==='missing-model')delete cap.model;
 const c=setup(f.graph,{cap});try{await expect(c.submit(projected)).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});

it.each(['native-selector-removal','selector-change','prompt','preset','output-preset','model','subtype','edge','deleted-node'])('guards live edits while resolving the homepage command: %s',async change=>{
 const f=await home(),projected=command(f.graph);let finish!:(value:Response)=>void;const c=setup(f.graph,{catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(projected),rejected=change==='native-selector-removal'?undefined:expect(pending).rejects.toBeDefined();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=f.graph.nodes[0].data;
  if(change==='native-selector-removal')delete data.params.rhModel;if(change==='selector-change')data.params.rhModel='other-real-v1';if(change==='prompt')data.params.prompt='later input';if(change==='preset')data.presetSelections=[{id:'later-preset'}];if(change==='output-preset')data.params.outputPreset='changed';if(change==='model')data.modelCode='other-real-v1';if(change==='subtype')data.subType='image-image';if(change==='edge')f.graph.edges=[{source:'later-source',target:'n'}];if(change==='deleted-node')f.graph.nodes=[];
  finish(json({items:[profile],nextCursor:null}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.submitted()[0].body.graph.nodes[0].data.params).not.toHaveProperty('rhModel');}
 }finally{c.adapter.clear();}
});

it.each(['native-selector-removal','later-prompt'])('checks the native selector removal while saving execution input: %s',async change=>{
 const f=await home(),projected=command(f.graph);let finish!:(value:Response)=>void,saved:any;const c=setup(f.graph,{save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.submit(projected),rejected=change==='later-prompt'?expect(pending).rejects.toBeDefined():undefined;await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));delete f.graph.nodes[0].data.params.rhModel;if(change==='later-prompt')f.graph.nodes[0].data.params.prompt='later input';finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-10-22T02:00:00Z'}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.submitted()[0].body.expectedRevision).toBe(2);expect(c.storage.isBlocked('p')).toBe(false);}
 }finally{c.adapter.clear();}
});
