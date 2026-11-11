import {ApiError} from '../api/client';
import type {Capability} from './model-catalog';

export const preflightKinds=['TEXT','STRUCTURED','IMAGE','VIDEO','AUDIO','UNKNOWN'] as const;
export type PreflightKind=typeof preflightKinds[number];
export const preflightFields=['model.kind','output.kind','inputs.kind','inputs.command','inputs.snapshot','references.kind','references.count','references.total','references.visual','references.any','references.upload','media.byteSize','media.durationMs','media.totalDurationMs','media.width','media.height','media.pixels','parameters'] as const;
export const preflightReasons=['KIND_UNSUPPORTED','KIND_MISMATCH','OUTPUT_UNSUPPORTED','REFERENCE_FORBIDDEN','COUNT_EXCEEDED','COUNT_REQUIRED','REFERENCE_REQUIRED','UPLOAD_PENDING','UPLOAD_FAILED','MAXIMUM_EXCEEDED','MINIMUM_NOT_MET','METADATA_MISSING','PARAMETER_INVALID','MODEL_UNAVAILABLE','MODEL_VERSION_CHANGED','COMMAND_MISMATCH','INPUT_CHANGED'] as const;
export const preflightComponents=['MODEL','PROMPT','REFERENCES','PARAMETERS','PRESETS','HISTORY','OUTPUT','TOPOLOGY','IDENTITY','PERMISSIONS','METADATA'] as const;
export type PreflightComponent=typeof preflightComponents[number];
/** Public schema names only. New names must be reviewed with the matching Go
 * diagnostic allowlist; arbitrary caller object keys never become log data. */
export const preflightParameterNames=['outputPreset','count','transparentBackground','reasoningEffort','reasoning_effort','seed','width','height','aspectRatio','steps','guidanceScale','cfgScale','cfg','strength','denoise','sampler','scheduler','quality','format','background','mode','prompt','text','voice','voiceId','language','speed','pitch','volume','temperature','topP','topK','maxTokens','maxOutputTokens','maxCompletionTokens','minP','presencePenalty','frequencyPenalty','stop','generateAudio','returnLastFrame','subjectMapping','referenceSubjectIndex','sourceSubjectIndex','duration','durationSeconds','fps','resolution','numFrames','batchSize','numImages','guidance','style','enabled'] as const;
export const preflightParameterRules=['required','type','enum','const','minimum','maximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','additionalProperties','forbidden','anyOf','oneOf','not','contains','minProperties','maxProperties','unsupportedSchema','complexity'] as const;
export type PreflightParameterRule=typeof preflightParameterRules[number];
export function validPreflightParameterPath(value:unknown):value is (string|number)[]{return Array.isArray(value)&&value.length<=12&&value.every(part=>typeof part==='string'?preflightParameterNames.includes(part as any):Number.isSafeInteger(part)&&part>=0&&part<=9999);}
export interface PreflightIssue {component?:PreflightComponent;field:typeof preflightFields[number];reason:typeof preflightReasons[number];inputKind?:PreflightKind;inputIndex?:number;assetId?:string;sourceNodeId?:string;actual?:number;expected?:number;minimum?:number;maximum?:number;expectedKinds?:PreflightKind[];parameterPath?:(string|number)[];parameterRule?:PreflightParameterRule}
export const preflightSyncReasons=['MERGE_CONFLICT','BASE_UNKNOWN','CAS_UNCERTAIN'] as const;
export const preflightConflictReasons=['FIELD_CHANGED','DELETE_EDIT','MODEL_PARAMETERS','GROUP_POSITION','DANGLING_REFERENCE','BASE_UNKNOWN'] as const;
export interface PreflightSync {blockedReason:typeof preflightSyncReasons[number];generation?:number;conflicts?:{reason:typeof preflightConflictReasons[number];component:PreflightComponent;sourceNodeId?:string}[]}
export interface PreflightContext {schemaVersion:'1';capabilityRef?:string;capabilityVersion?:string;requestedKind?:string;inputKinds?:PreflightKind[];issues?:PreflightIssue[];sync?:PreflightSync}
type PreflightApiError=ApiError&{preflight?:PreflightContext};
const safeID=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const safeNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
export function preflightKind(value:string):PreflightKind {const kind=String(value).toUpperCase();return preflightKinds.includes(kind as PreflightKind)?kind as PreflightKind:'UNKNOWN';}
export function preflightInputKinds(values:readonly string[]):PreflightKind[]{return [...new Set(values.map(preflightKind))];}
/** Keep only the documented diagnostic symbols and numeric facts. Never attach
 * caller objects, raw parameter values, messages, file names or media URLs. */
