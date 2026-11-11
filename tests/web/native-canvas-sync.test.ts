import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {nativeCanvasSyncPort,REMOTE_CANVAS_ORIGIN} from '../../apps/web/src/service/native-canvas-sync';
import type {NativeGraph} from '../../apps/web/src/service/graph';

class YMap {
 values=new Map<string,any>();observer:any;
 get=(key:string)=>this.values.get(key);set=(key:string,value:any)=>{this.values.set(key,value);};delete=(key:string)=>this.values.delete(key);keys=()=>this.values.keys();
 toJSON=()=>Object.fromEntries([...this.values].map(([key,value])=>[key,value?.toJSON?.()??value]));observe=(callback:any)=>{this.observer=callback;};unobserve=()=>{};
}
class YArray {
 values:any[]=[];deep:any;
 get length(){return this.values.length;}get=(index:number)=>this.values[index];push=(value:any[])=>this.values.push(...value);insert=(index:number,value:any[])=>this.values.splice(index,0,...value);delete=(index:number,count:number)=>this.values.splice(index,count);toArray=()=>this.values;toJSON=()=>this.values.map(value=>value?.toJSON?.()??value);observeDeep=(callback:any)=>{this.deep=callback;};unobserveDeep=()=>{};
}
function convert(value:any):any{if(Array.isArray(value)){const array=new YArray();array.push(value.map(convert));return array;}if(value&&typeof value==='object'){const map=new YMap();for(const [key,item]of Object.entries(value))map.set(key,convert(item));return map;}return value;}
const graph=():NativeGraph=>({nodes:[{id:'n',type:'rh-text',position:{x:5,y:8},data:{title:'Original',text:'Original'}},{id:'other',type:'rh-text',position:{x:40,y:80},data:{text:'Keep'}}],edges:[],meta:{id:'p',name:'Fixture'}});
function manager(){const seed=graph(),ymap=convert(seed.meta),ynodes=convert(seed.nodes),yedges=convert(seed.edges),transact=vi.fn((callback:any)=>callback());return{localOnly:true,ymap,ynodes,yedges,ydoc:{transact},selection:['n'],viewport:{x:400,y:300,zoom:2},shouldSkipRemoteRefresh:()=>false,isWriteBlocked:()=>false};}

it('patches existing Yjs node/data maps in one remote transaction and preserves the current tab UI state',()=>{
 const m=manager(),original=m.ynodes.get(0),data=original.get('data'),unchanged=m.ynodes.get(1),target=graph();target.nodes[0].data.title='Remote title';target.nodes[0].position={x:100,y:120};target.nodes.push({id:'added',type:'rh-text',position:{x:50,y:90},data:{text:'Remote added'}});target.edges.push({id:'edge',source:'n',target:'added',sourceHandle:null,targetHandle:null});target.viewport={x:0,y:0,zoom:1};
 expect(nativeCanvasSyncPort(m,{}).apply(target)).toBe(true);expect(m.ydoc.transact).toHaveBeenCalledExactlyOnceWith(expect.any(Function),REMOTE_CANVAS_ORIGIN);
 expect(m.ynodes.get(0)).toBe(original);expect(m.ynodes.get(0).get('data')).toBe(data);expect(m.ynodes.get(1)).toBe(unchanged);expect(m.ynodes.toJSON()).toEqual(target.nodes);expect(m.yedges.toJSON()).toEqual(target.edges);expect(m.selection).toEqual(['n']);expect(m.viewport).toEqual({x:400,y:300,zoom:2});expect(m.ymap.get('viewport')).toBeUndefined();
});

it.each([{tagName:'TEXTAREA'},{tagName:'INPUT'},{tagName:'SELECT'},{isContentEditable:true}])('defers a focused editor without mutating Yjs or asking the native renderer to remount',active=>{
 const m=manager();expect(nativeCanvasSyncPort(m,{activeElement:active}).apply({nodes:[],edges:[]})).toBe(false);expect(m.ydoc.transact).not.toHaveBeenCalled();expect(m.ynodes.length).toBe(2);
});

it('defers native local operations and drag selection until their remote reconciliation pause finishes',()=>{
 const m=manager();m.shouldSkipRemoteRefresh=()=>true;expect(nativeCanvasSyncPort(m,{}).apply({nodes:[],edges:[]})).toBe(false);m.shouldSkipRemoteRefresh=()=>false;expect(nativeCanvasSyncPort(m,{querySelector:()=>({})}).apply({nodes:[],edges:[]})).toBe(false);expect(m.ydoc.transact).not.toHaveBeenCalled();
});

it('fails closed for an unknown manager or a non-Yjs row before any graph mutation',()=>{
 const old={getRemoteData:()=>graph(),patchNodeData:vi.fn(),connectLocalFixture:vi.fn()};expect(nativeCanvasSyncPort(old,{}).available()).toBe(false);expect(()=>nativeCanvasSyncPort(old,{}).apply(graph())).toThrow('安全增量同步');expect(old.connectLocalFixture).not.toHaveBeenCalled();expect(old.patchNodeData).not.toHaveBeenCalled();
 const m=manager();m.ynodes.values.push({id:'plain'});expect(()=>nativeCanvasSyncPort(m,{}).apply(graph())).toThrow('不支持安全同步');expect(m.ydoc.transact).not.toHaveBeenCalled();
});

it('removes absent fields and rows while retaining unaffected map identities',()=>{
 const m=manager(),other=m.ynodes.get(1),target=graph();target.nodes.shift();target.nodes[0].data={title:'Replaced remote field'};
 nativeCanvasSyncPort(m,{}).apply(target);expect(m.ynodes.length).toBe(1);expect(m.ynodes.get(0)).toBe(other);expect(m.ynodes.toJSON()).toEqual(target.nodes);
});

