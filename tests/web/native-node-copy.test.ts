import {expect,it,vi} from 'vitest';
import {nativeCopy,normalize,nativeImageUploadOnly} from './helpers/native-copy-fixture';
import {installNativeNodeCopy,nativeCopySource,prepareNativeCopy} from '../../apps/web/src/service/native-node-copy';
import {ModelBindings} from '../../apps/web/src/service/model-bindings';
import {decodeGraph,encodeGraph} from '../../apps/web/src/service/graph';
import {orderCanvasMediaReferences} from '../../apps/web/src/service/canvas-media-reference';
import {videoModelInputAvailability} from '../../apps/web/src/service/video-model-input-availability';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
import {withNativeModelSelectionIntent} from '../../apps/web/src/service/model-catalog-view';

const node=(id:string,type='rh-video',data:any={})=>({id,type,position:{x:0,y:0},data});
const edge=(source:string,target:string)=>({id:source+'-'+target,source,target,sourceHandle:'output',targetHandle:'input'});
function fixture(){
 const a=node('a','rh-image',{isUpload:true,sourceObjects:['rhtv-asset:a']}),b=node('b','rh-image',{isUpload:true,sourceObjects:['rhtv-asset:b']}),v=node('v','rh-video',{status:'finished',modelCode:'test-video',capabilityRef:'test-video',capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'Animate',imageUrls:['rhtv-asset:stale']},imageOrder:['b::rhtv-asset:b','a::rhtv-asset:a'],taskId:'old-task',estimateTaskId:'old-estimate',generationStartedAt:10,estimatedSeconds:120,errorMsg:'old failure',progress:.9,output:[{url:'rhtv-asset:result',historyOutputId:'out',taskId:'old-task'}],selectedHistoryOutputId:'out',historyStorage:{source:'remote'}}),downstream=node('downstream');
 let graph={nodes:[a,b,v,downstream],edges:[edge('a','v'),edge('b','v'),edge('v','downstream')]};
 const bindings=new ModelBindings();bindings.seed('p',graph);
 let rows=structuredClone(graph);const original=structuredClone(graph);
 const port={node:(n:any)=>bindings.node('p',n),record:vi.fn((n:any,p:any)=>bindings.record('p',n,p)),current:()=>true};
 const manager:any={getRemoteData:()=>normalize(rows),getFullNodesByIds:(ids:string[])=>new Map(rows.nodes.filter((n:any)=>ids.includes(n.id)).map((n:any)=>[n.id,structuredClone(n)])),pasteGraph:(nodes:any[],edges:any[])=>manager.enqueue({kind:'pasteGraph',nodes,edges}),enqueue:vi.fn((op:any)=>{rows={nodes:[...rows.nodes,...structuredClone(op.nodes)],edges:[...rows.edges,...structuredClone(op.edges)]};return true;})};
 const native={bt:()=>manager,r:{useCallback:(fn:any)=>fn}},surface=new EventTarget();
 const release=installNativeNodeCopy({modelBindingPort:()=>port,canvasAttachment:()=>({client:manager,id:'p'})},native,surface as any);
 const copy=nativeCopy(manager);
 return{manager,native,port,copy,release,original,bindings,reload:()=>{graph=decodeGraph(encodeGraph(manager.getRemoteData())) as any;bindings.seed('p',graph);rows=normalize(graph);},rows:()=>rows};
}
it.each(['finished','processing','failed'])('copies exact model and clears execution ownership from a %s connected video, including after native reload',status=>{
 const f=fixture();try{const source=f.manager.getFullNodesByIds(['v']).get('v');source.data.status=status;
 const sourceBefore=structuredClone(source),copied=f.copy.clone({nodes:[source],edges:f.original.edges},{x:600,y:0},f.manager.getRemoteData().nodes,{exactPosition:true});
 f.manager.pasteGraph(copied.nodes,copied.edges);const id=copied.nodes[0].id;
 expect(source).toEqual(sourceBefore);expect(copied.edges.map((e:any)=>[e.source,e.target])).toEqual([['a',id],['b',id]]);
 for(const read of [()=>f.manager.getRemoteData(),()=>{f.reload();return f.manager.getRemoteData();}]){const graph=read(),data=graph.nodes.find((n:any)=>n.id===id).data;
 expect(data).toMatchObject({modelCode:'test-video',capabilityVersion:'1',parameterSchemaVersion:'1',status:'idle',output:[{url:'rhtv-asset:result'}],params:{prompt:'Animate'},imageOrder:['b::rhtv-asset:b','a::rhtv-asset:a']});
 for(const key of ['taskId','estimateTaskId','errorMsg','historyStorage','progress','generationStartedAt','estimatedSeconds','__studioCopySource'])expect(data[key],key).toBeUndefined();
 expect(graph.edges.filter((e:any)=>e.target==='downstream')).toHaveLength(1);
 }
 }finally{f.release();}
});
it('remaps string, object and compound reference orders when copying a group, without changing asset identities',()=>{
 const f=fixture();try{const sources=f.copy.read(f.original.nodes.slice(0,3));sources[2].data.imageOrder=[{nodeId:'b',url:'rhtv-asset:b',_key:'b::rhtv-asset:b'},'a::rhtv-asset:a'];sources[2].data.audioOrder=['b'];sources[2].data.videoOrder=['b::https://media.invalid/clip'];
 const c=f.copy.clone({nodes:sources,edges:f.original.edges},{x:1000,y:0},f.original.nodes,{exactPosition:true});f.manager.pasteGraph(c.nodes,c.edges);
 const [a,b,v]=c.nodes;expect(v.data.imageOrder).toEqual([{nodeId:b.id,url:'rhtv-asset:b',_key:b.id+'::rhtv-asset:b'},a.id+'::rhtv-asset:a']);expect(v.data.audioOrder).toEqual([b.id]);expect(v.data.videoOrder).toEqual([b.id+'::https://media.invalid/clip']);
 expect(orderCanvasMediaReferences([{nodeId:a.id,url:'rhtv-asset:a'},{nodeId:b.id,url:'rhtv-asset:b'}],v.data.imageOrder).map(row=>row.url)).toEqual(['rhtv-asset:b','rhtv-asset:a']);
 expect(c.edges).toHaveLength(2);expect(a.data.isUpload).toBe(true);
 }finally{f.release();}
});
it('Alt-drag retains inputs and never connects the copy to existing downstream nodes',()=>{
 const f=fixture();try{const c=f.copy.drag([{nodeId:'v',position:{x:800,y:0}}],f.manager.getRemoteData().nodes);expect(c.edges).toHaveLength(0);f.manager.pasteGraph(c.nodes,c.edges);expect(c.edges.map((e:any)=>e.source)).toEqual(['a','b']);expect(c.nodes[0].data.capabilityVersion).toBe('1');}finally{f.release();}
});
it.each(['menu','toolbar'])('preserves the binding through the actual direct %s duplicate callback seam',kind=>{
 const f=fixture();try{const graph=f.manager.getRemoteData(),v=normalize(graph).nodes.find((n:any)=>n.id==='v'),vZn=(node:any,edges:any[],nodes:any[])=>{const c=f.copy.duplicate(node,edges,nodes);f.manager.pasteGraph(c.nodes,c.edges);},vbt=f.copy.duplicate;
 const fn=kind==='menu'?()=>vZn(v,graph.edges,graph.nodes):(value:any)=>{const c=vbt(value,graph.edges,graph.nodes);f.manager.pasteGraph(c.nodes,c.edges);};
 f.native.r.useCallback(fn,kind==='menu'?[v,graph.edges,graph.nodes,false,()=>{}]:[undefined,undefined,undefined,()=>graph])(v);
 const copied=f.manager.getRemoteData().nodes.at(-1);expect(copied.data).toMatchObject({capabilityVersion:'1',status:'idle'});expect(copied.data.taskId).toBeUndefined();
 }finally{f.release();}
});
it('does not record a rejected paste or change the source node',()=>{
 const f=fixture();try{f.manager.enqueue=vi.fn(()=>false);const c=f.copy.clone({nodes:f.copy.read([f.original.nodes[2]]),edges:[]},null,f.original.nodes,{exactPosition:true});f.manager.pasteGraph(c.nodes,c.edges);expect(f.rows().nodes).toHaveLength(4);expect(f.port.record).not.toHaveBeenCalled();expect(f.manager.getRemoteData().nodes[2].data.taskId).toBe('old-task');}finally{f.release();}
});
it('does not retain external links when pasting into another project',()=>{
 const f=fixture();try{const c=f.copy.clone({nodes:f.copy.read([f.original.nodes[2]]),edges:f.original.edges},null,f.original.nodes,{exactPosition:true});const result=prepareNativeCopy(c.nodes,c.edges,f.original,'other');expect(result.edges).toEqual([]);expect(result.nodes[0].data.capabilityVersion).toBe('1');}finally{f.release();}
});
it('fails closed for an unresolved historical model and strips clipboard metadata from persisted graph',()=>{
 const source=node('old','rh-video',{modelCode:'m',taskId:'task'}),graph={nodes:[source],edges:[]},copy=nativeCopySource(source,'p',graph);expect(()=>prepareNativeCopy([{...copy,id:'new'}],[],graph,'p')).toThrow(/原节点/);expect(encodeGraph({nodes:[copy],edges:[]}).nodes[0].data).not.toHaveProperty('__studioCopySource');
});
it('invalidates first/last-frame availability when equal-count references change',()=>{
 const model={available:true,capabilityRef:'m',parameterSchema:{'x-media-limits':{IMAGE:2},'x-video-mode':'FIRST_LAST_FRAME'},inputKinds:['TEXT','IMAGE']},groups=[{nodeModelList:[{modelList:[model]}]}],target=node('v'),a=node('a','rh-image',{sourceObjects:['rhtv-asset:a']}),b=node('b','rh-image',{sourceObjects:['rhtv-asset:a']}),props={nodes:[a,b,target],edges:[edge('a','v'),edge('b','v')],videoModelGroups:groups};
 expect(videoModelInputAvailability(props,target).videoModelGroups[0].nodeModelList[0].modelList[0].disabled).toBe(true);b.data.sourceObjects=['rhtv-asset:b'];expect(videoModelInputAvailability(props,target).videoModelGroups[0].nodeModelList[0].modelList[0].disabled).not.toBe(true);
});
it.each(['API','SELF_HOSTED'])('only explicit same-model selection repairs an unversioned completed %s video',kind=>{
 const n=node('v','rh-video',{modelCode:'m',taskId:'old',status:'finished',output:[{url:'rhtv-asset:old'}]}),record=vi.fn(),original=vi.fn(()=>true),model={modelCode:'m',capabilityRef:'m',capabilityVersion:'7',parameterSchemaVersion:'7',available:true,'x-model-source':{kind}},port={current:()=>true,node:(n:any)=>n,record};
 const props=nativeModelProps({targetNode:n,models:{'image-video':[model]},onNodeDataPatch:original},port);props.onNodeDataPatch('v',{modelCode:'m',params:{prompt:'edit'}});expect(record).not.toHaveBeenCalled();
 withNativeModelSelectionIntent('v','m',()=>props.onNodeDataPatch('v',{modelCode:'m'}));expect(record).toHaveBeenCalledWith(n,expect.objectContaining({capabilityVersion:'7',taskId:'',estimateTaskId:'',status:'idle'}));
});
it.each([false,Promise.resolve(true)])('does not commit a text selection whose native mutation is rejected or deferred',result=>{
 const n=node('n','rh-text',{modelCode:'old'}),record=vi.fn(),model={modelCode:'new',capabilityRef:'new',capabilityVersion:'2',parameterSchemaVersion:'2',available:true},props=nativeModelProps({targetNode:n,nodes:[n],edges:[],models:{'text-text':[model]},onNodeDataPatch:()=>result},{current:()=>true,node:n=>n,record});props.onNodeDataPatch('n',{modelCode:'new'});expect(record).not.toHaveBeenCalled();
});

