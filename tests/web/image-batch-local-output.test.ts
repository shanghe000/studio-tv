import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {imageBatchNodeId,imageBatchPlan,localImageBatch} from '../../apps/web/src/service/image-batch-output';
import type {NativeGraph} from '../../apps/web/src/service/graph';

const cap={capabilityRef:'codex-image-edit-v1',kind:'IMAGE_TO_IMAGE',version:'2',parameterSchemaVersion:'2',available:true,testMode:false,executionKind:'AGENT',parameterSchema:{properties:{count:{type:'integer',enum:[1,2,4],default:1}}},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Image',version:'1'}};
const source=(id='source'):any=>({id,type:'rh-image',position:{x:10,y:20},parentNode:'group',data:{modelCode:cap.capabilityRef,subType:'image-image',generateNum:4,params:{prompt:'Original user prompt',imageUrls:['rhtv-asset:input-reference']},output:[{assetId:'old',url:'rhtv-asset:old',outputType:'image/png'}],sourceObjects:['rhtv-asset:old'],imageUrl:'rhtv-asset:old',selectedOutputHistoryId:'old-choice',selectedOutputHistoryIndex:3}});
const plan=(nodeId='source',state='SUCCEEDED',count=4,version='2'):any=>({nodeId,executionId:'execution-'+nodeId,capabilityRef:cap.capabilityRef,capabilityVersion:version,state,testMode:false,...(state==='FAILED'?{errorCode:'BATCH_INCOMPLETE'}:{}),outputs:Array.from({length:count},(_,index)=>({id:nodeId+'-output-'+index,type:'ASSET',assetId:nodeId+'-asset-'+index,mimeType:'image/png'}))});
const task=(plans=[plan()],revision=1):any=>({id:'task',projectId:'p',state:'SUCCEEDED',revision,testMode:false,plans});
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
function fixture(receipt=task(),graph:NativeGraph={nodes:[{id:'group',type:'group',position:{x:0,y:0},data:{nodeIds:['source']}},source()],edges:[]}){
 const transport=vi.fn(async(path:string)=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path.startsWith('/api/v1/assets/')?json({id:path.split('/').pop(),kind:'IMAGE',state:'READY',mimeType:'image/png',byteSize:1024,width:32,height:32,downloadUrl:'https://studio.invalid/'+path.split('/').pop()+'.png'}):path==='/api/v2/canvas-runs'?json(receipt,202):json(receipt)),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,vi.fn().mockResolvedValue(undefined),vi.fn()),patch=vi.fn((id:string,data:any)=>Object.assign(graph.nodes.find(node=>node.id===id).data,data)),add=vi.fn((node:any)=>graph.nodes.push(node)),blocked=vi.fn(()=>false),manager={getRemoteData:()=>graph,patchNodeData:patch,addNode:add,flushOperationQueue:vi.fn(),isWriteBlocked:blocked};adapter.attach('p',manager);
 return{adapter,storage,graph,manager,patch,add,blocked,transport,run:(type='GROUP')=>adapter.run({projectId:'p',targetType:type,targetId:type==='GROUP'?'group':'',graph}),deliver:(value:any)=>(adapter as any).apply(value),current:()=>graph.nodes.find(node=>node.id==='source')};
}

it.each(['GROUP','CANVAS'])('projects a real nonmanaged %s image batch into one image per node',async type=>{
 const f=fixture();try{await f.run(type);const original=f.current();expect(original.data).toMatchObject({status:'finished',output:[{assetId:'source-asset-0',historyOutputId:'source-output-0'}],selectedHistoryOutputId:'source-output-0',selectedOutputHistoryId:'',selectedOutputHistoryIndex:0,assetIds:['source-asset-0']});expect(f.add).toHaveBeenCalledTimes(3);for(const node of f.graph.nodes.filter(node=>String(node.id).startsWith('img_'))){expect(node).toMatchObject({type:'rh-image',parentNode:'group',data:{status:'finished',isUpload:true,generateNum:1,params:{},historyStorage:{imageBatchOrigin:{taskId:'task',executionId:'execution-source',sourceNodeId:'source'}}}});expect(node.data.output).toHaveLength(1);expect(node.data).not.toHaveProperty('modelCode');expect(node.data.historyStorage).not.toHaveProperty('source');expect(node.data.historyStorage).not.toHaveProperty('historyId');expect(node.data).not.toHaveProperty('selectedHistoryOutputId');}}finally{f.adapter.clear();}
});

it('uses the actual multi-entity CANVAS path and stages independent images for both entity plans',async()=>{
 const graph={nodes:[source('source'),source('second')],edges:[]},f=fixture(task([plan('source','SUCCEEDED',2),plan('second','SUCCEEDED',2)]),graph);try{await f.adapter.generateEntityPlans('p',graph.nodes.map(node=>({...node,data:{...node.data,generateNum:2}})),{capabilityRef:cap.capabilityRef});expect(JSON.parse(f.transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1]?.body||'{}').targetType).toBe('CANVAS');expect(f.add).toHaveBeenCalledTimes(2);expect(new Set(f.add.mock.calls.map(([node])=>JSON.stringify(node.position))).size).toBe(2);}finally{f.adapter.clear();}
});