it('preserves a running tab-local region tool and its output map during remote sync, then respects native cleanup',()=>{
 const m=manager(),transient={id:'recognize-running',type:'rh-text',position:{x:0,y:0},data:{localOnly:true,transientKind:'region-recognize',subType:'image-recognition',sceneCode:'canvas-image-region-recognize',text:'bbox result',taskId:'point-task'}},old={...transient,id:'old-server-tool'};
 m.ynodes.push([convert(transient)]);m.yedges.push([convert({id:'point-edge',source:'n',target:transient.id})]);const row=m.ynodes.get(2),data=row.get('data'),remote=graph();remote.nodes[0].data.text='Remote edit';remote.nodes.push(old);
 nativeCanvasSyncPort(m,{}).apply(remote);expect(m.ynodes.toJSON().map((n:any)=>n.id)).toEqual(['n','other','recognize-running']);expect(m.ynodes.get(2)).toBe(row);expect(row.get('data')).toBe(data);expect(data.get('text')).toBe('bbox result');expect(m.yedges.toJSON()).toEqual([{id:'point-edge',source:'n',target:transient.id}]);
 // lk()/PCt deletes its temporary node at completion/abort. A later remote
 // replay must not resurrect either the completed tool or a legacy saved one.
 m.ynodes.delete(2,1);m.yedges.delete(0,1);nativeCanvasSyncPort(m,{}).apply(remote);expect(m.ynodes.toJSON().map((n:any)=>n.id)).toEqual(['n','other']);expect(m.yedges.length).toBe(0);
});

it('matches the immutable native observer and undo origin rules instead of claiming local writes are remote',()=>{
 const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
 const body=(start:string,end:string)=>{const from=compiled.indexOf(start);const to=compiled.indexOf(end,from);if(from<0||to<0)throw new Error('Native manager seam changed');return compiled.slice(from+start.length,to);};
 const local=Symbol('local'),maintenance=Symbol('maintenance');const attach=new Function('R7','uh','return function(){'+body('attachObserver(){','}recordRemoteTouchedNodes(')+'};')((origin:any)=>origin===local||origin===maintenance,{full:true,nodes:[],edges:[]});
 const m:any=manager();m.detachObserver=vi.fn();m.onChange=()=>{};m.changeSubscribers=new Set();m.canvasContent=new YMap();m.recordRemoteTouchedNodes=vi.fn();m.createEntityChange=vi.fn(()=>({full:false,nodes:[{id:'n'}],edges:[]}));m.notifyRemoteChange=vi.fn();m.rebindIfNeeded=vi.fn();m.scheduleGraphIntegrityRepair=vi.fn();attach.call(m);
 m.ynodes.deep([],{origin:REMOTE_CANVAS_ORIGIN});expect(m.notifyRemoteChange).toHaveBeenCalledOnce();m.ynodes.deep([],{origin:local});m.ynodes.deep([],{origin:maintenance});expect(m.notifyRemoteChange).toHaveBeenCalledOnce();
 const undo=new Function('Tyn','Tc','return function(){'+body('ensureUndoManager(){','}initStructure(')+'};')(class {options:any;constructor(_scope:any,options:any){this.options=options;}},local);undo.call(m);expect(m.undoManager.options.trackedOrigins.has(local)).toBe(true);expect(m.undoManager.options.trackedOrigins.has(REMOTE_CANVAS_ORIGIN)).toBe(false);
});

it('applies an unrelated node while leaving the focused editor map and its input untouched',()=>{
 const m=manager(),own=m.ynodes.get(0),data=own.get('data'),target=graph();target.nodes[1].position={x:99,y:100};target.nodes[1].data.text='A colleague changed another node';
 const active={tagName:'TEXTAREA',closest:()=>({getAttribute:(name:string)=>name==='data-id'?'n':null})};
 expect(nativeCanvasSyncPort(m,{activeElement:active}).apply(target)).toBe(true);expect(m.ynodes.get(0)).toBe(own);expect(own.get('data')).toBe(data);expect(data.get('text')).toBe('Original');expect(m.ynodes.get(1).get('data').get('text')).toBe('A colleague changed another node');
});
it.each(['content','order','delete','incident-edge'])('keeps a focused editor protected from remote %s changes',change=>{
 const m=manager(),target=graph(),active={tagName:'TEXTAREA',closest:()=>({getAttribute:(name:string)=>name==='data-id'?'n':null})};
 if(change==='content')target.nodes[0].data.text='Remote replacement';if(change==='order')target.nodes.reverse();if(change==='delete')target.nodes.shift();if(change==='incident-edge')target.edges.push({id:'new',source:'other',target:'n'});
 expect(nativeCanvasSyncPort(m,{activeElement:active}).apply(target)).toBe(false);expect(m.ydoc.transact).not.toHaveBeenCalled();expect(m.ynodes.toJSON()).toEqual(graph().nodes);
});
it('defers a shuffle around a focused node even when its final index is unchanged',()=>{
 const m=manager(),last={id:'last',type:'rh-text',position:{x:80,y:80},data:{text:'Third'}};m.ynodes.push([convert(last)]);const focused=m.ynodes.get(1),data=focused.get('data'),target={...graph(),nodes:[last,graph().nodes[1],graph().nodes[0]]};
 const active={tagName:'TEXTAREA',closest:()=>({getAttribute:(name:string)=>name==='data-id'?'other':null})};expect(nativeCanvasSyncPort(m,{activeElement:active}).apply(target)).toBe(false);expect(m.ynodes.get(1)).toBe(focused);expect(focused.get('data')).toBe(data);expect(m.ydoc.transact).not.toHaveBeenCalled();
});
