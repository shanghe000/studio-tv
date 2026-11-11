import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach,expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=frozen.indexOf('function iCr('),end=frozen.indexOf('async function uTe(',start),regionStart=frozen.indexOf('function Fse('),regionEnd=frozen.indexOf('let S7e=',regionStart);
const text='coat <bbox>278 351 999 834</bbox>\nwoman <bbox>83 341 999 834</bbox>';
function fixture(){
 const forget=vi.fn(),native=runInNewContext(frozen.slice(regionStart,regionEnd)+frozen.slice(start,end)+';({run:lk,build:tar,parse:wye,boxes:oar})',{Zor:'canvas-image-region-recognize',Gy:forget,setTimeout:(fn:any,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:any)=>clearTimeout(id)});
 const node=native.build({id:'recognize-delayed',imageUrl:'rhtv-asset:owned',point:{x:510,y:520},model:{modelCode:'codex-6-1-vision-text-v1',config:[{type:'imageUrls',paramName:'imageUrls'},{type:'prompt',paramName:'prompt'}]}}),nodes=new Map<string,any>(),listeners=new Set<()=>void>();
 const deps={addNode:vi.fn((row:any)=>nodes.set(row.id,row)),removeNode:vi.fn((id:string)=>nodes.delete(id)),addEdge:vi.fn(),removeEdge:vi.fn(),subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},getNode:(id:string)=>nodes.get(id),runCanvasTask:vi.fn(async()=>({taskId:'delayed-task'})),queryTask:vi.fn(async()=>null as any)};
 const run=()=>native.run({canvasId:'p',node,canvas:{nodes:[node],edges:[]},parseResult:native.parse,deps});
 return{native,node,nodes,listeners,deps,forget,run,notify:()=>{for(const listener of listeners)listener();}};
}
afterEach(()=>{vi.useRealTimers();});

it('the real frozen lk/ACt retains the tool through 56.46s and cleans it only after local output consumption',async()=>{
 vi.useFakeTimers();const f=fixture();let consumed=false;
 const run=f.run().then((result:string)=>{consumed=true;return result;});await vi.advanceTimersByTimeAsync(0);
 setTimeout(()=>{Object.assign(f.node.data,{taskId:'delayed-task',status:'finished',text,output:[{text}]});f.notify();},56_460);
 await vi.advanceTimersByTimeAsync(55_000);expect(consumed).toBe(false);expect(f.nodes.get(f.node.id)).toBe(f.node);expect(f.deps.removeNode).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1_460);await expect(run).resolves.toBe(text);expect(consumed).toBe(true);expect(f.nodes.size).toBe(0);expect(f.deps.removeNode).toHaveBeenCalledExactlyOnceWith(f.node.id);expect(f.forget).toHaveBeenCalledExactlyOnceWith('p',f.node.id);expect(f.listeners.size).toBe(0);expect(f.native.boxes(text)).toHaveLength(2);
});

it('consumes an unbound actual adapter status receipt on the next native 2s poll, after the server is already terminal',async()=>{
 vi.useFakeTimers();const f=fixture(),api=new ProductClient('/api/v1',vi.fn()),storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());let terminal=false,uiBoxes:any[]=[];
 const receipt=()=>({id:'delayed-task',projectId:'p',state:terminal?'SUCCEEDED':'RUNNING',revision:terminal?3:2,testMode:false,plans:[{nodeId:f.node.id,executionId:'ex',state:terminal?'SUCCEEDED':'RUNNING',outputs:terminal?[{id:'out',type:'TEXT',text}]:[]}]});
 f.deps.queryTask.mockImplementation(async()=>adapter.task(receipt()));
 const run=f.run().then((result:string)=>{uiBoxes=f.native.boxes(result);return result;});await vi.advanceTimersByTimeAsync(0);setTimeout(()=>{terminal=true;},56_460);
 await vi.advanceTimersByTimeAsync(56_460);expect(terminal).toBe(true);expect(receipt()).not.toHaveProperty('canvasManaged');expect(uiBoxes).toEqual([]);expect(f.nodes.has(f.node.id)).toBe(true);expect(f.deps.removeNode).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1_539);expect(uiBoxes).toEqual([]);expect(f.nodes.has(f.node.id)).toBe(true);
 await vi.advanceTimersByTimeAsync(1);await expect(run).resolves.toBe(text);expect(uiBoxes).toHaveLength(2);expect(f.nodes.has(f.node.id)).toBe(false);expect(f.deps.queryTask).toHaveBeenLastCalledWith('delayed-task');adapter.clear();
});

it('uses the native 120s timeout, exposes failure, and performs cleanup without inventing a box',async()=>{
 vi.useFakeTimers();const f=fixture(),run=f.run(),rejected=expect(run).rejects.toThrow('120000ms');await vi.advanceTimersByTimeAsync(119_999);expect(f.nodes.has(f.node.id)).toBe(true);expect(f.deps.removeNode).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);await rejected;expect(f.nodes.has(f.node.id)).toBe(false);expect(f.deps.removeNode).toHaveBeenCalledOnce();expect(f.listeners.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
