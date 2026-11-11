import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {completeNativeGroupCommand} from '../../apps/web/src/service/native-group-command';

const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const section=(a:string,b:string)=>{const start=compiled.indexOf(a),end=compiled.indexOf(b,start+a.length);if(start<0||end<0)throw new Error('Frozen native group seam changed');return compiled.slice(start,end);};
// Execute the actual pinned GE -> cHe -> Rdt projection. Only unrelated model
// semantic helpers are stubbed; the geometry/edge projection is native code.
const source=section('function W5(','function sd(')+section('function Hte(','function d2t(')+section('function bDe(','function Ukn(')+section('async function cHe(','async function Zle(')+section('const jMr=','function p2t(')+section('function GE(','const UMr=');
const native=new Function('scope',`with(scope){${source};return{GE,cHe,ADe};}`)({LMr:new Set(),Ar:()=>false,Ui:()=>false,FMr:()=>null,sd:()=>[],EV:()=>null,_V:()=>null,MCe:(value:any)=>value,pNn:()=>'',gW:()=>{}});

function mounted():NativeGraph{
 // Minimal structural fixture from the real S06 two-shot diagnostic: two
 // absolute-position rh-images, a script ancestor, and data.groupId ownership.
 return{nodes:[
  {id:'script',type:'rh-script',position:{x:1326.6388588783082,y:1098.5},data:{status:'finished',params:{prompt:'two-shot source script'},output:{rows:[{id:'studio-shot-1'},{id:'studio-shot-2'}]}}},
  ...[0,1].map(index=>({id:'shot-'+(index+1),type:'rh-image',position:{x:2356.6388588783084+410*index,y:1028.5},data:{status:'idle',groupId:'storyboard-group',modelCode:'codex-image-edit-v1',subType:'image-image',toolsType:'image-image',sceneCode:'storyboard-prompt-board',isStoryboard:true,params:{prompt:'original shot '+(index+1),imageUrls:['rhtv-asset:reference-'+index],transparentBackground:false},generateNum:1}})),
  {id:'storyboard-group',type:'group',position:{x:2306.6388588783084,y:978.5},data:{groupType:'storyboard',nodeIds:['shot-1','shot-2'],width:890,height:314,nodeOffsets:{'shot-1':{x:50,y:50},'shot-2':{x:460,y:50}}}},
 ],edges:[1,2].map(index=>({id:'script-to-'+index,source:'script',target:'shot-'+index,sourceHandle:'output',targetHandle:'input',type:'default'}))};
}
async function command(graph=mounted(),members=['shot-1','shot-2']){
 let posted:any;const ctx={canvasId:'p',getNodes:()=>graph.nodes,getEdges:()=>graph.edges,
  generateGroupRunParams:(ids:string[],groupId:string)=>native.GE(ctx,ids,groupId),
  getRunParams:(id:string)=>{const target=native.ADe(graph.nodes.find(node=>node.id===id)),ancestor=native.ADe(graph.nodes.find(node=>node.id==='script'));target.data.params.prompt+='\ncompiled native style';return{nodes:[target,ancestor],edges:graph.edges.filter(edge=>edge.target===id).map(({source,target})=>({source,target}))};},
  markLocalRunning:()=>{},unmarkLocalRunning:()=>{},runCanvasTask:async(body:any)=>{posted=structuredClone(body);return{taskId:'readonly-test-task'};}};
 await native.cHe(ctx,{nodeIds:members,groupId:'storyboard-group',patchNode:()=>{}});
 return posted.canvas as NativeGraph;
}

