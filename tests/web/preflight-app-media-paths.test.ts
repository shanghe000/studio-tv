import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ApiError} from '../../apps/web/src/api/client';
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"2"'}}),cap:any={capabilityRef:'mock-image',kind:'TEXT_TO_IMAGE',version:'1',parameterSchemaVersion:'1',available:true,testMode:true,parameterSchema:{type:'object',properties:{}}};
const field=(kind='STRING')=>({nodeId:'field',fieldName:'value',fieldType:kind,fieldValue:'',fieldData:kind==='INT'?'["INT",{"min":1,"max":4}]':'["STRING",{}]'});
const app=(id:string,input:any,output='image')=>({id,type:'rh-ai',position:{x:0,y:0},data:{title:id,aiApp:{id,inputNodes:[input]},aiNodeOutputType:output}});
const definition=(id:string,f:any,outputType='IMAGE')=>({resource:{id,revision:1},content:{inputNodes:[f],outputType}});
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.restoreAllMocks();});
function setup(extra:(path:string,init:any)=>Response|Promise<Response>|undefined){
 const requests:any[]=[],api=new ProductClient('/api/v1',async(path,init:any={})=>{const body=init.body?JSON.parse(init.body):undefined;requests.push({path,body});const response=extra(path,init);if(response)return response;if(path.includes('model-capabilities'))return json({items:[cap,{...cap,kind:'LLM',capabilityRef:'mock-text'}],nextCursor:null});if(path==='/api/v2/generation-diagnostics')return json({logId:'fixture-diagnostic'});throw Error('Unexpected '+path);});api.setAccessToken('fixture');const storage=new ServiceStorage(api,vi.fn()),notice=vi.fn(),execution=new ExecutionAdapter(api,storage,async()=>{},notice,{allowTestMode:true});cleanups.push(()=>execution.clear());return{execution,requests,storage,notice};
}
it('checks all independent application values before the first task and identifies the failing application field',async()=>{
 const f=field(),bad=field('INT'),graph={nodes:[app('first',{...f,fieldValue:'valid'}),app('second',{...bad,fieldValue:'99'})],edges:[]};
 const c=setup((path,init)=>path==='/api/v2/apps/first'?json(definition('first',f)):path==='/api/v2/apps/second'?json(definition('second',bad)):path==='/api/v2/app-runs'?json({id:'task',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[]}):undefined);
 await expect(c.execution.run({projectId:'p',targetType:'CANVAS',graph})).rejects.toMatchObject({code:'APP_INPUT_TYPE',message:expect.stringContaining('second')});expect(c.requests.filter(row=>row.path==='/api/v2/app-runs')).toHaveLength(0);expect(c.requests.find(row=>row.path==='/api/v2/generation-diagnostics')?.body).toMatchObject({nodeId:'second',preflight:{issues:[expect.objectContaining({sourceNodeId:'second'})]}});
});
it('defers valid future application outputs without fabricating a temporary asset or reusing old output',async()=>{
 const f=field(),image=field('IMAGE'),first=app('first',{...f,fieldValue:'create'}),second=app('second',{...image,binding:{sourceNodeId:'first'}}),graph={nodes:[first,second],edges:[{source:'first',target:'second'}]};
 const c=setup((path,init)=>path==='/api/v2/apps/first'?json(definition('first',f)):path==='/api/v2/apps/second'?json(definition('second',image)):path==='/api/v1/assets/actual'?json({id:'actual',state:'READY',kind:'IMAGE'}):path==='/api/v2/app-runs'?json({id:JSON.parse(init.body).nodeId+'-task',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[{nodeId:JSON.parse(init.body).nodeId,state:'SUCCEEDED',outputs:JSON.parse(init.body).nodeId==='first'?[{id:'o',type:'ASSET',assetId:'actual'}]:[]}]}):undefined);
 await c.execution.run({projectId:'p',targetType:'CANVAS',graph});const creates=c.requests.filter(row=>row.path==='/api/v2/app-runs');expect(creates).toHaveLength(2);expect(creates[1].body.inputNodes[0].fieldValue).toBe('rhtv-asset:actual');expect(c.requests.some(row=>row.path.includes('placeholder')||row.path.includes('pending-'))).toBe(false);
});
it('rejects a known application binding type mismatch before an upstream task',async()=>{
 const f=field(),video=field('VIDEO'),first=app('first',{...f,fieldValue:'create'}),second=app('second',{...video,binding:{sourceNodeId:'first'}}),graph={nodes:[first,second],edges:[{source:'first',target:'second'}]};
 const c=setup(path=>path==='/api/v2/apps/first'?json(definition('first',f)):path==='/api/v2/apps/second'?json(definition('second',video)):undefined);
 await expect(c.execution.run({projectId:'p',targetType:'CANVAS',graph})).rejects.toMatchObject({code:'APP_INPUT_TYPE'});expect(c.requests.some(row=>row.path==='/api/v2/app-runs')).toBe(false);
});
it('validates ordinary model parameters in a mixed APP graph before the first APP submission',async()=>{
 const f=field(),second:any={id:'second',type:'rh-image',position:{x:400,y:0},data:{subType:'text-image',modelCode:'mock-image',params:{prompt:'paint',outputPreset:'invalid'}}},graph={nodes:[app('first',{...f,fieldValue:'create'}),second],edges:[]},typed={...cap,parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['square']}}}};
 const c=setup(path=>path.includes('model-capabilities')?json({items:[typed],nextCursor:null}):path==='/api/v2/apps/first'?json(definition('first',f)):path==='/api/v2/app-runs'?json({id:'first-task',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[]}):undefined);
 await expect(c.execution.run({projectId:'p',targetType:'CANVAS',graph})).rejects.toMatchObject({code:'MODEL_PARAMETER_INVALID'});expect(c.requests.some(row=>row.path==='/api/v2/app-runs'||row.path==='/api/v2/canvas-runs')).toBe(false);
});
it.each(['finished','idle'])('keeps the original %s node state when ordinary generate is rejected before a task',async status=>{
 const graph={nodes:[{id:'node',type:'rh-text',position:{x:0,y:0},data:{status,taskId:'old-task',text:'previous output',modelCode:'missing-model',params:{prompt:'new input'}}}],edges:[]},c=setup(()=>undefined),patch=vi.fn((id:string,data:any)=>Object.assign(graph.nodes[0].data,data));c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});expect(await c.execution.generate('node')).toBe(false);expect(graph.nodes[0].data).toMatchObject({status,taskId:'old-task',text:'previous output'});expect(patch.mock.calls.some(([,data])=>data.status==='failed')).toBe(false);
});
it('keeps prior entity output and task status when the new entity command fails local preflight',async()=>{
 const graph:any={nodes:[{id:'entity',type:'rh-image',position:{x:0,y:0},data:{storyboardEntityNode:true,storyboardScriptNodeId:'script',status:'finished',taskId:'old-task',text:'previous output',params:{prompt:'prior'}}}],edges:[]},c=setup(()=>undefined),patch=vi.fn((id:string,data:any)=>Object.assign(graph.nodes[0].data,data));c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});vi.spyOn(c.execution,'freezeGraph').mockImplementation(async graph=>graph);vi.spyOn(c.execution,'run').mockRejectedValue(new ApiError(422,'MODEL_INPUT_UNSUPPORTED','补齐参考图片。'));
 await expect(c.execution.generateEntityPlans('p',[{...graph.nodes[0],data:{...graph.nodes[0].data,status:'idle',taskId:'',text:'',output:[],params:{prompt:'new'}}}],{capabilityRef:'mock-image'})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(graph.nodes[0].data).toMatchObject({status:'finished',taskId:'old-task',text:'previous output'});expect(patch.mock.calls.some(([,data])=>data.status==='idle'||data.status==='failed'||data.taskId==='')).toBe(false);
});
it.each(['speed','trim','kind','crop','codec'])('blocks invalid media %s before saving or posting a task and reports its node',async problem=>{
 const spec:any={version:1,inputs:[{id:'source',assetId:'asset'}],tracks:[{type:'video',clips:[{input:'source',trim:{startMs:0,endMs:2000}}]}],output:{container:'mp4'}},asset:any={id:'asset',state:'READY',kind:'VIDEO',durationSeconds:3,width:640,height:480};if(problem==='speed')spec.tracks[0].clips[0].speed=5;if(problem==='trim')spec.tracks[0].clips[0].trim.endMs=4000;if(problem==='kind')asset.kind='AUDIO';if(problem==='crop')spec.tracks[0].clips[0].crop={x:500,y:0,width:300,height:200};if(problem==='codec')spec.output.audioCodec='opus';
 const c=setup(path=>path==='/api/v1/assets/asset'?json(asset):undefined);await expect(c.execution.handle('/canvas/media/task/run',{projectId:'p',nodeId:'video',operation:'TRIM',spec})).rejects.toMatchObject({code:'MEDIA_INPUT_INVALID'});expect(c.requests.some(row=>row.path==='/api/v2/media-jobs'||row.path.endsWith('/snapshot'))).toBe(false);expect(c.requests.find(row=>row.path==='/api/v2/generation-diagnostics')?.body).toMatchObject({nodeId:'video',preflight:{capabilityRef:'local-ffmpeg',capabilityVersion:'1'}});
});
it('does not create an old-canvas media task when project changes while source metadata is loading',async()=>{
 let finish!:(value:Response)=>void;const c=setup(path=>path==='/api/v1/assets/asset'?new Promise<Response>(resolve=>finish=resolve):undefined),graph={nodes:[{id:'video',type:'rh-video',position:{x:0,y:0},data:{}}],edges:[]};c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:vi.fn()});
 const pending=c.execution.handle('/canvas/media/task/run',{projectId:'p',nodeId:'video',operation:'TRIM',spec:{version:1,inputs:[{id:'source',assetId:'asset'}],tracks:[{type:'video',clips:[{input:'source'}]}],output:{container:'mp4'}}}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));c.execution.attach('q',{getRemoteData:()=>graph,patchNodeData:vi.fn()});finish(json({id:'asset',state:'READY',kind:'VIDEO',durationSeconds:3,width:640,height:480}));await rejected;expect(c.requests.some(row=>row.path==='/api/v2/media-jobs')).toBe(false);
});
it('validates every entity before changing statuses or submitting any task and identifies the invalid entity',async()=>{
 const typed={...cap,parameterSchema:{type:'object',properties:{scenario:{type:'string',enum:['success'],default:'success'}}}},graph:any={nodes:['one','two'].map(id=>({id,type:'rh-image',position:{x:0,y:0},data:{storyboardEntityNode:true,storyboardScriptNodeId:'script',status:'finished',taskId:'old-'+id,params:{prompt:'original'}}})),edges:[]},c=setup(path=>path.includes('model-capabilities')?json({items:[typed],nextCursor:null}):undefined),patch=vi.fn();c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});const nodes=structuredClone(graph.nodes);nodes[0].data.params.scenario='success';nodes[1].data.params.scenario='unsupported';
 await expect(c.execution.generateEntityPlans('p',nodes,{capabilityRef:cap.capabilityRef})).rejects.toMatchObject({code:'MODEL_PARAMETER_INVALID'});expect(patch).not.toHaveBeenCalled();expect(c.requests.some(row=>row.path==='/api/v2/canvas-runs')).toBe(false);expect(c.requests.find(row=>row.path==='/api/v2/generation-diagnostics')?.body).toMatchObject({nodeId:'two'});
});
it('keeps a real entity input edit made during preflight instead of patching the older selection over it',async()=>{
 const graph:any={nodes:[{id:'entity',type:'rh-image',position:{x:0,y:0},data:{storyboardEntityNode:true,storyboardScriptNodeId:'script',status:'finished',taskId:'old',params:{prompt:'original'}}}],edges:[]},c=setup(()=>undefined),patch=vi.fn();c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});const nodes=structuredClone(graph.nodes);nodes[0].data.params.prompt='earlier selected input';let finish!:(value:any)=>void;vi.spyOn(c.execution,'freezeGraph').mockImplementation(graph=>new Promise(resolve=>finish=()=>resolve(graph)));
 const pending=c.execution.generateEntityPlans('p',nodes,{capabilityRef:cap.capabilityRef}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));graph.nodes[0].data.params.prompt='newer edit';finish(undefined);await rejected;expect(graph.nodes[0].data.params.prompt).toBe('newer edit');expect(patch).not.toHaveBeenCalled();expect(c.requests.some(row=>row.path==='/api/v2/canvas-runs')).toBe(false);
});

