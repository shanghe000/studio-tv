import {h3UpgradePreset,h3VersionPresets,type H3PresetTuple} from './h3-parameter-contracts';

export interface H3ParameterMetadata {capabilityRef:string;version:string;presets:H3PresetTuple[]}
export type H3ParameterRatio='ultrawide'|'landscape'|'standard'|'square'|'standard-portrait'|'portrait';
export interface H3ParameterChoice {value:string;preset:H3PresetTuple;ratio:H3ParameterRatio|undefined;resolution:string|undefined;upgrade:boolean;disabled:boolean}
export interface H3ParameterDimension {id:string;label:string;disabled:boolean}
export interface H3ParameterSelection {choices:H3ParameterChoice[];selected:H3ParameterChoice;ratios:H3ParameterDimension[];resolutions:H3ParameterDimension[];durations:number[];durationIndex:number;extras:H3ParameterChoice[]}
export interface H3ParameterChange {ratio?:string;resolution?:string;durationSeconds?:number;value?:string}
const ratios:ReadonlyArray<readonly[H3ParameterRatio,string]>=[['ultrawide','21:9'],['landscape','16:9'],['standard','4:3'],['square','1:1'],['standard-portrait','3:4'],['portrait','9:16']];
const family=/^(?:legacy-)?(standard-portrait|ultrawide|landscape|portrait|standard|square)(?:-|$)/;
const reversed=/^(\d+p|\d+k)-(standard-portrait|ultrawide|landscape|portrait|standard|square)(?:-|$)/;
const dimensions:Record<string,Partial<Record<H3ParameterRatio,readonly[number,number]>>>={
 '480p':{landscape:[864,480],portrait:[480,864],square:[480,480],standard:[640,480],'standard-portrait':[480,640],ultrawide:[1120,480]},
 '768p':{landscape:[1344,768],portrait:[768,1344],square:[768,768],standard:[1024,768],'standard-portrait':[768,1024],ultrawide:[1792,768]},
 '1080p':{landscape:[1920,1088],portrait:[1088,1920],square:[1088,1088],standard:[1440,1088],'standard-portrait':[1088,1440],ultrawide:[2528,1088]},
 '2k':{landscape:[2560,1440],portrait:[1440,2560],square:[1440,1440],standard:[1920,1440],'standard-portrait':[1440,1920],ultrawide:[3360,1440]},
};
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
const sameTuple=(a:H3PresetTuple,b:H3PresetTuple)=>(['value','width','height','aspectRatio','durationSeconds','fps'] as const).every(key=>a[key]===b[key]);
const sameSpatial=(a:H3ParameterChoice,b:H3ParameterChoice)=>a.preset.width===b.preset.width&&a.preset.height===b.preset.height;
function validTuple(value:any):value is H3PresetTuple{
 if(!value||typeof value!=='object'||typeof value.value!=='string'||!value.value||value.value.length>200||!['width','height','fps'].every(key=>Number.isSafeInteger(value[key])&&value[key]>0)||typeof value.durationSeconds!=='number'||!Number.isFinite(value.durationSeconds)||value.durationSeconds<=0)return false;
 const divisor=gcd(value.width,value.height);return value.aspectRatio===`${value.width/divisor}:${value.height/divisor}`;
}
function groups(preset:H3PresetTuple):{ratio:H3ParameterRatio|undefined;resolution:string|undefined}{
 const reverse=reversed.exec(preset.value),ratio=(family.exec(preset.value)?.[1]??reverse?.[2]) as H3ParameterRatio|undefined;
 if(!ratio)return{ratio:undefined,resolution:undefined};
 // A nominal tier is a presentation group only; pixels always come from the
 // exact advertised tuple. Old 768x1376, 1280x736 and 1920x1088 identifiers
 // intentionally remain separate preserved-spec choices.
 const tier=reverse?.[1]??new RegExp(`^${ratio}-(\\d+p|\\d+k)-`).exec(preset.value)?.[1];
 if(!tier||preset.value.startsWith('legacy-')||preset.value==='landscape-736p-10s')return{ratio,resolution:undefined};
 const expected=dimensions[tier]?.[ratio];
 if(expected&&(expected[0]!==preset.width||expected[1]!==preset.height))return{ratio,resolution:undefined};
 return{ratio,resolution:tier};
}
function tierOrder(tier:string){if(tier==='2k')return 1440;if(tier==='4k')return 2160;const value=Number.parseInt(tier,10);return Number.isFinite(value)?value:Number.MAX_SAFE_INTEGER;}

/** Derive controls only from a versioned, advertised outputPreset field.
 * This function never changes the node or invents an inference tuple/value. */
