import {ApiClient,ApiError,type RequestOptions} from '../api/client';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';
import type {Asset} from '../api/types';
import {selectedModel,resolveCapability,textKind,type Capability} from './model-catalog';

// installNative replaces the SDK's local ID creation with persisted STUDIO IDs.
// SDK HTTP has server history and avoids the gateway's browser-only list filter.
export const assistantNativeConfig={type:'CANVAS_NEW_AGENT',content:{transport:'http'}};

interface Conversation {id:string;revision:number;kind:'GLOBAL'|'CANVAS';title:string;projectId:string|null;createdAt:string;updatedAt:string}
interface Part {type:'TEXT'|'ASSET'|'STRUCTURED';text?:string;assetId?:string;schemaCode?:string;value?:unknown}
interface Message {id:string;conversationId:string;seq:number;role:'USER'|'ASSISTANT'|'TOOL';content:Part[];createdAt:string;conversationRevision?:number}
interface Page<T> {records:T[];page:number;size:number;total:number;hasNext:boolean}
export interface AssistantRun {id:string;state:string;testMode?:boolean;assistantMessageId?:string;outputMessageId?:string;errorCode?:string;errorMessage?:string;error?:{code?:string;message?:string};[key:string]:unknown}
export interface AssistantEvent {sequence?:number|string;seq?:number|string;runId?:string;type:string;data?:any;createdAt?:string;occurredAt?:string}
export interface StartedAssistantRun {conversationId:string;message:Message;run:AssistantRun}
export interface AssistantStreamUpdate {type:'delta'|'completed'|'cancelled'|'event';text?:string;event?:AssistantEvent;run?:AssistantRun}
interface NativeRecovery {controller:AbortController;epoch:number;selection:number;canvasId:string;conversationId:string;runId?:string;cancelRequested:boolean;cancelPromise?:Promise<AssistantRun>}
interface NativeUnverified {epoch:number;selection:number;canvasId:string;conversationId:string;errorShown:boolean;messageShown:boolean}
interface AgentCapability {capabilityRef:string;capabilityVersion:string;parameterSchemaVersion:string;parameterSchema:any;inputKinds:string[];historyTextOnly:boolean}
interface AgentCapabilities {enabled:boolean;version:'1';toolExecutionAvailable:boolean;capabilities:AgentCapability[]}
export interface AssistantResolvers {
 beforeCanvasRun?:(projectId:string,signal:AbortSignal)=>Promise<void|(()=>void)>;
 resolveAsset?:(ref:string,signal?:AbortSignal)=>Promise<Asset|null|undefined>|Asset|null|undefined;
 resolveSkill?:(id:string,signal?:AbortSignal)=>Promise<{resource:{id:string;revision:number;version:string};content:{markdown?:string;files?:{path:string;content:string}[]}}>|{resource:{id:string;revision:number;version:string};content:{markdown?:string;files?:{path:string;content:string}[]}};
}

