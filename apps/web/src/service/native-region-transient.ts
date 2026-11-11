import type {NativeGraph} from './graph';

/** Exact tar() temporary point-recognition node in the frozen native editor.
 * Other localOnly nodes have not been reviewed and keep their normal meaning. */
export function isNativeRegionTransient(node:any):boolean {
 return node?.type==='rh-text'&&node.data?.localOnly===true
  &&node.data?.transientKind==='region-recognize'
  &&node.data?.subType==='image-recognition'
  &&node.data?.sceneCode==='canvas-image-region-recognize';
}

/** Storage projection only. Execution still freezes the original tool node. */
export function persistentRegionGraph(graph:NativeGraph):NativeGraph {
 const omitted=new Set(graph.nodes.filter(isNativeRegionTransient).map(node=>node.id));
 if(!omitted.size)return graph;
 return{...graph,nodes:graph.nodes.filter(node=>!omitted.has(node.id)),edges:graph.edges.filter(edge=>!omitted.has(edge.source)&&!omitted.has(edge.target))};
}

/** Keep a running native lk()/ACt tool in this tab during remote reconciliation.
 * Never resurrect a remotely persisted tool absent from the local manager. */
export function withLocalRegionTransients(graph:NativeGraph,local:NativeGraph):NativeGraph {
 const persistent=persistentRegionGraph(graph),transient=local.nodes.filter(isNativeRegionTransient);
 if(!transient.length)return persistent;
 const ids=new Set(persistent.nodes.map(node=>node.id)),tools=transient.filter(node=>!ids.has(node.id));
 if(!tools.length)return persistent;
 const toolIds=new Set(tools.map(node=>node.id));for(const id of toolIds)ids.add(id);
 const edgeIds=new Set(persistent.edges.map(edge=>edge.id));
 const edges=local.edges.filter(edge=>!edgeIds.has(edge.id)&&(toolIds.has(edge.source)||toolIds.has(edge.target))&&ids.has(edge.source)&&ids.has(edge.target));
 return{...persistent,nodes:[...persistent.nodes,...tools],edges:[...persistent.edges,...edges]};
}
