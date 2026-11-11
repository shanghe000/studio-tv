import {mediaInputContract,officialVideoProvider} from './official-video-input-contract';
import type {Asset} from '../api/types';
import type {Capability} from './model-catalog';
import {preflightError,preflightInputKinds,preflightKind,type PreflightIssue} from './preflight';

type Limits={knownBytesOnly?:boolean;knownMimeOnly?:boolean;minWidth?:number;minHeight?:number;minAspect?:number;maxAspect?:number;mimeTypes?:readonly string[];maxBytes?:number;maxTotalBytes?:number;maxWidth?:number;maxHeight?:number;maxPixels?:number;minDurationMs?:number;maxDurationMs?:number;maxTotalDurationMs?:number};
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const number=(value:number)=>String(Number(value.toFixed(3)));
const size=(value:number)=>number(Math.ceil(value/1048576*1000)/1000);

/** Use the selected model's public contract and resolved STUDIO asset facts.
 * Upload/display metadata and signed media URLs never define these limits. */
export function validateInputMedia(cap:Capability,assets:readonly Asset[]){
 const contract=mediaInputContract(cap);
 if(contract?.schemaVersion!=='1'||!contract.kinds||cap.testMode!==false)return;
 const problems:string[]=[],issues:PreflightIssue[]=[],totals=new Map<string,number>(),bytesByKind=new Map<string,number>();
 for(const [inputIndex,asset]of assets.entries()){
  const limits:Limits|undefined=contract.kinds[asset.kind];if(!limits)continue;
  const label=`第 ${inputIndex+1} 项`+(asset.kind==='IMAGE'?'参考图片':asset.kind==='VIDEO'?'参考视频':'参考音频'),identity={inputKind:preflightKind(asset.kind),inputIndex,assetId:asset.id};
  if(positive(asset.byteSize))bytesByKind.set(asset.kind,(bytesByKind.get(asset.kind)??0)+asset.byteSize);
  const mime=String(asset.mimeType??'').split(';')[0].trim().toLowerCase();
  if(limits.mimeTypes?.length===0){
   problems.push(`${label}没有可用于此模型的文件格式，请移除此参考或切换模型。`);issues.push({...identity,field:'references.kind',reason:'KIND_UNSUPPORTED'});
  }else if(limits.mimeTypes&&(mime||!limits.knownMimeOnly)&&!limits.mimeTypes.includes(mime)){
   problems.push(`${label}的文件格式不受支持，请使用 ${limits.mimeTypes.join(' / ')}。`);issues.push({...identity,field:'references.kind',reason:'KIND_UNSUPPORTED'});
  }
  for(const [field,actual,minimum]of [['media.width',asset.width,limits.minWidth],['media.height',asset.height,limits.minHeight]] as const)if(positive(actual)&&positive(minimum)&&actual<minimum){
   problems.push(`${label}${field==='media.width'?'宽':'高'}为 ${actual} 像素，至少需要 ${minimum} 像素。`);issues.push({...identity,field,reason:'MINIMUM_NOT_MET',actual,minimum});
  }
  if(positive(asset.width)&&positive(asset.height)&&((positive(limits.minAspect)&&asset.width/asset.height<limits.minAspect)||(positive(limits.maxAspect)&&asset.width/asset.height>limits.maxAspect))){
   problems.push(`${label}宽高比须在 ${limits.minAspect}–${limits.maxAspect} 之间，请裁剪后再提交。`);issues.push({...identity,field:'references.kind',reason:'PARAMETER_INVALID',component:'REFERENCES'});
  }
  if(positive(limits.maxBytes)){
   if(!positive(asset.byteSize)&&!limits.knownBytesOnly){problems.push(`${label}缺少有效文件大小，请重新上传后再提交。`);issues.push({...identity,field:'media.byteSize',reason:'METADATA_MISSING'});}
   else if(asset.byteSize>limits.maxBytes){problems.push(`${label}为 ${size(asset.byteSize)} MiB，超过 ${size(limits.maxBytes)} MiB 上限，请${asset.kind==='IMAGE'?'换用更小的参考图片后再提交':'压缩或裁剪后再提交'}。`);issues.push({...identity,field:'media.byteSize',reason:'MAXIMUM_EXCEEDED',actual:asset.byteSize,maximum:limits.maxBytes});}
  }
  const milliseconds=positive(asset.durationSeconds)?Math.round(asset.durationSeconds*1000):0,duration=milliseconds>0?milliseconds:undefined;
  if(positive(limits.minDurationMs)||positive(limits.maxDurationMs)){
   if(duration===undefined){problems.push(`${label}缺少有效时长，请重新上传后再提交。`);issues.push({...identity,field:'media.durationMs',reason:'METADATA_MISSING'});}
   else if(positive(limits.maxDurationMs)&&duration>limits.maxDurationMs){problems.push(`${label}为 ${number(duration/1000)} 秒，超过 ${number(limits.maxDurationMs/1000)} 秒上限，请裁剪后再提交。`);issues.push({...identity,field:'media.durationMs',reason:'MAXIMUM_EXCEEDED',actual:duration,maximum:limits.maxDurationMs});}
   else if(positive(limits.minDurationMs)&&duration<limits.minDurationMs){problems.push(`${label}为 ${number(duration/1000)} 秒，至少需要 ${number(limits.minDurationMs/1000)} 秒，请更换素材后再提交。`);issues.push({...identity,field:'media.durationMs',reason:'MINIMUM_NOT_MET',actual:duration,minimum:limits.minDurationMs});}
  }
  if(duration!==undefined)totals.set(asset.kind,(totals.get(asset.kind)??0)+duration);
  if(positive(limits.maxWidth)||positive(limits.maxHeight)||positive(limits.maxPixels)){
   if(!positive(asset.width)||!positive(asset.height)){
    problems.push(`${label}缺少有效宽高，请重新上传后再提交。`);
    if(!positive(asset.width))issues.push({...identity,field:'media.width',reason:'METADATA_MISSING'});
    if(!positive(asset.height))issues.push({...identity,field:'media.height',reason:'METADATA_MISSING'});
   }else if(positive(limits.maxWidth)&&asset.width>limits.maxWidth||positive(limits.maxHeight)&&asset.height>limits.maxHeight||positive(limits.maxPixels)&&asset.width*asset.height>limits.maxPixels){
    problems.push(`${label}尺寸 ${asset.width}×${asset.height} 超过当前模型限制，请缩小后再提交。`);
    for(const [field,actual,maximum]of [['media.width',asset.width,limits.maxWidth],['media.height',asset.height,limits.maxHeight],['media.pixels',asset.width*asset.height,limits.maxPixels]] as const)if(positive(maximum)&&actual>maximum)issues.push({...identity,field,reason:'MAXIMUM_EXCEEDED',actual,maximum});
   }
  }
 }
 for(const [kind,total]of totals){const limits:Limits=contract.kinds[kind];if(positive(limits.maxTotalDurationMs)&&total>limits.maxTotalDurationMs){problems.push(`参考${kind==='AUDIO'?'音频':'视频'}合计 ${number(total/1000)} 秒，超过 ${number(limits.maxTotalDurationMs/1000)} 秒上限，请裁剪或移除多余素材。`);issues.push({field:'media.totalDurationMs',reason:'MAXIMUM_EXCEEDED',inputKind:preflightKind(kind),actual:total,maximum:limits.maxTotalDurationMs});}}
 for(const [kind,bytes] of bytesByKind){const limits:Limits=contract.kinds[kind];if(positive(limits.maxTotalBytes)&&bytes>limits.maxTotalBytes){problems.push(`参考素材合计 ${size(bytes)} MiB，超过当前模型 ${size(limits.maxTotalBytes)} MiB 上限，请压缩或减少素材。`);issues.push({field:'media.byteSize',reason:'MAXIMUM_EXCEEDED',inputKind:preflightKind(kind),actual:bytes,maximum:limits.maxTotalBytes,component:'REFERENCES'});}}
 // Only embedded media enters the vendor JSON. Seedance exports videos by URL.
 const provider=officialVideoProvider(cap),embedded=provider?assets.filter(asset=>provider!=='volcengine-official'||asset.kind!=='VIDEO').reduce((bytes,asset)=>bytes+(positive(asset.byteSize)?4*Math.ceil(asset.byteSize/3):0),0):0;
 if(embedded>=64*1048576){problems.push('参考素材编码后超过官方服务单次 64 MiB 请求上限，请压缩或减少素材。');issues.push({field:'media.byteSize',reason:'MAXIMUM_EXCEEDED',component:'REFERENCES',actual:embedded,maximum:64*1048576});}
 if(problems.length)throw preflightError('MEDIA_INPUT_INVALID',problems.join('\n'),cap,{requestedKind:cap.kind,inputKinds:preflightInputKinds(assets.map(asset=>asset.kind)),issues});
}

