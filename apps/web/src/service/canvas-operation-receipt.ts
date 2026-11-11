import {ApiError,type ApiResult} from '../api/client';
import type {Snapshot} from '../api/types';
import {applyLiveGraphDelta} from './canvas-live-delta';
import type {CanvasOperationBatch} from './canvas-operations';

type Receipt=Snapshot&{batchId:string;clientId:string};
type Request=CanvasOperationBatch&{receiptOnly?:boolean;baseRevision?:number};
type Send=(body:Request,headers?:Record<string,string>)=>Promise<ApiResult<any>>;
const invalid=()=>new ApiError(502,'INVALID_OPERATION_RECEIPT','服务器尚未确认此操作，修改仍在此页面。');
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const date=(s:unknown)=>typeof s==='string'&&Number.isFinite(Date.parse(s));
const emptyChange=(d:any)=>d&&['upsertNodes','removeNodeIds','upsertEdges','removeEdgeIds','positions'].every(k=>Array.isArray(d[k])&&!d[k].length)&&d.nodeOrder===undefined&&d.edgeOrder===undefined;
function full(value:any,project:string,batch:string){return value?.projectId===project&&value.batchId===batch&&positive(value.revision)&&value.graph?.schemaVersion==='1'&&Array.isArray(value.graph.nodes)&&Array.isArray(value.graph.edges);}
function compact(reply:ApiResult<any>,base:Snapshot,batch:string):Receipt|null{
 const v=reply.data;
 if(v?.kind!=='DELTA'||v.projectId!==base.projectId||v.batchId!==batch||v.fromRevision!==base.revision||!positive(v.revision)||v.revision<base.revision||reply.etag!=='"'+v.revision+'"'||!positive(v.acceptedRevision)||v.acceptedRevision>v.revision||!date(v.acceptedAt)||!date(v.updatedAt)||typeof v.clientId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.clientId)||typeof v.eventCursor!=='string'||!/^(0|[1-9]\d{0,18})$/.test(v.eventCursor))return null;
 if(v.supersededOperations!==undefined&&(!Number.isSafeInteger(v.supersededOperations)||v.supersededOperations<0))return null;
 if(v.revision===base.revision&&!emptyChange(v.delta))return null;
 const graph=applyLiveGraphDelta(base.graph,v.delta);if(!graph)return null;
 const {kind:_,delta:__,fromRevision:___,...rest}=v;return {...rest,graph};
}
/** Capture the immutable server snapshot when sending. A covering SSE event
 * may replace the storage map entry while the write response is in flight. */
export async function canvasOperationReceipt(project:string,body:Request,base:Snapshot|undefined,send:Send,guard:()=>void):Promise<ApiResult<Receipt>>{
 const negotiate=base?.projectId===project&&positive(base.revision)&&!body.receiptOnly;
 const headers=negotiate?{'X-STUDIO-Canvas-Receipt':'delta-v1','X-STUDIO-Canvas-Base':String(base.revision)}:undefined;
 let reply:ApiResult<any>|undefined;
 try{reply=await send(body,headers);}catch(error){if(!negotiate||!(error instanceof ApiError)||error.code!=='INVALID_RESPONSE')throw error;}
 guard();
 if(reply?.data?.kind===undefined&&full(reply?.data,project,body.batchId))return reply!;
 if(!negotiate)throw invalid();
 if(reply){const data=compact(reply,base,body.batchId);if(data)return {...reply,data};}
 // The write may already be durable. This lookup can only read its receipt.
 const recovered=await send({...body,receiptOnly:true});guard();
 if(recovered.data?.kind!==undefined||!full(recovered.data,project,body.batchId))throw invalid();
 return recovered;
}
