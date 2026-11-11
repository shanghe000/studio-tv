// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {SketchModelSelections,installSketchboardModels,sketchModel,sketchModelOptions} from '../../apps/web/src/service/sketchboard-models';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import type {Capability} from '../../apps/web/src/service/model-catalog';

const image=(ref:string,kind='TEXT_TO_IMAGE'):Capability=>({capabilityRef:ref,version:'1',kind,available:true,testMode:false,executionKind:'MODEL',title:ref,model:{providerRef:'comfy',modelRef:ref,title:ref,version:'1'},inputKinds:kind==='TEXT_TO_IMAGE'?['TEXT','STRUCTURED']:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],parameterSchemaVersion:'1',parameterSchema:{type:'object',additionalProperties:false,properties:{outputPreset:{type:'string',enum:['1024-square'],default:'1024-square'},count:{type:'integer',enum:[1,2,4,8],default:1}},'x-output-presets':[{value:'1024-square',width:1024,height:1024,aspectRatio:'1:1'}]}});
const edit=image('qwen-image-edit-2511-v1','IMAGE_TO_IMAGE'),codexEdit={...image('codex-image-edit-v1','IMAGE_TO_IMAGE'),executionKind:'AGENT'},zimage=image('z-image-turbo-generate-v1'),klein=image('flux2-klein4b-generate-v1');
const models=[image('codex-image-generate-v1'),image('flux1-dev-generate-v1'),image('flux2-klein-generate-v1'),zimage,klein,codexEdit,edit];
const response=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{ETag:'"2"'}});
function execution(caps=models){
 const transport=vi.fn((path:string)=>Promise.resolve(path.includes('model-capabilities')?response({items:caps,nextCursor:null}):path==='/api/v1/assets/sketch'?response({byteSize:2048,mimeType:'image/png',id:'sketch',state:'READY',kind:'IMAGE'}):path.includes('generation-diagnostics')?response({logId:'sketch-test-log'}):response({id:'task',state:'SUCCEEDED',testMode:false,plans:[]},202))),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,vi.fn(),vi.fn(),{allowTestMode:false}),upload=vi.spyOn(storage,'upload').mockResolvedValue('rhtv-asset:sketch');
 return{adapter,storage,upload,transport,data:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1]!.body as string).graph.nodes[0].data};
}
const body={canvasId:'p',image:'data:image/png;base64,AA==',prompt:'一只红图形站在雪地里',styleCode:'watercolor',generationMode:'manual'};
afterEach(()=>{document.body.innerHTML='';window.history.replaceState({},'','/');});

it('offers actual image editors in realtime and text generation only in manual mode, excluding enhancement and invalid capabilities',()=>{
 const bad=[image('seedvr','IMAGE_ENHANCE'),{...zimage,capabilityRef:'offline',available:false},{...zimage,capabilityRef:'test',testMode:true},{...zimage,capabilityRef:'text-output',outputKinds:['TEXT']},{...edit,capabilityRef:'no-image-input',inputKinds:['TEXT']},{...zimage,capabilityRef:'unconfigured',model:undefined}];
 expect(sketchModelOptions([...models,...bad],'live').map(cap=>cap.capabilityRef)).toEqual([codexEdit.capabilityRef,edit.capabilityRef]);
 expect(new Set(sketchModelOptions([...models,...bad],'manual').map(cap=>cap.capabilityRef))).toEqual(new Set(models.map(cap=>cap.capabilityRef)));
});

it('keeps independent choices for each project and generation mode, defaults to Qwen and rejects stale or unavailable explicit choices',()=>{
 const choices=new SketchModelSelections();expect(sketchModel(models,'p','manual',choices)).toBe(edit);
 choices.set('p','manual',{capabilityRef:zimage.capabilityRef,capabilityVersion:'1'});expect(sketchModel(models,'p','manual',choices)).toBe(zimage);expect(sketchModel(models,'p','live',choices)).toBe(edit);expect(sketchModel(models,'other','manual',choices)).toBe(edit);
 expect(()=>sketchModel(models,'p','manual',choices,{capabilityRef:zimage.capabilityRef,capabilityVersion:'old'})).toThrow('模型版本');
 expect(()=>sketchModel(models.filter(cap=>cap!==zimage),'p','manual',choices)).toThrow('已不可用');choices.clear();expect(sketchModel(models,'p','manual',choices)).toBe(edit);
});

