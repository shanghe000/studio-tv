import {ApiError} from '../api/client';
import {CanvasPresenceClient,presencePeople,type CanvasPresenceState,type PresencePoint} from './canvas-presence';
import {canvasProjectFromPath} from './canvas-lifecycle';
import {cleanJson,type NativeGraph} from './graph';
import {equalDraftValue,mergeCanvasDraft} from './canvas-draft';
import {browserDraftJournal,type DraftEnvelope,type DraftJournalRecord} from './draft-journal';

const palette=['#bca2ed','#81b9ee','#e5b681','#8dceb0','#e8a3b8','#b5c97c'];
export function participantColor(id:string){let hash=0;for(const character of id)hash=(hash*31+character.charCodeAt(0))>>>0;return palette[hash%palette.length];}
const editable=(element:Element|null):element is HTMLElement=>!!element&&(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||(element as HTMLElement).isContentEditable||element.hasAttribute('contenteditable'));
const unique=(values:string[])=>[...new Set(values)].filter(Boolean);
function changedNodes(a:NativeGraph,b:NativeGraph){
 const before=new Map(a.nodes.map(node=>[node.id,node])),after=new Map(b.nodes.map(node=>[node.id,node])),changed=new Set<string>();
 for(const id of new Set([...before.keys(),...after.keys()]))if(!equalDraftValue(before.get(id),after.get(id)))changed.add(id);
 if(!equalDraftValue(a.edges,b.edges))for(const edge of [...a.edges,...b.edges])if(!a.edges.some(value=>equalDraftValue(value,edge))||!b.edges.some(value=>equalDraftValue(value,edge))){changed.add(edge.source);changed.add(edge.target);}
 return [...changed];
}
interface BufferedMutation {applied?:boolean;uncertain?:boolean;base?:NativeGraph;local?:NativeGraph;opaque?:boolean;ids:()=>string[];run:(merged:NativeGraph)=>void;project:(graph:NativeGraph)=>NativeGraph;key?:string}
export interface PresenceMutationBuffer {flushPending:()=>Promise<void>;resumeWaiting:()=>Promise<void>|undefined;hasPending:()=>boolean;error:()=>string;suspend:()=>void;reconnect:(client:CanvasPresenceClient)=>void;dispose:()=>void}
/** Guard the inspected WCn enqueue seam before it mutates Yjs. A denied or
 * disconnected write remains a separate recoverable local draft, never a
 * write to the shared graph. Direct native history actions are gated before
 * their history indices advance. */
