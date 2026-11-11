import type {NativeModelBindingPort} from './model-bindings';
import {h3PinnedPresetMetadataMatches,h3ResolutionRefs} from './h3-resolution-presets';
import {h3ParameterVersions,h3UpgradePreset,h3UpgradeValue,h3VersionPresets} from './h3-parameter-contracts';
const views=new WeakMap<object,Map<string,{groups:any;models:any;videoModelGroups:any}>>();
const parameterViews=new WeakMap<object,Map<string,{groups:any;models:any;videoModelGroups:any}>>();

function frozenParameterProps(props:any,bindings?:NativeModelBindingPort){
 const node=props?.targetNode??props?.node,data=node?.data,ref=data?.modelCode??data?.capabilityRef,version=data?.capabilityVersion;
 if(node?.type!=='rh-video'||typeof ref!=='string'||typeof version!=='string'||version===h3ParameterVersions[ref])return;
 const rows=h3VersionPresets(ref,version),current=Object.values(props.models??{}).flat().find((m:any)=>m?.modelCode===ref&&m?.model?.modelRef==='h3'&&m.capabilityVersion===h3ParameterVersions[ref]) as any;
 if(!rows||!current||!h3PinnedPresetMetadataMatches(current))return;
 const key=ref+'\0'+version;
 let cache=parameterViews.get(props.models);if(!cache){cache=new Map();parameterViews.set(props.models,cache);}let view=cache.get(key);
 if(!view||view.groups!==props.videoModelGroups){
  const upgraded=h3VersionPresets(ref,current.capabilityVersion)??[];
  const row=(m:any)=>m?.modelCode===ref?{...m,capabilityVersion:version,parameterSchemaVersion:version,h3OutputPresets:structuredClone(rows),config:(m.config??[]).map((f:any)=>f.paramName==='outputPreset'?{...f,studioH3ParameterMetadata:{capabilityRef:ref,version,presets:structuredClone(rows)},paramValue:rows[0].value,optionValue:[...rows.map(p=>({value:p.value,labelCn:p.title??`${p.width}×${p.height} · ${p.durationSeconds}秒`,labelEn:p.title??`${p.width}×${p.height} · ${p.durationSeconds}s`})),...upgraded.map(p=>({value:h3UpgradeValue(ref,p.value),labelCn:`新参数 · ${p.title??`${p.width}×${p.height} · ${p.durationSeconds}秒`}`,labelEn:`New parameters · ${p.title??`${p.width}×${p.height} · ${p.durationSeconds}s`}`}))]}:f)}:m;
  const groups=(items:any[]):any[]=>items.map(g=>({...g,...(Array.isArray(g.modelGroupList)?{modelGroupList:groups(g.modelGroupList)}:{}),...(Array.isArray(g.nodeModelList)?{nodeModelList:g.nodeModelList.map((n:any)=>({...n,modelList:n.modelList?.map(row)}))}:{})}));
  view={groups:props.videoModelGroups,models:Object.fromEntries(Object.entries(props.models).map(([name,value])=>[name,Array.isArray(value)?value.map(row):value])),videoModelGroups:Array.isArray(props.videoModelGroups)?groups(props.videoModelGroups):props.videoModelGroups};cache.set(key,view);
 }
 const patch=props.onNodeDataPatch;
 let upgraded=false;
 const onNodeDataPatch=typeof patch==='function'?(id:string,value:any,...rest:any[])=>{
  if(upgraded||bindings&&!bindings.current())return;
  const upgrade=h3UpgradePreset(ref,version,value?.params?.outputPreset);
  if(typeof value?.params?.outputPreset==='string'&&value.params.outputPreset.startsWith('__h3_upgrade_')&&!upgrade)return;
  if(upgrade){
   if(props.readonly===true||id!==node.id||!h3PinnedPresetMetadataMatches(current)||value.modelCode!==undefined&&value.modelCode!==ref)return;
   const bound={...value,modelCode:ref,capabilityRef:ref,capabilityVersion:current.capabilityVersion,parameterSchemaVersion:current.parameterSchemaVersion,aspectRatio:upgrade.aspectRatio,params:{...value.params,outputPreset:upgrade.value,aspectRatio:upgrade.aspectRatio}};
   const result=patch(id,bound,...rest);if(result!==false&&!(result&&typeof result.then==='function')){bindings?.record(node,bound);upgraded=true;bindings?.refreshParameters?.(id,bound);}return result;
  }
  const selected=value?.modelCode&&(value.modelCode!==ref||value.capabilityVersion===current.capabilityVersion)?Object.values(props.models).flat().find((m:any)=>m?.modelCode===value.modelCode&&m?.model?.modelRef==='h3'&&m.available===true) as any:undefined;
  const bound=selected?{...value,capabilityRef:selected.capabilityRef,capabilityVersion:selected.capabilityVersion,parameterSchemaVersion:selected.parameterSchemaVersion}:value;
  const result=patch(id,bound,...rest);if(selected&&id===node.id&&result!==false&&!(result&&typeof result.then==='function')&&bindings?.current())bindings.record(node,bound);return result;
 }:patch;
 return{...props,models:view.models,videoModelGroups:view.videoModelGroups,onNodeDataPatch};
}
/** A saved v1 node keeps its immutable 5s parameter menu. New nodes use current
 * v2; choosing a different public model explicitly records that new version. */
