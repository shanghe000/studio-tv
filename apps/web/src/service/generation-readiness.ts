import {ApiError} from '../api/client';
import type {NativeGraph} from './graph';
import {preflightContext,withPreflightContext,type PreflightContext} from './preflight';

export interface GenerationReadinessIssue {nodeId:string;code:string;message:string;field?:string;sourceNodeId?:string;modelRef?:string;modelVersion?:string;context?:PreflightContext;retryable?:boolean}
export interface GenerationReadiness {status:'ready'|'blocked';issues:GenerationReadinessIssue[];deferredNodeIds?:string[]}
export interface GenerationPreparationOptions {preview?:boolean;deferPresetValidation?:boolean;nativeVideoComposer?:boolean;deferredSourceIds?:ReadonlySet<string>;deferredOutputKinds?:ReadonlyMap<string,string[]>}
export function isGenerationMaterialNode(node:any):boolean{
 const data=node?.data??{};if(data.isUpload===true)return true;
 if(!['rh-image','rh-video','rh-audio'].includes(node?.type))return false;
 const sources:unknown[]=Array.isArray(data.sourceObjects)?data.sourceObjects:typeof data.sourceObjects==='string'?[data.sourceObjects]:[];
 if(!sources.some((value:unknown)=>typeof value==='string'&&value.trim().length>0))return false;
 const configured=(value:any)=>value!==undefined&&value!==null&&(typeof value==='string'?value.trim().length>0:Array.isArray(value)?value.length>0:typeof value==='object'?Object.keys(value).length>0:true);
 if(['modelCode','capabilityRef','model','modelId','model_id','capabilityVersion','modelType','params','routerParameters','prompt','toolsType','generateNum'].some(key=>configured(data[key])))return false;
 const type=String(data.subType??'').toUpperCase().replaceAll('-','_');return['','TEXT_IMAGE','IMAGE_IMAGE','TEXT_VIDEO','IMAGE_VIDEO','TEXT_AUDIO','AUDIO_AUDIO'].includes(type);
}
// These nodes may provide references or contain other nodes, but cannot be jobs.
export function isGenerationTarget(node:any):boolean{
 return !!node&&!['group','rh-group','comment','rh-comment','__rhtv_meta','rh-script-asset','rh-resource'].includes(node.type)&&!isGenerationMaterialNode(node);
}
export const generationNodeName=(node:any)=>String(node?.data?.title||node?.data?.label||({'rh-image':'图片','rh-video':'视频','rh-text':'文字','rh-audio':'音频','rh-ai':'应用'} as Record<string,string>)[node?.type]||'生成节点').slice(0,100);
export function generationReadinessIssue(error:unknown,node:any):GenerationReadinessIssue {
 const context=preflightContext(error),detail=context?.issues?.[0],code=error instanceof ApiError?error.code:'PREFLIGHT_UNAVAILABLE';
 const message=error instanceof Error?error.message:'暂时无法完成输入检查，请稍后重试。';
 // Keep the transport classification before reducing errors to UI data. New
 // gateway/service error codes must not become permanently cached refusals.
 // 501 denotes an unimplemented feature and requires a product/config change.
 const retryable=error instanceof TypeError||error instanceof ApiError&&(error.code==='INVALID_RESPONSE'||[408,429,500,502,503,504].includes(error.status));
 return{nodeId:String(node?.id||''),code,message:`${generationNodeName(node)}：${message}`,...(retryable?{retryable:true}:{}),...(detail?{field:detail.field,...(detail.sourceNodeId?{sourceNodeId:detail.sourceNodeId}:{})}:{}),...(context?{context}:{}),...(context?.capabilityRef?{modelRef:context.capabilityRef}:{}),...(context?.capabilityVersion?{modelVersion:context.capabilityVersion}:{})};
}
/** Match the canvas command's whole-graph structural limits before any task is
 * created. Runtime model/provider failures remain a separate lifecycle. */
export function validateGenerationGraph(graph:NativeGraph,targetId=''){
 const fail=(message:string,nodeId=targetId)=>{throw withPreflightContext(new ApiError(422,'GRAPH_INPUT_INVALID',message),{schemaVersion:'1',issues:[{field:'inputs.kind',reason:'PARAMETER_INVALID',component:'TOPOLOGY',...(nodeId?{sourceNodeId:nodeId}:{})}]});};
 if(!Array.isArray(graph?.nodes)||!Array.isArray(graph?.edges))fail('画布结构不完整，请重新打开项目。');
 if(graph.nodes.length>500)fail('一次生成最多包含500个画布节点，请拆分项目或移除不用的节点。');
 if(graph.edges.length>2000)fail('一次生成最多包含2000条连线，请移除不用的连线。');
 if(new TextEncoder().encode(JSON.stringify({nodes:graph.nodes,edges:graph.edges})).length>2*1048576)fail('本次画布输入超过2 MiB，请精简节点中的文字或拆分项目。');
 const nodes=new Map<string,any>();for(const node of graph.nodes){if(typeof node?.id!=='string'||!node.id||new TextEncoder().encode(node.id).length>200||nodes.has(node.id))fail('画布包含无效或重复的节点标识，请重新打开项目。',String(node?.id||targetId));nodes.set(node.id,node);}
 const indegree=new Map([...nodes.keys()].map(id=>[id,0])),children=new Map<string,string[]>(),pairs=new Set<string>();
 for(const edge of graph.edges){if(!nodes.has(edge.source)||!nodes.has(edge.target))fail('连线指向已删除的节点，请移除这条连线后再生成。',edge.target||targetId);if(edge.source===edge.target)fail('节点不能连接到自身，请移除自连线。',edge.target);
  const pair=JSON.stringify([edge.source,edge.target]);if(pairs.has(pair))fail('同一对节点存在重复连线，请移除多余连线后再生成。',edge.target);pairs.add(pair);
  if([edge.sourceHandle,edge.targetHandle].some(value=>value!=null&&(typeof value!=='string'||new TextEncoder().encode(value).length>200))||edge.conditioningRole!=null&&(typeof edge.conditioningRole!=='string'||new TextEncoder().encode(edge.conditioningRole).length>64))fail('连线的输入端或参考用途无效，请重新连接。',edge.target);
  indegree.set(edge.target,indegree.get(edge.target)!+1);const rows=children.get(edge.source)??[];rows.push(edge.target);children.set(edge.source,rows);
 }
 const ready=[...indegree].filter(([,count])=>count===0).map(([id])=>id);let visited=0;
 while(ready.length){const id=ready.pop()!;visited++;for(const next of children.get(id)??[]){const count=indegree.get(next)!-1;indegree.set(next,count);if(count===0)ready.push(next);}}
 if(visited!==nodes.size){const id=[...indegree].find(([,count])=>count>0)![0];fail(`“${generationNodeName(nodes.get(id))}”所在连线形成循环，请断开循环后再生成。`,id);}
}
