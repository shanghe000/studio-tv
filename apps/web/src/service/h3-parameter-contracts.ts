/** Frozen parameter contracts; these tuples do not assert GPU acceptance. */
export interface H3PresetTuple {value:string;width:number;height:number;aspectRatio:string;durationSeconds:number;fps:number;title?:string}
const names=['landscape','portrait','square','standard','standard-portrait','ultrawide'];
const labels=['16:9','9:16','1:1','4:3','3:4','21:9'];
const tiers=[['480p',[[864,480],[480,864],[480,480],[640,480],[480,640],[1120,480]]],['768p',[[1344,768],[768,1344],[768,768],[1024,768],[768,1024],[1792,768]]],['1080p',[[1920,1088],[1088,1920],[1088,1088],[1440,1088],[1088,1440],[2528,1088]]],['2k',[[2560,1440],[1440,2560],[1440,1440],[1920,1440],[1440,1920],[3360,1440]]]] as const;
export const h3ParameterVersions:Record<string,string>={
 'h3-first-frame-v1':'4','h3-first-last-frame-v1':'4','h3-reference-v1':'4','h3-video-reference-v1':'4',
 'h3-drama-reference-v1':'3','h3-action-reference-v1':'3','h3-sgun-long-reference-v1':'3','h3-tr-pika-twopass-ref-v1':'3',
};
const durations:Record<string,number[]>={'h3-first-frame-v1':[5],'h3-first-last-frame-v1':[5,10,15],'h3-reference-v1':[5,10,15],'h3-video-reference-v1':[5,10,15],'h3-drama-reference-v1':[5,10],'h3-action-reference-v1':[5],'h3-sgun-long-reference-v1':[20,30],'h3-tr-pika-twopass-ref-v1':[8]};
const legacy:Record<string,Record<string,H3PresetTuple[]>>={"h3-drama-reference-v1":{"1":[{"value":"landscape-480p-5s","width":864,"height":480,"aspectRatio":"9:5","durationSeconds":5,"fps":24,"title":"864×480 · 约5秒 · 24fps"},{"value":"portrait-768p-10s","width":768,"height":1376,"aspectRatio":"24:43","durationSeconds":10,"fps":24,"title":"768×1376 · 约10秒 · 24fps"},{"value":"landscape-736p-10s","width":1280,"height":736,"aspectRatio":"40:23","durationSeconds":10,"fps":24,"title":"1280×736 · 约10秒 · 24fps"}]},"h3-action-reference-v1":{"1":[{"value":"landscape-480p-5s","width":864,"height":480,"aspectRatio":"9:5","durationSeconds":5,"fps":24,"title":"864×480 · 约5秒 · 24fps"}]},"h3-sgun-long-reference-v1":{"1":[{"value":"landscape-480p-20s","width":864,"height":480,"aspectRatio":"9:5","durationSeconds":20,"fps":24,"title":"864×480 · 约20秒 · SGUN连续长片"},{"value":"landscape-480p-30s","width":864,"height":480,"aspectRatio":"9:5","durationSeconds":30,"fps":24,"title":"864×480 · 约30秒 · SGUN连续长片"}]},"h3-drama-reference-v2":{"2":[{"value":"landscape-480p-5s","title":"480P · 16:9近似对齐 · 864×480 · 约5秒 · 待GPU验收","width":864,"height":480,"aspectRatio":"9:5","durationSeconds":5,"fps":24},{"value":"portrait-480p-5s","title":"480P · 9:16近似对齐 · 480×864 · 约5秒 · 待GPU验收","width":480,"height":864,"aspectRatio":"5:9","durationSeconds":5,"fps":24},{"value":"square-480p-5s","title":"480P · 1:1 · 480×480 · 约5秒 · 待GPU验收","width":480,"height":480,"aspectRatio":"1:1","durationSeconds":5,"fps":24},{"value":"standard-480p-5s","title":"480P · 4:3 · 640×480 · 约5秒 · 待GPU验收","width":640,"height":480,"aspectRatio":"4:3","durationSeconds":5,"fps":24},{"value":"standard-portrait-480p-5s","title":"480P · 3:4 · 480×640 · 约5秒 · 待GPU验收","width":480,"height":640,"aspectRatio":"3:4","durationSeconds":5,"fps":24},{"value":"ultrawide-480p-5s","title":"480P · 21:9 · 1120×480 · 约5秒 · 待GPU验收","width":1120,"height":480,"aspectRatio":"7:3","durationSeconds":5,"fps":24},{"value":"landscape-768p-5s","title":"768P · 16:9近似对齐 · 1344×768 · 约5秒 · 待GPU验收","width":1344,"height":768,"aspectRatio":"7:4","durationSeconds":5,"fps":24},{"value":"portrait-768p-5s","title":"768P · 9:16近似对齐 · 768×1344 · 约5秒 · 待GPU验收","width":768,"height":1344,"aspectRatio":"4:7","durationSeconds":5,"fps":24},{"value":"square-768p-5s","title":"768P · 1:1 · 768×768 · 约5秒 · 待GPU验收","width":768,"height":768,"aspectRatio":"1:1","durationSeconds":5,"fps":24},{"value":"standard-768p-5s","title":"768P · 4:3 · 1024×768 · 约5秒 · 待GPU验收","width":1024,"height":768,"aspectRatio":"4:3","durationSeconds":5,"fps":24},{"value":"standard-portrait-768p-5s","title":"768P · 3:4 · 768×1024 · 约5秒 · 待GPU验收","width":768,"height":1024,"aspectRatio":"3:4","durationSeconds":5,"fps":24},{"value":"ultrawide-768p-5s","title":"768P · 21:9 · 1792×768 · 约5秒 · 待GPU验收","width":1792,"height":768,"aspectRatio":"7:3","durationSeconds":5,"fps":24}]},"h3-action-reference-v2":{"2":[{"value":"landscape-480p-5s","title":"480P · 16:9近似对齐 · 864×480 · 约5秒 · 待GPU验收","width":864,"height":480,"aspectRatio":"9:5","durationSeconds":5,"fps":24},{"value":"portrait-480p-5s","title":"480P · 9:16近似对齐 · 480×864 · 约5秒 · 待GPU验收","width":480,"height":864,"aspectRatio":"5:9","durationSeconds":5,"fps":24},{"value":"square-480p-5s","title":"480P · 1:1 · 480×480 · 约5秒 · 待GPU验收","width":480,"height":480,"aspectRatio":"1:1","durationSeconds":5,"fps":24},{"value":"standard-480p-5s","title":"480P · 4:3 · 640×480 · 约5秒 · 待GPU验收","width":640,"height":480,"aspectRatio":"4:3","durationSeconds":5,"fps":24},{"value":"standard-portrait-480p-5s","title":"480P · 3:4 · 480×640 · 约5秒 · 待GPU验收","width":480,"height":640,"aspectRatio":"3:4","durationSeconds":5,"fps":24},{"value":"ultrawide-480p-5s","title":"480P · 21:9 · 1120×480 · 约5秒 · 待GPU验收","width":1120,"height":480,"aspectRatio":"7:3","durationSeconds":5,"fps":24},{"value":"landscape-768p-5s","title":"768P · 16:9近似对齐 · 1344×768 · 约5秒 · 待GPU验收","width":1344,"height":768,"aspectRatio":"7:4","durationSeconds":5,"fps":24},{"value":"portrait-768p-5s","title":"768P · 9:16近似对齐 · 768×1344 · 约5秒 · 待GPU验收","width":768,"height":1344,"aspectRatio":"4:7","durationSeconds":5,"fps":24},{"value":"square-768p-5s","title":"768P · 1:1 · 768×768 · 约5秒 · 待GPU验收","width":768,"height":768,"aspectRatio":"1:1","durationSeconds":5,"fps":24},{"value":"standard-768p-5s","title":"768P · 4:3 · 1024×768 · 约5秒 · 待GPU验收","width":1024,"height":768,"aspectRatio":"4:3","durationSeconds":5,"fps":24},{"value":"standard-portrait-768p-5s","title":"768P · 3:4 · 768×1024 · 约5秒 · 待GPU验收","width":768,"height":1024,"aspectRatio":"3:4","durationSeconds":5,"fps":24},{"value":"ultrawide-768p-5s","title":"768P · 21:9 · 1792×768 · 约5秒 · 待GPU验收","width":1792,"height":768,"aspectRatio":"7:3","durationSeconds":5,"fps":24}]},"h3-tr-pika-twopass-ref-v1":{"1":[{"value":"landscape-1920x1088-8s","width":1920,"height":1088,"aspectRatio":"30:17","durationSeconds":8,"fps":24,"title":"1920×1088 · 8秒 · TR双采 · 待手测"}]}};
for(const ref of ['h3-first-frame-v1','h3-first-last-frame-v1','h3-reference-v1','h3-video-reference-v1']){
 const row=(seconds:number):H3PresetTuple=>({value:`480p-landscape-${seconds}s`,width:864,height:480,aspectRatio:'9:5',durationSeconds:seconds,fps:24,title:`864×480 · ${seconds}秒`});
 legacy[ref]={'1':[row(5)],'2':(ref==='h3-first-frame-v1'?[5]:[5,10,15]).map(row)};
}
const current:Record<string,H3PresetTuple[]>={};
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
function parameterPresets(ref:string,seconds:number[],include1080:boolean){
 const rows:H3PresetTuple[]=[];
 for(const [tier,sizes]of tiers){
  if(tier==='1080p'&&!include1080)continue;
  for(const [index,[width,height]]of sizes.entries())for(const durationSeconds of seconds){
   const divisor=gcd(width,height);
   rows.push({value:`${names[index]}-${tier}-${durationSeconds}s`,width,height,aspectRatio:`${width/divisor}:${height/divisor}`,durationSeconds,fps:24,title:`${tier.toUpperCase()}${tier==='1080p'?'（1088对齐）':''} · ${labels[index]} · ${width}×${height} · ${durationSeconds}秒`});
  }
 }
 if(ref==='h3-drama-reference-v1')for(const original of legacy[ref]['1'].slice(1))rows.push({...original,value:original.value==='portrait-768p-10s'?'legacy-portrait-768x1376-10s':original.value});
 if(ref==='h3-tr-pika-twopass-ref-v1')rows.push(...legacy[ref]['1'].map(row=>({...row})));
 return rows;
}
for(const [ref,seconds]of Object.entries(durations)){
 // Keep the previously published three-tier contracts immutable. Existing
 // nodes only move to the fourth tier through an explicit parameter choice.
 const previousVersion=String(Number(h3ParameterVersions[ref])-1);
 legacy[ref]??={};legacy[ref][previousVersion]=parameterPresets(ref,seconds,false);
 current[ref]=parameterPresets(ref,seconds,true);
}
// Add exact seconds without reinterpreting any saved v1–v4 preset.
legacy['h3-video-reference-v1']['4']=current['h3-video-reference-v1'];
current['h3-video-reference-v1']=parameterPresets('h3-video-reference-v1',Array.from({length:11},(_,i)=>i+5),true);
h3ParameterVersions['h3-video-reference-v1']='5';
export function h3VersionPresets(ref:unknown,version:unknown):H3PresetTuple[]|undefined{
 if(typeof ref!=='string'||typeof version!=='string')return;
 return version===h3ParameterVersions[ref]?current[ref]:legacy[ref]?.[version];
}
export function h3ParameterTupleMatches(ref:unknown,version:unknown,row:any){
 if(typeof ref!=='string'||!expandedParameterVersion(ref,version))return false;
 const expected=h3VersionPresets(ref,version)?.find(value=>value.value===row?.value);
 return !!expected&&(['width','height','aspectRatio','durationSeconds','fps'] as const).every(key=>expected[key]===row[key]);
}
function expandedParameterVersion(ref:string,version:unknown){
 const firstExpanded=['h3-first-frame-v1','h3-first-last-frame-v1','h3-reference-v1','h3-video-reference-v1'].includes(ref)?3:2;
 return Object.hasOwn(h3ParameterVersions,ref)&&typeof version==='string'&&Number(version)>=firstExpanded&&!!h3VersionPresets(ref,version);
}
export function h3DisplayRatios(ref:string,version:string,row:H3PresetTuple){
 const aliases=[row.aspectRatio];
 if(expandedParameterVersion(ref,version)||ref==='h3-tr-pika-twopass-ref-v1'&&version==='1'||row.width===864&&row.height===480&&row.durationSeconds===5)aliases.push('16:9');
 return [...new Set(aliases)];
}
export function h3UpgradeValue(ref:string,value:string){return `__h3_upgrade_${h3ParameterVersions[ref]}__${value}`;}
export function h3UpgradePreset(ref:string,version:string,value:unknown){
 if(version===h3ParameterVersions[ref]||typeof value!=='string'||!h3VersionPresets(ref,version))return;
 return current[ref]?.find(row=>h3UpgradeValue(ref,row.value)===value);
}
