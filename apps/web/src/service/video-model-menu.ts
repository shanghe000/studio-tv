import {openCredentialSettingsEvent} from './model-provider-credentials';
import {modelCatalogViewRevision,modelSourceByRef,projectModelGroups,projectModelOptions,subscribeModelCatalogView} from './model-catalog-view';
const verified=new WeakMap<Function,boolean>();
function videoCascade(type:any){
 if(typeof type!=='function'||type.name!=='s2e')return false;
 let known=verified.get(type);if(known===undefined){const source=Function.prototype.toString.call(type);known=source.includes('getDisabledReason')&&source.includes('mg-cascade-panel__item--disabled')&&source.includes('nodeModelList');verified.set(type,known);}return known;
}
function models(group:any):any[]{return Array.isArray(group?.nodeModelList)?group.nodeModelList.flatMap((row:any)=>Array.isArray(row.modelList)?row.modelList:[]):[];}
export function modelExecutionSource(model:any):'SELF_HOSTED'|'API'|undefined{const kind=(model?.['x-model-source']??modelSourceByRef(model?.capabilityRef??model?.modelCode??model?.value))?.kind;return kind==='SELF_HOSTED'||kind==='API'?kind:undefined;}
export function filterModelSourceGroups(groups:any[],kind:'SELF_HOSTED'|'API'):any[]{
 return groups.flatMap(group=>{
  const children=Array.isArray(group.modelGroupList)?filterModelSourceGroups(group.modelGroupList,kind):[],rows=(group.nodeModelList??[]).flatMap((row:any)=>{const list=(row.modelList??[]).filter((model:any)=>modelExecutionSource(model)===kind);return list.length?[{...row,modelList:list}]:[];});
  if(!children.length&&!rows.length)return[];
  return[{...group,...(Array.isArray(group.modelGroupList)?{modelGroupList:children}:{}),...(Array.isArray(group.nodeModelList)?{nodeModelList:rows}:{}),nodeTypeList:[...new Set([...rows.map((row:any)=>row.nodeType),...children.flatMap((child:any)=>child.nodeTypeList??[])])]}];
 });
}
function allModels(groups:any[]):any[]{return groups.flatMap(group=>[...models(group),...allModels(group.modelGroupList??[])]);}
function selectedGroup(groups:any[],value:string):any{for(const group of groups){if(models(group).some(model=>model.modelCode===value))return group;const nested=selectedGroup(group.modelGroupList??[],value);if(nested)return nested;}}
export const modelSourceMenuStyles=`
 .studio-model-source-menu{width:max-content;min-width:290px;max-width:min(420px,calc(100vw - 32px));background:#222225;border:1px solid #45454b;border-radius:10px;color:#eee;font-size:12px;box-shadow:0 12px 32px #0005}
 .studio-model-source-header{padding:10px 10px 0}.studio-model-source-tabs{display:flex;padding:3px;background:#161619;border-radius:7px;gap:3px}.studio-model-source-tabs button{flex:1;border:0;border-radius:5px;color:#b1b1b9;background:transparent;min-height:31px;font:inherit;cursor:pointer;padding:5px 12px}.studio-model-source-tabs button[aria-selected=true]{background:#49424f;color:#f0eaf4}.studio-model-source-tabs button:focus-visible,.studio-model-source-help button:focus-visible{outline:2px solid #a99abb;outline-offset:2px}
 .studio-model-source-help{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;color:#b2b2bb;font-size:11px;line-height:1.5;padding:10px 2px}.studio-model-source-help button{flex:none;border:0;background:transparent;color:#d5c4e6;padding:0;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.studio-model-source-menu .mg-cascade-panel{border:0;box-shadow:none;background:transparent}.studio-model-source-menu .mg-cascade-panel__col--root{min-width:290px}.studio-model-source-empty{padding:14px 12px 20px;color:#aaa}
`;
const wrappers=new WeakMap<Function,Function>();let menuId=0;
export function modelTriggerKeyboardHandlers(handlers:{onKeyDown?:Function;onKeyUp?:Function}={}){
 const protect=(original?:Function)=>(event:any)=>{if(event.key==='Enter'||event.key===' '||event.key==='Spacebar')event.stopPropagation();return original?.(event);};
 return{onKeyDown:protect(handlers.onKeyDown),onKeyUp:protect(handlers.onKeyUp)};
}
function protectModelTrigger(react:any,rendered:any){const child=rendered?.props?.children;return react.isValidElement(child)?react.cloneElement(rendered,{children:react.cloneElement(child,modelTriggerKeyboardHandlers(child.props))}):rendered;}
function sourceHeader(react:any,source:string,setSource:Function,id:string,allowSettings=true){return react.createElement('div',{className:'studio-model-source-header'},react.createElement('div',{className:'studio-model-source-tabs',role:'tablist','aria-label':'模型来源'},...(['SELF_HOSTED','API'] as const).map((kind,index)=>react.createElement('button',{key:kind,type:'button',role:'tab',id:id+'-'+kind,'aria-selected':source===kind,'aria-controls':id+'-panel',tabIndex:source===kind?0:-1,onMouseDown:(event:any)=>event.preventDefault(),onClick:(event:any)=>{event.stopPropagation();setSource(kind);},onKeyDown:(event:any)=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?1:1-index;setSource(next?'API':'SELF_HOSTED');event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();}}},kind==='SELF_HOSTED'?'自部署':'API 服务'))),react.createElement('div',{className:'studio-model-source-help'},react.createElement('span',null,source==='SELF_HOSTED'?'使用已部署的模型，无需个人 API Key。':allowSettings?'厂商按调用计费，自动匹配个人 API Key。':'使用已接通的托管模型服务。'),source==='API'&&allowSettings?react.createElement('button',{type:'button',onClick:(event:any)=>{event.preventDefault();event.stopPropagation();window.dispatchEvent(new CustomEvent(openCredentialSettingsEvent));}},'配置 API Key'):null));}
const ordinaryWrappers=new WeakMap<Function,Function>(),verifiedOrdinary=new WeakMap<Function,boolean>();
/** The shared native selector covers image generation, enhancement and text.
 * Filter its menu items after rendering so its current choice and callbacks
 * keep their original identity. A partially unclassified menu stays intact. */
