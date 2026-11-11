import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {modelSelections} from '../../apps/web/src/service/model-catalog';

const ref='codex-6-1-vision-text-v1',vision={capabilityRef:ref,version:'2',kind:'IMAGE_UNDERSTANDING',executionKind:'AGENT',available:true,testMode:false,parameterSchemaVersion:'2',parameterSchema:{type:'object',properties:{reasoningEffort:{type:'string',enum:['low','high'],default:'low'}},additionalProperties:false},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['TEXT'],model:{providerRef:'codex',modelRef:'codex-6-1',title:'Codex 6.1',version:'6.1'}};
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
function fixture(outputs:any[]=[{type:'TEXT',text:'```text\n风格提示词：暖色、柔光\n抽象插画\n```'}],kind='IMAGE',catalog:any[]=[vision]){
 const transport=vi.fn(async(path:string,options:any)=>{
  if(path==='/api/v1/assets/image')return json({byteSize:2048,mimeType:kind==='IMAGE'?'image/png':kind==='VIDEO'?'video/mp4':'application/octet-stream',id:'image',state:'READY',kind});
  if(path.includes('/model-capabilities?'))return json({items:catalog,nextCursor:null});
  if(path==='/api/v2/canvas-runs')return json({id:'task',state:'SUCCEEDED',plans:[],testMode:false},202);
  if(path==='/api/v2/tasks/task')return json({id:'task',state:'SUCCEEDED',plans:[{outputs}],testMode:false});
  throw new Error('Unexpected fixture request: '+path);
 });const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn().mockResolvedValue(undefined),vi.fn());adapter.attach('project',{getRemoteData:()=>({nodes:[],edges:[]}),patchNodeData:vi.fn()});
 return{adapter,transport,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data};
}
const body=()=>({modelCode:'canvas_prompt_user_style_extract',params:{messages:[{role:'user',content:[{type:'text',text:'user_style_extract_prompt'},{type:'image_url',image_url:{url:'rhtv-asset:image'}}]}]}});
afterEach(()=>modelSelections.clear());
const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=source.indexOf('const gtr="canvas_prompt_user_style_extract"'),end=source.indexOf('function xtr(',start);
if(start<0||end<start)throw new Error('Frozen style extraction reader missing');
const nativeStyle=(post:Function)=>new Function('Sn',source.slice(start,end)+';return btr;')({post}) as (reference:string)=>Promise<string>;

it('runs the actual frozen style button request and consumer with one owned IMAGE and unchanged choices/content envelope',async()=>{
 const f=fixture(),posted=vi.fn(async(path:string,data:any)=>({data:await f.adapter.handle(path,data)})),extract=nativeStyle(posted);
 expect(await extract('  rhtv-asset:image  ')).toBe('暖色，柔光，抽象插画');expect(posted.mock.calls[0]).toEqual(['/canvas/invoke/api/llm',body()]);
 const node=f.submitted();expect(node).toMatchObject({capabilityRef:ref,capabilityVersion:'2',parameterSchemaVersion:'2',routerParameters:{reasoningEffort:'low'},params:{prompt:'user_style_extract_prompt',imageUrls:['rhtv-asset:image']}});
 expect(node.promptSelection).toEqual({schemaVersion:'1',featureCode:'image.style-extract',messages:[{role:'USER',text:'user_style_extract_prompt',assetIds:['image']}],conditions:{requestedModelCode:'canvas_prompt_user_style_extract'}});expect(node).not.toHaveProperty('promptSpec');
});
it('keeps an explicit compatible vision choice and native High while rejecting the same alias for arbitrary text requests',async()=>{
 const other={...vision,capabilityRef:'codex-6-vision-text-v1',model:{...vision.model,version:'6'}},f=fixture(undefined,'IMAGE',[vision,other]),request={...body(),capabilityRef:other.capabilityRef,capabilityVersion:'2'};request.params={...request.params,reasoning_effort:'high'} as any;
 await f.adapter.handle('/canvas/invoke/api/llm',request);expect(f.submitted()).toMatchObject({capabilityRef:other.capabilityRef,capabilityVersion:'2',routerParameters:{reasoningEffort:'high'}});
});
it.each(['VIDEO','AUDIO','FILE'])('rejects actual %s even when the native request declares image_url',async kind=>{
 const f=fixture(undefined,kind);await expect(f.adapter.handle('/canvas/invoke/api/llm',body())).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});
it.each([
 ['no image',(b:any)=>b.params.messages[0].content.pop()],
 ['wrong marker',(b:any)=>b.params.messages[0].content[0].text='describe something else'],
 ['privileged role',(b:any)=>b.params.messages[0].role='system'],
 ['more images',(b:any)=>b.params.messages[0].content.push(b.params.messages[0].content[1])],
 ['extra message',(b:any)=>b.params.messages.push({role:'user',content:'extra'})],
 ['mixed video',(b:any)=>b.params.messages[0].content.push({type:'video_url',video_url:{url:'rhtv-asset:video'}})],
 ['second user text',(b:any)=>b.message='extra'],
] as [string,(b:any)=>void][])('rejects %s outside the exact captured style feature before catalog or execution',async(_label,edit)=>{
 const f=fixture(),request=body();edit(request);await expect(f.adapter.handle('/canvas/invoke/api/llm',request)).rejects.toMatchObject({code:'MODEL_SELECTION_INVALID'});expect(f.transport).not.toHaveBeenCalled();
});
it('does not map another fixed alias or a pure-text profile into this image feature',async()=>{
 const f=fixture(),wrong=body();wrong.modelCode='unknown_style_alias';await expect(f.adapter.handle('/canvas/invoke/api/llm',wrong)).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});
 const text={...vision,kind:'LLM',inputKinds:['TEXT','STRUCTURED'],capabilityRef:'codex-5-6-text-v1'},g=fixture(undefined,'IMAGE',[text]);await expect(g.adapter.handle('/canvas/invoke/api/llm',{...body(),capabilityRef:text.capabilityRef,capabilityVersion:'2'})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(g.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});
it.each([['empty',[]],['structured',[{type:'STRUCTURED',schemaVersion:'1',data:{style:'wrong protocol'}}]],['blank',[{type:'TEXT',text:''}]],['multiple',[{type:'TEXT',text:'one'},{type:'TEXT',text:'two'}]]] as [string,any[]][])('does not return a fake style success for incompatible output %s',async(_label,outputs)=>{
 const f=fixture(outputs);await expect(f.adapter.handle('/canvas/invoke/api/llm',body())).rejects.toMatchObject({code:'INVALID_OUTPUT'});
});

it.each(['a'.repeat(500),'风'.repeat(500),'😀'.repeat(250)])('keeps the complete style at the native500 UTF16 boundary',async value=>{const f=fixture([{type:'TEXT',text:value}]);expect((await f.adapter.handle('/canvas/invoke/api/llm',body())).choices[0].message.content).toBe(value);});
it.each(['a'.repeat(501),'风'.repeat(501),'😀'.repeat(250)+'a'])('rejects an overlong style rather than silently truncating its meaning',async value=>{const f=fixture([{type:'TEXT',text:value}]);await expect(f.adapter.handle('/canvas/invoke/api/llm',body())).rejects.toMatchObject({code:'INVALID_OUTPUT',message:'风格描述超过500字符，请重新提取或缩短后保存。'});});
