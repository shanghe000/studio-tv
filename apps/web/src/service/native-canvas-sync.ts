import {ApiError} from '../api/client';
import {equalDraftValue} from './canvas-draft';
import type {NativeGraph} from './graph';
import {withLocalRegionTransients} from './native-region-transient';

/** The immutable manager observes origins other than its local/maintenance
 * symbols. This origin refreshes the existing view and is not tracked by undo. */
export const REMOTE_CANVAS_ORIGIN=Object.freeze({kind:'STUDIO_REMOTE_CANVAS'});
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const map=(value:any)=>value&&typeof value.get==='function'&&typeof value.set==='function'&&typeof value.keys==='function'&&typeof value.delete==='function';
const array=(value:any)=>value&&typeof value.get==='function'&&typeof value.insert==='function'&&typeof value.delete==='function'&&typeof value.toArray==='function';

/** Uses the inspected WCn Yjs seam, never connectLocalFixture, React setNodes,
 * or a manager replacement. UI selection, camera and editor instances are left
 * to the native remote reconciliation. Input/drag sessions defer the batch. */
export function nativeCanvasSyncPort(manager:any,documentSource:any=globalThis.document){
 const available=()=>manager?.localOnly===true&&typeof manager.ydoc?.transact==='function'&&map(manager.ymap)&&array(manager.ynodes)&&array(manager.yedges)&&typeof manager.shouldSkipRemoteRefresh==='function';
 const ready=(target?:NativeGraph)=>{
  const active=documentSource?.activeElement;
  if(active&&(active.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName||''))){
   // Leave the focused node, its map identity/order and incident connections
   // untouched. Unrelated collaborator edits need not wait for a global blur.
   const host=active.closest?.('.react-flow__node[data-id],[data-target-node-id]'),id=host?.getAttribute('data-id')??host?.getAttribute('data-target-node-id');
   if(!target||!id)return false;
   const current=manager.ynodes.toArray().map(json),before=current.findIndex((node:any)=>node?.id===id),after=target.nodes.findIndex(node=>node.id===id);
   const incident=(edges:any[])=>edges.filter(edge=>edge.source===id||edge.target===id);
   if(before<0||before!==after||!equalDraftValue(current.slice(0,before+1).map((node:any)=>node.id),target.nodes.slice(0,after+1).map(node=>node.id))||!equalDraftValue(current[before],target.nodes[after])||!equalDraftValue(incident(manager.yedges.toArray().map(json)),incident(target.edges)))return false;
  }
  if(documentSource?.querySelector?.('.react-flow__node.dragging, .react-flow__selection'))return false;
  return !manager.shouldSkipRemoteRefresh()&&!manager.isWriteBlocked?.();
 };
 const json=(value:any)=>typeof value?.toJSON==='function'?value.toJSON():value;
 const convert=(value:any):any=>{
  if(Array.isArray(value)){const row=new manager.ynodes.constructor();row.push(value.map(convert));return row;}
  if(object(value)){const row=new manager.ymap.constructor();for(const [key,item]of Object.entries(value))if(item!==undefined)row.set(key,convert(item));return row;}
  return value;
 };
 const patch=(row:any,target:Record<string,any>)=>{
  for(const key of [...row.keys()])if(!Object.hasOwn(target,key))row.delete(key);
  for(const [key,value]of Object.entries(target)){
   if(value===undefined)continue;
   const current=row.get(key);if(equalDraftValue(json(current),value))continue;
   if(map(current)&&object(value))patch(current,value);
   else if(array(current)&&Array.isArray(value)){if(current.length)current.delete(0,current.length);if(value.length)current.push(value.map(convert));}
   else row.set(key,convert(value));
  }
 };
 const rowId=(row:any)=>map(row)?row.get('id'):json(row)?.id;
 const reconcile=(rows:any,target:any[])=>{
  const ids=new Set(target.map(row=>row.id));
  for(let index=rows.length-1;index>=0;index--)if(!ids.has(rowId(rows.get(index))))rows.delete(index,1);
  for(let index=0;index<target.length;index++){
   const desired=target[index];let row=rows.get(index);
   if(rowId(row)!==desired.id){
    const old=rows.toArray().findIndex((value:any,i:number)=>i>index&&rowId(value)===desired.id);
    // Integrated Yjs types cannot be reinserted. Only a moved/new row gets a
    // new type; untouched node/data maps retain their identity.
    if(old>=0)rows.delete(old,1);
    rows.insert(index,[convert(desired)]);row=rows.get(index);
   }
   if(!map(row))throw new ApiError(409,'NATIVE_SYNC_UNAVAILABLE','当前原生画布不支持安全增量同步。');
   patch(row,desired);
  }
 };
 return{
  available,ready,
  apply(graph:NativeGraph):boolean {
   if(!available())throw new ApiError(501,'NATIVE_SYNC_UNAVAILABLE','当前原生画布不支持安全增量同步，请重新打开作品。');
   if(!ready(graph))return false;
   // Validate all existing rows before starting a non-rollbackable Yjs batch.
   if([...manager.ynodes.toArray(),...manager.yedges.toArray()].some(row=>!map(row)))throw new ApiError(409,'NATIVE_SYNC_UNAVAILABLE','当前原生画布结构不支持安全同步。');
   // Native point recognition waits on its local hidden node. A remote save
   // has no ownership of that tab-local task or its eventual native cleanup.
   const target=withLocalRegionTransients(graph,{nodes:manager.ynodes.toArray().map(json),edges:manager.yedges.toArray().map(json)});
   manager.ydoc.transact(()=>{
    const ids=new Set(target.nodes.map(node=>node.id));
    reconcile(manager.yedges,target.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)));
    reconcile(manager.ynodes,target.nodes);
    for(const key of ['id','name','description']){
     const value=graph.meta?.[key];if(value!==undefined&&!equalDraftValue(manager.ymap.get(key),value))manager.ymap.set(key,value);
    }
   },REMOTE_CANVAS_ORIGIN);
   return true;
  },
 };
}
