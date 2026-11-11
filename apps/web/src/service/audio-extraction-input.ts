import {ApiError} from '../api/client';
import type {NativeGraph} from './graph';
import {canvasSourceMediaReferences} from './canvas-media-reference';
export const isAudioExtraction=(node:any)=>node?.type==='rh-audio'&&String(node.data?.toolsType??'').toUpperCase().replaceAll('-','_')==='VIDEO_AUDIO';
export const audioExtractionBatchError=()=>new ApiError(422,'MEDIA_BATCH_UNAVAILABLE','提取音轨需要从视频节点单独运行，请将音轨节点移出生成分组。');

/** The native extract action copies a video URL into its form AND creates an
 * edge. After any edit only the current edge/selected output identifies the
 * video. Older, standalone file-input forms have neither provenance field. */
export function audioExtractionInput(node:any,graph:NativeGraph):string{
 if(!isAudioExtraction(node)||node.data.modelCode!=='local-video-audio-v1'||node.data.params?.audioSeparationMode!=='all')throw new ApiError(422,'AUDIO_SEPARATION_UNAVAILABLE','请选择“提取全部音频”；人声和背景声分离尚未接入。');
 const incoming=graph.edges.filter(edge=>edge.target===node.id);
 if(!incoming.length){
  const direct=node.data.params?.videoUrl;
  if(!node.data.sourceNodeId&&!node.data.toolsSourceUrl&&typeof direct==='string'&&direct.trim())return direct;
  throw new ApiError(422,'VIDEO_REQUIRED','提取音轨需要一个视频，请连接要提取的视频节点。');
 }
 if(incoming.length!==1)throw new ApiError(422,'VIDEO_REQUIRED','提取音轨只使用一个视频，请只保留一条视频连线。');
 const edge=incoming[0],source=graph.nodes.find(item=>item.id===edge.source);
 if(source?.type!=='rh-video'||edge.sourceHandle!=null&&edge.sourceHandle!=='output'||edge.targetHandle!=null&&edge.targetHandle!=='input')throw new ApiError(422,'VIDEO_REQUIRED','请从视频节点的输出端连接到音轨节点的输入端。');
 const refs=canvasSourceMediaReferences(source,'video');
 if(!refs||refs.length!==1||source.data?.status==='uploading'||source.data?.uploading||source.data?.uploadFailed||source.data?.uploadError)throw new ApiError(422,'VIDEO_REQUIRED','请选择一个已上传完成或已生成的视频结果再提取音轨。');
 return refs[0];
}
export const audioExtractionSpec=(assetId:string)=>({version:1,inputs:[{id:'source',assetId}],tracks:[{type:'audio',clips:[{input:'source'}]}],output:{container:'wav'}});
