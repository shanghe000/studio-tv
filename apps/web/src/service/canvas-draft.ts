import type {NativeGraph} from './graph';

export interface DraftConflict {path:string;reason:'FIELD_CHANGED'|'DELETE_EDIT'|'MODEL_PARAMETERS'|'GROUP_POSITION'|'DANGLING_REFERENCE'|'BASE_UNKNOWN'}
export interface DraftMerge {graph:NativeGraph;conflicts:DraftConflict[]}
const missing=Symbol('missing');
const clone=(value:any):any=>value===missing?missing:structuredClone(value);
const object=(value:any):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function equalDraftValue(a:any,b:any):boolean {
 if(a===b)return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,index)=>equalDraftValue(value,b[index]));
 if(object(a)&&object(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equalDraftValue(a[key],b[key]));}
 return false;
}
const at=(value:any,key:string)=>object(value)&&Object.hasOwn(value,key)?value[key]:missing;
const pointer=(value:string)=>value.replaceAll('~','~0').replaceAll('/','~1');
const modelKeys=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion'];
const pick=(value:any,keys:string[])=>Object.fromEntries(keys.filter(key=>object(value)&&Object.hasOwn(value,key)).map(key=>[key,value[key]]));
const parent=(node:any)=>({...pick(node,['parentId','parentNode']),...pick(node?.data,['groupId'])});

/** Apply only the local differences to a server base. Arrays, coordinates and
 * exact model selections are indivisible; conflicting local values are kept
 * for recovery, never silently concatenated or sent as a resolved graph. */
