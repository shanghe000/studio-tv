import {ApiError} from '../api/client';
import type {NativeGraph} from './graph';
import {equalDraftValue} from './canvas-draft';

const invalid=()=>new ApiError(409,'STALE_NATIVE_GROUP_COMMAND','分组成员或连线已变更，请重新打开分组后生成。');
const point=(value:any)=>!!value&&typeof value==='object'&&typeof value.x==='number'&&Number.isFinite(value.x)&&typeof value.y==='number'&&Number.isFinite(value.y);

/** Frozen GE omits member geometry and the group; cHe/Rdt then add ancestors
 * and source/target-only edges. Restore display/membership metadata solely
 * from the caller's synchronous snapshot of this same mounted manager.
 * Native command data, including compiled prompts and model choices, is kept.
 */
export function completeNativeGroupCommand(command:NativeGraph|undefined,mounted:NativeGraph|undefined,targetId:string):NativeGraph|undefined{
 if(!command||!mounted)return command;
 if(!Array.isArray(command.nodes)||!Array.isArray(command.edges)||!Array.isArray(mounted.nodes)||!Array.isArray(mounted.edges))throw invalid();
 if(command.nodes.some(node=>node?.id===targetId)){
  // The owned normal-group toolbar calls generate() with the complete mounted
  // graph instead of GE. Native group membership lives in data, while the
  // execution API selects parentId/parentNode. Project only an exact captured
  // full graph; never infer a group on an independently supplied command.
  const group=mounted.nodes.find(node=>node?.id===targetId);
  if(group?.type!=='group'||group.data?.groupType!=='normal'||group.data?.storyboardEntityGroup===true||!equalDraftValue(command,mounted))return command;
  const current=new Map(mounted.nodes.map(node=>[node.id,node]));if(current.size!==mounted.nodes.length)throw invalid();
  const parents=new Map<string,string>(),visiting=new Set<string>();
  const visit=(node:any)=>{
   if(visiting.has(node.id))throw invalid();visiting.add(node.id);
   const memberIds=node.data?.nodeIds;
   if(!Array.isArray(memberIds)||!memberIds.length||new Set(memberIds).size!==memberIds.length)throw invalid();
   for(const id of memberIds){
    const member=current.get(id);
    if(typeof id!=='string'||!member||member.id===targetId||member.data?.groupId!==node.id||member.parentId!=null&&member.parentId!==node.id||member.parentNode!=null&&member.parentNode!==node.id||parents.has(id))throw invalid();
    parents.set(id,node.id);if(member.type==='group')visit(member);
   }
   for(const member of mounted.nodes)if((member.data?.groupId===node.id||member.parentId===node.id||member.parentNode===node.id)&&!memberIds.includes(member.id))throw invalid();
   visiting.delete(node.id);
  };
  visit(group);
  return{...command,nodes:command.nodes.map(node=>parents.has(node.id)?{...node,parentId:parents.get(node.id)}:node)};
 }
 const group=mounted.nodes.find(node=>node?.id===targetId),data=group?.data;
 if(group?.type!=='group'||!['normal','storyboard'].includes(data?.groupType)||data.storyboardEntityGroup===true||!point(group.position))throw invalid();
 const memberIds=data.nodeIds;
 if(!Array.isArray(memberIds)||!memberIds.length||memberIds.some(id=>typeof id!=='string'||!id)||new Set(memberIds).size!==memberIds.length)throw invalid();
 const current=new Map(mounted.nodes.map(node=>[node.id,node]));
 if(current.size!==mounted.nodes.length)throw invalid();
 // Do not revive a deleted member or import a node from another real group.
 for(const id of memberIds){const node=current.get(id);if(!node||node.type==='group'||node.type==='rh-entity'||node.data?.storyboardEntityNode===true||node.data?.groupId!==targetId||node.parentId!=null&&node.parentId!==targetId||node.parentNode!=null&&node.parentNode!==targetId)throw invalid();}
 const members=new Set(memberIds),ids=new Set<string>(),selected=new Set<string>();
 for(const node of command.nodes){
  const prior=current.get(node?.id);
  if(!node||typeof node.id!=='string'||ids.has(node.id)||!prior||prior.type!==node.type||!point(prior.position))throw invalid();
  ids.add(node.id);
  const member=members.has(node.id);
  if(member){
   if(node.data?.groupId!==targetId||node.parentId!=null&&node.parentId!==targetId||node.parentNode!=null&&node.parentNode!==targetId)throw invalid();
   selected.add(node.id);
  }else if(node.data?.groupId===targetId||node.parentId===targetId||node.parentNode===targetId)throw invalid();
  if(node.position===undefined){if(!member)throw invalid();}
  else if(!point(node.position)||node.position.x!==prior.position.x||node.position.y!==prior.position.y)throw invalid();
 }
 if(!selected.size||!command.nodes.some(node=>selected.has(node.id)&&node.position===undefined))throw invalid();
 const pairs=new Set<string>();
 const edges=command.edges.map(edge=>{
  if(!edge||Object.keys(edge).some(key=>key!=='source'&&key!=='target')||!ids.has(edge.source)||!ids.has(edge.target))throw invalid();
  const pair=JSON.stringify([edge.source,edge.target]);if(pairs.has(pair))throw invalid();pairs.add(pair);
  const matches=mounted.edges.filter(saved=>saved.source===edge.source&&saved.target===edge.target);
  if(matches.length!==1)throw invalid();
  const saved=matches[0];
  if(typeof saved.id!=='string'||!saved.id||saved.conditioningRole!=null||saved.sourceHandle!=null&&saved.sourceHandle!=='output'||saved.targetHandle!=null&&saved.targetHandle!=='input')throw invalid();
  return structuredClone(saved);
 });
 // Native q_ includes each selected node's incoming closure. A changed/deleted
 // edge must not silently turn an image-reference command into another input.
 for(const edge of mounted.edges)if(ids.has(edge.target)&&!pairs.has(JSON.stringify([edge.source,edge.target])))throw invalid();
 const nodes=command.nodes.map(node=>({...node,...(node.position===undefined?{position:structuredClone(current.get(node.id)!.position)}:{}),...(selected.has(node.id)?{parentId:targetId}:{})}));
 nodes.push({...structuredClone(group),data:{...structuredClone(data),nodeIds:[...selected]}});
 return{...command,nodes,edges};
}