export function nativeOrdinarySourceMenu(type:any,props:any,react:any):any{
 if(typeof type!=='function'||type.name!=='Lc'||!Array.isArray(props?.options)||!react?.useState||!react?.cloneElement)return type;
 let known=verifiedOrdinary.get(type);if(known===undefined){const source=Function.prototype.toString.call(type);known=source.includes('glass-dropdown-item__description')&&source.includes('data-option-label')&&source.includes('getPopupContainer');verifiedOrdinary.set(type,known);}if(!known)return type;
 if(!props.options.some((option:any)=>modelExecutionSource(option)))return type;
 let wrapped=ordinaryWrappers.get(type);if(wrapped)return wrapped;
 wrapped=function StudioModelSourceMenu(input:any){
  const [revision,setRevision]=react.useState(modelCatalogViewRevision),options=react.useMemo(()=>projectModelOptions(input.options),[input.options,revision]),selected=options.find((option:any)=>option.value===input.value),[source,setSource]=react.useState(()=>modelExecutionSource(selected)??'SELF_HOSTED'),id=react.useRef('studio-model-source-'+(++menuId));react.useEffect(()=>subscribeModelCatalogView(()=>setRevision(modelCatalogViewRevision())),[]);react.useEffect(()=>{const kind=modelExecutionSource(options.find((option:any)=>option.value===input.value));if(kind)setSource(kind);},[input.value]);
  const rendered=protectModelTrigger(react,type({...input,options}));if(!react.isValidElement(rendered)||!Array.isArray(rendered.props?.menu?.items)||typeof rendered.props.dropdownRender!=='function')return rendered;
  const sources=new Set(options.map(modelExecutionSource));if(sources.has(undefined)||!sources.has('SELF_HOSTED')||!sources.has('API'))return rendered;
  const refs=new Set(options.filter((option:any)=>modelExecutionSource(option)===source).map((option:any)=>String(option.value))),menu={...rendered.props.menu,items:rendered.props.menu.items.filter((item:any)=>refs.has(String(item.key)))},dropdownRender=rendered.props.dropdownRender,allowSettings=options.some((option:any)=>!!(option['x-model-source']??modelSourceByRef(option.capabilityRef??option.modelCode??option.value))?.credentialProviderRef);
  return react.cloneElement(rendered,{menu,dropdownRender:(...args:any[])=>react.createElement('div',{className:'studio-model-source-menu','data-studio-model-source':source,...modelTriggerKeyboardHandlers()},sourceHeader(react,source,setSource,id.current,allowSettings),react.createElement('div',{role:'tabpanel',id:id.current+'-panel','aria-labelledby':id.current+'-'+source},dropdownRender(...args)))});
 };
 ordinaryWrappers.set(type,wrapped);return wrapped;
}
/** Wrap the verified native cascade, keeping its hooks, keyboard behavior and
 * leaf callbacks. Only dropdown contents change when the source tab changes. */
