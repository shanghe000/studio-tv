import type {Capability} from './model-catalog';
import {validateCapabilityParameters} from './schema-parameters';
export const h3Modes:Record<string,string>={FIRST_FRAME:'start-video',FIRST_LAST_FRAME:'start-end-video',OMNI_REFERENCE:'multimodal-video'};
export function isH3(cap:Capability){return cap.available===true&&cap.testMode===false&&cap.model?.modelRef==='h3'&&(!cap.kind||['IMAGE_TO_VIDEO','OMNI_REFERENCE'].includes(cap.kind))&&!!h3Modes[cap.parameterSchema?.['x-video-mode']]&&cap.outputKinds?.includes('VIDEO');}
export function h3OutputPresets(cap:Capability){
 const values=cap.parameterSchema?.properties?.outputPreset?.enum,rows=cap.parameterSchema?.['x-output-presets'];
 if(!Array.isArray(values)||!Array.isArray(rows))return[];
 return rows.filter((row:any)=>row&&values.includes(row.value)&&['width','height','fps'].every(key=>Number.isSafeInteger(row[key])&&row[key]>0)&&typeof row.durationSeconds==='number'&&Number.isFinite(row.durationSeconds)&&row.durationSeconds>0&&typeof row.aspectRatio==='string');
}
export function h3PresetLabel(cap:Capability,value:any){
 const label=cap.parameterSchema?.properties?.outputPreset?.['x-enum-labels']?.[String(value)];if(typeof label==='string')return label;
 const row=h3OutputPresets(cap).find((row:any)=>row.value===value);
 return row?`${row.aspectRatio} · ${row.width}×${row.height} · ${row.durationSeconds} 秒 / ${row.fps}fps`:String(value);
}
export function h3InputError(cap:Capability|undefined,items:{type:string;uploading?:boolean;uploadError?:boolean}[],complete=true):string|null{
 if(!cap||!isH3(cap))return '请选择可用的 H3 模型。';
 if(items.some(x=>x.uploading))return '请等待参考素材上传完成。';
 if(items.some(x=>x.uploadError))return '请重试或移除上传失败的素材。';
 const limits=cap.parameterSchema['x-media-limits']??{},counts:Record<string,number>={};
 for(const item of items){const kind=item.type.toUpperCase();counts[kind]=(counts[kind]??0)+1;if(!['IMAGE','VIDEO','AUDIO'].includes(kind))return 'H3 仅支持图片、视频和音频参考。';}
 const total=cap.parameterSchema['x-media-total-limit']??12;
 if(items.length>total)return `参考素材合计最多 ${total} 个。`;
 for(const [kind,label]of [['IMAGE','图片'],['VIDEO','视频'],['AUDIO','音频']])if((counts[kind]??0)>(limits[kind]??0))return limits[kind]?`当前模型最多支持 ${limits[kind]} 个${label}参考。`:`当前模型不支持${label}参考，请切换 H3 模型。`;
 if(!complete)return null;
 const mode=cap.parameterSchema['x-video-mode'];
 if(mode==='FIRST_FRAME'&&counts.IMAGE!==1)return '首帧视频需要 1 张参考图片，请添加图片或连接上游图片节点到左侧输入端。';
 if(mode==='FIRST_LAST_FRAME'&&counts.IMAGE!==2)return '首尾帧视频需要 2 张图片；请添加图片或连接上游图片节点，按素材顺序分别作为首帧和尾帧。';
 if(!counts.IMAGE&&!counts.VIDEO)return `请添加${limits.VIDEO?'图片或视频':'参考图片'}作为视觉参考，或连接上游素材节点到左侧输入端；当前 H3 不支持纯文字或仅音频生成视频。`;
 return null;
}
export function h3Parameters(cap:Capability,params:Record<string,any>={}){
 const result:Record<string,any>={};
 for(const [key,field]of Object.entries(cap.parameterSchema.properties??{}) as [string,any][]){
  const value=params[key]===undefined?field.default:params[key];if(value!==undefined)result[key]=value;
 }
 validateCapabilityParameters(cap,result);return result;
}
export function h3FileError(file:Pick<File,'type'|'size'>){
 const kind=/^image\/(png|jpeg|webp)$/.test(file.type)?'image':file.type==='video/mp4'?'video':/^audio\/(wav|x-wav|mpeg|mp3)$/.test(file.type)?'audio':null;
 if(!kind)return '请上传 PNG/JPEG/WebP 图片、H.264 MP4 视频或 WAV/MP3 音频。';
 if(file.size>({image:10,video:64,audio:16}[kind])*1024*1024)return `素材超过${{image:'图片 10',video:'视频 64',audio:'音频 16'}[kind]} MiB 上限。`;
 return null;
}
