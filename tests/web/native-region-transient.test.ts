import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph,decodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {isNativeRegionTransient,persistentRegionGraph,withLocalRegionTransients} from '../../apps/web/src/service/native-region-transient';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const a=frozen.indexOf('function Fse('),b=frozen.indexOf('function wye(',a);
const build=runInNewContext(frozen.slice(a,b)+';tar',{Zor:'canvas-image-region-recognize'});
const tool=(id='recognize_actual')=>build({id,imageUrl:'rhtv-asset:owned',point:{x:510,y:520},model:{modelCode:'codex-6-1-vision-text-v1',modelType:'LLM',config:[{type:'imageUrls',paramName:'imageUrls'},{type:'prompt',paramName:'prompt'}]}});
const node=(id='source',text='Original')=>({id,type:'rh-text',position:{x:0,y:0},data:{text}});
const graph=(nodes:any[],edges:any[]=[]):NativeGraph=>({nodes,edges});
const reply=(data:any,status=200)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',data}),{status,headers:{ETag:'"'+(data.revision??1)+'"'}});
async function setup(initial:NativeGraph,hook?:(path:string,init:any)=>Response|undefined){
 let revision=1,stored=encodeGraph(initial);const snapshot=()=>({projectId:'p',revision,graph:structuredClone(stored),updatedAt:'2026-10-22T00:00:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  const custom=hook?.(path,init);if(custom)return custom;
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'u',name:'Project',revision,updatedAt:'2026-10-22T00:00:00Z'});
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){if(init.headers.get('If-Match')!=='"'+revision+'"')return reply({},412);stored=JSON.parse(init.body).graph;revision++;}return reply(snapshot());
  }
  if(path==='/api/v1/assets/owned')return reply({byteSize:2048,id:'owned',kind:'IMAGE',state:'READY',mimeType:'image/png',previewUrl:'/preview/owned'});
  if(path==='/api/v2/tasks/legacy')return reply({id:'legacy',projectId:'p',plans:[]});
  throw new Error('Unexpected '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());await storage.loadProject('p');
 return{api,storage,transport,current:()=>decodeGraph(stored),snapshot,remote:(g:NativeGraph)=>{stored=encodeGraph(g);revision++;return snapshot();}};
}

it('identifies the actual frozen tar node and leaves every partial lookalike/localOnly meaning alone',()=>{
 const actual=tool();expect(actual.data).toMatchObject({localOnly:true,transientKind:'region-recognize',subType:'image-recognition',sceneCode:'canvas-image-region-recognize',params:{prompt:'<point>510 520</point>'}});expect(isNativeRegionTransient(actual)).toBe(true);
 for(const key of ['localOnly','transientKind','subType','sceneCode']){const row=structuredClone(actual);delete row.data[key];expect(isNativeRegionTransient(row)).toBe(false);expect(persistentRegionGraph(graph([row])).nodes).toEqual([row]);}
 expect(isNativeRegionTransient({...actual,type:'rh-image'})).toBe(false);
 // The shared graph encoder remains valid for execution, including the tool.
 expect(decodeGraph(encodeGraph(graph([actual]))).nodes[0]).toEqual(actual);
});

it('autosaves only persistent edits and drops only exact tool nodes and their incident edges',async()=>{
 const other={...node('other'),data:{localOnly:true,transientKind:'another-tool',text:'Keep'}},f=await setup(graph([node(),other]));
 const local=f.storage.fixture('p');f.storage.attachNativeView('p',local);local.nodes[0].data.text='Edited';local.nodes.push(tool());local.edges.push({id:'tool-edge',source:'source',target:'recognize_actual'},{id:'real-edge',source:'source',target:'other'});
 await f.storage.queueSave('p',local);
 expect(f.current().nodes.map(n=>n.id)).toEqual(['source','other']);expect(f.current().nodes[0].data.text).toBe('Edited');expect(f.current().nodes[1].data).toEqual(other.data);expect(f.current().edges.map(e=>e.id)).toEqual(['real-edge']);
 expect(local.nodes.some(isNativeRegionTransient)).toBe(true);expect(f.storage.isBlocked('p')).toBe(false);
});

it('does not create a draft for native tool add/result/delete operations alone',async()=>{
 const f=await setup(graph([node()])),local=f.storage.fixture('p');f.storage.attachNativeView('p',local);local.nodes.push(tool());f.storage.observeNativeDraft('p',local);expect(f.storage.hasDraft('p')).toBe(false);
 local.nodes[1].data.text='woman <bbox>0 0 1000 1000</bbox>';f.storage.observeNativeDraft('p',local);expect(f.storage.hasDraft('p')).toBe(false);
 local.nodes.pop();f.storage.observeNativeDraft('p',local);expect(f.storage.hasDraft('p')).toBe(false);expect(f.transport.mock.calls.some(([,init])=>init.method==='PUT')).toBe(false);
});

it('safely projects old persisted tools away and rebases their server writeback against native deletion',async()=>{
 const old=tool(),initial=graph([node(),old],[{id:'legacy-edge',source:'source',target:old.id}]),f=await setup(initial);
 expect(f.storage.fixture('p').nodes.map(n=>n.id)).toEqual(['source']);expect(f.storage.snapshots.get('p')!.graph.nodes.some(n=>n.id===old.id)).toBe(true);
 const local=structuredClone(initial);f.storage.attachNativeView('p',local);local.nodes.pop();local.edges=[];local.nodes[0].data.text='Keep this user edit';const save=f.storage.queueSave('p',local);
 const remote=structuredClone(initial);remote.nodes[1].data.text='server completed bbox';remote.nodes[1].data.status='finished';
 const accepted=f.storage.acceptRemoteSnapshot('p',f.remote(remote),'"2"');expect(accepted.conflicts).toEqual([]);await save;
 expect(f.storage.isBlocked('p')).toBe(false);expect(f.current().nodes.map(n=>n.id)).toEqual(['source']);expect(f.current().nodes[0].data.text).toBe('Keep this user edit');
 const put=f.transport.mock.calls.find(([,init])=>init.method==='PUT')!;expect(put[1].headers.get('If-Match')).toBe('"2"');
});

