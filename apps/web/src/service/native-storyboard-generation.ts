import {ApiError} from '../api/client';
import {cleanJson} from './graph';
import {equalDraftValue} from './canvas-draft';
import {nativeVideoReferences} from './video-command';
import {videoParameterSelection} from './video-parameter-options';
import {capabilityModel} from './execution';

export function nativeStoryboardImage(node:any){
 return node?.type==='rh-image'&&node.data?.isStoryboard===true&&node.data?.sceneCode==='storyboard-prompt-board';
}

function sourceMotionModel(model:any){
 const fields=model?.config?.filter((field:any)=>field?.paramName==='outputPreset'),field=fields?.length===1?fields[0]:undefined,metadata=field?.studioVideoParameterMetadata,guide=model?.studioVideoInputGuidance;
 return model?.modelCode==='h3-motion-transfer-v1'&&model.capabilityRef===model.modelCode&&model.capabilityVersion==='2'&&model.parameterSchemaVersion==='2'
  &&model.kind==='VIDEO_TO_VIDEO'&&model.available===true&&model.testMode===false&&model.model?.providerRef==='comfy'&&model.model.modelRef==='h3'
  &&guide?.schemaVersion==='1'&&guide.mode==='MOTION_TRANSFER'&&guide.available===true&&guide.promptIgnored===true
  &&metadata?.schemaVersion==='1'&&metadata.capabilityRef===model.capabilityRef&&metadata.version==='2'&&metadata.mode==='MOTION_TRANSFER'
  &&metadata.durationPolicy==='SOURCE_VIDEO'&&metadata.sourceSecondsMin===2&&metadata.sourceSecondsMax===30?field:undefined;
}

/** The old composer rebuilds prompt-based video commands before calling STUDIO.
 * This exact source-duration model has no prompt field. Submit its current
 * bound graph after checking the same visible preset and reference resolver;
 * the STUDIO executor still owns permissions, media, parameters and stale edits.
 */
async function runSourceMotion(runtime:any,native:any,nodeId:string,action:any,field:any){
 const manager=native.bt(),projectId=runtime.inspect().id,identity=runtime.auth.user;
 manager?.flushOperationQueue?.(true);
 const context=()=>!!identity&&!!projectId&&runtime.auth.user===identity&&native.bt()===manager&&runtime.inspect().id===projectId;
 const encode=(value:string)=>runtime.storage?.encodeAsset(value)??value,params=cleanJson(action.params??{},encode),model=action.currentModel;
 const fresh=(data:any)=>data?.status==='idle'&&['capabilityRef','capabilityVersion','parameterSchemaVersion'].every(key=>data[key]===undefined)
  &&['taskId','estimateTaskId','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId'].every(key=>data[key]===undefined||data[key]===null||data[key]==='')
  &&data.historyStorage==null&&data.history==null&&['output','nodeOutputHistory'].every(key=>data[key]==null||Array.isArray(data[key])&&!data[key].length);
 const read=()=>{
  if(!context())throw new ApiError(409,'STALE_CANVAS_SESSION','画布或登录状态已变更，请重新打开作品。');
  const original=manager?.getRemoteData(),graph=runtime.storage?.restoreModelBindings?.(projectId,original)??original,safe=cleanJson(graph,encode),node=safe?.nodes?.find((value:any)=>value.id===nodeId),data=node?.data;
  if(node?.type!=='rh-video'||data?.isUpload===true||['running','processing','uploading'].includes(data?.status)||data?.modelCode!==model.capabilityRef)throw new ApiError(409,'STALE_EXECUTION_INPUT','动作模型尚未保存，请确认模型后重新生成。');
  const selected=videoParameterSelection(field,params.outputPreset);
  if(!selected||selected.metadata?.durationPolicy!=='SOURCE_VIDEO'||selected.selected.preset.durationSeconds!==0||data.params?.outputPreset!==selected.selected.value)throw new ApiError(409,'STALE_EXECUTION_INPUT','动作输出规格尚未保存，请确认参数后重新生成。');
  const allowed=new Set(['outputPreset','imageUrls','videoUrls','audioUrls','prompt','text','generateNum','rhModel','aspectRatio']);
  if(Object.keys(params).some(key=>!allowed.has(key))||params.generateNum!==undefined&&params.generateNum!==1||params.rhModel!==undefined&&params.rhModel!==model.capabilityRef||params.aspectRatio!==undefined&&params.aspectRatio!==data.params?.aspectRatio)throw new ApiError(409,'STALE_EXECUTION_INPUT','动作参数与当前画布不一致，请重新生成。');
  const sameText=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&!a.trim()&&!b.trim()||equalDraftValue(a,b);
  if(Object.hasOwn(params,'prompt')&&!sameText(params.prompt,data.params?.prompt??data.prompt??'')||Object.hasOwn(params,'text')&&!sameText(params.text,data.params?.text??data.params?.prompt??data.prompt??''))throw new ApiError(409,'STALE_EXECUTION_INPUT','动作描述尚未保存，请确认当前输入后重新生成。');
  for(const [kind,count]of [['image',1],['video',1],['audio',0]] as const){
   const references=nativeVideoReferences(node,safe,kind),current=params[kind+'Urls']??[];
   if(!references||references.length!==count||!Array.isArray(current)||!equalDraftValue(current,references))throw new ApiError(409,'STALE_EXECUTION_INPUT','动作参考素材与当前画布不一致，请重新添加素材或确认连线。');
  }
  return{original,node,data};
 };
 let current=read();
 if(fresh(current.data)){
  const bindings=runtime.modelBindingPort?.();
  if(!bindings?.current()||typeof runtime.execution.catalog!=='function')throw new ApiError(409,'STALE_EXECUTION_INPUT','动作模型版本尚未确认，请重新选择模型。');
  const rows=await runtime.execution.catalog(),matches=rows.filter((cap:any)=>cap.capabilityRef===model.capabilityRef&&cap.version==='2'&&cap.parameterSchemaVersion==='2'),latest=matches.length===1?sourceMotionModel(capabilityModel(matches[0])):undefined;
  current=read();
  if(!bindings.current()||!fresh(current.data)||!latest||!equalDraftValue(cleanJson(latest.studioVideoParameterMetadata),cleanJson(field.studioVideoParameterMetadata)))throw new ApiError(409,'STALE_EXECUTION_INPUT','动作模型版本已变化，请重新选择模型。');
  const raw=current.original.nodes.find((node:any)=>node.id===nodeId);
  bindings.record(raw,{modelCode:model.capabilityRef,capabilityRef:model.capabilityRef,capabilityVersion:'2',parameterSchemaVersion:'2'});
  current=read();
 }
 if(current.data.capabilityRef!==model.capabilityRef||current.data.capabilityVersion!=='2'||current.data.parameterSchemaVersion!=='2')throw new ApiError(409,'STALE_EXECUTION_INPUT','动作模型尚未保存，请确认模型后重新生成。');
 return runtime.execution.generate(nodeId);
}

