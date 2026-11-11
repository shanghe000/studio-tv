import {h3ParameterVersions,h3UpgradePreset,h3VersionPresets} from './h3-parameter-contracts';
/** Reviewed candidate dimensions. A matching tuple is a serialization contract,
 * not proof of GPU readiness; the catalog's availability gate remains decisive. */
export const h3ResolutionRefs=new Set(['h3-drama-reference-v2','h3-action-reference-v2']);
export const h3ResolutionPresets=[
 {value:'landscape-480p-5s',width:864,height:480,aspectRatio:'9:5'},
 {value:'portrait-480p-5s',width:480,height:864,aspectRatio:'5:9'},
 {value:'square-480p-5s',width:480,height:480,aspectRatio:'1:1'},
 {value:'standard-480p-5s',width:640,height:480,aspectRatio:'4:3'},
 {value:'standard-portrait-480p-5s',width:480,height:640,aspectRatio:'3:4'},
 {value:'ultrawide-480p-5s',width:1120,height:480,aspectRatio:'7:3'},
 {value:'landscape-768p-5s',width:1344,height:768,aspectRatio:'7:4'},
 {value:'portrait-768p-5s',width:768,height:1344,aspectRatio:'4:7'},
 {value:'square-768p-5s',width:768,height:768,aspectRatio:'1:1'},
 {value:'standard-768p-5s',width:1024,height:768,aspectRatio:'4:3'},
 {value:'standard-portrait-768p-5s',width:768,height:1024,aspectRatio:'3:4'},
 {value:'ultrawide-768p-5s',width:1792,height:768,aspectRatio:'7:3'},
].map(row=>Object.freeze({...row,durationSeconds:5,fps:24}));

// This tuple preserves the imported workflow. GPU acceptance is pending;
// enabling manual use in the catalog does not make it a verified model.
export const h3TRPikaRef='h3-tr-pika-twopass-ref-v1';
export const h3TRPikaPresets=[Object.freeze({value:'landscape-1920x1088-8s',width:1920,height:1088,aspectRatio:'30:17',durationSeconds:8,fps:24})];

export function h3PresetVersion(ref:unknown,version?:unknown){
 if(typeof ref!=='string')return;
 if(Object.hasOwn(h3ParameterVersions,ref)){
  const selected=version===undefined?h3ParameterVersions[ref]:version;
  return typeof selected==='string'&&h3VersionPresets(ref,selected)?selected:undefined;
 }
 if(h3ResolutionRefs.has(ref))return version===undefined||version==='2'?'2':undefined;
 if(ref==='h3-drama-reference-v1'||ref==='h3-action-reference-v1'||ref===h3TRPikaRef)return '1';
}

function fixedPresetMetadataMatches(model:any,version:string,presets:ReadonlyArray<{value:string;width:number;height:number;aspectRatio:string;durationSeconds:number;fps:number}>){
 if(model.modelCode!==model.capabilityRef||model.capabilityVersion!==version||model.parameterSchemaVersion!==version)return false;
 const rows=model.h3OutputPresets,fields=model.config?.filter((row:any)=>row.paramName==='outputPreset');
 if(!Array.isArray(rows)||rows.length!==presets.length||fields?.length!==1||fields[0].disabled===true)return false;
 const choices=fields[0].optionValue;
 const options=Array.isArray(choices)?choices.filter((row:any)=>!h3UpgradePreset(model.capabilityRef,version,row?.value)):choices;
 if(!Array.isArray(options)||options.length!==presets.length||!presets.some(row=>row.value===fields[0].paramValue))return false;
 return presets.every(expected=>{
  const matches=rows.filter((row:any)=>row?.value===expected.value),choices=options.filter((row:any)=>row?.value===expected.value&&row.disabled!==true);
  return matches.length===1&&choices.length===1&&(['width','height','aspectRatio','durationSeconds','fps'] as const).every(key=>matches[0][key]===expected[key]);
 });
}

/** Fail closed if a candidate's catalog contract changes at the same version. */
export function h3ResolutionMetadataMatches(model:any){
 return h3ResolutionRefs.has(model?.capabilityRef)&&fixedPresetMetadataMatches(model,'2',h3ResolutionPresets);
}

export function h3PinnedPresetMetadataMatches(model:any){
 if(h3ResolutionRefs.has(model?.capabilityRef))return h3ResolutionMetadataMatches(model);
 if(Object.hasOwn(h3ParameterVersions,model?.capabilityRef??'')){
  const version=model.capabilityVersion,rows=h3VersionPresets(model.capabilityRef,version);
  if(!rows)return false;
  if(model.kind==='IMAGE_TO_VIDEO'&&['1','2'].includes(version))return true;
  return fixedPresetMetadataMatches(model,version,rows);
 }
 return true;
}
