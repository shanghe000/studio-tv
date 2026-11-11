// Only structural evidence leaves the browser. References in this snapshot
// are numeric indexes into the visible graph, never user-defined field values.
import type {NativeGraph} from './graph';

const kinds = new Set(['rh-image','rh-video','rh-audio','rh-text','rh-script','rh-storyboard','rh-group','group','rh-role','rh-scene','rh-entity','rh-ai','rh-video-analysis','rh-remake-request','rh-video-remake','rh-director','rh-comment','rh-world','rh-w3d','rh-fastcut']);
const statuses = new Set(['idle','pending','queued','uploading','generating','running','finished','success','succeeded','failed','error','canceled','cancelled']);
const tools = new Set(['IMAGE_PORTRAIT','IMAGE_EXPRESSION','IMAGE_POSE','IMAGE_IMAGE','IMAGE_LIGHT','IMAGE_MULTIANGLE','IMAGE_CUTOUT_TEXT','IMAGE_REDRAW','IMAGE_ERASE','IMAGE_ENHANCE','GRID_CROP','VIDEO_AUDIO','IMAGE_CUTOUT','IMAGE_EXPAND']);
export type SnapshotPhase = 'READINESS'|'PREPARE'|'SYNC'|'SUBMIT';
export type SnapshotControl = 'COMMAND'|'GENERATE'|'RETRY'|'GROUP'|'SHORTCUT'|'MEDIA';
export interface SnapshotIntent {
  control: SnapshotControl;
  targetType: 'NODE'|'GROUP'|'CANVAS';
  targetId: string;
  selected?: readonly string[];
  click?:{visible:boolean;disabled:boolean;ariaDisabled?:boolean};
}
const count = (n:number) => Math.max(0, Math.min(100000, n));
const size = (value:unknown) => Array.isArray(value) ? count(value.length) : value == null ? 0 : 1;

function coordinate(value:unknown):number|undefined {
  return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1000000?Math.round(value):undefined;
}

function maxConnectShape(node:any){
  const data=node?.data;
  if(!data||!Object.hasOwn(data,'maxConnect'))return 'ABSENT' as const;
  const v=data.maxConnect;
  if(!v||Array.isArray(v)||typeof v!=='object')return 'OTHER' as const;
  const values=Object.values(v);
  if(values.length&&values.every(x=>x===null))return 'ALL_NULL' as const;
  if(values.some(x=>typeof x==='number'&&Number.isFinite(x)))return 'LIMITED' as const;
  return 'OTHER' as const;
}

function compareProjection(mounted:NativeGraph,command:NativeGraph,target:string){
  const incoming=(g:NativeGraph)=>g.edges.filter(e=>e?.target===target).map(e=>e.source);
  const page=incoming(mounted),sent=incoming(command);
  const unconsumed=new Map<string,number>();
  for(const source of page)unconsumed.set(source,(unconsumed.get(source)??0)+1);
  let added=0;
  for(const source of sent){
    const n=unconsumed.get(source)??0;
    if(n)unconsumed.set(source,n-1);else added++;
  }
  const removed=[...unconsumed.values()].reduce((total,n)=>total+n,0);
  return {
    mountedTarget:mounted.nodes.some(n=>n?.id===target),commandTarget:command.nodes.some(n=>n?.id===target),
    mountedMaxConnect:maxConnectShape(mounted.nodes.find(n=>n?.id===target)),
    commandMaxConnect:maxConnectShape(command.nodes.find(n=>n?.id===target)),
    mountedInputs:count(page.length),commandInputs:count(sent.length),
    addedSources:count(added),removedSources:count(removed),
    orderChanged:added===0&&removed===0&&page.some((source,i)=>source!==sent[i]),
  };
}

function describe(node:any, index:number, selected:Set<string>, indexes:Map<string,number>, parentId?:string, parentMismatch=false){
  const data=node.data??{}, parent=parentId?indexes.get(parentId):undefined;
  const status=typeof data.status==='string'?data.status.toLowerCase():'';
  const tool=String(typeof data.toolsType==='string'?data.toolsType:data.subType??'').slice(0,48).toUpperCase().replaceAll('-','_');
  return {
    index, kind:kinds.has(node.type)?String(node.type):'unknown',
    ...(parent!==undefined&&parent<100000?{parent}:{}),
    x:coordinate(node.position?.x),y:coordinate(node.position?.y),
    ...(parentMismatch?{parentMismatch:true}:{}),
    ...(node.dragging===true?{dragging:true}:{}),
    ...(node.selected===true||selected.has(node.id)?{selected:true}:{}),
    ...(typeof node.draggable==='boolean'?{draggable:node.draggable}:{}),
    ...(typeof node.selectable==='boolean'?{selectable:node.selectable}:{}),
    ...(node.extent==='parent'?{parentExtent:true}:{}),
    ...(statuses.has(status)?{status}:{}), ...(tools.has(tool)?{tool}:{}),
    ...(data.isUpload===true?{upload:true}:{}),
    ...(data.isPortraitAdjustResult===true?{portraitResult:true}:{}),
    ...(data.isPoseControlReference===true?{poseReference:true}:{}),
    ...(data.hidePromptInput===true?{promptHidden:true}:{}),
    ...(data.generating===true||data.isGenerating===true?{generating:true}:{}),
    ...(data.taskId?{hasTask:true}:{}), ...(data.modelCode||data.capabilityRef?{hasModel:true}:{}),
    ...(data.selectedHistoryOutputId||data.selectedOutputHistoryId?{historySelected:true}:{}),
    outputs:size(data.output), sources:size(data.sourceObjects), presets:size(data.presetSelections), historyCount:size(data.nodeOutputHistory),
  };
}