const audioEditGraph=()=>{
 const video=(id:string)=>({id,type:'rh-video',data:{isUpload:true,sourceObjects:['rhtv-asset:'+id]}});
 return {nodes:[video('old'),video('new'),{id:'track',type:'rh-audio',data:{toolsType:'VIDEO_AUDIO',sourceNodeId:'old',toolsSourceUrl:'rhtv-asset:old',modelCode:'local-video-audio-v1',params:{videoUrl:'rhtv-asset:old',audioSeparationMode:'all'}}}],edges:[{source:'new',target:'track'}]} as any;
};
it.each(['replace','disconnect','delete','wrong kind','two videos','stale history','batch'])('prepares full audio extraction from the current graph: %s',async change=>{
 const graph=audioEditGraph(),run={projectId:'p',targetId:'track',graph},video=(id:string)=>json({id,kind:'VIDEO',state:'READY',durationSeconds:3,width:640,height:480});
 if(change==='disconnect')graph.edges=[];if(change==='delete'){graph.nodes.splice(1,1);graph.edges=[];}
 if(change==='wrong kind')graph.nodes[1].type='rh-image';if(change==='two videos')graph.edges.push({source:'old',target:'track'});if(change==='stale history')graph.nodes[1].data.selectedHistoryOutputId='gone';
 const c=setup(path=>path.startsWith('/api/v1/assets/')?video(path.split('/').at(-1)!):path==='/api/v2/media-jobs'?json({taskId:'media',status:'QUEUED',outputs:[],testMode:false}):undefined);
 c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:vi.fn()});const readiness=await c.execution.inspectGeneration('p',['track'],graph,change==='batch');
 expect(readiness.status).toBe(change==='replace'?'ready':'blocked');
 c.execution.attach('',null);
 if(change==='replace'){await c.execution.run(run);expect(c.requests.find(x=>x.path==='/api/v2/media-jobs')?.body.spec.inputs).toEqual([{id:'source',assetId:'new'}]);}
 else{await expect(c.execution.run(change==='batch'?{...run,targetType:'CANVAS'}:run)).rejects.toBeTruthy();expect(c.requests.some(x=>x.path==='/api/v2/media-jobs'||x.path==='/api/v2/canvas-runs')).toBe(false);}
});
it('does not queue an old audio track when its video was changed while the asset was being read',async()=>{
 const graph=audioEditGraph();let finish!:(value:Response)=>void;
 const c=setup(path=>path.endsWith('/assets/new')?new Promise(resolve=>finish=resolve):undefined);c.execution.attach('p',{getRemoteData:()=>graph,patchNodeData:vi.fn()});
 const result=expect(c.execution.run({projectId:'p',targetId:'track',graph})).rejects.toMatchObject({code:'MEDIA_INPUT_CHANGED'});
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));graph.edges=[{source:'old',target:'track'}];finish(json({id:'new',kind:'VIDEO',state:'READY',durationSeconds:3,width:640,height:480}));await result;expect(c.requests.some(row=>row.path==='/api/v2/media-jobs')).toBe(false);
});
