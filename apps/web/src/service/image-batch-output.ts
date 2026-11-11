import {sha256} from '@noble/hashes/sha2.js';
import {ApiError} from '../api/client';

const refs=new Set(['codex-image-generate-v1','codex-image-edit-v1']);
const comfyRefs=new Set(['z-image-turbo-generate-v1','flux2-klein4b-generate-v1']);
const comfyBatch=(plan:any)=>plan.capabilityVersion==='1'&&comfyRefs.has(plan.capabilityRef);
export const imageBatchPlan=(plan:any)=>['2','3'].includes(plan.capabilityVersion)&&refs.has(plan.capabilityRef)||comfyBatch(plan)&&plan.status==='SUCCESS';
export function imageBatchNodeId(taskId:string,executionId:string,outputId:string){
 const json=JSON.stringify([taskId,executionId,outputId]).replace(/[<>&\u2028\u2029]/g,value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
 const digest=sha256(new TextEncoder().encode(json));
 return 'img_'+Array.from(digest.subarray(0,16),value=>value.toString(16).padStart(2,'0')).join('');
}
const finite=(value:any,fallback:number)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e7?value:fallback;
const size=(value:any,fallback:number)=>finite(value,fallback)>0?finite(value,fallback):fallback;
const rect=(node:any)=>({x:finite(node.position?.x,0),y:finite(node.position?.y,0),width:size(node.width,320),height:size(node.height,360)});
function position(target:any,nodes:any[]){
 const source=rect(target),siblings=nodes.filter(node=>node.parentNode===target.parentNode&&node.parentId===target.parentId);
 for(let slot=0;slot<1000;slot++){
  const x=source.x+source.width+64+Math.floor(slot/2)*384,y=source.y+(slot%2)*424;
  if(siblings.every(node=>{const other=rect(node);return !(x<other.x+other.width+32&&x+352>other.x&&y<other.y+other.height+32&&y+392>other.y);} ))return{x,y};
 }
 return{x:Math.max(source.x+source.width,...siblings.map(node=>{const other=rect(node);return other.x+other.width;}))+64,y:source.y};
}
const sameOrigin=(a:any,b:any)=>a?.taskId===b.taskId&&a?.executionId===b.executionId&&a?.sourceNodeId===b.sourceNodeId&&a?.outputId===b.outputId;
export function localImageBatch(projectId:string,taskId:string,plan:any,target:any,nodes:any[],projected:ReadonlySet<string>){
 if(target.type!=='rh-image'||!imageBatchPlan(plan)||!['SUCCESS','FAILED','CANCELLED'].includes(plan.status)||!plan.outputs?.length)return undefined;
 const executionId=plan.executionId||plan.taskPlanId,outputs=plan.outputs;
 if(!taskId||!executionId||outputs.length>(comfyBatch(plan)?8:4)||plan.historyDeletedAt||outputs.some((output:any)=>!output.outputId||!output.assetId||!output.url||!String(output.mimeType||output.outputType).startsWith('image/')||output.deletedAt)||new Set(outputs.map((output:any)=>output.outputId)).size!==outputs.length)throw new ApiError(502,'INVALID_OUTPUT','图片批次缺少可验证的素材或结果标识。');
 const marker=target.data?.historyStorage?.imageBatchProjection,prior=marker?.taskId===taskId&&marker?.executionId===executionId&&Array.isArray(marker.outputIds)?new Set<string>(marker.outputIds):new Set<string>(),origin=(index:number)=>({taskId,executionId,sourceNodeId:target.id,outputId:outputs[index].outputId,index,count:outputs.length}),key=(id:string)=>JSON.stringify([projectId,taskId,executionId,id]),native=outputs.map((output:any)=>({...output,historyOutputId:output.outputId})),created:any[]=[],keys:string[]=[],patch:Record<string,any>={};
 const complete=plan.status==='SUCCESS',start=complete?1:0,first=outputs[0];
 if(complete&&!projected.has(key(first.outputId))&&!prior.has(first.outputId))Object.assign(patch,{output:[native[0]],selectedHistoryBatchId:executionId,selectedHistoryOutputId:first.outputId,selectedOutputHistoryId:'',selectedOutputHistoryIndex:0,imageUrl:first.url,sourceObjects:[first.url],assetIds:[first.assetId],assetId:'',batchOrigin:origin(0)});
 const title=String(target.data?.title||target.data?.label||'图片');
 for(let index=start;index<outputs.length;index++){
  const output=outputs[index],id=imageBatchNodeId(taskId,executionId,output.outputId),batchOrigin=origin(index),existing=nodes.find(node=>node.id===id);
  keys.push(key(output.outputId));
  if(projected.has(key(output.outputId))||prior.has(output.outputId))continue;
  if(existing){if(sameOrigin(existing.data?.batchOrigin??existing.data?.historyStorage?.imageBatchOrigin,batchOrigin))continue;throw new ApiError(409,'RESULT_NODE_CONFLICT','生成结果节点与现有节点冲突，结果已保留在任务中。');}
  const node:any={id,type:'rh-image',position:position(target,[...nodes,...created]),data:{title:title+' · '+(index+1),status:'finished',isUpload:true,output:[native[index]],sourceObjects:[output.url],imageUrl:output.url,assetIds:[output.assetId],generateNum:1,params:{},testMode:!!output.testMode,batchOrigin,historyStorage:{imageBatchOrigin:batchOrigin}}};
  for(const field of ['parentNode','parentId'])if(typeof target[field]==='string'&&target[field])node[field]=target[field];
  created.push(node);
 }
 if(nodes.length+created.length>500)throw new ApiError(409,'RESULT_NODE_LIMIT','画布节点已达到上限，生成结果已保留在任务中。');
 keys.push(key(first.outputId));
 const metadata={imageBatchProjection:{taskId,executionId,outputIds:[...new Set([...prior,...outputs.map((output:any)=>output.outputId)])]},...(complete?{imageBatchOrigin:origin(0)}:{})};
 return{patch,nodes:created,keys,metadata};
}