it('completes the actual GE/cHe/Rdt command without changing native prompt/model/media data',async()=>{
 const graph=mounted(),raw=await command(graph),before=structuredClone(raw);
 expect(raw.nodes.filter(node=>node.type==='rh-image').every(node=>node.position===undefined)).toBe(true);
 expect(raw.nodes.some(node=>node.type==='group')).toBe(false);
 expect(()=>encodeGraph(raw)).toThrow("reading 'x'");
 const complete=completeNativeGroupCommand(raw,graph,'storyboard-group')!;
 expect(()=>encodeGraph(complete)).not.toThrow();
 expect(complete.nodes.filter(node=>node.parentId==='storyboard-group').map(node=>node.id)).toEqual(['shot-1','shot-2']);
 for(const node of raw.nodes)expect(complete.nodes.find(value=>value.id===node.id)?.data).toEqual(node.data);
 expect(complete.nodes.find(node=>node.id==='shot-1')?.data.params.prompt).toContain('compiled native style');
 expect(complete.nodes.find(node=>node.id==='script')?.parentId).toBeUndefined();
 expect(complete.edges).toEqual(graph.edges);expect(raw).toEqual(before);
 expect(complete.nodes.find(node=>node.id==='shot-1')?.position).toEqual(graph.nodes.find(node=>node.id==='shot-1')?.position);
});
it('supports the same real GE constructor for ordinary groups',async()=>{
 const graph=mounted();graph.nodes.find(node=>node.type==='group')!.data.groupType='normal';
 const raw=await command(graph),complete=completeNativeGroupCommand(raw,graph,'storyboard-group')!;
 expect(complete.nodes.find(node=>node.type==='group')?.data.groupType).toBe('normal');
 expect(complete.nodes.filter(node=>node.parentId==='storyboard-group')).toHaveLength(2);
});
it('keeps an explicit selected subset and never makes an ancestor a group member',async()=>{
 const graph=mounted(),raw=await command(graph,['shot-2']),complete=completeNativeGroupCommand(raw,graph,'storyboard-group')!;
 expect(complete.nodes.find(node=>node.type==='group')?.data.nodeIds).toEqual(['shot-2']);
 expect(complete.nodes.filter(node=>node.parentId==='storyboard-group').map(node=>node.id)).toEqual(['shot-2']);
 expect(complete.nodes.some(node=>node.id==='shot-1')).toBe(false);
});
it('leaves complete caller graphs and absent optional inputs unchanged',()=>{
 const graph=mounted();expect(completeNativeGroupCommand(graph,graph,'storyboard-group')).toBe(graph);
 expect(completeNativeGroupCommand(undefined,graph,'storyboard-group')).toBeUndefined();
 expect(completeNativeGroupCommand(graph,undefined,'storyboard-group')).toBe(graph);
});

const invalidCases:Record<string,(raw:NativeGraph,graph:NativeGraph)=>void>={
 'unknown node':raw=>raw.nodes.push({id:'forged',type:'rh-image',data:{}}),
 'changed node type':raw=>raw.nodes[0].type='rh-video',
 'duplicate command id':raw=>raw.nodes.push(structuredClone(raw.nodes[0])),
 'deleted mounted member':(_raw,graph)=>{graph.nodes=graph.nodes.filter(node=>node.id!=='shot-2');},
 'cross-group mounted ownership':(_raw,graph)=>{graph.nodes.find(node=>node.id==='shot-1')!.data.groupId='other';},
 'cross-group command ownership':raw=>{raw.nodes.find(node=>node.id==='shot-1')!.data.groupId='other';},
 'contradictory command parent':raw=>{raw.nodes[0].parentId='other';},
 'contradictory mounted parent':(_raw,graph)=>{graph.nodes.find(node=>node.id==='shot-1')!.parentNode='other';},
 'forged ancestor membership':raw=>{raw.nodes.find(node=>node.id==='script')!.data.groupId='storyboard-group';},
 'missing ancestor geometry':raw=>{delete raw.nodes.find(node=>node.id==='script')!.position;},
 'explicit null geometry':raw=>{raw.nodes[0].position=null;},
 'changed explicit geometry':raw=>{raw.nodes[0].position={x:1,y:2};},
 'invalid mounted geometry':(_raw,graph)=>{graph.nodes[0].position.x=Number.NaN;},
 'entity group':(_raw,graph)=>{graph.nodes.find(node=>node.type==='group')!.data.storyboardEntityGroup=true;},
 'entity member':(_raw,graph)=>{graph.nodes.find(node=>node.id==='shot-1')!.data.storyboardEntityNode=true;},
 'unsupported group type':(_raw,graph)=>{graph.nodes.find(node=>node.type==='group')!.data.groupType='video';},
 'duplicate captured membership':(_raw,graph)=>{graph.nodes.find(node=>node.type==='group')!.data.nodeIds.push('shot-1');},
 'ambiguous saved edge':(_raw,graph)=>{graph.edges.push({...graph.edges[0],id:'duplicate'});},
 'conditioned saved edge':(_raw,graph)=>{graph.edges[0].conditioningRole='POSE';},
 'nondefault saved handle':(_raw,graph)=>{graph.edges[0].targetHandle='mask';},
 'explicit incompatible edge metadata':raw=>{raw.edges[0].conditioningRole='MASK';},
 'duplicate projected edge':raw=>{raw.edges.push({...raw.edges[0]});},
 'missing incoming edge':raw=>{raw.edges.pop();},
 'new incoming source after capture':(_raw,graph)=>{graph.nodes.push({id:'new-input',type:'rh-image',position:{x:0,y:0},data:{}});graph.edges.push({id:'new-edge',source:'new-input',target:'shot-1'});},
};
for(const [label,mutate]of Object.entries(invalidCases))it('rejects '+label+' without repairing or mutating it',async()=>{
 const graph=mounted(),raw=await command(graph);mutate(raw,graph);const before=structuredClone(raw);
 let error:any;try{completeNativeGroupCommand(raw,graph,'storyboard-group');}catch(value){error=value;}
 expect(error).toBeInstanceOf(ApiError);expect(error.status).toBe(409);expect(error.code).toBe('STALE_NATIVE_GROUP_COMMAND');expect(raw).toEqual(before);
});

