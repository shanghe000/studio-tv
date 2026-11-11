import h3 from './fixtures/router-h3-capabilities.json';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {isGenerationMaterialNode,validateGenerationGraph} from '../../apps/web/src/service/generation-readiness';

const cap:any={capabilityRef:'edit',version:'1',parameterSchemaVersion:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,model:{providerRef:'comfy',modelRef:'edit',title:'参考编辑',version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['square'],default:'square'}},additionalProperties:false,'x-input-media-constraints':{schemaVersion:'1',kinds:{IMAGE:{maxBytes:1048576,maxWidth:2048,maxHeight:2048}}}}};
const source=()=>({id:'image',type:'rh-image',position:{x:0,y:0},data:{isUpload:true,subType:'text-image',sourceObjects:['rhtv-asset:reference']}});
const target=()=>({id:'target',type:'rh-image',position:{x:400,y:0},data:{title:'产品编辑',modelCode:'edit',capabilityVersion:'1',subType:'image-image',params:{prompt:'Keep the subject',outputPreset:'square'}}});
const graph=():NativeGraph=>({nodes:[source(),target()],edges:[{id:'edge',source:'image',target:'target',sourceHandle:'output',targetHandle:'input'}]});
function setup(g=graph(),caps:any[]=[structuredClone(cap)],assetFailure:()=>{status:number;code:string}|undefined=()=>undefined){
 const requests:any[]=[],assets:any={reference:{id:'reference',kind:'IMAGE',state:'READY',byteSize:1024,width:512,height:512}};
 const api=new ProductClient('/api/v1',async(path,options:any={})=>{const body=options.body?JSON.parse(options.body):undefined;requests.push({path,method:options.method||'GET',body});const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{ETag:'"2"'}});if(path.includes('model-capabilities'))return json({items:caps,nextCursor:null});if(path.startsWith('/api/v1/assets/')){const failure=assetFailure();return failure?new Response(JSON.stringify({code:1,error:{code:failure.code,message:'资产服务暂时无响应'}}),{status:failure.status}):json(assets[path.split('/').at(-1)!]);}if(path==='/api/v1/projects/p/snapshot')return json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-11-02T00:00:00Z'});if(path==='/api/v2/generation-diagnostics')return json({logId:'diagnostic'});if(path==='/api/v2/canvas-runs')return json({id:'task',projectId:'p',state:'SUCCEEDED',revision:1,testMode:false,plans:[]});throw Error('Unexpected readiness request '+path);});
 api.setAccessToken('fixture-only');const storage=new ServiceStorage(api,vi.fn()),notice=vi.fn(),execution=new ExecutionAdapter(api,storage,async()=>{},notice),manager={getRemoteData:()=>g,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(g),updatedAt:'2026-11-02T00:00:00Z'},'"1"');storage.attachNativeView('p',g);execution.attach('p',manager);return{g,execution,requests,assets,caps,manager,notice};
}
it('uses the submission model/asset/parameter checks without saving or submitting a task',async()=>{
 const f=setup();try{expect(await f.execution.inspectGeneration('p',['target'])).toEqual({status:'ready',issues:[]});expect(f.requests.every(row=>row.method==='GET')).toBe(true);expect(f.manager.patchNodeData).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();}finally{f.execution.clear();}
});
it.each([[504,'CANVAS_REQUEST_TIMEOUT'],[503,'ASSET_METADATA_SERVICE_BUSY']] as const)('retains retryability for an actual asset %s response with code %s',async(status,code)=>{
 let failure:{status:number;code:string}|undefined={status,code};const f=setup(graph(),[structuredClone(cap)],()=>failure),before=structuredClone(f.g);
 try{const blocked=await f.execution.inspectGeneration('p',['target']);expect(blocked).toMatchObject({status:'blocked',issues:[{code,retryable:true}]});failure=undefined;expect(await f.execution.inspectGeneration('p',['target'])).toEqual({status:'ready',issues:[]});expect(f.g).toEqual(before);expect(f.requests.filter(row=>row.path==='/api/v1/assets/reference')).toHaveLength(2);}finally{f.execution.clear();}
});
it.each([
 {type:'rh-image',subType:'image-image',kind:'IMAGE_TO_IMAGE',input:'IMAGE',output:'IMAGE'},
 {type:'rh-text',subType:'image-text',kind:'IMAGE_UNDERSTANDING',input:'IMAGE',output:'TEXT'},
 {type:'rh-audio',subType:'audio-audio',kind:'AUDIO_TO_AUDIO',input:'AUDIO',output:'AUDIO'},
])('validates connected references for ordinary $type nodes in a localOnly native manager',async({type,subType,kind,input,output})=>{
 const selected={...structuredClone(cap),kind,inputKinds:['TEXT',input],outputKinds:[output],parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['square'],default:'square'}},additionalProperties:false}},g=graph();g.nodes[0].type=input==='AUDIO'?'rh-audio':'rh-image';g.nodes[1].type=type;g.nodes[1].data.subType=subType;const f=setup(g,[selected]);(f.manager as any).localOnly=true;f.assets.reference.kind=input;
 try{expect(g.nodes[1].data.params).not.toHaveProperty('imageUrls');expect(g.nodes[1].data.params).not.toHaveProperty('audioUrls');expect(await f.execution.inspectGeneration('p',['target'])).toEqual({status:'ready',issues:[]});expect(f.requests.some(row=>row.path==='/api/v1/assets/reference')).toBe(true);expect(f.requests.some(row=>row.path==='/api/v2/canvas-runs'||row.method==='PUT')).toBe(false);}finally{f.execution.clear();}
});
it.each([
 {type:'rh-image',subType:'image-image',kind:'IMAGE_TO_IMAGE',input:'IMAGE',output:'IMAGE'},
 {type:'rh-text',subType:'image-text',kind:'IMAGE_UNDERSTANDING',input:'IMAGE',output:'TEXT'},
 {type:'rh-audio',subType:'audio-audio',kind:'AUDIO_TO_AUDIO',input:'AUDIO',output:'AUDIO'},
])('does not hide an unsupported connected asset for ordinary native $type nodes',async({type,subType,kind,input,output})=>{
 const selected={...structuredClone(cap),kind,inputKinds:['TEXT',input],outputKinds:[output],parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['square'],default:'square'}},additionalProperties:false}},g=graph();g.nodes[0].type=input==='AUDIO'?'rh-audio':'rh-image';g.nodes[1].type=type;g.nodes[1].data.subType=subType;const f=setup(g,[selected]);(f.manager as any).localOnly=true;f.assets.reference.kind='VIDEO';
 try{const answer=await f.execution.inspectGeneration('p',['target']);expect(answer.status).toBe('blocked');expect(answer.issues[0]).toMatchObject({nodeId:'target',sourceNodeId:'image',code:'MODEL_INPUT_UNSUPPORTED'});expect(f.requests.some(row=>row.path==='/api/v1/assets/reference')).toBe(true);expect(f.requests.some(row=>row.path==='/api/v2/canvas-runs'||row.method==='PUT')).toBe(false);}finally{f.execution.clear();}
});
it.each(['parameter','bytes','metadata','missing-image','unsupported','version','cycle','uploading','upload-error','unowned-url'])('blocks %s with the exact node before any task or graph write',async change=>{
 const f=setup();try{if(change==='parameter')f.g.nodes[1].data.params.outputPreset='unsupported';if(change==='bytes')f.assets.reference.byteSize=1048577;if(change==='metadata')delete f.assets.reference.width;if(change==='missing-image')f.g.edges=[];if(change==='unsupported')f.assets.reference.kind='VIDEO';if(change==='version')f.g.nodes[1].data.capabilityVersion='old';if(change==='cycle')f.g.edges.push({id:'back',source:'target',target:'image'});if(change==='uploading')f.g.nodes[0].data.status='uploading';if(change==='upload-error')f.g.nodes[0].data.uploadError=true;if(change==='unowned-url')f.g.nodes[0].data.sourceObjects=['https://unowned.invalid/input.png'];
  const answer=await f.execution.inspectGeneration('p',['target']);expect(answer.status).toBe('blocked');expect(answer.issues[0].nodeId).toBe('target');expect(answer.issues[0].message).toBeTruthy();expect(f.requests.some(row=>row.path==='/api/v2/canvas-runs'||row.method==='PUT')).toBe(false);expect(f.requests.some(row=>row.path.includes('generation-diagnostics'))).toBe(false);
  if(['bytes','metadata','unsupported','uploading','upload-error','unowned-url'].includes(change))expect(answer.issues[0].sourceNodeId).toBe('image');
 }finally{f.execution.clear();}
});
it('requires images for a selected edit, while allowing a group to generate that image first',async()=>{
 const g=graph();g.nodes[0]={id:'image',type:'rh-image',position:{x:0,y:0},data:{title:'先生成图片',modelCode:'generate',subType:'text-image',params:{prompt:'A product',outputPreset:'square'}}};
 const generate={...structuredClone(cap),capabilityRef:'generate',kind:'TEXT_TO_IMAGE'},f=setup(g,[generate,structuredClone(cap)]);try{const answer=await f.execution.inspectGeneration('p',['image','target']);expect(answer.status).toBe('ready');expect(f.requests.some(row=>row.path.includes('canvas-runs'))).toBe(false);}finally{f.execution.clear();}
});
it('rejects a known incompatible planned output before running the first node of a group',async()=>{
 const g=graph();g.nodes[0]={id:'image',type:'rh-image',position:{x:0,y:0},data:{title:'上游大图',modelCode:'generate',capabilityVersion:'1',subType:'text-image',params:{prompt:'A product',outputPreset:'square'}}};
 const generate={...structuredClone(cap),capabilityRef:'generate',kind:'TEXT_TO_IMAGE'};generate.parameterSchema['x-output-presets']=[{value:'square',width:4096,height:4096}];const f=setup(g,[generate,structuredClone(cap)]);
 try{const answer=await f.execution.inspectGeneration('p',['image','target']);expect(answer.status).toBe('blocked');expect(answer.issues.find(issue=>issue.nodeId==='target')).toMatchObject({sourceNodeId:'image',code:'MEDIA_INPUT_INVALID'});expect(f.requests.some(row=>row.path.includes('canvas-runs'))).toBe(false);}finally{f.execution.clear();}
});
it('records only an explicit blocked attempt and keeps parameter/source diagnostics',async()=>{
 const f=setup();try{f.g.nodes[1].data.params.outputPreset='unsupported';const answer=await f.execution.inspectGeneration('p',['target']);expect(f.requests.some(row=>row.path.includes('diagnostics'))).toBe(false);await f.execution.reportGenerationReadinessFailure('p',answer.issues[0]);const diagnostic=f.requests.find(row=>row.path.includes('diagnostics'));expect(diagnostic.body).toMatchObject({projectId:'p',nodeId:'target',errorCode:'MODEL_PARAMETER_INVALID',preflight:{capabilityRef:'edit',capabilityVersion:'1'}});expect(f.notice).not.toHaveBeenCalled();}finally{f.execution.clear();}
});
it('reports limits, cycles and dangling edges before server graph validation',()=>{
 expect(()=>validateGenerationGraph({nodes:[target()],edges:[{source:'missing',target:'target'}]})).toThrow('已删除');expect(()=>validateGenerationGraph({nodes:[target()],edges:[{source:'target',target:'target'}]})).toThrow('自身');expect(()=>validateGenerationGraph({nodes:Array.from({length:501},(_,i)=>({...target(),id:'n'+i})),edges:[]})).toThrow('500');
});
it('identifies duplicate legacy or imported links before any task is created',async()=>{
 const f=setup();f.g.edges.push({...f.g.edges[0],id:'duplicate-link'});
 try{const result=await f.execution.inspectGeneration('p',['target']);expect(result).toMatchObject({status:'blocked',issues:[{code:'GRAPH_INPUT_INVALID',message:expect.stringContaining('重复连线'),context:{issues:[{component:'TOPOLOGY',sourceNodeId:'target'}]}}]});expect(f.requests.some(row=>row.path.includes('canvas-runs'))).toBe(false);}finally{f.execution.clear();}
});
it.each(['cycle','dangling','duplicate','large-unrelated-input'])('keeps unrelated %s outside the selected group inspection and submitted execution snapshot',async defect=>{
 const g=graph();g.nodes.push({id:'group',type:'group',position:{x:0,y:0},data:{nodeIds:['target']}} as any,{id:'outside',type:'rh-text',position:{x:1000,y:0},data:{text:defect==='large-unrelated-input'?'x'.repeat(2*1048576):'unrelated'}} as any);
 const f=setup(g);
 if(defect==='cycle')g.edges.push({source:'outside',target:'outside'});
 if(defect==='dangling')g.edges.push({source:'deleted',target:'outside'});
 if(defect==='duplicate')g.edges.push({source:'outside',target:'deleted'},{source:'outside',target:'deleted'});
 const before=structuredClone(g);
 try{
  expect(await f.execution.inspectGeneration('p',['group'],g,true)).toEqual({status:'ready',issues:[]});
  expect(await f.execution.inspectGeneration('p',['target'],g,true)).toEqual({status:'ready',issues:[]});
  await f.execution.run({projectId:'p',targetType:'GROUP',targetId:'group',graph:g});
  const command=f.requests.find(row=>row.path==='/api/v2/canvas-runs').body;
  expect(command.graph.nodes.map((node:any)=>node.id).sort()).toEqual(['group','image','target']);expect(command.graph.edges).toHaveLength(1);expect(command.graph.edges[0]).toMatchObject({source:'image',target:'target'});expect(g).toEqual(before);
 }finally{f.execution.clear();}
});
it('still rejects a missing reference entering the selected group and points to its actual target',async()=>{
 const g=graph();g.nodes.push({id:'group',type:'group',position:{x:0,y:0},data:{nodeIds:['target']}} as any);const f=setup(g);g.edges.push({source:'deleted',target:'target'});
 try{const answer=await f.execution.inspectGeneration('p',['group'],g,true);expect(answer).toMatchObject({status:'blocked',issues:[{code:'GRAPH_INPUT_INVALID',sourceNodeId:'target'}]});await expect(f.execution.run({projectId:'p',targetType:'GROUP',targetId:'group',graph:g})).rejects.toMatchObject({code:'GRAPH_INPUT_INVALID'});expect(f.requests.some(row=>row.path==='/api/v2/canvas-runs')).toBe(false);}finally{f.execution.clear();}
});
it('uses the same structural scope for a group preview and submit, including an isolated material member',async()=>{
 const g=graph();g.nodes.push({id:'group',type:'group',position:{x:0,y:0},data:{nodeIds:['target','material']}},{...source(),id:'material'});const f=setup(g);g.edges.push({source:'material',target:'material'});
 try{expect(await f.execution.inspectGeneration('p',['group'],g,true)).toMatchObject({status:'blocked',issues:[{code:'GRAPH_INPUT_INVALID',sourceNodeId:'material'}]});await expect(f.execution.run({projectId:'p',targetType:'GROUP',targetId:'group',graph:g})).rejects.toMatchObject({code:'GRAPH_INPUT_INVALID'});expect(f.requests.some(row=>row.path==='/api/v2/canvas-runs')).toBe(false);}finally{f.execution.clear();}
});
it('checks a normal group membership inconsistency before submission and recovers when repaired',async()=>{
 const g=graph();g.nodes.push({id:'group',type:'group',position:{x:0,y:0},data:{groupType:'normal',nodeIds:['target']}});const f=setup(g);
 try{expect(await f.execution.inspectGeneration('p',['group'],g,true)).toMatchObject({status:'blocked',issues:[{code:'STALE_NATIVE_GROUP_COMMAND'}]});expect(f.requests.some(row=>row.path==='/api/v2/canvas-runs')).toBe(false);g.nodes[1].data.groupId='group';expect(await f.execution.inspectGeneration('p',['group'],g,true)).toEqual({status:'ready',issues:[]});expect(g.nodes[1].parentId).toBeUndefined();}finally{f.execution.clear();}
});
it.each(['group','rh-group'])('keeps %s inspection on group input composition even with only one generator',async type=>{
 const g=graph();g.nodes.push({id:'group',type,position:{x:0,y:0},data:{nodeIds:['target']}});const f=setup(g);(f.manager as any).localOnly=true;const prepare=vi.spyOn(f.execution as any,'prepareGenerationNode');
 try{expect(await f.execution.inspectGeneration('p',['group'],g,true)).toEqual({status:'ready',issues:[]});expect(prepare.mock.calls[0][4]).toMatchObject({nativeVideoComposer:false});}finally{f.execution.clear();}
});
it('shares conservative material classification with group target expansion',()=>{
 expect(isGenerationMaterialNode(source())).toBe(true);expect(isGenerationMaterialNode({...source(),data:{subType:'text-image',sourceObjects:['rhtv-asset:reference']}})).toBe(true);for(const key of ['params','modelCode','generateNum','modelType','toolsType'])expect(isGenerationMaterialNode({...source(),data:{subType:'text-image',sourceObjects:['rhtv-asset:reference'],[key]:key==='params'?{prompt:'new input'}:key==='generateNum'?1:'configured'}})).toBe(false);
});

