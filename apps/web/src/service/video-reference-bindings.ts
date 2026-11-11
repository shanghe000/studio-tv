import {ApiError} from '../api/client';
import type {Capability} from './model-catalog';
import type {NativeGraph} from './graph';
import {nativeVideoReferences} from './video-command';
import {videoParameterMetadata} from './video-parameter-options';

const roles=new Set(['REFERENCE_IMAGE','FIRST_FRAME','LAST_FRAME','MOTION_REFERENCE','SOURCE_VIDEO','MASK','POSE','DEPTH','REFERENCE_AUDIO','VOICE','STYLE','SKETCH']);
const kinds:Record<string,'image'|'video'|'audio'>={imageUrls:'image',videoUrls:'video',audioUrls:'audio'};
/** Reference identities are STUDIO assets. The public role schema assigns their
 * meaning; a label or a filename never changes a conditioning role. */
export function videoPromptSelection(cap:Capability,node:any,graph:NativeGraph,nativeComposer=false){
 const metadata=videoParameterMetadata(cap),declared=metadata?.mediaRoles;
 if(!metadata||!Array.isArray(declared)||!declared.length)return;
 const params=node.data?.params??{},bindings:{assetId:string;role:string;targetAssetId?:string}[]=[];
 const read=(name:string)=>{
  const values=kinds[name]?nativeVideoReferences(node,graph,kinds[name],{nativeComposer}):params[name];
  if(values===undefined||values===null||values==='')return[];
  return Array.isArray(values)?values:[values];
 };
 const id=(value:any)=>typeof value==='string'&&value.startsWith('rhtv-asset:')&&value.length>11?value.slice(11):undefined;
 for(const role of declared as any[]){
  if(!role||!roles.has(role.role)||typeof role.paramName!=='string')throw new ApiError(422,'VIDEO_REFERENCE_SCHEMA_INVALID','当前模型的参考素材配置不完整，请联系管理员。');
  const values=read(role.paramName),selected=role.index===undefined?values:Number.isSafeInteger(role.index)&&role.index>=0?values.slice(role.index,role.index+1):[];
  if(typeof role.minItems==='number'&&selected.length<role.minItems)throw new ApiError(422,'VIDEO_REFERENCE_REQUIRED',`请添加${typeof role.title==='string'?role.title:'所需参考素材'}。`);
  if(typeof role.maxItems==='number'&&selected.length>role.maxItems)throw new ApiError(422,'VIDEO_REFERENCE_LIMIT',`${typeof role.title==='string'?role.title:'当前参考素材'}最多支持 ${role.maxItems} 个。`);
  let targetAssetId:string|undefined;
  if(role.targetParamName!==undefined){
   if(typeof role.targetParamName!=='string')throw new ApiError(422,'VIDEO_REFERENCE_SCHEMA_INVALID','当前模型的遮罩目标配置不完整，请联系管理员。');
   const targets=read(role.targetParamName);targetAssetId=id(targets[role.targetIndex??0]);
   if(selected.length&&!targetAssetId)throw new ApiError(422,'VIDEO_REFERENCE_REQUIRED','请先添加遮罩对应的目标素材。');
  }
  for(const value of selected){const assetId=id(value);if(!assetId)throw new ApiError(422,'ASSET_REFERENCE_REQUIRED','视频参考必须使用已上传的 STUDIO 素材。');
   if(!bindings.some(binding=>binding.assetId===assetId&&binding.role===role.role&&binding.targetAssetId===targetAssetId))bindings.push({assetId,role:role.role,...(targetAssetId?{targetAssetId}:{})});
  }
 }
 const original=node.data?.promptSelection??{};
 return{...original,schemaVersion:'1',referenceBindings:bindings};
}
