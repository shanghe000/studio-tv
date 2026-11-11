/** Disposable loopback acceptance fixture only; no external endpoints or production projects. */
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {CanvasEditSessionClient} from '../../apps/web/src/service/canvas-edit-session';
import {decodeGraph} from '../../apps/web/src/service/graph';

const dir=process.env.STUDIO_CANVAS_FIXTURE_DIR!;
const origin=readFileSync(dir+'/origin','utf8').trim();
if(!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin))throw Error('Requires an isolated loopback fixture.');
const events:any[]=[],bodyLog:any[]=[],received:any[]=[];
const api=new ProductClient('/api/v1',async(path,options:any)=>{
 const url=new URL(path,origin);if(url.origin!==origin)throw Error('Refusing a non-fixture endpoint.');
 if(path==='/api/v2/canvas-runs')bodyLog.push(JSON.parse(options.body));
 const reply=await fetch(url,options);if(!reply.ok)console.error('HTTP',options.method??'GET',url.pathname,reply.status,(await reply.clone().text()).slice(0,260));return reply;
});api.setAccessToken('test-access');
const map=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{get length(){return map.size},key:(i:number)=>[...map.keys()][i]??null,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)}});
const project:any=(await api.request('/projects',{method:'POST',idempotencyKey:crypto.randomUUID(),body:{name:'Synthetic graph boundary '+Date.now()}})).data;
const id=project.id;assert.match(id,/^prj_/);assert.notEqual(id,'p');console.log('Isolated project',id);
const storage=new ServiceStorage(api,()=>{},()=>'usr_test');
await storage.loadProject(id);
const lease=new CanvasEditSessionClient(api,id,'usr_test',()=>true,()=>true,()=>true);
api.setCanvasSession(id,lease.clientId);await lease.ensure();
let view=decodeGraph(storage.snapshots.get(id)!.graph);
storage.attachNativeView(id,view);storage.enableCanvasOperations(id,{userId:'usr_test',clientId:lease.clientId,ensure:lease.ensure},view);
const ex=new ExecutionAdapter(api,storage,async()=>{},()=>{}),manager={getRemoteData:()=>view,localOnly:true,patchNodeData:()=>{},flushOperationQueue:()=>{}};
ex.attach(id,manager);
const read=async()=>{
 const remote:any=await api.request('/projects/'+id+'/snapshot');storage.acceptRemoteSnapshot(id,remote.data,remote.etag);
 view=decodeGraph(remote.data.graph);storage.attachNativeView(id,view);
 // This fixture replaces the rendered document synchronously. Confirm that
 // displayed revision just as CanvasSync does after its native view applies;
 // otherwise recreating a deleted ID looks like an edit from an ancient tab.
 storage.remoteNativeViewApplied(id,view,remote.data.revision);return remote.data;
};
const save=async()=>{storage.captureDraft(id,view);await storage.queueSave(id,view);await read();};
const complex=process.env.STUDIO_CANVAS_COMPLEX==='1';const record=()=>writeFileSync(dir+(complex?'/complex-topology.json':'/live-topology.json'),JSON.stringify({projectId:id,events,received,apiBodies:bodyLog},null,2));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const src=(key:string,assetId:string)=>({id:key,type:'rh-image',position:{x:10,y:10},data:{isUpload:true,sourceObjects:['rhtv-asset:'+assetId]}});
const wire=(a:string,target:string)=>({id:a+'-'+target,source:a,target,sourceHandle:'output',targetHandle:'input'});
try{
 const imported:any=(await api.requestRawJsonV2('/collaboration/projects/'+id+'/assets/import',{method:'POST',body:{assetIds:['a-image','b-image','b2-image']},idempotencyKey:crypto.randomUUID()})).data;
 const ids=imported.assetIdMap;assert(ids['a-image']&&ids['b-image']&&ids['b2-image']);
 view.nodes.push(src('A',ids['a-image']),src('B',ids['b-image']));
 const cases=[{model:'qwen-image-edit-2511-v1',kind:'rh-image',subType:'image-image'},{model:'h3-reference-v1',kind:'rh-video',subType:'multimodal-video'}];
 if(complex){
  const n=(id:string)=>view.nodes.find(n=>n.id===id);
  const gen=(id:string,type:string,modelCode:string,subType:string)=>({id,type,position:{x:120,y:140},data:{modelCode,subType,params:{prompt:'A kite in the breeze.'}}});
  const add=(from:string,to:string)=>view.edges.push(wire(from,to));
  const drop=(node:string)=>{view.nodes=view.nodes.filter(n=>n.id!==node);view.edges=view.edges.filter(e=>e.source!==node&&e.target!==node);};
  const receiptFor=async(operation:string)=>{for(let i=0;i<40;i++){try{const list=JSON.parse(readFileSync(dir+'/invocations.json','utf8'));const r=list.find((r:any)=>r.operationRef===operation&&r.correlation?.projectRef===id);if(r)return r;}catch{}await sleep(100);}throw Error('Missing correlated receiver request '+operation);};
  const step=async(node:string,label:string,assets:string[],ok=true)=>{
   await save();const before=n(node)?.data?.historyStorage?.historyId;
   const pending=bodyLog.length;const ready=await ex.inspectGeneration(id,[node],view);
   if(!ok){assert.equal(ready.status,'blocked',label+' '+JSON.stringify(ready));assert.equal(bodyLog.length,pending);events.push({label,node,ready:false,historyBefore:before,code:ready.issues[0]?.code});record();return;}
   assert.equal(ready.status,'ready',label+' '+JSON.stringify(ready));
   const result=await ex.run({projectId:id,targetType:'NODE',targetId:node,graph:structuredClone(view)});assert.equal(bodyLog.length,pending+1);
   let t:any;for(let index=0;index<180;index++){t=(await api.requestV2('/tasks/'+result.taskId)).data;if(['SUCCEEDED','FAILED','CANCELLED'].includes(t.state))break;await sleep(200);}
   assert.equal(t.state,'SUCCEEDED',label+' '+JSON.stringify({code:t.errorCode,error:t.errorMessage,plan:t.plans?.[0]?.errorCode}));
   const snapshot=await read(),d=n(node).data;assert(d.output?.length&&d.historyStorage?.historyId,label+' not written back');assert.notEqual(d.historyStorage.historyId,before);
   const receipt=await receiptFor(d.historyStorage.historyId);const actual=receipt.attachments.map((r:any)=>r.sourceRef),role=Object.fromEntries((receipt.promptSpec.conditioning??[]).map((x:any)=>[receipt.attachments.find((r:any)=>r.ref===x.attachmentRef)?.sourceRef,x.role]));
   assert.deepEqual(actual,assets,label+' wrong inputs / consumed an ancestor');if(d.modelCode==='h3-first-last-frame-v1'){assert.equal(role[assets[0]],'FIRST_FRAME',label);assert.equal(role[assets[1]],'LAST_FRAME',label);}
   if(d.modelCode==='h3-motion-transfer-v1'){assert.equal(role[assets[0]],'REFERENCE_IMAGE',label);assert.equal(role[assets[1]],'SOURCE_VIDEO',label);}
   events.push({label,node,ready:true,model:d.modelCode,taskId:result.taskId,state:t.state,historyBefore:before,historyAfter:d.historyStorage.historyId,outputId:d.output[0].assetId,expectedAssetIds:assets,receivedAssetIds:actual,role,revision:snapshot.revision,edges:view.edges.map(e=>e.source+'>'+e.target)});record();console.log(label,t.state,actual.length,'verified');
   return {asset:d.output[0].assetId,exec:d.historyStorage.historyId,outputs:structuredClone(d.output)};
  };
  // One raw source feeds two branches, then *both generated* images feed a
  // first/last model. Creation order is intentionally unrelated to wire order.
  view.nodes.push(src('C',ids['b2-image']),{id:'story',type:'rh-text',position:{x:0,y:60},data:{text:'A windswept ridge.'}},
   gen('right','rh-image','qwen-image-edit-2511-v1','image-image'),gen('left','rh-image','qwen-image-edit-2511-v1','image-image'),
   gen('join','rh-video','h3-first-last-frame-v1','start-end-video'),gen('side','rh-video','h3-reference-v1','multimodal-video'));
  add('story','left');add('A','left');add('A','right');add('left','join');add('right','join');add('left','side');
  const left=(await step('left','text and A make left image',[ids['a-image']]))!,right=(await step('right','shared A makes independent right image',[ids['a-image']]))!;
  assert.notEqual(left.asset,right.asset);
  const join1=(await step('join','generated left / generated right become first and last',[left.asset,right.asset]))!;
  const side=(await step('side','same generated left also feeds side video',[left.asset]))!;
  n('join').data.imageOrder=[{nodeId:'right',url:'rhtv-asset:'+right.asset},{nodeId:'left',url:'rhtv-asset:'+left.asset}];
  const join2=(await step('join','reverse frames explicitly then regenerate',[right.asset,left.asset]))!;assert.notEqual(join1.exec,join2.exec);
  assert.equal(n('side').data.historyStorage.historyId,side.exec);
  drop('left');await step('join','delete left: join is missing one frame',[],false);await step('side','delete left: side is missing its only image',[],false);
  assert.equal(n('join').data.historyStorage.historyId,join2.exec);assert.equal(n('side').data.historyStorage.historyId,side.exec);
  add('C','join');add('C','side');await step('join','replace deleted branch with C; preserve right first',[right.asset,ids['b2-image']]);const newSide=(await step('side','reconnect alternate raw source and regenerate',[ids['b2-image']]))!;
  view.edges=view.edges.filter(e=>!(e.source==='A'&&e.target==='right'));add('B','right');const right2=(await step('right','replace input A of retained right branch by B',[ids['b-image']]))!;
  await step('join','consume new right result and C, never raw A or B',[right2.asset,ids['b2-image']]);
  // Native history selection displays the older output and sends the scoped
  // execution/index. The backend resolves that entry from the history store.
  n('right').data.selectedOutputHistoryId=right.exec;n('right').data.selectedOutputHistoryIndex=0;n('right').data.nodeOutputHistory=[{id:right.exec,outputs:right.outputs}];n('right').data.output=right.outputs;
  const joinUsingHistory=(await step('join','select older retained right result and regenerate',[right.asset,ids['b2-image']]))!;
  assert.equal(n('right').data.historyStorage.historyId,right2.exec);
  const motion=gen('move','rh-video','h3-motion-transfer-v1','video-motion-transfer');motion.data.params.prompt='';
  view.nodes.push(motion);add('A','move');add('side','move');const move1=(await step('move','motion uses a real generated side video plus reference image',[ids['a-image'],newSide.asset]))!;
  view.edges=view.edges.filter(e=>!(e.source==='side'&&e.target==='move'));await step('move','disconnect actual video; retain motion result but block generation',[],false);
  assert.equal(n('move').data.historyStorage.historyId,move1.exec);
  add('join','move');await step('move','replace missing video with current joined result',[ids['a-image'],joinUsingHistory.asset]);
  // Generate a new upstream video using the same current canvas; the next
  // motion request must consume the new output, not its previous task cache.
  const newestJoin=(await step('join','generate the same upstream video again',[right.asset,ids['b2-image']]))!;
  await step('move','regenerate motion with the newest generated video',[ids['a-image'],newestJoin.asset]);
  n('join').data.selectedOutputHistoryId=joinUsingHistory.exec;n('join').data.selectedOutputHistoryIndex=0;n('join').data.nodeOutputHistory=[{id:joinUsingHistory.exec,outputs:joinUsingHistory.outputs}];n('join').data.output=joinUsingHistory.outputs;
  await step('move','choose older generated video from history and regenerate motion',[ids['a-image'],joinUsingHistory.asset]);
  assert.equal(n('join').data.historyStorage.historyId,newestJoin.exec);assert.equal(n('side').data.historyStorage.historyId,newSide.exec);
 }else{
 for(const {model,kind,subType} of cases){
  const target=kind==='rh-image'?'live-image':'live-video';let previous:string|undefined;
  const submit=async(label:string,expected:string[],ready:boolean)=>{
   await save();
   const current=view.nodes.find(n=>n.id===target),history=current?.data?.historyStorage?.historyId;
   const count=bodyLog.length;
   const readiness=await ex.inspectGeneration(id,[target],view);
   if(!ready){assert.equal(readiness.status,'blocked',label);assert.equal(bodyLog.length,count);if(previous)assert.equal(history,previous);events.push({model,label,ready:false,reason:readiness.issues[0].code,history});record();return;}
   assert.equal(readiness.status,'ready',JSON.stringify(readiness));
   if(previous)assert.equal(history,previous,'prior result must survive reconnect');
   const run=await ex.run({projectId:id,targetType:'NODE',targetId:target,graph:structuredClone(view)});assert.equal(bodyLog.length,count+1);
   const body=bodyLog.at(-1),submitted=body.graph.nodes.find((n:any)=>n.id===target);
   assert.deepEqual(submitted.data.params.imageUrls,expected.map(asset=>'rhtv-asset:'+asset));
   let task:any;for(let attempt=0;attempt<160;attempt++){task=(await api.requestV2('/tasks/'+run.taskId)).data;if(['SUCCEEDED','FAILED','CANCELLED'].includes(task.state))break;await sleep(200);}
   const snap=await read(),after=view.nodes.find(n=>n.id===target),h=after?.data?.historyStorage?.historyId;
   events.push({model,label,ready:true,taskId:run.taskId,state:task.state,historyBefore:history,historyAfter:h,outputCount:after?.data?.output?.length??0,expectedAssetIds:expected,revision:snap.revision,detail:task.plans?.[0]?.errorCode});
   received.push({taskId:run.taskId,model,targetId:target,expectedAssetIds:expected});record();
   console.log(model,label,task.state,after?.data?.status,h?'has history':'no history');
   assert.equal(task.state,'SUCCEEDED',JSON.stringify({task:run.taskId,code:task.errorCode,msg:task.errorMessage,plan:task.plans?.[0]?.errorCode}));assert(h&&after.data.output?.length,'actual output and history must be written to server graph');assert.notEqual(h,previous);previous=h;
  };
  view.nodes.push({id:target,type:kind,position:{x:100,y:100},data:{modelCode:model,subType,params:{prompt:'A red kite above a green plain.'}}});
  view.edges.push(wire('A',target));await submit('generate from A',[ids['a-image']],true);
  view.edges=view.edges.filter(e=>e.target!==target);await submit('disconnect A; no task',[],false);
  view.edges.push(wire('B',target));await submit('generate again from B',[ids['b-image']],true);
  view.nodes=view.nodes.filter(n=>n.id!=='B');view.edges=view.edges.filter(e=>e.source!=='B');await submit('delete B; no task',[],false);
  view.nodes.push(src('B',ids['b2-image']));view.edges.push(wire('B',target));await submit('generate from recreated B',[ids['b2-image']],true);
  if(kind==='rh-image'){view.nodes.find(n=>n.id==='B')!.data.sourceObjects=['rhtv-asset:'+ids['b-image']];await save();}
 }
 const receipts=JSON.parse(readFileSync(dir+'/invocations.json','utf8')).filter((r:any)=>r.correlation?.projectRef===id);
 const yes=events.filter(e=>e.ready),no=events.filter(e=>!e.ready);assert.equal(yes.length,6);assert.equal(no.length,4);assert.equal(receipts.length,yes.length);
 for(const row of yes){const receipt=receipts.find((r:any)=>r.operationRef===row.historyAfter);assert(receipt,'receiver has no matching task operation');assert.equal(receipt.capability.ref,row.model);assert.deepEqual(receipt.attachments.map((a:any)=>a.sourceRef),row.expectedAssetIds);}
 console.log('All six worker receipts matched the saved execution and its current attachments. Four blocked edits created zero tasks.');
 }
}finally{record();ex.clear();lease.stop();storage.clear();}