export function canvasFailureSnapshot(graph:NativeGraph|undefined, intent:SnapshotIntent, command?:NativeGraph, mounted?:NativeGraph) {
  if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))return;
  const indexes = new Map<string,number>();
  graph.nodes.forEach((node,i)=>{if(typeof node?.id==='string')indexes.set(node.id,i);});
  const selected=new Set(Array.isArray(intent.selected)?intent.selected:[]);
  const index=indexes.get(intent.targetId), target=index===undefined?undefined:graph.nodes[index];
  const nodes = new Set<number>(), links:{source:number;target:number}[]=[];
  const add=(i:number|undefined)=>{if(i!==undefined&&i<100000&&nodes.size<8)nodes.add(i);};
  const memberships=new Map<string,string>(),declared=new Set<string>();
  graph.nodes.forEach(n=>{
    if(!['group','rh-group'].includes(n?.type)||!Array.isArray(n.data?.nodeIds))return;
    declared.add(n.id);
    for(const child of n.data.nodeIds)if(typeof child==='string'&&!memberships.has(child))memberships.set(child,n.id);
  });
  const pointer=(n:any)=>n?.parentId??n?.parentNode??n?.data?.groupId;
  // The native crop group maintains an explicit member list. A stale child
  // pointer is valuable evidence but must not resurrect a removed member.
  const parent=(n:any)=>memberships.get(n?.id)??(!declared.has(pointer(n))?pointer(n):undefined);
  const mismatch=(n:any)=>!!pointer(n)&&!!(declared.has(pointer(n))||memberships.get(n?.id))&&memberships.get(n?.id)!==pointer(n);
  add(index);add(indexes.get(parent(target)));
  let incoming=0,outgoing=0,children=0;
  for(const edge of graph.edges){
    if(!edge)continue;
    if(edge.target===intent.targetId)incoming++;
    else if(edge.source===intent.targetId)outgoing++;
    else continue;
    const a=indexes.get(edge.source),b=indexes.get(edge.target);
    add(a);add(b);
    if(a!==undefined&&b!==undefined&&nodes.has(a)&&nodes.has(b)&&links.length<12)links.push({source:a,target:b});
  }
  graph.nodes.forEach((n,i)=>{if(n&&parent(n)===intent.targetId){children++;add(i);}});
  graph.nodes.forEach((n,i)=>{if(n&&(n.selected===true||selected.has(n.id)))add(i);});
  return {
    schemaVersion:'1' as const, phase:'PREPARE' as SnapshotPhase, control:intent.control, targetType:intent.targetType,
    ...(intent.click?{click:{visible:intent.click.visible===true,disabled:intent.click.disabled===true,...(typeof intent.click.ariaDisabled==='boolean'?{ariaDisabled:intent.click.ariaDisabled}:{})}}:{}),
    nodeCount:count(graph.nodes.length),edgeCount:count(graph.edges.length),incoming:count(incoming),outgoing:count(outgoing),children:count(children),
    ...(index!==undefined&&nodes.has(index)?{target:index}:{}),
    ...(Array.isArray(command?.nodes)&&Array.isArray(command.edges)?{commandNodes:count(command.nodes.length),commandEdges:count(command.edges.length)}:{}),
    ...(mounted&&Array.isArray(command?.nodes)&&Array.isArray(command.edges)?{projection:compareProjection(mounted,command,intent.targetId)}:{}),
    nodes:[...nodes].map(i=>describe(graph.nodes[i],i,selected,indexes,parent(graph.nodes[i]),mismatch(graph.nodes[i]))), links,
  };
}
export interface SnapshotDom {
  host:boolean; draggable?:boolean; dragging?:boolean; selected?:boolean;
  busyOverlay?:boolean; cancelVisible?:boolean; generateVisible:boolean; generateDisabled?:boolean;
  controlAriaDisabled?:boolean; readOnly?:boolean; group?:boolean;
}

export function observeSnapshotDom(root:Document,targetId:string,control:HTMLElement|undefined,visible:(el:HTMLElement)=>boolean,readOnly?:boolean,group?:boolean):SnapshotDom {
  const host=[...root.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')].find(el=>el.dataset.id===targetId);
  const hasVisible=(selector:string)=>!!host&&[...host.querySelectorAll<HTMLElement>(selector)].some(visible);
  const generateSelector='.generate-action-button:not(.rh-node-generating-cancel),.rh-node-fail-overlay__btn--retry,.group-toolbar .execute-btn';
  const generate=control?.matches(generateSelector)?control:host?.querySelector<HTMLElement>(generateSelector);
  const aria=control?.getAttribute('aria-disabled');
  return {
    host:!!host,generateVisible:!!generate&&visible(generate),
    ...(host?{
      draggable:host.classList.contains('draggable'),dragging:host.classList.contains('dragging'),selected:host.classList.contains('selected')||host.getAttribute('aria-selected')==='true',
      busyOverlay:hasVisible('.rh-node-running-overlay,.rh-node-generating-status,.rh-node-generating-dot-field'),
      cancelVisible:hasVisible('.rh-node-generating-cancel,.rh-node-running-badge-cancel'),
    }:{}),
    ...(generate?{generateDisabled:generate.matches(':disabled')||generate.getAttribute('aria-disabled')==='true'}:{}),
    ...(aria==='true'||aria==='false'?{controlAriaDisabled:aria==='true'}:{}),
    ...(typeof readOnly==='boolean'?{readOnly}:{}),...(typeof group==='boolean'?{group}:{}),
  };
}
export type CanvasFailureSnapshot = NonNullable<ReturnType<typeof canvasFailureSnapshot>> & {
  source?:'MOUNTED'|'COMMAND'; dom?:SnapshotDom; revision?:number; pendingSync?:boolean; syncBlocked?:boolean; syncBusy?:boolean;
};
