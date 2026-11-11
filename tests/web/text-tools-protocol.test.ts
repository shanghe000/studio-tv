import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {modelSelections} from '../../apps/web/src/service/model-catalog';

const profile=(version:string,kind='LLM')=>({
 capabilityRef:'codex-'+version.replaceAll('.','-')+(kind==='LLM'?'-text-v1':'-vision-text-v1'),version:'1',kind,
 executionKind:'AGENT',available:true,testMode:false,parameterSchemaVersion:'1',parameterSchema:{type:'object',properties:{},additionalProperties:false},
 inputKinds:kind==='LLM'?['TEXT','STRUCTURED']:['TEXT','STRUCTURED','IMAGE'],outputKinds:['TEXT'],
 model:{providerRef:'codex',modelRef:'codex-'+version.replaceAll('.','-'),title:'Codex '+version,version},
});
const text=profile('6.1'),other=profile('6'),vision=profile('6.1','IMAGE_UNDERSTANDING');
const response=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
function fixture(outputs:any[],catalog:any[]=[text,other,vision]){
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path.includes('/model-capabilities?'))return response({items:catalog,nextCursor:null});
  if(path.startsWith('/api/v2/model-capability-version?'))return new Response(JSON.stringify({code:'MODEL_VERSION_NOT_FOUND',message:'Fixture exact pair unavailable'}),{status:404});
  if(path==='/api/v2/canvas-runs')return response({id:'task',projectId:'project',state:'QUEUED',plans:[],testMode:false},202);
  if(path==='/api/v2/tasks/task')return response({id:'task',projectId:'project',state:'SUCCEEDED',testMode:false,plans:[{nodeId:'tool-node',outputs}]});
  throw new Error('Unexpected fixture request: '+path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn().mockResolvedValue(undefined),vi.fn());
 adapter.attach('project',{getRemoteData:()=>({nodes:[],edges:[]}),patchNodeData:vi.fn()});
 return{adapter,transport,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data};
}
afterEach(()=>modelSelections.clear());

const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=source.indexOf('async function QQr('),end=source.indexOf('async function ZQr(',start);
if(start<0||end<start)throw new Error('Immutable Skill optimizer reader is missing');
// Run the actual frozen request builder and JSON consumer with a local transport.
const nativeOptimizer=(post:Function)=>new Function('Sn','Wp','wht',source.slice(start,end)+';return QQr;')({post},(data:any)=>data,30000) as (file:{path:string;markdown:string})=>Promise<string>;

it.each(['TEXT','STRUCTURED'])('lets the real native Skill reader consume %s without losing Markdown or changing model/message binding',async type=>{
 const revised='---\ntitle: "Quoted"\n---\n# 完整技能\n引用 [参考](assets/ref.png)\n\n`code`';
 const output=type==='TEXT'?{type,text:JSON.stringify({optimized_content:revised})}:{type,schemaVersion:'1',data:{optimized_content:revised}};
 const f=fixture([output]);modelSelections.set('tools:LLM',{capabilityRef:other.capabilityRef,capabilityVersion:'1',explicit:true});
 const posted=vi.fn(async(path:string,body:any)=>({data:await f.adapter.handle(path,body)}));
 const run=nativeOptimizer(posted),file={path:'SKILL.md',markdown:'# 原文\n引用 [资源](assets/ref.png)'},before=structuredClone(file);
 expect(await run(file)).toBe(revised);expect(file).toEqual(before);
 const request=posted.mock.calls[0];expect(request[0]).toBe('/canvas/agent/skill/file/content/optimize');
 const node=f.submitted();expect(node.capabilityRef).toBe(other.capabilityRef);expect(node.capabilityVersion).toBe('1');expect(node.routerParameters).toEqual({});
 expect(node.params.prompt).toBe(request[1].message);expect(node.promptSelection.messages).toEqual([{role:'USER',text:request[1].message}]);expect(node.promptSelection.featureCode).toBe('skill.optimize');
});