export function nativeVideoSourceMenu(type:any,props:any,react:any):any{
 if(!videoCascade(type)||!Array.isArray(props?.groups)||!react?.useState||!react?.cloneElement)return type;
 let wrapped=wrappers.get(type);if(wrapped)return wrapped;
 wrapped=function StudioVideoSourceMenu(input:any){
  const [revision,setRevision]=react.useState(modelCatalogViewRevision),groups=react.useMemo(()=>projectModelGroups(input.groups),[input.groups,revision]),declared=allModels(groups),selected=declared.find(model=>model.modelCode===input.value),[source,setSource]=react.useState(()=>modelExecutionSource(selected)??'SELF_HOSTED'),id=react.useRef('studio-model-source-'+(++menuId));
  react.useEffect(()=>subscribeModelCatalogView(()=>setRevision(modelCatalogViewRevision())),[]);
  react.useEffect(()=>{const next=modelExecutionSource(declared.find(model=>model.modelCode===input.value));if(next)setSource(next);},[input.value]);
  const partitioned=declared.length>0&&declared.every(model=>!!modelExecutionSource(model)),filtered=react.useMemo(()=>partitioned?filterModelSourceGroups(groups,source):groups,[groups,source,partitioned]),rendered=protectModelTrigger(react,type(nativeVideoMenuProps(type,{...input,groups:filtered})));
  if(!react.isValidElement(rendered)||typeof rendered.props?.dropdownRender!=='function')return rendered;
  if(!partitioned)return rendered;
  const dropdownRender=rendered.props.dropdownRender,group=selectedGroup(groups,input.value),trigger=rendered.props.children;
  // The currently saved choice remains visible on the trigger while browsing
  // the other source. Switching tabs never selects or patches a model.
  let children=trigger;if(group&&react.isValidElement(trigger))children=react.cloneElement(trigger,{children:react.Children.map(trigger.props.children,(child:any)=>react.isValidElement(child)&&typeof child.props?.className==='string'&&child.props.className.includes('glass-dropdown-trigger__label')?react.cloneElement(child,{className:'glass-dropdown-trigger__label',children:group.modelGroupName||group.modelGroupNameEn||selected?.modelName}):child)});
  return react.cloneElement(rendered,{children,dropdownRender:(...args:any[])=>react.createElement('div',{className:'studio-model-source-menu','data-studio-model-source':source,...modelTriggerKeyboardHandlers()},sourceHeader(react,source,setSource,id.current),react.createElement('div',{role:'tabpanel',id:id.current+'-panel','aria-labelledby':id.current+'-'+source},filtered.length?dropdownRender(...args):react.createElement('div',{className:'studio-model-source-empty'},'此分类暂无可用型号。')))});
 };
 wrappers.set(type,wrapped);return wrapped;
}

/** The frozen cascade already renders disabled reasons as an accessible hover
 * description. Supply availability from STUDIO's public catalog to that native
 * path; neither a model label nor a client-side click enables execution. */
export function nativeVideoMenuProps(type:any,props:any){
 if(!videoCascade(type)||!Array.isArray(props?.groups))return props;
 const all:any[]=[],visit=(groups:any[])=>{for(const group of groups){all.push(...models(group));if(Array.isArray(group.modelGroupList))visit(group.modelGroupList);}};visit(props.groups);
 const declared=all.filter(model=>model?.capabilityRef&&model.modelCode===model.capabilityRef&&typeof model.available==='boolean');
 if(!declared.some(model=>!model.available||model.disabled===true))return props;
 const originalReason=props.getDisabledReason,originalChange=props.onChange;
 return{...props,getDisabledReason:(group:any)=>{
  const rows=models(group).filter(model=>model?.capabilityRef&&model.modelCode===model.capabilityRef);
  if(rows.length&&rows.every(model=>model.available===false||model.disabled===true))return rows.find(model=>typeof model.reason==='string'&&model.reason.trim())?.reason||'此模型尚未配置，请联系管理员。';
  return typeof originalReason==='function'?originalReason(group):undefined;
 },onChange:typeof originalChange==='function'?(ref:string,...args:any[])=>{
  if(declared.some(model=>model.capabilityRef===ref&&(model.available===false||model.disabled===true)))return;
  return originalChange(ref,...args);
 }:originalChange};
}
