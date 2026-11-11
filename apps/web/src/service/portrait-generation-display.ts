const portraitDialogs='.rh-character-emotion-dialog,.rh-character-appearance-dialog,.rh-character-makeup-dialog,.rh-pose-control-panel--modal';
const supportedFields=new Set(['prompt','transparentBackground','imageUrls']);
const nativeControls=new WeakMap<Function,boolean>();

function exactPortraitControls(type:any){
 if(typeof type!=='function'||type.name!=='_te')return false;
 let known=nativeControls.get(type);if(known===undefined){const source=Function.prototype.toString.call(type);known=source.includes('rh-portrait-generate-controls__select')&&source.includes('buttonTitle:"resolution"')&&source.includes('buttonTitle:"generateNum"');nativeControls.set(type,known);}return known;
}

/** The four inspected portrait footers share native _te. Its GSt fallback
 * invents 1K/2K when no width/aspect control exists; WSt's X means quantity.
 * This exact current model uses its default size and supports 1/2/4 images. */
function modelDefaultSize(model:any){
 return model?.available===true&&model.testMode===false&&model.kind==='IMAGE_TO_IMAGE'
  &&model.capabilityRef==='codex-image-edit-v1'&&model.capabilityVersion==='3'
  &&model.model?.providerRef==='codex'&&Array.isArray(model.config)&&model.config.every((field:any)=>supportedFields.has(field?.paramName));
}

export function projectPortraitGenerationDisplay(element:any,props:any,react:any){
 const children=element?.props?.children;
 if(!modelDefaultSize(props?.currentModel)||!Array.isArray(children)||children.length!==3||typeof react?.cloneElement!=='function')return element;
 const [size,count,generate]=children;
 if(size?.props?.buttonTitle!=='resolution'||count?.props?.buttonTitle!=='generateNum'
  ||![size,count].every(child=>typeof child?.props?.className==='string'&&child.props.className.split(/\s+/).includes('rh-portrait-generate-controls__select'))
  ||generate?.props?.currentModel!==props.currentModel||typeof generate?.props?.onClick!=='function')return element;
 const sizing=react.cloneElement(size,{value:'studio-model-default-size',options:[{value:'studio-model-default-size',label:'模型默认尺寸'}],disabled:true,buttonTitle:'输出尺寸：模型默认尺寸（当前模型不支持指定分辨率）',onChange:()=>{}});
 const quantity=Array.isArray(count.props.options)?react.cloneElement(count,{options:count.props.options.map((option:any)=>({...option,label:`${option.value} 张`})),buttonTitle:'生成数量（张，不是放大倍率）'}):count;
 return react.cloneElement(element,undefined,sizing,quantity,generate);
}

const copy=new Map([
 ['改变选中单张人物的内容，其余不变','尽量保留未调整部分（生成式编辑）'],
 ['开启后对参考图背景或风格不进行改动','生成时尽量保留参考图背景或风格，仍可能发生变化。'],
]);

/** Scoped compatibility display only: preserve all native model/state/save
 * callbacks. No graph, execution parameter, generated image or frozen asset is
 * edited. Mounted wrappers re-render to the original controls on disposal. */
export function installPortraitGenerationDisplay(native:any,root:Document=document){
 const react=native?.r,jsx=native?.j;
 if(typeof react?.cloneElement!=='function'||typeof react?.useSyncExternalStore!=='function'||typeof jsx?.jsx!=='function')return()=>{};
 let active=true,scheduled=false;const listeners=new Set<()=>void>(),wrappers=new WeakMap<Function,Function>(),installed:{name:string;original:Function;wrapper:Function}[]=[],texts=new Map<Text,{original:string;written:string}>();
 const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot=()=>active;
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,...args:any[]){
   if(active&&exactPortraitControls(args[0])){const component=args[0];let adapted=wrappers.get(component);if(!adapted){adapted=function PortraitGenerationDisplay(props:any){const enabled=react.useSyncExternalStore(subscribe,snapshot,snapshot),element=component(props);return enabled?projectPortraitGenerationDisplay(element,props,react):element;};wrappers.set(component,adapted);}args[0]=adapted;}
   return Reflect.apply(original,this,args);
  };jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 const refresh=()=>{scheduled=false;if(!active)return;for(const dialog of root.querySelectorAll(portraitDialogs))for(const paragraph of dialog.querySelectorAll('p')){
  if(paragraph.childNodes.length!==1||paragraph.firstChild?.nodeType!==3)continue;
  const text=paragraph.firstChild as Text,replacement=copy.get(text.data);if(!replacement)continue;
  texts.set(text,{original:text.data,written:replacement});text.data=replacement;
 }};
 const schedule=()=>{if(active&&!scheduled){scheduled=true;const view=root.defaultView;if(view?.requestAnimationFrame)view.requestAnimationFrame(refresh);else queueMicrotask(refresh);}};
 const observer=typeof MutationObserver==='function'&&root.body?new MutationObserver(schedule):null;
 observer?.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});refresh();
 return()=>{if(!active)return;active=false;observer?.disconnect();for(const listener of [...listeners])listener();for(const {name,original,wrapper}of installed)if(jsx[name]===wrapper)jsx[name]=original;for(const [text,value]of texts)if(text.data===value.written)text.data=value.original;texts.clear();};
}
