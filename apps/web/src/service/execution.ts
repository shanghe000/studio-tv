import {canvasFailureSnapshot,type CanvasFailureSnapshot,type SnapshotIntent,type SnapshotDom} from './canvas-failure-snapshot';
import {validatePublishedImagePreset} from './image-preset-readiness';
import {canvasImageSource,restoreCommandSourceTypes} from './canvas-media-reference';
import {SketchProgress,sketchStyles} from './sketchboard';
import {SketchModelSelections,sketchModel} from './sketchboard-models';
import {completeNativeGroupCommand} from './native-group-command';
import {completeNativeVideoCommand,nativeVideoReferences,projectNativeVideoInputs,nativeVideoComposedPrompt,restoreSavedVideoSourceMetadata,canvasMediaInputProjection} from './video-command';
import {resolveSavedVideoMode} from './native-video-mode';
import {ApiError} from '../api/client';
import {randomUuid,sha256Hex} from '../browser-compat';
import {ProductClient} from './product-client';
import {ServiceStorage} from './storage';
import {canvasRequestDeadline} from './canvas-request-deadline';
import {cleanJson,decodeGraph,type NativeGraph} from './graph';
import {equalDraftValue} from './canvas-draft';
import type {NodeExecutionState} from './canvas-sync';
import {HistoryAdapter} from './history';
import {legacyStoryboardResult,scriptTerminalFields,storyboardOutput} from './storyboard-output';
import {fitsInputs,menuCapabilities,modelChoice,modelSelections,selectedModel,selectCapability,resolveCapability,textKind,type ModelScope,type ModelChoice,type Capability,type ModelPolicy} from './model-catalog';
import {rememberModelSource} from './model-catalog-view';
import {officialVideoProvider} from './official-video-input-contract';
import {readinessMediaLimit} from './connection-readiness';
import {routerParameters} from './native-parameters';
import {nativeQuickSceneAlias,quickSceneCodes} from './image-quick-scenes';
import {imageBatchPlan,localImageBatch} from './image-batch-output';
import {completeNativeImageToolCommand,nativePortraitPortDefaults,restoreSavedImageUploadMetadata,restoreCapturedImageResultMetadata} from './image-tool-command';
import {nativeImageComposedPrompt,nativeImageComposedReferences,usesNativeImageInputs,nativeImagePromptCodes,normalizeNativeImagePrompt,type NativeTextProjection} from './image-prompt-projection';
import {semanticImageModel,semanticImageTools,semanticImageV3Tools,nativePortraitAlias,nativePanoramaAlias,panoramaScenes} from './image-semantic-tools';
import type {GenerationProgress} from './generation-progress';
import {h3PresetLabel,h3OutputPresets,isH3} from './h3-input';
import {isVideoCapability,videoParameterMetadata} from './video-parameter-options';
import {videoPromptSelection} from './video-reference-bindings';
import {videoInputGuidance} from './video-input-guidance';
import {isVideoProfile,videoPreflightError,videoParameters,videoCancellationReason,videoCancelUnsupportedMessage} from './video-input';
import {isNativeRegionTransient} from './native-region-transient';
import {validateInputMedia,validatePlannedInputMedia,type PlannedInputMedia} from './input-media-constraints';
import {executionInputFailure,executionDifference,draftConflictDiagnostic} from './execution-consistency';
import {preflightContext,preflightError,preflightInputKinds,withPreflightContext,type PreflightContext,type PreflightIssue} from './preflight';
import {isAudioExtraction,audioExtractionInput,audioExtractionSpec,audioExtractionBatchError} from './audio-extraction-input';
import {validateMediaJob} from './media-job-validation';
export type {Capability} from './model-catalog';
import {validateGenerationGraph,generationReadinessIssue,generationNodeName,isGenerationMaterialNode,isGenerationTarget,type GenerationReadiness,type GenerationReadinessIssue,type GenerationPreparationOptions} from './generation-readiness';
import type {Asset} from '../api/types';

// /canvas-runs validates the command and checks its revision before creating a
// task. A traced refusal at that point releases this attempt's native busy mark.
// Unknown failures, including an interrupted response after commit, retain it.
const canvasRefusalCodes: Record<number, ReadonlySet<string>> = {
  412: new Set(['VERSION_CONFLICT']),
  422: new Set([
    'MEDIA_INPUT_INVALID', 'VALIDATION_FAILED', 'GENERATION_TARGET_REQUIRED', 'INVALID_REQUEST',
    'CAPABILITY_UNAVAILABLE', 'UNTRUSTED_PROMPT_INSTRUCTIONS', 'PROMPT_CAPABILITY_MISMATCH',
    'PROMPT_CONDITIONING_INVALID', 'PROMPT_REFERENCE_REQUIRED', 'PROMPT_SPEC_INVALID',
  ]),
  501: new Set([
    'MODEL_ROUTER_NOT_CONFIGURED', 'PROMPT_TEMPLATE_NOT_CONFIGURED',
    'PROMPT_CONDITIONING_UNSUPPORTED', 'MODEL_EXECUTION_DISABLED',
  ]),
};
function definiteCanvasRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && typeof error.requestId === 'string' && !!error.requestId.trim()
    && canvasRefusalCodes[error.status]?.has(error.code) === true;
}

export const nativeKinds:Record<string,string>={
 TEXT_IMAGE:'TEXT_TO_IMAGE',IMAGE_IMAGE:'IMAGE_TO_IMAGE',TEXT_VIDEO:'TEXT_TO_VIDEO',IMAGE_VIDEO:'IMAGE_TO_VIDEO',START_VIDEO:'IMAGE_TO_VIDEO',START_END_VIDEO:'IMAGE_TO_VIDEO',END_VIDEO:'IMAGE_TO_VIDEO',MULTIMODAL_VIDEO:'OMNI_REFERENCE',
 MULTIMODAL_TEXT:'LLM',MULTIMODAL_STORYBOARD:'LLM',TEXT_TEXT:'LLM',TEXT_SCRIPT:'LLM',SCRIPT_STORYBOARD:'LLM',TEXT_STORYBOARD:'LLM',IMAGE_TEXT:'LLM',IMAGE_STORYBOARD:'LLM',VIDEO_TEXT:'LLM',VIDEO_STORYBOARD:'LLM',VIDEO_ANALYSIS:'LLM',IMAGE_RECOGNITION:'LLM',TEXT_LYRICS:'LLM',
 IMAGE_EDIT:'IMAGE_EDIT',IMAGE_REDRAW:'IMAGE_TO_IMAGE',IMAGE_ERASE:'IMAGE_TO_IMAGE',IMAGE_EXPAND:'IMAGE_TO_IMAGE',IMAGE_CUTOUT:'IMAGE_TO_IMAGE',IMAGE_CUTOUT_TEXT:'IMAGE_TO_IMAGE',IMAGE_LAYER_DECOMPOSITION:'IMAGE_LAYER_DECOMPOSITION',
 IMAGE_ENHANCE:'IMAGE_TO_IMAGE',IMAGE_GIGAPIXEL:'IMAGE_ENHANCE',IMAGE_HD:'IMAGE_ENHANCE',IMAGE_MULTIANGLE:'IMAGE_TO_IMAGE',IMAGE_LIGHT:'IMAGE_TO_IMAGE',IMAGE_MULTI_ANGLE:'IMAGE_TO_IMAGE',IMAGE_MULTI_ANGLE_LIGHT:'IMAGE_TO_IMAGE',
 VIDEO_VIDEO:'VIDEO_TO_VIDEO',VIDEO_EDIT:'VIDEO_TO_VIDEO',VIDEO_EXTEND:'VIDEO_TO_VIDEO',VIDEO_MOTION_TRANSFER:'VIDEO_TO_VIDEO',VIDEO_CLIP_RESHOOT:'VIDEO_TO_VIDEO',
 VIDEO_HD:'VIDEO_ENHANCE',VIDEO_EXPAND:'VIDEO_ENHANCE',VIDEO_ENHANCE:'VIDEO_ENHANCE',VIDEO_REMOVE_WATERMARK:'VIDEO_ENHANCE',VIDEO_REMOVE_SUBTITLES:'VIDEO_ENHANCE',VIDEO_REMOVE_BLUR:'VIDEO_ENHANCE',VIDEO_DENOISE:'VIDEO_ENHANCE',VIDEO_INTERPOLATION:'VIDEO_ENHANCE',VIDEO_FRAME_INTERPOLATION:'VIDEO_ENHANCE',
 TEXT_AUDIO:'TEXT_TO_AUDIO',TEXT_MUSIC:'TEXT_TO_MUSIC',TEXT_SONG:'TEXT_TO_MUSIC',AUDIO_AUDIO:'AUDIO_TO_AUDIO',AUDIO_SEPARATION:'AUDIO_SEPARATION',VIDEO_AUDIO:'AUDIO_SEPARATION',VIDEO_DEPTH_CONVERTER:'VIDEO_DEPTH',
 TEXT_TO_3D:'GENERATE_3D_MODEL',IMAGE_TO_3D:'GENERATE_3D_MODEL',MULTIVIEW_TO_3D:'GENERATE_3D_MODEL',TEXT_TO_W3D:'GENERATE_3D_WORLD',IMAGE_TO_W3D:'GENERATE_3D_WORLD',VIDEO_TO_W3D:'GENERATE_3D_WORLD',
};
export interface StudioOutput {type:string;text?:string;assetId?:string;mimeType?:string;width?:number;height?:number;durationMs?:number;schemaVersion?:string;data?:any;id?:string;outputId?:string;deletedAt?:string|null}
export interface TerminalNodeUpdate {nodeId:string;taskId:string;projectId:string;manager:any;status:'SUCCESS'|'FAILED'|'CANCELLED'}
export interface NativeRunningLease {current():boolean;accepted?(taskId:string,current:()=>boolean):void}
export interface NativeRunningPort {capture(nodeId:string,manager:any):NativeRunningLease|undefined}
export interface TransientNodeSettlement {nodeId:string;taskId?:string;projectId:string;manager:any;kind:'DETACHED'|'NOT_SUBMITTED';reason?:string;current():boolean}
interface LocalAttempt {order:number;epoch:number;manager:any;projectId:string;nodeIdentity:any;lease:NativeRunningLease;baselineTaskId:string;submitted:boolean;taskId?:string}
interface PendingSettlement {attempt:LocalAttempt;kind:TransientNodeSettlement['kind'];taskId?:string;executionId?:string;reason?:string}
interface RecoveredRun {nodeId:string;taskId:string;epoch:number;projectId:string;manager:any;nodeIdentity:any;lease:NativeRunningLease;previousAttempt?:LocalAttempt;expiresAt:number;controller:AbortController;detached?:{executionId:string;reason?:string}}
interface AppPlan {appId:string;revision:number;fields:any[];cap:Capability;parameters:Record<string,any>;outputKind:string}
interface PreflightTarget {projectId:string;nodeId:string;sceneCode?:string;preflight?:PreflightContext}
interface PreflightAsset {assetId:string;inputKind:PreflightIssue['inputKind'];sourceNodeId:string;asset?:Asset}
export interface PromptSelection {
 schemaVersion:'1';featureCode?:string;sceneCode?:string;presetSelections?:any;promptCodes?:string[];
 conditions?:Record<string,any>;referenceBindings?:{assetId:string;role:string;targetAssetId?:string}[];
 messages?:{role:'USER'|'ASSISTANT';text?:string;assetIds?:string[]}[];
}
export function appOutputKind(content:any,nativeOutput?:string){
 const declared=String(content.outputType??nativeOutput??'').toUpperCase();
 const kinds:Record<string,string>={TEXT:'LLM',STRING:'LLM',IMAGE:'TEXT_TO_IMAGE',VIDEO:'TEXT_TO_VIDEO',AUDIO:'TEXT_TO_AUDIO',MODEL:'GENERATE_3D_MODEL','3D':'GENERATE_3D_MODEL',WORLD:'GENERATE_3D_WORLD'};
 if(kinds[declared])return kinds[declared];if(Object.values(nativeKinds).includes(declared))return declared;
 // Captured apps declare their output category in actual catalog tags even when outputType is absent.
 const tags=(content.tags||[]).flatMap((tag:any)=>typeof tag==='object'?[tag.name,tag.nameEn]:[tag]).filter(Boolean);
 for(const [pattern,kind]of [[/^(?:文生视频|图生视频|视频生视频|Text-to-Video|Image-to-Video|Video-to-Video)$/i,'TEXT_TO_VIDEO'],[/^(?:文生图|图生图|Text-to-Image|Image-to-Image)$/i,'TEXT_TO_IMAGE'],[/^(?:音频生成|Audio Generation|Text-to-Audio)$/i,'TEXT_TO_AUDIO']] as const)if(tags.some((tag:string)=>pattern.test(tag)))return kind;
 return null;
}
const terminal=new Set(['SUCCEEDED','SUCCESS','FAILED','CANCELLED','CANCELED','COMPLETED','DONE','ERROR']);
const nativeState=(state:string)=>/SUCCEEDED|COMPLETED|SUCCESS|DONE/.test(state)?'SUCCESS':/CANCEL/.test(state)?'CANCELLED':/FAILED|ERROR/.test(state)?'FAILED':'RUNNING';
const qs=(body:any,fields:Record<string,string>)=>{const params=new URLSearchParams();for(const [source,target]of Object.entries(fields))if(body[source]!==undefined&&body[source]!==null&&body[source]!=='')params.set(target,String(body[source]));return params.toString();};