it.each([['qwen-image-edit-2511-v1','IMAGE_TO_IMAGE',1],['seedvr2-image-enhance-v1','IMAGE_ENHANCE',1],['codex-image-edit-v1','IMAGE_TO_IMAGE',4]] as const)('rechecks %s reference counts on loaded single nodes before enqueue',async(ref,kind,maximum)=>{
 const edit={...structuredClone(cap),kind,capabilityRef:ref,version:ref.startsWith('codex')?'3':'1',parameterSchema:{...cap.parameterSchema,...(!ref.startsWith('codex')?{'x-input-constraints':{min_images:1,max_images:1}}:{})}};
 const node=target();node.data.modelCode=ref;node.data.capabilityVersion=edit.version;node.data.subType=kind==='IMAGE_ENHANCE'?'image-hd':'image-image';
 const f=setup({nodes:[node],edges:[]},[edit]);
 try{
  const ids=Array.from({length:maximum+1},(_,i)=>'input'+i);for(const id of ids)f.assets[id]={...f.assets.reference,id};
  f.g.nodes[0].data.params.imageUrls=ids.slice(0,maximum).map(id=>'rhtv-asset:'+id);expect((await f.execution.inspectGeneration('p',['target'])).status).toBe('ready');
  f.g.nodes[0].data.params.imageUrls.push('rhtv-asset:'+ids.at(-1));expect((await f.execution.inspectGeneration('p',['target'])).issues[0]).toMatchObject({code:'MODEL_INPUT_UNSUPPORTED',context:{issues:[{reason:'COUNT_EXCEEDED',maximum}]}});
  expect(f.requests.some(r=>r.path==='/api/v2/canvas-runs')).toBe(false);
 }finally{f.execution.clear();}
});

it('rejects a saved first/last-frame graph which points both slots to the same asset without creating a task',async()=>{
 const profile={...h3.find(c=>c.capabilityRef==='h3-first-last-frame-v1')!,available:true,testMode:false},a=source(),b={...source(),id:'second'};
 const target={id:'target',type:'rh-video',position:{x:400,y:0},data:{modelCode:profile.capabilityRef,subType:'start-end-video',params:{prompt:'A short loop.'}}};
 const g={nodes:[a,b,target],edges:[a,b].map(n=>({id:'from-'+n.id,source:n.id,target:'target',sourceHandle:'output',targetHandle:'input'}))};
 const f=setup(g,[profile]);(f.manager as any).localOnly=true;
 try{
  const inspected=await f.execution.inspectGeneration('p',['target'],g);
  expect(inspected.issues[0]).toMatchObject({code:'MODEL_INPUT_UNSUPPORTED',message:expect.stringContaining('两份不同')});
  await expect(f.execution.run({projectId:'p',targetType:'NODE',targetId:'target',graph:g})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
  expect(f.requests.filter(row=>row.path==='/api/v2/canvas-runs')).toHaveLength(0);
 }finally{f.execution.clear();}
});
