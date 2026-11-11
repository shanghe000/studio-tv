import type {GraphNode,ProjectGraph} from '../api/types';
import {validCanvasNode,validCanvasEdge} from './canvas-operations';

// Deltas describe changes to the last server document, never to the native
// editor (which may contain input or pending operations). Fall back to the full
// authorized snapshot if any precondition is not demonstrably true.
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const id=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=200;
const keys=(x:Record<string,any>,allowed:string[])=>Object.keys(x).every(k=>allowed.includes(k));
const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v);
const point=(p:any)=>object(p)&&finite(p.x)&&finite(p.y);
const list=(v:any):v is any[]=>Array.isArray(v)&&v.length<=10000;
const distinct=(items:string[])=>new Set(items).size===items.length;
function rows<T extends {id:string}>(current:T[],upsert:T[],removed:string[],order:unknown):T[]|null {
 const byID=new Map(current.map(x=>[x.id,x]));if(byID.size!==current.length||!distinct([...upsert.map(x=>x.id),...removed]))return null;
 for(const key of removed)if(!byID.delete(key))return null;
 for(const item of upsert)byID.set(item.id,item);
 if(order===undefined)return [...byID.values()];
 if(!list(order)||order.length!==byID.size||!distinct(order)||!order.every(k=>id(k)&&byID.has(k)))return null;
 return order.map(k=>byID.get(k)!);
}
export function applyLiveGraphDelta(base:ProjectGraph,delta:unknown):ProjectGraph|null {
 if(!object(delta)||!keys(delta,['upsertNodes','removeNodeIds','upsertEdges','removeEdgeIds','positions','nodeOrder','edgeOrder']))return null;
 const {upsertNodes,removeNodeIds,upsertEdges,removeEdgeIds,positions}=delta;
 if(![upsertNodes,removeNodeIds,upsertEdges,removeEdgeIds,positions].every(list)||!upsertNodes.every(validCanvasNode)||!upsertEdges.every(validCanvasEdge)||!removeNodeIds.every(id)||!removeEdgeIds.every(id)||!positions.every((p:any)=>point(p)&&id(p.id)))return null;
 if(!distinct([...positions.map((p:any)=>p.id),...upsertNodes.map((n:GraphNode)=>n.id),...removeNodeIds]))return null;
 let nodes=rows(base.nodes,upsertNodes,removeNodeIds,delta.nodeOrder);
 const edges=rows(base.edges,upsertEdges,removeEdgeIds,delta.edgeOrder);
 if(!nodes||!edges)return null;
 const ids=new Set(nodes.map(n=>n.id));if(!edges.every(e=>ids.has(e.source)&&ids.has(e.target))||positions.some((p:any)=>!ids.has(p.id)))return null;
 if(positions.length){const moves=new Map<string,{x:number;y:number}>(positions.map((p:any)=>[p.id,{x:p.x,y:p.y}]));nodes=nodes.map(n=>moves.has(n.id)?{...n,position:moves.get(n.id)!}:n);}
 return {...base,nodes,edges};
}