export function mergeCanvasDraft(base:NativeGraph,local:NativeGraph,remote:NativeGraph):DraftMerge {
 const conflicts:DraftConflict[]=[];
 const conflict=(path:string,reason:DraftConflict['reason'])=>{if(!conflicts.some(item=>item.path===path&&item.reason===reason))conflicts.push({path,reason});};
 const merge=(before:any,mine:any,theirs:any,path:string,atomic=false):any=>{
  if(equalDraftValue(mine,before))return clone(theirs);
  if(equalDraftValue(theirs,before)||equalDraftValue(mine,theirs))return clone(mine);
  if(!atomic&&object(before)&&object(mine)&&object(theirs)){
   const result:Record<string,any>={};
   for(const key of new Set([...Object.keys(before),...Object.keys(mine),...Object.keys(theirs)])){
    const value=merge(at(before,key),at(mine,key),at(theirs,key),path+'/'+pointer(key),key==='position'||key==='viewport');
    if(value!==missing)result[key]=value;
   }
   return result;
  }
  conflict(path,mine===missing||theirs===missing?'DELETE_EDIT':'FIELD_CHANGED');return clone(mine);
 };
 const indexed=(rows:any[])=>{const result=new Map<string,any>();for(const row of rows){if(result.has(row.id))throw new Error('画布包含重复 ID。');result.set(row.id,row);}return result;};
 const beforeNodes=indexed(base.nodes),localNodes=indexed(local.nodes),remoteNodes=indexed(remote.nodes);
 const mergeRows=(before:Map<string,any>,mine:Map<string,any>,theirs:Map<string,any>,kind:'nodes'|'edges')=>{
  const rows:any[]=[];
  // Keep the server order and append locally created rows deterministically.
  for(const id of new Set([...theirs.keys(),...mine.keys(),...before.keys()])){
   const b=before.get(id)??missing,l=mine.get(id)??missing,r=theirs.get(id)??missing,path='/'+kind+'/'+pointer(id);
   let value=merge(b,l,r,path);
   if(kind==='nodes'&&b!==missing&&l!==missing&&r!==missing&&value!==missing){
    const bs=pick(b.data,modelKeys),ls=pick(l.data,modelKeys),rs=pick(r.data,modelKeys);
    const parameterKeys=['params','routerParameters'];
    const lm=!equalDraftValue(bs,ls),rm=!equalDraftValue(bs,rs),lp=!equalDraftValue(pick(b.data,parameterKeys),pick(l.data,parameterKeys)),rp=!equalDraftValue(pick(b.data,parameterKeys),pick(r.data,parameterKeys));
    const selection=merge(bs,ls,rs,path+'/data/modelSelection',true);
    value.data=value.data||{};for(const key of modelKeys)delete value.data[key];Object.assign(value.data,selection);
    // Identical resolved selections may converge (e.g. a task adds its frozen
    // version and parameters while the native bridge restores that version).
    // Parameter field conflicts are still handled by the ordinary merge above.
    if(!equalDraftValue(ls,rs)&&(lm&&rp||rm&&lp)){
     conflict(path+'/data/modelSelection','MODEL_PARAMETERS');
     for(const key of modelKeys)delete value.data[key];Object.assign(value.data,clone(ls));
     for(const key of parameterKeys){if(l.data&&Object.hasOwn(l.data,key))value.data[key]=clone(l.data[key]);else delete value.data[key];}
    }
    const bg=parent(b),lg=parent(l),rg=parent(r);
    if(!equalDraftValue(bg,lg)&&!equalDraftValue(b.position,r.position)||!equalDraftValue(bg,rg)&&!equalDraftValue(b.position,l.position)){
     conflict(path+'/position','GROUP_POSITION');value.position=clone(l.position);
     for(const key of ['parentId','parentNode']){if(Object.hasOwn(l,key))value[key]=clone(l[key]);else delete value[key];}
     if(l.data&&Object.hasOwn(l.data,'groupId'))value.data.groupId=clone(l.data.groupId);else delete value.data.groupId;
    }
   }
   if(value!==missing)rows.push(value);
  }
  return rows;
 };
 const nodes=mergeRows(beforeNodes,localNodes,remoteNodes,'nodes');
 const mergedNodes=indexed(nodes);
 const groups=(node:any,rows:Map<string,any>)=>new Set<string>([node?.parentId,node?.parentNode,node?.data?.groupId,...[...rows.values()].filter(group=>group.data?.nodeIds?.includes(node?.id)).map(group=>group.id)].filter(value=>typeof value==='string'));
 for(const [id,b] of beforeNodes){
  const l=localNodes.get(id),r=remoteNodes.get(id);if(!l||!r)continue;
  for(const groupId of new Set([...groups(b,beforeNodes),...groups(l,localNodes),...groups(r,remoteNodes)])){
   const bg=beforeNodes.get(groupId),lg=localNodes.get(groupId),rg=remoteNodes.get(groupId);
   if(!bg)continue;
   const groupChanged=(node:any)=>!node||!equalDraftValue(bg.position,node.position)||!equalDraftValue(bg.data?.nodeIds,node.data?.nodeIds);
   if(!equalDraftValue(b.position,l.position)&&groupChanged(rg)||!equalDraftValue(b.position,r.position)&&groupChanged(lg)){
    conflict('/nodes/'+pointer(id)+'/position','GROUP_POSITION');
    const merged=mergedNodes.get(id);if(merged)merged.position=clone(l.position);
   }
  }
 }
 const edges=mergeRows(indexed(base.edges),indexed(local.edges),indexed(remote.edges),'edges').flatMap(edge=>{
  if(mergedNodes.has(edge.source)&&mergedNodes.has(edge.target))return[edge];
  conflict('/edges/'+pointer(edge.id),'DANGLING_REFERENCE');
  const own=local.edges.find(value=>value.id===edge.id);
  if(!own||!localNodes.has(own.source)||!localNodes.has(own.target))return[];
  for(const id of [own.source,own.target])if(!mergedNodes.has(id)){const node=clone(localNodes.get(id));nodes.push(node);mergedNodes.set(id,node);}
  return[clone(own)];
 });
 const orderRows=(rows:any[],before:any[],mine:any[],theirs:any[],kind:string)=>{
  const existed=new Set(before.map(row=>row.id)),ownIds=new Set(mine.map(row=>row.id)),theirIds=new Set(theirs.map(row=>row.id));
  const changed=(other:any[])=>{const ids=new Set(other.map(row=>row.id));return!equalDraftValue(before.filter(row=>ids.has(row.id)).map(row=>row.id),other.filter(row=>existed.has(row.id)).map(row=>row.id));};
  const ownOrder=changed(mine),theirOrder=changed(theirs);
  if(ownOrder&&theirOrder&&!equalDraftValue(mine.filter(row=>existed.has(row.id)&&theirIds.has(row.id)).map(row=>row.id),theirs.filter(row=>existed.has(row.id)&&ownIds.has(row.id)).map(row=>row.id)))conflict('/'+kind+'/order','FIELD_CHANGED');
  const values=indexed(rows),primary=ownOrder?mine:theirs,secondary=ownOrder?theirs:mine;
  const ids=primary.filter(row=>values.has(row.id)).map(row=>row.id);
  for(let i=0;i<secondary.length;i++){
   const id=secondary[i].id;if(!values.has(id)||ids.includes(id))continue;
   let previous=-1,next=-1;
   for(let j=i-1;j>=0;j--){previous=ids.indexOf(secondary[j].id);if(previous>=0)break;}
   if(previous>=0)ids.splice(previous+1,0,id);
   else{for(let j=i+1;j<secondary.length;j++){next=ids.indexOf(secondary[j].id);if(next>=0)break;}ids.splice(next<0?ids.length:next,0,id);}
  }
  // Conflict recovery can restore a locally edited endpoint deleted remotely.
  for(const row of rows)if(!ids.includes(row.id))ids.push(row.id);
  return ids.map(id=>values.get(id));
 };
 const graph:NativeGraph={nodes:orderRows(nodes,base.nodes,local.nodes,remote.nodes,'nodes'),edges:orderRows(edges,base.edges,local.edges,remote.edges,'edges')};
 for(const key of ['meta','viewport'] as const){const value=merge(at(base,key),at(local,key),at(remote,key),'/'+key,key==='viewport');if(value!==missing)graph[key]=value;}
 return{graph,conflicts};
}
