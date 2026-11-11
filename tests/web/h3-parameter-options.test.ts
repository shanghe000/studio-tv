import {expect,it} from 'vitest';
import {h3ParameterSelection,selectH3Parameter} from '../../apps/web/src/service/h3-parameter-options';
import {h3ParameterVersions,h3UpgradeValue,h3VersionPresets} from '../../apps/web/src/service/h3-parameter-contracts';

function field(ref='h3-first-last-frame-v1',version=h3ParameterVersions[ref],upgrades=false){
 const rows=structuredClone(h3VersionPresets(ref,version)!);
 return{paramName:'outputPreset',paramValue:rows[0].value,studioH3ParameterMetadata:{capabilityRef:ref,version,presets:rows},optionValue:[...rows.map(row=>({value:row.value,disabled:false})),...(upgrades?h3VersionPresets(ref,h3ParameterVersions[ref])!.map(row=>({value:h3UpgradeValue(ref,row.value),disabled:false})):[])]};
}
it('derives four real resolution tiers, requested ratio order and exact 1080P pixels without changing the field',()=>{
 const input=field(),before=structuredClone(input),view=h3ParameterSelection(input,'landscape-480p-10s')!;
 expect(view.ratios.map(row=>row.id)).toEqual(['ultrawide','landscape','standard','square','standard-portrait','portrait']);
 expect(view.ratios.map(row=>row.label)).toEqual(['21:9','16:9','4:3','1:1','3:4','9:16']);
 expect(view.resolutions.map(row=>[row.id,row.label])).toEqual([['480p','480P'],['768p','768P'],['1080p','1080P'],['2k','2K']]);
 const value=selectH3Parameter(view,{resolution:'1080p'});expect(value).toBe('landscape-1080p-10s');
 expect(h3ParameterSelection(input,value)!.selected.preset).toMatchObject({width:1920,height:1088,durationSeconds:10,fps:24});
 expect(input).toEqual(before);
});
it('resolves successive ratio, tier and discrete duration gestures only to advertised complete tuples',()=>{
 const input=field();let value='landscape-480p-5s';
 for(const change of [{ratio:'standard-portrait'},{resolution:'2k'},{durationSeconds:15}]){
  const view=h3ParameterSelection(input,value)!;value=selectH3Parameter(view,change)!;
  expect(input.optionValue.some(option=>option.value===value&&!option.disabled)).toBe(true);
 }
 expect(value).toBe('standard-portrait-2k-15s');
 expect(h3ParameterSelection(input,value)!.selected.preset).toMatchObject({width:1440,height:1920,durationSeconds:15,aspectRatio:'3:4'});
});
it('keeps disabled combinations visible but never returns them as an option value',()=>{
 const input=field();for(const option of input.optionValue)if(option.value.startsWith('ultrawide-')||option.value.startsWith('landscape-2k-'))option.disabled=true;
 const view=h3ParameterSelection(input,'landscape-480p-10s')!;
 expect(view.ratios.find(row=>row.id==='ultrawide')?.disabled).toBe(true);
 expect(view.resolutions.find(row=>row.id==='2k')?.disabled).toBe(true);
 expect(selectH3Parameter(view,{ratio:'ultrawide'})).toBeUndefined();
 expect(selectH3Parameter(view,{resolution:'2k'})).toBeUndefined();
 expect(selectH3Parameter(view,{value:'ultrawide-1080p-10s'})).toBeUndefined();
 const portrait=selectH3Parameter(view,{ratio:'portrait'})!;
 expect(h3ParameterSelection(input,portrait)!.resolutions.find(row=>row.id==='2k')?.disabled).toBe(false);
});
it('retains old TR pixels and uiValue alongside the separately advertised aligned 1080P tuple',()=>{
 const ref='h3-tr-pika-twopass-ref-v1',input=field(ref,'1',true),before=structuredClone(input),old='landscape-1920x1088-8s',view=h3ParameterSelection(input,old)!;
 expect(view.selected).toMatchObject({value:old,resolution:undefined,upgrade:false,preset:{width:1920,height:1088,durationSeconds:8}});
 expect(view.extras.filter(row=>row.preset.width===1920&&row.preset.height===1088)).toHaveLength(1);
 expect(view.extras[0].value).toBe(old);
 expect(selectH3Parameter(view,{ratio:'landscape'})).toBe(old);
 expect(selectH3Parameter(view,{resolution:'1080p'})).toBe(h3UpgradeValue(ref,'landscape-1080p-8s'));
 expect(input).toEqual(before);
});
it('keeps both current TR preset identifiers when their pixels coincide',()=>{
 const input=field('h3-tr-pika-twopass-ref-v1'),old='landscape-1920x1088-8s',view=h3ParameterSelection(input,old)!;
 expect(view.choices.filter(row=>row.preset.width===1920&&row.preset.height===1088)).toHaveLength(2);
 expect(view.selected.value).toBe(old);expect(view.selected.resolution).toBeUndefined();
 expect(selectH3Parameter(view,{resolution:'1080p'})).toBe('landscape-1080p-8s');
 expect(selectH3Parameter(view,{value:old})).toBe(old);
});
it('distinguishes old 768x1376 and current 768x1344 despite their shared canonical preset spelling',()=>{
 const ref='h3-drama-reference-v1',input=field(ref,'1',true),old='portrait-768p-10s',view=h3ParameterSelection(input,old)!;
 expect(view.selected.preset).toMatchObject({width:768,height:1376});expect(view.selected.resolution).toBeUndefined();
 const value=selectH3Parameter(view,{resolution:'768p'});
 expect(value).toBe(h3UpgradeValue(ref,'portrait-768p-10s'));
 expect(h3ParameterSelection(input,value)!.selected.preset).toMatchObject({width:768,height:1344});
 expect(view.extras.some(row=>row.preset.width===768&&row.preset.height===1376)).toBe(true);
 expect(view.extras.some(row=>row.preset.width===1280&&row.preset.height===736)).toBe(true);
});
it('exposes only real discrete duration indices, including a legal explicit historical upgrade',()=>{
 const ref='h3-first-last-frame-v1',input=field(ref,'1',true),view=h3ParameterSelection(input,'480p-landscape-5s')!;
 expect(view.durations).toEqual([5,10,15]);expect(view.durationIndex).toBe(0);
 const next=selectH3Parameter(view,{durationSeconds:view.durations[view.durationIndex+1]});
 expect(next).toBe(h3UpgradeValue(ref,'landscape-480p-10s'));
 expect(h3ParameterSelection(input,next)!.durationIndex).toBe(1);
 expect(selectH3Parameter(view,{durationSeconds:6})).toBeUndefined();
 expect(selectH3Parameter(view,{durationSeconds:NaN})).toBeUndefined();
});
it.each(['h3-first-frame-v1','h3-action-reference-v1','h3-tr-pika-twopass-ref-v1'])('represents the one real duration for %s without manufacturing a range',ref=>{
 const input=field(ref),view=h3ParameterSelection(input,input.paramValue)!;
 expect(view.durations).toHaveLength(1);expect(view.durationIndex).toBe(0);
 expect(selectH3Parameter(view,{durationSeconds:view.durations[0]+1})).toBeUndefined();
});
it.each(['metadata','unknown-ref','version','missing-row','wrong-width','wrong-ratio','duplicate-row','duplicate-option','unknown-option','unknown-value','disabled-value'])('falls back without modifying an unproven field: %s',change=>{
 const input:any=field();let value=input.paramValue;
 if(change==='metadata')delete input.studioH3ParameterMetadata;
 if(change==='unknown-ref')input.studioH3ParameterMetadata.capabilityRef='other';
 if(change==='version')input.studioH3ParameterMetadata.version='unknown';
 if(change==='missing-row')input.studioH3ParameterMetadata.presets.pop();
 if(change==='wrong-width')input.studioH3ParameterMetadata.presets[0].width+=32;
 if(change==='wrong-ratio')input.studioH3ParameterMetadata.presets[0].aspectRatio='16:9';
 if(change==='duplicate-row')input.studioH3ParameterMetadata.presets[1]={...input.studioH3ParameterMetadata.presets[0]};
 if(change==='duplicate-option')input.optionValue.push({...input.optionValue[0]});
 if(change==='unknown-option')input.optionValue.push({value:'not-advertised',disabled:false});
 if(change==='unknown-value')value='not-advertised';
 if(change==='disabled-value')input.optionValue[0].disabled=true;
 const before=structuredClone(input);expect(h3ParameterSelection(input,value)).toBeUndefined();expect(input).toEqual(before);
});
it('uses an advertised default for display only and rejects invented multi-dimensional requests',()=>{
 const input=field(),before=structuredClone(input),view=h3ParameterSelection(input,undefined)!;
 expect(view.selected.value).toBe(input.paramValue);expect(input).toEqual(before);
 expect(selectH3Parameter(view,{ratio:'portrait',resolution:'2k'})).toBeUndefined();
 expect(selectH3Parameter(view,{ratio:'cinemascope'})).toBeUndefined();
 expect(selectH3Parameter(view,{resolution:'720p'})).toBeUndefined();
 expect(selectH3Parameter(view,{})).toBeUndefined();
});
