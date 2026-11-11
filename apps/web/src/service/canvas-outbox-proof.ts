import {sha256} from '@noble/hashes/sha2.js';
import type {ProjectGraph} from '../api/types';
import type {CanvasOperation} from './canvas-operations';

// Fingerprint only what this edit would replace. No second full canvas is
// stored locally. Insertion also depends on the existence of its endpoints;
// deleting a node must never remove new edges added after the writer left.
export function outboxInputProof(graph:ProjectGraph, operations:readonly CanvasOperation[]):string {
 const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
 const edges=new Map(graph.edges.map(edge=>[edge.id,edge]));
 const valueAt=(obj:unknown,path:string[])=>{
  let value:any=obj;
  for(const [index,key] of path.entries()){
   // Applying a nested patch would replace a scalar or array at this point.
   // Missing fields in an otherwise compatible object can be merged safely.
   if(value===null||typeof value!=='object'||Array.isArray(value))return ['ancestor',index,value];
   if(!Object.hasOwn(value,key))return [false];
   value=value[key];
  }
  return [true,value];
 };
 function stable(value:any):any {
  if(Array.isArray(value))return value.map(stable);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
 }
 const facts=operations.map(op=>{
  switch(op.type){
   case 'node.create':return nodes.get(op.node.id)??null;
   case 'node.delete':return [nodes.get(op.nodeId)??null,graph.edges.filter(e=>e.source===op.nodeId||e.target===op.nodeId).sort((a,b)=>a.id.localeCompare(b.id))];
   case 'edge.create':return [edges.get(op.edge.id)??null,nodes.has(op.edge.source),nodes.has(op.edge.target)];
   case 'edge.delete':return edges.get(op.edgeId)??null;
   case 'nodes.order':return graph.nodes.map(node=>node.id);
   case 'edges.order':return graph.edges.map(edge=>edge.id);
   case 'node.patch':case 'graph.patch':{
    const row=op.type==='graph.patch'?graph:nodes.get(op.nodeId);
    if(!row)return null;
    return [op.type==='node.patch'?nodes.get(op.nodeId)?.type:'graph',
     [...op.set.map(field=>field.path),...op.unset].map(path=>valueAt(row,path))];
   }
  }
 });
 return Array.from(sha256(new TextEncoder().encode(JSON.stringify(stable(facts)))),b=>b.toString(16).padStart(2,'0')).join('');
}