/** A board already owns its visible, compiled shot prompt. Native tP/V8 would
 * rebuild it from its parent table and flatten that table's output metadata.
 * Keep the normal action gates, then use the existing guarded STUDIO executor on
 * this exact current node. Parent-table edits require creating boards again.
 */
export async function runNativeNodeGenerationAction(runtime:any,native:any,notice:(text:string)=>void,nodeId:string,action:any,createsResult=false){
 if(action.disabled||action.isGenerating||action.currentModel.available===false)return false;
 const validation=action.preflight?.();if(validation){notice(String(validation));return false;}
 if(createsResult)return action.onClick({cancel:()=>{}});
 const manager=native.bt();
 const original=manager?.getRemoteData()?.nodes.find((node:any)=>node.id===nodeId);
 const sourceMotion=sourceMotionModel(action.currentModel);if(sourceMotion)return runSourceMotion(runtime,native,nodeId,action,sourceMotion);
 if(!nativeStoryboardImage(original))return action.onClick({cancel:()=>{}});
 const projectId=runtime.inspect().id,identity=runtime.auth.user,selection={id:original.data.storyboardRowId,ids:cleanJson(original.data.storyboardRowIds)};
 manager.flushOperationQueue?.(true);
 if(!identity||runtime.auth.user!==identity||native.bt()!==manager||runtime.inspect().id!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布或登录状态已变更，请重新打开分镜。');
 const node=manager.getRemoteData()?.nodes.find((value:any)=>value.id===nodeId),rows=node?.data?.storyboardRowIds;
 if(!nativeStoryboardImage(node)||!Array.isArray(rows)||!rows.length||rows.length>500||rows.some(id=>typeof id!=='string'||!id.trim())||new Set(rows).size!==rows.length||typeof node.data.storyboardRowId!=='string'||!node.data.storyboardRowId.trim()||selection.id!==node.data.storyboardRowId||!equalDraftValue(selection.ids,rows))throw new ApiError(422,'STORYBOARD_SELECTION_INVALID','分镜选择已变化，请从分镜表重新生成。');
 const selected=action.currentModel.modelCode??action.currentModel.capabilityRef;
 if(action.currentModel.available!==true||typeof selected!=='string'||selected!==node.data.modelCode||node.data.capabilityVersion&&action.currentModel.capabilityVersion&&node.data.capabilityVersion!==action.currentModel.capabilityVersion)throw new ApiError(409,'STALE_EXECUTION_INPUT','分镜模型尚未保存，请确认模型后重新生成。');
 const encode=(value:string)=>runtime.storage?.encodeAsset(value)??value;
 for(const key of ['prompt','imageUrls'])if(Object.hasOwn(action.params||{},key)&&!equalDraftValue(cleanJson(action.params[key],encode),cleanJson(node.data.params?.[key],encode)))throw new ApiError(409,'STALE_EXECUTION_INPUT','分镜参数尚未保存，请稍后重新生成。');
 return runtime.execution.generate(nodeId);
}
