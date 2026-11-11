// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {URL as FileURL} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import {installPortraitGenerationDisplay,projectPortraitGenerationDisplay} from '../../apps/web/src/service/portrait-generation-display';

const frozen=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
// Exact IMAGE_IMAGE record captured from the production model menu. In
// particular its 1/2/4 counts are real; only the native size fallback is false.
const productionModel=JSON.parse(readFileSync(new FileURL('../fixtures/codex-image-edit-v3.production-model-menu.json',import.meta.url),'utf8'));
const a=frozen.indexOf('function GSt('),b=frozen.indexOf('function khr(',a);
const jsx=(type:any,props:any,...rest:any[])=>({type,props,key:rest[0]}),cloneElement=(element:any,patch:any,...children:any[])=>({...element,props:{...element.props,...patch,...(children.length?{children}:{})}});
const control=runInNewContext(frozen.slice(a,b)+';_te',{d:{useMemo:(fn:Function)=>fn()},c:{jsx,jsxs:jsx},Zy:function NativeSelect(){},Ps:function NativeGenerate(){},_t:{WH_ASPECT_RATIO:'WH_ASPECT_RATIO',WH_RESOLUTION:'WH_RESOLUTION'}});
const model=(patch:any={})=>({...structuredClone(productionModel),...patch});
const props=(patch:any={})=>({currentModel:model(),resolution:'2K',generateNum:1,isGenerating:false,disabled:false,onResolutionChange:vi.fn(),onGenerateNumChange:vi.fn(),onGenerate:vi.fn(),...patch});
let release:(()=>void)|undefined;
afterEach(()=>{release?.();release=undefined;document.body.innerHTML='';vi.restoreAllMocks();});