const escaped=(id:unknown)=>encodeURIComponent(requiredId(id));
function requiredId(value:unknown):string {if(typeof value!=='string'||!value.trim())throw new ApiError(400,'VALIDATION_FAILED','需要真实的会话或运行ID。');return value;}
const unsupported=(message:string):never=>{throw new ApiError(501,'NOT_IMPLEMENTED',message);};
const textOf=(message:Message)=>message.content.filter(part=>part.type==='TEXT').map(part=>part.text||'').join('\n');
const millis=(value:string)=>{const time=Date.parse(value);if(!Number.isFinite(time))throw new ApiError(502,'INVALID_RESPONSE','会话时间无效。');return time;};
const terminal=(state:string)=>['SUCCEEDED','COMPLETED','FAILED','CANCELLED','CANCELED','TIMED_OUT','UNKNOWN'].includes(state.toUpperCase());
const testText=(text:string,testMode?:boolean)=>testMode&&!/TEST MODE/i.test(text)?'[TEST MODE]\n'+text:text;
const sse=(type:string,data:any)=>`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const directRunId=(id:string)=>/^agr_[a-f0-9]{32}$/.test(id);
const unverifiedMessage='本次执行结果尚未确认，请先核对画布和任务状态。';
const nativeServiceFailure=new Set(['Agent 服务处理失败，请重试当前步骤。','The Agent service could not complete this step. Please retry.']);
const validRunCursor=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value)&&(value.length<19||value<='9223372036854775807');
const eventSequence=(event:AssistantEvent)=>{const value=event.sequence??event.seq;if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return BigInt(value);if(validRunCursor(value)&&value!=='0')return BigInt(value);throw new ApiError(502,'INVALID_RESPONSE','运行事件序号无效。');};
const eventCursor=(value:number|string)=>{if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);if(validRunCursor(value))return BigInt(value);throw new ApiError(400,'VALIDATION_FAILED','恢复事件游标无效。');};
// The frozen WebSocket consumer tracks numeric seq. Convert only losslessly;
// the STUDIO polling cursor and the event itself retain the decimal string.
const nativeSequence=(event?:AssistantEvent)=>{const value=event?.sequence??event?.seq;if(typeof value==='string'){const number=Number(value);return Number.isSafeInteger(number)?number:value;}return value;};
function toolActivity(event:AssistantEvent){
 const status=event.type==='tool.started'?'running':event.type==='tool.completed'?(event.data?.success===false?'failed':'completed'):event.type==='tool.failed'?'failed':undefined;
 const {callId,toolName}=event.data||{};if(!status)return;
 if(typeof callId!=='string'||!callId||callId.length>256||typeof toolName!=='string'||!toolName||toolName.length>256)throw new ApiError(502,'INVALID_RESPONSE','工具事件响应无效。');
 const labels:Record<string,string>={studio_canvas_read:'读取画布',studio_canvas_patch:'更新画布',studio_model_list:'查看可用模型',studio_node_run:'提交生成任务',studio_task_read:'查看任务进度',studio_task_cancel:'取消任务'};
 return{schema:'runninghub.agent-activity.v1',id:callId,tool_name:toolName,kind:toolName.startsWith('studio_canvas_')?'canvas':'tool',label:labels[toolName]||'处理画布任务',status};
}

function pageNumber(value:any,fallback:number,max:number){if(value===undefined)return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)throw new ApiError(400,'VALIDATION_FAILED','分页参数无效。');return n;}
function pathname(path:string){if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Assistant native path must be relative');return new URL(path,'https://studio.invalid');}
function sdkPath(path:string){return path.replace(/^\/canvas\/agent\/cac(?=\/api\/v1\/)/,'').replace(/^\/agent-platform(?=\/api\/v1\/)/,'');}

/** Native protocol projection over STUDIO's persisted, owner-authorized resources. */
export class AssistantAdapter {
 private epoch=0;
 private readonly pending=new Set<AbortController>();
 private readonly sockets=new Set<AssistantSocket>();
 private readonly runs=new Map<string,string>();
 private readonly directRuns=new Set<string>();
 private readonly runCredentials=new Map<string,string>();
 private readonly creating=new Map<string,Promise<string>>();
 private readonly modelHistoryKinds=new Map<string,Set<string>>();
 modelInputKinds(id?:string){return [...(this.modelHistoryKinds.get(id||this.nativeSessionId||'')??[])];}
 private nativeState:any=null;
 private nativeInstalled=false;
 private nativeSelection=0;
 private nativeSessionId:string|null=null;
 private nativeRecovery:NativeRecovery|null=null;
 private nativeUnverified:NativeUnverified|null=null;
 private readonly nativeErrorMethods=new WeakSet<Function>();
 constructor(private readonly api:ApiClient,private readonly resolvers:AssistantResolvers={}){}
 clear(){this.nativeUnverified=null;this.modelHistoryKinds.clear();this.epoch++;this.nativeSelection++;this.stopNativeRecovery();this.nativeSessionId=null;for(const controller of this.pending)controller.abort();this.pending.clear();for(const socket of this.sockets)socket.close(1000,'Session cleared');this.sockets.clear();this.runs.clear();this.directRuns.clear();this.runCredentials.clear();this.creating.clear();this.nativeState?.resetConversationState();this.nativeState?.setGatewaySessionId(null);this.nativeState?.setLoading(false);this.nativeState?.setStreaming(false);this.nativeState=null;}
 private async request<T>(path:string,options:RequestOptions={}) {
  const result=await (this.api as ProductClient).requestV2<T>(path,options);
  // A body decoder may finish after transport headers released their scope.
  // Recheck the adapter signal before any event or native state is projected.
  if(options.signal?.aborted)throw new DOMException('Assistant request cancelled','AbortError');
  return result;
 }
 private scope(signal?:AbortSignal|null){
  if(!this.api.getAccessToken())throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
  const controller=new AbortController(),epoch=this.epoch,abort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  this.pending.add(controller);
  return{controller,check:()=>{if(epoch!==this.epoch||controller.signal.aborted||!this.api.getAccessToken())throw new DOMException('Assistant request cancelled','AbortError');},release:()=>{signal?.removeEventListener('abort',abort);this.pending.delete(controller);}};
 }
 private async scoped<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal){const scope=this.scope(signal);try{scope.check();const result=await work(scope.controller.signal);scope.check();return result;}finally{scope.release();}}
 private async detail(id:string,signal:AbortSignal){return this.request<Conversation>('/conversations/'+escaped(id),{signal});}
 private nativeGuard(id:string){
  const selection=this.nativeSelection,canvas=this.nativeState?.activeCanvasId,bound=this.nativeSessionId===id;
  return()=>{if(bound&&(selection!==this.nativeSelection||this.nativeSessionId!==id||this.nativeState?.activeCanvasId!==canvas))throw new DOMException('Assistant session changed','AbortError');};
 }
 private originalAgentMode(body:any,id:string){return(body.metadata?.chat_mode??body.chat_mode??body.chatMode??(this.nativeSessionId===id?this.nativeState?.currentChatMode:undefined))==='agent'&&body.businessType!=='HYPER_FRAMES';}
 private async agentCapabilities(signal:AbortSignal){
  let data:AgentCapabilities;try{data=(await this.request<AgentCapabilities>('/agent-capabilities',{signal})).data;}catch(error){if(error instanceof ApiError&&error.status===404)return;throw error;}
  if(data?.version!=='1'||typeof data.enabled!=='boolean'||typeof data.toolExecutionAvailable!=='boolean'||!Array.isArray(data.capabilities)||data.capabilities.some(cap=>typeof cap?.capabilityRef!=='string'||typeof cap?.capabilityVersion!=='string'))throw new ApiError(502,'INVALID_RESPONSE','Agent能力响应无效。');
  return data;
 }
 private isAgentRun(run:AssistantRun){return run.kind==='AGENT'||this.directRuns.has(run.id);}
 private runPath(conversationId:string,runId:string){return this.directRuns.has(runId)?`/agent-runs/${escaped(runId)}`:`/assistant/conversations/${escaped(conversationId)}/runs/${escaped(runId)}`;}
 private validateRun(run:AssistantRun,conversationId:string,runId:string){if(run?.id!==runId||run.conversationId!==conversationId||typeof run.state!=='string')throw new ApiError(404,'ASSISTANT_RUN_NOT_FOUND','运行不属于当前会话。');if(this.directRuns.has(runId)&&(run.kind!=='AGENT'||!['QUEUED','RUNNING','WAITING_FOR_AUTH','SUCCEEDED','FAILED','CANCELED','TIMED_OUT','UNKNOWN'].includes(run.state)))throw new ApiError(502,'INVALID_RESPONSE','Agent运行响应无效。');}
 private async messages(id:string,signal:AbortSignal){
  const records:Message[]=[];let page=1;
  for(;;){const {data}=await this.request<Page<Message>>(`/conversations/${escaped(id)}/messages?page=${page}&size=100`,{signal});
   if(!Array.isArray(data.records))throw new ApiError(502,'INVALID_RESPONSE','消息历史响应无效。');
   records.push(...data.records);if(!data.hasNext)break;
   if(data.records.length===0||page>=100000)throw new ApiError(502,'INVALID_RESPONSE','消息历史分页无效。');page++;
  }
  return records;
 }
 private async create(body:any,signal:AbortSignal){
  const project=body.canvasId||body.canvas_id||body.projectId||body.metadata?.canvas_id;
  const input:any={kind:project?'CANVAS':'GLOBAL',title:typeof body.title==='string'?body.title:'新对话'};
  if(project)input.projectId=requiredId(project);
  const {data}=await this.request<Conversation>('/conversations',{method:'POST',body:input,headers:{'Idempotency-Key':randomUuid()},signal});return data;
 }
 private async list(body:any,query:URLSearchParams,signal:AbortSignal,sdk:boolean){
  const page=pageNumber(body.pageNum??body.page??query.get('page')??undefined,1,100000),size=pageNumber(body.pageSize??body.size??query.get('page_size')??undefined,20,100);
  const project=body.canvasId||body.canvas_id||body.projectId||query.get('canvas_id'),params=new URLSearchParams({page:String(page),size:String(size),kind:project?'CANVAS':'GLOBAL'});
  if(project)params.set('projectId',requiredId(project));if(body.keyword)params.set('keyword',String(body.keyword));
  const {data}=await this.request<Page<Conversation>>('/conversations?'+params,{signal});
  const records=await Promise.all(data.records.map(async conversation=>{const count=(await this.messages(conversation.id,signal)).filter(message=>message.role==='USER').length;return sdk?{session_id:conversation.id,title:conversation.title,updated_at:millis(conversation.updatedAt),turn_count:count,created_at:millis(conversation.createdAt)}:{sessionId:conversation.id,title:conversation.title,lastTurnTime:millis(conversation.updatedAt),turnCount:count,createdAt:millis(conversation.createdAt)};}));
  return{records,total:data.total,size:data.size,current:data.page,pages:Math.ceil(data.total/data.size),hasNext:data.hasNext};
 }
 private async nativeEnvelope(message:Message,signal:AbortSignal){
  if(message.role==='TOOL')return unsupported('客户端工具消息协议尚未接入，原始历史仍保存在服务端。');
  const parts=await Promise.all(message.content.map(async part=>{
   if(part.type==='TEXT')return{type:'text',text:part.text||''};
   if(part.type==='STRUCTURED')return{type:'text',text:part.schemaCode==='ASSISTANT_SKILL_V1'?'[已选择技能]':JSON.stringify({schemaCode:part.schemaCode,value:part.value})};
   const {data}=await this.api.request<any>('/assets/'+escaped(part.assetId),{signal});
   const kinds=this.modelHistoryKinds.get(message.conversationId)??new Set<string>();if(data.kind)kinds.add(data.kind);this.modelHistoryKinds.set(message.conversationId,kinds);
   const url=data.previewUrl||data.downloadUrl;if(!url)throw new ApiError(502,'ASSET_UNAVAILABLE','历史消息素材尚不可用。');
   return{type:'text',text:`[${data.fileName||part.assetId}](${url})`};
  }));
  return{schema:'runninghub.message-envelope.v1',id:message.id,role:message.role.toLowerCase(),created_at:millis(message.createdAt),parts};
 }
 private async history(id:string,signal:AbortSignal){
  const {data}=await this.detail(id,signal),messages=await this.messages(id,signal);
  this.modelHistoryKinds.set(id,new Set<string>());
  return{session_id:data.id,canvas_id:data.projectId,protocol:'runninghub.message-envelope.v1',title:data.title,envelopes:await Promise.all(messages.map(message=>this.nativeEnvelope(message,signal)))};
 }
 private isNativeState(state:any){return state&&typeof state.setMessages==='function'&&typeof state.setGatewaySessionId==='function'&&typeof state.resetConversationState==='function'&&typeof state.addMessage==='function'&&Object.hasOwn(state,'activeCanvasId');}
 private nativeUnverifiedCurrent(){const hint=this.nativeUnverified;if(hint&&(hint.epoch!==this.epoch||hint.selection!==this.nativeSelection||hint.conversationId!==this.nativeSessionId||hint.canvasId!==this.nativeState?.activeCanvasId))this.nativeUnverified=null;return this.nativeUnverified;}
 private installNativeErrorProjection(state:any){
  const adapter=this;
  for(const method of ['setError','addMessage']){
   const original=state[method];if(typeof original!=='function'||this.nativeErrorMethods.has(original))continue;
   const projected=function(this:any,value:any,...args:any[]){
    const hint=adapter.nativeUnverifiedCurrent(),text=method==='setError'?value:value?.content;
    if(hint&&nativeServiceFailure.has(text)&&(method==='setError'||value?.role==='assistant'&&value?._local===true)){
     if(method==='setError'){hint.errorShown=true;value=unverifiedMessage;}else{hint.messageShown=true;value={...value,content:unverifiedMessage,_canRetry:false};}
     if(hint.errorShown&&hint.messageShown)adapter.nativeUnverified=null;
    }
    return original.call(this,value,...args);
   };
   this.nativeErrorMethods.add(projected);state[method]=projected;
  }
 }
 private stopNativeRecovery(){this.nativeRecovery?.controller.abort();this.nativeRecovery=null;}
 private captureNativeState(state:any){
  const previous=this.nativeState,canvasChanged=previous&&previous.activeCanvasId!==state.activeCanvasId,gatewayChanged=!previous||previous.gatewaySessionId!==state.gatewaySessionId;
  if(canvasChanged||previous&&gatewayChanged&&state.gatewaySessionId!==this.nativeSessionId){this.nativeSelection++;this.stopNativeRecovery();}
  if(canvasChanged||gatewayChanged)this.nativeSessionId=state.gatewaySessionId||null;
  this.nativeState=state;
 }
 private recoveryCurrent(recovery:NativeRecovery){return this.nativeRecovery===recovery&&!recovery.controller.signal.aborted&&recovery.epoch===this.epoch&&recovery.selection===this.nativeSelection&&this.nativeState?.activeCanvasId===recovery.canvasId&&this.nativeSessionId===recovery.conversationId;}
 private checkRecovery(recovery:NativeRecovery){if(!this.recoveryCurrent(recovery))throw new DOMException('Assistant session changed','AbortError');}
 /** These private callbacks are reached through the bundle's exported React
  * object. Their exact inspected signatures and dependency shapes distinguish
  * them from every other useCallback; no frozen file or React hook order changes.
  */
 installNative(native:any){
  if(this.nativeInstalled)return;
  const react=native?.r;if(typeof react?.useCallback!=='function')throw new ApiError(501,'NATIVE_ASSISTANT_SEAM_UNAVAILABLE','当前原生界面未提供会话适配接缝。');
  const original=react.useCallback,adapter=this;
  react.useCallback=function(callback:Function,dependencies:any[]|undefined){
   const source=Function.prototype.toString.call(callback);
   // The inspected main turn callback maps every SDK backend error through
   // Fp and projects a local retry card. Preserve only a bound UNKNOWN result.
   if(Array.isArray(dependencies)&&dependencies.length===9&&adapter.isNativeState(dependencies[0])&&source.includes('F-AGENT-CHAT-START')&&source.includes('F-AGENT-CHAT-ERROR')&&source.includes('Fp(')&&source.includes('addMessage')){
    adapter.captureNativeState(dependencies[0]);adapter.installNativeErrorProjection(dependencies[0]);
   }
   if(Array.isArray(dependencies)&&dependencies.length===2&&adapter.isNativeState(dependencies[0])&&source.includes('createSession 需要画布 ID')&&source.includes('setGatewaySessionId')){
    const [state,canvasId]=dependencies;adapter.captureNativeState(state);
    return original.call(this,()=>adapter.ensureNativeSession(state,String(canvasId)),dependencies);
   }
   if(Array.isArray(dependencies)&&dependencies.length===7&&adapter.isNativeState(dependencies[1])&&/await\s+fz\(\{\s*sessionId\s*:/.test(source)&&/shouldCommit\s*:/.test(source)){
    const [abort,state,canvasId]=dependencies;adapter.captureNativeState(state);
   return original.call(this,(id:string)=>adapter.loadNativeSession(requiredId(id),state,String(canvasId),abort),dependencies);
   }
   if(Array.isArray(dependencies)&&dependencies.length===3&&adapter.isNativeState(dependencies[1])&&source.includes('setGatewaySessionId(null)')&&source.includes('setAgentIdOverride')&&source.includes('setSkillPackageState')){
    return original.call(this,(...args:any[])=>{adapter.nativeSelection++;adapter.stopNativeRecovery();adapter.nativeSessionId=null;dependencies[1].setLoading(false);dependencies[1].setStreaming(false);return callback(...args);},dependencies);
   }
   if(Array.isArray(dependencies)&&dependencies.length===3&&adapter.isNativeState(dependencies[1])&&source.includes('_remakeBackgroundTaskId')&&source.includes('canvas.agent.session.cancelled')){
    return original.call(this,(...args:any[])=>{const recovery=adapter.nativeRecovery;return recovery&&adapter.recoveryCurrent(recovery)?adapter.cancelNativeRecovery(recovery):callback(...args);},dependencies);
   }
   return original.call(this,callback,dependencies);
  };
  this.nativeInstalled=true;
 }
 private async ensureNativeSession(state:any,canvasId:string){
  const epoch=this.epoch;
  if(!canvasId||this.nativeState?.activeCanvasId!==canvasId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开会话。');
  const currentId=this.nativeSessionId;
  if(currentId){await this.scoped(signal=>this.detail(requiredId(currentId),signal));if(epoch!==this.epoch||this.nativeState?.activeCanvasId!==canvasId)throw new DOMException('Canvas changed','AbortError');return currentId;}
  const pending=this.creating.get(canvasId);if(pending)return pending;
  const created=this.scoped(async signal=>{const conversation=await this.create({canvasId},signal);if(epoch!==this.epoch||this.nativeState?.activeCanvasId!==canvasId)throw new DOMException('Canvas changed','AbortError');this.nativeSessionId=conversation.id;state.setGatewaySessionId(conversation.id);return conversation.id;});
  this.creating.set(canvasId,created);try{return await created;}finally{if(this.creating.get(canvasId)===created)this.creating.delete(canvasId);}
 }
 private async loadNativeSession(id:string,state:any,canvasId:string,abort?:()=>void){
  const epoch=this.epoch,selection=++this.nativeSelection;this.stopNativeRecovery();abort?.();
  const history=await this.scoped(signal=>this.history(id,signal));
  if(epoch!==this.epoch||this.nativeState?.activeCanvasId!==canvasId)throw new DOMException('Canvas changed','AbortError');
  // Match native Te's ++w.current/shouldCommit guard: the most recent
  // selection wins even when two histories resolve on the same canvas.
  if(selection!==this.nativeSelection)return false;
  if(history.canvas_id!==canvasId)throw new ApiError(404,'CONVERSATION_NOT_FOUND','此会话不属于当前画布。');
  this.nativeSessionId=history.session_id;state.resetConversationState();state.setGatewaySessionId(history.session_id);
  state.setMessages(history.envelopes.map(envelope=>({schema:envelope.schema,id:envelope.id,role:envelope.role,timestamp:envelope.created_at,content:envelope.parts.map(part=>part.text).join('\n'),parts:envelope.parts,isStreaming:false,_historyReplay:true})));
  void this.recoverNativeSession(history.session_id,state,canvasId,epoch,selection);
  return true;
 }
 private async cancelNativeRecovery(recovery:NativeRecovery){
  this.checkRecovery(recovery);recovery.cancelRequested=true;
  if(!recovery.runId)return;
  if(!recovery.cancelPromise)recovery.cancelPromise=this.cancelRun(recovery.conversationId,recovery.runId,recovery.controller.signal);
  try{return await recovery.cancelPromise;}catch(error){if(this.recoveryCurrent(recovery))this.nativeState?.setError?.(error instanceof Error?error.message:'运行取消失败。');}
 }
 private async recoverNativeSession(id:string,state:any,canvasId:string,epoch:number,selection:number){
  const recovery:NativeRecovery={controller:new AbortController(),epoch,selection,canvasId,conversationId:id,cancelRequested:false};this.nativeRecovery=recovery;
  state.setLoading(true);state.setStreaming(false);
  try{
   const data=await this.scoped(async signal=>{
    const agent=this.originalAgentMode({},id)?await this.agentCapabilities(signal):undefined;
    this.checkRecovery(recovery);
    const direct=agent?(await this.request<{records:AssistantRun[]}>(`/conversations/${escaped(id)}/agent-runs?state=active`,{signal})).data.records:[];
    if(!Array.isArray(direct))throw new ApiError(502,'INVALID_RESPONSE','活动Agent运行响应无效。');
    for(const run of direct){if(run.kind!=='AGENT'||run.conversationId!==id)throw new ApiError(502,'INVALID_RESPONSE','活动运行不属于当前会话。');this.directRuns.add(requiredId(run.id));}
    const legacy=(await this.request<{records:AssistantRun[]}>(`/assistant/conversations/${escaped(id)}/runs?state=active`,{signal})).data;
    if(!Array.isArray(legacy.records))throw new ApiError(502,'INVALID_RESPONSE','活动运行响应无效。');
    return{records:[...direct,...legacy.records]};
   },recovery.controller.signal);this.checkRecovery(recovery);
   if(!Array.isArray(data.records))throw new ApiError(502,'INVALID_RESPONSE','活动运行响应无效。');
   if(data.records.length>1)throw new ApiError(409,'MULTIPLE_ACTIVE_RUNS','此会话存在多个活动运行，请检查服务端状态。');
   // A run can commit between the first history read and discovery. Absence
   // is authoritative for activity, but its final reply still needs a read.
   if(!data.records.length){await this.refreshNativeSession(id,recovery.controller.signal);this.checkRecovery(recovery);return;}
   const task=data.records[0];
   if(!['ASSISTANT','AGENT'].includes(String(task.kind))||task.conversationId!==id||typeof task.id!=='string'||!task.id.trim()||typeof task.messageId!=='string'||!task.messageId.trim()||!['QUEUED','RUNNING','WAITING_TOOL','WAITING_FOR_AUTH'].includes(task.state))throw new ApiError(502,'INVALID_RESPONSE','活动运行不属于当前会话。');
   recovery.runId=task.id;
   if(recovery.cancelRequested)await this.cancelNativeRecovery(recovery);
   if(task.state==='WAITING_TOOL'&&!recovery.cancelRequested)return unsupported('此运行正在等待客户端工具，工具恢复协议尚未接入。');
   const started=await this.resume(id,task.id,recovery.controller.signal);this.checkRecovery(recovery);
   if(started.run.state==='WAITING_TOOL')return unsupported('此运行正在等待客户端工具，工具恢复协议尚未接入。');
   state.setLoading(false);state.setStreaming(true);
   const run=await this.watch(started,update=>{this.checkRecovery(recovery);const activity=update.event&&toolActivity(update.event);if(activity)this.nativeState?.setOrchestrationStep?.(activity.status==='running'?{phase:'building',preview:activity.label}:null);},recovery.controller.signal);this.checkRecovery(recovery);
   if(['CANCELLED','CANCELED'].includes(run.state.toUpperCase()))await this.refreshNativeSession(id,recovery.controller.signal);
  }catch(error){if(this.recoveryCurrent(recovery)&&!(error instanceof DOMException&&error.name==='AbortError'))this.nativeState?.setError?.(error instanceof Error?error.message:'活动运行恢复失败。');}
  finally{if(this.recoveryCurrent(recovery)){this.nativeState?.setLoading(false);this.nativeState?.setStreaming(false);this.nativeState?.setOrchestrationStep?.(null);}if(this.nativeRecovery===recovery)this.nativeRecovery=null;}
 }
 private async refreshNativeSession(id:string,signal:AbortSignal){
  const state=this.nativeState,canvasId=state?.activeCanvasId,selection=this.nativeSelection;if(!state||this.nativeSessionId!==id||!canvasId)return;
  const history=await this.history(id,signal);if(selection!==this.nativeSelection||this.nativeState?.activeCanvasId!==canvasId||this.nativeSessionId!==id)return;
  state.setMessages(history.envelopes.map(envelope=>({schema:envelope.schema,id:envelope.id,role:envelope.role,timestamp:envelope.created_at,content:envelope.parts.map(part=>part.text).join('\n'),parts:envelope.parts,isStreaming:false,_historyReplay:true})));
 }
 private async gatewayHistory(id:string,body:any,signal:AbortSignal){
  await this.detail(id,signal);const messages=await this.messages(id,signal),turns:any[]=[];
  for(const message of messages){if(message.role==='USER')turns.push({id:message.id,sessionId:id,createdAt:message.createdAt,rawRequest:JSON.stringify({messages:[{role:'user',content:textOf(message)}]}),rawResponse:''});else if(message.role==='ASSISTANT'&&turns.length)turns[turns.length-1].rawResponse+=sse('chat.final',{text:textOf(message)});}
  const page=pageNumber(body.pageNum??body.page,1,100000),size=pageNumber(body.pageSize??body.size,50,100),records=turns.reverse().slice((page-1)*size,page*size);
  return{records,total:turns.length,size,current:page,pages:Math.ceil(turns.length/size),hasNext:page*size<turns.length};
 }
 async handle(path:string,body:any={},method='POST'):Promise<any|undefined>{
  const url=pathname(path),route=url.pathname,normalized=sdkPath(route);body=body||{};
  const create=['/canvas/openclaw/sessions/create','/canvas/api/session/create'].includes(route);
  const list=['/canvas/openclaw/sessions/list','/canvas/api/session/list'].includes(route)||normalized==='/api/v1/sessions';
  const remove=['/canvas/openclaw/sessions/delete','/canvas/api/session/delete'].includes(route);
  const history=['/canvas/openclaw/sessions/detail','/canvas/api/session/detail'].includes(route);
  const message=['/canvas/api/message/send','/canvas/api/session/message/send'].includes(route);
  const sdkDetail=normalized.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  const cancel=normalized.match(/^\/api\/v1\/chat\/tasks\/([^/]+)\/cancel$/);
  const turnDelete=route==='/canvas/openclaw/turns/delete';
  const messageDelete=['/canvas/api/message/delete','/canvas/api/session/message/delete'].includes(route);
  const sdkDelete=normalized.match(/^\/api\/v1\/sessions\/([^/]+)\/(messages|turns)\/([^/]+)$/);
  const pendingTools=normalized==='/api/v1/chat/client-tools/pending';
  if(turnDelete||messageDelete||sdkDelete||pendingTools)return this.scoped(async signal=>{
   if(pendingTools){
    const id=requiredId(body.session_id||body.sessionId||url.searchParams.get('session_id'));
    const {data}=await this.request<any>('/conversations/'+escaped(id)+'/client-tools/pending',{signal});
    if(!data||data.session_id!==id||data.status!=='none'||data.call!==null||data.resume_command!==null||data.active_resume!==null||!Array.isArray(data.host_events)||data.host_events.length||data.terminal_recovered!==false)throw new ApiError(502,'INVALID_RESPONSE','客户端工具状态响应无效。');
    return data;
   }
   if(sdkDelete&&method!=='DELETE')throw new ApiError(405,'METHOD_NOT_ALLOWED','消息删除需要DELETE请求。');
   const id=sdkDelete?decodeURIComponent(sdkDelete[1]):requiredId(body.sessionId||body.session_id||body.conversationId);
   const target=sdkDelete?decodeURIComponent(sdkDelete[3]):requiredId(turnDelete?body.turnId||body.turn_id||body.id:body.messageId||body.message_id||body.id);
   const type=sdkDelete?sdkDelete[2]:turnDelete?'turns':'messages',current=await this.detail(id,signal);
   const {data}=await this.request<any>('/conversations/'+escaped(id)+'/'+type+'/'+escaped(target),{method:'DELETE',headers:{'If-Match':current.etag||`"${current.data.revision}"`,'Idempotency-Key':randomUuid()},signal});
   if(data?.conversationId!==id||!Array.isArray(data.deletedMessageIds)||!data.deletedMessageIds.includes(target)||data.deletedMessageIds.some((value:any)=>typeof value!=='string'||!value)||new Set(data.deletedMessageIds).size!==data.deletedMessageIds.length||!Number.isSafeInteger(data.conversationRevision)||data.conversationRevision<=current.data.revision||typeof data.deletedAt!=='string'||!Number.isFinite(Date.parse(data.deletedAt)))throw new ApiError(502,'INVALID_RESPONSE','服务端消息删除结果无效。');
   if(this.nativeSessionId===id)await this.refreshNativeSession(id,signal);
   return data;
  });
  if(!create&&!list&&!remove&&!history&&!message&&!sdkDetail&&!cancel){
   return undefined;
  }
  return this.scoped(async signal=>{
   if(create)return(await this.create(body,signal)).id;
   if(list)return this.list(body,url.searchParams,signal,normalized==='/api/v1/sessions');
   if(remove||sdkDetail&&method==='DELETE'){
    const id=sdkDetail?decodeURIComponent(sdkDetail[1]):requiredId(body.sessionId||body.session_id||body.id),current=await this.detail(id,signal);
    const result=await this.request<{accepted:boolean}>('/conversations/'+escaped(id),{method:'DELETE',headers:{'If-Match':current.etag||`"${current.data.revision}"`},signal});
    if(result.data.accepted!==true)throw new ApiError(502,'INVALID_RESPONSE','服务端没有确认会话删除。');return result.data;
   }
   if(history)return this.gatewayHistory(requiredId(body.sessionId||body.session_id||body.id),body,signal);
   if(sdkDetail)return this.history(decodeURIComponent(sdkDetail[1]),signal);
   if(cancel){const id=decodeURIComponent(cancel[1]);if(directRunId(id))this.directRuns.add(id);let conversation=this.runs.get(id)||body.sessionId||body.session_id;
    if(!conversation){const {data}=await this.request<AssistantRun>((this.directRuns.has(id)?'/agent-runs/':'/assistant-runs/')+escaped(id),{signal});conversation=requiredId(data.conversationId);if(this.directRuns.has(id))this.validateRun(data,conversation,id);await this.detail(conversation,signal);}return this.cancel(requiredId(conversation),id,signal);}
   if(message){const id=requiredId(body.sessionId||body.session_id||body.id),current=await this.detail(id,signal);return this.append(id,body,current,signal);}
  });
 }
 private input(body:any){
  if(body.toolOutputs?.length||body.interaction_response||body.runtime_event)return unsupported('客户端工具和交互事件尚未由对话执行接口实现。');
  if(Array.isArray(body.content))return body.content;
  const last=Array.isArray(body.messages)?[...body.messages].reverse().find((message:any)=>message.role==='user'||message.role==='USER'):null;
  const text=body.message??body.prompt??last?.content??body.content;
  if((text===undefined||text==='')&&(body.image_attachments?.length||body.imageAttachments?.length||body.attachments?.length||last?._imageAttachments?.length))return[];
  if(typeof text!=='string'||!text.trim())throw new ApiError(400,'VALIDATION_FAILED','请输入对话内容。');
  return[{type:'TEXT',text}];
 }
 async validatedInput(body:any,signal?:AbortSignal):Promise<Part[]>{return this.scoped(async scopedSignal=>{
  if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'VALIDATION_FAILED','消息请求格式无效。');
  for(const key of ['image_attachments','imageAttachments','attachments','skill_ids','skillIds','skill_refs','skillRefs'])if(body[key]!==undefined&&!Array.isArray(body[key]))throw new ApiError(400,'VALIDATION_FAILED','消息附件或技能格式无效。');
  const raw=this.input(body);if(raw.length>100||raw.some((part:any)=>!part||typeof part!=='object'||Array.isArray(part)||!['TEXT','ASSET','STRUCTURED'].includes(part.type)))throw new ApiError(400,'VALIDATION_FAILED','消息内容格式无效。');
  for(const part of raw){if(part.type==='TEXT'&&(typeof part.text!=='string'||!part.text||part.text.includes('\0')||[...part.text].length>200000))throw new ApiError(400,'VALIDATION_FAILED','消息文本格式无效。');if(part.type==='ASSET')requiredId(part.assetId);}
  const input:Part[]=raw.map((part:Part)=>({...part})),structuredSkills:string[]=[];
  for(const part of input)if(part.type==='STRUCTURED'){if(part.schemaCode!=='ASSISTANT_SKILL_V1')return unsupported('此结构化消息schema尚未接入。');structuredSkills.push(requiredId((part.value as any)?.skillId));}
  const parts=input.filter(part=>part.type!=='STRUCTURED');
  const last=Array.isArray(body.messages)?[...body.messages].reverse().find((message:any)=>message.role==='user'||message.role==='USER'):null;
  const attachments=[...parts.filter(part=>part.type==='ASSET').map(part=>({assetId:part.assetId})),...(body.image_attachments||[]),...(body.imageAttachments||[]),...(body.attachments||[]),...(last?._imageAttachments||[])];
  for(const attachment of attachments){const ref=typeof attachment==='string'?attachment:attachment?.assetId||attachment?.url;
   if(typeof ref!=='string'||!ref)throw new ApiError(400,'ASSET_REFERENCE_REQUIRED','附件需要已授权的PF素材引用。');
   const mapped=await this.resolvers.resolveAsset?.(ref,scopedSignal),id=mapped?.id||(ref.startsWith('rhtv-asset:')?ref.slice('rhtv-asset:'.length):attachment?.assetId);
   if(!id)throw new ApiError(400,'ASSET_REFERENCE_REQUIRED','附件链接没有对应已上传的PF素材。');
   const {data:asset}=await this.api.request<Asset>('/assets/'+escaped(id),{signal:scopedSignal});
   if(asset.state!=='READY'||!['IMAGE','VIDEO','AUDIO'].includes(asset.kind))throw new ApiError(422,'ASSET_NOT_READY','附件素材尚未就绪。');
   if(!parts.some(part=>part.type==='ASSET'&&part.assetId===asset.id))parts.push({type:'ASSET',assetId:asset.id});
  }
  const selected=[...structuredSkills,...(body.skill_ids||[]),...(body.skillIds||[]),...(body.skill_refs||[]),...(body.skillRefs||[]),...(last?.skill_ids||[]),...(body.skillPackageId?[body.skillPackageId]:[]),...(body.skill_package_id?[body.skill_package_id]:[])];
  const skillIds=[...new Set(selected.map(requiredId))];if(skillIds.length>20)throw new ApiError(400,'VALIDATION_FAILED','一次对话最多选择20个技能。');
  for(const id of skillIds){
   const skill=this.resolvers.resolveSkill?await this.resolvers.resolveSkill(id,scopedSignal):(await this.request<any>('/skills/'+escaped(id),{signal:scopedSignal})).data;
   if(!skill?.resource||skill.resource.id!==id||!Number.isSafeInteger(skill.resource.revision)||skill.resource.revision<1||typeof skill.resource.version!=='string'||!skill.content)throw new ApiError(502,'INVALID_RESPONSE','技能详情响应无效。');
   const version=body.skillPackageVersionId||body.skill_package_version_id;if(version&&version!==skill.resource.version)throw new ApiError(412,'VERSION_CONFLICT','选中的技能版本已更新，请重新选择。');
   const markdown=skill.content.markdown||'',files=skill.content.files||[];
   if(typeof markdown!=='string'||!Array.isArray(files)||files.length>100||files.some((file:any)=>!file||typeof file.path!=='string'||typeof file.content!=='string'))throw new ApiError(502,'INVALID_RESPONSE','技能内容响应无效。');
   // ASSISTANT_SKILL_V1 permits only path/content. The server must re-read
   // the authoritative resource metadata to interpret encoded binary files.
   const value={skillId:id,revision:skill.resource.revision,version:skill.resource.version,markdown,files:files.map((file:any)=>({path:file.path,content:file.content}))};
   if(JSON.stringify(value).length>200000)throw new ApiError(413,'SKILL_SNAPSHOT_TOO_LARGE','技能内容过大，无法加入本次对话。');
   parts.push({type:'STRUCTURED',schemaCode:'ASSISTANT_SKILL_V1',value});
  }
  if(!parts.length)throw new ApiError(400,'VALIDATION_FAILED','请输入内容或添加已授权素材。');
  if(parts.length>100)throw new ApiError(400,'VALIDATION_FAILED','消息内容最多100段。');
  return parts;
 },signal);}
 private async append(id:string,body:any,current:{data:Conversation;etag?:string|null},signal:AbortSignal,content?:Part[]){
  const {data}=await this.request<Message>(`/conversations/${escaped(id)}/messages`,{method:'POST',body:{content:content||await this.validatedInput(body,signal)},headers:{'If-Match':current.etag||`"${current.data.revision}"`,'Idempotency-Key':randomUuid()},signal});return data;
 }
 private async capability(body:any,content:Part[],id:string,signal:AbortSignal){
  const candidates:Capability[]=[],inputs=new Set<string>();
  const read=async(kind:string)=>{let cursor='';const seen=new Set<string>();do{const params=new URLSearchParams({kind,limit:'100',...(cursor?{cursor}:{})}),page=(await this.request<{items:Capability[];nextCursor?:string|null}>('/model-capabilities?'+params,{signal})).data;if(!Array.isArray(page.items))throw new ApiError(502,'INVALID_RESPONSE','模型目录响应无效。');candidates.push(...page.items);const next=page.nextCursor||'';if(next&&seen.has(next))throw new ApiError(502,'INVALID_RESPONSE','模型目录分页无效。');seen.add(next);cursor=next;}while(cursor);};
  await read('LLM');
  // New model profiles must account for all persisted media in the context,
  // including a text-only continuation after an earlier image turn.
  const prior=candidates.some(cap=>cap.model)?(await this.messages(id,signal)).flatMap(message=>message.content):[];
  for(const part of [...prior,...content]){if(part.type==='ASSET'){const asset=(await this.api.request<Asset>('/assets/'+escaped(part.assetId),{signal})).data;inputs.add(asset.kind);}else inputs.add(part.type);}
  this.modelHistoryKinds.set(id,inputs);const kind=textKind('LLM',[...inputs]),choice=selectedModel(body,'assistant',kind);
  if(kind==='IMAGE_UNDERSTANDING'||choice&&!candidates.some(cap=>cap.capabilityRef===choice.capabilityRef))await read('IMAGE_UNDERSTANDING');
  return resolveCapability(path=>this.request<any>(path,{signal}),candidates,'LLM',[...inputs],choice);
 }
 private agentSelection(agent:AgentCapabilities,body:any,content:Part[]){
  if(!agent.toolExecutionAvailable)throw new ApiError(501,'AGENT_UNAVAILABLE','画布Agent尚不可用。');
  // Enabled direct discovery owns its exact model and parameter protocol.
  // Frozen vendor labels and Router preferences do not select this runtime.
  const ref=body.capabilityRef,version=body.capabilityVersion;
  if(ref!==undefined&&(typeof ref!=='string'||!ref.trim())||version!==undefined&&(typeof version!=='string'||!version.trim()||ref===undefined))throw new ApiError(422,'MODEL_SELECTION_INVALID','模型版本选择无效。');
  const candidates=ref===undefined?agent.capabilities:agent.capabilities.filter(cap=>cap.capabilityRef===ref);
  if(!candidates.length)throw new ApiError(422,'MODEL_AGENT_UNSUPPORTED','所选模型尚不支持画布Agent，请重新选择。');
  const exact=version===undefined?candidates:candidates.filter(cap=>cap.capabilityVersion===version);
  if(!exact.length)throw new ApiError(409,'MODEL_VERSION_CHANGED','所选模型版本已更新，请重新选择。');
  if(exact.length!==1)throw new ApiError(502,'INVALID_RESPONSE','Agent默认模型响应不明确。');
  const capability=exact[0],schema=capability.parameterSchema,effort=schema?.properties?.reasoningEffort;
  if(capability.parameterSchemaVersion!=='2'||schema?.type!=='object'||schema.additionalProperties!==false||!schema.properties||Object.keys(schema.properties).length!==1||effort?.type!=='string'||!Array.isArray(effort.enum)||effort.enum.length!==2||!effort.enum.includes('low')||!effort.enum.includes('high')||effort.default!=='low'||!Array.isArray(capability.inputKinds)||capability.inputKinds.length!==1||capability.inputKinds[0]!=='TEXT'||capability.historyTextOnly!==true)throw new ApiError(502,'INVALID_RESPONSE','Agent模型参数协议无效。');
  const parameters=body.parameters===undefined?{}:body.parameters;
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).some(key=>key!=='reasoningEffort')||parameters.reasoningEffort!==undefined&&!effort.enum.includes(parameters.reasoningEffort))throw new ApiError(422,'MODEL_PARAMETERS_INVALID','画布Agent参数无效。');
  // The server freezes and validates the bounded history for this run.
  // Only the submitted input can be checked here without widening that window.
  if(content.some(part=>part.type!=='TEXT'))throw new ApiError(422,'MODEL_INPUT_UNSUPPORTED','此画布Agent版本只支持纯文本输入。');
  return{capabilityRef:capability.capabilityRef,capabilityVersion:capability.capabilityVersion,parameters:{reasoningEffort:parameters.reasoningEffort??effort.default}};
 }
 async start(body:any,signal?:AbortSignal):Promise<StartedAssistantRun>{return this.scoped(async scopedSignal=>{
  this.nativeUnverified=null;
  // Validate before persisting a turn or selecting a model. Conversation reads
  // precede catalog calls so an inaccessible session cannot start work.
  this.input(body);const id=requiredId(body.sessionId||body.session_id),checkNative=this.nativeGuard(id),current=await this.detail(id,scopedSignal);checkNative();
  const guard=current.data.kind==='CANVAS'&&current.data.projectId?await this.resolvers.beforeCanvasRun?.(current.data.projectId,scopedSignal):undefined;
  const checkCanvas=()=>{if(scopedSignal.aborted)throw new DOMException('Assistant request cancelled','AbortError');checkNative();if(typeof guard==='function')guard();};
  checkCanvas();
  const content=await this.validatedInput(body,scopedSignal);checkCanvas();
  const agent=current.data.kind==='CANVAS'&&current.data.projectId&&this.originalAgentMode(body,id)?await this.agentCapabilities(scopedSignal):undefined;checkCanvas();
  const direct=agent?.enabled===true;
  const selection=direct?this.agentSelection(agent,body,content):await this.capability(body,content,id,scopedSignal).then(capability=>({capabilityRef:capability.capabilityRef,capabilityVersion:capability.version,parameters:body.parameters||{}}));checkCanvas();
  let expectedRevision:number|undefined;
  if(direct){
   const snapshot=(await this.request<{projectId:string;graphRevision:number}>(`/projects/${escaped(current.data.projectId)}/live-snapshot`,{signal:scopedSignal})).data;checkCanvas();
   if(snapshot?.projectId!==current.data.projectId||!Number.isSafeInteger(snapshot.graphRevision)||snapshot.graphRevision<1)throw new ApiError(502,'INVALID_RESPONSE','画布修订响应无效。');expectedRevision=snapshot.graphRevision;
  }
  const message=await this.append(id,body,current,scopedSignal,content);checkCanvas();
  const {data:run}=await this.request<AssistantRun>(direct?`/conversations/${escaped(id)}/agent-runs`:`/assistant/conversations/${escaped(id)}/runs`,{method:'POST',body:{...selection,messageId:message.id,...(direct?{expectedRevision}:{})},headers:{'Idempotency-Key':randomUuid()},signal:scopedSignal});checkNative();
  requiredId(run.id);if(direct){this.directRuns.add(run.id);this.validateRun(run,id,run.id);if(run.messageId!==message.id||run.projectId!==current.data.projectId)throw new ApiError(502,'INVALID_RESPONSE','Agent运行绑定响应无效。');}
  this.runs.set(run.id,id);return{conversationId:id,message,run};
 },signal);}
 async resume(conversationId:string,runId:string,signal?:AbortSignal,kind?:'AGENT'):Promise<StartedAssistantRun>{return this.scoped(async scopedSignal=>{
  if(kind==='AGENT'||directRunId(runId))this.directRuns.add(requiredId(runId));
  await this.detail(conversationId,scopedSignal);const base=this.runPath(conversationId,runId);
  const {data}=await this.request<AssistantRun>(base,{signal:scopedSignal});
  this.validateRun(data,conversationId,runId);
  const messageId=requiredId(data.messageId),history=await this.messages(conversationId,scopedSignal),message=history.find(item=>item.id===messageId&&item.role==='USER');
  if(!message)throw new ApiError(502,'ASSISTANT_INPUT_NOT_PERSISTED','运行的原始消息尚未保存。');
  const run={...data};
  // The task keeps its input ID; the output ID is the persisted event's
  // messageId. Recover it even when after_seq already passed that event.
  if(terminal(run.state)){let after=0n;for(;;){const {data:page}=await this.request<{items:AssistantEvent[]}>(`${base}/events?after=${after}`,{signal:scopedSignal});if(!Array.isArray(page.items))throw new ApiError(502,'INVALID_RESPONSE','运行事件响应无效。');for(const event of page.items){const sequence=eventSequence(event);if(sequence!==after+1n||this.directRuns.has(runId)&&event.runId!==runId)throw new ApiError(502,'INVALID_RESPONSE','运行事件序号无效。');after=sequence;if(['chat.delta','message.delta'].includes(event.type)&&typeof event.data?.messageId==='string')run.assistantMessageId=event.data.messageId;}if(page.items.length<100)break;}}
  this.runs.set(runId,conversationId);return{conversationId,message,run};
 },signal);}
 private async cancel(conversationId:string,runId:string,signal?:AbortSignal){if(directRunId(runId))this.directRuns.add(runId);const {data}=await this.request<AssistantRun>(this.runPath(conversationId,runId)+'/cancel',{method:'POST',body:{},signal});if(this.directRuns.has(runId))this.validateRun(data,conversationId,runId);return data;}
 cancelRun(conversationId:string,runId:string,signal?:AbortSignal){return this.scoped(scopedSignal=>this.cancel(conversationId,runId,scopedSignal),signal);}
 private async updateAgentAuth(conversationId:string,run:AssistantRun,signal:AbortSignal,refresh:boolean){
  const client=this.api as ProductClient;
  if(refresh)await client.refreshAccess(signal);
  for(let attempt=0;attempt<2;attempt++){
   const epoch=run.credentialEpoch;
   if(typeof epoch!=='string'||!/^[1-9]\d{0,19}$/.test(epoch))throw new ApiError(502,'INVALID_RESPONSE','Agent凭证修订响应无效。');
   const token=client.getAccessToken();if(!token)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
   try{
    const {data}=await this.request<AssistantRun>(`/agent-runs/${escaped(run.id)}/auth-context`,{method:'PUT',body:{},etag:`"${epoch}"`,signal});
    this.validateRun(data,conversationId,run.id);if(typeof data.credentialEpoch!=='string'||!/^[1-9]\d{0,19}$/.test(data.credentialEpoch))throw new ApiError(502,'INVALID_RESPONSE','Agent凭证修订响应无效。');
    // A concurrent refresh can change memory after request headers are sent.
    // Keep the captured credential so the next poll confirms any rotation;
    // never place it in a request body or native model context.
    this.runCredentials.set(run.id,token);return data;
   }catch(error){
    if(!(error instanceof ApiError&&error.status===412&&attempt===0))throw error;
    if(!await client.refreshAccess(signal))throw error;
    const {data}=await this.request<AssistantRun>(`/agent-runs/${escaped(run.id)}/auth-context`,{signal});this.validateRun(data,conversationId,run.id);run=data;
   }
  }
  throw new ApiError(412,'VERSION_CONFLICT','Agent凭证已更新，请重新打开会话。');
 }
 private async pause(signal:AbortSignal){await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Assistant polling cancelled','AbortError'));},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},400);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});}
 async watch(started:StartedAssistantRun,onUpdate:(update:AssistantStreamUpdate)=>void,signal?:AbortSignal,after:number|string=0){return this.scoped(async scopedSignal=>{
  const {conversationId,message}=started,checkNative=this.nativeGuard(conversationId),direct=this.isAgentRun(started.run);if(direct)this.directRuns.add(started.run.id);
  const base=this.runPath(conversationId,started.run.id);let run=started.run,last=eventCursor(after),full='',persistedMessageId=run.assistantMessageId||run.outputMessageId,waitingCredential:string|undefined;
  for(;;){
   checkNative();
   if(direct&&!terminal(run.state)){
    const waiting=run.state==='WAITING_FOR_AUTH',epoch=typeof run.credentialEpoch==='string'?run.credentialEpoch:undefined;
    if(this.runCredentials.get(run.id)!==this.api.getAccessToken()||waiting&&waitingCredential!==epoch){run=await this.updateAgentAuth(conversationId,run,scopedSignal,waiting);checkNative();if(waiting)waitingCredential=String(run.credentialEpoch);}
    if(!waiting)waitingCredential=undefined;
   }
   const {data}=await this.request<{items:AssistantEvent[];nextCursor?:string|null;terminal?:boolean}>(`${base}/events?after=${last}`,{signal:scopedSignal});
   checkNative();
   if(!Array.isArray(data.items)||data.items.length>100)throw new ApiError(502,'INVALID_RESPONSE','运行事件响应无效。');
   for(const event of data.items){const sequence=eventSequence(event);if(typeof event.type!=='string'||direct&&(event.runId!==run.id||typeof event.sequence!=='string'))throw new ApiError(502,'INVALID_RESPONSE','运行事件不属于当前运行。');if(sequence<=last)continue;if(sequence!==last+1n)throw new ApiError(502,'EVENT_SEQUENCE_GAP','运行事件不连续，请重新加载会话。');last=sequence;
    const kind=event.type.toLowerCase(),value=event.data?.delta??event.data?.text;
    if(['chat.delta','message.delta'].includes(kind)&&typeof event.data?.messageId==='string')persistedMessageId=event.data.messageId;
    if(['text.delta','text_delta','output.text.delta','response.output_text.delta','chat.delta','message.delta'].includes(kind)&&typeof value==='string'){full=event.data?.snapshot===true||kind==='chat.delta'?value:full+value;onUpdate({type:'delta',text:testText(full,run.testMode),event});}
    else onUpdate({type:'event',event});
   }
   if(data.items.length===100)continue;
   // A terminal run observed before this page freezes its event log. Drain
   // that log before projecting either completion or failure to the native UI.
   if(direct&&terminal(run.state)){this.validateRun(run,conversationId,started.run.id);if(run.messageId!==message.id)throw new ApiError(502,'INVALID_RESPONSE','Agent输入绑定已变更。');break;}
   const result=await this.request<AssistantRun>(base,{signal:scopedSignal});checkNative();run=result.data;if(direct){this.validateRun(run,conversationId,started.run.id);if(run.messageId!==message.id)throw new ApiError(502,'INVALID_RESPONSE','Agent输入绑定已变更。');}
   if(run.state==='WAITING_TOOL')return unsupported('此运行正在等待客户端工具，工具恢复协议尚未接入。');
   if(terminal(run.state)){if(direct&&data.terminal!==true)continue;break;}await this.pause(scopedSignal);
  }
  this.runCredentials.delete(run.id);
  if(['CANCELLED','CANCELED'].includes(run.state.toUpperCase())){onUpdate({type:'cancelled',run});return run;}
  if(run.state==='UNKNOWN'||(run.error?.code||run.errorCode)==='RUNTIME_RESULT_UNVERIFIED')throw new ApiError(502,run.error?.code||run.errorCode||'AGENT_RUN_UNKNOWN',unverifiedMessage);
  if(run.state.toUpperCase()==='FAILED')throw new ApiError(502,run.error?.code||run.errorCode||'ASSISTANT_RUN_FAILED',run.error?.message||run.errorMessage||run.errorCode||'对话运行失败。');
  if(run.state==='TIMED_OUT')throw new ApiError(504,run.errorCode||'AGENT_RUN_TIMED_OUT',run.errorMessage||'运行超时，请重新打开会话查看已保存结果。');
  const history=await this.messages(conversationId,scopedSignal),expected=run.assistantMessageId||run.outputMessageId||persistedMessageId;let output:Message|undefined;
  checkNative();
  if(expected)output=history.find(item=>item.id===expected&&item.role==='ASSISTANT');
  else{const index=history.findIndex(item=>item.id===message.id);if(index>=0){const following=history.slice(index+1),next=following.findIndex(item=>item.role==='USER'),turn=next<0?following:following.slice(0,next);output=turn.filter(item=>item.role==='ASSISTANT').at(-1);}}
  if(!output||!textOf(output).trim())throw new ApiError(502,'ASSISTANT_OUTPUT_NOT_PERSISTED','运行已结束，但服务端尚未保存对应回复。');
  onUpdate({type:'completed',text:testText(textOf(output),run.testMode),run});await this.refreshNativeSession(conversationId,scopedSignal);return run;
 },signal);}
 supportsStream(path:string):boolean{
  if(!path.startsWith('/')||path.startsWith('//'))return false;
  return['/canvas/openclaw/chat','/api/v1/chat/stream','/canvas/agent/chat/stream'].includes(sdkPath(pathname(path).pathname));
 }
 async stream(path:string,body:any={},signal?:AbortSignal):Promise<Response|undefined>{
  if(!this.supportsStream(path)||body.businessType==='HYPER_FRAMES')return undefined;
  const route=sdkPath(pathname(path).pathname);
  const scope=this.scope(signal),streamEpoch=this.epoch;let started:StartedAssistantRun;
  try{started=await this.start(body,scope.controller.signal);scope.check();}catch(error){scope.release();throw error;}
  const encoder=new TextEncoder(),raw=route==='/api/v1/chat/stream',checkNative=this.nativeGuard(started.conversationId);let stopped=false;
  const current=()=>{try{checkNative();return streamEpoch===this.epoch&&!!this.api.getAccessToken();}catch{return false;}};
  const abortCancel=()=>{if(!stopped&&current()&&signal?.aborted)void this.cancelRun(started.conversationId,started.run.id).catch(()=>{});};signal?.addEventListener('abort',abortCancel,{once:true});
  const bodyStream=new ReadableStream<Uint8Array>({start:controller=>{
   const emit=(value:string)=>{scope.check();checkNative();controller.enqueue(encoder.encode(value));};
   void this.watch(started,update=>{
    if(update.type==='delta'&&!raw)emit(sse('chat.delta',{text:update.text}));
    if(update.type==='event'&&update.event){const activity=toolActivity(update.event);if(activity)emit(raw?'\u001e'+JSON.stringify({type:'agent_activity',activity})+'\n':sse('agent.tool',{phase:activity.status==='running'?'start':activity.status,toolName:activity.tool_name}));}
    if(update.type==='completed')emit(raw?update.text||'':sse('chat.final',{text:update.text}));if(update.type==='cancelled')emit(raw?'\n[error] 运行已取消。':sse('chat.error',{error:'运行已取消。'}));
   },scope.controller.signal).then(()=>{if(!raw)emit('data: [DONE]\n\n');controller.close();}).catch(error=>{if(scope.controller.signal.aborted||!current())controller.error(error);else{try{const message=error instanceof Error?error.message:'对话运行失败。';if(raw&&this.directRuns.has(started.run.id)&&error instanceof ApiError&&message===unverifiedMessage&&this.nativeSessionId===started.conversationId&&this.nativeState?.activeCanvasId)this.nativeUnverified={epoch:this.epoch,selection:this.nativeSelection,canvasId:this.nativeState.activeCanvasId,conversationId:started.conversationId,errorShown:false,messageShown:false};emit(raw?'\n[error] '+message:sse('chat.error',{error:message}));controller.close();}catch{controller.error(error);}}}).finally(()=>{stopped=true;signal?.removeEventListener('abort',abortCancel);scope.release();});
  },cancel:()=>{if(!stopped&&current())void this.cancelRun(started.conversationId,started.run.id).catch(()=>{});scope.controller.abort();}});
  return new Response(bodyStream,{status:200,headers:{'Content-Type':raw?'text/plain;charset=utf-8':'text/event-stream','Cache-Control':'no-store'}});
 }
 socket(url:string):AssistantSocket|undefined{const route=new URL(url,'https://studio.invalid').pathname;if(!['/agent-platform/api/v1/chat/stream','/canvas/agent/cac/api/v1/chat/stream'].includes(route))return undefined;const socket=new AssistantSocket(this);this.sockets.add(socket);socket.addEventListener('close',()=>this.sockets.delete(socket),{once:true});return socket;}
}

/** WebSocket-shaped bridge; every business frame follows a persisted REST run. */
export class AssistantSocket extends EventTarget {
 static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSING=2;static readonly CLOSED=3;
 readonly CONNECTING=0;readonly OPEN=1;readonly CLOSING=2;readonly CLOSED=3;
 readyState=0;bufferedAmount=0;binaryType='blob';protocol='';extensions='';url='';
 onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;onclose:((event:Event)=>void)|null=null;
 private active:StartedAssistantRun|null=null;private controller:AbortController|null=null;
 constructor(private readonly adapter:AssistantAdapter){super();queueMicrotask(()=>{if(this.readyState!==0)return;this.readyState=1;this.deliver('open',new Event('open'));this.frame({type:'connection.ready',payload:{}});});}
 private deliver(type:string,event:Event){this.dispatchEvent(event);const callback=(this as any)['on'+type];callback?.call(this,event);}
 private frame(data:any){if(this.readyState===1)this.deliver('message',new MessageEvent('message',{data:JSON.stringify({version:1,...data})}));}
 send(data:string){if(this.readyState!==1)throw new DOMException('Socket is not open','InvalidStateError');let frame:any;try{frame=JSON.parse(data);}catch{this.frame({type:'chat.error',payload:{code:'INVALID_FRAME',message:'无效的聊天请求。',retryable:false}});return;}
  if(frame.type==='ping'){this.frame({type:'pong',payload:{}});return;}
  void this.command(frame).catch(error=>{if(this.readyState===1&&!(error instanceof DOMException&&error.name==='AbortError'))this.frame({request_id:frame.request_id,type:'chat.error',payload:{code:error instanceof ApiError?error.code:'ASSISTANT_ERROR',message:error instanceof Error?error.message:'对话运行失败。',retryable:false}});});
 }
 private async command(frame:any){
  const payload=frame.payload||{},request_id=frame.request_id;
  if(frame.type==='chat.cancel'){if(!this.active)throw new ApiError(409,'NO_ACTIVE_RUN','当前没有可取消的运行。');await this.adapter.cancelRun(this.active.conversationId,this.active.run.id);return;}
  if(frame.type!=='chat.start'&&frame.type!=='session.attach')return unsupported('此聊天工具或会话事件尚未由服务端实现。');
  if(this.controller)throw new ApiError(409,'CHAT_BUSY','当前对话仍在运行。');
  this.controller=new AbortController();
  try{
   const after=frame.type==='session.attach'?(payload.after_seq??0):0;eventCursor(after);
   const started=frame.type==='session.attach'?await this.adapter.resume(requiredId(payload.session_id),requiredId(payload.run_id),this.controller.signal,payload.run_kind==='AGENT'?'AGENT':undefined):await this.adapter.start(payload,this.controller.signal);this.active=started;
   this.frame({request_id,run_id:started.run.id,type:'run.accepted',payload:{run_id:started.run.id,client_command_id:payload.client_command_id}});
   this.frame({request_id,run_id:started.run.id,type:'chat.started',payload:{task_id:started.run.id}});
   let sent='';await this.adapter.watch(started,update=>{const envelope={request_id,run_id:started.run.id};
    if(update.type==='delta'){const text=update.text||'';if(!text.startsWith(sent))throw new ApiError(502,'INVALID_RESPONSE','运行文本顺序无效。');this.frame({...envelope,seq:nativeSequence(update.event),type:'chat.delta',payload:{text:text.slice(sent.length)}});sent=text;}
    if(update.type==='event'){const activity=update.event&&toolActivity(update.event);this.frame({...envelope,seq:nativeSequence(update.event),type:'chat.event',payload:activity?{type:'agent_activity',activity}:update.event});}
    if(update.type==='completed')this.frame({...envelope,type:'chat.completed',payload:{output:update.text}});
    if(update.type==='cancelled')this.frame({...envelope,type:'chat.cancelled',payload:{}});
   },this.controller.signal,after);
  }finally{this.controller=null;this.active=null;}
 }
 close(code=1000,reason=''){if(this.readyState===3)return;this.readyState=3;this.controller?.abort();this.controller=null;const event=new Event('close');Object.assign(event,{code,reason,wasClean:true});this.deliver('close',event);}
}
