import {expect,it,vi} from 'vitest';
import {nativeCopy,normalize} from './helpers/native-copy-fixture';
import {installNativeNodeCopy} from '../../apps/web/src/service/native-node-copy';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {encodeGraph,decodeGraph} from '../../apps/web/src/service/graph';
import catalog from './fixtures/router-h3-capabilities.json';

it.each(['immediate','saved','reloaded'])('submits a completed connected copy with its exact version and current inputs, then edits and resubmits (%s)',async stage=>{
 const cap={...structuredClone(catalog.find(c=>c.capabilityRef==='h3-first-frame-v1')!),available:true,testMode:false};
 let rows:any={nodes:[{id:'image',type:'rh-image',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:image']}},{id:'old',type:'rh-video',position:{x:500,y:0},data:{modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,subType:'start-video',status:'finished',taskId:'previous-task',estimateTaskId:'previous-estimate',params:{prompt:'Initial copy direction',outputPreset:cap.parameterSchema.properties.outputPreset.default},output:[{url:'rhtv-asset:previous-video',historyOutputId:'previous-output'}],selectedHistoryOutputId:'previous-output',imageOrder:['image::rhtv-asset:image']}}],edges:[{id:'input',source:'image',target:'old',sourceHandle:'output',targetHandle:'input'}]};
 let snapshot=encodeGraph(rows),revision=1;const requests:any[]=[],reply=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+revision+'"'}});
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('/model-capabilities?'))return reply({items:[{...cap,version:'future',parameterSchemaVersion:'future'}],nextCursor:null});
  if(path.startsWith('/api/v2/model-capability-version?'))return reply(cap);
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1)!;return reply({id,projectId:'p',state:'READY',kind:id==='image'?'IMAGE':'VIDEO',mimeType:id==='image'?'image/png':'video/mp4',width:640,height:360,byteSize:3000,durationSeconds:5});}
  if(path==='/api/v1/projects/p')return reply({id:'p',ownerId:'owner',revision});
  if(path.endsWith('/snapshot')){if(init?.method==='PUT'){snapshot=body.graph;revision++;}return reply({projectId:'p',revision,graph:snapshot,updatedAt:'2026-11-05T00:00:00Z'});}
  if(path==='/api/v2/canvas-runs')return reply({id:'new-'+requests.length,projectId:'p',canvasManaged:true,state:'SUCCEEDED',plans:[{nodeId:body.targetId,executionId:'execution-'+requests.length,state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  if(path==='/api/v2/generation-diagnostics')return reply({logId:'fixture'});
  throw Error('Unexpected copy lifecycle route '+path);
 });api.setAccessToken('isolated-copy-fixture');
 const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 await storage.loadProject('p');storage.attachNativeView('p',rows);
 const manager:any={localOnly:true,getRemoteData:()=>normalize(rows),getFullNodesByIds:(ids:string[])=>new Map(rows.nodes.filter((n:any)=>ids.includes(n.id)).map((n:any)=>[n.id,structuredClone(n)])),pasteGraph:(nodes:any[],edges:any[])=>{rows={nodes:[...rows.nodes,...nodes],edges:[...rows.edges,...edges]};return true;},flushOperationQueue:()=>{},patchNodeData:()=>{}};
 const port=()=>storage.modelBindingPort('p',()=>true),release=installNativeNodeCopy({storage,modelBindingPort:port,canvasAttachment:()=>({id:'p',client:manager})},{bt:()=>manager,r:{useCallback:(fn:any)=>fn}},new EventTarget() as any);
 try{
  const native=nativeCopy(manager),copied=native.clone({nodes:native.read([rows.nodes[1]]),edges:rows.edges},null,rows.nodes,{exactPosition:true});manager.pasteGraph(copied.nodes,copied.edges);const id=copied.nodes[0].id;
  if(stage!=='immediate')await storage.save('p',manager.getRemoteData());
  if(stage==='reloaded'){storage.clear();await storage.loadProject('p');rows=normalize(decodeGraph(snapshot));storage.attachNativeView('p',rows);}
  execution.attach('p',manager);
  for(const prompt of ['Initial copy direction','Edited after copy']){
   rows.nodes.find((n:any)=>n.id===id).data.params.prompt=prompt;
   await execution.run({projectId:'p',targetType:'NODE',targetId:id,graph:manager.getRemoteData()});
   const submitted=requests.filter(row=>row.path==='/api/v2/canvas-runs').at(-1).body,node=submitted.graph.nodes.find((n:any)=>n.id===id);
   expect(node.data).toMatchObject({capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,params:{prompt,imageUrls:['rhtv-asset:image']}});
   expect(node.data.taskId).toBeUndefined();expect(submitted.graph.edges.some((e:any)=>e.source==='image'&&e.target===id)).toBe(true);
  }
  expect(requests.filter(row=>row.path==='/api/v2/canvas-runs')).toHaveLength(2);
  expect(requests.some(row=>row.path.startsWith('/api/v2/tasks/previous'))).toBe(false);
  expect(rows.nodes.find((n:any)=>n.id==='old').data.taskId).toBe('previous-task');
 }finally{execution.clear();release();}
});