it('still rejects a changed raw server graph at the same revision, including legacy tool-only changes',async()=>{
 const f=await setup(graph([node(),tool()])),snapshot=f.snapshot();
 expect(()=>f.storage.acceptRemoteSnapshot('p',snapshot,'"1"')).not.toThrow();
 const changed=structuredClone(snapshot);changed.graph.nodes.find(n=>n.id==='recognize_actual')!.data.text='Changed at the same revision';
 expect(()=>f.storage.acceptRemoteSnapshot('p',changed,'"1"')).toThrow(expect.objectContaining({code:'SNAPSHOT_REVISION_MISMATCH'}));expect(f.storage.snapshots.get('p')).toEqual(snapshot);
});

it('keeps a genuine persistent-node delete/edit conflict blocked and preserves the user draft',async()=>{
 const f=await setup(graph([node(),node('real','Before')])),local=f.storage.fixture('p');f.storage.attachNativeView('p',local);local.nodes.pop();const save=f.storage.queueSave('p',local),rejected=expect(save).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});
 const accepted=f.storage.acceptRemoteSnapshot('p',f.remote(graph([node(),node('real','Remote edit')])),'"2"');expect(accepted.conflicts).toContainEqual({path:'/nodes/real',reason:'DELETE_EDIT'});await rejected;expect(f.storage.isBlocked('p')).toBe(true);expect(f.storage.draft('p')!.nodes.some(n=>n.id==='real')).toBe(false);
 f.storage.acceptRemoteSnapshot('p',f.remote(graph([node(),node('real','Remote edit'),tool()])),'"3"');expect(f.storage.isBlocked('p')).toBe(true);expect(f.transport.mock.calls.some(([,init])=>init.method==='PUT')).toBe(false);
});

it('overlays only currently local reviewed tools and never resurrects old tools from a remote snapshot',()=>{
 const running=tool('running'),old=tool('old'),local=graph([node(),running],[{id:'running-edge',source:'source',target:'running'},{id:'dangling-tool-edge',source:'deleted',target:'running'}]),remote=graph([node(),old]);
 const merged=withLocalRegionTransients(remote,local);expect(merged.nodes.map(n=>n.id)).toEqual(['source','running']);expect(merged.nodes[1]).toBe(running);expect(merged.edges.map(e=>e.id)).toEqual(['running-edge']);
 expect(withLocalRegionTransients(remote,graph([node()])).nodes.map(n=>n.id)).toEqual(['source']);
});

it('freezes the actual region input for inference without saving it or requesting server-managed canvas writeback',async()=>{
 const transient=tool(),cap={capabilityRef:'codex-6-1-vision-text-v1',kind:'IMAGE_UNDERSTANDING',version:'2',parameterSchemaVersion:'2',available:true,testMode:false,model:{providerRef:'codex',modelRef:'codex-6-1',title:'Codex Vision',version:'1'},inputKinds:['TEXT','IMAGE'],outputKinds:['TEXT'],parameterSchema:{type:'object',properties:{}}};
 const f=await setup(graph([node()]),path=>{
  if(path.includes('model-capabilities'))return reply({items:[cap],nextCursor:null});
  if(path==='/api/v2/canvas-runs')return reply({id:'tool-task',projectId:'p',state:'SUCCEEDED',revision:1,testMode:false,plans:[{nodeId:transient.id,executionId:'tool-execution',state:'SUCCEEDED',outputs:[{id:'result',type:'TEXT',text:'woman <bbox>50 200 950 900</bbox>'}]}]});
 });
 const live=graph([node(),transient]),manager={getRemoteData:()=>live,patchNodeData:vi.fn((id:string,patch:any)=>{const row=live.nodes.find(n=>n.id===id);if(row)Object.assign(row.data,patch);}),flushOperationQueue:vi.fn()},saved=vi.fn().mockResolvedValue(undefined),adapter=new ExecutionAdapter(f.api,f.storage,saved,vi.fn()),saveForExecution=vi.spyOn(f.storage,'saveForExecution');
 f.storage.attachNativeView('p',live);adapter.attach('p',manager);
 try{
  await adapter.run({projectId:'p',targetType:'NODE',targetId:transient.id,canvas:graph([transient])});
  const submit=f.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')!,body=JSON.parse(submit[1].body);
  expect(body).not.toHaveProperty('expectedRevision');expect(body.targetId).toBe(transient.id);expect(body.graph.nodes[0].data).toMatchObject({localOnly:true,transientKind:'region-recognize',params:{prompt:'<point>510 520</point>',imageUrls:['rhtv-asset:owned']},capabilityRef:cap.capabilityRef,capabilityVersion:'2'});
  expect(saveForExecution).not.toHaveBeenCalled();expect(f.transport.mock.calls.some(([,init])=>init.method==='PUT')).toBe(false);expect(manager.patchNodeData).toHaveBeenCalledWith(transient.id,expect.objectContaining({text:'woman <bbox>50 200 950 900</bbox>'}),expect.anything());
  await f.storage.queueSave('p',live);expect(f.current().nodes.map(n=>n.id)).toEqual(['source']);expect(live.nodes.find(n=>n.id===transient.id)!.data.text).toContain('<bbox>');
 }finally{adapter.clear();}
});
