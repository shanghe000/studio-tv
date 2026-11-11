// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import h3Catalog from './fixtures/router-h3-capabilities.json';
import motionCatalog from './fixtures/router-motion-capabilities.json';
import officialCatalog from './fixtures/router-official-video-capabilities.json';
import {videoInputGuidance,videoInputHint,installCanvasVideoInputGuidance} from '../../apps/web/src/service/video-input-guidance';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {createH3ParameterControls} from '../../apps/web/src/service/h3-parameter-controls';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

// The H3 fixture is an actual signed Router GET catalog. CI18's producer check
// confirmed all eight versions and 387 tuples remain unchanged. It intentionally
// lacks the new generic video metadata: this is the legacy UI regression.
const h3=(h3Catalog as any[]).map(cap=>({...cap,testMode:false}));
const motion=(motionCatalog as any[]).map(cap=>({...cap,testMode:false}));
const react={createElement:(type:any,props:any,...children:any[])=>({type,props:{...props,children}})};
const descendants=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(descendants):tree&&typeof tree==='object'?[tree,...descendants(tree.props?.children)]:[];
let dispose:(()=>void)|undefined;
afterEach(()=>{dispose?.();dispose=undefined;document.body.innerHTML='';});

it.each(h3)('shows real $capabilityRef materials without changing its frozen preset contract',cap=>{
 const before=structuredClone(cap),model=capabilityModel(cap),guide=videoInputGuidance(cap)!,field=model.config.find(row=>row.paramName==='outputPreset')!;
 expect(guide).toBeDefined();expect(guide.connection).toContain('左侧输入端');expect(guide.connection).toContain('上游');
 expect(guide.materials.find(row=>row.kind==='IMAGE')!.maximum).toBe(cap.parameterSchema['x-input-constraints'].max_images);
 expect(field.studioH3ParameterMetadata!.presets).toEqual(cap.parameterSchema['x-output-presets']);
 const tree=createH3ParameterControls(react)({field,value:field.paramValue,onChange:vi.fn()}),nodes=descendants(tree);
 expect(nodes.some(row=>row.props?.['data-studio-video-material-help']==='')).toBe(true);
 expect(nodes.flatMap(row=>row.props?.children??[]).join(' ')).toContain('生成所需素材');
 expect(videoInputHint(cap)).not.toContain('GPU');expect(videoInputHint(cap)).not.toContain('用户明确授权');expect(cap).toEqual(before);
});

it('keeps single and multi-person requirements, source video duration and automatic masks findable',()=>{
 for(const cap of motion){
  const guide=videoInputGuidance(cap)!,model=capabilityModel(cap);
  expect(guide.summary).toContain('1 张人物参考图');expect(guide.materials.map(row=>row.minimum)).toEqual([1,1]);
  expect(guide.materials.find(row=>row.kind==='VIDEO')!.description).toContain('5.2至15秒');
  if(cap.parameterSchema['x-subject-control'].mode==='MULTI'){expect(guide.subject).toContain('从 0 开始编号');expect(guide.subject).toContain('遮罩自动生成');}
  else expect(guide.subject).toContain('单人');
  expect(Boolean(model.config.find(row=>row.paramName==='prompt'))).toBe(!guide.promptIgnored);
 }
 expect(videoInputGuidance({...motion[0],testMode:true})).toBeUndefined();
 expect(videoInputGuidance(undefined)).toBeUndefined();
});

