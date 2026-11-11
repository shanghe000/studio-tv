import {ApiError} from '../api/client';
import type {GraphEdge,GraphNode,ProjectGraph,Snapshot} from '../api/types';
import {randomUuid} from '../browser-compat';
import {outboxInputProof} from './canvas-outbox-proof';
import {META_NODE,META_TYPE} from './graph';

export interface CanvasFieldSet {path:string[];value:any}
export type CanvasOperation=
 |{type:'node.create';node:GraphNode}
 |{type:'node.patch';nodeId:string;set:CanvasFieldSet[];unset:string[][]}
 |{type:'node.delete';nodeId:string}
 |{type:'edge.create';edge:GraphEdge}
 |{type:'edge.delete';edgeId:string}
 |{type:'nodes.order';nodeIds:string[]}
 |{type:'edges.order';edgeIds:string[]}
 |{type:'graph.patch';set:CanvasFieldSet[];unset:string[][]};
export interface CanvasOperationBatch {observedRevision?:number;schemaVersion:'1';batchId:string;clientId:string;operations:CanvasOperation[]}
export type CanvasCanonicalSnapshot=Pick<Snapshot,'projectId'|'revision'|'graph'>;
export interface CanvasOperationJournal {claimRecoverable?:()=>Promise<void>;releaseRecovered?:()=>void;dispose?:()=>void;readonly length:number;key:(index:number)=>string|null;getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void;removeItem:(key:string)=>void}
export interface CanvasOperationSessionOptions {userId:string;projectId:string;clientId:string;permitsObservedRevision?:()=>boolean|undefined;storage?:CanvasOperationJournal;createBatchId?:()=>string;now?:()=>number}
interface OutboxRecord {deferredObservedRevision?:number;observedRevision?:number;beforeProof?:string;format:'OPERATION_OUTBOX';schemaVersion:'1';userId:string;projectId:string;batchId:string;createdAt:number;order:number;operations:CanvasOperation[]}
export const MAX_CANVAS_OPERATIONS=2048;
export const MAX_CANVAS_OPERATION_BYTES=2*1024*1024;
const unsafe=new Set(['__proto__','prototype','constructor']);
const plain=(value:any):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:any,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const equal=(a:any,b:any):boolean=>a===b||Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>equal(value,b[index]))||plain(a)&&plain(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
const invalid=()=>new ApiError(422,'CANVAS_OPERATION_INVALID','画布操作尚未确认，当前修改已保留。');
const limited=()=>new ApiError(422,'CANVAS_OPERATION_LIMIT','本次修改较多，请稍候再同步。当前内容已保留。');
function json(value:any,depth=0):boolean {
 if(depth>80)return false;if(value===null||typeof value==='string'||typeof value==='boolean')return true;if(typeof value==='number')return Number.isFinite(value);
 if(Array.isArray(value))return value.every(item=>json(item,depth+1));return plain(value)&&Object.keys(value).every(key=>!unsafe.has(key)&&json(value[key],depth+1));
}
const path=(value:any,kind:'node'|'graph')=>Array.isArray(value)&&value.length>=1&&value.length<=32&&value.every(part=>typeof part==='string'&&part.length>0&&part.length<=200&&!unsafe.has(part))&&(kind==='graph'?value[0]==='viewport':['data','position','type'].includes(value[0]));
function patches(value:any,kind:'node'|'graph'){
 return Array.isArray(value.set)&&Array.isArray(value.unset)&&value.set.length+value.unset.length<=2048&&value.set.every((entry:any)=>plain(entry)&&path(entry.path,kind)&&Object.hasOwn(entry,'value')&&json(entry.value))&&value.unset.every((entry:any)=>path(entry,kind));
}
function node(value:any):value is GraphNode{return plain(value)&&id(value.id)&&typeof value.type==='string'&&!!value.type&&plain(value.position)&&Number.isFinite(value.position.x)&&Number.isFinite(value.position.y)&&plain(value.data)&&json(value);}
function edge(value:any):value is GraphEdge{return plain(value)&&id(value.id)&&id(value.source)&&id(value.target)&&(value.sourceHandle===null||typeof value.sourceHandle==='string')&&(value.targetHandle===null||typeof value.targetHandle==='string')&&json(value);}
export {node as validCanvasNode,edge as validCanvasEdge};
function graph(value:any):value is ProjectGraph {
 return value?.schemaVersion==='1'&&Array.isArray(value.nodes)&&Array.isArray(value.edges)&&value.nodes.every(node)&&value.edges.every(edge)&&new Set(value.nodes.map((row:any)=>row.id)).size===value.nodes.length&&new Set(value.edges.map((row:any)=>row.id)).size===value.edges.length&&plain(value.viewport)&&[value.viewport.x,value.viewport.y,value.viewport.zoom].every(Number.isFinite)&&value.viewport.zoom>0;
}
export function validateCanvasOperations(operations:unknown):asserts operations is CanvasOperation[]{
 if(!Array.isArray(operations)||operations.length>MAX_CANVAS_OPERATIONS)throw limited();
 for(const op of operations){
  if(!plain(op))throw invalid();let valid=false;
  switch(op.type){
   case'node.create':valid=node(op.node);break;
   case'node.patch':valid=id(op.nodeId)&&patches(op,'node');break;
   case'node.delete':valid=id(op.nodeId);break;
   case'edge.create':valid=edge(op.edge);break;
   case'edge.delete':valid=id(op.edgeId);break;
   case'nodes.order':valid=Array.isArray(op.nodeIds)&&op.nodeIds.length<=10000&&op.nodeIds.every((value:any)=>id(value))&&new Set(op.nodeIds).size===op.nodeIds.length;break;
   case'edges.order':valid=Array.isArray(op.edgeIds)&&op.edgeIds.length<=10000&&op.edgeIds.every((value:any)=>id(value))&&new Set(op.edgeIds).size===op.edgeIds.length;break;
   case'graph.patch':valid=patches(op,'graph');break;
  }
  if(!valid||!json(op))throw invalid();
 }
 if(new TextEncoder().encode(JSON.stringify(operations)).length>MAX_CANVAS_OPERATION_BYTES-256)throw limited();
}
function fields(before:any,after:any,location:string[],set:CanvasFieldSet[],unset:string[][]){
 if(equal(before,after))return;
 // Native controls omit frozen request metadata. Introducing its replacement
 // must not merge a previous model's unseen parameters into the new receipt.
 const receipt=location.length===2&&location[0]==='data'&&['routerParameters','userPromptSnapshot','promptSelection'].includes(location[1]);
 if(!receipt&&plain(after)&&(plain(before)||before===undefined)){
  if(!Object.keys(after).length&&before===undefined){set.push({path:location,value:{}});return;}
  const prior=plain(before)?before:{};
  for(const key of new Set([...Object.keys(prior),...Object.keys(after)])){
   if(!Object.hasOwn(after,key))unset.push([...location,key]);else fields(prior[key],after[key],[...location,key],set,unset);
  }
 }else set.push({path:location,value:structuredClone(after)});
}
/** Diff only the actual previous and next native observations after encodeGraph.
 * Arrays are authored values, never concatenated or three-way merged. */
export function diffCanvasOperations(previous:ProjectGraph,next:ProjectGraph):CanvasOperation[]{
 if(!graph(previous)||!graph(next))throw invalid();
 const operations:CanvasOperation[]=[],priorNodes=new Map(previous.nodes.map(row=>[row.id,row])),nextNodes=new Map(next.nodes.map(row=>[row.id,row])),priorEdges=new Map(previous.edges.map(row=>[row.id,row])),nextEdges=new Map(next.edges.map(row=>[row.id,row]));
 for(const row of previous.edges)if(!nextEdges.has(row.id)||!equal(row,nextEdges.get(row.id)))operations.push({type:'edge.delete',edgeId:row.id});
 for(const row of previous.nodes)if(!nextNodes.has(row.id))operations.push({type:'node.delete',nodeId:row.id});
 for(const row of next.nodes){
  const before=priorNodes.get(row.id);if(!before){operations.push({type:'node.create',node:structuredClone(row)});continue;}
  const set:CanvasFieldSet[]=[],unset:string[][]=[];for(const key of ['type','position','data']as const)fields(before[key],row[key],[key],set,unset);if(set.length||unset.length)operations.push({type:'node.patch',nodeId:row.id,set,unset});
 }
 for(const row of next.edges)if(!priorEdges.has(row.id)||!equal(priorEdges.get(row.id),row))operations.push({type:'edge.create',edge:structuredClone(row)});
 const nodeIds=next.nodes.map(row=>row.id),edgeIds=next.edges.map(row=>row.id);
 const appendNodes=[...previous.nodes.filter(row=>nextNodes.has(row.id)),...next.nodes.filter(row=>!priorNodes.has(row.id))].map(row=>row.id);
 const appendEdges=[...previous.edges.filter(row=>nextEdges.has(row.id)&&equal(row,nextEdges.get(row.id))),...next.edges.filter(row=>!priorEdges.has(row.id)||!equal(priorEdges.get(row.id),row))].map(row=>row.id);
 if(!equal(nodeIds,appendNodes))operations.push({type:'nodes.order',nodeIds});if(!equal(edgeIds,appendEdges))operations.push({type:'edges.order',edgeIds});
 const set:CanvasFieldSet[]=[],unset:string[][]=[];fields(previous.viewport,next.viewport,['viewport'],set,unset);if(set.length||unset.length)operations.push({type:'graph.patch',set,unset});
 validateCanvasOperations(operations);return operations;
}
function assign(target:any,location:string[],value:any,remove=false){
 let current=target;for(const part of location.slice(0,-1)){if(!plain(current[part])){if(remove)return;current[part]={};}current=current[part];}
 if(remove)delete current[location.at(-1)!];else current[location.at(-1)!]=structuredClone(value);
}
function patch(target:any,value:{set:CanvasFieldSet[];unset:string[][]}){for(const location of value.unset)assign(target,location,undefined,true);for(const entry of value.set)assign(target,entry.path,entry.value);}
function order<T extends {id:string}>(rows:T[],ids:string[]):T[]{const map=new Map(rows.map(row=>[row.id,row])),listed=new Set(ids);return[...ids.flatMap(id=>map.has(id)?[map.get(id)!]:[]),...rows.filter(row=>!listed.has(row.id))];}
/** Optimistic projection preserves canonical-only rows. A missing patched row
 * is not resurrected, and an already-created ID is not overwritten. Server
 * admission remains authoritative for those races and atomic batch validity. */
export function applyCanvasOperations(canonical:ProjectGraph,operations:readonly CanvasOperation[]):ProjectGraph {
 if(!graph(canonical))throw invalid();validateCanvasOperations(operations);const result=structuredClone(canonical);
 for(const op of operations){switch(op.type){
  case'node.create':if(!result.nodes.some(row=>row.id===op.node.id))result.nodes.push(structuredClone(op.node));break;
  case'node.patch':{const row=result.nodes.find(row=>row.id===op.nodeId);if(row)patch(row,op);break;}
  case'node.delete':result.nodes=result.nodes.filter(row=>row.id!==op.nodeId);result.edges=result.edges.filter(row=>row.source!==op.nodeId&&row.target!==op.nodeId);break;
  case'edge.create':if(!result.edges.some(row=>row.id===op.edge.id)&&result.nodes.some(row=>row.id===op.edge.source)&&result.nodes.some(row=>row.id===op.edge.target))result.edges.push(structuredClone(op.edge));break;
  case'edge.delete':result.edges=result.edges.filter(row=>row.id!==op.edgeId);break;
  case'nodes.order':result.nodes=order(result.nodes,op.nodeIds);break;
  case'edges.order':result.edges=order(result.edges,op.edgeIds);break;
  case'graph.patch':patch(result,op);break;
 }}return result;
}

/** Immutable per-batch records cannot overwrite another page's queued edits.
 * The journal contains operations only; canonical content comes from the
 * authenticated server. Transport owns retries, admission and receipt proof. */
export class CanvasOperationSession {
 private canonical?:CanvasCanonicalSnapshot;
 private observation?:ProjectGraph;
 // A worker/save receipt can advance the canonical graph while a native drag
 // or IME edit defers its paint. A new edit sees only the applied revision.
 private appliedRevision=1;
 private rows:OutboxRecord[]=[];
 private _generation=0;
 private _storageError:string|undefined;
 private readonly prefix:string;
 constructor(private readonly options:CanvasOperationSessionOptions){
  if(!id(options.userId,64)||!id(options.projectId,64)||!id(options.clientId,64))throw invalid();
  this.prefix='studiotv:canvas-operations:1:'+options.userId+':'+options.projectId+':';this.load();
 }
 prepareRecovery(){return this.options.storage?.claimRecoverable?.();}
 releaseRecovered(){if(!this.hasPending())this.options.storage?.releaseRecovered?.();}
 dispose(){this.options.storage?.dispose?.();}
 get generation(){return this._generation;}
 get pendingCount(){return this.rows.length;}
 get storageError(){return this._storageError;}
 get revision(){return this.canonical?.revision??0;}
 hasPending(){return this.rows.length>0;}
 private failed(){this._storageError='当前修改暂未完整记录在设备上，请保持此页面打开。';}
 // A different page may have acknowledged some rows or added edits after this
 // tab opened. Keep memory-only rows until a real receipt or quarantine.
 private retainedKey(batchId:string){return 'studiotv:retained-operations:'+this.options.userId+':'+this.options.projectId+':'+batchId;}
 refreshOutbox(){
  this.load();
  const storage=this.options.storage;
  if(!storage)return;
  // A previous holder can still have an archived row in memory. Even when
  // later edits restore its original inputs, it must never be replayed.
  try{
   for(const row of [...this.rows])if(storage.getItem(this.retainedKey(row.batchId))===JSON.stringify(row))this.removeAcknowledged(row.batchId);
  }catch{this.failed();}
 }
 recoveryOptions(){
  const row=this.rows[0];
  if(!row||!this.canonical)return {};
  if(!row.beforeProof||outboxInputProof(this.canonical.graph,row.operations)!==row.beforeProof)return {receiptOnly:true};
  return {baseRevision:this.revision};
 }
 preserveHead(batchId:string){
  const row=this.rows[0],storage=this.options.storage;
  if(!row||row.batchId!==batchId||!storage)throw new ApiError(409,'CANVAS_RECOVERY_UNAVAILABLE','请保留此页面，待本机存储可用后再试。');
  // Archive before removing. On failure the original immutable record survives.
  storage.setItem(this.retainedKey(batchId),JSON.stringify(row));
  this.removeAcknowledged(batchId);
 }
 private load(){
  const storage=this.options.storage;if(!storage)return;
  try{
   for(let index=0;index<storage.length;index++){
    const key=storage.key(index);if(!key?.startsWith(this.prefix))continue;
    try{
     const text=storage.getItem(key);if(!text||text.length>MAX_CANVAS_OPERATION_BYTES+2048)throw invalid();const row=JSON.parse(text) as OutboxRecord;
     if(row.deferredObservedRevision!==undefined&&(!Number.isSafeInteger(row.deferredObservedRevision)||row.deferredObservedRevision<1||row.observedRevision!==undefined))throw invalid();
     if(row.format!=='OPERATION_OUTBOX'||row.schemaVersion!=='1'||row.userId!==this.options.userId||row.projectId!==this.options.projectId||!id(row.batchId,64)||key!==this.prefix+row.batchId||row.observedRevision!==undefined&&(!Number.isSafeInteger(row.observedRevision)||row.observedRevision<1)||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!Number.isSafeInteger(row.order)||row.order<0)throw invalid();validateCanvasOperations(row.operations);if(!row.operations.length)throw invalid();
     if(!this.rows.some(known=>known.batchId===row.batchId))this.rows.push(structuredClone(row));
    }catch{this.failed();}
   }
   this.rows.sort((a,b)=>a.createdAt-b.createdAt||a.order-b.order||a.batchId.localeCompare(b.batchId));
  }catch{this.failed();}
 }
 private wire(row:OutboxRecord):CanvasOperationBatch{return{...(row.observedRevision===undefined?{}:{observedRevision:row.observedRevision}),schemaVersion:'1',batchId:row.batchId,clientId:this.options.clientId,operations:structuredClone(row.operations)};}
 pending():readonly CanvasOperationBatch[]{return this.rows.map(row=>this.wire(row));}
 head():CanvasOperationBatch|undefined{return this.rows[0]&&this.wire(this.rows[0]);}
 // An edit seen before admission has never been transmitted. Freeze its
 // negotiated payload before the first request, including across a reload.
 headForTransport(modern:boolean){
  const row=this.rows[0];if(!row)return;
  if(row.deferredObservedRevision!==undefined){
   const pinned={...row};if(modern)pinned.observedRevision=row.deferredObservedRevision;delete pinned.deferredObservedRevision;
   try{this.options.storage?.setItem(this.prefix+row.batchId,JSON.stringify(pinned));}catch{this.failed();throw new ApiError(503,'CANVAS_OUTBOX_UNAVAILABLE','当前修改暂存于本页，设备存储恢复后会继续保存。');}
   this.rows[0]=pinned;
  }
  return this.head();
 }
 status(){return{generation:this.generation,pendingCount:this.pendingCount,storageError:this.storageError,revision:this.revision};}
 acceptSnapshot(snapshot:CanvasCanonicalSnapshot,ackBatchId?:string){
  if(snapshot.projectId!==this.options.projectId||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1||!graph(snapshot.graph))throw invalid();
  if(!this.canonical||snapshot.revision>this.canonical.revision){this.canonical=structuredClone(snapshot);this._generation++;}
  else if(snapshot.revision===this.canonical.revision&&!equal(snapshot.graph,this.canonical.graph))throw new ApiError(502,'CANVAS_SNAPSHOT_MISMATCH','画布同步内容尚未确认，请重试同步。');
  if(ackBatchId)this.removeAcknowledged(ackBatchId);
  if(!this.observation)this.observation=this.projected();
 }
 acknowledge(batchId:string,snapshot:CanvasCanonicalSnapshot){if(!id(batchId,64))throw invalid();this.acceptSnapshot(snapshot,batchId);}
 private removeAcknowledged(batchId:string){
  const index=this.rows.findIndex(row=>row.batchId===batchId);if(index<0)return;this.rows.splice(index,1);this._generation++;
  try{
   this.options.storage?.removeItem(this.prefix+batchId);
   // A transient quota failure must not permanently block later generation
   // after the server confirmed every in-memory edit. Recheck the journal so
   // an unreadable or still-retained record keeps its warning and bytes.
   if(this._storageError&&!this.rows.length){this._storageError=undefined;this.load();}
  }catch{this.failed();}
 }
 reobserve(actual:ProjectGraph,appliedRevision?:number){
  if(!graph(actual))throw invalid();
  if(appliedRevision!==undefined&&Number.isSafeInteger(appliedRevision)&&appliedRevision>=1&&appliedRevision<=this.revision)this.appliedRevision=appliedRevision;
  this.observation=structuredClone(actual);
 }
 observe(actual:ProjectGraph):CanvasOperationBatch|undefined {
  if(!this.canonical||!this.observation)throw new ApiError(409,'CANVAS_NOT_READY','画布还在加载，请稍后继续编辑。');
  let baseline=this.observation;
  const synthesized=actual.nodes.some(row=>row.id===META_NODE&&row.type===META_TYPE&&row.data.version==='1');
  // encodeGraph adds native metadata even for a newly created empty canvas.
  // Seeing that generated row in the view does not prove the server stored it.
  // Only this reserved row is repaired: real remotely deleted nodes must never
  // be recreated. Existing unknown-outcome batches remain byte-for-byte intact.
  const retainedMetadataPatch=this.rows.some(row=>row.operations.some(operation=>operation.type==='node.patch'&&operation.nodeId===META_NODE));
  if(synthesized&&!retainedMetadataPatch){
   // Metadata presence depends only on create/delete of its reserved ID.
   // Building a detached projection of every asset for this one bit makes
   // repeated native observations disproportionately expensive on large docs.
   let present=this.canonical.graph.nodes.some(row=>row.id===META_NODE);
   for(const record of this.rows)for(const op of record.operations){
    if(op.type==='node.create'&&op.node.id===META_NODE)present=true;
    if(op.type==='node.delete'&&op.nodeId===META_NODE)present=false;
   }
   if(!present)baseline={...baseline,nodes:baseline.nodes.filter(row=>row.id!==META_NODE)};
  }
  // The prior observation was validated and is detached from the caller.
  if(equal(baseline,actual))return;
  const operations=diffCanvasOperations(baseline,actual);if(!operations.length){this.observation=structuredClone(actual);return;}
  const batchId=(this.options.createBatchId??randomUuid)();if(!id(batchId,64)||this.rows.some(row=>row.batchId===batchId))throw invalid();
  const clock=(this.options.now??Date.now)();if(!Number.isSafeInteger(clock)||clock<0)throw invalid();
  // Date.now can move backwards after sleep or clock correction. A retained
  // batch must never sort ahead of the edit it was authored after on reload.
  const createdAt=this.rows.reduce((latest,row)=>Math.max(latest,row.createdAt),clock);
  // The negotiated payload is part of the server receipt hash. Never change
  // its shape when retrying across a deployment or recovering on another page.
  const supported=this.options.permitsObservedRevision?this.options.permitsObservedRevision():true;
  const observedRevision=supported===true?this.appliedRevision:undefined;
  const deferredObservedRevision=supported===undefined?this.appliedRevision:undefined;
  const row:OutboxRecord={observedRevision,deferredObservedRevision,beforeProof:outboxInputProof(baseline,operations),format:'OPERATION_OUTBOX',schemaVersion:'1',userId:this.options.userId,projectId:this.options.projectId,batchId,createdAt,order:Math.max(0,...this.rows.map(row=>row.order))+1,operations};
  this.rows.push(row);this.observation=structuredClone(actual);this._generation++;
  try{const storage=this.options.storage;if(storage){const key=this.prefix+batchId;if(storage.getItem(key)!==null)throw invalid();storage.setItem(key,JSON.stringify(row));}}catch{this.failed();}
  return this.wire(row);
 }
 projected():ProjectGraph {
  if(!this.canonical)throw new ApiError(409,'CANVAS_NOT_READY','画布还在加载，请稍后继续编辑。');
  return this.rows.reduce((result,row)=>applyCanvasOperations(result,row.operations),structuredClone(this.canonical.graph));
 }
}
