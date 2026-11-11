import {ApiError} from '../api/client';
import {preflightError,preflightInputKinds,preflightKind,type PreflightIssue} from './preflight';

export interface ModelDescriptor {providerRef:string;modelRef:string;title:string;version:string}
export interface Capability {capabilityRef:string;version:string;kind:string;executionKind?:string;title?:string;testMode?:boolean;available:boolean;reason?:string|null;parameterSchemaVersion?:string;parameterSchema?:any;inputKinds?:string[];outputKinds?:string[];supportsCancel?:boolean;model?:ModelDescriptor}
export interface ModelChoice {capabilityRef:string;capabilityVersion?:string;explicit?:boolean}
export interface ModelPolicy {allowTestMode?:boolean}
export type ModelScope='assistant'|'hf'|'tools';
export const modelSelections=new Map<string,ModelChoice>();
export const textKind=(kind:string,inputs:string[])=>kind==='LLM'&&inputs.includes('IMAGE')?'IMAGE_UNDERSTANDING':kind;
export const fitsInputs=(cap:Capability,inputs:string[])=>cap.model?Array.isArray(cap.inputKinds)&&cap.inputKinds.length>0&&inputs.every(kind=>cap.inputKinds!.includes(kind)):!cap.inputKinds||inputs.every(kind=>cap.inputKinds!.includes(kind));
export const fitsOutputs=(cap:Capability,kind=cap.kind)=>!['LLM','IMAGE_UNDERSTANDING'].includes(kind)||(!cap.model&&!cap.outputKinds)||!!cap.outputKinds?.some(output=>['TEXT','STRUCTURED'].includes(output));
export function compareModels(a:Capability,b:Capability){
 const rank=(cap:Capability)=>!cap.available?-1:cap.testMode===true?0:cap.model?2:1;const priority=rank(b)-rank(a);if(priority)return priority;
 if(!a.model||!b.model||a.model.providerRef!==b.model.providerRef)return 0;
 const left=a.model.version.split('.'),right=b.model.version.split('.');if([...left,...right].some(part=>!/^\d+$/.test(part)||!Number.isSafeInteger(Number(part))))return 0;
 for(let i=0;i<Math.max(left.length,right.length);i++){const difference=Number(right[i]||0)-Number(left[i]||0);if(difference)return difference;}return 0;
}
const real=(cap:Capability)=>cap.testMode===false;
export function modelChoice(body:any):ModelChoice|undefined {
 const ref=body?.capabilityRef??body?.modelCode??body?.model_id??body?.modelId??body?.model??body?.params?.capabilityRef??body?.params?.modelCode??body?.params?.model;
 if(ref===undefined||ref===null||ref==='')return undefined;
 if(typeof ref!=='string')throw new ApiError(422,'MODEL_SELECTION_INVALID','请选择目录中的模型。');
 return{capabilityRef:ref,capabilityVersion:body.capabilityVersion??body.params?.capabilityVersion};
}
export function selectedModel(body:any,scope:ModelScope,kind='LLM'):ModelChoice|undefined {
 // A deliberate selector choice overrides the frozen UI's old vendor label;
 // a caller's explicit capabilityRef remains authoritative.
 if(body?.capabilityRef)return modelChoice(body);const choice=modelChoice(body),preference=modelSelections.get(scope+':'+kind);return preference?.explicit||!choice?preference??choice:choice;
}
const allowTests=(caps:Capability[],policy:ModelPolicy={})=>policy.allowTestMode??!caps.some(cap=>cap.testMode===false);
export function menuCapabilities(caps:Capability[],kind:string,inputs:string[]=[],policy:ModelPolicy={},includeUnavailable=false){
 const target=textKind(kind,inputs),candidates=caps.filter(cap=>cap.kind===target&&(cap.available||includeUnavailable&&real(cap)&&!!cap.model&&cap.parameterSchema?.['x-video-parameter-metadata']?.schemaVersion==='1')&&fitsInputs(cap,inputs)&&fitsOutputs(cap,target)),configured=candidates.some(cap=>real(cap)&&cap.model);
 return candidates.filter(cap=>(cap.testMode!==true||allowTests(caps,policy))&&(!configured||real(cap)&&cap.model)).sort(compareModels);
}
export function selectCapability(caps:Capability[],kind:string,inputs:string[]=[],choice?:ModelChoice,policy:ModelPolicy={}){
 const target=textKind(kind,inputs);
 const context={requestedKind:target,inputKinds:preflightInputKinds(inputs)};
 if(choice){
  const cap=caps.find(cap=>cap.capabilityRef===choice.capabilityRef);
  if(!cap||!cap.available)throw preflightError('MODEL_UNAVAILABLE','所选模型未配置或已不可用，请重新选择。',cap,{...context,capabilityRef:choice.capabilityRef,capabilityVersion:choice.capabilityVersion??cap?.version,issues:[{field:'model.kind',reason:'MODEL_UNAVAILABLE'}]});
  if(cap.testMode===true&&!allowTests(caps,policy))throw preflightError('MODEL_UNAVAILABLE','此入口暂无可用的真实模型，请选择已配置模型。',cap,{...context,issues:[{field:'model.kind',reason:'MODEL_UNAVAILABLE'}]});
  if(choice.capabilityVersion&&choice.capabilityVersion!==cap.version)throw preflightError('MODEL_VERSION_CHANGED','所选模型版本已更新，请重新选择。',cap,{...context,capabilityVersion:choice.capabilityVersion,issues:[{field:'model.kind',reason:'MODEL_VERSION_CHANGED'}]});
  // An explicit saved legacy profile may continue its original conversation.
  const legacyImage=target==='IMAGE_UNDERSTANDING'&&cap.kind==='LLM'&&!cap.model;
  if(cap.parameterSchema?.['x-video-parameter-metadata']?.schemaVersion==='1'&&cap.parameterSchema?.['x-video-mode']==='TEXT_TO_VIDEO'&&inputs.some(kind=>['IMAGE','VIDEO','AUDIO'].includes(kind)))throw preflightError('MODEL_INPUT_UNSUPPORTED','文生视频不使用参考素材，请先移除参考素材或对应连线。',cap,{...context,issues:inputs.flatMap(inputKind=>['IMAGE','VIDEO','AUDIO'].includes(inputKind)?[{field:'references.kind' as const,reason:'REFERENCE_FORBIDDEN' as const,inputKind:preflightKind(inputKind),maximum:0}]:[])});
  const issues:PreflightIssue[]=[],messages:string[]=[],labels:Record<string,string>={TEXT:'文字',STRUCTURED:'结构化数据',IMAGE:'图片',VIDEO:'视频',AUDIO:'音频'};
  if(cap.kind!==target&&!legacyImage){issues.push({field:'model.kind',reason:'KIND_MISMATCH'});messages.push(`当前节点需要 ${target} 类型模型，所选模型类型为 ${cap.kind}`);}
  if(!fitsInputs(cap,inputs)){
   const accepted=preflightInputKinds(cap.inputKinds??[]),unsupported=inputs.filter(input=>!cap.inputKinds?.includes(input));
   for(const input of unsupported)issues.push({field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:preflightKind(input),expectedKinds:accepted});
   if(!unsupported.length)issues.push({field:'inputs.kind',reason:'KIND_UNSUPPORTED',expectedKinds:accepted});
   messages.push(`不支持${[...new Set(unsupported)].map(input=>labels[input]??'未知类型').join('、')||'当前类型'}输入；支持的输入为${accepted.map(input=>labels[input]??'未知类型').join('、')||'无已声明类型'}`);
  }
  if(!fitsOutputs(cap,target)){issues.push({field:'output.kind',reason:'OUTPUT_UNSUPPORTED',expectedKinds:['TEXT','STRUCTURED']});messages.push('当前节点需要文字或结构化输出，所选模型不提供该输出');}
  if(issues.length)throw preflightError('MODEL_INPUT_UNSUPPORTED',messages.join('；')+'。请移除不支持的素材或对应连线，或选择兼容模型。',cap,{...context,issues});
  return cap;
 }
 const candidates=menuCapabilities(caps,kind,inputs,policy);
 const cap=candidates.find(cap=>real(cap)&&(cap.model||cap.executionKind==='AGENT'&&['LLM','IMAGE_UNDERSTANDING'].includes(cap.kind)))??candidates.find(cap=>cap.testMode===true)??(allowTests(caps,policy)&&target==='IMAGE_UNDERSTANDING'&&!caps.some(cap=>cap.model)?caps.find(cap=>cap.kind==='LLM'&&cap.testMode===true&&cap.available&&fitsInputs(cap,inputs)):undefined);
 if(!cap){const error=preflightError('MODEL_UNAVAILABLE','此入口暂无可用的真实模型。',undefined,{...context,issues:[{field:'model.kind',reason:'MODEL_UNAVAILABLE'}]});error.status=501;throw error;}
 return cap;
}
/** Explicit historical versions are resolved authoritatively, never upgraded to latest. */
export async function resolveCapability(request:(path:string)=>Promise<{data:any}>,caps:Capability[],kind:string,inputs:string[]=[],choice?:ModelChoice,policy:ModelPolicy={}){
 if(choice?.capabilityVersion!==undefined&&choice.capabilityVersion!==null&&choice.capabilityVersion!==''){
  if(typeof choice.capabilityVersion!=='string'||!choice.capabilityVersion.trim()||choice.capabilityVersion.length>100)throw new ApiError(422,'MODEL_SELECTION_INVALID','模型版本格式错误。');
  const current=caps.find(cap=>cap.capabilityRef===choice.capabilityRef);
  if(current?.version!==choice.capabilityVersion){
   const query=new URLSearchParams({ref:choice.capabilityRef,version:choice.capabilityVersion});let cap:Capability;
   try{cap=(await request('/model-capability-version?'+query)).data as Capability;}catch(error){if(error instanceof ApiError&&error.status===404)throw preflightError(current?'MODEL_VERSION_CHANGED':'MODEL_UNAVAILABLE',current?'所选模型的历史版本已不可用，请重新选择。':'所选模型未配置或已不可用，请重新选择。',current,{capabilityRef:choice.capabilityRef,capabilityVersion:choice.capabilityVersion,requestedKind:textKind(kind,inputs),inputKinds:preflightInputKinds(inputs),issues:[{field:'model.kind',reason:current?'MODEL_VERSION_CHANGED':'MODEL_UNAVAILABLE'}]});throw error;}
   if(!cap||cap.capabilityRef!==choice.capabilityRef||cap.version!==choice.capabilityVersion||typeof cap.parameterSchemaVersion!=='string'||!cap.parameterSchema||typeof cap.parameterSchema!=='object'||Array.isArray(cap.parameterSchema))throw new ApiError(502,'INVALID_RESPONSE','历史模型版本响应不一致。');
   return selectCapability([cap],kind,inputs,choice,{allowTestMode:allowTests(caps,policy)});
  }
 }
 return selectCapability(caps,kind,inputs,choice,policy);
}
export async function readModelCatalog(request:(path:string)=>Promise<{data:any}>):Promise<Capability[]>{
 const caps:Capability[]=[],seen=new Set<string>();let cursor='';
 do{const query=new URLSearchParams({limit:'100',...(cursor?{cursor}:{})}),page=(await request('/model-capabilities?'+query)).data;
  if(!Array.isArray(page?.items))throw new ApiError(502,'INVALID_RESPONSE','模型目录响应格式错误。');caps.push(...page.items);
  const next=page.nextCursor||'';if(next&&seen.has(next))throw new ApiError(502,'INVALID_RESPONSE','模型目录分页游标重复。');seen.add(next);cursor=next;
 }while(cursor);return caps;
}