export function modelKindLabel(kind:string,en=false){
 const labels:Record<string,[string,string]>={LLM:['文字与理解','Text & understanding'],TEXT_TO_IMAGE:['图片生成','Image generation'],IMAGE_TO_IMAGE:['图片编辑','Image editing'],IMAGE_TO_VIDEO:['图生视频','Image to video'],TEXT_TO_VIDEO:['文生视频','Text to video'],OMNI_REFERENCE:['全能参考','Multimodal reference'],VIDEO_TO_VIDEO:['视频编辑','Video editing'],TEXT_TO_AUDIO:['音频生成','Audio generation'],TEXT_TO_MUSIC:['音乐生成','Music generation'],AUDIO_TO_AUDIO:['音频编辑','Audio editing'],IMAGE_ENHANCE:['画质增强','Image enhancement'],VIDEO_ENHANCE:['视频增强','Video enhancement'],AUDIO_SEPARATION:['音频分离','Audio separation'],GENERATE_3D_MODEL:['3D 模型','3D models'],GENERATE_3D_WORLD:['3D 世界','3D worlds']};
 return labels[kind]?.[en?1:0]??kind.toLowerCase().replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
}
export function capabilityModel(cap:Capability){
 const schema=cap.parameterSchema||{},required=new Set(schema.required||[]),inputGuidance=videoInputGuidance(cap),promptRequired=inputGuidance?!inputGuidance.promptIgnored:schema['x-prompt-policy']==='required'||required.has('prompt');
 const source=schema['x-model-source'],modelSource=rememberModelSource(cap.capabilityRef,source&&['SELF_HOSTED','API'].includes(source.kind)?{kind:source.kind,...(typeof source.credentialProviderRef==='string'?{credentialProviderRef:source.credentialProviderRef}:{})}:undefined);
 const videoMetadata=videoParameterMetadata(cap),presetLabel=(value:any)=>{
  const row=videoMetadata?.presets.find(row=>row.value===value);
  return row?[row.resolution?.toUpperCase(),row.aspectRatio==='adaptive'?'自动匹配参考素材':row.aspectRatio,videoMetadata?.durationPolicy==='SOURCE_VIDEO'?'跟随动作视频':row.durationSeconds===-1?'智能跟随':`${row.durationSeconds}秒`].filter(Boolean).join(' · '):schema['x-output-presets']?h3PresetLabel(cap,value):schema.properties?.outputPreset?.enum?.length===1?schema.properties.outputPreset.title:String(value);
 };
 // Native generateNum is the image batch size inside one canvas task. Keep
 // its original quantity control instead of rendering a second count field.
 const nativeImageCount=!!cap.model&&['TEXT_TO_IMAGE','IMAGE_TO_IMAGE'].includes(cap.kind)&&schema.properties?.count?.type==='integer'&&Array.isArray(schema.properties.count.enum)&&schema.properties.count.enum.length>0;
 const optionLabel=(paramName:string,p:any,value:any)=>paramName==='outputPreset'&&videoMetadata?.durationPolicy==='SOURCE_VIDEO'?presetLabel(value):p['x-enum-labels']?.[String(value)]||(paramName==='outputPreset'?presetLabel(value):String(value));
 const config=Object.entries(schema.properties||{}).filter(([name])=>!(nativeImageCount&&name==='count')&&!(schema['x-prompt-policy']==='ignored'&&name==='prompt')).map(([paramName,p]:[string,any])=>({
  paramName:paramName==='reasoningEffort'?'reasoning_effort':paramName,paramDataType:p.type==='integer'?'int':p.type==='number'?'float':p.type==='array'?(p.items?.type==='object'?'arrayObject':'arrayString'):p.type||'string',
  type:paramName==='subjectMapping'&&schema['x-subject-control']?.mode==='MULTI'?'studioSubjectMapping':paramName==='prompt'?'prompt':p.enum?'list':p.type==='boolean'?'boolean':p.type==='integer'?'int':p.type==='number'?'float':/image/i.test(paramName)?(p.type==='array'?'imageUrls':'imageUrl'):/video/i.test(paramName)?(p.type==='array'?'videoUrls':'videoUrl'):/audio/i.test(paramName)?(p.type==='array'?'audioUrls':'audioUrl'):'text',
  title:paramName==='reasoningEffort'?'推理强度':paramName==='transparentBackground'?'透明背景':p.title||paramName,titleEn:paramName==='reasoningEffort'?'ReasoningEffort':p.title||paramName,description:p.description,display:true,required:paramName==='prompt'?promptRequired:required.has(paramName),paramValue:p.default,
  ...(p.enum||p.type==='boolean'?{optionValue:(p.enum||[true,false]).map((value:any)=>({value,labelCn:paramName==='reasoningEffort'&&['low','high'].includes(value)?value==='low'?'Low':'High':optionLabel(paramName,p,value),labelEn:paramName==='reasoningEffort'&&['low','high'].includes(value)?value==='low'?'Low':'High':optionLabel(paramName,p,value)}))}:{}),
  min:p.minimum,max:p.maximum,minLength:p.minLength,maxLength:p.maxLength,maxNum:p.maxItems,
  ...(paramName==='outputPreset'&&isH3(cap)?{studioH3ParameterMetadata:{capabilityRef:cap.capabilityRef,version:cap.version,presets:structuredClone(h3OutputPresets(cap))}}:{}),
  ...(paramName==='outputPreset'&&videoMetadata?{studioVideoParameterMetadata:videoMetadata}:{}),
  ...(paramName==='outputPreset'&&inputGuidance?{studioVideoInputGuidance:inputGuidance}:{}),
  ...(paramName==='subjectMapping'&&schema['x-subject-control']?{studioVideoSubjectMetadata:{control:structuredClone(schema['x-subject-control']),parameterSchema:structuredClone(p)}}:{}),
 }));
 const title=(cap.testMode?'[TEST MODE] ':'')+(cap.title||cap.model?.title||cap.capabilityRef);
 if(schema['x-prompt-policy']!=='ignored'&&!config.some(field=>field.paramName==='prompt'))config.unshift({paramName:'prompt',paramDataType:'string',type:'prompt',title:'描述',titleEn:'Prompt',description:undefined,display:true,required:promptRequired,paramValue:undefined,min:undefined,max:undefined,minLength:undefined,maxLength:undefined,maxNum:undefined});
 // Native reference controls describe input parts. They never become Router
 // parameters unless the advertised parameter schema separately declares them.
 if(cap.model&&cap.inputKinds?.includes('IMAGE')&&!config.some(field=>field.type==='imageUrls'||field.type==='imageUrl'))config.push({paramName:'imageUrls',paramDataType:'arrayString',type:'imageUrls',title:'参考图片',titleEn:'Reference images',description:undefined,display:true,required:false,paramValue:undefined,min:undefined,max:undefined,minLength:undefined,maxLength:undefined,maxNum:cap.capabilityRef==='codex-image-edit-v1'?cap.version==='3'?4:1:undefined});
 const mediaLimits=schema['x-media-limits'];
 if(mediaLimits){for(const field of config)if(field.type==='imageUrls')field.maxNum=mediaLimits.IMAGE;
  for(const [kind,key,label]of [['AUDIO','audioUrls','音频参考'],['VIDEO','videoUrls','视频参考']])if(mediaLimits[kind]>0&&!config.some(field=>field.paramName===key))config.push({paramName:key,paramDataType:'arrayString',type:key,title:label,titleEn:label,description:schema['x-media-descriptions']?.[kind],display:true,required:false,paramValue:undefined,min:undefined,max:undefined,minLength:undefined,maxLength:undefined,maxNum:mediaLimits[kind]});
 }
 if(Array.isArray(schema['x-media-roles']))for(const field of config){
  const roles=schema['x-media-roles'].filter((role:any)=>role&&typeof role.title==='string'&&(role.paramName===field.paramName||!role.paramName&&({IMAGE:'imageUrls',VIDEO:'videoUrls',AUDIO:'audioUrls'} as Record<string,string>)[role.kind]===field.paramName));
  if(roles.length){field.title=roles.map((role:any)=>role.title).join(' / ');field.description=roles.map((role:any)=>[role.title,typeof role.description==='string'?role.description:''].filter(Boolean).join('：')).join('；');field.required=roles.some((role:any)=>Number.isSafeInteger(role.minItems)&&role.minItems>0);}
 }
 return{id:cap.capabilityRef,modelCode:cap.capabilityRef,kind:cap.kind,modelName:title,modelNameEn:title,modelType:['LLM','IMAGE_UNDERSTANDING'].includes(cap.kind)?'LLM':'OPENAPI',description:cap.reason||schema.description||'',descriptionEn:cap.reason||schema.description||'',generateNum:cap.parameterSchema?.properties?.count?.enum||[1],config,available:cap.available,disabled:!cap.available,reason:cap.reason??null,capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,testMode:!!cap.testMode,inputKinds:cap.inputKinds,outputKinds:cap.outputKinds,...(modelSource?{'x-model-source':modelSource}:{}),...(typeof cap.supportsCancel==='boolean'?{supportsCancel:cap.supportsCancel}:{}),...(inputGuidance?{studioVideoInputGuidance:inputGuidance}:{}),...(isH3(cap)?{h3OutputPresets:structuredClone(h3OutputPresets(cap))}:{}),...(cap.model?{model:cap.model}:{})};
}
// Keep stable node/edge order for reference ordering and CanvasGuard. The
// editable document stays complete; the execution snapshot contains the target
// and its incoming dependency closure, never an unrelated branch of the canvas.
function executionAncestors(graph:NativeGraph,targetId:string){
 const parents=new Map<string,string[]>();for(const edge of graph.edges){const row=parents.get(edge.target);if(row)row.push(edge.source);else parents.set(edge.target,[edge.source]);}
 const ids=new Set<string>([targetId]),pending=[targetId];while(pending.length)for(const source of parents.get(pending.pop()!)??[])if(!ids.has(source)){ids.add(source);pending.push(source);}
 return ids;
}
function nodeExecutionGraph(graph:NativeGraph,targetId:string):NativeGraph{
 const ids=executionAncestors(graph,targetId);return {nodes:graph.nodes.filter(n=>ids.has(n.id)),edges:graph.edges.filter(e=>ids.has(e.target))};
}
function generationScopeGraph(graph:NativeGraph,roots:string[]):NativeGraph{
 const ids=generationMembers(graph,roots);
 for(const id of [...ids])for(const source of executionAncestors(graph,id))ids.add(source);
 // Keep invalid incoming edges in scope so missing references are explained;
 // unrelated branches cannot block this group's otherwise valid generation.
 return{nodes:graph.nodes.filter(node=>ids.has(node.id)),edges:graph.edges.filter(edge=>ids.has(edge.target))};
}
function generationMembers(graph:NativeGraph,roots:string[]){
 const children=new Map<string,string[]>(),link=(p:any,id:any)=>{if(typeof p==='string'&&typeof id==='string'){const list=children.get(p)||[];list.push(id);children.set(p,list);}};
 for(const n of graph.nodes){link(n.parentId,n.id);link(n.parentNode,n.id);if(['group','rh-group'].includes(n.type)&&Array.isArray(n.data?.nodeIds))for(const child of n.data.nodeIds)link(n.id,child);}
 const ids=new Set(roots),pending=[...roots];while(pending.length)for(const child of children.get(pending.pop()!)||[])if(!ids.has(child)){ids.add(child);pending.push(child);}return ids;
}
export class ExecutionAdapter {
 readonly sketchModels=new SketchModelSelections();
 readonly sketchProgress=new SketchProgress();
 private epoch=0;
 private canvasLeasePort:{flushPending:(projectId:string)=>Promise<void>|void;acquire:(projectId:string,nodeIds:string[])=>Promise<void>|void}|null=null;
 setCanvasLeasePort(port:typeof this.canvasLeasePort){this.canvasLeasePort=port;}
 private nativeTextProjection:{project:NativeTextProjection}|null=null;
 private readinessListeners=new Set<()=>void>();
 getGenerationCapabilities(){return structuredClone([...this.capabilities.values()]);}
 subscribeGenerationReadiness(listener:()=>void){this.readinessListeners.add(listener);return()=>this.readinessListeners.delete(listener);}
 setNativeTextProjection(project:NativeTextProjection){
  if(typeof project!=='function')return()=>{};
  const port={project};this.nativeTextProjection=port;
  return()=>{if(this.nativeTextProjection===port)this.nativeTextProjection=null;};
 }
 private capabilities=new Map<string,Capability>();
 private failureTargets=new WeakMap<ApiError,PreflightTarget>();
 private reportedFailures=new WeakSet<Error>();
 private nativeIntent?:(projectId:string,targetId:string,targetType:string)=>SnapshotIntent|undefined;
 setNativeSubmitIntent(take:(projectId:string,targetId:string,targetType:string)=>SnapshotIntent|undefined){
  this.nativeIntent=take;return ()=>{if(this.nativeIntent===take)this.nativeIntent=undefined;};
 }
 private diagnosticSelection?:()=>readonly string[];
 private diagnosticDom?:(project:string,node:string)=>SnapshotDom|undefined;
 setDiagnosticDom(read:(project:string,node:string)=>SnapshotDom|undefined){
  this.diagnosticDom=read;return ()=>{if(this.diagnosticDom===read)this.diagnosticDom=undefined;};
 }
 setDiagnosticSelection(read:()=>readonly string[]){
  this.diagnosticSelection=read;
  return ()=>{if(this.diagnosticSelection===read)this.diagnosticSelection=undefined;};
 }
 private captureFailureSnapshot(projectId:string, intent:SnapshotIntent, command?:NativeGraph):CanvasFailureSnapshot|undefined {
  try {
   const mounted=this.projectId===projectId?this.manager?.getRemoteData():undefined;
   const selected=intent.selected??(mounted?this.diagnosticSelection?.():undefined);
   // Frozen tools sometimes queue the new node for insertion until submit.
   // Prefer the mounted page unless only the actual command contains its target.
   const mountedTarget=mounted?.nodes?.some((node:any)=>node?.id===intent.targetId);
   const commandTarget=command?.nodes?.some((node:any)=>node?.id===intent.targetId);
   const page=mounted&&(mountedTarget||!commandTarget)?mounted:command;
   const result:CanvasFailureSnapshot|undefined=canvasFailureSnapshot(page,{...intent,selected},command,mounted);
   if(!result)return;
   result.source=page===mounted?'MOUNTED':'COMMAND';
   const revision=this.storage.snapshots.get(projectId)?.revision;
   if(revision!==undefined&&Number.isSafeInteger(revision)&&revision>=0)result.revision=revision;
   return result;
  }catch{return;} // Diagnostic projection must never affect the actual operation.
 }
 private attemptSnapshots=new WeakMap<Error,CanvasFailureSnapshot>();
 private acceptedResponseErrors=new WeakSet<Error>();
 private progressViews=new Map<string,GenerationProgress>();
 private progressListeners=new Set<()=>void>();
 readonly subscribeProgress=(listener:()=>void)=>{this.progressListeners.add(listener);return()=>{this.progressListeners.delete(listener);};};
 nodeProgress(nodeId:string){const value=this.progressViews.get(nodeId),node=this.manager?.getRemoteData()?.nodes?.find((row:any)=>row.id===nodeId);return value&&node?.data?.taskId===value.taskId?value:undefined;}
 private recordProgress(task:any){
  let changed=false;
  for(const plan of task.plans){
   const previous=this.progressViews.get(plan.nodeId),active=this.nodeTasks.get(plan.nodeId)?.id;
   if(active&&active!==task.id||task.projectId&&task.projectId!==this.projectId)continue;
   const value:GenerationProgress={taskId:task.id,state:plan.state??task.state,progress:typeof plan.progress==='number'&&Number.isFinite(plan.progress)&&plan.progress>=0&&plan.progress<=1?plan.progress:null,progressDetail:plan.progressDetail??null};
   if(JSON.stringify(previous)!==JSON.stringify(value)){this.progressViews.set(plan.nodeId,value);changed=true;}
  }
  if(changed)for(const listener of this.progressListeners)listener();
 }
 private clearProgress(){if(this.progressViews.size){this.progressViews.clear();for(const listener of this.progressListeners)listener();}}
 private catalogCache=new Map<string,{items:Capability[];expiresAt:number}>();
 private catalogPending=new Map<string,{promise:Promise<Capability[]>;controller:AbortController}>();
 private capabilityReads=new Set<AbortController>();
 private polls=new Map<string,AbortController>();
 private manager:any=null;
 private projectId:string|null=null;
 private applied=new Map<string,string>();
 private nodeTasks=new Map<string,{id:string;order:number;revision:number;canvasRevision?:number}>();
 private nonCancelableVideoTasks=new Set<string>();
 private submissionSequence=0;
 private terminalListeners=new Set<(update:TerminalNodeUpdate)=>void>();
 private terminalUpdates=new Map<string,{update:TerminalNodeUpdate;signature:string}>();
 private historyOutputs=new Map<string,{historyId:string;outputId:string}>();
 private submissions=new Map<string,Promise<{taskId:string;testMode:boolean}>>();
 private imageProjections=new Set<string>();
 private waits=new Map<ReturnType<typeof setTimeout>,()=>void>();
 private detachedNotices=new Set<string>();
 private runningPort?:NativeRunningPort;
 private localAttempts=new Map<string,LocalAttempt>();
 private settlements=new Map<string,PendingSettlement>();
 private recoveredRuns=new Map<string,RecoveredRun>();
 private settlementListeners=new Set<(update:TransientNodeSettlement)=>void>();
 private readonly historyReader:HistoryAdapter;
 constructor(readonly api:ProductClient,readonly storage:ServiceStorage,readonly saved:()=>Promise<void>,readonly notice:(message:string)=>void,private readonly modelPolicy:ModelPolicy={}){this.historyReader=new HistoryAdapter(api,(output,testMode)=>this.output(output,testMode),(id,mapping)=>this.historyOutputs.set(id,mapping));}
 onTerminal(listener:(update:TerminalNodeUpdate)=>void){this.terminalListeners.add(listener);for(const {update,signature}of this.terminalUpdates.values())if(this.manager===update.manager&&this.projectId===update.projectId&&this.nodeTasks.get(update.nodeId)?.id===update.taskId&&this.applied.get(update.nodeId)===signature&&this.manager.getRemoteData()?.nodes.some((node:any)=>node.id===update.nodeId&&node.data?.taskId===update.taskId))listener(update);return()=>{this.terminalListeners.delete(listener);};}
 onSettled(listener:(update:TransientNodeSettlement)=>void){this.settlementListeners.add(listener);return()=>{this.settlementListeners.delete(listener);};}
 installNativeRunningPort(port:NativeRunningPort){this.runningPort=port;return()=>{if(this.runningPort===port){this.runningPort=undefined;this.stopRecoveredRuns();this.localAttempts.clear();this.settlements.clear();}};}
 private stopRecoveredRuns(nodeId?:string){for(const [id,run]of this.recoveredRuns)if(nodeId===undefined||id===nodeId){run.controller.abort();this.recoveredRuns.delete(id);}}
 private recoveredCurrent(run:RecoveredRun){
  if(this.recoveredRuns.get(run.nodeId)!==run||run.controller.signal.aborted||Date.now()>=run.expiresAt||this.epoch!==run.epoch||this.projectId!==run.projectId||this.manager!==run.manager||this.nodeIdentity(run.manager,run.nodeId)!==run.nodeIdentity||!run.lease.current()||this.localAttempts.get(run.nodeId)!==run.previousAttempt)return false;
  const node=run.manager.getRemoteData()?.nodes.find((value:any)=>value.id===run.nodeId),tasks=[node?.data?.taskId,node?.data?.estimateTaskId].map(value=>String(value??'').trim()).filter(Boolean),cached=this.nodeTasks.get(run.nodeId)?.id;
  return !!node&&['rh-text','rh-image','rh-video','rh-audio'].includes(node.type)&&tasks.every(id=>id===run.taskId)&&(!cached||cached===run.taskId);
 }
 private drainRecoveredRuns(){
  for(const run of this.recoveredRuns.values()){if(!run.detached)continue;if(!this.recoveredCurrent(run)){this.stopRecoveredRuns(run.nodeId);continue;}if(['running','processing','uploading'].includes(run.manager.getRemoteData()?.nodes.find((node:any)=>node.id===run.nodeId)?.data?.status))continue;
   const current=()=>this.recoveredCurrent(run)&&!['running','processing','uploading'].includes(run.manager.getRemoteData()?.nodes.find((node:any)=>node.id===run.nodeId)?.data?.status),update:TransientNodeSettlement={nodeId:run.nodeId,taskId:run.taskId,projectId:run.projectId,manager:run.manager,kind:'DETACHED',reason:run.detached.reason,current};
   for(const listener of this.settlementListeners){if(!current())break;try{listener(update);}catch(error){this.notice(error instanceof Error?error.message:'本地生成状态未能更新。');}}
   if(this.localAttempts.get(run.nodeId)===run.previousAttempt)this.localAttempts.delete(run.nodeId);if(this.settlements.get(run.nodeId)?.attempt===run.previousAttempt)this.settlements.delete(run.nodeId);if(this.recoveredRuns.get(run.nodeId)===run)this.stopRecoveredRuns(run.nodeId);
  }
 }
 /** Only the native remembered-run TTL seam supplies lookup candidates. The
  * authenticated task response, rather than canvas hints, proves completion. */
 recoverNativeRunning(nodeId:string,manager:any,taskId:string,ttl:number){
  if(!taskId||!Number.isFinite(ttl)||ttl<=0||this.manager!==manager||!this.projectId)return false;
  const existing=this.recoveredRuns.get(nodeId);if(existing?.taskId===taskId&&this.recoveredCurrent(existing))return true;
  if(this.polls.has(taskId))return false;
  const previousAttempt=this.localAttempts.get(nodeId),nodeIdentity=this.nodeIdentity(manager,nodeId);if(previousAttempt?.lease.current()&&(previousAttempt.taskId!==taskId||previousAttempt.manager!==manager||previousAttempt.projectId!==this.projectId||previousAttempt.nodeIdentity!==nodeIdentity))return false;
  const lease=previousAttempt?.lease.current()?previousAttempt.lease:nodeIdentity?this.runningPort?.capture(nodeId,manager):undefined;if(!lease?.current())return false;
  this.stopRecoveredRuns(nodeId);const run:RecoveredRun={nodeId,taskId,epoch:this.epoch,projectId:this.projectId,manager,nodeIdentity,lease,previousAttempt,expiresAt:Date.now()+ttl,controller:new AbortController()};this.recoveredRuns.set(nodeId,run);if(!this.recoveredCurrent(run)){this.stopRecoveredRuns(nodeId);return false;}
  const pause=(delay:number)=>new Promise<void>((resolve,reject)=>{if(run.controller.signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}const timer=setTimeout(()=>{run.controller.signal.removeEventListener('abort',abort);resolve();},Math.min(delay,Math.max(1,run.expiresAt-Date.now()))),abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};run.controller.signal.addEventListener('abort',abort,{once:true});});
  void(async()=>{let failures=0;try{while(this.recoveredCurrent(run)){
   let task:any;try{task=(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(taskId),{signal:run.controller.signal})).data;}catch(error){if(!this.recoveredCurrent(run))break;if(error instanceof ApiError&&error.status<500||++failures>=3)throw error;await pause(250*failures);continue;}if(!this.recoveredCurrent(run))break;
   const plan=task?.plans?.[0],states=['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED'];
   if(task?.id!==taskId||task.projectId!==run.projectId||task.kind!=='CANVAS'||task.targetType!=='NODE'||task.targetId!==nodeId||task.canvasManaged!==true||!Array.isArray(task.plans)||task.plans.length!==1||plan.nodeId!==nodeId||!plan.executionId||!states.includes(task.state)||!states.includes(plan.state)||!this.serverManaged(task))break;
   run.lease.accepted?.(taskId,()=>this.recoveredCurrent(run));
   if(terminal.has(task.state)){if(terminal.has(plan.state)&&plan.canvasBinding.applicationState==='DETACHED'){run.detached={executionId:plan.executionId,reason:plan.canvasBinding.reason};this.detached(taskId,plan.executionId,plan.canvasBinding.reason);this.drainRecoveredRuns();}
    // A late native TTL mark can follow an already consumed coherent terminal
    // snapshot. Reuse only that exact sync notification; GET never invents it.
    else if(terminal.has(plan.state)&&plan.canvasBinding.applicationState==='APPLIED'){const known=this.terminalUpdates.get(nodeId),signature=JSON.stringify(['server',taskId,plan.executionId,plan.state,'APPLIED']),current=()=>this.recoveredCurrent(run)&&known?.signature===signature&&this.applied.get(nodeId)===signature&&this.nodeTasks.get(nodeId)?.id===taskId&&manager.getRemoteData()?.nodes.some((node:any)=>node.id===nodeId&&node.data?.taskId===taskId&&node.data?.status===(nativeState(plan.state)==='SUCCESS'?'finished':nativeState(plan.state)==='FAILED'?'failed':'idle'));
     if(known)for(const listener of this.terminalListeners){if(!current())break;try{listener(known.update);}catch(error){this.notice(error instanceof Error?error.message:'原生执行状态未能更新。');}}
    }break;}
   await pause(1000);
  }}catch(error){if(this.recoveredCurrent(run))this.notice(error instanceof Error?error.message:'任务状态查询失败。');}finally{if(this.recoveredRuns.get(nodeId)===run&&!run.detached)this.stopRecoveredRuns(nodeId);}})();return true;
 }
 setModelSelection(scope:ModelScope,kind:string,choice?:ModelChoice){const key=scope+':'+kind;if(choice)modelSelections.set(key,choice);else modelSelections.delete(key);}
 modelSelection(scope:ModelScope,kind:string){return modelSelections.get(scope+':'+kind);}
 clear(){this.clearProgress();this.sketchProgress.clear();this.sketchModels.clear();modelSelections.clear();this.epoch++;const changed=new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。');for(const pending of this.catalogPending.values())pending.controller.abort(changed);for(const controller of this.capabilityReads)controller.abort(changed);this.capabilityReads.clear();this.catalogPending.clear();this.catalogCache.clear();this.stopRecoveredRuns();this.historyReader.clear();for(const [timer,reject]of this.waits){clearTimeout(timer);reject();}this.waits.clear();for(const c of this.polls.values())c.abort();this.polls.clear();this.capabilities.clear();this.nonCancelableVideoTasks.clear();this.applied.clear();this.imageProjections.clear();this.terminalUpdates.clear();this.nodeTasks.clear();this.detachedNotices.clear();this.localAttempts.clear();this.settlements.clear();this.submissionSequence=0;this.historyOutputs.clear();this.submissions.clear();this.manager=null;this.projectId=null;}
 /** Release only browser watchers. Accepted server jobs keep running and are
  * recovered from their authoritative snapshot on the next attachment. */
 detach(){this.clearProgress();this.stopRecoveredRuns();for(const c of this.polls.values())c.abort();this.polls.clear();this.applied.clear();this.terminalUpdates.clear();this.nodeTasks.clear();this.localAttempts.clear();this.settlements.clear();this.manager=null;this.projectId=null;}
 attach(id:string,manager:any){if(this.projectId!==id||this.manager!==manager){this.clearProgress();this.stopRecoveredRuns();for(const c of this.polls.values())c.abort();this.polls.clear();this.applied.clear();this.terminalUpdates.clear();this.nodeTasks.clear();this.localAttempts.clear();this.settlements.clear();for(const node of manager?.getRemoteData()?.nodes||[])if(node.data?.taskId)this.nodeTasks.set(node.id,{id:String(node.data.taskId),order:0,revision:-1});}this.projectId=id;this.manager=manager;for(const node of manager?.getRemoteData()?.nodes||[])if(node.data?.taskId&&(['running','processing'].includes(node.data?.status)||legacyStoryboardResult(node)||node.type==='rh-script'&&node.data.status==='finished'&&Object.keys(scriptTerminalFields(node.data)).length))this.watch(String(node.data.taskId));}
 private check(epoch:number){if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。');}
 private serverManaged(task:any){
  if(task.canvasManaged===undefined||task.canvasManaged===false){if((task.plans||[]).some((plan:any)=>plan.canvasBinding!==undefined))throw new ApiError(502,'INVALID_CANVAS_EXECUTION','任务的画布回写凭据无效。');return false;}
  if(task.canvasManaged!==true||!task.id||!Array.isArray(task.plans)||!task.plans.length||task.plans.some((plan:any)=>!plan.nodeId||!plan.executionId||!['PENDING','APPLIED','DETACHED'].includes(plan.canvasBinding?.applicationState)))throw new ApiError(502,'INVALID_CANVAS_EXECUTION','任务的画布回写凭据无效。');
  this.recordProgress(task);
  return true;
 }
 private detached(taskId:string,executionId:string,reason?:string){
  const key=JSON.stringify([taskId,executionId,reason]);if(this.detachedNotices.has(key))return;this.detachedNotices.add(key);
  const messages:Record<string,string>={OUTPUT_UNAVAILABLE:'生成结果的素材已不可用，本次结果未能写回画布。',INPUT_UNAVAILABLE:'生成输入已不可用，本次结果未能写回画布。',RESULT_TOO_LARGE:'生成结果超过画布大小限制，本次结果未能写回画布，可在历史记录中查看。'};
  this.notice(messages[reason||'']||'画布已更改，本次生成结果保留在历史记录中。');
 }
 private nodeIdentity(manager:any,id:string){return manager?.ynodes?.toArray?.().find((row:any)=>String(row?.get?.('id')??row?.toJSON?.()?.id)===id);}
 private settlementCurrent(nodeId:string,pending:PendingSettlement){
  const attempt=pending.attempt;if(this.settlements.get(nodeId)!==pending||this.localAttempts.get(nodeId)!==attempt||attempt.epoch!==this.epoch||this.manager!==attempt.manager||this.projectId!==attempt.projectId||this.nodeIdentity(attempt.manager,nodeId)!==attempt.nodeIdentity||!attempt.lease.current())return false;
  if(pending.kind==='DETACHED'&&(attempt.taskId!==pending.taskId||this.nodeTasks.get(nodeId)?.id!==pending.taskId)||pending.kind==='NOT_SUBMITTED'&&attempt.submitted)return false;
  const node=attempt.manager.getRemoteData()?.nodes.find((value:any)=>value.id===nodeId),taskId=String(node?.data?.taskId||'');return !!node&&(pending.kind==='DETACHED'?!taskId||taskId===pending.taskId:taskId===attempt.baselineTaskId)&&!['running','processing','uploading'].includes(node.data?.status);
 }
 private drainSettlements(){
  for(const [nodeId,pending]of this.settlements){if(!this.settlementCurrent(nodeId,pending))continue;
   const {attempt,kind,taskId,reason}=pending,update:TransientNodeSettlement={nodeId,...(taskId?{taskId}:{}),projectId:attempt.projectId,manager:attempt.manager,kind,...(reason?{reason}:{}),current:()=>this.settlementCurrent(nodeId,pending)};
   for(const listener of this.settlementListeners){if(!update.current())break;try{listener(update);}catch(error){this.notice(error instanceof Error?error.message:'本地生成状态未能更新。');}}
   if(this.settlements.get(nodeId)===pending)this.settlements.delete(nodeId);if(this.localAttempts.get(nodeId)===attempt)this.localAttempts.delete(nodeId);
  }
 }
 private settleDetached(taskId:string,plan:any){
  const attempt=this.localAttempts.get(plan.nodeId);if(!attempt||attempt.taskId!==taskId)return;
  this.settlements.set(plan.nodeId,{attempt,kind:'DETACHED',taskId,executionId:plan.executionId,reason:plan.canvasBinding.reason});this.drainSettlements();
 }
 /** Called only after the coherent server snapshot has reached this manager.
  * Task receipts never persist a second copy of server-managed outputs. */
 syncApplied(projectId:string,manager:any,states:readonly NodeExecutionState[],graphRevision?:number){
  if(this.projectId!==projectId||this.manager!==manager)return;
  const epoch=this.epoch,graph=manager.getRemoteData();
  for(const state of states){
   const node=graph?.nodes.find((value:any)=>value.id===state.nodeId);if(!node||node.data?.taskId!==state.taskId)continue;
   const previous=this.nodeTasks.get(state.nodeId),snapshotRevision=graphRevision??this.storage.snapshots.get(projectId)?.revision;
   if(previous?.id!==state.taskId&&previous?.canvasRevision!==undefined&&snapshotRevision!==undefined&&snapshotRevision<=previous.canvasRevision)continue;
   this.nodeTasks.set(state.nodeId,{id:state.taskId,order:previous?.id===state.taskId?previous.order:++this.submissionSequence,revision:previous?.id===state.taskId?previous.revision:-1,...(previous?.id===state.taskId&&previous.canvasRevision!==undefined?{canvasRevision:previous.canvasRevision}:{})});
   const status=nativeState(state.state);if(!terminal.has(state.state))continue;
   if(state.applicationState==='DETACHED'){this.detached(state.taskId,state.executionId,state.reason);continue;}
   if(state.applicationState!=='APPLIED'||node.data?.status!==(status==='SUCCESS'?'finished':status==='FAILED'?'failed':'idle'))continue;
   const signature=JSON.stringify(['server',state.taskId,state.executionId,state.state,state.applicationState]);if(this.applied.get(state.nodeId)===signature)continue;
   this.applied.set(state.nodeId,signature);
   const update:TerminalNodeUpdate={nodeId:state.nodeId,taskId:state.taskId,projectId,manager,status:status as TerminalNodeUpdate['status']};this.terminalUpdates.set(state.nodeId,{update,signature});
   for(const listener of this.terminalListeners){if(epoch!==this.epoch||this.manager!==manager||this.projectId!==projectId||this.nodeTasks.get(state.nodeId)?.id!==state.taskId||this.applied.get(state.nodeId)!==signature||!manager.getRemoteData()?.nodes.some((value:any)=>value.id===state.nodeId&&value.data?.taskId===state.taskId))break;try{listener(update);}catch(error){this.notice(error instanceof Error?error.message:'原生执行状态未能更新。');}}
  }
  this.drainSettlements();
  this.drainRecoveredRuns();
 }
 invalidateCatalog(){for(const pending of this.catalogPending.values())pending.controller.abort();this.catalogPending.clear();this.catalogCache.clear();for(const listener of this.readinessListeners)listener();}
 async catalog(kind?:string){
  const key=kind||'',cached=this.catalogCache.get(key);
  // This memory cache only supplies menus. Every submitted job still passes
  // the server's current authorization and capability-version validation.
  if(cached&&cached.expiresAt>Date.now())return structuredClone(cached.items);
  const existing=this.catalogPending.get(key);if(existing)return structuredClone(await existing.promise);
  const epoch=this.epoch,controller=new AbortController(),pending={controller,promise:Promise.resolve([] as Capability[])};
  pending.promise=this.loadCatalog(kind,controller.signal).then(items=>{this.check(epoch);this.catalogCache.set(key,{items,expiresAt:Date.now()+30_000});return items;}).finally(()=>{if(this.catalogPending.get(key)===pending)this.catalogPending.delete(key);});
  this.catalogPending.set(key,pending);return structuredClone(await pending.promise);
 }
 private async loadCatalog(kind:string|undefined,signal:AbortSignal){
  const epoch=this.epoch,items:Capability[]=[],seen=new Set<string>();let cursor='';
  do{const query=new URLSearchParams({limit:'100',...(kind?{kind}:{}),...(cursor?{cursor}:{})});const page=(await canvasRequestDeadline(signal,(request,onReadProgress)=>this.api.requestV2<any>('/model-capabilities?'+query,{signal:request,onReadProgress}))).data;this.check(epoch);if(!Array.isArray(page.items))throw new ApiError(502,'INVALID_RESPONSE','模型目录响应格式错误。');items.push(...page.items);const next=page.nextCursor||'';if(next&&seen.has(next))throw new ApiError(502,'INVALID_RESPONSE','模型目录分页游标重复。');seen.add(next);cursor=next;}while(cursor);
  items.sort((a,b)=>Number(this.defaultReal(b))-Number(this.defaultReal(a)));if(!kind)this.capabilities.clear();else for(const [ref,cap]of this.capabilities)if(cap.kind===kind)this.capabilities.delete(ref);for(const item of items)this.capabilities.set(item.capabilityRef,item);for(const listener of this.readinessListeners)listener();return items;
 }
 private async readCapabilityVersion(path:string){
  const controller=new AbortController();this.capabilityReads.add(controller);
  try{return await canvasRequestDeadline(controller.signal,(signal,onReadProgress)=>this.api.requestV2(path,{signal,onReadProgress}));}
  finally{this.capabilityReads.delete(controller);}
 }
 private defaultReal(c:Capability){return c.available&&c.testMode===false&&c.executionKind==='AGENT'&&['LLM','IMAGE_UNDERSTANDING'].includes(c.kind);}
 private fits(c:Capability,inputs:string[]){return fitsInputs(c,inputs);}
 private nativeInputs(type:string){if(semanticImageTools.has(type))return ['IMAGE'];return ['VIDEO_ANALYSIS','VIDEO_TEXT','VIDEO_STORYBOARD'].includes(type)?['VIDEO']:['IMAGE_RECOGNITION','IMAGE_TEXT','IMAGE_STORYBOARD'].includes(type)?['IMAGE']:[];}
 private modelsForType(caps:Capability[],type:string){
 if(type==='VIDEO_AUDIO')return[capabilityModel({capabilityRef:'local-video-audio-v1',version:'1',title:'提取全部音频',kind:'AUDIO_SEPARATION',available:true,testMode:false,executionKind:'MODEL',model:{providerRef:'studio',modelRef:'ffmpeg-audio',title:'提取全部音频',version:'1'},inputKinds:['VIDEO'],outputKinds:['AUDIO'],parameterSchemaVersion:'1',parameterSchema:{type:'object',properties:{},additionalProperties:false}})];
 return (['MULTIMODAL_TEXT','MULTIMODAL_STORYBOARD'].includes(type)?[...menuCapabilities(caps,'LLM',[],this.modelPolicy),...menuCapabilities(caps,'IMAGE_UNDERSTANDING',['IMAGE'],this.modelPolicy)]:menuCapabilities(caps,nativeKinds[type]||type,this.nativeInputs(type),this.modelPolicy,/VIDEO/.test(type))).filter(cap=>{
  const mode=cap.parameterSchema?.['x-video-mode'];if(!mode)return true;
  const modes:Record<string,string[]>={TEXT_VIDEO:['TEXT_TO_VIDEO'],IMAGE_VIDEO:['FIRST_FRAME','LAST_FRAME'],START_VIDEO:['FIRST_FRAME'],END_VIDEO:['LAST_FRAME'],START_END_VIDEO:['FIRST_LAST_FRAME'],MULTIMODAL_VIDEO:['OMNI_REFERENCE'],VIDEO_MOTION_TRANSFER:['MOTION_TRANSFER'],VIDEO_VIDEO:['VIDEO_TO_VIDEO','MOTION_TRANSFER'],VIDEO_EDIT:['VIDEO_TO_VIDEO'],VIDEO_EXTEND:['VIDEO_EXTEND'],VIDEO_CLIP_RESHOOT:['VIDEO_TO_VIDEO']};
  return modes[type]?.includes(mode)??false;
 }).filter(cap=>!semanticImageV3Tools.has(type)||cap.capabilityRef==='codex-image-edit-v1'&&cap.version==='3'&&cap.available&&cap.testMode===false).map(cap=>semanticImageModel(capabilityModel(cap),type));}
 private preferred(caps:Capability[],kind:string,inputs:string[]=[]){try{return selectCapability(caps,kind,inputs,undefined,this.modelPolicy);}catch{return undefined;}}
 private kind(node:any){const data=node.data||{},type=String(resolveSavedVideoMode(node,this.capabilities.get(data.capabilityRef??data.modelCode))||data.subType||data.toolsType||'').toUpperCase().replaceAll('-','_');return nativeKinds[type]||(Object.values(nativeKinds).includes(type)?type:null)||(/rh-text|rh-script|rh-storyboard/.test(node.type)?'LLM':/rh-image/.test(node.type)?'TEXT_TO_IMAGE':/rh-video/.test(node.type)?'TEXT_TO_VIDEO':/rh-audio/.test(node.type)?'TEXT_TO_AUDIO':/rh-3d/.test(node.type)?'GENERATE_3D_MODEL':/world/.test(node.type)?'GENERATE_3D_WORLD':null);}
 private async nodeInputs(node:any,graph:NativeGraph,facts?:PreflightAsset[],options:GenerationPreparationOptions={}){
  const types=new Set(this.nativeInputs(String(node.data?.subType||node.data?.toolsType||'').toUpperCase().replaceAll('-','_'))),references=new Set<string>(),owners=new Map<string,string>();let sourceId=String(node.id);
  const reference=(ref:string)=>{references.add(ref);if(!owners.has(ref)||owners.get(ref)===String(node.id)&&sourceId!==String(node.id))owners.set(ref,sourceId);};
  const selected=executionAncestors(graph,node.id);
  // New nodes may not have persisted the default model yet. Use that same
  // catalog default only for inspection; normal model resolution still follows.
  const choice=modelChoice(node.data),quickScene=choice?.capabilityRef===nativeQuickSceneAlias&&this.nativeQuickSceneDefault(node,node.data,graph,['IMAGE'],choice),defaultCap=quickScene?this.preferred([...this.capabilities.values()],'IMAGE_TO_IMAGE',['IMAGE']):!choice?this.preferred([...this.capabilities.values()],this.kind(node)||'',[...types]):undefined;
  graph=canvasMediaInputProjection(defaultCap?{...node,data:{...node.data,capabilityRef:defaultCap.capabilityRef}}:node,graph,defaultCap??this.capabilities.get(choice?.capabilityRef??''));
  const visit=(value:any,key='')=>{if(typeof value==='string'){if(value.startsWith('rhtv-asset:'))reference(value);else if(/^(assetId|assetIds)$/i.test(key)&&value)reference('rhtv-asset:'+value);else if(value&&/^(?:url|urls|sourceObjects|toolsSourceUrl|(?:image|video|audio|mask|frame|file)(?:Url|Urls))$/i.test(key))throw preflightError('ASSET_REFERENCE_REQUIRED',`“${generationNodeName(graph.nodes.find(source=>source.id===sourceId))}”的参考素材尚未上传或导入，请重新选择已上传素材。`,undefined,{issues:[{field:'references.upload',reason:'REFERENCE_REQUIRED',sourceNodeId:sourceId}]});}else if(Array.isArray(value))value.forEach(item=>visit(item,key));else if(value&&typeof value==='object')Object.entries(value).forEach(([name,item])=>visit(item,name));};
  for(const source of graph.nodes)if(selected.has(source.id)){
   sourceId=String(source.id);const data=source.data||{};
   if(source.id!==node.id&&options.deferredSourceIds?.has(source.id)){
    const output=options.deferredOutputKinds?.get(source.id)??this.capabilities.get(data.capabilityRef??data.modelCode)?.outputKinds??({'rh-image':['IMAGE'],'rh-video':['VIDEO'],'rh-audio':['AUDIO'],'rh-text':['TEXT'],'rh-script':['STRUCTURED'],'rh-storyboard':['STRUCTURED']} as Record<string,string[]>)[source.type];
    if(!output?.length)throw new ApiError(422,'UPSTREAM_OUTPUT_UNKNOWN','上游节点尚未声明输出类型，请先选择可用模型。');for(const kind of output)types.add(kind);continue;
   }
   // A connected result contributes its displayed output, not the references
   // and parameters that were used to produce that result.
   if(source.id===node.id){visit(data.params);visit(data.toolsSourceUrl,'toolsSourceUrl');visit(data.promptSelection?.messages);if(options.nativeVideoComposer&&usesNativeImageInputs(node))for(const mention of Array.isArray(data.mentionAssets)?data.mentionAssets:[])if(mention?.type!=='TEXT'&&mention?.url)visit(mention.url,'url');}
   if(options.nativeVideoComposer&&(node.type==='rh-video'||usesNativeImageInputs(node))&&source.id!==node.id&&(canvasImageSource(source.type)||['rh-video','rh-audio'].includes(source.type))){
    // The native composer already selected the displayed history output. Only
    // validate media actually consumed by this command, not other cached rows.
    const consumed=new Set(['image','video','audio'].flatMap(kind=>node.data?.params?.[kind+'Urls']??[]));
    const selectedMedia=(value:any)=>{if(typeof value==='string'){if(consumed.has(value))reference(value);}else if(Array.isArray(value))value.forEach(selectedMedia);else if(value&&typeof value==='object')Object.values(value).forEach(selectedMedia);};
    for(const value of [data.sourceObjects,data.imageUrl,data.videoUrl,data.audioUrl,data.output])selectedMedia(value);continue;
   }
   visit(data.sourceObjects,'sourceObjects');visit(data.imageUrl,'imageUrl');visit(data.videoUrl,'videoUrl');visit(data.audioUrl,'audioUrl');if(source.id!==node.id){const output=Array.isArray(data.output)?data.output:undefined,selected=data.selectedHistoryOutputId??data.selectedOutputHistoryId,chosen=selected&&output?.find((value:any)=>value?.historyOutputId===selected||value?.outputId===selected||value?.id===selected);visit(chosen??data.output);}
  }
  for(const ref of references){
   const cached=options.preview&&ref.startsWith('rhtv-asset:')?this.storage.assets.get(ref.slice(11)):undefined,sourceNodeId=owners.get(ref)??String(node.id);
   let asset:Asset;
   try{asset=cached?.state==='READY'?cached:await this.storage.resolveAsset(ref);}
   catch(error){
    if(!(error instanceof ApiError)||![403,404,409].includes(error.status)||['IPAC_PERMISSION_DENIED','ACCOUNT_DISABLED','FEISHU_IDENTITY_REQUIRED','SESSION_CHANGED'].includes(error.code))throw error;
    const title=generationNodeName(graph.nodes.find(source=>source.id===sourceNodeId));
    const issue=new ApiError(error.status,error.code,`“${title}”的参考素材无法用于本次生成：${error.message} 请选择可用素材或移除这项参考。`,error.requestId);
    throw withPreflightContext(issue,{issues:[{field:'references.kind',reason:error.code==='ASSET_NOT_READY'?'UPLOAD_PENDING':'REFERENCE_REQUIRED',component:'REFERENCES',sourceNodeId,assetId:ref.slice(11)}]});
   }
   if(asset.kind)types.add(asset.kind);facts?.push({assetId:asset.id,inputKind:preflightInputKinds([asset.kind])[0],sourceNodeId,asset});
  }
  return [...types];
 }
 private async nativeImageParseDefault(node:any,data:any,graph:NativeGraph,inputs:string[],choice?:ModelChoice){
  if(data.capabilityRef||data.params?.capabilityRef||node.type!=='rh-text'||String(data.subType).toUpperCase().replaceAll('-','_')!=='MULTIMODAL_TEXT'||data.hidePromptInput!==true||!inputs.includes('IMAGE'))return false;
  const alias=choice?.capabilityRef==='llm-haimaflash-multimadal-text',fallback=this.preferred([...this.capabilities.values()],'LLM',['TEXT']);
  if(!alias&&(!fallback?.model||choice?.capabilityRef!==fallback.capabilityRef))return false;
  const prompt=data.params?.prompt;
  if(typeof prompt!=='string'||prompt.length!==2628||await sha256Hex(new TextEncoder().encode(prompt))!=='87531563949237a209a49f179e2be378a459b326cf3e7c62b7409f13699860ab')return false;
  // Native nk can replace bEr's alias with its text default and discard the
  // reference field before run() is called. Only this exact immutable parser
  // command may recover from its still-present actor-owned IMAGE input edge.
  const sources=new Set(graph.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source)),refs=new Set<string>();
  const collect=(value:any)=>{if(typeof value==='string'&&value.startsWith('rhtv-asset:'))refs.add(value);else if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object'){if(typeof value.assetId==='string')refs.add('rhtv-asset:'+value.assetId);Object.values(value).forEach(collect);}};
  for(const source of graph.nodes)if(sources.has(source.id)&&source.type==='rh-image'){collect(source.data?.sourceObjects);collect(source.data?.imageUrl);collect(source.data?.output);}
  if(!alias&&!refs.size)return false;
  if(!Array.isArray(data.params?.imageUrls)||!data.params.imageUrls.length){
   const images:string[]=[];for(const ref of refs){const asset=await this.storage.resolveAsset(ref);if(asset.kind==='IMAGE')images.push('rhtv-asset:'+asset.id);}
   if(!images.length)return false;data.params={...data.params,imageUrls:images};
  }
  return true;
 }
 private nativeQuickSceneDefault(node:any,data:any,graph:NativeGraph,inputs:string[],choice?:ModelChoice){
  if(choice?.capabilityRef!==nativeQuickSceneAlias||choice.capabilityVersion||data.capabilityRef||data.params?.capabilityRef||node.type!=='rh-image'||String(data.toolsType).toUpperCase().replaceAll('-','_')!=='IMAGE_IMAGE'||!quickSceneCodes.has(data.sceneCode)||data.generateNum!==1||data.params?.prompt!==''||inputs.length!==1||inputs[0]!=='IMAGE')return false;
  const source=data.toolsSourceUrl;
  if(typeof source!=='string'||!source.startsWith('rhtv-asset:')||!Array.isArray(data.params?.imageUrls)||data.params.imageUrls.length!==1||data.params.imageUrls[0]!==source)return false;
  // A quick scene edits its direct source's displayed output. Historical
  // generation inputs remain in the graph for version guards, but are not
  // additional references for this edit (the API verifies owned history).
  const refs=new Set<string>(),direct=new Set(graph.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source));
  const visit=(value:any,key='')=>{if(typeof value==='string'){if(value.startsWith('rhtv-asset:'))refs.add(value);else if(/^(assetId|assetIds)$/i.test(key)&&value)refs.add('rhtv-asset:'+value);}else if(Array.isArray(value))value.forEach(item=>visit(item,key));else if(value&&typeof value==='object')Object.entries(value).forEach(([name,item])=>visit(item,name));};
  visit(data.params);visit(data.toolsSourceUrl);
  for(const item of graph.nodes)if(direct.has(item.id)){if(item.type!=='rh-image')return false;const value=item.data||{};visit(value.sourceObjects);visit(value.imageUrl);visit(value.output);}
  return refs.size===1&&refs.has(source);
 }
 private nativeImageFeatureDefault(node:any,data:any,inputs:string[],choice?:ModelChoice){
  if(node.type!=='rh-image'||choice?.capabilityVersion||data.capabilityRef||data.params?.capabilityRef)return false;
  const alias=choice?.capabilityRef,source=data.toolsSourceUrl,type=String(data.toolsType||'').toUpperCase().replaceAll('-','_');
  if(alias===nativePortraitAlias)return data.isPortraitAdjustResult===true&&type==='IMAGE_IMAGE'&&inputs.length===1&&inputs[0]==='IMAGE'&&typeof source==='string'&&source.startsWith('rhtv-asset:')&&Array.isArray(data.presetSelections)&&data.presetSelections.length>0;
  return alias===nativePanoramaAlias&&data.panorama?.isPanoramaNode===true&&panoramaScenes.has(data.sceneCode)&&['IMAGE_IMAGE','TEXT_IMAGE',''].includes(type)&&inputs.every(kind=>kind==='IMAGE')&&(data.sceneCode==='canvas-image-panorama-image'?inputs.includes('IMAGE'):!inputs.length);
 }
 async freezeGraph(graph:NativeGraph,projectId=this.projectId,selected:(node:any)=>boolean=()=>true){
  if(projectId)graph=this.storage.restoreModelBindings(projectId,graph);
  if(projectId)graph=await this.storage.prepareExecutionGraph(projectId,graph);else await this.storage.prepareGraph(graph);
  // The preparation of each job already checks the exact inputs it consumes.
  // A durable history row is not another job input or a reason to fetch bytes.
  const safe=cleanJson(graph,this.storage.encodeAsset);
  // Only media parameter values are subject to the asset boundary; prompt text may contain URLs.
  const validate=(value:any,key='')=>{if(typeof value==='string'&&/^(?:url|urls|video|mask|sourceVideo|sourceObjects|.*(?:image|video|audio|frame|mask|file)Urls?)$/i.test(key)&&value&&!value.startsWith('rhtv-asset:'))throw new ApiError(422,'ASSET_REFERENCE_REQUIRED','模型输入必须使用已上传的 STUDIO 素材。');if(Array.isArray(value))value.forEach(x=>validate(x,key));else if(value&&typeof value==='object')Object.entries(value).forEach(([k,v])=>validate(v,k));};
  for(const node of safe.nodes)if(selected(node)){validate(node.data?.params||{});validate(node.data?.sourceObjects,'sourceObjects');}
  return{nodes:safe.nodes,edges:safe.edges};
 }
 async output(output:StudioOutput,testMode=false){
  const type=String(output.type||(output as any).outputType||'').toUpperCase(),marker=testMode?'[TEST MODE] ':'';
  if(type==='TEXT')return{outputId:output.outputId||output.id,text:marker+(output.text||''),outputType:'text',testMode};
  if(type==='STRUCTURED')return{outputId:output.outputId||output.id,outputType:'structured',schemaVersion:output.schemaVersion,data:output.data,testMode};
  if((type==='ASSET'||type==='ARTIFACT')&&output.assetId){const asset=await this.storage.resolveAsset('rhtv-asset:'+output.assetId);return{outputId:output.outputId||output.id,assetId:asset.id,mediaId:asset.id,url:asset.downloadUrl||asset.previewUrl,originalUrl:asset.downloadUrl,...(asset.kind==='IMAGE'?{thumbnailUrl:asset.previewUrl}:{}),outputType:output.mimeType||asset.mimeType,mimeType:asset.mimeType,fileName:asset.fileName,width:output.width,height:output.height,durationMs:output.durationMs,testMode,...(output.deletedAt?{deletedAt:output.deletedAt}:{})};}
  throw new ApiError(502,'INVALID_OUTPUT','生成结果缺少可验证的 STUDIO 素材或文字。');
 }
 async task(task:any){const state=String(task.state||task.status||'').toUpperCase(),plans=await Promise.all((task.plans||[]).map(async(plan:any)=>({...plan,nodeId:plan.nodeId,taskPlanId:plan.executionId||plan.id,status:nativeState(String(plan.state||plan.status||state).toUpperCase()),outputs:await Promise.all((plan.outputs||[]).map((output:StudioOutput)=>this.output(output,plan.testMode??!!task.testMode))),errorMessage:plan.errorMessage||plan.error?.message||plan.errorCode})));return{...task,taskId:task.id||task.taskId,status:nativeState(state),plans,testMode:!!task.testMode,errorMessage:task.errorMessage||task.error?.message||task.errorCode};}
 private claim(task:any,manager:any,projectId:string,order:number,canvasRevision?:number){
  if(!manager||this.manager!==manager||this.projectId!==projectId||task.projectId&&task.projectId!==projectId)return;
  const managed=this.serverManaged(task);
  const taskId=task.id||task.taskId;if(!taskId)return;
  for(const plan of task.plans||[]){const attempt=this.localAttempts.get(plan.nodeId);if(managed&&attempt?.order===order&&attempt.manager===manager&&attempt.projectId===projectId)attempt.taskId=taskId;
   if(!manager.getRemoteData()?.nodes.some((node:any)=>node.id===plan.nodeId))continue;const previous=this.nodeTasks.get(plan.nodeId);if(previous&&previous.order>order)continue;
   this.nodeTasks.set(plan.nodeId,{id:taskId,order,revision:previous&&previous.id===taskId?previous.revision:-1,...(managed&&canvasRevision!==undefined?{canvasRevision}:{})});if(previous?.id!==taskId){this.applied.delete(plan.nodeId);this.terminalUpdates.delete(plan.nodeId);}
   if(managed&&attempt&&attempt.taskId===taskId&&attempt.order===order)attempt.lease.accepted?.(taskId,()=>this.localAttempts.get(plan.nodeId)===attempt&&attempt.epoch===this.epoch&&this.manager===manager&&this.projectId===projectId&&this.nodeIdentity(manager,plan.nodeId)===attempt.nodeIdentity&&this.nodeTasks.get(plan.nodeId)?.id===taskId);
   if(!managed)manager.patchNodeData(plan.nodeId,{taskId});
  }
  if(!managed)manager.flushOperationQueue?.(true);
 }
 private async apply(task:any){
  if(!this.manager||!this.projectId||task.projectId&&task.projectId!==this.projectId)return;
  if(this.serverManaged(task)){if(terminal.has(String(task.state).toUpperCase()))for(const plan of task.plans)if(plan.canvasBinding.applicationState==='DETACHED'){this.detached(task.id||task.taskId,plan.executionId,plan.canvasBinding.reason);this.settleDetached(task.id||task.taskId,plan);}return;}
  const epoch=this.epoch,manager=this.manager,projectId=this.projectId,view=await this.task(task);this.check(epoch);
  if(this.manager!==manager||this.projectId!==projectId)return;
  // Native getRemoteData reads integrated state. Settle queued user deletes
  // before deciding whether an accepted image source still owns its results.
  if(view.plans.some(imageBatchPlan))manager.flushOperationQueue?.(true);
  if(this.epoch!==epoch||this.manager!==manager||this.projectId!==projectId)return;
  const completed:{update:TerminalNodeUpdate;signature:string}[]=[];
  const prepared:any[]=[],stagedNodes=[...(manager.getRemoteData()?.nodes||[])];
  for(const plan of view.plans){const owner=this.nodeTasks.get(plan.nodeId),revision=Number.isSafeInteger(task.revision)?task.revision:undefined;if(!owner||owner.id!==view.taskId||revision!==undefined&&revision<owner.revision)continue;const signature=JSON.stringify([view.taskId,task.revision,plan.status,plan.outputs,plan.errorMessage]);if(this.applied.get(plan.nodeId)===signature)continue;if(!manager.getRemoteData()?.nodes.some((n:any)=>n.id===plan.nodeId))continue;
   const failed=plan.status==='FAILED',done=plan.status==='SUCCESS',cancelled=plan.status==='CANCELLED';const first=plan.outputs[0],node=manager.getRemoteData().nodes.find((n:any)=>n.id===plan.nodeId),patch:any={status:done?'finished':failed?'failed':cancelled?'idle':'processing',taskId:view.taskId,errorMsg:plan.errorMessage||'',testMode:plan.testMode??view.testMode,...((plan.testMode??view.testMode)?{customBadgeText:'TEST MODE'}:node.data?.customBadgeText==='TEST MODE'?{customBadgeText:''}:{})};
   if(node.data?.taskId&&node.data.taskId!==view.taskId)continue;
   if(node.type==='rh-image'&&imageBatchPlan(plan)&&node.data?.taskId!==view.taskId)continue;
   const history=node.data?.historyStorage,persistedRevision=Number(history?.revision);
   if(revision!==undefined&&history?.source==='remote'&&history.historyId===plan.taskPlanId&&Number.isSafeInteger(persistedRevision)&&persistedRevision>revision)continue;
   const images=localImageBatch(projectId,view.taskId,plan,node,stagedNodes,this.imageProjections);
   if(images&&(manager.isWriteBlocked?.()||images.nodes.length&&typeof manager.addNode!=='function'))throw new ApiError(409,'CANVAS_WRITE_UNAVAILABLE','画布暂时无法写入结果，请重新打开作品。');
   if(done){if(!(plan.testMode??view.testMode)&&node.data?.testMode===true&&typeof node.data.title==='string')patch.title=node.data.title.replace(/^\[TEST MODE\] /,'');if(plan.testMode??view.testMode){const title=String(node.data?.title||node.data?.label||node.type);patch.title=title.includes('[TEST MODE]')?title:'[TEST MODE] '+title;}if(!images)patch.output=plan.outputs;patch.historyStorage={source:'remote',schemaVersion:1,historyId:plan.taskPlanId,revision:String(task.revision||'0'),resultCount:task.resultCount??plan.outputs.length};if(first?.text!==undefined){patch.text=first.text;patch.content=first.text;}if(first?.data!==undefined){patch.structuredOutput=first.data;if(node.type==='rh-script')patch.script=first.data;if(node.type==='rh-storyboard')patch.storyboard=first.data;}if(first?.url){if(node.type==='rh-audio')patch.audioUrl=first.url;if(node.type==='rh-video')patch.videoUrl=first.url;}}
   if(images){Object.assign(patch,images.patch);patch.historyStorage={...(patch.historyStorage??node.data?.historyStorage??{}),...images.metadata};stagedNodes.push(...images.nodes);}
   if(node.type==='rh-script'&&(done||failed||cancelled)){const stage=scriptTerminalFields(node.data);if(plan.testMode??view.testMode)delete stage.customBadgeText;Object.assign(patch,stage);}
   if(node.type==='rh-script'&&done){patch.executionOutputs=plan.outputs;patch.presentationError=null;try{patch.output=storyboardOutput(plan.outputs,plan.nodeSnapshot?.data);}catch(error){if(!(error instanceof ApiError)||error.code!=='STORYBOARD_PRESENTATION_UNSUPPORTED')throw error;patch.presentationError={code:error.code,message:error.message};this.notice(error.message);}}
   prepared.push({plan,patch,images,owner,signature,revision,done,failed,cancelled});
  }
  // Preflight every plan before queuing mutations: native addNode is deferred
  // until flush, so later plans must also see all staged result nodes.
  for(const {plan,patch,images,owner,signature,revision,done,failed,cancelled}of prepared){
   if(images)for(const child of images.nodes)manager.addNode(child);
   // The immutable manager requires explicit permission for persisted outputs and completion.
   // Its "running" state is local-only; "processing" survives the same native filter.
   manager.patchNodeData(plan.nodeId,patch,{allowFields:['output','status']});if(images)for(const key of images.keys)this.imageProjections.add(key);this.applied.set(plan.nodeId,signature);if(revision!==undefined)owner.revision=revision;
   if(done||failed||cancelled){const result={update:{nodeId:plan.nodeId,taskId:view.taskId,projectId,manager,status:done?'SUCCESS' as const:failed?'FAILED' as const:'CANCELLED' as const},signature};this.terminalUpdates.set(plan.nodeId,result);completed.push(result);}
  }
  manager.flushOperationQueue?.(true);
  for(const {update,signature}of completed)for(const listener of this.terminalListeners){if(epoch!==this.epoch||this.manager!==manager||this.projectId!==projectId||this.nodeTasks.get(update.nodeId)?.id!==update.taskId||this.applied.get(update.nodeId)!==signature)break;try{listener(update);}catch(error){this.notice(error instanceof Error?error.message:'原生执行状态未能更新。');}}
 }
 private preflightTarget(body:any):PreflightTarget {
  const projectId=String(body.canvasId||body.projectId||this.projectId||''),nodeId=String(body.targetId||'');
  let graph=typeof body.canvas==='object'?body.canvas:body.graph;
  if(!graph&&typeof body.canvas==='string'){try{graph=JSON.parse(body.canvas);}catch{/* Submission owns malformed-command errors. */}}
  const node=(graph??this.manager?.getRemoteData())?.nodes?.find((value:any)=>value.id===nodeId),data=node?.data;
  const ref=data?.capabilityRef??data?.modelCode??data?.model_id??data?.modelId??data?.model??data?.params?.capabilityRef??data?.params?.modelCode??data?.params?.model;
  return{projectId,nodeId,...(typeof data?.sceneCode==='string'&&data.sceneCode.startsWith('canvas-')?{sceneCode:data.sceneCode}:{}),
   ...(typeof ref==='string'?{preflight:{schemaVersion:'1',capabilityRef:ref,...(typeof (data?.capabilityVersion??data?.params?.capabilityVersion)==='string'?{capabilityVersion:data.capabilityVersion??data.params.capabilityVersion}:{}),...(node?{requestedKind:this.kind(node)||undefined}:{})}}:{})};
 }
 private rememberPreflightFailure(error:unknown,target:PreflightTarget,context:Partial<PreflightContext>={}):unknown {
  if(error instanceof ApiError&&!error.requestId){
   withPreflightContext(error,{...target.preflight,...context,...preflightContext(error)});
   this.failureTargets.set(error,{...target,preflight:preflightContext(error)});
  }
  return error;
 }
 run(body:any){return this.dispatchCanvasRun(body,false);}
 private dispatchCanvasRun(body:any,fromNative:boolean){
  const type=body.targetType||'NODE',key=JSON.stringify([body.canvasId||body.projectId||this.projectId,type,body.targetId||'',type==='CANVAS'?(body.graph?.nodes??body.canvas?.nodes??[]).map((node:any)=>node.id).sort():null]);
  const projectId=String(body.canvasId||body.projectId||this.projectId||''),targetId=String(body.targetId??'');
  // Consume even if the operation coalesces or a direct API call supersedes
  // the native attempt. Neither can leave a click label for the next request.
  let intent:SnapshotIntent|undefined;
  try{
   const candidate=this.nativeIntent?.(projectId,targetId,type);
   if(fromNative)intent=candidate;
  }catch{/* A torn-down page must not prevent actual submission. */}
  const current=this.submissions.get(key);if(current)return current;
  const command={...body},diagnostic=this.preflightTarget(command),epoch=this.epoch;
  if(type==='NODE'&&this.progressViews.delete(String(body.targetId||'')))for(const listener of this.progressListeners)listener();
  const pending=this.submit(command,true,intent).catch(async error=>{if(epoch===this.epoch)await this.reportPreflightFailure(diagnostic,error);throw error;});
  this.submissions.set(key,pending);void pending.finally(()=>{if(this.submissions.get(key)===pending)this.submissions.delete(key);}).catch(()=>{});return pending;
 }
 async reportPreflightFailure(body:any,failure:unknown,notify=true,snapshot?:CanvasFailureSnapshot){
  if(!(failure instanceof Error)||this.reportedFailures.has(failure)||this.acceptedResponseErrors.has(failure))return;
  if(failure instanceof ApiError&&(failure.status===401||failure.status===403||['SESSION_CHANGED','STALE_CANVAS_SESSION','UNAUTHORIZED','UNAUTHENTICATED'].includes(failure.code)))return;
  const reportedTarget='nodeId' in body?body as PreflightTarget:this.preflightTarget(body);
  const clientSnapshot=this.attemptSnapshots.get(failure)??snapshot??this.captureFailureSnapshot(reportedTarget.projectId,{
   control:'COMMAND',targetId:reportedTarget.nodeId,targetType:body.targetType==='GROUP'?'GROUP':body.targetType==='CANVAS'?'CANVAS':'NODE'
  },body.graph);
  if(!(failure instanceof ApiError)&&(!clientSnapshot||failure.name==='AbortError'))return;
  const error=failure instanceof ApiError?failure:new ApiError(0,'CLIENT_SUBMISSION_ERROR',failure.message);
  // Report existing server errors only as supplemental evidence correlated to
  // a real request UUID. Never replace its identity or send another alert.
  const prior=error.requestId;
  if(prior&&(!clientSnapshot||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(prior)))return;
  const target=this.failureTargets.get(error)??reportedTarget;
  const {projectId,sceneCode}=target,nodeId=target.nodeId||(clientSnapshot?.targetType==='CANVAS'?'studio-canvas':'');
  if(!projectId||!nodeId||!this.api.getAccessToken())return;
  this.reportedFailures.add(failure);
  try {
   const mounted=this.projectId===projectId?this.preflightTarget({projectId,targetId:nodeId}):undefined;
   const sync=error.code==='LOCAL_DRAFT_CONFLICT'?this.storage.draftRecoveryState(projectId):undefined;
   withPreflightContext(error,{...mounted?.preflight,...target.preflight,...preflightContext(error),...(sync?.blockedReason?{sync:{blockedReason:sync.blockedReason,generation:sync.generation,conflicts:sync.conflicts.map(draftConflictDiagnostic)}}:{})});
   const context=preflightContext(error),preflight=context&&Object.keys(context).length>1?context:undefined;
   if(clientSnapshot){
    // Observe the live UI and the outcome of the save only after a failure.
    // The revision and graph above refer to what was present at the attempt.
    try{
     const state=sync??this.storage.draftRecoveryState(projectId);
     clientSnapshot.pendingSync=this.storage.hasDraft(projectId);
     clientSnapshot.syncBlocked=state.blocked;
     clientSnapshot.syncBusy=state.busy;
    }catch{/* An unavailable sync view still permits logging the original input. */}
    if(this.projectId===projectId){
     try{clientSnapshot.dom=this.diagnosticDom?.(projectId,body.observationTargetId||reportedTarget.nodeId||target.nodeId);}catch{/* A transient DOM cannot hide an otherwise valid report. */}
    }
   }
   const result=await this.api.requestV2<{logId:string}>('/generation-diagnostics',{method:'POST',retryAuth:false,signal:AbortSignal.timeout(2000),body:{
    projectId,nodeId,errorCode:error.code,...(sceneCode?{sceneCode}:{}),...(preflight?{preflight}:{}),...(clientSnapshot?{clientSnapshot}:{}),...(prior?{relatedRequestId:prior}:{})
   }});
   const id=prior??result.data.logId;
   if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id))return;
   error.requestId=id;
   if(!failure.message.includes(id))failure.message+=' 日志编号：'+id;
   if(notify)this.notice(failure.message);
   return id;
  }catch{return;} // A failed diagnostic must not replace the original error.
 }
 private deferredGenerationKinds(node:any,graph:NativeGraph,options:GenerationPreparationOptions){
  const direct=new Set(graph.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source));
  return graph.nodes.filter(source=>direct.has(source.id)&&options.deferredSourceIds?.has(source.id)).flatMap(source=>options.deferredOutputKinds?.get(source.id)??this.capabilities.get(source.data?.capabilityRef??source.data?.modelCode)?.outputKinds??({'rh-image':['IMAGE'],'rh-video':['VIDEO'],'rh-audio':['AUDIO'],'rh-text':['TEXT'],'rh-script':['STRUCTURED'],'rh-storyboard':['STRUCTURED']} as Record<string,string[]>)[source.type]??[]);
 }
 private plannedGenerationMedia(node:any,graph:NativeGraph,options:GenerationPreparationOptions):PlannedInputMedia[]{
  const direct=new Set(graph.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source)),plans:PlannedInputMedia[]=[];
  for(const source of graph.nodes)if(direct.has(source.id)&&options.deferredSourceIds?.has(source.id)){
   const data=source.data??{},cap=this.capabilities.get(data.capabilityRef??data.modelCode);if(!cap?.available||cap.testMode!==false||!cap.model||data.capabilityVersion&&data.capabilityVersion!==cap.version)continue;
   const schema=cap.parameterSchema??{},value=Object.hasOwn(data.params??{},'outputPreset')?data.params.outputPreset:data.routerParameters?.outputPreset??schema.properties?.outputPreset?.default;
   if(!Array.isArray(schema.properties?.outputPreset?.enum)||!schema.properties.outputPreset.enum.includes(value))continue;
   const rows=schema['x-output-presets']??schema['x-video-parameter-metadata']?.presets,row=Array.isArray(rows)?rows.find((row:any)=>row?.value===value):undefined;
   if(!row)continue;const kind=cap.outputKinds?.find(value=>['IMAGE','VIDEO','AUDIO'].includes(value));if(!kind)continue;
   plans.push({sourceNodeId:source.id,kind,...(typeof row.width==='number'?{width:row.width}:{}),...(typeof row.height==='number'?{height:row.height}:{}),...(typeof row.durationSeconds==='number'&&row.durationSeconds>0?{durationMs:Math.round(row.durationSeconds*1000)}:{})});
  }
  return plans;
 }
 private validateRequiredGenerationInputs(cap:Capability,node:any,graph:NativeGraph,assets:Asset[],options:GenerationPreparationOptions){
  if(cap.testMode===true)return;
  const deferred=this.deferredGenerationKinds(node,graph,options);
  if(!isH3(cap)&&!isVideoProfile(cap)){
   const limits=cap.parameterSchema?.['x-input-constraints']??{};
   for(const [kind,label,key]of [['IMAGE','图片','images'],['VIDEO','视频','videos'],['AUDIO','音频','audios']] as const){
    const count=assets.filter(row=>row.kind===kind).length+deferred.filter(value=>value===kind).length;
    const minimum=limits['min_'+key]??(kind==='IMAGE'&&(cap.kind==='IMAGE_UNDERSTANDING'||cap.kind==='IMAGE_TO_IMAGE'&&cap.model)?1:0),maximum=readinessMediaLimit(cap,kind);
    if(Number.isSafeInteger(minimum)&&count<minimum)throw preflightError('MODEL_INPUT_UNSUPPORTED',`需要至少${minimum}${kind==='IMAGE'?'张':'项'}已上传的参考${label}，请连接${label}节点或添加参考素材。`,cap,{issues:[{field:'references.count',reason:'REFERENCE_REQUIRED',inputKind:kind,actual:count,minimum}]});
    if(maximum!==undefined&&count>maximum)throw preflightError('MODEL_INPUT_UNSUPPORTED',`当前模型最多支持 ${maximum} 项${label}参考，当前有 ${count} 项，请移除多余素材。`,cap,{issues:[{field:'references.count',reason:'COUNT_EXCEEDED',inputKind:kind,actual:count,maximum}]});
   }
  }
  if(assets.length>100)throw preflightError('MODEL_INPUT_UNSUPPORTED','参考素材合计最多100项，请移除多余素材。',cap,{issues:[{field:'references.total',reason:'COUNT_EXCEEDED',actual:assets.length,maximum:100}]});
  if(cap.parameterSchema?.['x-prompt-policy']==='required'||officialVideoProvider(cap)){
   const data=node.data??{},raw=String(data.params?.prompt??data.prompt??''),prompt=node.type==='rh-image'?nativeImageComposedPrompt(raw,data,node,graph,this.nativeTextProjection?.project):raw;
   // Ordinary upstream documents become user text on visual-only services.
   // A specialized shot or a selected execution can have a different frontier.
   const visual=['comfy','h3','minimax','minimax-official','volcengine-official'].includes(cap.model?.providerRef??''),ordinary=!data.toolsType&&!data.sceneCode&&!data.isStoryboard;
   const docs=visual&&ordinary?graph.edges.filter(e=>e.target===node.id).flatMap(e=>{const n=graph.nodes.find(v=>v.id===e.source),d=n?.data;if(!['rh-script','rh-storyboard'].includes(n?.type??'')||!d||d.selectedHistoryOutputId||d.selectedOutputHistoryId||d.historyStorage?.historyId||d.applicationInput==null)return[];return[JSON.stringify(d.applicationInput)];}):[];
   if(typeof prompt==='string'&&(cap.parameterSchema?.['x-model-source']?.kind==='SELF_HOSTED'||officialVideoProvider(cap))&&new TextEncoder().encode([prompt.trim(),...docs].filter(Boolean).join('\n\n')).length>16000)throw preflightError('MODEL_PARAMETER_INVALID','画面描述和已连接的脚本合计超过生成服务支持的 16,000 个 UTF-8 字节，请缩短描述或脚本后再提交。',cap,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PROMPT',parameterPath:['prompt'],parameterRule:'maxLength'}]});
   const text=graph.edges.filter(edge=>edge.target===node.id).some(edge=>{const source=graph.nodes.find(value=>value.id===edge.source);return source?.type==='rh-text'&&String(source.data?.text??source.data?.content??'').trim();});
   // For these reference-edit actions the STUDIO prompt compiler supplies the
   // scene/feature instruction. A required upstream prompt is not necessarily
   // a required free-text field (e.g. the 45 named storyboard actions).
   const tool=String(data.toolsType||'').replaceAll('-','_').toUpperCase();
   const compiledEdit=node.type==='rh-image'&&cap.kind==='IMAGE_TO_IMAGE'&&assets.some(asset=>asset.kind==='IMAGE')&&(
    tool==='IMAGE_IMAGE'&&quickSceneCodes.has(data.sceneCode)||['IMAGE_MULTIANGLE','IMAGE_MULTI_ANGLE','IMAGE_LIGHT','IMAGE_MULTI_ANGLE_LIGHT','IMAGE_ENHANCE','IMAGE_CUTOUT_TEXT'].includes(tool)
    ||data.isPortraitAdjustResult===true&&Array.isArray(data.presetSelections)&&data.presetSelections.length>0||data.panorama?.isPanoramaNode===true&&data.sceneCode==='canvas-image-panorama-image');
   if(!compiledEdit&&!prompt?.trim()&&!text&&!docs.length&&!deferred.some(kind=>['TEXT','STRUCTURED'].includes(kind)))throw preflightError('MODEL_INPUT_UNSUPPORTED','请填写画面描述或连接提供描述的文字节点。',cap,{issues:[{field:'inputs.kind',reason:'REFERENCE_REQUIRED',inputKind:'TEXT',component:'PROMPT'}]});
  }
 }
 async inspectGeneration(projectId:string,nodeIds:string[],supplied?:NativeGraph,group=false):Promise<GenerationReadiness>{
  const epoch=this.epoch,manager=this.manager,base=supplied??manager?.getRemoteData(),fallback={id:nodeIds[0]??'',data:{title:'当前画布'}};
  try{
   this.storage.requirePermission(projectId,'canRun');if(!base||this.projectId!==projectId||!manager)throw new ApiError(409,'CANVAS_REQUIRED','请先打开项目画布。');
   const groupRoot=nodeIds.length===1&&['group','rh-group'].includes(base.nodes.find((node:any)=>node.id===nodeIds[0])?.type??'')?nodeIds[0]:undefined;
   const prepared=groupRoot?(completeNativeGroupCommand(base,base,groupRoot)??base):base;
   const scope=generationScopeGraph(prepared,nodeIds);
   const graph=structuredClone(this.storage.restoreModelBindings(projectId,scope));
   // Preparing an explicitly selected catalog material uses the existing
   // idempotent asset importer. Inspection never creates a task or saves a graph.
   await this.storage.prepareGraph(graph);this.check(epoch);const safe:NativeGraph=cleanJson(graph,this.storage.encodeAsset);validateGenerationGraph(safe,nodeIds[0]);
   if(this.storage.isBlocked(projectId))throw new ApiError(409,'LOCAL_DRAFT_CONFLICT','画布同步检查尚未通过，本地修改已保留。同步恢复后可继续生成。');
   await this.catalog();this.check(epoch);if(this.manager!==manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请在当前画布重新检查。');
   const selected=generationMembers(safe,nodeIds);
   const targets=safe.nodes.filter(node=>selected.has(node.id)&&isGenerationTarget(node));
   if(!targets.length)throw new ApiError(422,'GENERATION_TARGET_REQUIRED','请选择可生成的内容节点，或先向分组中添加内容。');
   const deferredSourceIds=new Set(targets.map(node=>node.id)),plans=new Map<string,AppPlan>(),deferredOutputKinds=new Map<string,string[]>(),issues:GenerationReadiness['issues']=[];
   for(const node of targets)if(node.type==='rh-ai')try{const plan=await this.appPlan(node,epoch);plans.set(node.id,plan);deferredOutputKinds.set(node.id,plan.cap.outputKinds??({LLM:['TEXT','STRUCTURED'],TEXT_TO_IMAGE:['IMAGE'],IMAGE_TO_IMAGE:['IMAGE'],TEXT_TO_VIDEO:['VIDEO'],TEXT_TO_AUDIO:['AUDIO']} as Record<string,string[]>)[plan.outputKind]??[]);}catch(error){issues.push(generationReadinessIssue(error,node));}
   for(const node of targets){try{
    if(node.data?.localVideoEdit===true)throw new ApiError(422,'LOCAL_MEDIA_RETRY_UNAVAILABLE','请从源视频重新打开对应处理工具，确认参数后提交。');
    if(node.type==='rh-ai'){const plan=plans.get(node.id);if(plan)await this.appInputs(node,plan,safe,epoch,deferredSourceIds,plans);continue;}
    if(['running','processing','uploading'].includes(node.data?.status))throw new ApiError(409,'NODE_INPUT_PENDING',node.data.status==='uploading'?'请等待素材上传完成。':'此节点仍在运行，请等待完成或停止当前任务。');
    if(isAudioExtraction(node)){
     if(group||nodeIds.length>1||safe.nodes.some(row=>row.type==='group'&&nodeIds.includes(row.id)))throw audioExtractionBatchError();
     const asset=await this.storage.resolveAsset(audioExtractionInput(node,safe));if(asset.kind!=='VIDEO')throw new ApiError(422,'VIDEO_REQUIRED','请连接已上传的视频。');
     validateMediaJob(audioExtractionSpec(asset.id),'EXTRACT_AUDIO',new Map([['source',asset]]),{executor:'FFMPEG',bizType:'CANVAS'});continue;
    }
    await this.prepareGenerationNode(projectId,node,safe,epoch,{preview:true,nativeVideoComposer:!group&&manager.localOnly===true&&nodeIds.length===1&&!['group','rh-group'].includes(safe.nodes.find(value=>value.id===nodeIds[0])?.type??''),deferredSourceIds,deferredOutputKinds});
   }catch(error){issues.push(generationReadinessIssue(error,node));}}
   this.check(epoch);return{status:issues.length?'blocked':'ready',issues,...(targets.length>1?{deferredNodeIds:[...deferredSourceIds]}:{})};
  }catch(error){return{status:'blocked',issues:[generationReadinessIssue(error,fallback)]};}
 }
 async reportGenerationReadinessFailure(projectId:string,issue:GenerationReadinessIssue,intent?:SnapshotIntent,graph?:NativeGraph){
  if(this.projectId!==projectId||!issue.nodeId)return;
  const error=withPreflightContext(new ApiError(422,issue.code,issue.message),issue.context??{schemaVersion:'1',...(issue.modelRef?{capabilityRef:issue.modelRef}:{}),...(issue.modelVersion?{capabilityVersion:issue.modelVersion}:{})});
  const snapshot=this.captureFailureSnapshot(projectId,intent??{targetId:issue.nodeId,targetType:'NODE',control:'GENERATE'},graph);
  if(snapshot)snapshot.phase='READINESS';
  return this.reportPreflightFailure({projectId,nodeId:issue.nodeId,observationTargetId:intent?.targetId},error,false,snapshot);
 }
 private validatePendingGenerationInputs(node:any,graph:NativeGraph,options:GenerationPreparationOptions){
  const sources=new Set([node.id,...graph.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source)]);
  for(const source of graph.nodes)if(sources.has(source.id)&&!(source.id!==node.id&&options.deferredSourceIds?.has(source.id))){
   const data=source.data??{},pending=data.status==='uploading'||data.uploading===true,failed=!!data.uploadError||data.uploadFailed===true;
   if(pending||failed)throw preflightError('MODEL_INPUT_UNSUPPORTED',`“${generationNodeName(source)}”的素材${pending?'仍在上传，请等待上传完成':'上传失败，请重新上传或移除该素材'}。`,undefined,{issues:[{field:'references.upload',reason:pending?'UPLOAD_PENDING':'UPLOAD_FAILED',sourceNodeId:source.id}]});
  }
 }
 private async prepareGenerationNode(projectId:string,node:any,graph:NativeGraph,epoch:number,options:GenerationPreparationOptions={}):Promise<{node:any;cap?:Capability;quickScene:boolean;inputAssets:PreflightAsset[];inputs:string[]}>{
  const history=await this.storage.historicalGenerationModel(projectId,node);this.check(epoch);
  if(history)node={...node,data:{...node.data,capabilityRef:history.capabilityRef,capabilityVersion:history.version,parameterSchemaVersion:history.parameterSchemaVersion}};
  const savedMode=resolveSavedVideoMode(node,history??this.capabilities.get(node.data?.capabilityRef??node.data?.modelCode));
  if(savedMode)node={...node,data:{...node.data,subType:savedMode}};
  if(savedMode||history)graph={...graph,nodes:graph.nodes.map(value=>value.id===node.id?node:value)};
  let nativeImageComposer=false;
  if(options.nativeVideoComposer&&usesNativeImageInputs(node)){
   const refs=nativeImageComposedReferences(node,graph,this.storage.encodeAsset,true);
   // Specialized sources/ports keep their separate execution contract.
   if(refs!==undefined){nativeImageComposer=true;
    if(refs.length||node.data?.params?.imageUrls){node={...node,data:{...node.data,params:{...node.data.params,imageUrls:refs}}};graph={...graph,nodes:graph.nodes.map(value=>value.id===node.id?node:value)};}
   }else if(graph.edges.filter(edge=>edge.target===node.id).every(edge=>!edge.conditioningRole&&(!edge.sourceHandle||edge.sourceHandle==='output')&&(!edge.targetHandle||edge.targetHandle==='input')&&['rh-image','rh-text'].includes(graph.nodes.find(n=>n.id===edge.source)?.type||''))){
    throw preflightError('ASSET_REFERENCE_REQUIRED','图片参考尚未上传或所选结果已不可用，请补齐或移除该参考。',this.capabilities.get(node.data?.capabilityRef??node.data?.modelCode),{issues:[{field:'references.kind',reason:'REFERENCE_REQUIRED',component:'REFERENCES',sourceNodeId:node.id}]});
   }
  }
  if(options.nativeVideoComposer&&!nativeImageComposer){const projected=projectNativeVideoInputs(node,graph,this.nativeTextProjection?.project);if(projected){if(projected.error)throw preflightError('ASSET_REFERENCE_REQUIRED',projected.error,this.capabilities.get(node.data?.capabilityRef??node.data?.modelCode),{issues:[{field:'references.kind',reason:'REFERENCE_REQUIRED',component:'REFERENCES',sourceNodeId:node.id}]});node={...node,data:projected.data};graph={...graph,nodes:graph.nodes.map(value=>value.id===node.id?node:value)};}else options={...options,nativeVideoComposer:false};}
  let data={...node.data};let quickScene=false;const kind=this.kind(node)||'',inputAssets:PreflightAsset[]=[];let inputs:string[]=[],cap:Capability|undefined;try{if(!kind)throw new ApiError(422,'GENERATION_TARGET_UNSUPPORTED','此类节点没有可用的生成服务，请选择可生成的内容节点。');this.validatePendingGenerationInputs(node,graph,options);if(node.type==='rh-image')data=normalizeNativeImagePrompt(data,node,graph,this.nativeTextProjection?.project);inputs=await this.nodeInputs(node,graph,inputAssets,options);let choice=modelChoice(data);
   if(await this.nativeImageParseDefault(node,data,graph,inputs,choice))choice=undefined;
   if(this.nativeQuickSceneDefault(node,data,graph,inputs,choice)){quickScene=true;choice=undefined;}
   if(this.nativeImageFeatureDefault(node,data,inputs,choice))choice=undefined;
   const old=choice&&this.capabilities.get(choice.capabilityRef);
   if(!choice?.capabilityVersion&&old?.testMode===false&&!old.model&&menuCapabilities([...this.capabilities.values()],kind,inputs,this.modelPolicy).some(cap=>cap.model))choice=undefined;
   const catalog=history?[history,...[...this.capabilities.values()].filter(value=>value.capabilityRef!==history.capabilityRef)]:[...this.capabilities.values()];
   cap=kind?await resolveCapability(path=>this.readCapabilityVersion(path),catalog,kind,inputs,choice,this.modelPolicy):undefined;this.check(epoch);if(!options.deferPresetValidation)validatePublishedImagePreset(node,cap);
   if(cap){data.modelCode=cap.capabilityRef;data.capabilityRef=cap.capabilityRef;data.capabilityVersion=cap.version;data.parameterSchemaVersion=cap.parameterSchemaVersion;data.testMode=!!cap.testMode;data.routerParameters=routerParameters(cap,data);if(node.type==='rh-video'){
    if(isH3(cap)||isVideoProfile(cap)){
     let historical=false;const references=new Set<string>();
     const futureKinds=this.deferredGenerationKinds(node,graph,options),knownGraph=options.deferredSourceIds?{...graph,edges:graph.edges.filter(edge=>!options.deferredSourceIds!.has(edge.source))}:graph;
     const media=(['image','video','audio'] as const).flatMap(type=>{const future=futureKinds.filter(kind=>kind===type.toUpperCase()),params={...data.params};if(future.length){delete params[type+'Urls'];delete params[type+'Url'];}const rows=nativeVideoReferences({...node,data:{...data,params}},knownGraph,type,options.nativeVideoComposer?{nativeComposer:true}:undefined);if(!rows){if(isVideoProfile(cap!))throw preflightError('ASSET_REFERENCE_REQUIRED',`视频参考素材不完整（${{image:'图片',video:'视频',audio:'音频'}[type]}），请重新添加或移除对应连线。`,cap,{issues:[{field:'references.kind',reason:'METADATA_MISSING',inputKind:preflightInputKinds([type])[0]}]});historical=true;return future.map(()=>({type}));}if(type==='image'&&cap!.parameterSchema?.['x-video-mode']==='FIRST_LAST_FRAME'&&new Set(rows).size!==rows.length)throw preflightError('MODEL_INPUT_UNSUPPORTED','当前首尾帧需要两份不同的图片素材，请替换重复的首帧或尾帧。',cap,{issues:[{field:'references.kind',reason:'PARAMETER_INVALID',inputKind:'IMAGE',component:'REFERENCES',sourceNodeId:node.id}]});for(const ref of rows)references.add(ref);return [...rows,...future].map(()=>({type}));});
     const problem=historical?null:videoPreflightError(cap,media);if(problem)throw problem;
     if(!historical&&cap.parameterSchema?.['x-input-media-constraints']){const assets=await Promise.all([...references].map(ref=>this.storage.resolveAsset(ref)));this.check(epoch);validateInputMedia(cap,assets);}
     data.routerParameters=videoParameters(cap,data.routerParameters);
    }
    const selection=videoPromptSelection(cap,{...node,data},graph,options.nativeVideoComposer);if(selection)data.promptSelection=selection;
   }}if(cap){const assets=inputAssets.flatMap(row=>row.asset?[row.asset]:[]);validateInputMedia(cap,assets);const planned=this.plannedGenerationMedia(node,graph,options);if(planned.length)validatePlannedInputMedia(cap,[...planned,...inputAssets.flatMap(row=>row.asset?.durationSeconds?[{sourceNodeId:row.sourceNodeId,kind:row.asset.kind,durationMs:Math.round(row.asset.durationSeconds*1000)}]:[])]);this.validateRequiredGenerationInputs(cap,{...node,data},graph,assets,options);}
   return{node:{...node,data},cap,quickScene,inputAssets,inputs};}catch(error){
    const context=preflightContext(error);
    if(context?.issues)withPreflightContext(error,{...context,issues:context.issues.flatMap(issue=>{
     if(issue.assetId){const owner=inputAssets.find(asset=>asset.assetId===issue.assetId);return[{...issue,...(owner?{sourceNodeId:owner.sourceNodeId}:{})}];}
     if(!['inputs.kind','references.kind'].includes(issue.field)||!issue.inputKind)return[issue];
     const rejected=inputAssets.filter(asset=>asset.inputKind===issue.inputKind);
     return rejected.length?rejected.map(asset=>({...issue,assetId:asset.assetId,sourceNodeId:asset.sourceNodeId})):[issue];
    })});
    throw this.rememberPreflightFailure(error,this.preflightTarget({projectId,targetId:node.id,graph:{nodes:[node],edges:[]}}),{schemaVersion:'1',requestedKind:kind,inputKinds:preflightInputKinds(inputs),...(cap?{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version}:{})});
   }
 }
 private async submit(body:any,allowServerBinding=true,intent?:SnapshotIntent){
  let evidence:CanvasFailureSnapshot|undefined,accepted=false;
  let localAttempt:LocalAttempt|undefined,attemptNodeId='',definiteRefusalReason:string|undefined;try{
  // A native parser can edit its mounted node while save/catalog awaits. The
  // submitted graph is the user's original command, including its raw prompt.
  const supplied=typeof body.canvas==='string'?JSON.parse(body.canvas):body.canvas||body.graph,commandProject=String(body.canvasId||body.projectId||this.projectId||'');this.storage.requirePermission(commandProject,'canRun');let snapshot=supplied?JSON.parse(JSON.stringify(this.storage.restoreModelBindings(commandProject,supplied))):undefined;
  const epoch=this.epoch,manager=this.manager,order=++this.submissionSequence;let nativeGroupCommand=false;
  evidence=this.captureFailureSnapshot(commandProject,intent??{targetId:String(body.targetId??''),targetType:body.targetType==='GROUP'?'GROUP':body.targetType==='CANVAS'?'CANVAS':'NODE',control:'COMMAND'},supplied);
  if(allowServerBinding&&manager&&this.projectId===commandProject){
   const pending=this.canvasLeasePort?.flushPending(commandProject);
   if(pending){if(evidence)evidence.phase='SYNC';await pending;if(evidence)evidence.phase='PREPARE';this.check(epoch);if(this.manager!==manager||this.projectId!==commandProject)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次生成尚未提交。');}
  }
  // Every native form queues its latest field patch immediately before submit.
  // Flush it before capturing the mounted baseline, including ordinary nodes;
  // the later autosave wait must never compare a new command to an old form.
  if(allowServerBinding&&manager&&this.projectId===commandProject&&['NODE','GROUP'].includes(body.targetType||'NODE'))manager.flushOperationQueue?.(true);
  if(allowServerBinding&&manager&&this.projectId===commandProject&&body.targetType==='GROUP'){
   const mounted=JSON.parse(JSON.stringify(this.storage.restoreModelBindings(commandProject,manager.getRemoteData())));
   const completed=completeNativeGroupCommand(snapshot,mounted,String(body.targetId||''));nativeGroupCommand=completed!==snapshot;snapshot=completed;
  }
  const initialTarget=(snapshot||manager?.getRemoteData())?.nodes?.find((node:any)=>node.id===String(body.targetId||''));
  if(initialTarget?.data?.localVideoEdit===true)throw new ApiError(501,'LOCAL_MEDIA_RETRY_UNAVAILABLE','请从源视频重新打开对应处理工具并提交；此结果节点不能使用模型生成重试。');
  if(isAudioExtraction(initialTarget)&&(body.targetType||'NODE')==='NODE'){
   const attached=manager&&this.projectId===commandProject,graphNow=()=>attached?manager.getRemoteData():snapshot;
   const read=()=>{this.check(epoch);if(attached&&(this.manager!==manager||this.projectId!==commandProject))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请在当前画布提取音轨。');
    const graph=graphNow(),target=graph?.nodes.find((row:any)=>row.id===initialTarget.id);if(!target)throw new ApiError(422,'GENERATION_TARGET_REQUIRED','音轨节点已删除。');return this.storage.encodeAsset(audioExtractionInput(target,graph));};
   const reference=read(),asset=await this.storage.resolveAsset(reference);
   if(asset.kind!=='VIDEO')throw new ApiError(422,'VIDEO_REQUIRED','请连接已上传的视频。');
   const guard=()=>{if(read()!==reference)throw new ApiError(409,'MEDIA_INPUT_CHANGED','输入视频已更换，请确认当前视频后再提取音轨。');};
   guard();const result=await this.submitMedia('/canvas/media/task/run',{projectId:commandProject,nodeId:initialTarget.id,operation:'EXTRACT_AUDIO',executor:'FFMPEG',bizType:'CANVAS',spec:audioExtractionSpec(asset.id)},guard);return{taskId:result.taskId,testMode:!!result.testMode};
  }
  const nativeParser=initialTarget?.type==='rh-text' &&initialTarget.data?.hidePromptInput===true&&String(initialTarget.data?.subType||'').toUpperCase().replaceAll('-','_')==='MULTIMODAL_TEXT';
  const bindingCandidate=allowServerBinding&&!nativeParser&&!isNativeRegionTransient(initialTarget)&&(body.targetType||'NODE')==='NODE'&&initialTarget&&['rh-text','rh-image','rh-video','rh-audio'].includes(initialTarget.type)&&!initialTarget.data?.storyboardEntityNode&&!initialTarget.data?.autoCreatedByAiApp&&manager&&this.projectId===commandProject&&(this.storage.snapshots.has(commandProject)||this.storage.projects.has(commandProject));
  attemptNodeId=String(body.targetId||'');const nativeIdentity=(id:string)=>this.nodeIdentity(manager,id),targetIdentity=nativeIdentity(attemptNodeId);
  // Native tP creates a command projection after persisting the panel values.
  // Guard later edits against the actual mounted view captured before awaits.
  const capturedServerGraph=bindingCandidate&&this.storage.snapshots.get(commandProject)?decodeGraph(structuredClone(this.storage.snapshots.get(commandProject)!.graph)):undefined;
  const nativeBaseline=bindingCandidate?JSON.parse(JSON.stringify(this.storage.restoreModelBindings(commandProject,manager.getRemoteData()))):undefined;
  snapshot=completeNativeVideoCommand(completeNativeImageToolCommand(restoreCommandSourceTypes(snapshot,nativeBaseline,attemptNodeId),nativeBaseline,attemptNodeId),nativeBaseline,attemptNodeId,this.capabilities.get(initialTarget?.data?.capabilityRef??initialTarget?.data?.modelCode));
  if(manager&&this.projectId===commandProject&&(body.targetType||'NODE')==='NODE'){
   this.stopRecoveredRuns(attemptNodeId);
   this.localAttempts.delete(attemptNodeId);this.settlements.delete(attemptNodeId);
   const lease=bindingCandidate&&targetIdentity?this.runningPort?.capture(attemptNodeId,manager):undefined;if(lease?.current()){localAttempt={order,epoch,manager,projectId:commandProject,nodeIdentity:targetIdentity,lease,baselineTaskId:String(nativeBaseline?.nodes.find((node:any)=>node.id===attemptNodeId)?.data?.taskId||''),submitted:false};this.localAttempts.set(attemptNodeId,localAttempt);}
  }
  if(bindingCandidate&&!this.storage.snapshots.has(commandProject))throw new ApiError(409,'BASE_UNKNOWN','画布版本尚未加载，请重新打开作品。');
  if(evidence)evidence.phase='SYNC';
  await this.saved();if(evidence)evidence.phase='PREPARE';this.check(epoch);if((bindingCandidate||nativeGroupCommand)&&(this.manager!==manager||this.projectId!==commandProject))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次生成尚未提交。');
  const projectId=commandProject;if(!projectId)throw new ApiError(422,'PROJECT_REQUIRED','请先打开作品。');
  const originalGraph=snapshot||this.manager?.getRemoteData();if(!Array.isArray(originalGraph?.nodes)||!Array.isArray(originalGraph?.edges))throw new ApiError(422,'GRAPH_REQUIRED','生成需要完整画布。');const graph=this.storage.restoreModelBindings(projectId,originalGraph);
  if(!this.capabilities.size)await this.catalog();this.check(epoch);
  const targetId=String(body.targetId||''),targetType=body.targetType||'NODE';
  const targetNode=graph.nodes.find((node:any)=>node.id===targetId);
  if(!['NODE','GROUP','CANVAS'].includes(targetType)||targetType!=='CANVAS'&&!targetNode)throw new ApiError(422,'GENERATION_TARGET_REQUIRED','生成目标已不存在，请重新选择当前节点或分组。');
  const groupTargets=targetType==='GROUP'?generationMembers(graph,[targetId]):new Set([targetId]);
  const selected=(node:any)=>isGenerationTarget(node)&&(targetType==='NODE'?node.id===targetId:targetType==='GROUP'?node.id!==targetId&&groupTargets.has(node.id):node.type!=='group');
  if(targetType==='NODE'&&isGenerationMaterialNode(targetNode))throw new ApiError(422,'GENERATION_TARGET_REQUIRED','上传素材无需再次生成，请将它连接到需要生成的内容节点。');
  if(targetType!=='NODE'&&graph.nodes.some((node:any)=>selected(node)&&isAudioExtraction(node)))throw audioExtractionBatchError();
  if(!graph.nodes.some(selected))throw new ApiError(422,'GENERATION_TARGET_REQUIRED','当前范围没有可生成的内容节点，请先添加内容。');
  if(allowServerBinding&&manager&&this.projectId===projectId){
   const pending=this.canvasLeasePort?.acquire(projectId,graph.nodes.filter(selected).map((node:any)=>String(node.id)));
   if(pending){await pending;this.check(epoch);if(this.manager!==manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次生成尚未提交。');}
  }
  if(graph.nodes.some((node:any)=>selected(node)&&node.type==='rh-ai'))return this.submitApps(body,projectId,graph,selected,epoch,order);
  const submittedGraph=targetType==='NODE'?nodeExecutionGraph(graph,targetId):targetType==='GROUP'?generationScopeGraph(graph,[targetId]):graph;
  await this.storage.prepareGraph(submittedGraph);this.check(epoch);const safeGraph:NativeGraph=cleanJson(submittedGraph,this.storage.encodeAsset);validateGenerationGraph(safeGraph,targetId);
  if(body.name!==undefined&&(typeof body.name!=='string'||new TextEncoder().encode(body.name).length>400))throw new ApiError(422,'GENERATION_NAME_INVALID','本次生成的名称最多400字节，请缩短后再提交。');
  const nativeQuickSceneTargets=new Set<string>();
  const resolvedCapabilities=new Map<string,Capability>();
  const deferredSourceIds=targetType==='NODE'?undefined:new Set<string>(safeGraph.nodes.filter(selected).map(node=>node.id));
  const nodes=await Promise.all(safeGraph.nodes.map(async(node:any)=>{if(!selected(node))return node;const result=await this.prepareGenerationNode(projectId,node,safeGraph,epoch,{deferredSourceIds,deferPresetValidation:!!bindingCandidate,nativeVideoComposer:!!bindingCandidate&&manager.localOnly===true});if(result.cap)resolvedCapabilities.set(node.id,result.cap);if(result.quickScene)nativeQuickSceneTargets.add(node.id);return result.node;}));
  let frozen=await this.freezeGraph({nodes,edges:safeGraph.edges},projectId,selected);this.check(epoch);
  let expectedRevision:number|undefined;
  if(bindingCandidate){
   const frozenTarget=frozen.nodes.find((node:any)=>node.id===targetId)!,generated=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','routerParameters','testMode'];
   const canonical=(value:NativeGraph)=>cleanJson(this.storage.remapGraphForProject(projectId,{nodes:value.nodes,edges:value.edges}),this.storage.encodeAsset);
   const before=canonical(nativeBaseline),command=canonical(graph);
   // Native media previews, resize commits and task receipts persist display
   // geometry/timing here. Nested parameters and output metadata stay guarded.
   const ignored=new Set(['__rhtv','title','label','modelName','modelNameEn','status','taskId','errorMsg','testMode','customBadgeText','progress','progressDetail','width','height','opResize','estimateTaskId','generationStartedAt','estimatedSeconds']);
   const semantic=(value:NativeGraph)=>{
    const selected=executionAncestors(value,targetId);
    return{nodes:value.nodes.filter((node:any)=>selected.has(node.id)).map((node:any)=>({id:node.id,type:node.type,data:Object.fromEntries(Object.entries(node.data||{}).filter(([key])=>!ignored.has(key)&&!(key==='maxConnect'&&node.id===targetId&&nativePortraitPortDefaults(node))))})).sort((a,b)=>a.id.localeCompare(b.id)),edges:value.edges.filter((edge:any)=>selected.has(edge.target)).map((edge:any)=>({source:edge.source,target:edge.target,sourceHandle:edge.sourceHandle??null,targetHandle:edge.targetHandle??null,conditioningRole:edge.conditioningRole??null}))};
   };
   const initial=before.nodes.find((node:any)=>node.id===targetId),projected=command.nodes.find((node:any)=>node.id===targetId);
   if(!initial||!projected)throw new ApiError(409,'STALE_EXECUTION_INPUT','节点已删除或重建，请重新生成。');
   const normalizeType=(value:any)=>String(value||'').toUpperCase().replaceAll('-','_'),cap=resolvedCapabilities.get(targetId)??this.capabilities.get(frozenTarget.data.capabilityRef),nativeModel=cap?capabilityModel(cap):undefined;
   const stale=(message:string,phase:'command'|'snapshot',component:Parameters<typeof executionInputFailure>[2],nodeId=targetId)=>{
    const labels:Record<string,string>={MODEL:'模型选择',PROMPT:'描述',REFERENCES:'参考素材',PARAMETERS:'参数',PRESETS:'预设条件',HISTORY:'历史结果',OUTPUT:'结果选择',TOPOLOGY:'连线',IDENTITY:'节点',PERMISSIONS:'权限',METADATA:'同步信息'};
    return executionInputFailure(cap,phase,component,nodeId,`${generationNodeName(before.nodes.find((node:any)=>node.id===nodeId))}（${labels[component]??'输入'}）：${message}`);
   };
   const projectionKeys=new Set<string>(),nativeEmptyDefaults=new Set<string>(),enhanceParamAliases=new Set<string>(),imageDefaultAliases=new Set<string>(),videoParamAliases=new Set<string>(),videoUiAliases=new Set<string>();let projectedTextAlias=false,projectedPromptAlias=false,projectedImageAlias=false,projectedHomeModelAlias=false,projectedStylePresetAlias=false;
   const plainText=initial.type==='rh-text'&&!initial.data?.hidePromptInput&&['','TEXT_TEXT','MULTIMODAL_TEXT'].includes(normalizeType(initial.data?.subType))&&!['TEXT_LYRICS'].includes(normalizeType(initial.data?.textUiCategory));
   const plainTextModel=plainText&&projected.type==='rh-text'&&cap?.kind==='LLM'&&cap.available&&cap.testMode===false&&!!cap.model&&initial.data?.modelCode===cap.capabilityRef&&projected.data?.modelCode===cap.capabilityRef;
   const restoreProjection=(key:string,valid:boolean)=>{if(equalDraftValue(projected.data?.[key],initial.data?.[key]))return;if(!valid)throw stale('生成命令与当前画布输入不一致，请重新生成。','command',key==='userPromptSnapshot'?'PROMPT':key==='modelType'||key==='subType'||key==='textModelListType'||key==='textUiCategory'?'MODEL':key==='maxConnect'?'TOPOLOGY':key==='nodeOutputHistory'?'HISTORY':'PRESETS');if(!['presetSelections','nodeOutputHistory'].includes(key))projectionKeys.add(key);if(Object.hasOwn(initial.data||{},key))projected.data[key]=initial.data[key];else delete projected.data[key];};
   // The captured H3 motion form has no prompt control. Its mounted params
   // omit prompt or retain a whitespace placeholder. Depending on its config,
   // q_/MCe omits that ignored parameter or adds an empty one and a snapshot.
   // Only that promptless profile's empty projection is equivalent; authored
   // text, other policies and all media/preset/history values remain guarded.
   const sourceMotionMetadata=cap?.capabilityRef==='h3-motion-transfer-v1'&&cap.version==='2'&&cap.parameterSchemaVersion==='2'?videoParameterMetadata(cap):undefined;
   const promptlessMotionVersion=cap?.version==='1'&&cap.parameterSchemaVersion==='1'||cap?.version==='2'&&cap.parameterSchemaVersion==='2'&&cap.kind==='VIDEO_TO_VIDEO'&&cap.model?.providerRef==='comfy'&&cap.model.modelRef==='h3'
    &&sourceMotionMetadata?.mode==='MOTION_TRANSFER'&&sourceMotionMetadata.durationPolicy==='SOURCE_VIDEO'&&sourceMotionMetadata.sourceSecondsMin===2&&sourceMotionMetadata.sourceSecondsMax===30;
   const promptlessMotion=initial.type==='rh-video'&&projected.type==='rh-video'&&cap?.capabilityRef==='h3-motion-transfer-v1'&&promptlessMotionVersion
    &&cap.available&&cap.testMode===false&&isVideoProfile(cap)&&cap.parameterSchema['x-video-mode']==='MOTION_TRANSFER'&&cap.parameterSchema['x-prompt-policy']==='ignored'
    &&initial.data?.modelCode===cap.capabilityRef&&projected.data?.modelCode===cap.capabilityRef
    &&initial.data?.prompt===''&&[initial.data?.params?.prompt,projected.data?.params?.prompt].every(value=>value===undefined||typeof value==='string'&&value.trim()==='');
   const userPrompt=promptlessMotion?(initial.data?.params?.prompt??''):initial.data?.params?.prompt;
   const nativeVideoInput=manager.localOnly===true?projectNativeVideoInputs(initial,before,this.nativeTextProjection?.project):undefined;
   const videoComposedPrompt=nativeVideoInput&&typeof userPrompt==='string'?nativeVideoComposedPrompt(userPrompt,initial,before,this.nativeTextProjection?.project):undefined;
   const nativeTextPromptOmission=!!plainTextModel&&typeof userPrompt==='string'&&initial.data?.prompt===userPrompt&&!Object.hasOwn(projected.data||{},'prompt');
   const nativeTextConnectionOmission=!!plainTextModel&&equalDraftValue(initial.data?.maxConnect,{image:null,text:null,video:null})&&!Object.hasOwn(projected.data||{},'maxConnect');
   // MCe projects every video form to its declared model config. The raw
   // mounted form can retain UI selectors, regardless of how the node was
   // created. Only the same real model/mode and schema-equivalent selectors
   // qualify; prompt, media, explicit params and selected history stay guarded.
   const savedVideoMode=resolveSavedVideoMode(initial,cap);if(savedVideoMode)projectionKeys.add('subType');
   const nativeVideoType=normalizeType(savedVideoMode??initial.data?.subType),videoFormModes:Record<string,string[]>={TEXT_VIDEO:['TEXT_TO_VIDEO'],IMAGE_VIDEO:['FIRST_FRAME','LAST_FRAME'],START_VIDEO:['FIRST_FRAME'],END_VIDEO:['LAST_FRAME'],START_END_VIDEO:['FIRST_LAST_FRAME'],MULTIMODAL_VIDEO:['OMNI_REFERENCE'],VIDEO_MOTION_TRANSFER:['MOTION_TRANSFER'],VIDEO_VIDEO:['VIDEO_TO_VIDEO','MOTION_TRANSFER'],VIDEO_EDIT:['VIDEO_TO_VIDEO'],VIDEO_EXTEND:['VIDEO_EXTEND'],VIDEO_CLIP_RESHOOT:['VIDEO_TO_VIDEO']};
   const nativeVideoForm=initial.type==='rh-video'&&projected.type==='rh-video'&&cap&&cap.available===true&&cap.testMode===false&&(isH3(cap)||isVideoCapability(cap))
    &&nativeKinds[nativeVideoType]===cap.kind&&videoFormModes[nativeVideoType]?.includes(cap.parameterSchema?.['x-video-mode'])&&normalizeType(projected.data?.subType)===nativeVideoType
    &&(!initial.data?.toolsType||normalizeType(initial.data.toolsType)===nativeVideoType)&&(!projected.data?.toolsType||normalizeType(projected.data.toolsType)===nativeVideoType)
    &&initial.data?.modelCode===cap.capabilityRef&&projected.data?.modelCode===cap.capabilityRef
    &&typeof userPrompt==='string'&&(promptlessMotion||projected.data?.params?.prompt===userPrompt||videoComposedPrompt!==undefined&&projected.data?.params?.prompt===videoComposedPrompt);
   const nativeVideoConnectionOmission=!!nativeVideoForm&&equalDraftValue(initial.data?.maxConnect,{image:null,text:null,video:null})&&!Object.hasOwn(projected.data||{},'maxConnect');
   if(nativeVideoForm){
    // These form caches are not execution inputs when absent from this model's
    // schema. MCe always omits them, including values retained from a previous
    // model or output preset. An explicit submitted value remains guarded.
    for(const key of ['rhModel','aspectRatio'])if(!cap.parameterSchema?.properties?.[key]&&Object.hasOwn(initial.data?.params||{},key)&&!Object.hasOwn(projected.data?.params||{},key)){
     projected.data.params={...projected.data.params,[key]:initial.data.params[key]};videoUiAliases.add(key);
    }
   }
   restoreProjection('userPromptSnapshot',typeof userPrompt==='string'?equalDraftValue(projected.data?.userPromptSnapshot,{paramName:'prompt',value:userPrompt}):projected.data?.userPromptSnapshot===undefined);
   if(initial.type==='rh-image'){const codes=nativeImagePromptCodes(initial.data);restoreProjection('promptCodes',equalDraftValue(projected.data?.promptCodes,codes.length?codes:undefined));}
   restoreProjection('modelType',!!nativeModel&&projected.data?.modelType===nativeModel.modelType);
   // Native P1t stores its locked panorama placeholder in the mounted node,
   // while tP submits the paused real T2I model and derived text scene. These
   // two fields are command metadata only for this exact captured selection.
   const nativeTextPanorama=initial.type==='rh-image'&&projected.type==='rh-image'
    &&normalizeType(initial.data?.subType)==='TEXT_IMAGE'&&normalizeType(projected.data?.subType)==='TEXT_IMAGE'
    &&!initial.data?.toolsType&&!projected.data?.toolsType&&initial.data?.modelCode===nativePanoramaAlias
    &&initial.data?.panorama?.isPanoramaNode===true&&initial.data?.panorama?.locked===true
    &&initial.data?.panorama?.pausedModel===cap?.capabilityRef&&equalDraftValue(initial.data.panorama,projected.data?.panorama)
    &&Array.isArray(initial.data?.presetSelections)&&initial.data.presetSelections.some((row:any)=>row?.key==='panorama'&&row.id==='panorama'&&row.labelKey==='canvas.imageToolbar.panorama')
    &&equalDraftValue(initial.data.presetSelections,projected.data?.presetSelections)
    &&!before.edges.some((edge:any)=>edge.target===targetId)&&!command.edges.some((edge:any)=>edge.target===targetId)
    &&[undefined,'canvas-image-panorama-text'].includes(initial.data?.sceneCode)
    &&projected.data?.sceneCode==='canvas-image-panorama-text'&&projected.data?.modelCode===cap?.capabilityRef
    &&cap?.capabilityRef==='codex-image-generate-v1'&&cap.version==='3'&&cap.kind==='TEXT_TO_IMAGE'&&cap.available&&cap.testMode===false
    &&cap.model?.providerRef==='codex'&&cap.model?.modelRef==='codex-image';
   if(nativeTextPanorama){restoreProjection('modelCode',true);restoreProjection('sceneCode',true);}

   // _X's direct homepage launch adds this redundant UI selector to params;
   // q_/MCe omits it from the native command's declared model parameters.
   // Accept only that omission for the same resolved production T2I model.
   if(initial.type==='rh-image'&&projected.type==='rh-image'&&normalizeType(initial.data?.subType)==='TEXT_IMAGE'&&normalizeType(projected.data?.subType)==='TEXT_IMAGE'&&!initial.data?.toolsType&&!projected.data?.toolsType&&cap?.kind==='TEXT_TO_IMAGE'&&cap.available&&cap.testMode===false&&!!cap.model&&!cap.parameterSchema?.properties?.rhModel&&initial.data?.modelCode===cap.capabilityRef&&projected.data?.modelCode===cap.capabilityRef&&initial.data?.params?.rhModel===cap.capabilityRef&&!Object.hasOwn(projected.data?.params||{},'rhModel')){
    projectedHomeModelAlias=true;projected.data.params={...projected.data.params,rhModel:cap.capabilityRef};
   }
   // Applying a built-in style can switch the native form from Z-Image to
   // Codex editing. nk retains its fixed Comfy preset in the mounted params,
   // but q_/MCe omits that undeclared field from the new model's command.
   if(initial.type==='rh-image'&&!initial.data?.toolsType&&normalizeType(initial.data?.subType)==='IMAGE_IMAGE'
    &&cap?.capabilityRef==='codex-image-edit-v1'&&cap.version==='3'&&cap.available&&cap.testMode===false&&cap.model?.providerRef==='codex'&&cap.model?.modelRef==='codex-image'
    &&initial.data?.modelCode===cap.capabilityRef&&projected.data?.modelCode===cap.capabilityRef
    &&initial.data?.params?.imageUrls===''&&initial.data?.params?.outputPreset==='1024-square'&&!cap.parameterSchema?.properties?.outputPreset
    &&!Object.hasOwn(projected.data?.params||{},'outputPreset')
    &&initial.data?.presetSelections?.some((row:any)=>row.key==='styleLibrary'&&['cinematic_realism','anime_illustration','product_ad','editorial_fashion'].includes(row.id)&&typeof row.referenceImageUrl==='string'&&this.storage.encodeAsset(row.referenceImageUrl).startsWith('rhtv-asset:'))
    &&equalDraftValue(initial.data.presetSelections,projected.data?.presetSelections)&&equalDraftValue(routerParameters(cap,initial.data),routerParameters(cap,projected.data))){
    projectedStylePresetAlias=true;projected.data.params={...projected.data.params,outputPreset:initial.data.params.outputPreset};
   }
   // SEr's enhance placeholder keeps a redundant singular source field. The
   // real image form drops it and introduces empty prompt/text controls.
   const enhanceSource=initial.data?.toolsSourceUrl,enhanceTool=normalizeType(initial.data?.toolsType);
   const enhancePlaceholder=enhanceTool==='IMAGE_ENHANCE'&&cap?.capabilityRef==='codex-image-edit-v1',promptlessEnhance=['IMAGE_ENHANCE','IMAGE_GIGAPIXEL','IMAGE_HD'].includes(enhanceTool)&&cap?.kind==='IMAGE_ENHANCE'&&cap.available&&cap.testMode===false&&!!cap.model&&cap.parameterSchema?.['x-prompt-policy']==='ignored';
   if(initial.type==='rh-image'&&(enhancePlaceholder||promptlessEnhance)&&initial.data?.prompt===''&&initial.data?.params?.prompt===undefined&&typeof enhanceSource==='string'&&enhanceSource.startsWith('rhtv-asset:')&&projected.data?.toolsSourceUrl===enhanceSource&&initial.data?.params?.imageUrl===enhanceSource&&equalDraftValue(initial.data?.params?.imageUrls,[enhanceSource])&&equalDraftValue(projected.data?.params?.imageUrls,[enhanceSource])){
    projected.data.params={...projected.data.params};for(const key of ['prompt','text'])if(initial.data.params[key]===undefined&&projected.data.params[key]===''){delete projected.data.params[key];enhanceParamAliases.add(key);}
    if(projected.data.params.imageUrl===undefined){projected.data.params.imageUrl=enhanceSource;enhanceParamAliases.add('imageUrl');}
   }
   // Reopened Codex image forms materialize this boolean schema default.
   // Accept only an omitted value becoming its already-effective value.
   if(initial.type==='rh-image'&&['codex-image-generate-v1','codex-image-edit-v1'].includes(cap?.capabilityRef??'')&&initial.data?.params?.transparentBackground===undefined&&cap?.parameterSchema?.properties?.transparentBackground?.default===false&&projected.data?.params?.transparentBackground===false&&equalDraftValue(routerParameters(cap,initial.data),routerParameters(cap,projected.data))){
    projected.data.params={...projected.data.params};delete projected.data.params.transparentBackground;imageDefaultAliases.add('transparentBackground');
   }
   const mediaPrompt=['rh-image','rh-video','rh-audio'].includes(initial.type)&&typeof userPrompt==='string';
   const composedPrompt=initial.type==='rh-image'&&typeof userPrompt==='string'?nativeImageComposedPrompt(userPrompt,initial.data,initial,before,this.nativeTextProjection?.project):videoComposedPrompt??userPrompt;
   if(mediaPrompt&&!promptlessMotion&&!equalDraftValue(projected.data?.params?.prompt,userPrompt)){
    if(initial.type!=='rh-image'&&!nativeVideoInput||projected.data?.params?.prompt!==composedPrompt)throw stale('生成命令与当前画布输入不一致，请重新生成。','command','PROMPT');
    projected.data.params={...projected.data.params,prompt:userPrompt};
   }
   if(promptlessMotion){projected.data.params={...projected.data.params};if(Object.hasOwn(initial.data?.params??{},'prompt'))projected.data.params.prompt=initial.data.params.prompt;else delete projected.data.params.prompt;projectedPromptAlias=true;}
   restoreProjection('prompt',nativeTextPromptOmission||mediaPrompt&&(projected.data?.prompt===userPrompt||projected.data?.prompt===composedPrompt));
   if(nativeTextConnectionOmission||nativeVideoConnectionOmission)restoreProjection('maxConnect',true);
   if(mediaPrompt&&!cap?.parameterSchema?.properties?.text&&!equalDraftValue(projected.data?.params?.text,initial.data?.params?.text)){
    if(!((nativeVideoForm||initial.type==='rh-image')&&!Object.hasOwn(projected.data?.params||{},'text'))&&projected.data?.params?.text!==userPrompt&&projected.data?.params?.text!==composedPrompt)throw stale('生成命令与当前画布输入不一致，请重新生成。','command','PROMPT');projectedTextAlias=true;if(Object.hasOwn(initial.data?.params||{},'text'))projected.data.params.text=initial.data.params.text;else delete projected.data.params.text;
   }
   if(initial.type==='rh-image'&&!equalDraftValue(projected.data?.params?.imageUrls,initial.data?.params?.imageUrls)){
    const references=nativeImageComposedReferences(initial,before,this.storage.encodeAsset,manager.localOnly===true&&usesNativeImageInputs(initial));
    if(!references||!equalDraftValue(projected.data?.params?.imageUrls,references))throw stale('参考图片与当前画布不一致，请重新生成。','command','REFERENCES');
    projectedImageAlias=true;projected.data.params={...projected.data.params};if(Object.hasOwn(initial.data?.params||{},'imageUrls'))projected.data.params.imageUrls=initial.data.params.imageUrls;else delete projected.data.params.imageUrls;
   }
   if(manager.localOnly===true&&usesNativeImageInputs(initial)&&!equalDraftValue(frozenTarget.data?.params?.imageUrls,initial.data?.params?.imageUrls))projectedImageAlias=true;
   if(initial.type==='rh-video'&&(cap?.model?.modelRef==='h3'||isVideoCapability(cap)))for(const kind of ['image','video','audio'] as const){
    const key=kind+'Urls';if(equalDraftValue(projected.data?.params?.[key],initial.data?.params?.[key])){if(nativeVideoInput&&!equalDraftValue(frozenTarget.data?.params?.[key],initial.data?.params?.[key]))videoParamAliases.add(key);continue;}
    const references=nativeVideoReferences(initial,before,kind,nativeVideoInput?{nativeComposer:true}:undefined);
    const omittedEmpty=nativeVideoInput&&nativeVideoForm&&references?.length===0&&!Object.hasOwn(projected.data?.params||{},key)&&!nativeModel?.config?.some((field:any)=>field.paramName===key);
    if(!references||!omittedEmpty&&!equalDraftValue(projected.data?.params?.[key],references))throw stale('视频参考素材与当前画布不一致，请重新生成。','command','REFERENCES');
    videoParamAliases.add(key);projected.data.params={...projected.data.params};if(Object.hasOwn(initial.data?.params||{},key))projected.data.params[key]=initial.data.params[key];else delete projected.data.params[key];
   }
   for(const key of ['presetSelections','nodeOutputHistory']){
    // The H3 composer serializes a cleared preset (null) as []. Both mean no
    // preset; never accept dropping an actual selection or rewriting history.
    if(key==='presetSelections'&&initial.type==='rh-video'&&cap?.model?.modelRef==='h3'&&initial.data?.presetSelections===null&&Array.isArray(projected.data?.presetSelections)&&projected.data.presetSelections.length===0){restoreProjection(key,true);projectionKeys.add(key);continue;}
    const noPrevious=initial.data?.[key]===undefined,empty=Array.isArray(projected.data?.[key])&&projected.data[key].length===0;
    // Native W8 adds empty image selection/history arrays even when a tool
    // intentionally has no prompt control (cutout, light, erase, expand).
    restoreProjection(key,(initial.type==='rh-image'||mediaPrompt)&&noPrevious&&empty&&(key!=='nodeOutputHistory'||!initial.data?.historyStorage&&(!initial.data?.output||Array.isArray(initial.data.output)&&!initial.data.output.length)));
    if(noPrevious&&empty)nativeEmptyDefaults.add(key);
   }
   const nativeTextType=plainText&&cap?['MULTIMODAL_TEXT','IMAGE_TEXT','VIDEO_TEXT','TEXT_TEXT','TEXT_LYRICS'].find(type=>this.modelsForType([...this.capabilities.values()],type).some(model=>model.modelCode===cap.capabilityRef)):undefined;
   const nativeListType=nativeTextType==='MULTIMODAL_TEXT'?'MULTIMODAL_TEXT':nativeTextType==='TEXT_LYRICS'?'TEXT_LYRICS':'TEXT_TEXT';
   restoreProjection('subType',!!nativeTextType&&normalizeType(projected.data?.subType)===nativeTextType||!!savedVideoMode&&projected.data?.subType===savedVideoMode);
   restoreProjection('textModelListType',!!nativeTextType&&normalizeType(projected.data?.textModelListType)===nativeListType);
   restoreProjection('textUiCategory',!!nativeTextType&&normalizeType(projected.data?.textUiCategory)==='TEXT_TEXT');
   if(!equalDraftValue(semantic(command),semantic(before))){const difference=executionDifference(semantic(before),semantic(command),targetId);throw stale('生成命令与当前画布输入不一致，请重新生成。','command',difference.component,difference.nodeId);}
   validatePublishedImagePreset(frozenTarget,resolvedCapabilities.get(targetId));
   const current=()=>this.storage.restoreModelBindings(projectId,manager.getRemoteData());
   const quickSceneDefaults={subType:'image-image',maxConnect:{image:null,text:null,video:null}};
   const check=(allowSaveCatchUp=false)=>{
    this.check(epoch);if(this.manager!==manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次生成尚未提交。');
    if(targetIdentity&&nativeIdentity(targetId)!==targetIdentity)throw stale('节点已删除或重建，请重新生成。','snapshot','IDENTITY');
    const live=current();if(!live||!Array.isArray(live.nodes)||!Array.isArray(live.edges))throw stale('画布输入已更改，请重新生成。','snapshot','IDENTITY');
    const normalized=canonical(live),normalizedBefore=canonical(before),node=normalized.nodes.find((value:any)=>value.id===targetId),initial=normalizedBefore.nodes.find((value:any)=>value.id===targetId);
    if(!node||!initial||this.storage.isBlocked(projectId)&&!(allowSaveCatchUp&&this.storage.isSaveCatchingUp(projectId)))throw stale('画布输入已更改，请重新生成。','snapshot',!node||!initial?'IDENTITY':'METADATA');
    // W8's exact empty defaults may reach the mounted node after run() starts.
    // Only normalize fields already accepted from this captured command.
    for(const key of nativeEmptyDefaults)if(initial.data?.[key]===undefined&&Array.isArray(node.data?.[key])&&node.data[key].length===0)delete node.data[key];
    // Live sync can apply this submission's own saved projection before its
    // PUT receipt returns. Accept only exact values already validated against
    // this captured command; unrelated later edits still compare unchanged.
    for(const key of projectionKeys)if(equalDraftValue(node.data?.[key],frozenTarget.data?.[key])){
     if(Object.hasOwn(initial.data||{},key))node.data[key]=initial.data[key];else delete node.data[key];
    }
    const parameterAliases=[...(projectedPromptAlias?['prompt']:[]),...(projectedTextAlias?['text']:[]),...(projectedImageAlias?['imageUrls']:[]),...(projectedHomeModelAlias?['rhModel']:[]),...(projectedStylePresetAlias?['outputPreset']:[]),...enhanceParamAliases,...imageDefaultAliases,...videoParamAliases,...videoUiAliases];
    for(const key of parameterAliases)if(equalDraftValue(node.data?.params?.[key],frozenTarget.data?.params?.[key])){
     node.data.params={...node.data.params};if(Object.hasOwn(initial.data?.params||{},key))node.data.params[key]=initial.data.params[key];else delete node.data.params[key];
    }
    for(const key of imageDefaultAliases)if(initial.data?.params?.[key]===undefined&&node.data?.params?.[key]===false){node.data.params={...node.data.params};delete node.data.params[key];}
    if(projectedHomeModelAlias&&!Object.hasOwn(node.data?.params||{},'rhModel'))node.data.params={...node.data.params,rhModel:initial.data.params.rhModel};
    if(projectedStylePresetAlias&&!Object.hasOwn(node.data?.params||{},'outputPreset'))node.data.params={...node.data.params,outputPreset:initial.data.params.outputPreset};
    if(nativeTextPromptOmission&&!Object.hasOwn(node.data||{},'prompt'))node.data.prompt=initial.data.prompt;
    if(nativeTextConnectionOmission&&!Object.hasOwn(node.data||{},'maxConnect'))node.data.maxConnect=initial.data.maxConnect;
    if(nativeVideoConnectionOmission&&!Object.hasOwn(node.data||{},'maxConnect'))node.data.maxConnect=initial.data.maxConnect;
    for(const key of videoUiAliases)if(!Object.hasOwn(node.data?.params||{},key))node.data.params={...node.data.params,[key]:initial.data.params[key]};
    if(nativeTextPanorama&&node.data?.sceneCode===frozenTarget.data.sceneCode){if(Object.hasOwn(initial.data||{},'sceneCode'))node.data.sceneCode=initial.data.sceneCode;else delete node.data.sceneCode;}
    // The frozen editor asynchronously mounts the real quick-scene model and
    // adds these exact input defaults. Only accept the already-validated alias
    // transition; existing values, prompts and references remain guarded.
    if(nativeQuickSceneTargets.has(targetId)&&node.data?.modelCode===frozenTarget.data.modelCode)for(const [key,value]of Object.entries(quickSceneDefaults)){
     if(initial.data?.[key]===undefined&&equalDraftValue(node.data?.[key],value))delete node.data[key];
    }
    for(const key of generated){if(!equalDraftValue(node.data?.[key],initial.data?.[key])&&!equalDraftValue(node.data?.[key],frozenTarget.data?.[key]))throw stale('生成选型已更改，请重新生成。','snapshot','MODEL');if(Object.hasOwn(initial.data||{},key))node.data[key]=initial.data[key];else delete node.data[key];}
    if(!equalDraftValue(semantic(normalized),semantic(normalizedBefore))){const difference=executionDifference(semantic(normalizedBefore),semantic(normalized),targetId);throw stale('画布输入已更改，请重新生成。','snapshot',difference.component,difference.nodeId);}
   };
   check();const latest=current(),latestTarget=latest.nodes.find((node:any)=>node.id===targetId);
   if(nativePortraitPortDefaults(latestTarget)){
    frozenTarget.data.maxConnect=structuredClone(latestTarget.data.maxConnect);
   }else if(nativePortraitPortDefaults(frozenTarget)&&!Object.hasOwn(latestTarget?.data??{},'maxConnect')){
    delete frozenTarget.data.maxConnect;
   }
   if(nativeQuickSceneTargets.has(targetId)&&latestTarget?.data?.modelCode===frozenTarget.data.modelCode)for(const [key,value]of Object.entries(quickSceneDefaults))if(initial.data?.[key]===undefined&&equalDraftValue(latestTarget.data?.[key],value))frozenTarget.data[key]=structuredClone(value);
   const exact={...latest,nodes:latest.nodes.map((node:any)=>{
    if(node.id!==targetId)return node;const data={...frozenTarget.data};for(const key of ignored){if(generated.includes(key))continue;if(Object.hasOwn(node.data||{},key))data[key]=node.data[key];else delete data[key];}return{...node,data};
   })};
   const projectionBase=(base:NativeGraph,ack:NativeGraph)=>{
    const prior=ack.nodes.find((node:any)=>node.id===targetId);if(!prior)return base;
    return{...base,nodes:base.nodes.map((node:any)=>{if(node.id!==targetId)return node;const data={...node.data};for(const key of projectionKeys){if(Object.hasOwn(prior.data||{},key))data[key]=prior.data[key];else delete data[key];}for(const key of [...(projectedTextAlias?['text']:[]),...(projectedPromptAlias?['prompt']:[]),...(projectedImageAlias?['imageUrls']:[]),...(projectedHomeModelAlias?['rhModel']:[]),...(projectedStylePresetAlias?['outputPreset']:[]),...enhanceParamAliases,...imageDefaultAliases,...videoParamAliases,...videoUiAliases]){data.params={...data.params};if(Object.hasOwn(prior.data?.params||{},key))data.params[key]=prior.data.params[key];else delete data.params[key];}return{...node,data};})};
   };
   if(evidence)evidence.phase='SYNC';
   const receipt=await this.storage.saveForExecution(projectId,exact,current,check,projectionBase);if(evidence)evidence.phase='PREPARE';check();
   frozen=this.storage.remapGraphForProject(projectId,frozen);
   const acknowledged=canonical(decodeGraph(receipt.graph));
   frozen=restoreCapturedImageResultMetadata(frozen,acknowledged,capturedServerGraph?canonical(capturedServerGraph):undefined,targetId);
   frozen=restoreSavedVideoSourceMetadata(restoreSavedImageUploadMetadata(frozen,acknowledged,targetId),acknowledged,targetId);
   if(!equalDraftValue(semantic(frozen),semantic(acknowledged))){const difference=executionDifference(semantic(frozen),semantic(acknowledged),targetId);throw stale('保存后的输入与本次生成不一致，请重新生成。','snapshot',difference.component,difference.nodeId);}
   expectedRevision=receipt.revision;
  }
  if(nativeGroupCommand&&(this.manager!==manager||this.projectId!==projectId))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次生成尚未提交。');
  this.storage.requirePermission(projectId,'canRun');
  if(localAttempt)localAttempt.submitted=true;
  if(evidence)evidence.phase='SUBMIT';
  let task:any;try{task=(await this.api.requestV2<any>('/canvas-runs',{method:'POST',idempotencyKey:randomUuid(),body:{projectId,targetType,targetId,graph:frozen,...(expectedRevision!==undefined?{expectedRevision}:{}),...(body.name?{name:body.name}:{}),...(body.execution_key||body.executionKey?{executionKey:body.execution_key||body.executionKey}:{})}})).data;}
  catch(error){if(localAttempt&&!localAttempt.taskId&&this.localAttempts.get(attemptNodeId)===localAttempt&&definiteCanvasRejection(error)){localAttempt.submitted=false;definiteRefusalReason=error.message;}throw error;}accepted=true;this.check(epoch);
  if(expectedRevision!==undefined&&(!this.serverManaged(task)||task.projectId!==projectId||task.plans.length!==1||task.plans[0].nodeId!==targetId))throw new ApiError(502,'INVALID_CANVAS_EXECUTION','服务器未确认本次节点的画布结果回写。');
  if(this.manager===manager&&this.projectId===projectId)for(const node of frozen.nodes){const current=manager?.getRemoteData()?.nodes.find((value:any)=>value.id===node.id);if(current?.data?.modelCode===node.data?.modelCode){const bound=this.storage.restoreModelBindings(projectId,{nodes:[current],edges:[]}).nodes[0];if(!bound.data?.capabilityVersion||bound.data.capabilityVersion===node.data.capabilityVersion)this.storage.rememberModelBinding(projectId,current,node.data);}}
  if(typeof task.id==='string'&&[...resolvedCapabilities.values()].some(cap=>videoCancellationReason(cap)))this.nonCancelableVideoTasks.add(task.id);
  this.claim(task,manager,projectId,order,expectedRevision);await this.apply(task);if(this.projectId===projectId&&!terminal.has(String(task.state).toUpperCase())&&(this.manager?.getRemoteData()?.nodes.some((n:any)=>n.id===targetId)||targetType!=='NODE'))this.watch(task.id);return{taskId:task.id,testMode:!!task.testMode};
  }catch(error){
   if(error instanceof Error){if(accepted)this.acceptedResponseErrors.add(error);else if(evidence&&!this.attemptSnapshots.has(error))this.attemptSnapshots.set(error,evidence);}
   if(localAttempt&&!localAttempt.submitted&&this.localAttempts.get(attemptNodeId)===localAttempt){this.settlements.set(attemptNodeId,{attempt:localAttempt,kind:'NOT_SUBMITTED',...(definiteRefusalReason?{reason:definiteRefusalReason}:{})});this.drainSettlements();}throw error;}
 }
 private parameters(cap:Capability,data:any){return routerParameters(cap,data);}
 private async appPlan(node:any,epoch:number):Promise<AppPlan>{
  if(typeof node.id!=='string'||!node.id||node.id.length>200)throw new ApiError(422,'APP_NODE_INVALID','应用节点标识无效，请重新添加该节点。');
  const appId=String(node.data?.aiApp?.id??node.data?.webappId??'');if(!appId)throw new ApiError(422,'APP_REQUIRED','应用节点缺少真实的 APP 标识。');
  const row=(await this.api.requestV2<any>('/apps/'+encodeURIComponent(appId))).data;this.check(epoch);
  const resource=row.resource??row,content=row.content;
  if(String(resource.id)!==appId||!Number.isSafeInteger(resource.revision)||!Array.isArray(content?.inputNodes))throw new ApiError(502,'INVALID_APP_DEFINITION','应用没有有效的当前版本或输入表单。');
  const fields=content.inputNodes,inputs=node.data?.aiApp?.inputNodes;
  if(!Array.isArray(inputs)||fields.length>200||inputs.length!==fields.length||new Set(fields.map((field:any)=>JSON.stringify([field.nodeId,field.fieldName]))).size!==fields.length||fields.some((field:any)=>!inputs.some((input:any)=>String(input.nodeId)===String(field.nodeId)&&input.fieldName===field.fieldName)))throw new ApiError(422,'APP_FORM_CHANGED','应用输入表单已更新，请重新添加应用节点。');
  const kind=appOutputKind(content,node.data?.aiNodeOutputType),cap=this.preferred([...this.capabilities.values()],kind||'');
  if(!cap)throw new ApiError(501,'TEST_CAPABILITY_UNAVAILABLE','此应用输出类型尚未配置测试模型。');
  return{appId,revision:resource.revision,fields,cap,parameters:this.parameters(cap,node.data),outputKind:kind||''};
 }
 private async appInputs(node:any,plan:AppPlan,graph:NativeGraph,epoch:number,deferred:ReadonlySet<string>=new Set(),plans:ReadonlyMap<string,AppPlan>=new Map()){
  return Promise.all(plan.fields.map(async(field:any)=>{
   const input=node.data.aiApp.inputNodes.find((value:any)=>String(value.nodeId)===String(field.nodeId)&&value.fieldName===field.fieldName),kind=String(field.fieldType||'STRING').toUpperCase(),label=`应用“${String(node.data?.title||node.data?.label||node.id)}”的“${String(field.fieldName)}”`;
   const invalid=(message:string,reason:PreflightIssue['reason']='PARAMETER_INVALID')=>preflightError('APP_INPUT_TYPE',label+message,plan.cap,{issues:[{field:'parameters',reason,component:'PARAMETERS',sourceNodeId:node.id}]});
   let config:any=[];try{config=typeof field.fieldData==='string'?JSON.parse(field.fieldData):field.fieldData??[];}catch{throw new ApiError(502,'INVALID_APP_DEFINITION',label+'的字段配置无效，请重新加载应用。');}
   if(!Array.isArray(config))throw new ApiError(502,'INVALID_APP_DEFINITION',label+'的字段配置无效，请重新加载应用。');
   let value=input.fieldValue;
   if(input.binding?.sourceNodeId){
    const source=graph.nodes.find((item:any)=>item.id===input.binding.sourceNodeId);
    if(!source||!graph.edges.some((edge:any)=>edge.source===source.id&&edge.target===node.id))throw invalid('的输入绑定已失效，请重新连接对应来源。','REFERENCE_REQUIRED');
    if(deferred.has(source.id)){
     const sourceKind=plans.get(source.id)?.outputKind??this.kind(source)??'',choice=modelChoice(source.data),selected=choice?this.capabilities.get(choice.capabilityRef):undefined;
     const inferred=sourceKind==='LLM'?['TEXT','STRUCTURED']:sourceKind.includes('IMAGE')?['IMAGE']:sourceKind.includes('VIDEO')||sourceKind==='OMNI_REFERENCE'?['VIDEO']:sourceKind.includes('AUDIO')||sourceKind==='TEXT_TO_MUSIC'?['AUDIO']:[];
     const outputs=selected?.outputKinds?.length?selected.outputKinds:inferred,expected=['IMAGE','VIDEO','AUDIO','FILE'].includes(kind)?kind:'TEXT';
     if(expected&&!outputs.includes(expected))throw invalid('与上游输出类型不匹配，请连接'+({IMAGE:'图片',VIDEO:'视频',AUDIO:'音频',FILE:'文件',TEXT:'文字'}as Record<string,string>)[expected]+'来源。','KIND_MISMATCH');
     // Only the value produced by a future upstream run is deferred. The
     // graph binding, current form and declared source type are checked now.
     return{nodeId:String(field.nodeId),fieldName:field.fieldName,deferred:true};
    }
    const data=source.data||{},outputs=Array.isArray(data.output)?data.output:[],first=outputs[0];
    value=!['IMAGE','VIDEO','AUDIO','FILE'].includes(kind)?data.text??data.content??first?.text??'':first?.assetId?'rhtv-asset:'+first.assetId:typeof first==='string'?first:first?.url??first?.fileUrl??data.sourceObjects?.[0]??data.imageUrl??data.videoUrl??data.audioUrl??'';
    if(value&&typeof value==='object')value=value.assetId?'rhtv-asset:'+value.assetId:value.url??value.fileUrl??value.originalUrl??'';
   }
   if(value===undefined||value===null)value=field.fieldValue??config[1]?.default;
   if(['IMAGE','VIDEO','AUDIO','FILE'].includes(kind)){
    if(typeof value!=='string'||!value)throw preflightError('APP_INPUT_REQUIRED',label+'需要已上传的素材，请补齐后再提交。',plan.cap,{issues:[{field:'references.kind',reason:'REFERENCE_REQUIRED',sourceNodeId:node.id}]});
    let asset;try{asset=await this.storage.resolveAsset(value);}catch(error){if(error instanceof ApiError){error.message=label+'的素材无法使用：'+error.message;withPreflightContext(error,{issues:[{field:'references.upload',reason:'UPLOAD_FAILED',sourceNodeId:node.id}]});}throw error;}this.check(epoch);if(asset.kind&&asset.kind!==kind)throw invalid('的素材类型不匹配，请重新选择对应类型。','KIND_MISMATCH');value='rhtv-asset:'+asset.id;
   }else if(['INT','INTEGER','FLOAT','DOUBLE','NUMBER'].includes(kind)){
    if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())throw invalid('需要有效数字，请填写后再提交。');value=Number(value);
    if(!Number.isFinite(value)||(['INT','INTEGER'].includes(kind)&&!Number.isInteger(value))||config[1]?.min!==undefined&&value<config[1].min||config[1]?.max!==undefined&&value>config[1].max)throw invalid('的数字超出允许范围'+(config[1]?.min!==undefined||config[1]?.max!==undefined?`（${config[1]?.min??'不限'}～${config[1]?.max??'不限'}）`:'')+'，请调整后再提交。');
   }else if(['BOOLEAN','BOOL'].includes(kind)){
    if(value==='true')value=true;else if(value==='false')value=false;if(typeof value!=='boolean')throw invalid('需要选择开启或关闭。');
   }else{
    if(typeof value!=='string'||value.includes('\0'))throw invalid('的文字内容无效，请重新填写。');
    if(Array.isArray(config[0])&&config[0].length&&!config[0].some((choice:any)=>String(choice)===value))throw invalid('的选项不在当前表单中，请重新选择。');
   }
   if(new TextEncoder().encode(JSON.stringify(value)).length>200000)throw invalid('的内容超过200,000字节，请缩短内容或更换素材。');
   return{nodeId:String(field.nodeId),fieldName:field.fieldName,fieldValue:value};
  }));
 }
 private async submitApps(body:any,projectId:string,graph:NativeGraph,selected:(node:any)=>boolean,epoch:number,order:number){
  const manager=this.projectId===projectId?this.manager:null,check=()=>{this.check(epoch);this.storage.requirePermission(projectId,'canRun');if(manager&&(this.manager!==manager||this.projectId!==projectId))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，后续应用执行已取消。');};check();
  const current=manager?.getRemoteData();
  if(current&&graph.nodes.length===1&&graph.edges.length===0){const overrides=new Map(graph.nodes.map(node=>[node.id,node]));graph={...current,nodes:current.nodes.map((node:any)=>overrides.get(node.id)??node)};}
  // Every APP goes through the authoritative form validator. Separate persisted tasks remain separate IDs.
  const failure=(error:unknown,node:any)=>this.rememberPreflightFailure(error,this.preflightTarget({projectId,targetId:node.id,graph:{nodes:[node],edges:[]}}),{...(plans.get(node.id)?{capabilityRef:plans.get(node.id)!.cap.capabilityRef,capabilityVersion:plans.get(node.id)!.cap.version}:{}),issues:preflightContext(error)?.issues??[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',sourceNodeId:node.id}]});
  const plans=new Map<string,AppPlan>();for(const node of graph.nodes)if(selected(node)&&node.type==='rh-ai'){try{plans.set(node.id,await this.appPlan(node,epoch));check();}catch(error){throw failure(error,node);}}
  const boundSources=new Set(graph.nodes.flatMap((node:any)=>node.type==='rh-ai'?(node.data?.aiApp?.inputNodes||[]).map((field:any)=>field.binding?.sourceNodeId).filter(Boolean):[]));
  const targets=graph.nodes.filter((node:any)=>selected(node)&&(node.type==='rh-ai'||this.kind(node)&&!node.data?.autoCreatedByAiApp&&!node.data?.isUpload&&!(boundSources.has(node.id)&&!node.data?.modelCode&&!node.data?.capabilityRef)));
  const ids=new Set(targets.map((node:any)=>node.id)),ordered:any[]=[],visiting=new Set<string>(),visited=new Set<string>();
  const visit=(node:any)=>{if(visiting.has(node.id))throw failure(preflightError('GRAPH_CYCLE','应用连线形成循环，请断开返回上游的连线。',plans.get(node.id)?.cap,{issues:[{field:'inputs.command',reason:'PARAMETER_INVALID',component:'TOPOLOGY',sourceNodeId:node.id}]}),node);if(visited.has(node.id))return;visiting.add(node.id);for(const edge of graph.edges)if(edge.target===node.id&&ids.has(edge.source))visit(targets.find((item:any)=>item.id===edge.source));visiting.delete(node.id);visited.add(node.id);ordered.push(node);};targets.forEach(visit);
  const working=cleanJson(graph,this.storage.encodeAsset),tasks:any[]=[],deferredOutputKinds=new Map<string,string[]>();
  for(const [id,plan]of plans){const kind=plan.outputKind;deferredOutputKinds.set(id,kind==='LLM'?['TEXT','STRUCTURED']:kind.includes('IMAGE')?['IMAGE']:kind.includes('VIDEO')||kind==='OMNI_REFERENCE'?['VIDEO']:kind.includes('AUDIO')||kind==='TEXT_TO_MUSIC'?['AUDIO']:[]);}
  // Validate every currently knowable input before creating the first task.
  // Future upstream output values are deferred, never fabricated as assets.
  for(const node of ordered){try{if(node.type==='rh-ai')await this.appInputs(node,plans.get(node.id)!,working,epoch,ids,plans);else await this.prepareGenerationNode(projectId,node,working,epoch,{deferredSourceIds:ids,deferredOutputKinds});check();}catch(error){throw failure(error,node);}}
  for(const target of ordered){
   check();const node=working.nodes.find((item:any)=>item.id===target.id)!;let task:any;
   if(node.type==='rh-ai'){
    const plan=plans.get(node.id)!;let inputNodes:any[];try{inputNodes=await this.appInputs(node,plan,working,epoch);check();}catch(error){throw failure(error,node);}
    task=(await this.api.requestV2<any>('/app-runs',{method:'POST',idempotencyKey:randomUuid(),body:{projectId,nodeId:node.id,appId:plan.appId,appRevision:plan.revision,inputNodes,capabilityRef:plan.cap.capabilityRef,capabilityVersion:plan.cap.version,parameters:plan.parameters}})).data;
   }else{
    const result=await this.submit({...body,projectId,canvasId:projectId,targetType:'NODE',targetId:node.id,canvas:working},false);task=(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(result.taskId))).data;
   }
   check();if(node.type==='rh-ai')this.claim(task,manager,projectId,order);tasks.push(task);await this.apply(task);check();
   if(graph.edges.some((edge:any)=>edge.source===node.id&&ids.has(edge.target))){
    const completedTask=terminal.has(String(task.state).toUpperCase())?task:await this.awaitTask(task.id,true),completed=await this.task(completedTask);check();
    if(completed.status!=='SUCCESS')throw new ApiError(422,'EXECUTION_FAILED','上游生成未成功完成。');
    const outputs=completed.plans.find((plan:any)=>plan.nodeId===node.id)?.outputs||[];
    // The persisted upstream task retains its form/configuration. This downstream snapshot carries only its real results.
    node.data={title:node.data.title,label:node.data.label,status:'finished',testMode:completed.testMode,output:outputs,assetIds:outputs.filter((output:any)=>output.assetId).map((output:any)=>output.assetId),...(outputs[0]?.text!==undefined?{text:outputs[0].text,content:outputs[0].text}:{}),...(outputs[0]?.data!==undefined?{structuredOutput:outputs[0].data}:{})};
    await this.apply(completedTask);
   }else if(!terminal.has(String(task.state).toUpperCase())&&this.projectId===projectId)this.watch(task.id);
  }
  if(!tasks.length)throw new ApiError(422,'GRAPH_REQUIRED','没有可执行的应用节点。');
  return{taskId:tasks[0].id,...(tasks.length>1?{taskIds:tasks.map(task=>task.id)}:{}),testMode:tasks.every(task=>task.testMode===true)};
 }
 async generateEntityPlans(projectId:string,nodes:any[],model:any){
  this.storage.requirePermission(projectId,'canRun');
  const epoch=this.epoch,manager=this.manager;
  if(!manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新选择实体。');
  const beforeInputs=new Map<string,any>((manager.getRemoteData()?.nodes??[]).map((node:any)=>[node.id,structuredClone(node.data??{})]));
  if(!nodes.length||model?.available===false)throw new ApiError(422,'ENTITY_SELECTION_REQUIRED','请选择实体和可用模型。');
  if(!this.capabilities.size)await this.catalog();this.check(epoch);
  if(this.manager!==manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新选择实体。');
  const requested=this.capabilities.get(model.capabilityRef??model.modelCode);
  if(!requested?.available)throw new ApiError(501,'CAPABILITY_UNAVAILABLE','请选择当前目录中的可用模型。');
  const planned:any[]=[];
  for(const node of nodes){try{
   if(!manager.getRemoteData()?.nodes.some((item:any)=>item.id===node.id&&item.data?.storyboardScriptNodeId===node.data?.storyboardScriptNodeId))throw new ApiError(409,'ENTITY_SELECTION_STALE','实体选择已更新。');
   const kind=this.kind(node),cap=requested.kind===kind?requested:this.preferred([...this.capabilities.values()],kind||'');
   if(!cap)throw new ApiError(501,'CAPABILITY_UNAVAILABLE','此实体输入类型尚未配置模型。');
   const data={...node.data,modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,testMode:!!cap.testMode};data.routerParameters=this.parameters(cap,{...data,routerParameters:undefined});
   planned.push({...node,type:'rh-image',data});
  }catch(error){this.rememberPreflightFailure(error,this.preflightTarget({projectId,targetId:node.id,graph:{nodes:[node],edges:[]}}),{capabilityRef:requested.capabilityRef,capabilityVersion:requested.version,issues:preflightContext(error)?.issues??[{field:'parameters',reason:'PARAMETER_INVALID',sourceNodeId:node.id}]});await this.reportPreflightFailure({projectId,targetId:node.id,graph:{nodes:[node],edges:[]}},error);throw error;}}
  for(const node of planned){try{const graph=await this.freezeGraph({nodes:[node],edges:[]},projectId);await this.prepareGenerationNode(projectId,graph.nodes[0],graph,epoch);this.check(epoch);if(this.manager!==manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次实体生成尚未提交。');}catch(error){this.rememberPreflightFailure(error,this.preflightTarget({projectId,targetId:node.id,graph:{nodes:[node],edges:[]}}));await this.reportPreflightFailure({projectId,targetId:node.id,graph:{nodes:[node],edges:[]}},error);throw error;}}
  const patches=planned.map(node=>({id:node.id,data:Object.fromEntries(Object.entries(node.data).filter(([key])=>!['status','taskId','estimateTaskId','generationStartedAt','errorMsg','errorMessage','output','historyStorage','nodeOutputHistory','selectedOutputHistoryIndex','selectedHistoryOutputId','selectedOutputHistoryId','assetIds','imageUrl','sourceObjects','text','content'].includes(key)))}));
  for(const patch of patches){const current=manager.getRemoteData()?.nodes.find((node:any)=>node.id===patch.id),baseline=beforeInputs.get(patch.id);if(!current||!baseline||Object.keys(patch.data).some(key=>!equalDraftValue(current.data?.[key],baseline[key]))){const error=preflightError('STALE_EXECUTION_INPUT','实体内容刚有新修改，当前编辑已保留，请确认内容后重新生成。',requested,{issues:[{field:'inputs.snapshot',reason:'INPUT_CHANGED',component:'PARAMETERS',sourceNodeId:patch.id}]});error.status=409;this.rememberPreflightFailure(error,{projectId,nodeId:patch.id});await this.reportPreflightFailure({projectId,nodeId:patch.id},error);throw error;}}
  for(const patch of patches)manager.patchNodeData(patch.id,patch.data,{replaceParams:true});manager.flushOperationQueue?.(true);
  const acceptedBefore=new Map(planned.map(node=>[node.id,this.nodeTasks.get(node.id)?.id]));
  try{return await this.run({projectId,targetType:planned.length===1?'NODE':'CANVAS',targetId:planned.length===1?planned[0].id:'',graph:{nodes:planned,edges:[]}});}catch(error){if(epoch===this.epoch&&this.manager===manager&&this.projectId===projectId)for(const node of planned){const accepted=this.nodeTasks.get(node.id)?.id;if(accepted&&accepted!==acceptedBefore.get(node.id))manager.patchNodeData(node.id,{status:'failed',errorMsg:error instanceof Error?error.message:'实体生成失败。'});}throw error;}
 }
 async generate(nodeId:string){
  const manager=this.manager,projectId=this.projectId,epoch=this.epoch,acceptedBefore=this.nodeTasks.get(nodeId)?.id;let identity:any,runStarted=false;
  try{
   if(!manager||!projectId)return false;this.storage.requirePermission(projectId,'canRun');const requireCanvas=this.storage.canvasReadGuard(projectId),initial=manager.getRemoteData()?.nodes.find((node:any)=>node.id===nodeId);if(!initial)return false;
   // A production node keeps its Yjs row identity while its fields change.
   // Stable in-memory manager ports use their existing node object instead.
   identity=this.nodeIdentity(manager,nodeId)??initial;
   const check=()=>{this.check(epoch);if(this.manager!==manager||this.projectId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次生成尚未提交。');requireCanvas();this.storage.requirePermission(projectId,'canRun');const node=manager.getRemoteData()?.nodes.find((node:any)=>node.id===nodeId);if(!node||(this.nodeIdentity(manager,nodeId)??node)!==identity)throw new ApiError(409,'STALE_EXECUTION_INPUT','节点已删除或重建，请重新生成。');};
   check();const pending=this.canvasLeasePort?.flushPending(projectId);if(pending)await pending;check();manager.flushOperationQueue?.(true);check();
   // Unlike an explicit native command, this entry point means "generate the
   // mounted node". Capture it only after its accepted local intents settle.
   const graph=manager.getRemoteData(),node=graph.nodes.find((node:any)=>node.id===nodeId);runStarted=true;await this.run({canvasId:projectId,targetType:/group/.test(node.type)?'GROUP':'NODE',targetId:nodeId,canvas:graph,name:graph.meta?.name});return true;
  }catch(error){if(epoch===this.epoch&&this.manager===manager&&this.projectId===projectId){const node=manager?.getRemoteData()?.nodes.find((node:any)=>node.id===nodeId),accepted=this.nodeTasks.get(nodeId)?.id;if(runStarted&&node&&(this.nodeIdentity(manager,nodeId)??node)===identity&&accepted&&accepted!==acceptedBefore)manager?.patchNodeData(nodeId,{status:'failed',errorMsg:error instanceof Error?error.message:'生成失败。'});this.notice(error instanceof Error?error.message:'生成失败。');}return false;}
 }
 nodeCancellationReason(nodeId:string){
  const node=this.manager?.getRemoteData()?.nodes.find((row:any)=>row.id===nodeId),taskId=this.nodeTasks.get(nodeId)?.id||node?.data?.taskId;
  if(taskId&&this.nonCancelableVideoTasks.has(taskId))return videoCancelUnsupportedMessage;
  if(node?.type!=='rh-video')return;
  const cap=this.capabilities.get(node.data?.capabilityRef??node.data?.modelCode);
  if(cap&&(!node.data?.capabilityVersion||cap.version===node.data.capabilityVersion))return videoCancellationReason(cap);
 }
 async cancelNode(nodeId:string){this.storage.requirePermission(this.projectId??'','canRun');const node=this.manager?.getRemoteData()?.nodes.find((n:any)=>n.id===nodeId),taskId=node&&(this.nodeTasks.get(nodeId)?.id||node.data?.taskId);if(!taskId)throw new ApiError(409,'TASK_NOT_FOUND','节点没有正在执行的任务。');return this.cancel(taskId);}
 async cancel(id:string){
  if(this.projectId)this.storage.requirePermission(this.projectId,'canRun');
  const nodes=this.manager?.getRemoteData()?.nodes?.filter((node:any)=>(this.nodeTasks.get(node.id)?.id||node.data?.taskId)===id)??[];
  if(nodes.some((node:any)=>node.type==='rh-video'&&!this.capabilities.has(node.data?.capabilityRef??node.data?.modelCode)))await this.catalog();
  if(this.nonCancelableVideoTasks.has(id)||nodes.some((node:any)=>this.nodeCancellationReason(node.id)))throw new ApiError(501,'VIDEO_CANCEL_UNSUPPORTED',videoCancelUnsupportedMessage);
  const task=(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{},idempotencyKey:randomUuid()})).data;await this.apply(task);return task;
 }
 private watch(id:string){if(!id||this.polls.has(id))return;const controller=new AbortController(),epoch=this.epoch,manager=this.manager,projectId=this.projectId;this.polls.set(id,controller);void(async()=>{try{for(;;){if(controller.signal.aborted)break;const task=(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(id),{signal:controller.signal})).data;this.check(epoch);if(controller.signal.aborted||this.manager!==manager||this.projectId!==projectId)break;await this.apply(task);if(controller.signal.aborted||terminal.has(String(task.state||'').toUpperCase()))break;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',abort);resolve();},1000);const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};controller.signal.addEventListener('abort',abort,{once:true});});}}catch(error){if(!controller.signal.aborted&&epoch===this.epoch)this.notice(error instanceof Error?error.message:'任务状态查询失败。');}finally{if(this.polls.get(id)===controller)this.polls.delete(id);}})();}
 private async history(body:any,node=false){const epoch=this.epoch,path='/history?'+qs(body,{canvasId:'projectId',projectId:'projectId',nodeId:'nodeId',type:'type',page:'page',pageNum:'page',size:'size',pageSize:'size'}),page=(await this.api.requestV2<any>(path)).data;
  const records=page.records||page.items||page.batches;if(!Array.isArray(records))throw new ApiError(502,'INVALID_RESPONSE','历史响应格式错误。');
  const batches=await Promise.all(records.map(async(row:any)=>({...row,batchId:row.batchId||row.id,taskId:row.taskId||row.runId,createdAt:row.createdAt,outputs:await Promise.all((row.outputs||[]).map((x:StudioOutput)=>this.output(x,!!row.testMode)))})));
  this.check(epoch);
  if(node){const resultCount=page.resultCount??await this.historyResultCount(body,page);this.check(epoch);return{batches,revision:String(page.revision),resultCount,pageNum:page.page??page.current??body.pageNum,hasNext:page.hasNext??page.hasMore};}
  const rows=batches.flatMap(row=>row.outputs.map((output:any)=>{if(output.outputId)this.historyOutputs.set(output.outputId,{historyId:row.executionId||row.id,outputId:output.outputId});return{...row,...output,id:output.outputId||row.id,taskPlanId:row.executionId||row.id,resultUrl:output.url,resultType:output.outputType,createTime:Date.parse(row.createdAt)};}));
  return{...page,records:rows,current:page.page??page.current,size:page.size??page.pageSize,total:page.total,pages:page.pages??Math.ceil(page.total/(page.size||page.pageSize||20)),hasNext:page.hasNext??page.hasMore};
 }
 private async historyResultCount(body:any,current:any){
  if((current.page??current.current??body.pageNum??body.page??1)===1&&!current.hasNext&&!current.hasMore)return(current.records||current.items||current.batches).reduce((sum:number,row:any)=>sum+(row.outputs||[]).length,0);
  let total=0;for(let page=1;page<=100000;page++){const path='/history?'+qs({...body,page,pageNum:page,size:100,pageSize:100},{canvasId:'projectId',projectId:'projectId',nodeId:'nodeId',type:'type',page:'page',pageNum:'page',size:'size',pageSize:'size'}),result=(await this.api.requestV2<any>(path)).data,records=result.records||result.items||result.batches;if(!Array.isArray(records))throw new ApiError(502,'INVALID_RESPONSE','历史统计响应格式错误。');total+=records.reduce((sum:number,row:any)=>sum+(row.outputs||[]).length,0);if(!result.hasNext&&!result.hasMore)return total;if(!records.length)throw new ApiError(502,'INVALID_RESPONSE','历史分页响应格式错误。');}throw new ApiError(502,'INVALID_RESPONSE','历史分页超出范围。');
 }
 async isolated(kind:string,prompt:string,references:string[]=[],projectId=this.projectId,parameters:any={},selection?:PromptSelection,choice?:ModelChoice|((kind:string)=>ModelChoice|undefined)){
  const epoch=this.epoch,nodeId='studio-tool-'+randomUuid();let inputs:string[]=[],cap:Capability|undefined,selected:ModelChoice|undefined;
  try{
   if(!projectId)throw new ApiError(422,'PROJECT_REQUIRED','请先打开作品。');
   this.storage.requirePermission(projectId,'canRun');
   const catalog=await this.catalog(),assets=await Promise.all(references.map(ref=>this.storage.resolveAsset(ref)));this.check(epoch);
   inputs=assets.map(asset=>asset.kind);selected=typeof choice==='function'?choice(textKind(kind,inputs)):choice??selectedModel({},'tools',textKind(kind,inputs));
   if(selection?.featureCode==='image.style-extract'&&(assets.length!==1||assets[0].kind!=='IMAGE')){
    const candidate=catalog.find(value=>value.capabilityRef===selected?.capabilityRef);
    throw preflightError('MODEL_INPUT_UNSUPPORTED',`风格提取需要一张已上传的图片，当前有 ${assets.length} 个参考素材，请移除多余素材或替换为图片。`,candidate,{requestedKind:kind,inputKinds:preflightInputKinds(inputs),...(selected?{capabilityRef:selected.capabilityRef,capabilityVersion:selected.capabilityVersion??candidate?.version}:{}),issues:[{field:'references.count',reason:'COUNT_REQUIRED',inputKind:'IMAGE',actual:assets.filter(asset=>asset.kind==='IMAGE').length,expected:1},...assets.flatMap((asset,index)=>asset.kind==='IMAGE'?[]:[{field:'references.kind' as const,reason:'KIND_UNSUPPORTED' as const,inputKind:preflightInputKinds([asset.kind])[0],inputIndex:index,assetId:asset.id,expectedKinds:['IMAGE' as const]}])]});
   }
   cap=await resolveCapability(path=>this.readCapabilityVersion(path),catalog,kind,inputs,selected,this.modelPolicy);this.check(epoch);
   validateInputMedia(cap,assets);
   const media:Record<string,string[]>={};for(const asset of assets){const key=({IMAGE:'imageUrls',VIDEO:'videoUrls',AUDIO:'audioUrls'} as Record<string,string>)[asset.kind];if(!key)throw new ApiError(501,'MESSAGE_PART_UNSUPPORTED','此素材类型尚未接入模型输入。');(media[key]??=[]).push('rhtv-asset:'+asset.id);}
   const promptSelection=selection?{...selection,
    ...(selection.referenceBindings?{referenceBindings:await Promise.all(selection.referenceBindings.map(async binding=>({...binding,assetId:(await this.storage.resolveAsset(binding.assetId)).id})))}:{}),
    ...(selection.messages?{messages:await Promise.all(selection.messages.map(async message=>({...message,...(message.assetIds?{assetIds:await Promise.all(message.assetIds.map(async ref=>(await this.storage.resolveAsset(ref)).id))}:{})})))}:{})}:undefined;
   this.check(epoch);const type=kind==='LLM'?'rh-text':kind.includes('VIDEO')?'rh-video':kind.includes('AUDIO')?'rh-audio':'rh-image';
   const node={id:nodeId,type,position:{x:0,y:0},data:{modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,subType:kind,params:{prompt,...media},...(promptSelection?{promptSelection}:{}),routerParameters:routerParameters(cap,{params:parameters,routerParameters:parameters}),generateNum:1}};
   return await this.submit({projectId,targetType:'NODE',targetId:nodeId,graph:{nodes:[node],edges:[]}},false);
  }catch(error){
   this.rememberPreflightFailure(error,{projectId:projectId??'',nodeId},{schemaVersion:'1',requestedKind:kind,inputKinds:preflightInputKinds(inputs),...(cap?{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version}:selected?{capabilityRef:selected.capabilityRef,capabilityVersion:selected.capabilityVersion}:{})});
   if(epoch===this.epoch)await this.reportPreflightFailure({projectId,nodeId},error);throw error;
  }
 }
 async awaitTask(id:string,raw=false){const epoch=this.epoch;for(;;){this.check(epoch);const task=(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(id))).data;this.check(epoch);if(terminal.has(String(task.state).toUpperCase())){if(nativeState(task.state)!=='SUCCESS')throw new ApiError(422,task.errorCode||'EXECUTION_FAILED',task.errorMessage||'生成未成功完成。');return raw?task:this.task(task);}await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.waits.delete(timer);resolve();},400);this.waits.set(timer,()=>reject(new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。')));});}}
 private async specialStatus(id:string){const task=(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(id))).data,view=await this.task(task);const outputs=view.plans.flatMap((p:any)=>p.outputs);return{taskId:task.id,status:view.status,imageUrl:outputs.find((o:any)=>o.url)?.url,results:outputs,errorMessage:view.errorMessage,testMode:view.testMode};}
 async handle(path:string,b:any,method='POST'):Promise<any|undefined>{
  if(path==='/canvas/cos/fileSizes'){
   if(!Array.isArray(b.urls)||b.urls.length>100)throw new ApiError(422,'INVALID_ASSET_REFERENCES','请选择最多 100 个 STUDIO 素材。');
   const files=await Promise.all(b.urls.map(async(url:string)=>{const asset=await this.storage.resolveAsset(String(url));if(!Number.isSafeInteger(asset.byteSize)||asset.byteSize<0)throw new ApiError(502,'INVALID_RESPONSE','素材缺少有效的文件大小。');return{url,size:asset.byteSize,assetId:asset.id};}));return{files,totalSize:files.reduce((sum,file)=>sum+file.size,0)};
  }
  if(path==='/canvas/prompt/enhance'){
   const prompt=String(b.prompt||''),context={scene:b.scene,nodeCategory:b.nodeCategory,refImageCount:b.refImageCount,videoParams:b.videoParams,modelCode:b.modelCode};
   // Native modelCode describes the generation target, not the optimizer LLM.
   const run=await this.isolated('LLM',prompt,[],b.canvasId||this.projectId,{}, {schemaVersion:'1',featureCode:'prompt.enhance',conditions:context},selectedModel({capabilityRef:b.capabilityRef,capabilityVersion:b.capabilityVersion},'tools'));
   const task=await this.awaitTask(run.taskId),enhancedPrompt=task.plans.flatMap((plan:any)=>plan.outputs).filter((output:any)=>typeof output.text==='string').map((output:any)=>output.text).join('\n');
   if(!enhancedPrompt)throw new ApiError(502,'INVALID_OUTPUT','模型没有返回优化后的提示词。');
   return{enhancedPrompt,testMode:task.testMode,taskId:run.taskId};
  }
  if(path==='/canvas/sketchboard/realtime/generate'){
   const projectId=String(b.canvasId||this.projectId||''),mode=b.generationMode||'live',token=this.sketchProgress.start(projectId,mode);
   try{
    this.sketchProgress.update(token,{message:'正在准备图片生成…'});
    if(!['live','manual'].includes(mode))throw new ApiError(422,'INVALID_GENERATION_MODE','画板生成模式无效。');
    const style=sketchStyles.find(style=>style.code===(b.styleCode||'anime'));
    if(!style)throw new ApiError(422,'INVALID_SKETCH_STYLE','请选择当前画板中的风格。');
    const cap=sketchModel(await this.catalog(),projectId,mode,this.sketchModels,b,this.modelPolicy),choice={capabilityRef:cap.capabilityRef,capabilityVersion:cap.version};
    if(cap.kind==='TEXT_TO_IMAGE'){
     const prompt=String(b.prompt||'').trim();
     if(!prompt)throw new ApiError(422,'SKETCH_PROMPT_REQUIRED','文字创作需要填写画面描述；若要根据画笔生成，请选择参考草图模型。');
     this.sketchProgress.update(token,{message:'正在提交文字创作…'});
     // Text-only profiles cannot consume the drawing. Keep its PNG out of
     // uploads and the task graph; use the ordinary text-to-image template.
     const run=await this.isolated('TEXT_TO_IMAGE',prompt,[],projectId,{}, {schemaVersion:'1',conditions:{stylePrompt:style.prompt,generationMode:mode}},choice);
     this.sketchProgress.update(token,{phase:'running',taskId:run.taskId,message:undefined});return run;
    }
    this.sketchProgress.update(token,{message:'正在上传草图并提交生成…'});
    if(typeof b.image!=='string'||!b.image.startsWith('data:image/png;base64,')||b.image.length>23*1024*1024)throw new ApiError(422,'INVALID_IMAGE','画板需要不超过 16 MB 的 PNG 图像。');
    let bytes:Uint8Array<ArrayBuffer>;try{bytes=Uint8Array.from(atob(b.image.slice(b.image.indexOf(',')+1)),char=>char.charCodeAt(0));}catch{throw new ApiError(422,'INVALID_IMAGE','画板图像数据无效。');}
    if(bytes.length>16*1024*1024)throw new ApiError(422,'INVALID_IMAGE','画板图像超过大小限制。');
    const url=await this.storage.upload(new File([bytes],'sketch.png',{type:'image/png'}),projectId);
    const run=await this.isolated('IMAGE_TO_IMAGE',String(b.prompt||'').trim()||'根据草图生成完整画面，保留主体、轮廓和空间布局。',[url],projectId,{}, {schemaVersion:'1',featureCode:'sketchboard.generate',conditions:{styleCode:style.code,stylePrompt:style.prompt,generationMode:mode},referenceBindings:[{assetId:url,role:'SKETCH'}]},choice);
    this.sketchProgress.update(token,{phase:'running',taskId:run.taskId,message:undefined});return run;
   }catch(error){await this.reportPreflightFailure({projectId,targetId:'studio-sketchboard'},error);this.sketchProgress.update(token,{phase:'failed'});throw error;}
  }
  if(path==='/canvas/sketchboard/realtime/status'){
   const id=String(b.taskId),epoch=this.epoch,token=this.sketchProgress.value?.taskId===id?this.sketchProgress.value.token:undefined;
   try{
    // The frozen view allows 130 polls. Bounded long polling accommodates the
    // configured async editor (~15 min total), without changing other tools.
    let status=await this.specialStatus(id);
    for(let i=0;i<3&&status.status==='RUNNING';i++){
     await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.waits.delete(timer);resolve();},2000);this.waits.set(timer,()=>reject(new ApiError(401,'SESSION_CHANGED','登录状态已变更。')));});
     this.check(epoch);status=await this.specialStatus(id);
    }
    this.check(epoch);
    if(status.status==='CANCELLED')status={...status,status:'FAILED',errorMessage:'画板生成已取消。'};
    if(token!==undefined)this.sketchProgress.update(token,{phase:status.status==='RUNNING'?'running':status.status==='SUCCESS'?'done':'failed'});
    return status;
   }catch(error){if(token!==undefined)this.sketchProgress.update(token,{phase:'failed'});throw error;}
  }
  if(path==='/openapi/v2/query')return this.specialStatus(String(b.taskId));
  if(path==='/openapi/v2/rhart-image/qwen-vl/prompt-matte')return this.isolated('IMAGE_CUTOUT',String(b.prompt||''),[String(b.imageUrl)],this.projectId,{}, {schemaVersion:'1',featureCode:'image.cutout',referenceBindings:[{assetId:String(b.imageUrl),role:'REFERENCE_IMAGE'}]});
  if(path==='/canvas/invoke/api/llm'||path==='/canvas/agent/skill/file/content/optimize'){
   const original=b.params?.messages||[];if(!Array.isArray(original))throw new ApiError(422,'INVALID_MESSAGES','对话消息格式错误。');
   const requested=b.modelCode||b.params?.modelCode||b.model||b.params?.model,nativeStyle=path==='/canvas/invoke/api/llm'&&requested==='canvas_prompt_user_style_extract';
   if(nativeStyle){
    const message=original[0],parts=message?.content;
    if(original.length!==1||message?.role!=='user'||!Array.isArray(parts)||parts.length!==2||parts[0]?.type!=='text'||parts[0].text!=='user_style_extract_prompt'||parts[1]?.type!=='image_url'||typeof parts[1].image_url?.url!=='string'||!parts[1].image_url.url.trim()||b.message)throw new ApiError(422,'MODEL_SELECTION_INVALID','风格提取入口需要原有的单张图片请求。');
   }
   const messages:NonNullable<PromptSelection['messages']>=original.map((message:any)=>{
    const role=String(message.role||'user').toUpperCase();if(!['USER','ASSISTANT','SYSTEM','DEVELOPER'].includes(role))throw new ApiError(422,'INVALID_MESSAGES','不支持的对话消息角色。');
    const content=message.content;if(typeof content!=='string'&&!Array.isArray(content))throw new ApiError(422,'INVALID_MESSAGES','对话内容格式错误。');
    const texts:string[]=[],assetIds:string[]=[];if(typeof content==='string')texts.push(content);else for(const part of content){
     if(!part||typeof part!=='object')throw new ApiError(422,'INVALID_MESSAGES','对话内容格式错误。');
     if(['text','input_text'].includes(part.type)){if(typeof part.text!=='string')throw new ApiError(422,'INVALID_MESSAGES','对话文字格式错误。');texts.push(part.text);continue;}
     const keys:Record<string,string>={image_url:'image_url',video_url:'video_url',audio_url:'audio_url',file_url:'file_url',input_image:'image_url',input_video:'video_url'};
     const key=keys[part.type];if(!key)throw new ApiError(501,'MESSAGE_PART_UNSUPPORTED','此对话输入类型尚未接入，请使用已上传的 STUDIO 素材。');
     const ref=typeof part[key]==='string'?part[key]:part[key]?.url;if(typeof ref!=='string'||!ref)throw new ApiError(422,'ASSET_REFERENCE_REQUIRED','对话媒体必须使用已上传的 STUDIO 素材。');assetIds.push(ref);
    }const text=texts.join('\n');
    // Native browser instructions are untrusted user content; only STUDIO templates set privileged roles.
    return{role:role==='ASSISTANT'?'ASSISTANT':'USER',...(text?{text}:{}),...(assetIds.length?{assetIds}:{})};
   });if(b.message)messages.push({role:'USER',text:String(b.message)});
   const refs=[...new Set(messages.flatMap(message=>message.assetIds||[]))],text=messages.filter(message=>message.role==='USER').at(-1)?.text||'';
   const parameters={...(b.routerParameters||{}),...(Object.hasOwn(b.params||{},'reasoning_effort')?{reasoning_effort:b.params.reasoning_effort}:{})};
   const run=await this.isolated('LLM',text,refs,b.canvasId||this.projectId,parameters, {schemaVersion:'1',featureCode:nativeStyle?'image.style-extract':path.includes('invoke')?'llm.invoke':'skill.optimize',messages,conditions:{requestedModelCode:requested}},(kind)=>selectedModel(nativeStyle?{capabilityRef:b.capabilityRef,capabilityVersion:b.capabilityVersion}:b,'tools',kind)),task=await this.awaitTask(run.taskId),outputs=task.plans.flatMap((plan:any)=>plan.outputs);
   if(nativeStyle&&(outputs.length!==1||outputs[0].outputType!=='text'||typeof outputs[0].text!=='string'||!outputs[0].text.trim()))throw new ApiError(502,'INVALID_OUTPUT','模型没有返回风格提取要求的单个描述词。');
   if(nativeStyle&&outputs[0].text.length>500)throw new ApiError(502,'INVALID_OUTPUT','风格描述超过500字符，请重新提取或缩短后保存。');
   if(!path.includes('invoke')&&outputs.length!==1)throw new ApiError(502,'INVALID_OUTPUT','模型没有返回技能优化要求的单个 JSON。');
   const result=outputs.map((output:any)=>{
    if(path.includes('invoke'))return typeof output.text==='string'?output.text:output.data!==undefined?JSON.stringify(output.data):'';
    if(output.outputType==='structured'&&output.schemaVersion!=='1')throw new ApiError(502,'INVALID_OUTPUT','模型返回的技能优化结构版本不受支持。');
    let data=output.data;if(data===undefined&&typeof output.text==='string'){try{data=JSON.parse(output.text.replace(/^\[TEST MODE\] /,''));}catch{throw new ApiError(502,'INVALID_OUTPUT','模型没有返回技能优化要求的 JSON。');}}
    if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.optimized_content!=='string'||!data.optimized_content.trim())throw new ApiError(502,'INVALID_OUTPUT','模型没有返回优化后的技能内容。');return JSON.stringify(data);
   }).filter(Boolean).join('\n');
   if(!result)throw new ApiError(502,'INVALID_OUTPUT','模型没有返回文字结果。');return path.includes('invoke')?{choices:[{message:{role:'assistant',content:result}}],testMode:task.testMode}:{output:result,testMode:task.testMode};
  }
  if(path==='/canvas/model/list'){
   const caps=await this.catalog(),types:string[]=[...(b.types||Object.keys(nativeKinds))];
   // The pinned native main-canvas kW list omits image quality tools. Its Lgt
   // mapper accepts additional returned rows, so publish these real tool kinds
   // into the same toolbarContext.models used by both actions and their guard.
   if(types.includes('TEXT_IMAGE')&&types.includes('IMAGE_IMAGE'))for(const type of ['IMAGE_GIGAPIXEL','IMAGE_HD'])if(!types.includes(type)&&this.modelsForType(caps,type).some(model=>model.available===true&&model.testMode===false))types.push(type);
   return types.map(type=>({type,modelList:this.modelsForType(caps,type)}));
  }
  if(path==='/canvas/model/group/list'){
   const caps=await this.catalog();return[...new Set(caps.map(c=>c.kind==='IMAGE_UNDERSTANDING'?'LLM':c.kind))].flatMap(kind=>{
    const groups=new Map<string,any>();
    for(const [nodeType,value]of Object.entries(nativeKinds))if(value===kind)for(const model of this.modelsForType(caps,nodeType)){
     let group=groups.get(model.modelCode);if(!group){group={modelGroupId:kind+':'+model.modelCode,modelGroupName:model.modelName,modelGroupNameEn:model.modelNameEn,nodeTypeList:[],nodeModelList:[]};groups.set(model.modelCode,group);}
     group.nodeTypeList.push(nodeType);group.nodeModelList.push({nodeType,modelList:[model]});
    }
    if(!groups.size)return[];
    // Native video filtering checks nodeTypeList at every cascade depth.
    const modelGroupList=[...groups.values()],nodeTypeList=[...new Set(modelGroupList.flatMap(group=>group.nodeTypeList))];
    return[{modelGroupId:kind,modelGroupName:modelKindLabel(kind),modelGroupNameEn:modelKindLabel(kind,true),nodeTypeList,modelGroupList}];
   });
  }
  if(path==='/canvas/task/run')return this.dispatchCanvasRun(b,true);
  if(path==='/canvas/task/batchStatus'){const result=(await this.api.requestV2<any>('/tasks/batch-status',{method:'POST',body:{ids:b.taskIds,includeResults:!!b.includeResults}})).data;return{tasks:await Promise.all(result.tasks.map((task:any)=>this.task(task)))};}
  if(path==='/canvas/task/cancel')return this.cancel(String(b.taskId));
  if(path==='/canvas/node-history/page')return this.history(b,true);
  if(path==='/canvas/his/list'||path==='/canvas/sketchboard/his/list'||path==='/api/output/v2/history')return this.historyReader.list(path==='/canvas/sketchboard/his/list'?{...b,type:'IMAGE'}:b,path==='/api/output/v2/history');
  if(path==='/canvas/his/generate/param/detail'){const row=(await this.api.requestV2<any>('/history/'+encodeURIComponent(b.taskPlanId))).data,task=row.snapshot?null:(await this.api.requestV2<any>('/tasks/'+encodeURIComponent(row.taskId))).data;const snapshot=row.snapshot||task?.snapshot?.graph||task?.snapshot;if(!Array.isArray(snapshot?.nodes)||!Array.isArray(snapshot?.edges))throw new ApiError(502,'INVALID_RESPONSE','历史任务未保存可复用的画布。');return{...row,snapshot,nodeId:row.nodeId};}
  if(path==='/canvas/his/deleteBatch'){
   const epoch=this.epoch,ids=[...new Set<string>((b.ids||[]).map(String))],known=ids.map(id=>this.historyOutputs.get(id));
   if(known.some(Boolean)){if(known.some(item=>!item))throw new ApiError(422,'HISTORY_SELECTION_STALE','请选择当前已加载的历史结果。');const successList:string[]=[],failList:any[]=[];for(let index=0;index<ids.length;index++){const item=known[index]!;try{const row=(await this.api.requestV2<any>('/history/'+encodeURIComponent(item.historyId))).data;await this.api.requestV2('/history/'+encodeURIComponent(item.historyId)+'/outputs/'+encodeURIComponent(item.outputId),{method:'DELETE',etag:'"'+row.revision+'"'});this.check(epoch);this.historyOutputs.delete(ids[index]);successList.push(ids[index]);}catch(error){this.check(epoch);if(!(error instanceof ApiError)||[401,403].includes(error.status))throw error;failList.push({id:ids[index],code:error.code,message:error.message});}}return{successList,failList};}
   const result=(await this.api.requestV2<any>('/history/delete',{method:'POST',body:{ids},idempotencyKey:randomUuid()})).data;return{successList:result.deletedIds,failList:[]};
  }
  if(path==='/canvas/node-history/delete-output'){if(!b.historyId)throw new ApiError(422,'HISTORY_ID_REQUIRED','需要真实的历史批次标识。');const before=await this.history({...b,pageNum:1,pageSize:1},true);if(String(before.revision)!==String(b.expectedRevision))throw new ApiError(412,'VERSION_CONFLICT','节点历史已更新，请重新加载。');const row=(await this.api.requestV2<any>('/history/'+encodeURIComponent(b.historyId))).data;await this.api.requestV2('/history/'+encodeURIComponent(b.historyId)+'/outputs/'+encodeURIComponent(b.outputId),{method:'DELETE',etag:'"'+row.revision+'"'});const page=await this.history({...b,pageNum:1,pageSize:1},true);const batch=page.batches[0];return{revision:page.revision,resultCount:page.resultCount,...(batch?.outputs[0]?{fallback:{batch,outputId:batch.outputs[0].outputId}}:{})};}
  if(path==='/canvas/media/task/run'||path==='/media/jobs/submit')return this.submitMedia(path,b);
  if(/^\/media\/jobs\/[^/]+$/.test(path))return this.mediaResult((await this.api.requestV2<any>('/media-jobs/'+encodeURIComponent(path.split('/').pop()!))).data,true);
  if(path==='/canvas/media/task/cancel'){const projectId=b.projectId||b.canvasId||this.projectId;if(projectId)this.storage.requirePermission(String(projectId),'canRun');return this.mediaResult((await this.api.requestV2<any>('/media-jobs/'+encodeURIComponent(b.taskId)+'/cancel',{method:'POST',body:{}})).data);}
  return undefined;
 }
 private async submitMedia(path:string,b:any,guard?:()=>void){
   const projectId=String(b.projectId||b.bizId||b.canvasId||this.projectId||''),nodeId=String(b.nodeId||'studio-media'),epoch=this.epoch,manager=this.projectId===projectId?this.manager:null;
   const check=()=>{this.check(epoch);if(manager&&(this.manager!==manager||this.projectId!==projectId))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次媒体处理尚未继续提交。');};
   const evidence=this.captureFailureSnapshot(projectId,{targetId:nodeId,targetType:'NODE',control:'MEDIA'},b.graph);
   let accepted=false;
   try{
    this.storage.requirePermission(projectId,'canRun');check();
    if(b.dryRun===true||b.priority&&b.priority!=='normal')throw new ApiError(501,'MEDIA_SCHEDULING_UNAVAILABLE','此媒体预检或优先级协议尚未接入。');
    const frozen=await this.freezeMedia(b.spec),spec=frozen.spec,operation=b.operation||b.operateType||(spec?.tracks?.[0]?.type==='compress'?'COMPRESS':path==='/media/jobs/submit'&&spec?.tracks?.some((track:any)=>track.type==='video')?'COMPOSE':undefined);
    check();validateMediaJob(spec,operation,frozen.assets,{executor:b.executor,bizType:b.bizType});
    const command:any={projectId,spec,...(operation?{operation}:{}),...(b.nodeId?{nodeId:b.nodeId}:{}),...(b.bizType?{bizType:b.bizType}:{}),...(b.executor?{executor:b.executor}:{})};this.storage.requirePermission(projectId,'canRun');
    const order=++this.submissionSequence;
    if(path==='/canvas/media/task/run'&&b.nodeId&&manager&&this.projectId===projectId){
     if(evidence)evidence.phase='SYNC';
     manager.flushOperationQueue?.(true);await this.saved();check();
     const current=()=>cleanJson(manager.getRemoteData(),this.storage.encodeAsset),initial=current();
     const checkSnapshot=()=>{check();if(!equalDraftValue(current(),initial))throw new ApiError(409,'STALE_EXECUTION_INPUT','画布已更改，请重新执行视频处理。');};
     const receipt=await this.storage.saveForExecution(projectId,initial,current,checkSnapshot);checkSnapshot();command.expectedRevision=receipt.revision;command.graph=receipt.graph;
    }
    check();guard?.();if(evidence)evidence.phase='SUBMIT';
    const data=(await this.api.requestV2<any>('/media-jobs',{method:'POST',body:command,idempotencyKey:randomUuid()})).data;accepted=true;check();
    if(command.expectedRevision!==undefined){if(!data.task||!this.serverManaged(data.task))throw new ApiError(502,'INVALID_CANVAS_EXECUTION','媒体任务缺少画布回写凭据。');this.claim(data.task,manager,projectId,order,command.expectedRevision);await this.apply(data.task);this.watch(data.task.id);}
    const result=await this.mediaResult(data,path==='/media/jobs/submit');check();return result;
   }catch(error){
    if(accepted&&error instanceof Error)this.acceptedResponseErrors.add(error);
    const target={projectId,nodeId};this.rememberPreflightFailure(error,target,{schemaVersion:'1',capabilityRef:'local-ffmpeg',capabilityVersion:'1',requestedKind:'MEDIA'});
    if(epoch===this.epoch)await this.reportPreflightFailure(target,error,true,evidence);
    throw error;
   }
  }
 private async mediaResult(data:any,generic=false){if(!data?.taskId||!Array.isArray(data.outputs))throw new ApiError(502,'INVALID_RESPONSE','媒体任务响应格式错误。');const epoch=this.epoch;const outputs=await Promise.all(data.outputs.map(async(output:any)=>{if(!output.assetId)throw new ApiError(502,'INVALID_OUTPUT','媒体结果缺少 STUDIO 素材标识。');const asset=await this.storage.resolveAsset(String(output.assetId));return{...output,url:asset.downloadUrl||asset.previewUrl};}));this.check(epoch);return{...data,...(generic&&/^(?:SUCCESS|SUCCEEDED)$/.test(data.status)?{status:'DONE'}:{}),outputs};}
 private async freezeMedia(spec:any){
  let value:any;try{value=cleanJson(spec,this.storage.encodeAsset);}catch{throw preflightError('MEDIA_INPUT_INVALID','媒体配置含无效或尚未上传的素材，请等待上传完成或重新选择。',undefined,{issues:[{field:'references.upload',reason:'UPLOAD_PENDING'}]});}const assets=new Map<string,Awaited<ReturnType<ServiceStorage['resolveAsset']>>>();
  if(!Array.isArray(value?.inputs)||value.inputs.length<1||value.inputs.length>16)throw preflightError('MEDIA_INPUT_INVALID','媒体处理需要1～16项已上传素材，请补齐或减少素材。',undefined,{issues:[{field:'references.count',reason:'COUNT_REQUIRED',minimum:1,maximum:16}]});
  for(const [index,input]of value.inputs.entries()){
   if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.id!=='string')throw preflightError('MEDIA_INPUT_INVALID',`第${index+1}项媒体输入无效，请重新添加素材。`,undefined,{issues:[{field:'references.kind',reason:'METADATA_MISSING',inputIndex:index}]});
   try{const asset=await this.storage.resolveAsset(input.assetId||input.url);assets.set(input.id,asset);input.assetId=asset.id;delete input.url;}catch(error){if(error instanceof ApiError){error.message=`第${index+1}项媒体素材无法使用：`+error.message;withPreflightContext(error,{issues:[{field:'references.upload',reason:'UPLOAD_FAILED',inputIndex:index}]});}throw error;}
  }
  for(const track of Array.isArray(value.tracks)?value.tracks:[])for(const clip of Array.isArray(track?.clips)?track.clips:[])if(clip&&typeof clip.rotate==='number')clip.rotate=String(clip.rotate);
  return{spec:value,assets};
 }
}