it.each([
 ['malformed JSON',[{type:'TEXT',text:'# Markdown is not a JSON object'}]],
 ['null',[{type:'STRUCTURED',schemaVersion:'1',data:null}]],
 ['wrong field',[{type:'STRUCTURED',schemaVersion:'1',data:{content:'wrong'}}]],
 ['wrong type',[{type:'STRUCTURED',schemaVersion:'1',data:{optimized_content:5}}]],
 ['empty Markdown',[{type:'STRUCTURED',schemaVersion:'1',data:{optimized_content:'  \n'}}]],
 ['unknown schema',[{type:'STRUCTURED',schemaVersion:'2',data:{optimized_content:'# content'}}]],
 ['no output',[]],
 ['multiple JSON values',[{type:'TEXT',text:'{"optimized_content":"one"}'},{type:'TEXT',text:'{"optimized_content":"two"}'}]],
] as [string,any[]][])('rejects Skill %s rather than passing an invalid native DTO',async(_label,outputs)=>{
 const f=fixture(outputs);await expect(f.adapter.handle('/canvas/agent/skill/file/content/optimize',{message:'# original'})).rejects.toMatchObject({code:'INVALID_OUTPUT'});
});

it.each([
 ['IMAGE','text-image-original-vendor-model'],
 ['VIDEO','image-video-original-vendor-model'],
])('treats native %s modelCode as prompt-enhance target context and uses the real text default',async(nodeCategory,modelCode)=>{
 const f=fixture([{type:'TEXT',text:'优化后的提示词'}]),body={canvasId:'project',prompt:'保留[图1]与原人物身份',scene:'original-scene',nodeCategory,refImageCount:2,modelCode,videoParams:{duration:5,aspectRatio:'9:16'}},before=structuredClone(body);
 expect(await f.adapter.handle('/canvas/prompt/enhance',body)).toEqual({enhancedPrompt:'优化后的提示词',taskId:'task',testMode:false});expect(body).toEqual(before);
 const node=f.submitted();expect(node.capabilityRef).toBe(text.capabilityRef);expect(node.capabilityVersion).toBe('1');expect(node.params.prompt).toBe(body.prompt);expect(node.routerParameters).toEqual({});
 expect(node.promptSelection).toEqual({schemaVersion:'1',featureCode:'prompt.enhance',conditions:{scene:body.scene,nodeCategory,refImageCount:2,videoParams:body.videoParams,modelCode}});
});

it('keeps an explicit compatible prompt-enhance capability instead of replacing it with the default or target model',async()=>{
 const f=fixture([{type:'TEXT',text:'revised'}]);await f.adapter.handle('/canvas/prompt/enhance',{prompt:'original',modelCode:'target-image-model',capabilityRef:other.capabilityRef,capabilityVersion:'1'});
 const node=f.submitted();expect(node.capabilityRef).toBe(other.capabilityRef);expect(node.capabilityVersion).toBe('1');expect(node.promptSelection.conditions.modelCode).toBe('target-image-model');
});

it.each([
 [vision.capabilityRef,'1','MODEL_INPUT_UNSUPPORTED'],
 [text.capabilityRef,'2','MODEL_VERSION_CHANGED'],
 ['unknown-llm','1','MODEL_UNAVAILABLE'],
])('strictly rejects explicit prompt-enhance selection %s / %s',async(capabilityRef,capabilityVersion,code)=>{
 const f=fixture([{type:'TEXT',text:'must not run'}]);await expect(f.adapter.handle('/canvas/prompt/enhance',{prompt:'original',modelCode:'target-video-model',capabilityRef,capabilityVersion})).rejects.toMatchObject({code});
 expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('preserves llm.invoke choices/message/content with plain TEXT and STRUCTURED outputs',async()=>{
 const f=fixture([{type:'TEXT',text:'plain text'},{type:'STRUCTURED',schemaVersion:'1',data:{json:true}}]);
 expect(await f.adapter.handle('/canvas/invoke/api/llm',{capabilityRef:text.capabilityRef,capabilityVersion:'1',params:{messages:[{role:'user',content:'original request'}]}})).toEqual({choices:[{message:{role:'assistant',content:'plain text\n{"json":true}'}}],testMode:false});
 const node=f.submitted();expect(node.capabilityRef).toBe(text.capabilityRef);expect(node.promptSelection.featureCode).toBe('llm.invoke');expect(node.promptSelection.messages).toEqual([{role:'USER',text:'original request'}]);
});