export function h3ParameterSelection(field:any,selectedValue:unknown):H3ParameterSelection|undefined{
 if(!field||field.paramName!=='outputPreset'||!Array.isArray(field.optionValue)||!field.optionValue.length||field.optionValue.length>1024)return;
 const metadata=field.studioH3ParameterMetadata as H3ParameterMetadata|undefined;
 if(!metadata||typeof metadata.capabilityRef!=='string'||typeof metadata.version!=='string'||!Array.isArray(metadata.presets)||!metadata.presets.length||metadata.presets.length>512)return;
 const contract=h3VersionPresets(metadata.capabilityRef,metadata.version);
 if(!contract||contract.length!==metadata.presets.length)return;
 const presets=new Map<string,H3PresetTuple>();
 for(const row of metadata.presets){
  if(!validTuple(row)||presets.has(row.value))return;
  const expected=contract.filter(p=>p.value===row.value);if(expected.length!==1||!sameTuple(row,expected[0]))return;
  presets.set(row.value,row);
 }
 const choices:H3ParameterChoice[]=[],values=new Set<string>();
 for(const option of field.optionValue){
  if(!option||typeof option.value!=='string'||!option.value||values.has(option.value))return;
  values.add(option.value);
  const direct=presets.get(option.value),upgrade=direct?undefined:h3UpgradePreset(metadata.capabilityRef,metadata.version,option.value),row=direct??upgrade;
  if(!row||!validTuple(row))return;
  const preset={...row};choices.push({value:option.value,preset,...groups(preset),upgrade:!!upgrade,disabled:option.disabled===true});
 }
 const value=selectedValue===undefined||selectedValue===null?field.paramValue:selectedValue;
 if(typeof value!=='string')return;
 const selected=choices.find(choice=>choice.value===value);if(!selected||selected.disabled)return;
 const enabled=choices.filter(choice=>!choice.disabled);
 const resolutionIds=[...new Set(choices.map(choice=>choice.resolution).filter((id):id is string=>!!id))].sort((a,b)=>tierOrder(a)-tierOrder(b)||a.localeCompare(b));
 const durations=[...new Set(enabled.filter(choice=>sameSpatial(choice,selected)).map(choice=>choice.preset.durationSeconds))].sort((a,b)=>a-b);
 const extras:H3ParameterChoice[]=[];
 for(const choice of choices.filter(choice=>choice.resolution===undefined)){
  const previous=extras.findIndex(row=>sameSpatial(row,choice)&&row.preset.durationSeconds===choice.preset.durationSeconds&&row.preset.fps===choice.preset.fps);
  if(previous<0)extras.push(choice);
  else if(choice.value===selected.value||extras[previous].disabled&&!choice.disabled)extras[previous]=choice;
 }
 return{choices,selected,
  ratios:ratios.map(([id,label])=>({id,label,disabled:!enabled.some(choice=>choice.ratio===id)})),
  resolutions:resolutionIds.map(id=>({id,label:id.toUpperCase(),disabled:!enabled.some(choice=>choice.resolution===id&&choice.ratio===selected.ratio)})),
  durations,durationIndex:durations.indexOf(selected.preset.durationSeconds),extras};
}

/** Resolve one user gesture to an existing optionValue, including upgrade aliases.
 * No render-time normalization or independent ratio/size/duration state is saved. */
export function selectH3Parameter(view:H3ParameterSelection,change:H3ParameterChange):string|undefined{
 const keys=Object.keys(change).filter(key=>change[key as keyof H3ParameterChange]!==undefined);
 if(keys.length!==1||!['ratio','resolution','durationSeconds','value'].includes(keys[0]))return;
 const enabled=view.choices.filter(choice=>!choice.disabled),current=view.selected;
 if(change.value!==undefined)return enabled.find(choice=>choice.value===change.value)?.value;
 let candidates:H3ParameterChoice[];
 if(change.ratio!==undefined){
  if(!view.ratios.some(row=>row.id===change.ratio&&!row.disabled))return;
  candidates=enabled.filter(choice=>choice.ratio===change.ratio);
  const sameTier=candidates.filter(choice=>choice.resolution===current.resolution);
  if(sameTier.length)candidates=sameTier;
 }else if(change.resolution!==undefined){
  if(!view.resolutions.some(row=>row.id===change.resolution&&!row.disabled))return;
  candidates=enabled.filter(choice=>choice.ratio===current.ratio&&choice.resolution===change.resolution);
 }else{
  if(typeof change.durationSeconds!=='number'||!view.durations.includes(change.durationSeconds))return;
  candidates=enabled.filter(choice=>sameSpatial(choice,current)&&choice.preset.durationSeconds===change.durationSeconds);
  // An explicit duration edit opts into exact-second output even when the
  // old approximate preset has the same 5/10/15-second label.
  const exact=candidates.find(choice=>choice.upgrade&&choice.value.startsWith('__h3_upgrade_5__'));
  if(exact)return exact.value;
 }
 const sameDuration=candidates.filter(choice=>choice.preset.durationSeconds===current.preset.durationSeconds);
 if(sameDuration.length)candidates=sameDuration;
 // A base preset and its explicit upgrade alias may share exactly the same
 // pixels and duration. Keeping the current option avoids incidental upgrades.
 return candidates.find(choice=>choice.value===current.value)?.value
  ??candidates.find(choice=>choice.upgrade===current.upgrade)?.value
  ??candidates[0]?.value;
}
