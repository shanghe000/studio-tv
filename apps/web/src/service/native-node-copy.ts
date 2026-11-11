import {ApiError} from '../api/client';
import type {NativeGraph} from './graph';
import type {NativeModelBindingPort} from './model-bindings';

// Clipboard metadata is public configuration, never execution authority. It
// survives Xie/O2e/iee, and is removed before the Yjs paste transaction.
const sourceKey='__studioCopySource';
const bindingKeys=['capabilityRef','capabilityVersion','parameterSchemaVersion'];
const executionKeys=['taskId','estimateTaskId','executionId','runId','errorMsg','errorMessage','errorCode','progress','progressDetail','startTime','finishTime','finishTimeSec','elapsedTime','queuePosition','generationStartedAt','estimatedSeconds','testMode','nodeOutputHistory','historyStorage','history','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex','batchOrigin','routerParameters','userPromptSnapshot','promptSelection'];
export function nativeCopySource(node:any,projectId:string,graph:NativeGraph,bindings?:NativeModelBindingPort){
 const bound=bindings?.node(node)??node;
 return{...bound,data:{...bound.data,[sourceKey]:{projectId,nodeId:node.id,edges:graph.edges.filter(edge=>edge.target===node.id)}}};
}
function remapOrder(value:any,ids:Map<string,string>):any{
 const key=(value:string)=>{const index=value.indexOf('::'),id=index<0?value:value.slice(0,index);return ids.has(id)?ids.get(id)!+(index<0?'':value.slice(index)):value;};
 if(typeof value==='string')return key(value);
 if(!value||typeof value!=='object')return value;
 return{...value,...(typeof value.nodeId==='string'?{nodeId:ids.get(value.nodeId)??value.nodeId}:{}),...(typeof value._key==='string'?{_key:key(value._key)}:{})};
}
/** Paste keeps inputs and internal links, but never adds a new input to an
 * existing downstream node. Alt-drag, menu Duplicate and clipboard agree. */
export function prepareNativeCopy(nodes:any[],edges:any[],graph:NativeGraph,projectId:string,sources:any[]=[],requiresOrigin=false){
 const origins=nodes.map((node,index)=>node.data?.[sourceKey]??sources[index]?.data?.[sourceKey]);
 if(!origins.some(Boolean)){if(requiresOrigin)throw new ApiError(422,'CLIPBOARD_RECOPY_REQUIRED','剪贴板缺少节点来源信息，请在画布中重新复制节点后粘贴。');return{nodes,edges};}
 if(origins.some(origin=>!origin||typeof origin.nodeId!=='string'))throw new Error('复制内容不完整，请重新复制所选节点。');
 const ids=new Map<string,string>(origins.map((origin,index)=>[origin.nodeId,nodes[index].id]));
 if(ids.size!==nodes.length)throw new Error('复制内容包含重复节点，请重新复制。');
 const known=new Set(graph.nodes.map(node=>node.id)),added=new Set(nodes.map(node=>node.id));
 const copied=nodes.map((node,index)=>{
  const data={...node.data},source=sources[index];
  // Direct menu duplication does not pass through getFullNodesByIds.
  if(source&&source.id===origins[index].nodeId&&source.type===node.type&&source.data?.modelCode===data.modelCode)for(const key of [...bindingKeys,'isUpload'])if(source.data[key]!==undefined)data[key]=source.data[key];
  if(data.modelCode&&data.taskId&&!data.capabilityVersion&&data.isUpload!==true)throw new ApiError(422,'MODEL_VERSION_UNVERIFIED','原节点的模型版本尚未确认，请先在原节点重新选择模型再复制。');
  delete data[sourceKey];for(const key of executionKeys)delete data[key];
  if(data.customBadgeText==='TEST MODE')delete data.customBadgeText;
  if(node.type!=='group'&&node.type!=='rh-comment'&&data.isUpload!==true)data.status='idle';
  // Some completed image views duplicate their displayed result into
  // sourceObjects. Once task/history ownership is cleared, native Jrr treats
  // that duplicate as an uploaded image and hides the generation composer.
  // Retain the output preview, never turn a generated copy into an upload.
  if(node.type==='rh-image'&&data.isUpload!==true&&data.modelCode&&data.capabilityVersion&&Array.isArray(data.output)&&Array.isArray(data.sourceObjects)&&data.sourceObjects.length){
   const url=(value:any)=>typeof value==='string'?value:value?.url??value?.fileUrl??value?.originalUrl;
   const outputs=new Set(data.output.map(url).filter((value:any)=>typeof value==='string'&&value));
   if(outputs.size&&data.sourceObjects.every((value:any)=>outputs.has(url(value))))delete data.sourceObjects;
  }
  for(const key of ['imageOrder','videoOrder','audioOrder'])if(Array.isArray(data[key]))data[key]=data[key].map(value=>remapOrder(value,ids));
  // The visible output remains a reusable preview, without old task/history
  // identity. A new run must create its own receipt and history.
  if(Array.isArray(data.output))data.output=data.output.map((output:any)=>{if(!output||typeof output!=='object')return output;const next={...output};for(const key of ['taskId','executionId','historyOutputId','historyId'])delete next[key];return next;});
  return{...node,data};
 });
 const links=new Map<string,any>();
 const add=(edge:any,remap:boolean)=>{
  const source=remap?(ids.get(edge.source)??edge.source):edge.source,target=remap?(ids.get(edge.target)??edge.target):edge.target;
  if(!added.has(target)||!added.has(source)&&!known.has(source))return;
  const sourceHandle=edge.sourceHandle||'output',targetHandle=edge.targetHandle||'input',id=`e-${source}-${sourceHandle}-${target}-${targetHandle}`;
  links.set(id,{...edge,id,source,target,sourceHandle,targetHandle});
 };
 // Saved source edges also cover native Alt-drag's empty edge list. External
 // endpoints are meaningful only inside the source project.
 for(const origin of origins)for(const edge of origin.edges??[])if(ids.has(edge.source)||origin.projectId===projectId)add(edge,true);
 for(const edge of edges)if(added.has(edge.source)||origins.every(origin=>origin.projectId===projectId))add(edge,false);
 return{nodes:copied,edges:[...links.values()]};
}