it.each(['FAILED','CANCELED'])('retains old source media and real %s status while saving every verified partial image separately',async state=>{
 const f=fixture({...task([plan('source',state,2)]),state}),old=structuredClone(f.current().data.output),terminal=vi.fn();f.adapter.onTerminal(terminal);try{await f.run();expect(f.current().data).toMatchObject({status:state==='FAILED'?'failed':'idle',output:old,params:{prompt:'Original user prompt'},historyStorage:{imageBatchProjection:{outputIds:['source-output-0','source-output-1']}}});expect(f.current().data.historyStorage).not.toHaveProperty('source');expect(f.current().data.historyStorage).not.toHaveProperty('historyId');expect(f.add).toHaveBeenCalledTimes(2);expect(terminal).toHaveBeenLastCalledWith(expect.objectContaining({status:state==='FAILED'?'FAILED':'CANCELLED'}));if(state==='FAILED')expect(f.current().data.errorMsg).toBe('BATCH_INCOMPLETE');}finally{f.adapter.clear();}
});

it('preserves moved, edited and deleted children and a manually selected source across repeated task revisions',async()=>{
 const f=fixture();try{await f.run();const child=f.add.mock.calls[0][0],deleted=f.add.mock.calls[1][0];child.position={x:999,y:777};child.data.title='User title';f.graph.nodes=f.graph.nodes.filter(node=>node.id!==deleted.id);Object.assign(f.current().data,{output:[{url:'user-selected',outputType:'image/png'}],imageUrl:'user-selected',sourceObjects:['user-selected'],selectedHistoryOutputId:'another'});await f.deliver(task(undefined,2));await f.deliver(task(undefined,3));expect(f.add).toHaveBeenCalledTimes(3);expect(f.graph.nodes.some(node=>node.id===deleted.id)).toBe(false);expect(child).toMatchObject({position:{x:999,y:777},data:{title:'User title'}});expect(f.current().data.output[0].url).toBe('user-selected');expect(f.current().data.selectedHistoryOutputId).toBe('another');}finally{f.adapter.clear();}
});

it.each(['SUCCEEDED','FAILED'])('keeps provenance and deletion markers after frozen normalization and a fresh adapter for %s',async state=>{
 const f=fixture({...task([plan('source',state,2)]),state});await f.run();const deleted=f.add.mock.calls[0][0].id;f.graph.nodes=f.graph.nodes.filter(node=>node.id!==deleted);
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('const u1n='),end=frozen.indexOf('function WXr(',start),normalize=new Function(frozen.slice(start,end)+';return oL;')() as (graph:NativeGraph)=>NativeGraph,normalized=normalize(f.graph);f.adapter.clear();const g=fixture({...task([plan('source',state,2)],2),state},normalized);
 try{expect(g.current().data).not.toHaveProperty('batchOrigin');expect(g.current().data.historyStorage.imageBatchProjection.outputIds).toHaveLength(2);for(const node of normalized.nodes.filter(node=>String(node.id).startsWith('img_')))expect(node.data.historyStorage.imageBatchOrigin.outputId).toBeTruthy();await g.deliver({...task([plan('source',state,2)],2),state});expect(g.add).not.toHaveBeenCalled();expect(g.graph.nodes.some(node=>node.id===deleted)).toBe(false);}finally{g.adapter.clear();}
});

it('does not project an old receipt onto a same-ID replacement with no accepted task',async()=>{
 const f=fixture();try{await f.run();const count=f.add.mock.calls.length;f.graph.nodes=f.graph.nodes.map(node=>node.id==='source'?{...source(),data:{params:{prompt:'Replacement'}}}:node);f.patch.mockClear();await f.deliver(task(undefined,2));expect(f.patch).not.toHaveBeenCalled();expect(f.add).toHaveBeenCalledTimes(count);expect(f.current().data.params.prompt).toBe('Replacement');}finally{f.adapter.clear();}
});

it('flushes a queued native source deletion before deciding whether to create result nodes',async()=>{
 const node=source();node.data.taskId='task';node.data.status='idle';const f=fixture(task(),{nodes:[node],edges:[]});f.manager.flushOperationQueue.mockImplementationOnce(()=>{f.graph.nodes=f.graph.nodes.filter(value=>value.id!==node.id);});
 try{await f.deliver(task());expect(f.add).not.toHaveBeenCalled();expect(f.patch).not.toHaveBeenCalled();expect(f.graph.nodes).toHaveLength(0);}finally{f.adapter.clear();}
});

it('never writes local outputs or nodes for a server-managed receipt',async()=>{
 const receipt={...task(),canvasManaged:true,plans:[{...plan(),canvasBinding:{applicationState:'APPLIED'}}]},f=fixture(receipt);try{await f.run();await f.deliver({...receipt,revision:2});expect(f.patch).not.toHaveBeenCalled();expect(f.add).not.toHaveBeenCalled();}finally{f.adapter.clear();}
});

