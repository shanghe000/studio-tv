import {mediaInputContract} from './official-video-input-contract';
import {uploadMediaTypes,uploadMimeType} from './upload-mime';
import {ApiError} from '../api/client';
import type {Capability} from './model-catalog';
import {h3InputError,h3Parameters,h3FileError,isH3} from './h3-input';
import {preflightError,preflightInputKinds,preflightKind,type PreflightIssue} from './preflight';
import {validateCapabilityParameters} from './schema-parameters';

export const videoModes:Record<string,string>={TEXT_TO_VIDEO:'text-video',FIRST_FRAME:'start-video',FIRST_LAST_FRAME:'start-end-video',LAST_FRAME:'end-video',OMNI_REFERENCE:'multimodal-video',MOTION_TRANSFER:'video-motion-transfer',VIDEO_TO_VIDEO:'video-video',VIDEO_EXTEND:'video-extend'};
export const videoCancelUnsupportedMessage='此视频模型的任务提交后不能停止，请等待生成完成。';
export function videoCancellationReason(cap:Capability|undefined){return cap?.testMode===false&&!!cap.model&&cap.outputKinds?.includes('VIDEO')&&cap.supportsCancel===false?videoCancelUnsupportedMessage:undefined;}
/** New video profiles opt into a versioned public schema. Historical H3 uses
 * its existing strict gate and keeps its immutable parameter contracts. */
export function isVideoProfile(cap:Capability){return cap.testMode===false&&!!cap.model&&cap.outputKinds?.includes('VIDEO')&&cap.parameterSchema?.['x-video-parameter-metadata']?.schemaVersion==='1'&&Object.hasOwn(videoModes,cap.parameterSchema?.['x-video-mode']);}
// File picking checks only facts already known locally. Dimensions, duration,
// total bytes and combinations are validated from READY assets before generation.
export function videoUploadAccept(cap:Capability|undefined):string{
 if(!cap)return '';
 const contract=mediaInputContract(cap),kinds=cap.parameterSchema?.['x-media-limits'];
 return uploadMediaTypes.filter(type=>{
  const mime=uploadMimeType(type),kind=mime.split('/')[0].toUpperCase();
  if(kinds&&!(kinds[kind]>0))return false;
  if(isH3(cap)&&contract?.schemaVersion!=='1')return !h3FileError({type,size:0});
  const formats=contract?.schemaVersion==='1'?contract.kinds?.[kind]?.mimeTypes:undefined;
  return !formats||formats.includes(mime);
 }).join(',');
}
export function videoUploadFileError(cap:Capability,file:File):string|null{
 if(!uploadMediaTypes.some(type=>type===file.type))return `画布不支持此文件格式（${file.type||'未知格式'}）。`;
 const contract=mediaInputContract(cap);
 if(isH3(cap)&&contract?.schemaVersion!=='1')return h3FileError(file);
 const mime=uploadMimeType(file.type),kind=mime.split('/')[0].toUpperCase();
 const limits=contract?.schemaVersion==='1'?contract.kinds?.[kind]:undefined;
 if(limits?.mimeTypes&&!limits.mimeTypes.includes(mime))return `当前模型不支持 ${mime}，允许的格式为 ${limits.mimeTypes.join(' / ')}。`;
 if(Number.isSafeInteger(limits?.maxBytes)&&limits.maxBytes>0&&file.size>limits.maxBytes)return `${file.name} 为 ${Math.ceil(file.size/1048576*100)/100} MiB，超过当前模型 ${limits.maxBytes/1048576} MiB 的上限。`;
 return null;
}
export function videoInputError(cap:Capability|undefined,items:{type:string;uploading?:boolean;uploadError?:boolean}[],complete=true):string|null{
 if(cap&&isH3(cap))return h3InputError(cap,items,complete);
 if(!cap||!isVideoProfile(cap)||!cap.available)return cap?.reason||'请选择可用的视频模型。';
 if(items.some(item=>item.uploading))return '请等待参考素材上传完成。';
 if(items.some(item=>item.uploadError))return '请重试或移除上传失败的素材。';
 const schema=cap.parameterSchema,mode=schema['x-video-mode'];
 if(mode==='TEXT_TO_VIDEO'&&items.length)return '文生视频不使用参考素材，请先移除当前参考素材。';
 const limits=schema['x-media-limits']??{},counts:Record<string,number>={};
 for(const item of items){const kind=item.type.toUpperCase();if(!['IMAGE','VIDEO','AUDIO'].includes(kind))return '请使用当前模型支持的图片、视频或音频参考。';counts[kind]=(counts[kind]??0)+1;}
 const total=schema['x-media-total-limit'];if(typeof total==='number'&&items.length>total)return `参考素材合计最多 ${total} 个，请移除多余素材。`;
 for(const [kind,label]of [['IMAGE','图片'],['VIDEO','视频'],['AUDIO','音频']])if((counts[kind]??0)>(limits[kind]??0))return limits[kind]?`当前模型最多支持 ${limits[kind]} 个${label}参考，请移除多余素材。`:`当前模型不支持${label}参考，请移除对应素材或切换模型。`;
 if(!complete)return null;
 if(mode==='FIRST_FRAME'&&counts.IMAGE!==1)return '首帧视频需要 1 张参考图片。';
 if(mode==='LAST_FRAME'&&counts.IMAGE!==1)return '尾帧视频需要 1 张参考图片。';
 if(mode==='FIRST_LAST_FRAME'&&counts.IMAGE!==2)return '首尾帧视频需要 2 张图片，按添加顺序分别作为首帧和尾帧。';
 const required=Array.isArray(schema['x-media-roles'])?schema['x-media-roles']:[];
 for(const role of required)if(role&&role.minItems>0&&(counts[role.kind]??0)<role.minItems+(Number.isSafeInteger(role.index)?role.index:0))return `请添加${typeof role.title==='string'?role.title:'模型要求的参考素材'}，或将上游${role.kind==='VIDEO'?'视频':role.kind==='AUDIO'?'音频':'图片'}节点连接到本节点左侧输入端。`;
 if(mode==='OMNI_REFERENCE'){
  if(schema['x-reference-requirement']==='ANY_MEDIA'){if(!items.length)return '请添加图片、视频或音频参考。';}
  else if(!counts.IMAGE&&!counts.VIDEO)return '请添加图片或视频作为视觉参考。';
 }
 return null;
}