export interface PlannedInputMedia {sourceNodeId:string;kind:string;width?:number;height?:number;durationMs?:number}
/** The coordinator supplies only facts from an exact catalog model/version and
 * selected output preset. This is not an asset: absent dimensions, source-based
 * duration, bytes and other unknown output properties stay unknown. */
export function validatePlannedInputMedia(cap:Capability,plans:readonly PlannedInputMedia[]):void {
 const contract=mediaInputContract(cap);
 if(contract?.schemaVersion!=='1'||!contract.kinds||cap.testMode!==false)return;
 const problems:string[]=[],issues:PreflightIssue[]=[],totals=new Map<string,{duration:number;sources:string[]}>();
 for(const [inputIndex,plan]of plans.entries()){
  const limits:Limits|undefined=contract.kinds[plan.kind];if(!limits)continue;
  const label=`第 ${inputIndex+1} 项上游计划输出`+(plan.kind==='IMAGE'?'图片':plan.kind==='VIDEO'?'视频':plan.kind==='AUDIO'?'音频':'素材'),identity={sourceNodeId:plan.sourceNodeId,inputKind:preflightKind(plan.kind),inputIndex};
  for(const [field,actual,minimum]of [['media.width',plan.width,limits.minWidth],['media.height',plan.height,limits.minHeight]] as const)if(positive(minimum)&&positive(actual)&&actual<minimum){problems.push(`${label}的已知尺寸低于模型下限 ${minimum} 像素，请调整上游输出。`);issues.push({...identity,field,reason:'MINIMUM_NOT_MET',actual,minimum});}
  if(positive(plan.width)&&positive(plan.height)&&((positive(limits.minAspect)&&plan.width/plan.height<limits.minAspect)||(positive(limits.maxAspect)&&plan.width/plan.height>limits.maxAspect))){problems.push(`${label}的已知宽高比须在 ${limits.minAspect}–${limits.maxAspect} 之间，请调整上游输出。`);issues.push({...identity,field:'references.kind',reason:'PARAMETER_INVALID',component:'REFERENCES'});}
  for(const [field,actual,maximum,name]of [['media.width',plan.width,limits.maxWidth,'宽度'],['media.height',plan.height,limits.maxHeight,'高度']] as const)if(positive(actual)&&positive(maximum)&&actual>maximum){
   problems.push(`${label}${name}为 ${number(actual)} 像素，超过当前模型 ${number(maximum)} 像素上限，请先调整上游输出规格。`);issues.push({...identity,field,reason:'MAXIMUM_EXCEEDED',actual,maximum});
  }
  if(positive(plan.width)&&positive(plan.height)&&positive(limits.maxPixels)&&plan.width*plan.height>limits.maxPixels){
   problems.push(`${label}尺寸为 ${number(plan.width)}×${number(plan.height)}，超过当前模型 ${number(limits.maxPixels)} 总像素上限，请先调整上游输出规格。`);issues.push({...identity,field:'media.pixels',reason:'MAXIMUM_EXCEEDED',actual:plan.width*plan.height,maximum:limits.maxPixels});
  }
  if(positive(plan.durationMs)){
   if(positive(limits.maxDurationMs)&&plan.durationMs>limits.maxDurationMs){problems.push(`${label}时长为 ${number(plan.durationMs/1000)} 秒，超过当前模型 ${number(limits.maxDurationMs/1000)} 秒上限，请先调整上游输出规格或拆分流程。`);issues.push({...identity,field:'media.durationMs',reason:'MAXIMUM_EXCEEDED',actual:plan.durationMs,maximum:limits.maxDurationMs});}
   if(positive(limits.minDurationMs)&&plan.durationMs<limits.minDurationMs){problems.push(`${label}时长为 ${number(plan.durationMs/1000)} 秒，当前模型至少需要 ${number(limits.minDurationMs/1000)} 秒，请先调整上游输出规格。`);issues.push({...identity,field:'media.durationMs',reason:'MINIMUM_NOT_MET',actual:plan.durationMs,minimum:limits.minDurationMs});}
   const total=totals.get(plan.kind)??{duration:0,sources:[]};total.duration+=plan.durationMs;total.sources.push(plan.sourceNodeId);totals.set(plan.kind,total);
  }
 }
 for(const [kind,total]of totals){const limits:Limits=contract.kinds[kind];if(positive(limits.maxTotalDurationMs)&&total.duration>limits.maxTotalDurationMs){
  problems.push(`上游计划输出${kind==='AUDIO'?'音频':kind==='VIDEO'?'视频':'素材'}的已知时长合计 ${number(total.duration/1000)} 秒，超过当前模型 ${number(limits.maxTotalDurationMs/1000)} 秒总时长上限，请先调整上游输出规格或减少参考。`);
  for(const sourceNodeId of new Set(total.sources))issues.push({field:'media.totalDurationMs',reason:'MAXIMUM_EXCEEDED',inputKind:preflightKind(kind),sourceNodeId,actual:total.duration,maximum:limits.maxTotalDurationMs});
 }}
 if(problems.length)throw preflightError('MEDIA_INPUT_INVALID',problems.join('\n'),cap,{requestedKind:cap.kind,inputKinds:preflightInputKinds(plans.map(plan=>plan.kind)),issues});
}
