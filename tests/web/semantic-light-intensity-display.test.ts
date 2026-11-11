// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {afterEach,expect,it,vi} from 'vitest';
import {installSemanticLightIntensityDisplay,semanticLightIntensityValue} from '../../apps/web/src/service/semantic-light-intensity-display';

const frozen=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),models=JSON.parse(readFileSync(new FileURL('../fixtures/semantic-light.production-model-menu.json',import.meta.url),'utf8'));
const a=frozen.indexOf('function Hir('),b=frozen.indexOf('function Gir(',a),c=frozen.indexOf('function whr('),e=frozen.indexOf('const Shr=',c);
const jsx=(type:any,props:any)=>({type,props}),native=runInNewContext(frozen.slice(a,b)+frozen.slice(c,e)+';({fields:Hir,format:J1t,row:whr})',{c:{jsx,jsxs:jsx}});
let release:(()=>void)|undefined;const props=new WeakMap<Element,any[]>();
afterEach(()=>{release?.();release=undefined;document.body.innerHTML='';vi.restoreAllMocks();});
const propsOf=(element:any)=>props.get(element)||[];
function dom(tree:any):Node {
 if(tree===null||tree===undefined||tree===false)return document.createTextNode('');
 if(typeof tree==='string'||typeof tree==='number')return document.createTextNode(String(tree));
 const el=document.createElement(tree.type),p=tree.props||{};
 for(const[key,value]of Object.entries(p)){
  if(key==='children'||value===undefined)continue;if(key==='className'){el.className=String(value);continue;}
  if(key==='style'){for(const[name,v]of Object.entries(value as any))el.style.setProperty(name,String(v));continue;}
  if(key==='onChange'){el.addEventListener('change',value as EventListener);continue;}el.setAttribute(key,String(value));
 }
 const children=Array.isArray(p.children)?p.children:[p.children];for(const child of children)el.append(dom(child));return el;
}
function mount(value=75,model=structuredClone(models[0]),cfgPatch:any={}){
 const cfg={...native.fields(model,false).find((row:any)=>row.paramName==='light_intensity'),...cfgPatch},onChange=vi.fn(),field={cfg,value,onChange},tree=native.row(field),row=dom(tree) as HTMLElement,panel=document.createElement('div');panel.className='rh-lighting-panel';panel.append(row);document.body.append(panel);props.set(row,[field,{currentModel:model}]);
 return{model,cfg,field,tree,row,panel,onChange,input:row.querySelector('input')!,display:row.querySelector('.rh-tool-panel__control-value')!,unit:row.querySelector('.rh-tool-panel__control-unit')!};
}

it.each(models)('uses the actual frozen Hir/J1t/whr and production $capabilityRef fixture to correct 750% without changing input or callback',model=>{
 const f=mount(75,structuredClone(model)),before=structuredClone(f.model),input=f.input,handler=f.tree.props.children[1].props.children[0].props.children.props.onChange;
 expect(f.display.textContent).toBe('750%');expect(input.value).toBe('75');expect(f.cfg).toMatchObject({paramName:'light_intensity',min:0,max:100,suffix:'%'});
 release=installSemanticLightIntensityDisplay(propsOf);expect(f.display.textContent).toBe('75 / 100');expect(f.display.getAttribute('title')).toContain('不是物理光学百分比');expect(f.row.querySelector('input')).toBe(input);expect(input.min).toBe('0');expect(input.max).toBe('100');expect(input.step).toBe('1');expect(input.value).toBe('75');
 input.value='76';input.dispatchEvent(new Event('change'));expect(f.onChange).toHaveBeenCalledExactlyOnceWith(76);expect(f.tree.props.children[1].props.children[0].props.children.props.onChange).toBe(handler);expect(f.field.onChange).toBe(f.onChange);expect(f.model).toEqual(before);
 release();release=undefined;expect(f.display.textContent).toBe('750%');expect(f.display.hasAttribute('title')).toBe(false);expect(input.value).toBe('76');
});

it.each([0,50,75,100])('displays the actual %i/100 scale without multiplying the native parameter',value=>{
 const f=mount(value);expect(f.display.textContent).toBe(String(value*10)+'%');release=installSemanticLightIntensityDisplay(propsOf);expect(f.display.textContent).toBe(String(value)+' / 100');expect(f.input.value).toBe(String(value));expect(f.field.value).toBe(value);
});

it.each([
 {capabilityRef:'another-light-model'},{capabilityVersion:'4'},{available:false},{testMode:true},{kind:'TEXT_TO_IMAGE'},{model:{providerRef:'another',modelRef:'codex-image'}},{config:[]},{config:{}},
])('keeps an unreviewed model or schema unchanged: %j',patch=>{
 const baseline=structuredClone(models[0]),f=mount(75);Object.assign(f.model,patch);release=installSemanticLightIntensityDisplay(propsOf);expect(f.display.textContent).toBe('750%');expect(f.input.value).toBe('75');expect(f.onChange).not.toHaveBeenCalled();expect(semanticLightIntensityValue({...baseline,...patch},f.cfg,75)).toBeUndefined();
});

it.each([{min:0,max:10},{min:1,max:100},{paramName:'another_intensity'},{type:'int'}])('leaves other numeric intensity ranges/fields untouched: %j',patch=>{
 const f=mount(75,structuredClone(models[0]),patch),before=f.display.textContent;release=installSemanticLightIntensityDisplay(propsOf);expect(f.display.textContent).toBe(before);
});

it('does not alter percentages outside the lighting panel or another row within it',()=>{
 const f=mount();f.panel.className='another-panel';const other=document.createElement('span');other.textContent='75%';document.body.append(other);release=installSemanticLightIntensityDisplay(propsOf);expect(f.display.textContent).toBe('750%');expect(other.textContent).toBe('75%');
});

it('handles controlled native rerenders and restores an unreviewed model transition without changing its state',async()=>{
 const f=mount();release=installSemanticLightIntensityDisplay(propsOf);f.field.value=50;f.input.value='50';f.display.firstChild!.textContent='500';
 await vi.waitFor(()=>expect(f.display.textContent).toBe('50 / 100'));expect(f.input.value).toBe('50');f.model.capabilityRef='another-editor';f.row.classList.add('native-model-change');
 await vi.waitFor(()=>expect(f.display.textContent).toBe('500%'));expect(f.display.hasAttribute('title')).toBe(false);expect(f.onChange).not.toHaveBeenCalled();
});

it('adapts newly mounted rows and restores only owned text on cleanup, without an observer write loop',async()=>{
 release=installSemanticLightIntensityDisplay(propsOf);const f=mount(),writes=vi.spyOn(f.display,'setAttribute');await vi.waitFor(()=>expect(f.display.textContent).toBe('75 / 100'));
 await new Promise<void>(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>resolve())));expect(writes).toHaveBeenCalledTimes(1);
 f.display.firstChild!.textContent='External later text';release();release=undefined;expect(f.display.textContent).toBe('External later text%');expect(f.onChange).not.toHaveBeenCalled();
});