export function historicalH3ModelProps(props:any,bindings?:NativeModelBindingPort){
 const frozen=frozenParameterProps(props,bindings);if(frozen)return frozen;
 const node=props?.targetNode??props?.node,data=node?.data;
 if(node?.type!=='rh-video'||data?.capabilityVersion!=='1'||!props.models)return props;
 const ref=data.modelCode??data.capabilityRef,current=Object.values(props.models).flat().find((m:any)=>m?.modelCode===ref&&m?.model?.modelRef==='h3'&&m.capabilityVersion==='2') as any;
 if(!current||h3ResolutionRefs.has(ref))return props;
 let cache=views.get(props.models);if(!cache){cache=new Map();views.set(props.models,cache);}let view=cache.get(ref);
 if(!view||view.groups!==props.videoModelGroups){
  const row=(m:any)=>m?.modelCode===ref?{...m,capabilityVersion:'1',parameterSchemaVersion:'1',config:(m.config??[]).map((f:any)=>f.paramName==='outputPreset'?{...f,paramValue:'480p-landscape-5s',optionValue:(f.optionValue??[]).filter((v:any)=>v.value==='480p-landscape-5s')}:f)}:m;
  const groups=(items:any[]):any[]=>items.map(g=>({...g,...(Array.isArray(g.modelGroupList)?{modelGroupList:groups(g.modelGroupList)}:{}),...(Array.isArray(g.nodeModelList)?{nodeModelList:g.nodeModelList.map((n:any)=>({...n,modelList:n.modelList?.map(row)}))}:{})}));
  view={groups:props.videoModelGroups,models:Object.fromEntries(Object.entries(props.models).map(([key,value])=>[key,Array.isArray(value)?value.map(row):value])),videoModelGroups:Array.isArray(props.videoModelGroups)?groups(props.videoModelGroups):props.videoModelGroups};cache.set(ref,view);
 }
 const patch=props.onNodeDataPatch;
 const onNodeDataPatch=typeof patch==='function'?(id:string,value:any,...rest:any[])=>{
  if(bindings&&!bindings.current())return;
  const model=value?.modelCode&&value.modelCode!==ref?Object.values(props.models).flat().find((m:any)=>m?.modelCode===value.modelCode&&m?.model?.modelRef==='h3'&&m.available===true) as any:undefined;
  const bound=model?{...value,capabilityRef:model.capabilityRef,capabilityVersion:model.capabilityVersion,parameterSchemaVersion:model.parameterSchemaVersion}:value;
  const result=patch(id,bound,...rest);if(model&&id===node.id&&result!==false&&!(result&&typeof result.then==='function')&&bindings?.current())bindings.record(node,bound);return result;
 }:patch;
 return{...props,models:view.models,videoModelGroups:view.videoModelGroups,onNodeDataPatch};
}
