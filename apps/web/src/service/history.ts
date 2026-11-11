import {ApiError} from '../api/client';
import type {ProductClient} from './product-client';
import {historyVideoPosterURL} from './video-history-display';

type OutputKind='IMAGE'|'VIDEO'|'AUDIO'|'TDM'|'SPZ'|'TEXT'|'STRUCTURED';
export interface HistoryOutput {id?:string;outputId?:string;type:string;mimeType?:string;assetId?:string;text?:string;data?:unknown;testMode?:boolean;deletedAt?:string|null;[key:string]:unknown}
export interface HistoryMapping {historyId:string;outputId:string}
export type HistoryProjector=(raw:HistoryOutput,testMode:boolean)=>Promise<any>;
interface HistoryPlan {id:string;executionId?:string;taskId:string;projectId:string;nodeId:string;revision:number;createdAt:string;testMode:boolean;outputs:HistoryOutput[];paramsSnapshot?:any;nodeConfigSnapshot?:any}
interface HistoryPage {records:HistoryPlan[];page:number;size:number;total:number;hasNext:boolean;revision:number}
interface Item {raw:HistoryOutput;plan:HistoryPlan;kind:OutputKind;id:string;createdAt:number}
const kinds=new Set<OutputKind>(['IMAGE','VIDEO','AUDIO','TDM','SPZ','TEXT','STRUCTURED']);
const taskTypes=new Set(['API','WEBAPP','WORKFLOW','ExclAPI','CORPAPI','FAST_WEBAPP','SKU_WEBAPP_API','SKU_WORKFLOW_API','FAST_WEBAPP_V2']);
const maxPages=1000,maxOutputs=200000;
const unsupported=(message:string):never=>{throw new ApiError(501,'HISTORY_FILTER_UNAVAILABLE',message);};
const invalid=(message:string):never=>{throw new ApiError(502,'INVALID_HISTORY',message);};
const changed=():never=>{throw new ApiError(409,'HISTORY_CHANGED','历史已更新，请重新加载第一页。');};
function id(value:any){if(typeof value!=='string'||!value.trim())return invalid('历史缺少真实的结果或任务标识。');return value;}
function number(value:any,fallback:number,max:number){const result=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(result)||result<1||result>max)throw new ApiError(400,'VALIDATION_FAILED','历史分页参数无效。');return result;}
function classify(raw:HistoryOutput):OutputKind|null {
 const type=String(raw.type||'').toUpperCase();
 if(type==='TEXT'||type==='STRUCTURED')return type;
 if(type!=='ASSET'&&type!=='ARTIFACT')return invalid('历史结果类型无效。');
 id(raw.assetId);
 const mime=String(raw.mimeType||'').toLowerCase().split(';',1)[0].trim();
 if(mime.startsWith('image/'))return'IMAGE';if(mime.startsWith('video/'))return'VIDEO';if(mime.startsWith('audio/'))return'AUDIO';
 if(['model/gltf-binary','model/gltf+json'].includes(mime))return'TDM';
 if(['application/x-spz','application/x-ply','application/x-splat'].includes(mime))return'SPZ';
 if(!mime)return invalid('历史素材缺少实际MIME类型。');
 return null;
}
function groupEnd(items:Item[],start:number,size:number){let end=Math.min(items.length,start+size);while(end<items.length&&end>start&&items[end].plan.taskId===items[end-1].plan.taskId)end++;return end;}

