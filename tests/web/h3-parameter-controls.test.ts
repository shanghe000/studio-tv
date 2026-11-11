// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {URL as FileURL} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import {createH3ParameterControls} from '../../apps/web/src/service/h3-parameter-controls';
import {h3ParameterVersions,h3UpgradeValue,h3VersionPresets} from '../../apps/web/src/service/h3-parameter-contracts';
import {installNativeOutputPresetLayout} from '../../apps/web/src/service/output-preset-layout';

const jsx=(type:any,props:any,key?:any)=>({type,key:key??null,props});
const react={Fragment:Symbol('fragment'),createElement:(type:any,props:any,...children:any[])=>jsx(type,{...props,...(children.length?{children:children.length===1?children[0]:children}:{})},props?.key),cloneElement:(element:any,props:any)=>({...element,props:{...element.props,...props}}),useSyncExternalStore:(_subscribe:any,snapshot:any)=>snapshot()};
function field(ref='h3-first-last-frame-v1',version=h3ParameterVersions[ref]){
 const presets=structuredClone(h3VersionPresets(ref,version)!);
 const upgraded=version===h3ParameterVersions[ref]?[]:h3VersionPresets(ref,h3ParameterVersions[ref])!.map(preset=>({...preset,value:h3UpgradeValue(ref,preset.value)}));
 return{paramName:'outputPreset',type:'list',title:'输出规格',paramValue:presets[0].value,studioH3ParameterMetadata:{capabilityRef:ref,version,presets},optionValue:[...presets,...upgraded].map(preset=>({value:preset.value,labelCn:preset.title}))};
}
function descendants(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(descendants):tree&&typeof tree==='object'?[tree,...descendants(tree.props?.children)]:[];}
function render(f:any,value=f.paramValue,onChange=vi.fn()){
 const Component=createH3ParameterControls(react);return{tree:Component({field:f,value,onChange}),onChange};
}
const button=(tree:any,key:string,value:string)=>descendants(tree).find(node=>node.type==='button'&&node.props[key]===value);
const slider=(tree:any)=>descendants(tree).find(node=>node.type==='input'&&node.props.type==='range');
it('offers every exact second for video reference, preserves dimensions and rejects unadvertised input',()=>{
 const f=field('h3-video-reference-v1'),{tree,onChange}=render(f,'portrait-768p-12s');
 const picker=descendants(tree).find(node=>node.type==='select'&&node.props.className==='studio-h3-duration-select');
 expect(descendants(picker).filter(node=>node.type==='option').map(node=>node.props.value)).toEqual([5,6,7,8,9,10,11,12,13,14,15]);
 expect(picker.props.value).toBe(12);
 picker.props.onChange({currentTarget:{value:'13'}});expect(onChange).toHaveBeenLastCalledWith('outputPreset','portrait-768p-13s');
 picker.props.onChange({currentTarget:{value:'12.5'}});picker.props.onChange({currentTarget:{value:'30'}});expect(onChange).toHaveBeenCalledTimes(1);
 button(tree,'data-h3-resolution','1080p').props.onClick();expect(onChange).toHaveBeenLastCalledWith('outputPreset','portrait-1080p-12s');
 const stops=descendants(tree).find(node=>node.props?.className==='studio-h3-duration-stops');
 expect(descendants(stops).filter(node=>node.type==='span')).toHaveLength(3);
});
let release:(()=>void)|undefined;
afterEach(()=>{release?.();release=undefined;document.head.innerHTML='';vi.restoreAllMocks();});