it('projects full captured normal-group membership for the owned toolbar without mutating layout or other groups',()=>{
 const graph=mounted();graph.nodes.find(node=>node.type==='group')!.data.groupType='normal';const before=structuredClone(graph);
 const complete=completeNativeGroupCommand(graph,structuredClone(graph),'storyboard-group')!;
 expect(complete.nodes.filter(node=>node.parentId==='storyboard-group').map(node=>node.id)).toEqual(['shot-1','shot-2']);
 expect(complete.nodes.find(node=>node.id==='script')?.parentId).toBeUndefined();
 expect(complete.nodes.map(node=>node.position)).toEqual(graph.nodes.map(node=>node.position));
 expect(complete.nodes.map(node=>node.data)).toEqual(graph.nodes.map(node=>node.data));expect(graph).toEqual(before);
 const changed=structuredClone(graph);changed.nodes[1].data.params.prompt='different supplied input';
 expect(completeNativeGroupCommand(changed,graph,'storyboard-group')).toBe(changed);
});
it('projects a real nested ordinary group recursively while rejecting cycles and inconsistent ownership',()=>{
 const graph=mounted(),group=graph.nodes.find(node=>node.type==='group')!;group.data.groupType='normal';group.data.groupId='outer';
 graph.nodes.push({id:'outer',type:'group',position:{x:0,y:0},data:{groupType:'normal',nodeIds:['storyboard-group']}});
 const complete=completeNativeGroupCommand(graph,structuredClone(graph),'outer')!;
 expect(complete.nodes.find(node=>node.id==='storyboard-group')?.parentId).toBe('outer');
 expect(complete.nodes.filter(node=>node.parentId==='storyboard-group')).toHaveLength(2);
 const cycle=structuredClone(graph);cycle.nodes.find(node=>node.id==='shot-1')!.type='group';cycle.nodes.find(node=>node.id==='shot-1')!.data.nodeIds=['outer'];cycle.nodes.find(node=>node.id==='outer')!.data.groupId='shot-1';
 expect(()=>completeNativeGroupCommand(cycle,structuredClone(cycle),'outer')).toThrow(ApiError);
 const conflict=structuredClone(graph);conflict.nodes.find(node=>node.id==='shot-1')!.parentId='another';
 expect(()=>completeNativeGroupCommand(conflict,structuredClone(conflict),'outer')).toThrow(ApiError);
});
it.each(['missing','duplicate','unlisted'])('rejects %s membership in the exact full normal graph',change=>{
 const graph=mounted(),group=graph.nodes.find(node=>node.type==='group')!;group.data.groupType='normal';
 if(change==='missing')graph.nodes=graph.nodes.filter(node=>node.id!=='shot-1');
 if(change==='duplicate')group.data.nodeIds.push('shot-1');
 if(change==='unlisted')group.data.nodeIds.pop();
 expect(()=>completeNativeGroupCommand(graph,structuredClone(graph),'storyboard-group')).toThrow(ApiError);
});
