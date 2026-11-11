import {expect,it} from 'vitest';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';
import type {NativeGraph} from '../../apps/web/src/service/graph';
const node=(id:string,text=id)=>({id,type:'rh-text',position:{x:0,y:0},data:{text,title:id}});
const graph=(nodes:any[],edges:any[]=[]):NativeGraph=>({nodes,edges,viewport:{x:0,y:0,zoom:1}});
const edge=(id:string,source:string,target:string)=>({id,source,target,sourceHandle:null,targetHandle:null});

it('rebases disjoint fields and remote-created nodes without mutating any input',()=>{
 const base=graph([node('a')]),local=structuredClone(base),remote=structuredClone(base);local.nodes[0].data.text='Local';remote.nodes[0].data.title='Remote title';remote.nodes.push(node('b'));
 const original=structuredClone([base,local,remote]),merged=mergeCanvasDraft(base,local,remote);
 expect(merged.conflicts).toEqual([]);expect(merged.graph.nodes[0].data).toEqual({text:'Local',title:'Remote title'});expect(merged.graph.nodes[1].id).toBe('b');expect([base,local,remote]).toEqual(original);
});
it('retains local text on a same-field conflict without concatenating it',()=>{
 const base=graph([node('a')]),local=graph([node('a','Local')]),remote=graph([node('a','Remote')]),merged=mergeCanvasDraft(base,local,remote);
 expect(merged.conflicts).toContainEqual({path:'/nodes/a/data/text',reason:'FIELD_CHANGED'});expect(merged.graph.nodes[0].data.text).toBe('Local');
});
it.each(['local','remote'])('retains the local decision when %s deletes an edited node',direction=>{
 const base=graph([node('a')]),local=direction==='local'?graph([]):graph([node('a','Local edit')]),remote=direction==='remote'?graph([]):graph([node('a','Remote edit')]),merged=mergeCanvasDraft(base,local,remote);
 expect(merged.conflicts).toContainEqual({path:'/nodes/a',reason:'DELETE_EDIT'});expect(merged.graph.nodes).toEqual(local.nodes);
});
it('treats coordinate tuples and media arrays as indivisible conflict values',()=>{
 const base=graph([{...node('a'),data:{references:['asset1']}}]),local=structuredClone(base),remote=structuredClone(base);local.nodes[0].position.x=10;remote.nodes[0].position.y=20;local.nodes[0].data.references.push('asset2');remote.nodes[0].data.references.push('asset3');
 const merged=mergeCanvasDraft(base,local,remote);expect(merged.graph.nodes[0].position).toEqual({x:10,y:0});expect(merged.graph.nodes[0].data.references).toEqual(['asset1','asset2']);expect(merged.conflicts).toHaveLength(2);
});
it.each(['params','routerParameters'])('prevents combining a changed model version with another editor’s %s',parameterKey=>{
 const base=graph([{...node('a'),data:{modelCode:'M',capabilityRef:'M',capabilityVersion:'1',parameterSchemaVersion:'1',[parameterKey]:{effort:'low'}}}]),local=structuredClone(base),remote=structuredClone(base);local.nodes[0].data[parameterKey].effort='high';remote.nodes[0].data.capabilityVersion='2';remote.nodes[0].data.parameterSchemaVersion='2';
 const merged=mergeCanvasDraft(base,local,remote);expect(merged.conflicts).toContainEqual({path:'/nodes/a/data/modelSelection',reason:'MODEL_PARAMETERS'});expect(merged.graph.nodes[0].data.capabilityVersion).toBe('1');expect(merged.graph.nodes[0].data[parameterKey].effort).toBe('high');
});
it('merges the same frozen model selection restored by native UI and server completion',()=>{
 const base=graph([{...node('a'),type:'rh-video',data:{modelCode:'h3-first-frame-v1',params:{outputPreset:'480p-landscape-5s'}}}]),local=structuredClone(base),remote=structuredClone(base);
 const resolved={capabilityRef:'h3-first-frame-v1',capabilityVersion:'1',parameterSchemaVersion:'1'};
 Object.assign(local.nodes[0].data,resolved);Object.assign(remote.nodes[0].data,resolved,{routerParameters:{outputPreset:'480p-landscape-5s'},videoUrl:'rhtv-asset:result'});local.nodes.push(node('new'));
 const merged=mergeCanvasDraft(base,local,remote);expect(merged.conflicts).toEqual([]);expect(merged.graph.nodes[0].data.videoUrl).toBe('rhtv-asset:result');expect(merged.graph.nodes[0].data.routerParameters).toEqual({outputPreset:'480p-landscape-5s'});expect(merged.graph.nodes[1].id).toBe('new');
});
it('still detects parameter conflicts under identical newly resolved selections',()=>{
 const base=graph([{...node('a'),data:{modelCode:'M',params:{effort:'low'}}}]),local=structuredClone(base),remote=structuredClone(base);
 for(const g of [local,remote])Object.assign(g.nodes[0].data,{capabilityRef:'M',capabilityVersion:'2',parameterSchemaVersion:'2'});
 local.nodes[0].data.params.effort='high';remote.nodes[0].data.params.effort='medium';
 expect(mergeCanvasDraft(base,local,remote).conflicts).toContainEqual({path:'/nodes/a/data/params/effort',reason:'FIELD_CHANGED'});
});
it('pauses a child’s relative movement when another editor moves its group',()=>{
 const base=graph([{...node('g'),type:'group',data:{nodeIds:['a']}},{...node('a'),parentId:'g'}]),local=structuredClone(base),remote=structuredClone(base);local.nodes[1].position.x=10;remote.nodes[0].position.x=500;
 const merged=mergeCanvasDraft(base,local,remote);expect(merged.conflicts).toContainEqual({path:'/nodes/a/position',reason:'GROUP_POSITION'});expect(merged.graph.nodes.find(value=>value.id==='a')?.position.x).toBe(10);
});
it('retains a valid local edge when independently edited endpoints would otherwise dangle',()=>{
 const base=graph(['a','b','c','d'].map(id=>node(id)),[edge('e','a','b')]),local=graph(['a','b','c'].map(id=>node(id)),[edge('e','c','b')]),remote=graph(base.nodes,[edge('e','a','d')]),merged=mergeCanvasDraft(base,local,remote);
 expect(merged.conflicts).toContainEqual({path:'/edges/e',reason:'DANGLING_REFERENCE'});expect(merged.graph.edges).toEqual(local.edges);expect(merged.graph.nodes.some(value=>value.id==='d')).toBe(false);
});
it('preserves a local order change together with remotely added nodes',()=>{
 const base=graph(['a','b','c'].map(id=>node(id))),local=graph([base.nodes[2],base.nodes[0],base.nodes[1]]),remote=graph([base.nodes[0],node('remote'),base.nodes[1],base.nodes[2]]),merged=mergeCanvasDraft(base,local,remote);
 expect(merged.conflicts).toEqual([]);expect(merged.graph.nodes.map(value=>value.id)).toEqual(['c','a','remote','b']);
});
it('preserves remote edge order when local node content alone changes',()=>{
 const base=graph(['a','b','c'].map(id=>node(id)),[edge('e1','a','b'),edge('e2','b','c')]),local=structuredClone(base),remote=graph(base.nodes,[base.edges[1],base.edges[0]]);local.nodes[0].data.text='Local';
 expect(mergeCanvasDraft(base,local,remote).graph.edges.map(value=>value.id)).toEqual(['e2','e1']);
});
it('retains local order and reports concurrent incompatible reorderings',()=>{
 const base=graph(['a','b','c'].map(id=>node(id))),local=graph([base.nodes[1],base.nodes[0],base.nodes[2]]),remote=graph([base.nodes[0],base.nodes[2],base.nodes[1]]),merged=mergeCanvasDraft(base,local,remote);
 expect(merged.conflicts).toContainEqual({path:'/nodes/order',reason:'FIELD_CHANGED'});expect(merged.graph.nodes.map(value=>value.id)).toEqual(['b','a','c']);
});