export function guardNativePresenceMutations(runtime:any,native:any,manager:any,client:CanvasPresenceClient,notice:(text:string)=>void,current:()=>boolean):PresenceMutationBuffer {
 const queued:BufferedMutation[]=[],restorers:(()=>void)[]=[],journal=browserDraftJournal(),journalId='lease-pending-'+client.clientId;
 let draining:Promise<void>|null=null,error='',disposed=false,waitingForLease=false,createdAt=new Date().toISOString(),recorded=false,bufferGeneration=0,recordedGeneration=-1,clientGeneration=0,publishingNode=false;let recordedVersion:DraftJournalRecord|undefined;
 const existing=()=>new Set<string>((runtime.storage.snapshots.get(client.projectId)?.graph?.nodes??[]).map((node:any)=>node.id));
 const clearRecovered=()=>{
  if(!queued.length||!recordedVersion||recordedGeneration!==bufferGeneration)return;
  try{if(!journal?.isResolved(recordedVersion))return;}catch{return;}
  queued.splice(0);error='';waitingForLease=false;recorded=false;recordedVersion=undefined;bufferGeneration++;
  try{journal?.removeOwn(client.userId,client.projectId,journalId);runtime.storage.refreshDraftBackups?.(client.projectId);}catch{}
 };
 const backup=()=>{
  clearRecovered();if(!queued.length){if(recorded){try{journal?.removeOwn(client.userId,client.projectId,journalId);runtime.storage.refreshDraftBackups?.(client.projectId);}catch{}recorded=false;}return;}
  try{
   // The lease journal stores only the delta captured at the moment of the
   // intent. A newer storage snapshot may not yet be mounted in native Yjs;
   // pairing that newer base with the old mounted graph would undo peers.
   const first=queued[0],last=queued[queued.length-1];
   let graph=structuredClone(last.local!) as NativeGraph;
   const unresolved=new Map<string,string>();const encode=(value:string)=>{let mapped:string;try{mapped=runtime.storage.encodeAsset(value);}catch{mapped=value;}if(mapped.startsWith('blob:')||mapped.includes('/__rhtv_media/')){let placeholder=unresolved.get(mapped);if(!placeholder){placeholder='studiotv-unuploaded:lease-'+(unresolved.size+1);unresolved.set(mapped,placeholder);}return placeholder;}return mapped;};
   graph=cleanJson(graph,encode);const base=cleanJson(first.base!,encode),pending=queued.map(item=>({base:cleanJson(item.base!,encode),local:cleanJson(item.local!,encode),initialEtag:'unknown',unknownBase:false}));
   const envelope:DraftEnvelope={format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId:client.userId,projectId:client.projectId,createdAt,updatedAt:new Date().toISOString(),graph,base,pending,...(unresolved.size?{unresolvedMedia:unresolved.size}:{})};
   if(!journal)throw new Error('当前浏览器未提供本机备份。');recordedVersion=journal.write(envelope,journalId);recordedGeneration=bufferGeneration;recorded=true;runtime.storage.refreshDraftBackups?.(client.projectId);
  }catch{error='当前编辑尚未同步，内容已保留。请保持页面打开并重试同步。';}
 };
 const flushPending=():Promise<void>=>{
  clearRecovered();if(draining)return draining;const ownGeneration=clientGeneration,leaseClient=client;
  const pending=(async()=>{while(queued.length){
   if(disposed||ownGeneration!==clientGeneration||!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，当前编辑仍保留。请返回原画布后重试同步。');
   const item=queued[0];let ids=unique(item.ids()).filter(id=>existing().has(id));waitingForLease=false;
   try{for(let attempt=0;attempt<3;attempt++){
    await leaseClient.acquire(ids);const latest=unique(item.ids()).filter(id=>existing().has(id));if(latest.every(id=>ids.includes(id)))break;
    if(attempt===2)throw new ApiError(409,'STALE_CANVAS_SESSION','节点正在同步，当前编辑已保留，请重试同步。');ids=latest;
   }}catch(reason){if(ownGeneration===clientGeneration&&!disposed)waitingForLease=reason instanceof ApiError&&reason.code==='NODE_EDIT_OCCUPIED';throw reason;}clearRecovered();if(queued[0]!==item)continue;
   if(disposed||ownGeneration!==clientGeneration||!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，未应用旧页面的编辑。');
   if(item.uncertain)throw new ApiError(409,'LOCAL_EDIT_RECOVERY_REQUIRED','当前编辑尚未完整同步，内容已保留，请重试同步。');
   if(!item.applied){
    const mounted=structuredClone(manager.getRemoteData()) as NativeGraph,merged=mergeCanvasDraft(item.base!,item.local!,mounted);
    if(merged.conflicts.length||item.opaque&&!equalDraftValue(item.base,mounted))throw new ApiError(409,'LOCAL_DRAFT_CONFLICT','同一节点的内容已更新，当前编辑已保留，请重试同步。');
    try{item.run(merged.graph);item.applied=true;}catch(reason){item.uncertain=true;throw reason;}
   }
   manager.flushOperationQueue?.(true);runtime.storage.captureDraft?.(client.projectId,manager.getRemoteData());
   if(runtime.storage.draftRecoveryState?.(client.projectId)?.persistence==='memory-only')throw new ApiError(409,'LOCAL_DRAFT_BACKUP_UNAVAILABLE','当前编辑尚未同步，请保持页面打开后重试同步。');
   queued.shift();bufferGeneration++;error='';backup();
  }})();
  draining=pending;void pending.finally(()=>{if(draining===pending)draining=null;}).catch(()=>{});return pending;
 };
 const add=(item:BufferedMutation)=>{
  clearRecovered();if(item.key&&queued.some(row=>row.key===item.key))return;
  if(queued.length>=256)throw new ApiError(409,'CANVAS_EDIT_QUEUE_FULL','待处理编辑过多，请先等待节点占用解除并保存。');
  let virtual=structuredClone(manager.getRemoteData()) as NativeGraph;for(const prior of queued)virtual=mergeCanvasDraft(prior.base!,prior.local!,virtual).graph;item.base=virtual;item.local=item.project(structuredClone(virtual));queued.push(item);bufferGeneration++;backup();const ownGeneration=clientGeneration;void flushPending().catch(reason=>{if(ownGeneration!==clientGeneration)return;error=reason instanceof Error?reason.message:'编辑暂未同步，请等待连接恢复后继续。';if(current())notice(error);backup();});
 };
 const wrap=(object:any,name:string,wrapper:(original:Function)=>Function)=>{const original=object?.[name];if(typeof original!=='function')return;const owned=wrapper(original);object[name]=owned;restorers.push(()=>{if(object[name]===owned)object[name]=original;});};
 const virtualGraph=()=>{let graph=manager.getRemoteData() as NativeGraph;if(queued.length)graph=structuredClone(graph);for(const prior of queued)graph=mergeCanvasDraft(prior.base!,prior.local!,graph).graph;return graph;};
 const edgeIds=(graph:NativeGraph,edge:any)=>{
  // The native addEdge transaction replaces a director's prior input. Those
  // removed edges protect their old sources as well as the new endpoints.
  const director=graph.nodes.find(node=>node.id===edge?.target)?.type==='rh-director',removed=graph.edges.filter(value=>value.id===edge?.id||director&&value.target===edge.target&&value.source!==edge.source);
  return unique([edge?.source,edge?.target,...removed.flatMap(value=>[value.source,value.target])].filter(Boolean));
 };
 const idsFor=(op:any,graph:NativeGraph)=>{
  if(op.kind==='removeNode')return unique([op.nodeId,...graph.edges.filter((edge:any)=>edge.source===op.nodeId||edge.target===op.nodeId).flatMap((edge:any)=>[edge.source,edge.target])]);if(op.nodeId)return[op.nodeId];if(op.kind==='moveNodes')return op.moves.map((move:any)=>move.nodeId);if(op.kind==='addEdge')return edgeIds(graph,op.edge);if(op.kind==='removeEdge'){const edge=graph.edges.find((value:any)=>value.id===op.edgeId);return edge?[edge.source,edge.target]:[];}
  if(op.kind==='pasteGraph'&&op.nodes?.length){const added=new Set((op.nodes??[]).map((node:any)=>node.id)),known=new Set(graph.nodes.map(node=>node.id)),edges=new Set(graph.edges.map(edge=>edge.id));return unique((op.edges??[]).filter((edge:any)=>!edges.has(edge.id)&&(known.has(edge.source)||added.has(edge.source))&&(known.has(edge.target)||added.has(edge.target))).flatMap((edge:any)=>[edge.source,edge.target]));}return[];
 };
 const apply=(graph:NativeGraph,op:any):NativeGraph=>{
  if(op.kind==='patchNodeData')return{...graph,nodes:graph.nodes.map(node=>{if(node.id!==op.nodeId)return node;const data={...node.data,...op.patch};if(op.patch.params&&!op.replaceParams)data.params={...node.data?.params,...op.patch.params};return{...node,data};})};
  if(op.kind==='moveNodes')return{...graph,nodes:graph.nodes.map(node=>{const move=op.moves.find((value:any)=>value.nodeId===node.id);return move?{...node,position:move.position}:node;})};
  if(op.kind==='patchNodeMeta')return{...graph,nodes:graph.nodes.map(node=>node.id===op.nodeId?{...node,...op.patch}:node)};
  if(op.kind==='removeNode')return{...graph,nodes:graph.nodes.filter(node=>node.id!==op.nodeId),edges:graph.edges.filter(edge=>edge.source!==op.nodeId&&edge.target!==op.nodeId)};
  if(op.kind==='addEdge'){const director=graph.nodes.find(node=>node.id===op.edge.target)?.type==='rh-director';return{...graph,edges:[...graph.edges.filter(edge=>edge.id!==op.edge.id&&(!director||edge.target!==op.edge.target||edge.source===op.edge.source)),op.edge]};}
  if(op.kind==='removeEdge')return{...graph,edges:graph.edges.filter(edge=>edge.id!==op.edgeId)};
  if(op.kind==='pasteGraph'&&op.nodes?.length){
   // Q1n inserts the new nodes and their connections in one transaction. ID
   // collisions are skipped, rather than overwriting an existing node/edge.
   const nodes=[...graph.nodes],nodeIds=new Set(nodes.map(node=>node.id)),edges=[...graph.edges],edgeIds=new Set(edges.map(edge=>edge.id));for(const node of op.nodes)if(!nodeIds.has(node.id)){nodes.push(node);nodeIds.add(node.id);}for(const edge of op.edges??[])if(!edgeIds.has(edge.id)&&nodeIds.has(edge.source)&&nodeIds.has(edge.target)){edges.push(edge);edgeIds.add(edge.id);}return{...graph,nodes,edges};
  }return graph;
 };
 // Pass the three-way result to shallow native patches as well. Otherwise a
 // full form's unchanged stale params could overwrite a peer's independent
 // parameter even though the merge correctly classified it as untouched.
 const rebase=(operation:any,merged:NativeGraph)=>{
  const op=structuredClone(operation),node=merged.nodes.find(value=>value.id===op.nodeId);
  if(op.kind==='patchNodeData'&&node){for(const key of Object.keys(op.patch))op.patch[key]=structuredClone(node.data?.[key]);if(Object.hasOwn(op.patch,'params'))op.replaceParams=true;}
  if(op.kind==='patchNodeMeta'&&node)for(const key of Object.keys(op.patch))op.patch[key]=structuredClone(node[key]);
  if(op.kind==='moveNodes')op.moves=op.moves.map((move:any)=>({...move,position:merged.nodes.find(value=>value.id===move.nodeId)?.position??move.position}));
  if(op.kind==='addEdge')op.edge=merged.edges.find(value=>value.id===op.edge.id)??op.edge;
  if(op.kind==='pasteGraph'){op.nodes=op.nodes.map((node:any)=>merged.nodes.find(value=>value.id===node.id)??node);op.edges=(op.edges??[]).map((edge:any)=>merged.edges.find(value=>value.id===edge.id)??edge);}
  return op;
 };
 // Native selector creation calls addNode and addEdge in the same stack.
 // Publish the new local node before outer connection validators read Yjs;
 // only the existing endpoints need leases until creation is persisted.
 // This is the native queue flush, without any REST save or synthetic node.
 wrap(manager,'addNode',original=>function(this:any,...args:any[]){
  const result=original.apply(this,args);if(!publishingNode){publishingNode=true;try{manager.flushOperationQueue?.(true);}finally{publishingNode=false;}}return result;
 });
 wrap(manager,'enqueue',original=>function(this:any,operation:any,...args:any[]){
  if(!runtime.storage.canEdit(client.projectId))throw new ApiError(403,'READ_ONLY','当前只有查看权限，不能修改画布。');
  const mounted=manager.getRemoteData() as NativeGraph,virtual=queued.length?virtualGraph():mounted,affected=unique(idsFor(operation,virtual)),ids=affected.filter(id=>existing().has(id));
  const dependsOnPending=queued.length>0&&affected.some(id=>!mounted.nodes.some(node=>node.id===id)&&virtual.nodes.some(node=>node.id===id));
  if(!ids.length&&!dependsOnPending||client.owns(ids)&&!queued.length)return original.call(this,operation,...args);
  const op=structuredClone(operation),context=this;add({ids:()=>affected,run:merged=>original.call(context,rebase(op,merged),...args),project:graph=>apply(graph,op)});
 });
 wrap(manager,'addEdge',original=>function(this:any,edge:any,options:any){
  const affected=edgeIds(virtualGraph(),edge),ids=affected.filter(id=>existing().has(id));if(!options?.immediate||client.owns(ids)&&!queued.length)return original.call(this,edge,options);const context=this,copy=structuredClone(edge);add({ids:()=>affected,run:merged=>{original.call(context,merged.edges.find(value=>value.id===copy.id)??copy,options);},project:graph=>apply(graph,{kind:'addEdge',edge:copy})});return false;
 });
 wrap(manager,'applyHistoryTransition',original=>function(this:any,beforeNodes:any[],beforeEdges:any[],afterNodes:any[],afterEdges:any[],...args:any[]){const ids=changedNodes({nodes:beforeNodes,edges:beforeEdges},{nodes:afterNodes,edges:afterEdges}).filter(id=>existing().has(id));if(!client.owns(ids))throw new ApiError(409,'NODE_EDIT_OCCUPIED','历史操作涉及的节点正在被编辑，请等待节点占用解除。');return original.call(this,beforeNodes,beforeEdges,afterNodes,afterEdges,...args);});
 for(const direction of ['undo','redo'])wrap(manager,direction,original=>function(this:any,...args:any[]){const ids=[...existing()];if(client.owns(ids)&&!queued.length)return original.apply(this,args);const context=this;add({key:'direct-'+direction,opaque:true,ids:()=>[...existing()],run:()=>{original.apply(context,args);},project:graph=>graph});});
 const history=native.fA;
 if(history?.getState&&history?.setState){
  const originals:Record<string,Function>={},owned:Record<string,Function>={};
  for(const direction of ['undo','redo'] as const){const original=history.getState()[direction];if(typeof original!=='function')continue;originals[direction]=original;owned[direction]=(...args:any[])=>{
   if(manager.localOnly===true&&manager.undoManager)return manager[direction]?.();
   const plan=()=>{const state=history.getState(),index=state.historyIndex,next=direction==='undo'?index-1:index+1,before=state.historyStack?.[index],after=state.historyStack?.[next];return before&&after?{before:{nodes:before.nodes,edges:before.edges},after:{nodes:after.nodes,edges:after.edges}}:null;};
   const initial=plan();if(!initial)return original(...args);const ids=changedNodes(initial.before,initial.after).filter(id=>existing().has(id));if(client.owns(ids)&&!queued.length)return original(...args);
   add({key:'history-'+direction,ids:()=>{const value=plan();return value?changedNodes(value.before,value.after):[];},run:()=>{if(!equalDraftValue(plan(),initial))throw new ApiError(409,'LOCAL_EDIT_RECOVERY_REQUIRED','历史记录已更新，当前编辑已保留，请重试同步。');original(...args);},project:graph=>mergeCanvasDraft(initial.before,initial.after,graph).graph});
  };}history.setState(owned);restorers.push(()=>{const restore:Record<string,Function>={};for(const [name,value]of Object.entries(owned))if(history.getState()[name]===value)restore[name]=originals[name];history.setState(restore);});
 }
 // Direct history entry mutations have synchronous return contracts. DOM
 // intent pre-acquires them; guard an unowned programmatic caller explicitly.
 for(const name of ['appendNodeOutputHistoryEntry','removeNodeOutputHistoryItem'])wrap(manager,name,original=>function(this:any,nodeId:string,...args:any[]){if(existing().has(nodeId)&&!client.owns([nodeId])){void client.acquire([nodeId]).catch(reason=>notice(reason instanceof Error?reason.message:'节点正在被编辑。'));throw new ApiError(409,'NODE_EDIT_OCCUPIED','正在取得节点编辑权限，请保留当前编辑后继续。');}return original.call(this,nodeId,...args);});
 const resumeWaiting=()=>{
  clearRecovered();if(disposed||draining||!waitingForLease||!queued.length||!current()||!runtime.storage.canEdit(client.projectId)||client.state().status!=='connected')return;
  const blocked=unique(queued[0].ids()).filter(id=>existing().has(id)).some(id=>{const holder=client.holder(id);return holder&&(holder.clientId!==client.clientId||holder.userId!==client.userId);});if(blocked)return;
  const generation=clientGeneration,pending=flushPending();void pending.catch(reason=>{if(disposed||generation!==clientGeneration||!current())return;error=reason instanceof Error?reason.message:'尚未恢复同步。';backup();});return pending;
 };
 return{flushPending,resumeWaiting,hasPending:()=>{clearRecovered();return queued.length>0;},error:()=>error,suspend:()=>{clientGeneration++;draining=null;backup();},reconnect:next=>{if(disposed||next.projectId!==client.projectId||next.userId!==client.userId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布或账号已变化，当前编辑仍保留。请返回原画布后重试同步。');clientGeneration++;draining=null;client=next;},dispose:()=>{if(disposed)return;backup();clientGeneration++;disposed=true;waitingForLease=false;for(const restore of restorers.reverse())restore();}};
}

export function canvasTransform(doc:Document){
 const canvas=doc.querySelector<HTMLElement>('.react-flow'),viewport=canvas?.querySelector<HTMLElement>('.react-flow__viewport');if(!canvas||!viewport)return null;
 const rect=canvas.getBoundingClientRect(),transform=getComputedStyle(viewport).transform,values=transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number);
 const scale=values?.[0]??1,x=values?.[4]??0,y=values?.[5]??0;if(!Number.isFinite(scale)||scale<=0||!Number.isFinite(x)||!Number.isFinite(y))return null;
 return{rect,screen:(point:PresencePoint)=>({x:rect.left+x+point.x*scale,y:rect.top+y+point.y*scale}),canvas:(point:PresencePoint)=>({x:(point.x-rect.left-x)/scale,y:(point.y-rect.top-y)/scale})};
}
function element<K extends keyof HTMLElementTagNameMap>(doc:Document,tag:K,text?:string,className?:string){const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
interface PointerIntent {id:number;target:HTMLElement;ids:string[];x:number;y:number;lastX:number;lastY:number;button:number;buttons:number;down:boolean;canceled:boolean;started:boolean;pointerType:string;pointerGesture:boolean;event:PointerEvent;lastEvent:PointerEvent}
export function installNativePresence(runtime:any,native:any,notice:(text:string)=>void,props:(element:any)=>any[]=()=>[],surface:any=window,doc:Document=document){
 if(typeof runtime.setCanvasPresence!=='function'||!runtime.api||!runtime.auth?.onClear)return()=>{};
 const style=element(doc,'style');style.textContent=nativePresenceStyles;doc.head.append(style);
 const overlay=element(doc,'div',undefined,'studio-presence-overlay');overlay.setAttribute('data-studio-presence','');overlay.setAttribute('aria-hidden','true');
 const panel=element(doc,'div',undefined,'studio-presence-panel'),toggle=element(doc,'button','协作连接中…','studio-presence-toggle'),people=element(doc,'div',undefined,'studio-presence-people'),status=element(doc,'p','','studio-presence-status'),retry=element(doc,'button','重试同步','studio-presence-retry'),hint=element(doc,'p','先操作的成员暂时占用节点，离开后自动释放。','studio-presence-hint');
 panel.setAttribute('data-studio-presence','');toggle.type=retry.type='button';toggle.setAttribute('aria-expanded','false');people.hidden=true;people.append(status,hint,retry);panel.append(toggle,people);doc.body.append(panel,overlay);panel.hidden=true;retry.hidden=true;
 let blockedClick:HTMLElement|null=null,idleReleasePending=false,visibilityGeneration=0;
 let disposed=false,suspended=false,client:CanvasPresenceClient|null=null,guard:PresenceMutationBuffer|null=null,releaseClient:(()=>void)|null=null,releaseSelection:(()=>void)|null=null,attachment:any=null,currentUser='',frame:number|undefined,intent:PointerIntent|null=null,replay=false,cancelingPointer=false,lastActivity=Date.now(),lastError='',hoverNode='',hoverTimer:ReturnType<typeof setTimeout>|undefined;
 let connecting:{owner:CanvasPresenceClient;work:Promise<void>;finish?:()=>void}|null=null;
 const cursorElements=new Map<string,HTMLElement>(),leaseElements=new Map<string,HTMLElement>();let domNodes=new Map<string|null,HTMLElement>(),nodesDirty=true;
 const readonly=new Map<HTMLElement,{readOnly?:boolean;contenteditable:string|null}>(),composing=new WeakSet<HTMLElement>();
 const current=()=>!disposed&&!suspended&&!!client&&runtime.auth.user?.id===currentUser&&runtime.canvasAttachment()?.client===attachment?.client&&runtime.canvasAttachment()?.id===attachment?.id;
 const graph=()=>attachment?.client.getRemoteData(),selection=()=>unique((native.c5?.getState?.().selectedNodeIds??[]).filter((id:any)=>typeof id==='string'));
 const targets=(target:EventTarget|null)=>{
  if(!(target instanceof Element)||!client)return[];const node=target.closest<HTMLElement>('.react-flow__node[data-id],[data-node-id]'),own=node?.getAttribute('data-id')??node?.getAttribute('data-node-id');if(own)return[own];
  const candidates=props(target).flatMap(value=>[value.nodeId,value.targetNode?.id,value.groupNode?.id,value.node?.id]).filter(value=>typeof value==='string'&&graph()?.nodes.some((node:any)=>node.id===value));return unique(candidates).slice(0,128);
 };
 const editableIds=(target:EventTarget|null)=>targets(target);
 const show=(message:string)=>{if(message!==lastError){lastError=message;notice(message);}status.textContent=message;};
 const activity=()=>{lastActivity=Date.now();};
 const unfreeze=(target:HTMLElement)=>{const prior=readonly.get(target);if(!prior)return;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement)target.readOnly=prior.readOnly??false;else if(prior.contenteditable===null)target.removeAttribute('contenteditable');else target.setAttribute('contenteditable',prior.contenteditable);readonly.delete(target);};
 const freeze=(target:HTMLElement)=>{if(readonly.has(target)||composing.has(target))return;readonly.set(target,{readOnly:target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement?target.readOnly:undefined,contenteditable:target.getAttribute('contenteditable')});if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement)target.readOnly=true;else target.setAttribute('contenteditable','false');};
 const selectionChanged=()=>{if(!current())return;client!.setSelection(selection());};
 const render=()=>{
  if(!current()||!client)return;const state=client.state(),snapshot=state.snapshot,members=presencePeople(snapshot?.members??[],snapshot?.leases??[],client.userId,client.clientId),peers=members.filter(member=>!member.isYou);
  panel.hidden=false;const permission=doc.querySelector('.studio-collab-readonly');if(permission&&panel.parentElement!==permission)permission.append(panel);panel.classList.toggle('studio-presence-panel--floating',!permission);
  toggle.replaceChildren();const faces=element(doc,'span',undefined,'studio-presence-faces');for(const member of peers.slice(0,4)){const face=element(doc,'span',Array.from(member.displayName||'成员').slice(0,2).join(''),'studio-presence-avatar');face.style.background=participantColor(member.userId);face.title=member.displayName;faces.append(face);}toggle.append(faces,element(doc,'span',state.status==='connected'?`在线 ${members.length} 人`:state.status==='connecting'?'协作连接中…':'协作重连中…'));
  toggle.setAttribute('data-connection',state.status);status.textContent=guard?.error()||state.error||(state.status==='connected'?'成员光标与节点占用实时同步。':'连接恢复前，已有编辑会保留在当前页面。');retry.hidden=!guard?.hasPending();
  for(const row of [...people.querySelectorAll('[data-presence-member]')])row.remove();for(const member of members){const row=element(doc,'div',undefined,'studio-presence-member');row.setAttribute('data-presence-member','');row.setAttribute('data-presence-user',member.userId);const dot=element(doc,'span',undefined,'studio-presence-dot');dot.style.background=participantColor(member.userId);const pages=member.pages.length>1?` · ${member.pages.length} 个页面`:'',state=member.role==='VIEWER'?'只读':member.editing?'编辑中':'浏览中';row.append(dot,element(doc,'span',member.displayName+(member.isYou?'（你）':'')),element(doc,'small',state+pages));if(member.isYou&&member.pages.length>1)row.title='包含当前页和你在其他页面或设备打开的画布；各页面的节点占用独立。';people.insertBefore(row,hint);}
  for(const target of doc.querySelectorAll<HTMLElement>('.react-flow__node input,.react-flow__node textarea,.react-flow__node [contenteditable],.studio-presence-pending-input')){
   const ids=editableIds(target);if(!ids.length)continue;if(client.owns(ids))unfreeze(target);else freeze(target);
  }
  paintOverlay();
 };
 const paintOverlay=()=>{
  if(!current()||!client)return;const transform=canvasTransform(doc);if(!transform){for(const node of [...cursorElements.values(),...leaseElements.values()])node.hidden=true;return;}const state=client.state(),activeCursors=new Set<string>(),activeLeases=new Set<string>();
  for(const member of state.snapshot?.members??[]){if(member.clientId===client.clientId||!member.cursor)continue;if(member.userId===client.userId&&(client.joinedAt===undefined||Date.parse(member.lastSeenAt)<=client.joinedAt))continue;activeCursors.add(member.clientId);let cursor=cursorElements.get(member.clientId);
   if(!cursor){cursor=element(doc,'div',undefined,'studio-presence-cursor');const icon=doc.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('width','18');icon.setAttribute('height','22');icon.setAttribute('viewBox','0 0 18 22');const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M2 1.5 15.5 12 9 13 6.5 19.5Z');icon.append(path);cursor.append(icon,element(doc,'span'));overlay.append(cursor);cursorElements.set(member.clientId,cursor);}
   const position=transform.screen(member.cursor);cursor.hidden=position.x<transform.rect.left||position.x>transform.rect.right||position.y<transform.rect.top||position.y>transform.rect.bottom;
   const value=`translate(${position.x}px,${position.y}px)`;if(cursor.style.transform!==value)cursor.style.transform=value;cursor.style.setProperty('--peer-color',participantColor(member.userId));const name=member.userId===client.userId?'你·另一页面':member.displayName;if(cursor.lastElementChild?.textContent!==name)cursor.lastElementChild!.textContent=name;
  }
  for(const [id,node]of cursorElements)if(!activeCursors.has(id)){node.remove();cursorElements.delete(id);}
  if(nodesDirty){domNodes=new Map([...doc.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')].map(node=>[node.getAttribute('data-id'),node]));nodesDirty=false;}
  for(const lease of state.snapshot?.leases??[]){if(lease.clientId===client.clientId)continue;const node=domNodes.get(lease.nodeId);if(!node?.isConnected)continue;activeLeases.add(lease.nodeId);let frame=leaseElements.get(lease.nodeId);if(!frame){frame=element(doc,'div',undefined,'studio-presence-node');frame.append(element(doc,'span'));overlay.append(frame);leaseElements.set(lease.nodeId,frame);}
   const rect=node.getBoundingClientRect();frame.hidden=rect.right<transform.rect.left||rect.left>transform.rect.right||rect.bottom<transform.rect.top||rect.top>transform.rect.bottom;
   for(const [key,value]of Object.entries({left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'}))if((frame.style as any)[key]!==value)(frame.style as any)[key]=value;frame.style.setProperty('--peer-color',participantColor(lease.userId));const name=`${lease.userId===client.userId?'你·另一页面':lease.displayName} 正在编辑`;if(frame.firstElementChild!.textContent!==name)frame.firstElementChild!.textContent=name;
  }
  for(const [id,node]of leaseElements)if(!activeLeases.has(id)){node.remove();leaseElements.delete(id);}
 };
 const animate=()=>{if(disposed)return;paintOverlay();frame=surface.requestAnimationFrame(animate);};
 toggle.onclick=()=>{people.hidden=!people.hidden;toggle.setAttribute('aria-expanded',String(!people.hidden));render();};retry.onclick=()=>{void guard?.flushPending().then(()=>{lastError='';render();}).catch(error=>show(error instanceof Error?error.message:'尚未恢复同步。'));};
 const acquire=(ids:string[])=>{if(!current()||!client)return Promise.reject(new ApiError(409,'STALE_CANVAS_SESSION','画布已切换。'));const owner=client,valid=()=>current()&&client===owner;activity();const snapshot=runtime.storage.snapshots.get(owner.projectId),persisted=new Set((snapshot?.graph?.nodes??[]).map((node:any)=>node.id)),prepare=ids.some(id=>!persisted.has(id))?Promise.resolve(runtime.waitForSave?.()):Promise.resolve();return prepare.then(()=>{if(!valid())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换。');return owner.acquire(ids);}).then(()=>{if(!valid())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换。');for(const target of [...readonly.keys()])if(editableIds(target).every(id=>owner.owns([id])))unfreeze(target);lastError='';render();});};
 const stopEvent=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();};
 // Native handles listen on document, while node drags may listen on window.
 // Replaying at a DOM target reaches both; dispatching at window skips document
 // and leaves the frozen connection's mouseup/cleanup listener stranded.
 const mouse=(pending:PointerIntent,type:string,event:PointerEvent=pending.lastEvent)=>{
  const target=type==='mousedown'?pending.target:event.target instanceof Node&&event.target.isConnected?event.target:doc;
  const init={bubbles:true,cancelable:true,view:surface,clientX:event.clientX,clientY:event.clientY,button:0,buttons:type==='mouseup'?0:1,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,altKey:event.altKey};
  // zM's visible plus affordance owns a pointer-only gesture. Replaying a
  // compatibility mousedown never starts it; raw ReactFlow handles still use
  // their original mouse protocol. Replay exactly one family per intent.
  target.dispatchEvent(pending.pointerGesture?new PointerEvent(type.replace('mouse','pointer'),{...init,pointerId:pending.id,pointerType:pending.pointerType,isPrimary:true}):new MouseEvent(type,init));
 };
 const clickIntent=(pending:PointerIntent)=>{
  // Native icons are SVG elements. They can be the real pointer target but
  // do not implement HTMLElement.click(), so preserve that target explicitly.
  if(typeof pending.target.click==='function')pending.target.click();else{const event=pending.lastEvent;pending.target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:surface,clientX:event.clientX,clientY:event.clientY,button:0,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,altKey:event.altKey}));}
 };
 const pointerDown=(event:PointerEvent)=>{
  if(replay||!current()||event.button!==0)return;blockedClick=null;if(intent)cancelPointer();const ids=targets(event.target);if(!ids.length)return;activity();const priorConnection=connecting?.owner===client?connecting.work:undefined;if(client!.owns(ids)&&!priorConnection)return;
  stopEvent(event);intent={id:event.pointerId,target:event.target as HTMLElement,ids,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,button:event.button,buttons:event.buttons,down:true,canceled:false,started:false,pointerType:event.pointerType,pointerGesture:event.target instanceof Element&&!!event.target.closest('.node-plus-button'),event,lastEvent:event};const pending=intent;
  const prepare=()=>{if(intent!==pending||pending.canceled||!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换。');return acquire(ids);};
  void (priorConnection?priorConnection.then(prepare):prepare()).then(()=>{if(intent!==pending||pending.canceled||!current()||!pending.target.isConnected)return;replay=true;try{
   if(pending.pointerType==='mouse'||pending.pointerGesture){
    pending.started=true;mouse(pending,'mousedown',event);if(editable(pending.target))pending.target.focus({preventScroll:true});
    if(pending.lastX!==pending.x||pending.lastY!==pending.y)mouse(pending,'mousemove');
    if(!pending.down){mouse(pending,'mouseup');if(Math.hypot(pending.lastX-pending.x,pending.lastY-pending.y)<6){pending.target.focus?.({preventScroll:true});clickIntent(pending);blockedClick=pending.target;}intent=null;}
   }
   else if(!pending.down&&Math.hypot(pending.lastX-pending.x,pending.lastY-pending.y)<6){pending.target.focus?.({preventScroll:true});clickIntent(pending);blockedClick=pending.target;intent=null;}
  }finally{replay=false;}}).catch(error=>{pending.canceled=true;if(current()&&intent===pending){show(error instanceof Error?error.message:'节点正在被其他成员编辑。');if(!pending.down){blockedClick=pending.target;intent=null;}}});
 };
 const pointerMove=(event:PointerEvent)=>{
  if(replay||!current()||!client)return;const transform=canvasTransform(doc),canvas=doc.querySelector('.react-flow');if(transform&&canvas?.contains(event.target as Node))client.setCursor(transform.canvas({x:event.clientX,y:event.clientY}));else client.setCursor(null);
  if(intent&&event.pointerId===intent.id){if(intent.pointerGesture)stopEvent(event);intent.lastX=event.clientX;intent.lastY=event.clientY;intent.lastEvent=event;if(intent.started&&intent.down){replay=true;try{mouse(intent,'mousemove');}finally{replay=false;}}}
 };
 const pointerUp=(event:PointerEvent)=>{if(replay||!intent||event.pointerId!==intent.id)return;const pending=intent;if(pending.pointerGesture)stopEvent(event);pending.down=false;pending.lastX=event.clientX;pending.lastY=event.clientY;pending.lastEvent=event;if(pending.canceled){blockedClick=pending.target;intent=null;return;}if(pending.started){replay=true;try{mouse(pending,'mouseup');if(Math.hypot(pending.lastX-pending.x,pending.lastY-pending.y)<6){clickIntent(pending);blockedClick=pending.target;}}finally{replay=false;intent=null;}}else if(pending.pointerType!=='mouse'&&current()&&client!.owns(pending.ids)){replay=true;try{if(Math.hypot(pending.lastX-pending.x,pending.lastY-pending.y)<6){pending.target.focus?.({preventScroll:true});clickIntent(pending);blockedClick=pending.target;}else show('已取得节点编辑权限，请再次拖动。');}finally{replay=false;intent=null;}}};
 const cancelPointer=()=>{if(intent){intent.canceled=true;if(intent.started){replay=true;cancelingPointer=true;try{mouse(intent,'mouseup');}finally{replay=false;cancelingPointer=false;}}intent=null;}};
 const mouseCompatibility=(event:MouseEvent)=>{if(!replay&&(intent||event.type==='click'&&blockedClick&&event.target instanceof Node&&blockedClick.contains(event.target))){stopEvent(event);if(event.type==='click')blockedClick=null;}};
 const pointerHover=(event:PointerEvent)=>{if(!current()||event.pointerType&&event.pointerType!=='mouse')return;const id=targets(event.target)[0]??'';if(id===hoverNode)return;hoverNode=id;if(hoverTimer)clearTimeout(hoverTimer);if(!id||client!.owns([id])||!runtime.storage.snapshots.get(client!.projectId)?.graph.nodes.some((node:any)=>node.id===id))return;
  const owner=client,activityAt=lastActivity;hoverTimer=setTimeout(()=>{hoverTimer=undefined;if(!current()||client!==owner||hoverNode!==id)return;void owner!.acquire([id]).then(()=>{render();setTimeout(()=>{if(current()&&client===owner&&lastActivity===activityAt&&!guard?.hasPending()&&!(editable(doc.activeElement)&&targets(doc.activeElement).includes(id)))void owner!.release([id]).catch(()=>{});},700);}).catch(()=>{});},150);
 };
 const focusIn=(event:FocusEvent)=>{if(!current())return;const ids=targets(event.target);if(ids.length){activity();void acquire(ids).catch(error=>show(error instanceof Error?error.message:'节点暂时不可编辑。'));}};
 const inputGuard=(event:InputEvent)=>{if(replay||!current())return;const ids=targets(event.target);if(!ids.length||client!.owns(ids))return;if(event.isComposing||composing.has(event.target as HTMLElement))return;stopEvent(event);void acquire(ids).catch(error=>show(error instanceof Error?error.message:'节点暂时不可编辑。'));};
 const clipboard=(event:ClipboardEvent)=>{if(replay||!current()||event.type==='copy')return;const ids=targets(event.target).length?targets(event.target):selection();if(!ids.length||client!.owns(ids))return;stopEvent(event);const target=event.target as HTMLElement,data=new DataTransfer();
  // Clipboard access can expire once this trusted event returns. Retain every
  // format/file now, then let the native paste capture identify canvas refs or
  // uploaded images before emulating the editable element's default insertion.
  for(const type of event.clipboardData?.types??[])if(type!=='Files')data.setData(type,event.clipboardData!.getData(type));for(const file of Array.from(event.clipboardData?.files??[]))data.items.add(file);
  const text=data.getData('text/plain');show('正在取得节点编辑权限，原有内容已保留。');void acquire(ids).then(()=>{
   if(!current()||!target.isConnected)return;if(event.type==='cut'){show('已取得编辑权限，请再次剪切，以便安全写入系统剪贴板。');return;}
   replay=true;try{if(!target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})))return;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement){if(target.readOnly||target.disabled)return;const start=target.selectionStart??target.value.length,end=target.selectionEnd??start,value=target.value.slice(0,start)+text+target.value.slice(end),setter=Object.getOwnPropertyDescriptor(target instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value')?.set;setter?.call(target,value);target.focus({preventScroll:true});target.setSelectionRange(start+text.length,start+text.length);target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:text}));}else if(target.isContentEditable){target.focus({preventScroll:true});doc.execCommand('insertText',false,text);}}finally{replay=false;}
  }).catch(error=>{if(current())show(error instanceof Error?error.message:'节点正在被编辑。');});};
 const keyDown=(event:KeyboardEvent)=>{if(replay||!current())return;const ids=targets(event.target).length?targets(event.target):['Delete','Backspace'].includes(event.key)&&!editable(event.target as Element)?selection():[];if(!ids.length||client!.owns(ids))return;if(event.isComposing)return;
  if(event.ctrlKey||event.metaKey||event.altKey||event.key==='Tab'||event.key.startsWith('Arrow')||event.key==='Escape')return;
  stopEvent(event);const target=event.target as HTMLElement,character=event.key.length===1?event.key:null;
  void acquire(ids).then(()=>{if(!current()||!target.isConnected||doc.activeElement!==target)return;if(character){replay=true;try{if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement){const start=target.selectionStart??target.value.length,end=target.selectionEnd??start,value=target.value.slice(0,start)+character+target.value.slice(end),setter=Object.getOwnPropertyDescriptor(target instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value')?.set;setter?.call(target,value);target.setSelectionRange(start+character.length,start+character.length);target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:character}));}else if(target.isContentEditable)doc.execCommand('insertText',false,character);}finally{replay=false;}}else if(event.key==='Delete'||event.key==='Backspace'){replay=true;try{target.dispatchEvent(new KeyboardEvent('keydown',{key:event.key,code:event.code,bubbles:true,cancelable:true}));}finally{replay=false;}}}).catch(error=>show(error instanceof Error?error.message:'节点暂时不可编辑。'));
 };
 const compositionStart=(event:CompositionEvent)=>{composing.add(event.target as HTMLElement);},compositionEnd=(event:CompositionEvent)=>{composing.delete(event.target as HTMLElement);render();};
 const join=(next:any,user:string,reuseGuard=false)=>{
  const ownedClient=new CanvasPresenceClient(runtime.api,next.id,user,()=>runtime.storage.canEdit(next.id),()=>!disposed&&!suspended&&runtime.auth.user?.id===user&&runtime.canvasAttachment()?.client===next.client&&runtime.canvasAttachment()?.id===next.id,undefined,()=>runtime.auth.user?.id===user);client=ownedClient;
  if(reuseGuard&&guard)guard.reconnect(ownedClient);else guard=guardNativePresenceMutations(runtime,native,next.client,ownedClient,notice,current);
  (ownedClient as any).flushPending=guard.flushPending;(ownedClient as any).hasPending=guard.hasPending;
  const updated=()=>{if(!current()||client!==ownedClient)return;render();void guard?.resumeWaiting()?.then(()=>{if(current()&&client===ownedClient){lastError='';render();}}).catch(error=>{if(current()&&client===ownedClient){show(error instanceof Error?error.message:'尚未恢复同步。');render();}});};
  runtime.setCanvasPresence(ownedClient);releaseClient=ownedClient.subscribe(updated);releaseSelection=native.c5?.subscribe?.(selectionChanged)??null;selectionChanged();void ownedClient.start().then(()=>{if(client===ownedClient)updated();}).catch(error=>{if(current()&&client===ownedClient){show(error instanceof Error?error.message:'协作连接暂时不可用。');render();}});render();
 };
 const refresh=()=>{
  if(disposed||suspended)return;const next=runtime.canvasAttachment?.(),user=runtime.auth.user?.id;
  if(next?.id===attachment?.id&&next?.client===attachment?.client&&user===currentUser)return;
  cancelPointer();releaseClient?.();releaseSelection?.();guard?.dispose();client?.stop({release:!guard?.hasPending()&&!runtime.storage.hasPending?.()});runtime.setCanvasPresence(null);for(const target of [...readonly.keys()])unfreeze(target);overlay.replaceChildren();cursorElements.clear();leaseElements.clear();nodesDirty=true;panel.hidden=true;attachment=next;currentUser=user??'';client=null;guard=null;
  if(!next||!user||canvasProjectFromPath(surface.location.pathname)!==next.id)return;join(next,user);
 };
 const pagehide=()=>{
  if(disposed||suspended)return;suspended=true;cancelPointer();if(hoverTimer)clearTimeout(hoverTimer);hoverTimer=undefined;hoverNode='';guard?.suspend();releaseClient?.();releaseSelection?.();releaseClient=null;releaseSelection=null;client?.stop({release:!guard?.hasPending()&&!runtime.storage.hasPending?.()});panel.hidden=true;overlay.replaceChildren();cursorElements.clear();leaseElements.clear();nodesDirty=true;
 };
 const pageshow=(event:PageTransitionEvent)=>{
  if(disposed||!suspended||!event.persisted)return;suspended=false;const next=runtime.canvasAttachment?.(),user=runtime.auth.user?.id;
  if(next&&user&&next.id===attachment?.id&&next.client===attachment.client&&user===currentUser&&canvasProjectFromPath(surface.location.pathname)===next.id){join(next,user,true);return;}
  // A cached page may restore after login or route changes. Old edits remain
  // in their original backup; never rebind them to another identity or canvas.
  attachment=null;currentUser='';refresh();
 };
 const jsxRestorers:(()=>void)[]=[];
 for(const method of ['jsx','jsxs']){const original=native.j?.[method];if(typeof original!=='function')continue;const wrapped=function(this:any,type:any,properties:any,...rest:any[]){
  // zM must receive pointerup to remove its document listeners/timer even
  // when the page cancels. Suppress its short-click/menu callback during that
  // cleanup, while leaving genuine native clicks and drag starts unchanged.
  if(current()&&properties&&typeof properties.onConnectionDragStart==='function'){
   const drag=properties.onConnectionDragStart,short=properties.onShortClick;properties={...properties,onConnectionDragStart:(...args:any[])=>{if(!cancelingPointer)return drag(...args);},...(typeof short==='function'?{onShortClick:(...args:any[])=>{if(!cancelingPointer)return short(...args);}}:{})};
  }
  if(current()&&properties&&typeof properties.onConnect==='function'&&Array.isArray(properties.nodes)&&Array.isArray(properties.edges)){
   const action=properties.onConnect,end=properties.onConnectEnd,mounted=attachment?.client,project=attachment?.id,user=currentUser,active=()=>current()&&attachment?.client===mounted&&attachment?.id===project&&currentUser===user;properties={...properties,onConnect:(connection:any)=>{
    if(!active()||intent?.canceled)return;const ids=unique([connection.source,connection.target].filter((value:any)=>typeof value==='string'));
    // The frozen onConnect sets a synchronous flag consumed by onConnectEnd.
    // Do not delay it when both leases are already held.
    if(client!.owns(ids))return action(connection);
    const owner=client!,attempt:{owner:CanvasPresenceClient;work:Promise<void>;finish?:()=>void}={owner,work:Promise.resolve()};connecting=attempt;
    attempt.work=acquire(ids).then(()=>{if(active()&&client===owner)action(connection);}).catch(error=>{if(active()&&client===owner)show(error instanceof Error?error.message:'连线节点正在被编辑。');}).finally(()=>{
     try{if(active()&&client===owner)attempt.finish?.();}finally{if(connecting===attempt)connecting=null;}
    });void attempt.work.catch(error=>{if(active()&&client===owner)show(error instanceof Error?error.message:'连线尚未完成。');});
   },...(typeof end==='function'?{onConnectEnd:(...args:any[])=>{
    if(!active()||intent?.canceled)return;const pending=connecting?.owner===client?connecting:undefined;if(!pending)return end(...args);
    // An explicit onConnect already owns this attempt. Finish after its lease
    // check, using a cancellation-shaped event to clear native gesture state
    // without letting its node-body fallback submit a rejected connection.
    pending.finish=()=>end(new Event('pointercancel'),args[1]);
   }}:{})};
  }return original.call(this,type,properties,...rest);
 };native.j[method]=wrapped;jsxRestorers.push(()=>{if(native.j[method]===wrapped)native.j[method]=original;});}
 const observer=new surface.MutationObserver((records:MutationRecord[])=>{if(records.some(record=>!(record.target instanceof Element&&record.target.closest('[data-studio-presence]')))){nodesDirty=true;refresh();}});observer.observe(doc.body,{childList:true,subtree:true});
 const releaseAuth=runtime.auth.onClear(refresh),releaseAccess=runtime.storage.subscribeAccess?.(refresh),tick=setInterval(()=>{
  if(!current()||!client)return;render();const focused=doc.activeElement,editing=doc.hasFocus?.()!==false&&editable(focused)&&targets(focused).length>0;
  if(Date.now()-lastActivity>10000&&!intent?.down&&!editing&&!guard?.hasPending()&&!idleReleasePending){idleReleasePending=true;const owner=client,activityAt=lastActivity;void Promise.resolve(runtime.waitForSave?.()).then(()=>{if(current()&&client===owner&&activityAt===lastActivity&&!guard?.hasPending())return owner.release();}).catch(()=>{}).finally(()=>{idleReleasePending=false;});}
 },1000);
 const hidden=()=>{
  const visibilityAt=++visibilityGeneration;if(!current()||!client||doc.visibilityState!=='hidden')return;
  cancelPointer();client.setCursor(null);if(guard?.hasPending())return;
  const owner=client,scope=attachment,activityAt=lastActivity;let graphAt:string|undefined;try{graphAt=JSON.stringify(graph());}catch{return;}
  // A completed save belongs to this hidden interval only. The page may have
  // resumed/acquired again, or accepted a background native edit meanwhile.
  void Promise.resolve(runtime.waitForSave?.()).then(()=>{if(client===owner&&attachment===scope&&current()&&doc.visibilityState==='hidden'&&visibilityAt===visibilityGeneration&&activityAt===lastActivity&&!guard?.hasPending()&&!runtime.storage.hasPending?.()&&JSON.stringify(graph())===graphAt)return owner.release();}).catch(()=>{});
 };
 const listeners:Array<[EventTarget,string,EventListener,boolean?]>=[[surface,'pointerdown',pointerDown as EventListener,true],[doc,'pointermove',pointerMove as EventListener,true],[doc,'pointerover',pointerHover as EventListener,true],[surface,'pointerup',pointerUp as EventListener,true],[surface,'pointercancel',cancelPointer,true],[surface,'blur',((event:FocusEvent)=>{if(event.target===surface||(event.target as Window|null)?.document===doc){cancelPointer();client?.setCursor(null);}}) as EventListener,true],[surface,'mousedown',mouseCompatibility as EventListener,true],[surface,'mousemove',mouseCompatibility as EventListener,true],[surface,'mouseup',mouseCompatibility as EventListener,true],[surface,'click',mouseCompatibility as EventListener,true],[doc,'focusin',focusIn as EventListener,true],[doc,'beforeinput',inputGuard as EventListener,true],[doc,'keydown',keyDown as EventListener,true],[doc,'paste',clipboard as EventListener,true],[doc,'cut',clipboard as EventListener,true],[doc,'compositionstart',compositionStart as EventListener,true],[doc,'compositionend',compositionEnd as EventListener,true],[doc,'visibilitychange',hidden],[surface,'pagehide',pagehide],[surface,'pageshow',pageshow as EventListener],[surface,'popstate',refresh],[surface,'rhtv:canvas-attachment',refresh]];
 for(const [target,name,callback,capture]of listeners)target.addEventListener(name,callback,capture);frame=surface.requestAnimationFrame(animate);refresh();
 return()=>{if(disposed)return;cancelPointer();guard?.dispose();client?.stop({release:!guard?.hasPending()&&!runtime.storage.hasPending?.()});disposed=true;releaseClient?.();releaseSelection?.();releaseAuth();releaseAccess?.();runtime.setCanvasPresence(null);observer.disconnect();clearInterval(tick);if(hoverTimer)clearTimeout(hoverTimer);if(frame!==undefined)surface.cancelAnimationFrame(frame);for(const [target,name,callback,capture]of listeners)target.removeEventListener(name,callback,capture);for(const restore of jsxRestorers)restore();for(const target of [...readonly.keys()])unfreeze(target);panel.remove();overlay.remove();style.remove();};
}
export const nativePresenceStyles=`
.studio-presence-panel[hidden],.studio-presence-retry[hidden],.studio-presence-cursor[hidden],.studio-presence-node[hidden]{display:none}.studio-presence-panel{position:relative;font-family:inherit;font-size:12px;line-height:1.5;color:#eee8f5}.studio-presence-panel--floating{position:fixed;top:108px;right:18px;z-index:8500}.studio-presence-toggle,.studio-presence-retry{display:flex;align-items:center;gap:7px;min-height:30px;padding:4px 8px;border:1px solid #63556f;border-radius:7px;background:#29232f;color:#eee8f5;font:inherit;cursor:pointer}.studio-presence-toggle:hover,.studio-presence-retry:hover{background:#3a3043}.studio-presence-toggle:focus-visible,.studio-presence-retry:focus-visible{outline:2px solid #c8a8ee;outline-offset:3px}.studio-presence-faces{display:flex}.studio-presence-avatar{display:grid;place-items:center;min-width:24px;height:24px;padding:0 2px;margin-inline-start:-4px;border:1px solid #211c26;border-radius:50%;color:#1d1724;font:600 10px/1.2 system-ui}.studio-presence-avatar:first-child{margin-inline-start:0}.studio-presence-toggle[data-connection=offline],.studio-presence-toggle[data-connection=reconnecting]{color:#ffd1a9}.studio-presence-people{position:absolute;inset-inline-end:0;top:calc(100% + 8px);box-sizing:border-box;width:min(320px,calc(100vw - 32px));max-height:min(460px,calc(100dvh - 150px));overflow:auto;padding:14px;background:#27222e;border:1px solid #5b4d67;border-radius:10px;box-shadow:0 8px 24px rgb(0 0 0 / .25);font:14px/1.6 system-ui}.studio-presence-people[hidden]{display:none}.studio-presence-status,.studio-presence-hint{margin:0 0 12px;color:#d8cce3;overflow-wrap:anywhere}.studio-presence-hint{margin:12px 0 0;font-size:12px}.studio-presence-member{display:flex;align-items:center;gap:8px;min-height:30px}.studio-presence-member>span:nth-child(2){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.studio-presence-member small{font-size:12px;color:#d2c5dd}.studio-presence-dot{width:8px;height:8px;flex:none;border-radius:50%}.studio-presence-retry{margin-block:10px}.studio-presence-overlay{position:fixed;inset:0;z-index:7300;pointer-events:none;overflow:hidden}.studio-presence-cursor{position:absolute;left:0;top:0;display:flex;align-items:flex-start;transition:transform 100ms linear;will-change:transform}.studio-presence-cursor svg{flex:none;fill:var(--peer-color);stroke:#201927;stroke-width:1.3}.studio-presence-cursor span,.studio-presence-node>span{max-width:180px;padding:3px 7px;border-radius:5px;background:var(--peer-color);color:#1d1724;font:600 12px/1.4 system-ui;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.studio-presence-cursor span{margin-top:15px;margin-left:-6px}.studio-presence-node{position:fixed;box-sizing:border-box;outline:2px solid var(--peer-color);outline-offset:2px;border-radius:9px}.studio-presence-node>span{position:absolute;bottom:calc(100% + 6px);left:-2px}.studio-presence-panel ::selection{background:#7955a0;color:#fff}.studio-presence-panel{scrollbar-color:#82708e #27222e}@media(prefers-reduced-motion:reduce){.studio-presence-cursor{transition:none}}@media(max-width:600px){.studio-presence-people{font-size:16px}.studio-presence-avatar{min-width:22px;height:22px}.studio-presence-node>span{max-width:130px}.studio-presence-hint{font-size:14px}}
`;