function sanitized(context:Partial<PreflightContext>):PreflightContext {
 const result:PreflightContext={schemaVersion:'1'};
 for(const key of ['capabilityRef','capabilityVersion'] as const)if(safeID(context[key])&&(key!=='capabilityVersion'||context[key]!.length<=100))result[key]=context[key];
 if(typeof context.requestedKind==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(context.requestedKind))result.requestedKind=context.requestedKind;
 if(Array.isArray(context.inputKinds))result.inputKinds=preflightInputKinds(context.inputKinds).slice(0,6);
 if(context.sync&&preflightSyncReasons.includes(context.sync.blockedReason)){
  const sync:PreflightSync={blockedReason:context.sync.blockedReason};
  if(Number.isSafeInteger(context.sync.generation)&&safeNumber(context.sync.generation))sync.generation=context.sync.generation;
  if(Array.isArray(context.sync.conflicts))sync.conflicts=context.sync.conflicts.slice(0,16).flatMap(value=>preflightConflictReasons.includes(value?.reason)&&preflightComponents.includes(value?.component)?[{reason:value.reason,component:value.component,...(safeID(value.sourceNodeId)?{sourceNodeId:value.sourceNodeId}:{})}]:[]);
  result.sync=sync;
 }
 if(Array.isArray(context.issues))result.issues=context.issues.slice(0,16).flatMap(value=>{
  if(!value||!preflightFields.includes(value.field)||!preflightReasons.includes(value.reason))return[];
  const issue:PreflightIssue={field:value.field,reason:value.reason};
  if(preflightComponents.includes(value.component!))issue.component=value.component;
  if(preflightKinds.includes(value.inputKind!))issue.inputKind=value.inputKind;
  for(const key of ['assetId','sourceNodeId'] as const)if(safeID(value[key]))issue[key]=value[key];
  if(Number.isSafeInteger(value.inputIndex)&&value.inputIndex!>=0&&value.inputIndex!<=9999)issue.inputIndex=value.inputIndex;
  for(const key of ['actual','expected','minimum','maximum'] as const)if(safeNumber(value[key]))issue[key]=value[key];
  if(Array.isArray(value.expectedKinds))issue.expectedKinds=preflightInputKinds(value.expectedKinds).slice(0,6);
  if(value.field==='parameters'&&value.reason==='PARAMETER_INVALID'){
   if(validPreflightParameterPath(value.parameterPath))issue.parameterPath=[...value.parameterPath];
   if(preflightParameterRules.includes(value.parameterRule!))issue.parameterRule=value.parameterRule;
  }
  return[issue];
 });
 return result;
}
export function preflightContext(error:unknown):PreflightContext|undefined {return error instanceof ApiError&&(error as PreflightApiError).preflight?sanitized((error as PreflightApiError).preflight!):undefined;}
export function withPreflightContext<T>(error:T,patch:Partial<PreflightContext>):T {if(error instanceof ApiError)(error as PreflightApiError).preflight=sanitized({...preflightContext(error),...patch});return error;}
export function modelPreflightLabel(cap:Pick<Capability,'capabilityRef'|'version'|'title'|'model'>){return `${cap.title||cap.model?.title||cap.capabilityRef}（${cap.capabilityRef}，版本 ${cap.version}）`;}
export function preflightError(code:string,message:string,cap?:Pick<Capability,'capabilityRef'|'version'|'title'|'model'>,context:Partial<PreflightContext>={}):ApiError {
 const metadata=sanitized({...(cap?{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version}:{}),...context});
 const label=cap?modelPreflightLabel({...cap,capabilityRef:metadata.capabilityRef??cap.capabilityRef,version:metadata.capabilityVersion??cap.version}):metadata.capabilityRef?`模型 ${metadata.capabilityRef}${metadata.capabilityVersion?`（版本 ${metadata.capabilityVersion}）`:''}`:'';
 const error=new ApiError(code==='MODEL_VERSION_CHANGED'?409:422,code,label?`${label}：${message}`:message);
 return withPreflightContext(error,metadata);
}
