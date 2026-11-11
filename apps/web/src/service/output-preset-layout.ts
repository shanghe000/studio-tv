import {createH3ParameterControls,h3ParameterControlStyles,hasH3ParameterControls} from './h3-parameter-controls';
import {createVideoSubjectControls,hasVideoSubjectControls,videoSubjectControlStyles} from './video-subject-controls';

const marker='data-studio-output-preset';
const nativeFields=new WeakMap<Function,boolean>();

function exactParameterFields(type:any){
 if(typeof type!=='function'||type.name!=='Af')return false;
 let known=nativeFields.get(type);if(known===undefined){const source=Function.prototype.toString.call(type);known=source.includes('compactRatioHeading')&&source.includes('onAspectRatioChange')&&source.includes('video-params-block');nativeFields.set(type,known);}return known;
}

// Af keys each native parameter block by its real paramName. Annotate only
// outputPreset; the style also requires an image/video popover, including when
// that popover is portalled to document.body.
export function installNativeOutputPresetLayout(native:any,root:Document=document){
 const jsx=native.j,react=native.r;
 if(typeof jsx?.jsx!=='function'||typeof jsx?.jsxs!=='function')return()=>{};
 let active=true;const listeners=new Set<()=>void>(),wrappers=new WeakMap<Function,Function>();
 const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot=()=>active;
 const controls=typeof react?.createElement==='function'&&typeof react?.cloneElement==='function'?createH3ParameterControls(react,()=>active):undefined;
 const subjectControls=controls?createVideoSubjectControls(react,()=>active):undefined;
 const originalJsx=jsx.jsx,originalJsxs=jsx.jsxs;
 const wrap=(original:Function)=>function(this:any,type:any,props:any,...args:any[]){
  if(active&&controls&&exactParameterFields(type)&&(hasH3ParameterControls(props)||hasVideoSubjectControls(props))){
   const component=type;let adapted=wrappers.get(component);
   if(!adapted){
    adapted=function H3ParameterFields(input:any){
     const enabled=typeof react.useSyncExternalStore==='function'?react.useSyncExternalStore(subscribe,snapshot,snapshot):active;
     // Keep Af's effects and the exact native rendering of every other field.
     // Calling the same component on every render preserves its hook order.
     const element=component(input),field=enabled&&hasH3ParameterControls(input),subjectField=enabled&&hasVideoSubjectControls(input),children=element?.props?.children;
     if(!field&&!subjectField||!Array.isArray(children))return element;
     let replaced=false,subjectReplaced=false;
     const projected=children.map((child:any)=>{
      if(subjectField&&subjectControls&&child?.key==='subjectMapping'&&typeof child?.props?.className==='string'&&child.props.className.split(/\s+/).includes('video-params-block')){subjectReplaced=true;return react.createElement(subjectControls,{key:'subjectMapping',field:subjectField,value:input.params?.subjectMapping??subjectField.paramValue,isEn:input.isEn,onChange:input.onChange,disabled:input.disabled===true});}
      if(!field||replaced||child?.key!=='outputPreset'||typeof child?.props?.className!=='string'||!child.props.className.split(/\s+/).includes('video-params-block'))return child;
      replaced=true;return react.createElement(controls,{key:'outputPreset',field,value:input.params?.outputPreset??field.paramValue,isEn:input.isEn,onChange:input.onChange,disabled:input.disabled===true});
     });
     if(subjectField&&subjectControls&&!subjectReplaced)projected.push(react.createElement(subjectControls,{key:'subjectMapping',field:subjectField,value:input.params?.subjectMapping??subjectField.paramValue,isEn:input.isEn,onChange:input.onChange,disabled:input.disabled===true}));
   return replaced||subjectField?react.cloneElement(element,{children:projected}):element;
    };wrappers.set(component,adapted);
   }
   type=adapted;
  }
  const classes=type==='div'&&args[0]==='outputPreset'&&typeof props?.className==='string'?props.className.split(/\s+/):[];
  const output=classes.includes('video-params-block')&&classes.includes('scale-selector');
  return original.call(this,type,output?{...props,[marker]:''}:props,...args);
 };
 const ownedJsx=wrap(originalJsx),ownedJsxs=wrap(originalJsxs);
 jsx.jsx=ownedJsx;jsx.jsxs=ownedJsxs;
 const style=root.createElement('style');style.id='studio-output-preset-layout';style.textContent=outputPresetLayoutStyles+h3ParameterControlStyles+videoSubjectControlStyles;root.head.append(style);
 return()=>{if(!active)return;active=false;for(const listener of [...listeners])listener();listeners.clear();style.remove();if(jsx.jsx===ownedJsx)jsx.jsx=originalJsx;if(jsx.jsxs===ownedJsxs)jsx.jsxs=originalJsxs;};
}

export const outputPresetLayoutStyles=`
 .model-config-params-popover:is(.model-config-params-popover--image,.model-config-params-popover--video) [data-studio-output-preset] .tap-radio-group__wrapper{display:flex!important;flex-direction:column;align-items:stretch;gap:4px}
 .model-config-params-popover:is(.model-config-params-popover--image,.model-config-params-popover--video) [data-studio-output-preset] .tap-radio-group__button{flex:0 0 auto!important;width:100%;max-width:100%;height:auto;min-height:32px;box-sizing:border-box;padding:8px 10px}
 .model-config-params-popover:is(.model-config-params-popover--image,.model-config-params-popover--video) [data-studio-output-preset] .tap-radio-group__label{white-space:normal;overflow-wrap:anywhere;word-break:normal;line-height:1.4}
`;
