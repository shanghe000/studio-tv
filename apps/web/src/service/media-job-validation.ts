import type {Asset} from '../api/types';
import {preflightError,type PreflightIssue} from './preflight';

export const mediaSpeedBounds={min:.25,max:4} as const;
type MediaAsset=Pick<Asset,'id'|'kind'|'durationSeconds'|'width'|'height'>;
const object=(value:any):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value:any,min:number,max:number)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const finite=(value:any,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const id=(value:any)=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\s\\]/.test(value)&&!value.includes('://');
const allowed=(value:Record<string,any>,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
const fail=(message:string,issue:Partial<PreflightIssue>={})=>{throw preflightError('MEDIA_INPUT_INVALID',message,undefined,{requestedKind:'MEDIA',issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',...issue}]});};
const supported=new Set(['CROP','SPEED','REVERSE','ROTATE','MIRROR','ROTATE_MIRROR','TRIM','CONCAT','TRANSCODE','COMPRESS','EXTRACT_AUDIO','AUDIO_EXTRACT','CROP_DURATION','COMPOSE']);

/** Mirror the public media spec and deterministic FFmpeg bounds before any
 * job is created. Asset facts come from the authenticated STUDIO asset response;
 * video audio-stream availability still requires the media decoder. */
export function validateMediaJob(spec:any,operation:unknown,assets:ReadonlyMap<string,MediaAsset>,command:{executor?:unknown;bizType?:unknown}={}){
 if(command.executor!==undefined&&command.executor!==''&&command.executor!=='FFMPEG')fail('当前媒体工具仅支持本地视频处理，请重新打开对应工具。');
 if(command.bizType!==undefined&&command.bizType!==''&&command.bizType!=='CANVAS')fail('媒体任务所属画布无效，请重新打开当前项目。');
 if(!object(spec)||!allowed(spec,['version','inputs','tracks','output'])||!(spec.version===undefined||spec.version===null||spec.version===0||spec.version===1))fail('媒体处理配置版本无效，请重新打开对应工具后再提交。');
 if(!Array.isArray(spec.inputs)||spec.inputs.length<1||spec.inputs.length>16)fail('媒体处理需要1～16项已上传素材，请补齐或减少素材。',{field:'references.count',reason:'COUNT_REQUIRED',minimum:1,maximum:16});
 if(!Array.isArray(spec.tracks)||spec.tracks.length<1||spec.tracks.length>2)fail('媒体处理最多支持一条视频轨道和一条音频轨道，请调整轨道。');
 const inferred=spec.tracks[0]?.type==='compress'?'COMPRESS':spec.tracks[0]?.type==='split'?'TRIM':spec.tracks[0]?.type==='video'?'CONCAT':undefined;
 const op=operation||inferred;if(typeof op!=='string'||!supported.has(op))fail('当前媒体操作尚未支持，请重新选择裁剪、变速、倒放、旋转、拼接、压缩或提取音频。');
 const inputs=new Map<string,MediaAsset>();
 for(const [index,input]of spec.inputs.entries()){
  if(!object(input)||!allowed(input,['id','assetId'])||!id(input.id)||!id(input.assetId)||inputs.has(input.id))fail(`第${index+1}项媒体输入标识无效或重复，请重新添加素材。`,{field:'references.kind',reason:'METADATA_MISSING',inputIndex:index});
  const resolved=assets.get(input.id);if(!resolved||!['IMAGE','VIDEO','AUDIO'].includes(resolved.kind))fail(`第${index+1}项素材缺少有效类型，请重新上传后再提交。`,{field:'references.kind',reason:'METADATA_MISSING',inputIndex:index,assetId:input.assetId});
  const asset=resolved!;
  if(asset.kind!=='IMAGE'&&(!finite(asset.durationSeconds,Number.MIN_VALUE,600)))fail(`第${index+1}项素材需要有效时长且不能超过600秒，请裁剪或重新上传。`,{field:'media.durationMs',reason:typeof asset.durationSeconds==='number'&&asset.durationSeconds>600?'MAXIMUM_EXCEEDED':'METADATA_MISSING',inputIndex:index,assetId:asset.id,maximum:600000});
  inputs.set(input.id,asset);
 }
 const output=spec.output===undefined||spec.output===null?{container:'mp4'}:spec.output;
 if(!object(output))fail('输出配置无效，请重新打开媒体处理工具。');
 if(!allowed(output,['container','fps','width','height','videoCodec','audioCodec','bucket','crf','maxBytes','preset']))fail('输出配置包含当前未支持的参数，请恢复工具中的输出设置。');
 if(!['mp4','webm','mov','wav'].includes(output.container))fail('请选择支持的输出格式：MP4、WebM、MOV或WAV。');
 const fps=output.fps??0,width=output.width??0,height=output.height??0;
 if(!integer(fps,0,60))fail('输出帧率必须为0～60的整数；0表示使用默认帧率。');
 if(!integer(width,0,3840)||!integer(height,0,2160)||(width===0)!==(height===0)||width>0&&(width<2||height<2||width%2!==0||height%2!==0))fail('输出宽高需同时填写，范围为2～3840×2～2160且均为偶数；留空则跟随源素材。',{field:'media.width',reason:'PARAMETER_INVALID'});
 if(output.videoCodec!==undefined&&!['','h264','libx264','vp9','libvpx-vp9'].includes(output.videoCodec)||output.audioCodec!==undefined&&!['','aac','opus','pcm_s16le'].includes(output.audioCodec)||output.bucket!==undefined&&!['','canvas'].includes(output.bucket))fail('输出编码或保存位置不受支持，请恢复工具默认设置。');
 if(!integer(output.maxBytes??0,0,536870912)||output.crf!==undefined&&output.crf!==null&&!integer(output.crf,18,40)||output.preset!==undefined&&!['','veryfast','fast','medium'].includes(output.preset))fail('压缩参数无效：文件大小最多512 MiB，质量值为18～40，编码速度请选择预设选项。');
 const audioOnly=output.container==='wav'||op==='EXTRACT_AUDIO'||op==='AUDIO_EXTRACT';
 if(output.container==='wav'&&(output.preset||output.crf!==undefined&&output.crf!==null||output.videoCodec||fps||width||height||output.audioCodec&&output.audioCodec!=='pcm_s16le'))fail('WAV音频输出不使用视频尺寸、帧率、视频编码或压缩质量参数，请清除这些设置。');
 if(!audioOnly&&output.container==='webm'&&(output.videoCodec&&!['vp9','libvpx-vp9'].includes(output.videoCodec)||output.audioCodec&&output.audioCodec!=='opus'))fail('WebM输出需要VP9视频编码和Opus音频编码，请恢复对应编码选项。');
 if(!audioOnly&&output.container!=='webm'&&(output.videoCodec&&!['h264','libx264'].includes(output.videoCodec)||output.audioCodec&&output.audioCodec!=='aac'))fail('MP4或MOV输出需要H.264视频编码和AAC音频编码，请恢复对应编码选项。');
 const kinds=new Set<string>(),used=new Set<string>();let count=0,effectiveWidth=width,effectiveHeight=height;
 for(const [trackIndex,track]of spec.tracks.entries()){
  const kind=track?.type==='split'||track?.type==='compress'?'video':track?.type;
  if(!object(track)||!allowed(track,['type','clips'])||!['video','audio'].includes(kind)||kinds.has(kind)||!Array.isArray(track.clips)||track.clips.length<1)fail(`第${trackIndex+1}条轨道无效；每种轨道只允许一条且至少包含一个片段。`);
  kinds.add(kind);
  for(const [clipIndex,clip]of track.clips.entries()){
   const label=`第${trackIndex+1}条轨道的第${clipIndex+1}个片段`;
   if(++count>24)fail('一次媒体处理最多24个片段，请拆分后再提交。');
   if(!object(clip)||!allowed(clip,['input','trim','crop','speed','reverse','rotate','mirror'])||!inputs.has(clip.input))fail(`${label}未连接有效素材，请重新选择片段来源。`,{field:'references.kind',reason:'REFERENCE_REQUIRED'});
   used.add(clip.input);const asset=inputs.get(clip.input)!,isAudio=audioOnly||kind==='audio';
   if(isAudio&&asset.kind==='IMAGE'||!isAudio&&asset.kind==='AUDIO')fail(`${label}的素材类型与轨道不匹配，请替换为${isAudio?'带音轨的视频或音频':'视频或图片'}。`,{field:'references.kind',reason:'KIND_MISMATCH',assetId:asset.id,inputKind:asset.kind});
   if(clip.reverse!==undefined&&typeof clip.reverse!=='boolean')fail(`${label}的倒放选项无效，请重新选择。`);
   if(clip.speed!==undefined&&clip.speed!==null&&!finite(clip.speed,mediaSpeedBounds.min,mediaSpeedBounds.max))fail(`${label}的播放速度必须在0.25～4倍之间。`);
   if(clip.rotate!==undefined&&!['','0','90','180','270'].includes(clip.rotate))fail(`${label}的旋转角度需为0、90、180或270度。`);
   if(clip.mirror!==undefined&&!['','horizontal','vertical'].includes(clip.mirror))fail(`${label}的镜像方向需为水平或垂直。`);
   if(kind==='audio'&&(clip.crop||clip.rotate&&clip.rotate!=='0'||clip.mirror))fail(`${label}是音频片段，不能裁剪画面、旋转或镜像。`);
   const trim=clip.trim;
   if(trim!==undefined&&trim!==null){
    if(!object(trim)||!allowed(trim,['startMs','endMs'])||!integer(trim.startMs??0,0,600000)||trim.endMs!==undefined&&trim.endMs!==null&&!integer(trim.endMs,(trim.startMs??0)+1,600000))fail(`${label}的裁剪起止时间无效，请确保结束晚于开始且不超过600秒。`,{field:'media.durationMs',reason:'PARAMETER_INVALID'});
    if(asset.kind!=='IMAGE'&&((trim.startMs??0)>=asset.durationSeconds!*1000||trim.endMs!==undefined&&trim.endMs!==null&&trim.endMs>asset.durationSeconds!*1000+100))fail(`${label}的裁剪范围超出素材时长，请缩短裁剪范围。`,{field:'media.durationMs',reason:'MAXIMUM_EXCEEDED',assetId:asset.id,maximum:Math.round(asset.durationSeconds!*1000)});
   }
   const crop=clip.crop;
   if(crop!==undefined&&crop!==null){
    if(!object(crop)||!allowed(crop,['x','y','width','height'])||!integer(crop.x??0,0,16384)||!integer(crop.y??0,0,16384)||!integer(crop.width,2,3840)||!integer(crop.height,2,2160))fail(`${label}的画面裁剪尺寸无效，请重新框选裁剪区域。`);
    if(!finite(asset.width,2,Number.MAX_SAFE_INTEGER)||!finite(asset.height,2,Number.MAX_SAFE_INTEGER)||(crop.x??0)+crop.width>asset.width!||(crop.y??0)+crop.height>asset.height!)fail(`${label}的裁剪区域超出原画面，或素材缺少尺寸信息，请重新框选或上传。`,{field:'media.width',reason:'MAXIMUM_EXCEEDED',assetId:asset.id});
   }
   if(!isAudio&&!effectiveWidth){
    effectiveWidth=crop?.width??asset.width??0;effectiveHeight=crop?.height??asset.height??0;if(clip.rotate==='90'||clip.rotate==='270')[effectiveWidth,effectiveHeight]=[effectiveHeight,effectiveWidth];effectiveWidth-=effectiveWidth%2;effectiveHeight-=effectiveHeight%2;
    if(!integer(effectiveWidth,2,3840)||!integer(effectiveHeight,2,2160))fail('源画面尺寸缺失或超出当前媒体处理范围，请先设置不超过3840×2160的偶数输出尺寸。',{field:'media.width',reason:'MAXIMUM_EXCEEDED',assetId:asset.id,maximum:3840});
   }
   if(clip.reverse){
    const seconds=((trim?.endMs??(asset.kind==='IMAGE'?3000:asset.durationSeconds!*1000))-(trim?.startMs??0))/1000/(clip.speed??1),videoBytes=isAudio?0:(Math.ceil(seconds*(fps||24))+2)*effectiveWidth*effectiveHeight*4,audioBytes=isAudio?(Math.ceil(seconds*48000)+48000)*2*4:0;
    if(videoBytes+audioBytes>256*1024*1024)fail(`${label}超出倒放处理容量，请缩短片段或降低输出尺寸。`,{field:'media.durationMs',reason:'MAXIMUM_EXCEEDED',assetId:asset.id});
   }
  }
 }
 if(used.size!==inputs.size)fail('存在未被任何片段使用的素材，请移除多余输入。',{field:'references.kind',reason:'REFERENCE_FORBIDDEN'});
 if(!audioOnly&&!kinds.has('video'))fail('视频输出需要视频轨道；纯音频轨道请选择WAV输出。');
 if(output.container==='wav'&&kinds.has('video')&&kinds.has('audio'))fail('WAV输出只支持一条音频来源轨道，请移除另一条轨道。');
 return op;
}
