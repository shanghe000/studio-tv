/** A credential change only updates public catalog availability in the render
 * view. Historical model versions and saved node parameters stay authoritative. */
const listeners=new Set<()=>void>();
const sources=new Map<string,{kind:'SELF_HOSTED'|'API';credentialProviderRef?:string}>();
const selectionIntents=new Map<string,{ref:string;token:object}>();
/** The inspected native setModelCode commits synchronously. Scope one public
 * choice to its owning node and discard unused intent when that callback ends. */
export function withNativeModelSelectionIntent<T>(nodeId:string,ref:string,run:()=>T):T{const token={};selectionIntents.set(nodeId,{ref,token});try{return run();}finally{if(selectionIntents.get(nodeId)?.token===token)selectionIntents.delete(nodeId);}}
export function consumeNativeModelSelectionIntent(nodeId:string,ref:string){if(selectionIntents.get(nodeId)?.ref!==ref)return false;selectionIntents.delete(nodeId);return true;}
export const modelSourceByRef=(ref:unknown)=>typeof ref==='string'?sources.get(ref):undefined;
export function rememberModelSource(ref:string,source:{kind:'SELF_HOSTED'|'API';credentialProviderRef?:string}|undefined){if(source)sources.set(ref,source);return source;}
let revision=0,models=new Map<string,any>();
let projected=new WeakMap<object,any>();
export const subscribeModelCatalogView=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const modelCatalogViewRevision=()=>revision;
export function replaceModelCatalogView(groups:any[]){
 const next=new Map<string,any>(),visit=(rows:any[])=>{for(const group of rows){for(const row of group.nodeModelList??[])for(const model of row.modelList??[])if(model.capabilityRef===model.modelCode)next.set(model.capabilityRef,model);if(Array.isArray(group.modelGroupList))visit(group.modelGroupList);}};visit(groups);
 models=next;projected=new WeakMap();revision++;for(const listener of listeners)listener();
}
export function clearModelCatalogView(){models.clear();sources.clear();selectionIntents.clear();projected=new WeakMap();revision++;for(const listener of listeners)listener();}
function view(model:any){
 const ref=model?.capabilityRef??model?.modelCode??model?.value,fresh=models.get(ref);if(!fresh)return model;
 const inputReason=fresh.available===true?model.studioInputDisabledReason:undefined;
 return{...model,available:fresh.available,disabled:!!inputReason||fresh.disabled,reason:inputReason??fresh.reason,description:inputReason??fresh.description,descriptionEn:inputReason??fresh.descriptionEn,'x-model-source':fresh['x-model-source']};
}
export function projectModelOptions(options:any[]){if(!models.size)return options;const cached=projected.get(options);if(cached)return cached;const result=options.map(view);projected.set(options,result);return result;}
export function projectModelGroups(groups:any[]):any[]{
 if(!models.size)return groups;
 const cached=projected.get(groups);if(cached)return cached;
 const result=groups.map(group=>({...group,...(Array.isArray(group.nodeModelList)?{nodeModelList:group.nodeModelList.map((row:any)=>({...row,modelList:row.modelList.map(view)}))}:{}),...(Array.isArray(group.modelGroupList)?{modelGroupList:projectModelGroups(group.modelGroupList)}:{})}));projected.set(groups,result);return result;
}
export function projectModelCatalogProps(props:any){
 if(!models.size||!props||typeof props!=='object')return props;
 let result=props;
 for(const key of ['groups','videoModelGroups'])if(Array.isArray(props[key])){if(result===props)result={...props};result[key]=projectModelGroups(props[key]);}
 if(props.models&&typeof props.models==='object'&&!Array.isArray(props.models)){
  let mapped=projected.get(props.models);if(!mapped){mapped=Object.fromEntries(Object.entries(props.models).map(([key,rows])=>[key,Array.isArray(rows)?rows.map(view):rows]));projected.set(props.models,mapped);}
  if(result===props)result={...props};result.models=mapped;
 }
 return result;
}
