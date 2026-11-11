import type {NativeModelBindingPort} from './model-bindings';
import {h3PinnedPresetMetadataMatches,h3PresetVersion} from './h3-resolution-presets';
const callbacks=new WeakMap<Function,WeakMap<object,{models:any;bindings?:NativeModelBindingPort;callback:Function}>>();
const versionKeys=['capabilityRef','capabilityVersion','parameterSchemaVersion'];
const empty=(value:any)=>value===undefined||value===null||value==='';
const bound=(data:any)=>typeof data?.capabilityVersion==='string'&&!!h3PresetVersion(data?.modelCode,data.capabilityVersion)&&data?.capabilityRef===data?.modelCode&&data?.parameterSchemaVersion===data.capabilityVersion;
function fresh(data:any){return data?.status==='idle'&&versionKeys.every(key=>!Object.hasOwn(data,key))&&empty(data.taskId)&&empty(data.estimateTaskId)&&data.historyStorage==null&&data.history==null&&data.isUpload!==true&&(data.output==null||Array.isArray(data.output)&&!data.output.length)&&(data.nodeOutputHistory==null||Array.isArray(data.nodeOutputHistory)&&!data.nodeOutputHistory.length)&&['selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId'].every(key=>empty(data[key]));}

function preset(model:any,value:any){
 const field=model.config?.filter((row:any)=>row.paramName==='outputPreset');
 if(field?.length!==1||field[0].disabled===true||!Array.isArray(field[0].optionValue)||field[0].optionValue.filter((option:any)=>option.value===value&&option.disabled!==true).length!==1||!Array.isArray(model.h3OutputPresets))return;
 const matches=model.h3OutputPresets.filter((row:any)=>row.value===value);
 if(matches?.length!==1)return;const row=matches[0];
 if(!['width','height','fps'].every(key=>Number.isSafeInteger(row[key])&&row[key]>0)||typeof row.durationSeconds!=='number'||!Number.isFinite(row.durationSeconds)||row.durationSeconds<=0)return;
 const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,divisor=gcd(row.width,row.height);
 if(row.aspectRatio!==`${row.width/divisor}:${row.height/divisor}`)return;
 return row;
}

/** Fixed H3 selectors share this native UI mismatch.
 * The selected advertised preset owns its pixel ratio; it is not a separate
 * inference parameter. Never migrate a saved node while rendering. */
export function h3PresetSelectionProps(props:any,bindings?:NativeModelBindingPort){
 const node=props?.targetNode??props?.node,data=node?.data,original=props?.onNodeDataPatch;
 const rows=Object.values(props.models??{}).flat() as any[],advertised=rows.find(row=>row?.modelCode===data?.modelCode);
 const version=h3PresetVersion(data?.modelCode,data?.capabilityVersion??advertised?.capabilityVersion);
 if(node?.type!=='rh-video'||typeof original!=='function'||!version||!bound(data)&&!fresh(data)||props.readonly===true)return props;
 const model=rows.find(row=>row?.modelCode===data.modelCode&&row.capabilityRef===data.modelCode&&row.capabilityVersion===version&&row.parameterSchemaVersion===version&&row.available===true&&row.testMode===false&&['IMAGE_TO_VIDEO','OMNI_REFERENCE'].includes(row.kind)&&row.model?.modelRef==='h3');
 if(!model||model.disabled===true||!Array.isArray(model.config)||model.config.some((field:any)=>field.paramName==='aspectRatio'||field.type==='aspectRatio')||!Array.isArray(model.h3OutputPresets)||!h3PinnedPresetMetadataMatches(model))return props;
 let nodes=callbacks.get(original);if(!nodes){nodes=new WeakMap();callbacks.set(original,nodes);}let state=nodes.get(node);
 if(!state||state.models!==props.models){
  state={models:props.models,bindings,callback:undefined as any};const lease=state;
  state.callback=(id:string,patch:any,...rest:any[])=>{
   if(lease.bindings&&!lease.bindings.current())return;
   const params=patch?.params,current=node.data,binding=lease.bindings;
   if(current.modelCode!==model.capabilityRef||!bound(current)&&!fresh(current)||model.modelCode!==current.modelCode||model.capabilityVersion!==version||model.parameterSchemaVersion!==version||model.model?.modelRef!=='h3'||model.available!==true||model.testMode!==false||model.disabled===true||!h3PinnedPresetMetadataMatches(model))return original(id,patch,...rest);
   if(id!==node.id||!params||!Object.hasOwn(params,'outputPreset')||patch.modelCode!==undefined&&patch.modelCode!==current.modelCode||patch.capabilityRef!==undefined&&patch.capabilityRef!==current.capabilityRef||patch.capabilityVersion!==undefined&&patch.capabilityVersion!==current.capabilityVersion||patch.parameterSchemaVersion!==undefined&&patch.parameterSchemaVersion!==current.parameterSchemaVersion||params.rhModel!==undefined&&params.rhModel!==current.modelCode)return original(id,patch,...rest);
   const selected=preset(model,params.outputPreset);if(!selected)return original(id,patch,...rest);
   const changed=params.outputPreset!==current.params?.outputPreset,canonical=current.aspectRatio===selected.aspectRatio&&current.params?.aspectRatio===selected.aspectRatio;
   const previous=preset(model,current.params?.outputPreset),previousCanonical=previous&&current.aspectRatio===previous.aspectRatio&&current.params?.aspectRatio===previous.aspectRatio;
   // SD/af/i1 coerces undeclared ratios back to16:9 on later native edits.
   // Retain an already canonical selection only for that exact fallback;
   // old inconsistent10s drafts and explicit other ratios stay untouched.
   const carry=!changed&&canonical&&params.aspectRatio==='16:9';
   const ratio=params.aspectRatio,top=patch.aspectRatio;
   if(!changed&&!carry||changed&&ratio!==undefined&&ratio!==current.params?.aspectRatio&&ratio!==selected.aspectRatio&&!(previousCanonical&&ratio==='16:9')||top!==undefined&&top!==current.aspectRatio&&top!==selected.aspectRatio)return original(id,patch,...rest);
   const needsBinding=!bound(current);if(needsBinding&&(!changed||!binding?.current()))return original(id,patch,...rest);
   const value={...patch,aspectRatio:selected.aspectRatio,params:{...params,aspectRatio:selected.aspectRatio},...(needsBinding?{capabilityRef:model.capabilityRef,capabilityVersion:version,parameterSchemaVersion:version}:{})};
   const result=original(id,value,...rest);
   // The inspected native patch is synchronous. A deferred implementation
   // cannot prove that the same target survived until resolution, so it must
   // not create a sidecar binding from this earlier render's node.
   if(result&&typeof result.then==='function')return result;
   if(result!==false&&needsBinding&&lease.bindings===binding&&binding?.current())binding.record(node,value);
   return result;
  };nodes.set(node,state);
 }else state.bindings=bindings;
 return{...props,onNodeDataPatch:state.callback};
}