it('retains historical version1 multi-output behavior',async()=>{
 const old=source();old.data.taskId='task';old.data.status='idle';const receipt=task([plan('source','SUCCEEDED',2,'1')]),f=fixture(receipt,{nodes:[old],edges:[]});try{await f.deliver(receipt);expect(f.current().data.output).toHaveLength(2);expect(f.add).not.toHaveBeenCalled();expect(f.current().data.historyStorage).not.toHaveProperty('imageBatchProjection');}finally{f.adapter.clear();}
});

it.each(['blocked','missing add','collision','deleted output'])('preflights %s before queuing any image results',async condition=>{
 const receipt=task(),f=fixture(receipt);if(condition==='blocked')f.blocked.mockReturnValue(true);if(condition==='missing add')delete (f.manager as any).addNode;if(condition==='collision')f.graph.nodes.push({id:imageBatchNodeId('task','execution-source','source-output-1'),type:'rh-image',position:{x:30,y:40},data:{title:'Unrelated'}});if(condition==='deleted output')receipt.plans[0].outputs[1].deletedAt='2026-10-07T01:00:00Z';
 try{await expect(f.run()).rejects.toMatchObject({code:condition==='collision'?'RESULT_NODE_CONFLICT':condition==='deleted output'?'INVALID_OUTPUT':'CANVAS_WRITE_UNAVAILABLE'});expect(f.add).not.toHaveBeenCalled();expect(f.patch.mock.calls.some(([,patch])=>Object.hasOwn(patch,'output'))).toBe(false);}finally{f.adapter.clear();}
});

it('checks the total node limit across all plans before the native deferred add queue is mutated',async()=>{
 const graph={nodes:[source(),source('second'),...Array.from({length:497},(_,index)=>({id:'unrelated-'+index,type:'rh-text',position:{x:0,y:0},data:{}}))],edges:[]},f=fixture(task([plan('source','SUCCEEDED',2),plan('second','SUCCEEDED',2)]),graph);try{await expect(f.adapter.run({projectId:'p',targetType:'CANVAS',graph:{nodes:graph.nodes.slice(0,2),edges:[]}})).rejects.toMatchObject({code:'RESULT_NODE_LIMIT'});expect(f.add).not.toHaveBeenCalled();expect(f.patch.mock.calls.some(([,patch])=>Object.hasOwn(patch,'output'))).toBe(false);expect(f.graph.nodes).toHaveLength(499);}finally{f.adapter.clear();}
});

it('matches the backend node digest including Go JSON escapes for arbitrary result identifiers',()=>{
 const expected=createHash('sha256').update('["task","execution","out\\u003c\\u003e\\u0026\\u2028\\u2029"]').digest('hex').slice(0,32);expect(imageBatchNodeId('task','execution','out<>&\u2028\u2029')).toBe('img_'+expected);
});

it.each(['z-image-turbo-generate-v1','flux2-klein4b-generate-v1'])('projects a successful %s batch once, including eight independent outputs',async ref=>{
 for(const count of [1,2,4,8]){
  const node=source();node.data.taskId='task';node.data.status='processing';
  const batch={...plan('source','SUCCEEDED',count,'1'),capabilityRef:ref},f=fixture(task([batch]),{nodes:[node],edges:[]});
  try{await f.deliver(task([batch]));expect(f.current().data.output).toHaveLength(1);expect(f.current().data.assetIds).toEqual(['source-asset-0']);expect(f.add).toHaveBeenCalledTimes(count-1);expect(new Set(f.graph.nodes.map(node=>node.id)).size).toBe(count);for(const child of f.graph.nodes.slice(1)){expect(child.data.output).toHaveLength(1);expect(child.data.sourceObjects).toEqual([child.data.output[0].url]);expect(child.data.historyStorage).not.toHaveProperty('historyId');}await f.deliver(task([batch],2));expect(f.add).toHaveBeenCalledTimes(count-1);const marker=f.current().data.historyStorage.imageBatchProjection;expect(marker.outputIds).toHaveLength(count);}finally{f.adapter.clear();}
 }
});

it.each(['z-image-turbo-generate-v1','flux2-klein4b-generate-v1'])('does not grant %s partial or unversioned batch behavior',ref=>{
 const node=source(),outputs=[{outputId:'out',assetId:'asset',url:'rhtv-asset:asset',mimeType:'image/png'}],base={capabilityRef:ref,capabilityVersion:'1',executionId:'exec',outputs};
 for(const status of ['FAILED','CANCELLED','RUNNING']){const p={...base,status};expect(imageBatchPlan(p)).toBe(false);expect(localImageBatch('p','task',p,node,[node],new Set())).toBeUndefined();}
 expect(imageBatchPlan({...base,status:'SUCCESS',capabilityVersion:'2'})).toBe(false);
 expect(imageBatchPlan({...base,status:'SUCCESS',capabilityRef:'unreviewed-image-model'})).toBe(false);
 const tooMany={...base,status:'SUCCESS',outputs:Array.from({length:9},(_,i)=>({...outputs[0],outputId:'out-'+i}))};expect(()=>localImageBatch('p','task',tooMany,node,[node],new Set())).toThrow('图片批次缺少可验证的素材或结果标识');
});