it.each(h3)('rejects missing materials before a native $capabilityRef canvas POST',async cap=>{
 const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200}),transport=vi.fn((path:string)=>Promise.resolve(json({items:[cap],nextCursor:null}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn(),{allowTestMode:false}),mode=cap.parameterSchema['x-video-mode'];
 const node={id:'video',type:'rh-video',data:{modelCode:cap.capabilityRef,subType:mode==='FIRST_FRAME'?'start-video':mode==='FIRST_LAST_FRAME'?'start-end-video':'multimodal-video',params:{prompt:'bounded protocol check'}}};
 await expect(adapter.run({projectId:'p',targetId:'video',graph:{nodes:[node],edges:[]}})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED',message:expect.stringContaining('上游')});
 expect(transport.mock.calls.some(([path])=>path.includes('/canvas-runs'))).toBe(false);adapter.clear();
});

function canvasFixture(cap:any){
 const node={id:'video',type:'rh-video',data:{modelCode:cap.capabilityRef,params:{}}},graph:any={nodes:[node],edges:[]};
 document.body.innerHTML='<div class="react-flow__node" data-id="video"><div class="rh-video-node"><div class="rh-video-empty-actions is-actions-hidden"><span class="rh-video-empty-actions__icon"></span></div></div></div><span id="mutation"></span>';
 const runtime:any={auth:{user:{id:'actor'}},inspect:()=>({id:'project'}),execution:{catalog:vi.fn(async()=>[cap])},storage:{encodeAsset:(value:string)=>value==='blob:reference'?'rhtv-asset:reference':value}},native={bt:()=>({getRemoteData:()=>graph})};
 dispose=installCanvasVideoInputGuidance(runtime,native,()=>[]);return{graph,runtime,host:document.querySelector('.rh-video-empty-actions')!};
}
const painted=()=>new Promise(resolve=>setTimeout(resolve,0));
const mutate=()=>{document.querySelector('#mutation')!.textContent=String(Math.random());};

it('shows model-specific missing inputs and live upstream counts, preserving graph and cleanup',async()=>{
 const {graph,runtime,host}=canvasFixture(motion[1]);await painted();
 expect(host.textContent).toContain('人物参考图和 1 段动作源视频');expect(host.textContent).toContain('还需添加：人物参考图、动作源视频');
 graph.nodes.push({id:'image',type:'rh-image',data:{sourceObjects:['blob:reference']}});graph.edges.push({source:'image',target:'video'});mutate();await painted();expect(host.textContent).toContain('还需添加：动作源视频');
 graph.nodes.push({id:'source',type:'rh-video',data:{sourceObjects:['rhtv-asset:source']}});graph.edges.push({source:'source',target:'video'});const before=structuredClone(graph);mutate();await painted();
 expect(host.textContent).toContain('已连接：1 张图片 · 1 段视频');expect(graph).toEqual(before);
 runtime.auth.user=null;mutate();await painted();expect(document.querySelector('.studio-video-input-guide')).toBeNull();expect(host.classList.contains('studio-video-guidance-host')).toBe(false);
 dispose!();dispose=undefined;expect(document.querySelector('#studio-video-input-guidance')).toBeNull();
});

it('explains the unavailable initial text mode without selecting a model or hiding the chooser',async()=>{
 const cap={...(officialCatalog as any[])[0],testMode:false},fixture=canvasFixture(cap),before=structuredClone(fixture.graph);await painted();
 expect(fixture.host.textContent).toContain('当前视频型号暂不可用');expect(fixture.host.textContent).toContain('选择已开放的型号');expect(fixture.host.textContent).not.toContain('先连接素材');expect(fixture.graph).toEqual(before);
});
it('does not borrow the latest version requirements or declare an unresolved historical version unavailable',async()=>{
 const {graph,host}=canvasFixture(motion[1]);graph.nodes[0].data.capabilityVersion='historical-version';await painted();
 expect(host.textContent).toContain('已选视频型号');expect(host.textContent).not.toContain('人物参考图和 1 段动作源视频');expect(host.textContent).not.toContain('型号暂不可用');
});
it('does not invite reference uploads for a text-only video model',async()=>{
 const cap={...(officialCatalog as any[]).find(cap=>cap.parameterSchema['x-video-mode']==='TEXT_TO_VIDEO'),available:true,testMode:false},fixture=canvasFixture(cap);await painted();
 expect(fixture.host.textContent).toContain('无需参考素材');expect(fixture.host.textContent).not.toContain('添加已上传素材');expect(fixture.host.querySelector('.studio-video-input-guide__status')).toBeNull();
});

it('keeps an uploading reference informational instead of throwing or claiming it is ready',async()=>{
 const {graph,host}=canvasFixture(motion[1]);graph.nodes.push({id:'image',type:'rh-image',data:{sourceObjects:['blob:uploading']}});graph.edges.push({source:'image',target:'video'});await painted();
 expect(host.textContent).toContain('参考素材尚未就绪');expect(host.textContent).not.toContain('已连接：');
});

it('puts the H3 source-duration material and prompt policy in the visible composer without changing the graph',async()=>{
 const original=structuredClone((await import('./fixtures/router-motion-source-capabilities.json')).default[0]) as any,cap={...original,testMode:false};
 cap.parameterSchema['x-input-media-constraints']={schemaVersion:'1',kinds:{IMAGE:{maxBytes:10485760},VIDEO:{maxBytes:67108864,maxDurationMs:30000}}};
 const model=capabilityModel(cap);
 const graph:any={nodes:[{id:'motion',type:'rh-video',data:{modelCode:cap.capabilityRef,params:{outputPreset:'landscape-480p-source'}}}],edges:[]};
 document.body.innerHTML='<div class="rh-canvas-video-params" data-target-node-id="motion"><div class="config-panel-wrap__basic"><div class="video-input-wrap"></div><button class="generate-action-button">生成</button></div></div><span id="mutation"></span>';
 const runtime:any={auth:{user:{id:'actor'}},inspect:()=>({id:'project'}),execution:{catalog:vi.fn(async()=>[cap])},storage:{encodeAsset:(value:string)=>value}},native={bt:()=>({getRemoteData:()=>graph})};
 dispose=installCanvasVideoInputGuidance(runtime,native,()=>[{currentModel:model}]);await painted();
 const note=document.querySelector('.studio-motion-source-hint')!;expect(note.textContent).toContain('2–30 秒动作视频');expect(note.textContent).toContain('≤10 MiB');expect(note.textContent).toContain('无需填写提示词或上传遮罩');expect(note.textContent).toContain('还需添加：人物参考图、动作源视频');
 expect(document.querySelector('.config-panel-wrap__basic')?.firstElementChild).toBe(note);
 graph.nodes.push({id:'image',type:'rh-image',data:{sourceObjects:['rhtv-asset:reference']}});graph.edges.push({source:'image',target:'motion'});graph.nodes.push({id:'video',type:'rh-video',data:{sourceObjects:['rhtv-asset:source']}});graph.edges.push({source:'video',target:'motion'});const before=structuredClone(graph);mutate();await painted();
 expect(note.textContent).toContain('已连接人物图和动作视频');expect(graph).toEqual(before);
 model.capabilityVersion='1';mutate();await painted();expect(document.querySelector('.studio-motion-source-hint')).toBeNull();
 model.capabilityVersion='2';mutate();await painted();expect(document.querySelector('.studio-motion-source-hint')).not.toBeNull();runtime.auth.user=null;mutate();await painted();expect(document.querySelector('.studio-motion-source-hint')).toBeNull();
});
