import {h3ParameterSelection,selectH3Parameter,type H3ParameterSelection} from './h3-parameter-options';

export interface VideoOutputPreset {value:string;resolution?:string;aspectRatio?:string;durationSeconds:number;width?:number;height?:number;fps?:number;title?:string}
export interface VideoMediaRole {role:string;kind:string;title:string;description?:string;minItems?:number;maxItems?:number;paramName?:string}
export interface VideoParameterMetadata {schemaVersion:'1';capabilityRef:string;version:string;presets:VideoOutputPreset[];mode?:string;mediaRoles?:VideoMediaRole[];subjectControl?:Record<string,any>;outputLimits?:{maxArtifactBytes?:number};supportsCancel?:boolean;durationPolicy?:'SOURCE_VIDEO';sourceSecondsMin?:number;sourceSecondsMax?:number}
export interface VideoParameterChoice {value:string;preset:VideoOutputPreset;ratio:string|undefined;resolution:string|undefined;upgrade:boolean;disabled:boolean}
export interface VideoParameterSelection {choices:VideoParameterChoice[];selected:VideoParameterChoice;ratios:{id:string;label:string;disabled:boolean}[];resolutions:{id:string;label:string;disabled:boolean}[];durations:number[];durationIndex:number;extras:VideoParameterChoice[];metadata?:VideoParameterMetadata;legacy?:H3ParameterSelection}
export interface VideoParameterChange {ratio?:string;resolution?:string;durationSeconds?:number;value?:string}
export function isVideoCapability(cap:any){return cap?.available===true&&cap.testMode===false&&!!cap.model&&cap.outputKinds?.includes('VIDEO')&&cap.parameterSchema?.['x-video-parameter-metadata']?.schemaVersion==='1'&&['TEXT_TO_VIDEO','FIRST_FRAME','LAST_FRAME','FIRST_LAST_FRAME','OMNI_REFERENCE','MOTION_TRANSFER','VIDEO_TO_VIDEO','VIDEO_EXTEND'].includes(cap.parameterSchema?.['x-video-mode']);}
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const ratio=(value:unknown):value is string=>text(value)&&(value==='adaptive'||/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)&&value.split(':').every(part=>Number(part)>0));
const sameSpatial=(a:VideoParameterChoice,b:VideoParameterChoice)=>a.ratio===b.ratio&&a.resolution===b.resolution&&a.preset.width===b.preset.width&&a.preset.height===b.preset.height;
function validPreset(row:any,sourceDuration=false):row is VideoOutputPreset{
 if(!row||!text(row.value)||!(row.durationSeconds===-1||sourceDuration&&row.durationSeconds===0||positive(row.durationSeconds))||row.resolution!==undefined&&!text(row.resolution)||row.aspectRatio!==undefined&&!ratio(row.aspectRatio))return false;
 if((row.width===undefined)!==(row.height===undefined)||['width','height','fps'].some(key=>row[key]!==undefined&&(!Number.isSafeInteger(row[key])||row[key]<=0)))return false;
 return row.resolution!==undefined||row.aspectRatio!==undefined||row.width!==undefined;
}
/** The schema's complete preset list is authoritative. No pixel size, ratio,
 * duration, option value or combination is synthesized in the browser. */