it('renders the six aspect buttons and actual resolution tiers, and submits only one advertised preset per edit',()=>{
 const f=field(),{tree,onChange}=render(f,'landscape-768p-10s'),nodes=descendants(tree);
 expect(nodes.filter(node=>node.props?.['data-h3-ratio']).map(node=>node.props['data-h3-ratio'])).toEqual(['ultrawide','landscape','standard','square','standard-portrait','portrait']);
 expect(nodes.filter(node=>node.props?.['data-h3-resolution']).map(node=>node.props['data-h3-resolution'])).toEqual(['480p','768p','1080p','2k']);
 button(tree,'data-h3-ratio','portrait').props.onClick();expect(onChange).toHaveBeenLastCalledWith('outputPreset','portrait-768p-10s');
 button(tree,'data-h3-resolution','2k').props.onClick();expect(onChange).toHaveBeenLastCalledWith('outputPreset','landscape-2k-10s');
 slider(tree).props.onChange({currentTarget:{value:'2'}});expect(onChange).toHaveBeenLastCalledWith('outputPreset','landscape-768p-15s');
 expect(onChange).toHaveBeenCalledTimes(3);expect(onChange.mock.calls.every(([,value])=>f.optionValue.some(option=>option.value===value))).toBe(true);
 expect(slider(tree).props).toMatchObject({min:0,max:2,step:1,value:1,'aria-valuetext':'10 秒'});
 slider(tree).props.onChange({currentTarget:{value:'1.5'}});slider(tree).props.onChange({currentTarget:{value:'30'}});expect(onChange).toHaveBeenCalledTimes(3);
 const stopPropagation=vi.fn();tree.props.onKeyDown({key:'ArrowLeft',stopPropagation});tree.props.onKeyDown({key:'Escape',stopPropagation});expect(stopPropagation).toHaveBeenCalledOnce();
});

it('keeps fixed durations visible and disabled, and includes the exact 1080P aligned pixels',()=>{
 const {tree,onChange}=render(field('h3-tr-pika-twopass-ref-v1'),'landscape-1080p-8s');
 expect(slider(tree).props.disabled).toBe(true);expect(descendants(tree).some(node=>node.type==='output'&&node.props.children==='固定8秒')).toBe(true);
 expect(descendants(tree).find(node=>node.props?.className==='studio-h3-output-summary').props.children).toContain('32像素对齐');
 slider(tree).props.onChange({currentTarget:{value:'1'}});expect(onChange).not.toHaveBeenCalled();
});

it('preserves old preset values until an explicit edit emits an existing upgrade alias',()=>{
 const f=field('h3-first-last-frame-v1','2'),before=structuredClone(f),{tree,onChange}=render(f,'480p-landscape-5s');
 expect(onChange).not.toHaveBeenCalled();expect(f).toEqual(before);
 button(tree,'data-h3-ratio','portrait').props.onClick();expect(onChange).toHaveBeenCalledExactlyOnceWith('outputPreset',h3UpgradeValue('h3-first-last-frame-v1','portrait-480p-5s'));
});

it('retains exceptional original sizes as real options and respects disabled controls',()=>{
 const f=field('h3-tr-pika-twopass-ref-v1'),{tree,onChange}=render(f,'landscape-480p-8s'),select=descendants(tree).find(node=>node.type==='select');
 expect(select.props.children.some((option:any)=>option.props.value==='landscape-1920x1088-8s')).toBe(true);
 select.props.onChange({currentTarget:{value:'landscape-1920x1088-8s'}});expect(onChange).toHaveBeenCalledExactlyOnceWith('outputPreset','landscape-1920x1088-8s');
 const Component=createH3ParameterControls(react),blocked=Component({field:f,value:f.paramValue,onChange,disabled:true});
 button(blocked,'data-h3-ratio','portrait').props.onClick();expect(onChange).toHaveBeenCalledOnce();expect(button(blocked,'data-h3-ratio','portrait').props.disabled).toBe(true);
});

function nativeFixture(){
 const source=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=source.indexOf('function Af('),end=source.indexOf('}function j9n(',start)+1;
 const runtime:any={j:{jsx,jsxs:jsx,Fragment:react.Fragment},r:react},effect=vi.fn();
 const Af=runInNewContext(source.slice(start,end)+';Af',{c:runtime.j,d:{useEffect:effect},Q1:()=>null,fft:(fields:any)=>fields,zje:(item:any)=>item.title,Gje:()=>'',R9n:()=>false,_t:{ASPECT_RATIO:'aspectRatio'},Tx:(item:any)=>item.optionValue.map((option:any)=>({value:option.value,label:option.labelCn})),ai:function NativeHeading(){},dp:function NativeOptions(){}});
 return{runtime,Af,effect};
}