/** Symbolic counterpart of the user-facing validator. Counts refer to the
 * submitted reference list; no reference URL or arbitrary source value enters
 * diagnostics. Missing requirements are recorded even when no asset exists. */
export function videoInputIssues(cap:Capability|undefined,items:{type:string;uploading?:boolean;uploadError?:boolean}[],complete=true):PreflightIssue[]{
 if(!cap||!cap.available||!isH3(cap)&&!isVideoProfile(cap))return[{field:'model.kind',reason:'MODEL_UNAVAILABLE'}];
 const pending=items.findIndex(item=>item.uploading);if(pending>=0)return[{field:'references.upload',reason:'UPLOAD_PENDING',inputIndex:pending,inputKind:preflightKind(items[pending].type)}];
 const failed=items.findIndex(item=>item.uploadError);if(failed>=0)return[{field:'references.upload',reason:'UPLOAD_FAILED',inputIndex:failed,inputKind:preflightKind(items[failed].type)}];
 const schema=cap.parameterSchema,mode=schema['x-video-mode'],limits=schema['x-media-limits']??{},counts:Record<string,number>={},issues:PreflightIssue[]=[];
 if(mode==='TEXT_TO_VIDEO'&&items.length)return[{field:'references.total',reason:'REFERENCE_FORBIDDEN',actual:items.length,maximum:0}];
 for(const [inputIndex,item]of items.entries()){
  const kind=item.type.toUpperCase();counts[kind]=(counts[kind]??0)+1;
  if(!['IMAGE','VIDEO','AUDIO'].includes(kind))issues.push({field:'references.kind',reason:'KIND_UNSUPPORTED',inputKind:preflightKind(kind),inputIndex,expectedKinds:['IMAGE','VIDEO','AUDIO']});
 }
 if(issues.length)return issues;
 const total=schema['x-media-total-limit']??(isH3(cap)?12:undefined);
 if(typeof total==='number'&&items.length>total)issues.push({field:'references.total',reason:'COUNT_EXCEEDED',actual:items.length,maximum:total});
 for(const kind of ['IMAGE','VIDEO','AUDIO'])if((counts[kind]??0)>(limits[kind]??0))issues.push({field:'references.count',reason:limits[kind]?'COUNT_EXCEEDED':'KIND_UNSUPPORTED',inputKind:preflightKind(kind),actual:counts[kind],maximum:limits[kind]??0});
 if(issues.length||!complete)return issues;
 const expected=mode==='FIRST_FRAME'||mode==='LAST_FRAME'?1:mode==='FIRST_LAST_FRAME'?2:undefined;
 if(expected!==undefined&&(counts.IMAGE??0)!==expected)return[{field:'references.count',reason:'COUNT_REQUIRED',inputKind:'IMAGE',actual:counts.IMAGE??0,expected}];
 if(!isH3(cap))for(const role of Array.isArray(schema['x-media-roles'])?schema['x-media-roles']:[]){const minimum=role?.minItems+(Number.isSafeInteger(role?.index)?role.index:0);if(role?.minItems>0&&(counts[role.kind]??0)<minimum)issues.push({field:'references.count',reason:'REFERENCE_REQUIRED',inputKind:preflightKind(role.kind),actual:counts[role.kind]??0,minimum});}
 if(issues.length)return issues;
 if(isH3(cap)&&!counts.IMAGE&&!counts.VIDEO||mode==='OMNI_REFERENCE'&&schema['x-reference-requirement']!=='ANY_MEDIA'&&!counts.IMAGE&&!counts.VIDEO)return[{field:'references.visual',reason:'REFERENCE_REQUIRED',actual:(counts.IMAGE??0)+(counts.VIDEO??0),minimum:1,expectedKinds:['IMAGE','VIDEO']}];
 if(mode==='OMNI_REFERENCE'&&schema['x-reference-requirement']==='ANY_MEDIA'&&!items.length)return[{field:'references.any',reason:'REFERENCE_REQUIRED',actual:0,minimum:1,expectedKinds:['IMAGE','VIDEO','AUDIO']}];
 return[];
}
export function videoPreflightError(cap:Capability|undefined,items:{type:string;uploading?:boolean;uploadError?:boolean}[],complete=true):ApiError|null {
 const message=videoInputError(cap,items,complete);if(!message)return null;
 const labels:Record<string,string>={IMAGE:'图片',VIDEO:'视频',AUDIO:'音频',UNKNOWN:'未知类型',TEXT:'文字',STRUCTURED:'结构化数据'},kinds=preflightInputKinds(items.map(item=>item.type));
 const counts=kinds.map(kind=>`${labels[kind]} ${items.filter(item=>preflightKind(item.type)===kind).length} 项`).join('、');
 return preflightError('MODEL_INPUT_UNSUPPORTED',`${message}${counts?` 当前参考：${counts}。`:' 当前未添加参考素材。'}`,cap,{requestedKind:cap?.kind,inputKinds:kinds,issues:videoInputIssues(cap,items,complete)});
}

/** Structured values stay typed all the way into Router parameters. */
export function videoParameters(cap:Capability,params:Record<string,any>={}){
 if(isH3(cap))return h3Parameters(cap,params);
 if(!isVideoProfile(cap))throw new ApiError(422,'MODEL_UNAVAILABLE','请选择可用的视频模型。');
 const result:Record<string,any>={};
 for(const [key,field]of Object.entries(cap.parameterSchema.properties??{}) as [string,any][]){
  const value=params[key]===undefined?field.default:params[key];if(value!==undefined)result[key]=structuredClone(value);
 }
 validateCapabilityParameters(cap,result);
 if(Array.isArray(result.subjectMapping))for(const key of ['referenceSubjectIndex','sourceSubjectIndex']){const seen=new Set<any>(),index=result.subjectMapping.findIndex((row:any)=>{if(seen.has(row[key]))return true;seen.add(row[key]);return false;});if(index>=0)throw preflightError('MODEL_PARAMETER_INVALID','每个人物只能参与一组配对，请检查人物编号。',cap,{requestedKind:cap.kind,issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',parameterPath:['subjectMapping',index,key],parameterRule:'uniqueItems'}]});}
 return result;
}