/** Output-level projection of the real, owner-authorized STUDIO plan history. */
export class HistoryAdapter {
 private epoch=0;
 private readonly pending=new Set<AbortController>();
 constructor(private readonly api:ProductClient,private readonly projectOutput:HistoryProjector,private readonly onMapped?:(outputId:string,mapping:HistoryMapping)=>void){}
 clear(){this.epoch++;for(const controller of this.pending)controller.abort();this.pending.clear();}
 private check(epoch:number,signal:AbortSignal){if(epoch!==this.epoch||signal.aborted||!this.api.getAccessToken())throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次历史请求已取消。');}
 private filters(body:any,importMode:boolean){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'VALIDATION_FAILED','历史请求格式无效。');
  const supported=new Set(['page','pageNum','pageSize','size','current','canvasId','projectId','nodeId','type','status','hasOutput','onlyImageVideo','fromId','taskType','fastCreation','teamId','scope']);
  for(const key of Object.keys(body))if(!supported.has(key)&&body[key]!==undefined&&body[key]!==null&&body[key]!=='')unsupported('此历史筛选尚未接入。');
  if(body.teamId||body.scope&&body.scope!=='personal')unsupported('团队历史尚未接入。');
  if(body.status!==undefined){const status=Array.isArray(body.status)?body.status:[body.status];if(status.length!==1||!['SUCCESS','SUCCEEDED'].includes(status[0]))unsupported('历史仅支持已成功保存的结果。');}
  if(body.taskType!==undefined){const requested=body.taskType;if(!Array.isArray(requested)||requested.length!==taskTypes.size||new Set(requested).size!==taskTypes.size||requested.some((value:any)=>!taskTypes.has(value)))unsupported('任务来源筛选尚未接入。');}
  if(body.fastCreation!==undefined&&body.fastCreation!==null)unsupported('快速创作来源筛选尚未接入。');
  if(body.hasOutput!==undefined&&body.hasOutput!==true)unsupported('历史仅支持已保存的输出。');
  if(body.onlyImageVideo!==undefined&&typeof body.onlyImageVideo!=='boolean')throw new ApiError(400,'VALIDATION_FAILED','历史媒体筛选格式无效。');
  if(importMode&&body.onlyImageVideo===false)unsupported('原生导入仅支持图片和视频结果。');
  const requested=body.type===undefined||body.type===null||body.type===''?'':String(body.type).toUpperCase(),kind=['GLB','MESH_3D'].includes(requested)?'TDM':requested;
  if(kind&&kind!=='ALL'&&!kinds.has(kind as OutputKind))unsupported('此历史结果类型尚未接入。');
  if(importMode&&kind&&kind!=='ALL'&&!['IMAGE','VIDEO'].includes(kind))unsupported('原生导入仅支持图片和视频结果。');
  const page=number(body.page??body.pageNum??body.current,1,100000),size=number(body.size??body.pageSize,importMode?30:20,100);
  if(importMode&&page!==1)throw new ApiError(400,'VALIDATION_FAILED','作品导入使用任务游标，current必须为1。');
  if(!importMode&&body.fromId)unsupported('此历史列表使用结果页码。');
  if(body.fromId!==undefined&&typeof body.fromId!=='string')throw new ApiError(400,'VALIDATION_FAILED','历史游标格式无效。');
  const projectId=body.projectId??body.canvasId;if(projectId!==undefined&&(typeof projectId!=='string'||!projectId.trim()))throw new ApiError(400,'VALIDATION_FAILED','历史作品标识无效。');
  if(body.nodeId!==undefined&&(typeof body.nodeId!=='string'||!body.nodeId.trim()))throw new ApiError(400,'VALIDATION_FAILED','历史节点标识无效。');
  return{page,size,kind,onlyImageVideo:importMode||body.onlyImageVideo===true,fromId:body.fromId||'',projectId,nodeId:body.nodeId};
 }
 private async scan(projectId:string|undefined,nodeId:string|undefined,epoch:number,signal:AbortSignal){
  const plans:HistoryPlan[]=[],seen=new Set<string>();let revision:number|undefined,total:number|undefined;
  for(let page=1;page<=maxPages;page++){
   const query=new URLSearchParams({page:String(page),size:'100'});if(projectId)query.set('projectId',projectId);if(nodeId)query.set('nodeId',nodeId);
   const data=(await this.api.requestV2<HistoryPage>('/history?'+query,{signal})).data;this.check(epoch,signal);
   if(!data||!Array.isArray(data.records)||data.records.length>100||data.page!==page||data.size!==100||typeof data.hasNext!=='boolean'||!Number.isSafeInteger(data.total)||data.total<0||!Number.isSafeInteger(data.revision)||data.revision<0)return invalid('历史分页响应无效。');
   if(data.total>maxPages*100)throw new ApiError(413,'HISTORY_SCAN_LIMIT','历史超过本次可读取范围，请按作品或节点筛选。');
   if(revision!==undefined&&(data.revision!==revision||data.total!==total))return changed();revision=data.revision;total=data.total;
   for(const plan of data.records){if(!plan||typeof plan!=='object')return invalid('历史计划响应无效。');const key=id(plan.executionId||plan.id);if(seen.has(key))return changed();seen.add(key);plans.push(plan);}
   if(!data.hasNext){if(plans.length!==total)return changed();return{plans,revision};}
   if(data.records.length!==100)return invalid('历史分页不完整。');
  }
  throw new ApiError(413,'HISTORY_SCAN_LIMIT','历史超过本次可读取范围，请按作品或节点筛选。');
 }
 async list(body:any={},importMode=false){
  const filter=this.filters(body,importMode);if(!this.api.getAccessToken())throw new ApiError(401,'UNAUTHORIZED','请先登录。');
  const epoch=this.epoch,controller=new AbortController();this.pending.add(controller);
  try{
   const {plans,revision}=await this.scan(filter.projectId,filter.nodeId,epoch,controller.signal),items:Item[]=[],seen=new Set<string>();
   for(const plan of plans){
    id(plan.taskId);id(plan.executionId||plan.id);if(!Array.isArray(plan.outputs))return invalid('历史缺少已保存的输出。');
    const createdAt=Date.parse(plan.createdAt);if(!Number.isFinite(createdAt))return invalid('历史结果时间无效。');
    for(const raw of plan.outputs){if(!raw||typeof raw!=='object')return invalid('历史输出响应无效。');if(raw.deletedAt)continue;const outputId=id(raw.id||raw.outputId);if(seen.has(outputId))return invalid('历史结果标识重复。');seen.add(outputId);if(seen.size>maxOutputs)throw new ApiError(413,'HISTORY_SCAN_LIMIT','历史输出超过本次可读取范围，请按作品或节点筛选。');
     const kind=classify(raw);if(kind===null){if(filter.kind&&filter.kind!=='ALL'||filter.onlyImageVideo)continue;return unsupported('此已保存文件类型尚未提供原生历史展示。');}if(filter.kind&&filter.kind!=='ALL'&&kind!==filter.kind||filter.onlyImageVideo&&!['IMAGE','VIDEO'].includes(kind))continue;
     items.push({raw,plan,kind,id:outputId,createdAt});
    }
   }
   let start=(filter.page-1)*filter.size,end=start+filter.size;
   if(importMode){start=0;if(filter.fromId){let last=-1;for(let index=items.length-1;index>=0;index--)if(items[index].plan.taskId===filter.fromId){last=index;break;}if(last<0)throw new ApiError(409,'HISTORY_CURSOR_STALE','历史游标已失效，请重新加载第一页。');start=last+1;}end=groupEnd(items,start,filter.size);}
   const selected=items.slice(start,end),records=await Promise.all(selected.map(async item=>{
    const testMode=!!(item.plan.testMode||item.raw.testMode),output=await this.projectOutput(item.raw,testMode);this.check(epoch,controller.signal);
    if(!output||typeof output!=='object'||output.outputId&&output.outputId!==item.id)return invalid('历史输出映射无效。');
    const media=!['TEXT','STRUCTURED'].includes(item.kind),url=media?output.url||output.originalUrl:undefined;
    if(media&&(typeof url!=='string'||!url||output.assetId!==item.raw.assetId||typeof output.fileName!=='string'||!output.fileName))return invalid('历史结果缺少当前PF素材链接或文件名。');
    if(media&&classify({...item.raw,mimeType:output.mimeType||output.outputType})!==item.kind)return changed();
    const text=item.kind==='TEXT'?output.text??item.raw.text:undefined;if(item.kind==='TEXT'&&(typeof text!=='string'||!text.trim()))return invalid('历史文字输出无效。');
    if(item.kind==='STRUCTURED'&&!Object.hasOwn(output,'data')&&!Object.hasOwn(item.raw,'data'))return invalid('历史结构化输出无效。');
    const markedText=testMode&&text!==undefined&&!/TEST MODE/i.test(text)?'[TEST MODE] '+text:text;
    const nativeType=item.kind==='TDM'?(String(output.mimeType).toLowerCase()==='model/gltf+json'?'GLTF':'GLB'):item.kind;
    const name=output.fileName||item.raw.outputName||item.plan.nodeConfigSnapshot?.data?.title||'',result:any={...output,id:item.id,outputId:item.id,historyId:item.plan.executionId||item.plan.id,taskPlanId:item.plan.executionId||item.plan.id,taskId:item.plan.taskId,projectId:item.plan.projectId,nodeId:item.plan.nodeId,createTime:item.createdAt,createdAt:item.plan.createdAt,resultType:nativeType,outputType:nativeType,type:nativeType,nativeType:item.kind,status:'SUCCESS',testMode,outputName:name,fileName:output.fileName||'',paramsSnapshot:item.plan.paramsSnapshot,nodeConfigSnapshot:item.plan.nodeConfigSnapshot};
    if(media){result.resultUrl=url;result.url=url;if(item.kind==='VIDEO'){result.thumbnail=result.thumbnailUrl=historyVideoPosterURL(url);}else result.thumbnail=output.thumbnailUrl||url;if(importMode)result.fileUrl=url;}
    if(markedText!==undefined)result.text=markedText;
    if(item.kind==='STRUCTURED'&&!Object.hasOwn(output,'data'))result.data=item.raw.data;
    if(testMode){result.customBadgeText='TEST MODE';if(result.outputName&&!/TEST MODE/i.test(result.outputName))result.outputName='[TEST MODE] '+result.outputName;}
    // Isolated 2D tasks persist their real mode as a prompt condition. The
    // native preview filters missing modes into realtime, hiding manual jobs.
    const mode=[item.plan.nodeConfigSnapshot?.data?.generationMode,item.plan.paramsSnapshot?.generationMode,item.plan.nodeConfigSnapshot?.data?.promptSelection?.conditions?.generationMode].find(value=>value==='live'||value==='manual');if(mode!==undefined)result.generationMode=mode;
    return result;
   }));
   this.check(epoch,controller.signal);for(const record of records){this.check(epoch,controller.signal);this.onMapped?.(record.id,{historyId:record.historyId,outputId:record.id});}
   let pages=Math.ceil(items.length/filter.size);if(importMode){pages=0;for(let cursor=0;cursor<items.length;){cursor=groupEnd(items,cursor,filter.size);pages++;}}
   return{records,total:items.length,current:importMode?1:filter.page,page:importMode?1:filter.page,size:filter.size,pages,hasNext:end<items.length,hasMore:end<items.length,revision:String(revision),nextCursor:importMode&&end<items.length?records.at(-1)?.taskId||null:null};
  }finally{this.pending.delete(controller);}
 }
}