it.each([zimage,klein])('submits $capabilityRef from manual 2D as single-image text generation with style and without uploading or binding a drawing',async cap=>{
 const {adapter,upload,data}=execution();adapter.sketchModels.set('p','manual',{capabilityRef:cap.capabilityRef,capabilityVersion:'1'});
 await adapter.handle('/canvas/sketchboard/realtime/generate',{...body,image:'ignored, not a PNG'});
 expect(upload).not.toHaveBeenCalled();expect(data()).toMatchObject({capabilityRef:cap.capabilityRef,capabilityVersion:'1',subType:'TEXT_TO_IMAGE',generateNum:1,params:{prompt:body.prompt},routerParameters:{outputPreset:'1024-square',count:1},promptSelection:{schemaVersion:'1',conditions:{stylePrompt:'Watercolor washes, soft pigment edges and subtle paper texture.',generationMode:'manual'}}});
 expect(data().params).not.toHaveProperty('imageUrls');expect(data().promptSelection).not.toHaveProperty('referenceBindings');expect(data().promptSelection).not.toHaveProperty('featureCode');expect(data().promptSelection.conditions).not.toHaveProperty('sourceMode');expect(adapter.sketchProgress.value).toMatchObject({phase:'running',taskId:'task'});
});

it.each(['live','manual'])('preserves typed SKETCH conditioning and explicit editor selection in %s mode',async mode=>{
 const {adapter,upload,data}=execution();await adapter.handle('/canvas/sketchboard/realtime/generate',{...body,prompt:'',generationMode:mode,capabilityRef:codexEdit.capabilityRef,capabilityVersion:'1'});
 expect(upload).toHaveBeenCalledOnce();expect(data()).toMatchObject({capabilityRef:codexEdit.capabilityRef,subType:'IMAGE_TO_IMAGE',params:{imageUrls:['rhtv-asset:sketch']},promptSelection:{featureCode:'sketchboard.generate',conditions:{styleCode:'watercolor',generationMode:mode},referenceBindings:[{assetId:'sketch',role:'SKETCH'}]}});expect(data().params.prompt).toContain('保留主体');
});

it.each([
 {generationMode:'live',prompt:'fox',capabilityRef:zimage.capabilityRef,error:'SKETCH_TEXT_REQUIRES_MANUAL'},
 {generationMode:'manual',prompt:'   ',capabilityRef:zimage.capabilityRef,error:'SKETCH_PROMPT_REQUIRED'},
 {generationMode:'manual',prompt:'fox',capabilityRef:'missing',error:'MODEL_UNAVAILABLE'},
 {generationMode:'manual',prompt:'fox',capabilityRef:zimage.capabilityRef,capabilityVersion:'old',error:'MODEL_VERSION_CHANGED'},
])('rejects $error before uploading or creating a task',async ({error,...params})=>{
 const {adapter,upload,transport}=execution();await expect(adapter.handle('/canvas/sketchboard/realtime/generate',{...body,...params})).rejects.toMatchObject({code:error});expect(upload).not.toHaveBeenCalled();expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);expect(adapter.sketchProgress.value?.phase).toBe('failed');adapter.clear();expect(adapter.sketchModels.get('p','manual')).toBeUndefined();
});