it('proves four frozen portrait footers invent 2K but preserve the real production 1/2/4 image counts',()=>{
 expect([...frozen.matchAll(/c\.jsx\(_te,/g)].length).toBe(4);
 expect(productionModel.generateNum).toEqual([1,2,4]);expect(productionModel.config.map((field:any)=>field.paramName)).toEqual(['prompt','transparentBackground','imageUrls']);
 const p=props(),native=control(p),[size,count]=native.props.children;
 expect(size.props.value).toBe('2K');expect(size.props.options.map((row:any)=>row.value)).toEqual(['1K','2K']);expect(count.props.options).toEqual([{value:1,label:'1X'},{value:2,label:'2X'},{value:4,label:'4X'}]);
 const original=structuredClone({model:p.currentModel,resolution:p.resolution,generateNum:p.generateNum}),projected=projectPortraitGenerationDisplay(native,p,{cloneElement}),[defaultSize,quantity,generate]=projected.props.children;
 expect(defaultSize.props).toMatchObject({value:'studio-model-default-size',disabled:true,options:[{value:'studio-model-default-size',label:'模型默认尺寸'}]});
 expect(quantity.props.options).toEqual([{value:1,label:'1 张'},{value:2,label:'2 张'},{value:4,label:'4 张'}]);expect(quantity.props.value).toBe(count.props.value);expect(quantity.props.disabled).toBe(count.props.disabled);expect(quantity.props.onChange).toBe(count.props.onChange);expect(quantity.props.buttonTitle).toContain('不是放大倍率');expect(generate).toBe(native.props.children[2]);
 defaultSize.props.onChange('4K');quantity.props.onChange(4);expect(p.onResolutionChange).not.toHaveBeenCalled();expect(p.onGenerateNumChange).toHaveBeenCalledExactlyOnceWith(4);
 generate.props.onClick();expect(p.onGenerate).toHaveBeenCalledOnce();expect({model:p.currentModel,resolution:p.resolution,generateNum:p.generateNum}).toEqual(original);expect(native.props.children[0].props.value).toBe('2K');
});

it.each([
 {available:false},{testMode:true},{kind:'TEXT_TO_IMAGE'},{capabilityRef:'another-editor-v1'},{capabilityVersion:'4'},{model:{providerRef:'comfy'}},{config:[{paramName:'resolution',type:'list'}]},{config:[{paramName:'outputPreset',type:'list'}]},
])('leaves unreviewed or explicitly sized models unchanged: %j',patch=>{
 const p=props({currentModel:model(patch)}),element=control(p);expect(projectPortraitGenerationDisplay(element,p,{cloneElement})).toBe(element);
});

it.each([1,2,4])('retains native count %i in the selector, callback and submitted generation parameters',generateNum=>{
 const p=props({generateNum}),element=control(p),projected=projectPortraitGenerationDisplay(element,p,{cloneElement}),[size,count,action]=projected.props.children;
 expect(size.props.disabled).toBe(true);expect(count.props.value).toBe(generateNum);expect(count.props.onChange).toBe(element.props.children[1].props.onChange);expect(action).toBe(element.props.children[2]);expect(action.props.params.generateNum).toBe(generateNum);expect(action.props.disabled).toBe(element.props.children[2].props.disabled);
 count.props.onChange(generateNum);expect(p.onGenerateNumChange).toHaveBeenCalledExactlyOnceWith(generateNum);action.props.onClick();expect(p.onGenerate).toHaveBeenCalledOnce();
});

it('uses the existing native JSX chain for the exact footer, preserves unrelated controls and restores it on cleanup',()=>{
 const original=vi.fn(jsx),native:any={j:{jsx:original,jsxs:original},r:{cloneElement,useSyncExternalStore:(subscribe:Function,snapshot:Function)=>{subscribe(()=>{});return snapshot();}}},p=props();
 release=installPortraitGenerationDisplay(native);
 const component=native.j.jsx(control,p).type,output=component(p);expect(output.props.children[0].props.disabled).toBe(true);expect(component).not.toBe(control);
 function Other(){}const lookalike=function _te(){return jsx('div',{children:'2K'});};expect(native.j.jsx(lookalike,p).type).toBe(lookalike);expect(native.j.jsx(Other,p).type).toBe(Other);expect(native.j.jsxs(control,p).type).toBe(component);
 release();release=undefined;expect(native.j.jsx).toBe(original);expect(native.j.jsxs).toBe(original);expect(component(p).props.children[0].props.value).toBe('2K');
});

it('does not overwrite a later JSX wrapper on disposal and deactivates its already mounted footer',()=>{
 const original=vi.fn(jsx),native:any={j:{jsx:original,jsxs:original},r:{cloneElement,useSyncExternalStore:(_subscribe:Function,snapshot:Function)=>snapshot()}};release=installPortraitGenerationDisplay(native);
 const p=props(),component=native.j.jsx(control,p).type,later=vi.fn();native.j.jsx=later;release();release=undefined;
 expect(native.j.jsx).toBe(later);expect(component(p).props.children[0].props.value).toBe('2K');
});

it('updates only known text inside all four native portrait dialogs, handles new dialogs, and restores owned text on cleanup',async()=>{
 document.body.innerHTML='<p id="outside">改变选中单张人物的内容，其余不变</p><p id="size">2K</p>';
 const native:any={j:{jsx,jsxs:jsx},r:{cloneElement,useSyncExternalStore:(_s:Function,snapshot:Function)=>snapshot()}};release=installPortraitGenerationDisplay(native);
 for(const name of ['rh-character-emotion-dialog','rh-character-appearance-dialog','rh-character-makeup-dialog','rh-pose-control-panel--modal']){
  const dialog=document.createElement('div');dialog.className=name;dialog.innerHTML='<p>改变选中单张人物的内容，其余不变</p><p>开启后对参考图背景或风格不进行改动</p><p>2K</p>';document.body.append(dialog);
 }
 await vi.waitFor(()=>expect([...document.querySelectorAll('[class]')].every(dialog=>dialog.querySelector('p')?.textContent==='尽量保留未调整部分（生成式编辑）')).toBe(true));
 expect(document.querySelector('#outside')!.textContent).toBe('改变选中单张人物的内容，其余不变');expect(document.querySelector('#size')!.textContent).toBe('2K');
 const changed=document.querySelector('.rh-character-makeup-dialog p')!;changed.textContent='A later native update';
 release();release=undefined;expect(changed.textContent).toBe('A later native update');expect(document.querySelector('.rh-character-emotion-dialog p')!.textContent).toBe('改变选中单张人物的内容，其余不变');
 const newly=document.createElement('div');newly.className='rh-character-emotion-dialog';newly.innerHTML='<p>改变选中单张人物的内容，其余不变</p>';document.body.append(newly);await new Promise<void>(resolve=>window.requestAnimationFrame(()=>resolve()));expect(newly.textContent).toBe('改变选中单张人物的内容，其余不变');
});