it('replaces only the real Af outputPreset block shared by native parameter surfaces and preserves other field events',()=>{
 const {runtime,Af,effect}=nativeFixture(),f=field(),onChange=vi.fn(),other={paramName:'quality',type:'list',title:'Other',optionValue:[{value:'original',labelCn:'Other'}]},props={modelConfig:[other,f],params:{outputPreset:f.paramValue,quality:'original'},onChange};
 release=installNativeOutputPresetLayout(runtime);
 const component=runtime.j.jsx(Af,props).type,fragment=component(props),[quality,output]=fragment.props.children;
 expect(component).not.toBe(Af);expect(effect).toHaveBeenCalledOnce();expect(quality.key).toBe('quality');expect(output.key).toBe('outputPreset');expect(output.type.name).toBe('H3ParameterControls');
 quality.props.children[1].props.onChange('original');expect(onChange).toHaveBeenCalledExactlyOnceWith('quality','original');
 const controls=output.type(output.props);button(controls,'data-h3-ratio','portrait').props.onClick();expect(onChange).toHaveBeenLastCalledWith('outputPreset','portrait-480p-5s');
 expect(document.querySelector('#studio-output-preset-layout')?.textContent).toContain('.studio-h3-ratios');
});

it('leaves untagged image/other fields and lookalike components native and restores owned hooks on cleanup',()=>{
 const {runtime,Af}=nativeFixture(),original=runtime.j.jsx,f=field(),props={modelConfig:[f],params:{outputPreset:f.paramValue},onChange:vi.fn()};
 release=installNativeOutputPresetLayout(runtime);
 const untagged={...f,studioH3ParameterMetadata:undefined};expect(runtime.j.jsx(Af,{...props,modelConfig:[untagged]}).type).toBe(Af);
 const lookalike=function Af(){return null;};expect(runtime.j.jsx(lookalike,props).type).toBe(lookalike);
 const component=runtime.j.jsxs(Af,props).type,oldControls=component(props).props.children[0],oldTree=oldControls.type(oldControls.props);
 release();release=undefined;expect(runtime.j.jsx).toBe(original);expect(runtime.j.jsxs).toBe(original);expect(document.querySelector('#studio-output-preset-layout')).toBeNull();
 expect(component(props).props.children[0].type.name).not.toBe('H3ParameterControls');button(oldTree,'data-h3-ratio','portrait').props.onClick();expect(props.onChange).not.toHaveBeenCalled();
});

it('does not overwrite a JSX wrapper installed after this adapter',()=>{
 const {runtime}=nativeFixture();release=installNativeOutputPresetLayout(runtime);const later=vi.fn();runtime.j.jsx=later;
 release();release=undefined;expect(runtime.j.jsx).toBe(later);
});

it('shows source-video duration without a zero-second slider and keeps only advertised dimensions selectable',()=>{
 const presets=[{value:'landscape-480p-source',resolution:'480p',aspectRatio:'16:9',width:864,height:480,durationSeconds:0,fps:24},{value:'portrait-480p-source',resolution:'480p',aspectRatio:'9:16',width:480,height:864,durationSeconds:0,fps:24}];
 const f={paramName:'outputPreset',paramValue:presets[0].value,optionValue:presets.map(row=>({value:row.value})),studioVideoParameterMetadata:{schemaVersion:'1',capabilityRef:'h3-motion-transfer-v1',version:'2',mode:'MOTION_TRANSFER',durationPolicy:'SOURCE_VIDEO',sourceSecondsMin:2,sourceSecondsMax:30,presets}};
 const {tree,onChange}=render(f),nodes=descendants(tree);
 expect(slider(tree)).toBeUndefined();expect(nodes.find(node=>node.type==='output')?.props.children).toBe('跟随动作视频');
 expect(nodes.find(node=>node.props?.['data-studio-source-duration']!==undefined)?.props.children).toContain('2–30 秒');
 expect(nodes.find(node=>node.props?.className==='studio-h3-output-summary')?.props.children).not.toContain('0秒');
 button(tree,'data-h3-ratio','9:16').props.onClick();expect(onChange).toHaveBeenCalledExactlyOnceWith('outputPreset','portrait-480p-source');
 const Component=createH3ParameterControls(react);
 expect(Component({field:{...f,studioVideoParameterMetadata:{...f.studioVideoParameterMetadata,durationPolicy:undefined}},value:f.paramValue,onChange})).toBeNull();
 expect(Component({field:{...f,studioVideoParameterMetadata:{...f.studioVideoParameterMetadata,mode:'TEXT_TO_VIDEO'}},value:f.paramValue,onChange})).toBeNull();
});
