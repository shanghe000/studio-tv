import {equalDraftValue} from './canvas-draft';
import {cleanJson} from './graph';
import {h3PresetVersion,h3ResolutionPresets,h3TRPikaPresets,h3TRPikaRef} from './h3-resolution-presets';
import {h3DisplayRatios,h3VersionPresets} from './h3-parameter-contracts';

// Same presentation-only fields as migration 024. Unknown data remains an
// input: a real edit must still invalidate the server's execution binding.
const display=new Set(['__rhtv','title','label','modelName','modelNameEn','status','taskId','errorMsg','testMode','customBadgeText','progress','progressDetail','width','height','opResize','estimateTaskId','generationStartedAt','estimatedSeconds','localVideoEditTaskId']);
// Exact reviewed presets. A newly advertised model or preset
// requires its own reviewed serialization contract.
const presets:Record<string,Record<string,string[]>>={
 'h3-drama-reference-v1':{'landscape-480p-5s':['9:5','16:9'],'portrait-768p-10s':['24:43'],'landscape-736p-10s':['40:23']},
 'h3-action-reference-v1':{'landscape-480p-5s':['9:5','16:9']},
 [h3TRPikaRef]:Object.fromEntries(h3TRPikaPresets.map(row=>[row.value,[row.aspectRatio,'16:9']])),
 ...Object.fromEntries(['h3-drama-reference-v2','h3-action-reference-v2'].map(ref=>[ref,Object.fromEntries(h3ResolutionPresets.map(row=>[row.value,[row.aspectRatio]]))])),
};

/** q_/MCe's accepted command drops redundant selectors and freezes execution
 * metadata. The native storyboard form can re-add those selectors and omit
 * that metadata on the next autosave. Normalize only the same complete input
 * against its server receipt; never write task status or manufacture a bind. */
export function restoreNativeH3InputSerialization(node:any,prior:any,encodeAsset:(value:string)=>string=(value)=>value){
 const data=node?.data,receipt=prior?.data,ref=receipt?.capabilityRef,version=h3PresetVersion(ref,receipt?.capabilityVersion);
 const frozen=version?h3VersionPresets(ref,version):undefined,selected=frozen?.find(row=>row.value===receipt?.params?.outputPreset),allowed=selected?h3DisplayRatios(ref,version!,selected):presets[ref]?.[receipt?.params?.outputPreset];
 if(node?.type!=='rh-video'||prior?.type!==node.type||node.id!==prior.id||!data||!receipt||!allowed
  ||!version||receipt.modelCode!==ref||receipt.capabilityVersion!==version||receipt.parameterSchemaVersion!==version
  ||data.modelCode!==ref||data.capabilityRef!==ref||data.capabilityVersion!==version||data.parameterSchemaVersion!==version
  ||data.isStoryboard!==true||receipt.isStoryboard!==true||typeof receipt.storyboardRowId!=='string'||!receipt.storyboardRowId
  ||data.storyboardRowId!==receipt.storyboardRowId
  ||String(data.subType??'').toUpperCase().replaceAll('-','_')!=='MULTIMODAL_VIDEO'
  ||String(receipt.subType??'').toUpperCase().replaceAll('-','_')!=='MULTIMODAL_VIDEO')return node;
 const current=cleanJson(data,encodeAsset),previous=cleanJson(receipt,encodeAsset),prompt=previous.params?.prompt,preset=previous.params?.outputPreset,ratio=previous.aspectRatio;
 if(typeof preset!=='string'||!allowed.includes(ratio))return node;
 if(typeof prompt!=='string'||!prompt||current.params?.prompt!==prompt||current.prompt!==prompt||previous.prompt!==prompt
  ||!equalDraftValue(previous.userPromptSnapshot,{paramName:'prompt',value:prompt})
  ||!equalDraftValue(previous.routerParameters,{outputPreset:preset})
  ||current.params?.outputPreset!==preset||current.aspectRatio!==ratio)return node;
 const params={...current.params},rawParams={...data.params};
 for(const [key,value] of [['rhModel',ref],['aspectRatio',ratio]] as const){
  if(Object.hasOwn(params,key)&&!Object.hasOwn(previous.params,key)){
   if(params[key]!==value)return node;
   delete params[key];delete rawParams[key];
  }
 }
 if(!equalDraftValue(params,previous.params))return node;
 const patch:Record<string,any>={};
 for(const key of ['routerParameters','userPromptSnapshot']){
  if(Object.hasOwn(current,key)){if(!equalDraftValue(current[key],previous[key]))return node;}
  else patch[key]=structuredClone(receipt[key]);
 }
 const semantic=(value:any)=>Object.fromEntries(Object.entries(value).filter(([key])=>!display.has(key)&&!['routerParameters','userPromptSnapshot'].includes(key)));
 if(!equalDraftValue(semantic({...current,params}),semantic(previous)))return node;
 if(!Object.keys(patch).length&&equalDraftValue(rawParams,data.params))return node;
 return{...node,data:{...data,...patch,params:rawParams}};
}