it('rejects a pre-upgrade clipboard instead of copying an unverifiable task as a new model selection',()=>{
 const old=node('old','rh-video',{modelCode:'m',taskId:'old-task'});expect(()=>prepareNativeCopy([old],[],{nodes:[],edges:[]},'p',[],true)).toThrow(/重新复制/);
 expect(prepareNativeCopy([old],[],{nodes:[],edges:[]},'p')).toEqual({nodes:[old],edges:[]});
});

it.each(['clipboard','menu','drag'])('keeps the generation composer for a completed image copied by %s, including save and reload',method=>{
 const original=node('image','rh-image',{modelCode:'codex-image-generate-v1',capabilityRef:'codex-image-generate-v1',capabilityVersion:'3',parameterSchemaVersion:'3',subType:'text-image',status:'finished',taskId:'old-task',params:{prompt:'A city',text:'A city',transparentBackground:false},output:[{url:'rhtv-asset:result',historyOutputId:'sample'}],sourceObjects:['rhtv-asset:result'],selectedHistoryOutputId:'sample'}),graph={nodes:[original],edges:[]};
 const source=nativeCopySource(original,'p',graph),manager={getFullNodesByIds:()=>new Map([[original.id,source]])},native=nativeCopy(manager);
 const copied=method==='menu'?native.duplicate(original,[],graph.nodes):method==='drag'?native.drag([{nodeId:original.id,position:{x:600,y:0}}],graph.nodes):native.clone({nodes:native.read([original]),edges:[]},null,graph.nodes);
 const prepared=prepareNativeCopy(copied.nodes,copied.edges,graph,'p',method==='menu'?[source]:[]),copy=prepared.nodes[0];
 for(const current of [copy,decodeGraph(encodeGraph({nodes:[copy],edges:[]})).nodes[0]]){
  expect(nativeImageUploadOnly(current,[])).toBe(false);expect(current.data.sourceObjects).toBeUndefined();expect(current.data.taskId).toBeUndefined();
  expect(current.data).toMatchObject({modelCode:'codex-image-generate-v1',capabilityVersion:'3',status:'idle',params:original.data.params,output:[{url:'rhtv-asset:result'}]});
 }
 expect(original.data.sourceObjects).toEqual(['rhtv-asset:result']);expect(original.data.taskId).toBe('old-task');
});
it.each([true,undefined])('preserves uploaded or independent source material during image copy (%s)',isUpload=>{
 const original=node('image','rh-image',{modelCode:'model',capabilityVersion:'1',isUpload,output:[{url:'rhtv-asset:result'}],sourceObjects:[isUpload?'rhtv-asset:result':'rhtv-asset:input']}),graph={nodes:[original],edges:[]},source=nativeCopySource(original,'p',graph);
 const result=prepareNativeCopy([{...source,id:'copy'}],[],graph,'p');expect(result.nodes[0].data.sourceObjects).toEqual(original.data.sourceObjects);
});
