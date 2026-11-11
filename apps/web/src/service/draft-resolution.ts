import type {NativeGraph} from './graph';
import {equalDraftValue,type DraftConflict} from './canvas-draft';

export type DraftChoice='local'|'server';
export interface DraftConflictDetail extends DraftConflict {localValue:unknown;serverValue:unknown}
const modelKeys=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','params','routerParameters'];
const parts=(path:string)=>path.split('/').slice(1).map(value=>value.replaceAll('~1','/').replaceAll('~0','~'));
const clone=(value:any)=>value===undefined?undefined:structuredClone(value);
const pick=(data:any,keys:string[])=>Object.fromEntries(keys.filter(key=>Object.hasOwn(data??{},key)).map(key=>[key,clone(data[key])]));
export function draftPathValue(graph:NativeGraph,path:string):any {
 if(path==='/')return graph;
 const keys=parts(path);let value:any=graph;
 if(keys[0]==='nodes'||keys[0]==='edges'){
  const kind=keys.shift()! as 'nodes'|'edges',id=keys.shift()!;
  if(id==='order'&&!keys.length)return graph[kind].map(row=>row.id);
  value=graph[kind].find(row=>row.id===id);
 }
 for(const key of keys){if(key==='modelSelection')return pick(value,modelKeys);value=value?.[key];}
 return clone(value);
}
export function draftConflictDetails(conflicts:DraftConflict[],local:NativeGraph,server:NativeGraph):DraftConflictDetail[]{
 return conflicts.map(conflict=>({...conflict,localValue:draftPathValue(local,conflict.path),serverValue:draftPathValue(server,conflict.path)}));
}
export function sameConflictValues(a:DraftConflictDetail[],b:DraftConflictDetail[]){
 return a.length===b.length&&a.every(left=>b.some(right=>left.path===right.path&&left.reason===right.reason&&equalDraftValue(left.localValue,right.localValue)&&equalDraftValue(left.serverValue,right.serverValue)));
}

/** The ordinary three-way merger has already kept all disjoint remote fields.
 * Decisions change only its reported conflict paths, never replace the graph. */
export function resolveDraftGraph(local:NativeGraph,server:NativeGraph,conflicts:DraftConflict[],choices:Record<string,DraftChoice>):NativeGraph {
 if(conflicts.some(conflict=>conflict.reason==='BASE_UNKNOWN')&&choices['/']==='server')return structuredClone(server);
 for(const conflict of conflicts)if(choices[conflict.path]!=='local'&&choices[conflict.path]!=='server')throw new Error('请为每项冲突选择保留本地或服务器内容。');
 const result=structuredClone(local);
 const restoredOnlyForEdges=new Set<string>();
 for(const conflict of conflicts){
  if(choices[conflict.path]!=='server'||conflict.path==='/')continue;
  const keys=parts(conflict.path);
  if(keys[0]==='nodes'||keys[0]==='edges'){
   const kind=keys.shift()! as 'nodes'|'edges',id=keys.shift()!;
   if(id==='order'&&!keys.length){const order=server[kind].map(row=>row.id);result[kind].sort((a,b)=>{const x=order.indexOf(a.id),y=order.indexOf(b.id);return(x<0?Infinity:x)-(y<0?Infinity:y);});continue;}
   const their=server[kind].find(row=>row.id===id);let own=result[kind].find(row=>row.id===id);
   if(!keys.length){
    if(kind==='edges'&&conflict.reason==='DANGLING_REFERENCE'&&!their){const edge=result.edges.find(row=>row.id===id);if(edge)for(const endpoint of [edge.source,edge.target])restoredOnlyForEdges.add(endpoint);}
    result[kind]=result[kind].filter(row=>row.id!==id);if(their)result[kind].push(clone(their));continue;
   }
   if(!own&&their){own=clone(their);result[kind].push(own);}if(!own)continue;
   if(conflict.reason==='MODEL_PARAMETERS'){
    own.data??={};for(const key of modelKeys){if(Object.hasOwn(their?.data??{},key))own.data[key]=clone(their!.data[key]);else delete own.data[key];}continue;
   }
   if(conflict.reason==='GROUP_POSITION'){
    for(const key of ['position','parentId','parentNode']){if(Object.hasOwn(their??{},key))own[key]=clone(their![key]);else delete own[key];}
    own.data??={};if(Object.hasOwn(their?.data??{},'groupId'))own.data.groupId=clone(their!.data.groupId);else delete own.data.groupId;continue;
   }
   let target=own,source=their;for(const key of keys.slice(0,-1)){target[key]??={};target=target[key];source=source?.[key];}
   const last=keys.at(-1)!;if(source&&Object.hasOwn(source,last))target[last]=clone(source[last]);else delete target[last];
  }else{
   let target:any=result,source:any=server;for(const key of keys.slice(0,-1)){target[key]??={};target=target[key];source=source?.[key];}
   const last=keys.at(-1)!;if(source&&Object.hasOwn(source,last))target[last]=clone(source[last]);else delete target[last];
  }
 }
 // An explicit server choice of a deleted node also discards its old local
 // connections. Other dangling choices must preserve their selected endpoint.
 result.nodes=result.nodes.filter(node=>!restoredOnlyForEdges.has(node.id)||server.nodes.some(row=>row.id===node.id)||result.edges.some(edge=>edge.source===node.id||edge.target===node.id)||conflicts.some(conflict=>conflict.path==='/nodes/'+node.id||conflict.path.startsWith('/nodes/'+node.id+'/')));
 const ids=new Set(result.nodes.map(node=>node.id));
 for(const conflict of conflicts)if(conflict.reason==='DANGLING_REFERENCE'&&choices[conflict.path]==='server'){
  const edgeId=parts(conflict.path)[1],edge=result.edges.find(row=>row.id===edgeId);
  if(edge)for(const id of [edge.source,edge.target])if(!ids.has(id)){const node=server.nodes.find(row=>row.id===id);if(node){result.nodes.push(clone(node));ids.add(id);}}
 }
 for(const conflict of conflicts)if(conflict.reason==='DANGLING_REFERENCE'&&choices[conflict.path]==='local'){
  const edge=result.edges.find(row=>row.id===parts(conflict.path)[1]);
  if(edge&&(!ids.has(edge.source)||!ids.has(edge.target)))throw new Error('保留连线需要同时保留对应节点，请调整冲突选择。');
 }
 if(result.edges.some(edge=>!ids.has(edge.source)||!ids.has(edge.target)))throw new Error('此选择会删除本地连线的对应节点，请先移除该连线或选择保留节点。');
 return result;
}