export function videoParameterSelection(field:any,selectedValue:unknown):VideoParameterSelection|undefined{
 // Historical H3 contracts retain their explicit version/alias validation.
 const legacy=h3ParameterSelection(field,selectedValue);if(legacy)return{...legacy,legacy};
 if(!field||field.paramName!=='outputPreset'||!Array.isArray(field.optionValue)||!field.optionValue.length||field.optionValue.length>1024)return;
 const metadata=field.studioVideoParameterMetadata as VideoParameterMetadata|undefined;
 if(!metadata||metadata.schemaVersion!=='1'||!text(metadata.capabilityRef)||!text(metadata.version)||!Array.isArray(metadata.presets)||metadata.presets.length!==field.optionValue.length)return;
 const presets=new Map<string,VideoOutputPreset>();
 const sourceDuration=metadata.durationPolicy==='SOURCE_VIDEO'&&metadata.mode==='MOTION_TRANSFER'&&positive(metadata.sourceSecondsMin)&&positive(metadata.sourceSecondsMax)&&metadata.sourceSecondsMax>=metadata.sourceSecondsMin;
 for(const row of metadata.presets){if(!validPreset(row,sourceDuration)||presets.has(row.value))return;presets.set(row.value,{...row});}
 const choices:VideoParameterChoice[]=[],seen=new Set<string>();
 for(const option of field.optionValue){
  if(!option||!text(option.value)||seen.has(option.value))return;seen.add(option.value);
  const preset=presets.get(option.value);if(!preset)return;
  choices.push({value:option.value,preset,ratio:preset.aspectRatio,resolution:preset.resolution,upgrade:false,disabled:option.disabled===true});
 }
 const value=selectedValue??field.paramValue,selected=choices.find(row=>row.value===value);if(!selected||selected.disabled)return;
 const enabled=choices.filter(row=>!row.disabled),ids=(key:'ratio'|'resolution')=>[...new Set(choices.map(row=>row[key]).filter((value):value is string=>!!value))];
 const durations=[...new Set(enabled.filter(row=>sameSpatial(row,selected)).map(row=>row.preset.durationSeconds))].sort((a,b)=>a-b);
 return{choices,selected,metadata,ratios:ids('ratio').map(id=>({id,label:id,disabled:!enabled.some(row=>row.ratio===id)})),resolutions:ids('resolution').map(id=>({id,label:id.toUpperCase(),disabled:!enabled.some(row=>row.resolution===id&&row.ratio===selected.ratio)})),durations,durationIndex:durations.indexOf(selected.preset.durationSeconds),extras:choices.filter(row=>!row.ratio&&!row.resolution)};
}
/** Resolve one gesture to one of the catalog's complete, enabled presets. */
export function selectVideoParameter(view:VideoParameterSelection,change:VideoParameterChange):string|undefined{
 if(view.legacy)return selectH3Parameter(view.legacy,change);
 const keys=Object.keys(change).filter(key=>change[key as keyof VideoParameterChange]!==undefined);
 if(keys.length!==1||!['ratio','resolution','durationSeconds','value'].includes(keys[0]))return;
 const enabled=view.choices.filter(row=>!row.disabled),current=view.selected;
 if(change.value!==undefined)return enabled.find(row=>row.value===change.value)?.value;
 let candidates:VideoParameterChoice[];
 if(change.ratio!==undefined){
  if(!view.ratios.some(row=>row.id===change.ratio&&!row.disabled))return;
  candidates=enabled.filter(row=>row.ratio===change.ratio);
  const sameResolution=candidates.filter(row=>row.resolution===current.resolution);if(sameResolution.length)candidates=sameResolution;
 }else if(change.resolution!==undefined){
  if(!view.resolutions.some(row=>row.id===change.resolution&&!row.disabled))return;
  candidates=enabled.filter(row=>row.ratio===current.ratio&&row.resolution===change.resolution);
 }else{
  if(!view.durations.includes(change.durationSeconds!))return;
  candidates=enabled.filter(row=>sameSpatial(row,current)&&row.preset.durationSeconds===change.durationSeconds);
 }
 const sameDuration=candidates.filter(row=>row.preset.durationSeconds===current.preset.durationSeconds);if(sameDuration.length)candidates=sameDuration;
 return candidates.find(row=>row.value===current.value)?.value??candidates[0]?.value;
}

export function videoParameterMetadata(cap:any):VideoParameterMetadata|undefined{
 const schema=cap.parameterSchema,metadata=schema?.['x-video-parameter-metadata'];
 if(cap.testMode!==false||!cap.model||!cap.outputKinds?.includes('VIDEO')||metadata?.schemaVersion!=='1'||!Array.isArray(schema.properties?.outputPreset?.enum))return;
 const projected:VideoParameterMetadata={schemaVersion:'1',capabilityRef:cap.capabilityRef,version:cap.version,presets:metadata.presets,mode:schema['x-video-mode'],mediaRoles:schema['x-media-roles'],subjectControl:schema['x-subject-control'],outputLimits:schema['x-output-limits'],supportsCancel:typeof cap.supportsCancel==='boolean'?cap.supportsCancel:undefined,...(metadata.durationPolicy==='SOURCE_VIDEO'?{durationPolicy:metadata.durationPolicy,sourceSecondsMin:metadata.sourceSecondsMin,sourceSecondsMax:metadata.sourceSecondsMax}:{})};
 const field={paramName:'outputPreset',paramValue:schema.properties.outputPreset.default,optionValue:schema.properties.outputPreset.enum.map((value:any)=>({value})),studioVideoParameterMetadata:projected};
 return videoParameterSelection(field,field.paramValue)?structuredClone(projected):undefined;
}