function board(mode='live'){
 document.body.innerHTML=`<div class="sketch-studio"><div class="sketch-studio__preview-topbar"><div class="sketch-studio__generation-mode is-${mode}"><button class="sketch-studio__generation-mode-option is-active" aria-checked="true"></button></div></div><span class="studio-sketch-hint"></span></div>`;
 return document.querySelector('.sketch-studio__generation-mode')!;
}
it('renders grouped real model choices without replacing native actions, restores manual selection and keeps text models out of realtime redraws',async()=>{
 const mode=board(),selections=new SketchModelSelections(),native=document.querySelector('.sketch-studio__generation-mode-option'),release=installSketchboardModels({catalog:async()=>models,selections},()=>'p');
 try{
  await vi.waitFor(()=>expect(document.querySelectorAll('.studio-sketch-models option')).toHaveLength(2));const select=document.querySelector<HTMLSelectElement>('.studio-sketch-models select')!;expect(select.value).toBe(edit.capabilityRef);expect(document.querySelector('.sketch-studio__generation-mode-option')).toBe(native);
  mode.className='sketch-studio__generation-mode is-manual';await vi.waitFor(()=>expect(select.options).toHaveLength(7));expect(Array.from(select.querySelectorAll('optgroup')).map(group=>group.label)).toEqual(['参考草图','文字创作（仅手动）']);select.value=zimage.capabilityRef;select.dispatchEvent(new Event('change'));
  expect(document.querySelector('.studio-sketch-model-hint')?.textContent).toContain('画笔不作为约束');expect(document.querySelector('.studio-sketch-model-hint')?.textContent).toContain('单张输出 · 1024×1024');expect(document.querySelector('.studio-sketch-hint')?.textContent).toContain('手动提交');
  mode.className='sketch-studio__generation-mode is-live';await vi.waitFor(()=>expect(select.options).toHaveLength(2));expect(select.value).toBe(edit.capabilityRef);
  mode.className='sketch-studio__generation-mode is-manual';await vi.waitFor(()=>expect(select.value).toBe(zimage.capabilityRef));
 }finally{release();}expect(document.querySelector('.studio-sketch-models')).toBeNull();expect(document.querySelector('.sketch-studio__generation-mode-option')).toBe(native);
});

it('retains an unavailable selection as an explicit error and lets the user choose a current model without a silent fallback',async()=>{
 board('manual');const selections=new SketchModelSelections();selections.set('p','manual',{capabilityRef:'removed',capabilityVersion:'1'});const release=installSketchboardModels({catalog:async()=>models,selections},()=>'p');
 try{await vi.waitFor(()=>expect(document.querySelector('.studio-sketch-model-error')?.textContent).toContain('已不可用'));const select=document.querySelector<HTMLSelectElement>('select')!;expect(select.value).toBe('removed');expect(select.disabled).toBe(false);select.value=klein.capabilityRef;select.dispatchEvent(new Event('change'));expect(select.value).toBe(klein.capabilityRef);expect(document.querySelector('.studio-sketch-model-error')).toBeNull();}finally{release();}
});

it('uses the nested route scope over a stale canvas manager and disables model editing on a read-only project',async()=>{
 board('manual');let resolve!:(caps:Capability[])=>void;const promise=new Promise<Capability[]>(yes=>resolve=yes),selections=new SketchModelSelections(),canRun=vi.fn(()=>false),release=installSketchboardModels({catalog:()=>promise,selections,canRun},()=>'stale-manager');
 try{window.history.replaceState({},'','/project/canvas/p/sketchboard');document.querySelector('.sketch-studio')!.classList.add('ready');await vi.waitFor(()=>expect(document.querySelector('.studio-sketch-model-hint')?.textContent).toContain('读取'));
  resolve(models);await vi.waitFor(()=>expect(document.querySelectorAll('option')).toHaveLength(7));expect(document.querySelector('select')?.disabled).toBe(true);expect(canRun).toHaveBeenCalledWith('p');expect(selections.get('p','manual')?.capabilityRef).toBe(edit.capabilityRef);expect(selections.get('stale-manager','manual')).toBeUndefined();document.body.innerHTML='';await vi.waitFor(()=>expect(document.querySelector('.studio-sketch-models')).toBeNull());
 }finally{release();}
});

it('ignores a late catalog after leaving the 2D editor',async()=>{
 board('manual');let resolve!:(caps:Capability[])=>void;const promise=new Promise<Capability[]>(yes=>resolve=yes),selections=new SketchModelSelections(),release=installSketchboardModels({catalog:()=>promise,selections},()=>'p');
 try{document.body.innerHTML='<div>其他页面</div>';await new Promise(resolve=>setTimeout(resolve,0));resolve(models);await new Promise(resolve=>setTimeout(resolve,0));expect(document.querySelector('.studio-sketch-models')).toBeNull();expect(selections.get('p','manual')).toBeUndefined();}finally{release();}
});