/** Intercept the inspected native read/paste seams, without editing the frozen
 * bundle. Configuration is carried in the accepted Yjs transaction, so queued
 * leases, undo/redo and synchronous observers see the same binding. */
export function installNativeNodeCopy(runtime:any,native:any,surface:Window=window){
 let disposed=false,owner:any,release:(()=>void)|undefined,context:any[]=[],clipboard=false;
 const port=()=>runtime.modelBindingPort?.() as NativeModelBindingPort|undefined;
 const attach=()=>{
  const attachment=runtime.canvasAttachment?.(),next=attachment?.client??native.bt?.();if(next===owner)return;
  release?.();owner=next;if(!next||typeof next.getRemoteData!=='function'||typeof next.getFullNodesByIds!=='function')return;
  const remote=next.getRemoteData,full=next.getFullNodesByIds,paste=next.pasteGraph;
  const project=()=>String(runtime.canvasAttachment?.()?.id??runtime.inspect?.().id??'');
  const current=()=>!disposed&&owner===next&&!!project()&&port()?.current()===true;
  const read=function(this:any){const graph=remote.call(this);if(!graph||!current())return graph;const rows=full.call(this,graph.nodes.map((node:any)=>node.id));return{...graph,nodes:graph.nodes.map((node:any)=>{const raw=rows.get(node.id),data={...node.data};if(raw?.type===node.type&&raw.data?.modelCode===data.modelCode)for(const key of bindingKeys)if(raw.data[key]!==undefined)data[key]=raw.data[key];return port()?.node({...node,data})??{...node,data};})};};
  const sourceGraph=()=>{const graph=read.call(next);return graph?(runtime.storage?.copySourceGraph?.(project(),graph)??graph):graph;};
  const readFull=function(this:any,ids:string[]){const rows=full.call(this,ids);if(!current())return rows;const graph=sourceGraph();return graph?new Map([...rows].map(([id,node]:any)=>{const data=graph.nodes.find((n:any)=>n.id===id)?.data??{},copy={...node,data:{...node.data}};for(const key of [...bindingKeys,'isUpload'])if(data[key]!==undefined)copy.data[key]=data[key];return[id,nativeCopySource(copy,project(),graph,port())];})):rows;};
  const copy=function(this:any,nodes:any[],edges:any[],...args:any[]){if(current()){const graph=read.call(this),prepared=prepareNativeCopy(nodes,edges,graph,project(),context,clipboard);nodes.splice(0,nodes.length,...prepared.nodes);edges.splice(0,edges.length,...prepared.edges);}return paste.call(this,nodes,edges,...args);};
  next.getRemoteData=read;next.getFullNodesByIds=readFull;next.pasteGraph=copy;
  release=()=>{if(next.getRemoteData===read)next.getRemoteData=remote;if(next.getFullNodesByIds===readFull)next.getFullNodesByIds=full;if(next.pasteGraph===copy)next.pasteGraph=paste;};
 };
 // The two direct duplicate callbacks bypass the full-node reader. Carry the
 // exact source identity only while their original native action is executing.
 const react=native.r,original=react?.useCallback;
 const callback=typeof original==='function'?function(this:any,fn:Function,deps:any[]){const source=Function.prototype.toString.call(fn);
  const menu=deps?.length===5&&deps[0]?.id&&Array.isArray(deps[1])&&Array.isArray(deps[2])&&source.includes('vZn(');
  const toolbar=deps?.length===4&&typeof deps[3]==='function'&&source.includes('vbt(')&&source.includes('pasteGraph(');
  const paste=deps?.length===3&&source.includes('Gvt(')&&source.includes('iee(')&&source.includes('pasteGraph(');
  if(!menu&&!toolbar&&!paste)return original.call(this,fn,deps);
  return original.call(this,(...args:any[])=>{attach();const previous=context,previousClipboard=clipboard,node=menu?deps[0]:toolbar?args[0]:undefined,graph=owner?.getRemoteData?.(),id=String(runtime.canvasAttachment?.()?.id??runtime.inspect?.().id??'');
   if(node&&graph){const full=owner.getFullNodesByIds([node.id]).get(node.id);context=[full??nativeCopySource(node,id,graph,port())];}clipboard=paste;try{return fn(...args);}finally{context=previous;clipboard=previousClipboard;}
  },deps);
 }:undefined;
 if(callback)react.useCallback=callback;
 surface.addEventListener('rhtv:canvas-attachment',attach);surface.addEventListener('popstate',attach);attach();
 return()=>{disposed=true;release?.();surface.removeEventListener('rhtv:canvas-attachment',attach);surface.removeEventListener('popstate',attach);if(callback&&react.useCallback===callback)react.useCallback=original;};
}
