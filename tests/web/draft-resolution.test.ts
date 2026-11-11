import {expect,it} from 'vitest';
import {mergeCanvasDraft} from '../../apps/web/src/service/canvas-draft';
import {draftConflictDetails,resolveDraftGraph} from '../../apps/web/src/service/draft-resolution';
import type {NativeGraph} from '../../apps/web/src/service/graph';
const node=(id:string,data:any)=>({id,type:'rh-text',position:{x:0,y:0},data});
const graph=(nodes:any[],edges:any[]=[]):NativeGraph=>({nodes,edges});

it('resolves exact model and parameter choices atomically while keeping independent server outputs',()=>{
 const base=graph([node('a',{modelCode:'M1',capabilityRef:'M1',capabilityVersion:'1',params:{prompt:'base'}})]),local=structuredClone(base),server=structuredClone(base);
 Object.assign(local.nodes[0].data,{modelCode:'M2',capabilityRef:'M2',params:{prompt:'local'}});
 Object.assign(server.nodes[0].data,{modelCode:'M3',capabilityRef:'M3',params:{prompt:'server'},output:[{text:'generated'}]});server.nodes.push(node('remote',{text:'keep'}));
 const merged=mergeCanvasDraft(base,local,server),details=draftConflictDetails(merged.conflicts,merged.graph,server);
 expect(details.find(row=>row.reason==='MODEL_PARAMETERS')?.serverValue).toMatchObject({modelCode:'M3',params:{prompt:'server'}});
 const choices=Object.fromEntries(merged.conflicts.map(row=>[row.path,'server' as const])),resolved=resolveDraftGraph(merged.graph,server,merged.conflicts,choices);
 expect(resolved.nodes[0].data).toMatchObject({modelCode:'M3',capabilityRef:'M3',params:{prompt:'server'},output:[{text:'generated'}]});expect(resolved.nodes[1].id).toBe('remote');
});
it('requires every deletion/edge decision and rejects contradictory deletion of a locally retained edge endpoint',()=>{
 const a=node('a',{text:'a'}),b=node('b',{text:'b'}),base=graph([a,b]),local=graph([a,{...b,data:{text:'local'}}],[{id:'edge',source:'a',target:'b'}]),server=graph([a]);
 const merged=mergeCanvasDraft(base,local,server);
 expect(merged.conflicts).toContainEqual({path:'/nodes/b',reason:'DELETE_EDIT'});
 expect(()=>resolveDraftGraph(merged.graph,server,merged.conflicts,{})).toThrow('每项冲突');
 expect(()=>resolveDraftGraph(merged.graph,server,merged.conflicts,{'/nodes/b':'server'})).toThrow('对应节点');
 const kept=resolveDraftGraph(merged.graph,server,merged.conflicts,{'/nodes/b':'local'});expect(kept.nodes.some(row=>row.id==='b')).toBe(true);expect(kept.edges).toHaveLength(1);
});
it('does not resurrect a server-deleted unchanged node when the user rejects its dangling local connection',()=>{
 const a=node('a',{text:'a'}),b=node('b',{text:'b'}),base=graph([a,b]),local=graph([a,b],[{id:'edge',source:'a',target:'b'}]),server=graph([a]),merged=mergeCanvasDraft(base,local,server);
 expect(merged.conflicts).toContainEqual({path:'/edges/edge',reason:'DANGLING_REFERENCE'});
 const resolved=resolveDraftGraph(merged.graph,server,merged.conflicts,{'/edges/edge':'server'});expect(resolved.nodes.map(row=>row.id)).toEqual(['a']);expect(resolved.edges).toEqual([]);
});
