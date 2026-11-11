// Compiled into a temporary script by the acceptance runner, never shipped.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {diffCanvasOperations} from '../../apps/web/src/service/canvas-operations';
const [dir,file,mode='cases']=process.argv.slice(2),origin=fs.readFileSync(path.join(dir,'origin'),'utf8'),project='p',client='acceptance-page',root='/api/v2/projects/'+project;
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
async function call(url:string,body?:any){
 const r=await fetch(origin+url,{method:body?'POST':'GET',headers:{Authorization:'Bearer test-access','Content-Type':'application/json','X-STUDIO-Canvas-Session':client,'Idempotency-Key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})}),data=await r.json();
 if(!r.ok)throw Error(url+' '+r.status+': '+JSON.stringify(data).slice(0,640));return data.data;
}
const snap=()=>call('/api/v1/projects/'+project+'/snapshot');
const ops=(operations:any[])=>call(root+'/canvas-operations',{schemaVersion:'1',clientId:client,batchId:crypto.randomUUID(),operations});
const snapshotFor=async(target:any)=>{const s=await snap(),operations=diffCanvasOperations(s.graph,target);return operations.length?await ops(operations):s;};
const signed=(eid:string)=>JSON.parse(fs.readFileSync(path.join(dir,'invocations.json'),'utf8')).filter((r:any)=>r.operationRef===eid);
const outcomes:any[]=[];const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(x=>JSON.parse(x));
for(const [i,row] of rows.entries()){
 const name=row.name??[row.model,row.sourceA,row.sourceB,row.step].join('/');try{
  await call(root+'/edit-session',{clientId:client});
  if(mode==='timeline'){
   if(row.initialGraph)await snapshotFor(row.initialGraph);
   if(row.operations.length)await ops(row.operations); // Includes explicitly imported invalid states; preflight decides admission.
   const graph=(await snap()).graph;
   const shape=(edges:any[])=>edges.map(({source,target})=>[source,target]);
   assert.deepEqual(shape(graph.edges),shape(row.graph.edges));assert.deepEqual(new Set(graph.nodes.filter((n:any)=>n.type!=='__rhtv_meta').map((n:any)=>n.id)),new Set(row.graph.nodes.map((n:any)=>n.id)));
   if(!row.body){assert.notEqual(row.expectedStatus,'ready');outcomes.push({name,submitted:false,reason:row.expectedStatus});continue;}
  }
  const body={...row.body,projectId:project};const target=body.graph.nodes.find((n:any)=>n.id===body.targetId);
  if(body.expectedRevision!=null){
   const graph=encodeGraph({...body.graph,edges:body.graph.edges.map((e:any,index:number)=>({...e,id:e.id??('line'+index)}))});
   body.expectedRevision=(await snapshotFor(graph)).revision;
  }
  const task=await call('/api/v2/canvas-runs',body);
  const plan=task.plans.find((p:any)=>p.nodeId===body.targetId);assert.ok(plan);
  let result=task;for(let n=0;n<400&&!['SUCCEEDED','FAILED','CANCELED'].includes(result.state);n++){await new Promise(r=>setTimeout(r,80));result=await call('/api/v2/tasks/'+task.id);}
  const p=result.plans.find((p:any)=>p.nodeId===body.targetId);
  const [wire,...extra]=signed(plan.executionId);assert.ok(wire,'worker did not reach Router: '+JSON.stringify([result.state,p.errorCode,p.errorMessage]));assert.equal(extra.length,0);assert.equal(wire.capability.ref,target.data.capabilityRef);assert.equal(wire.capability.version,target.data.capabilityVersion);
  assert.deepEqual(wire.parameters,target.data.routerParameters??{});
  const assets=wire.input.filter((part:any)=>part.type==='MEDIA').map((part:any)=>wire.attachments.find((a:any)=>a.attachmentRef===part.attachmentRef)??wire.attachments.find((a:any)=>a.ref===part.attachmentRef)).map((a:any)=>a.sourceRef);
  if(row.expectedAssetIds)assert.deepEqual(assets,row.expectedAssetIds);
  if(row.expectedPortraitRecipeId){
   const conditions=wire.input.find((part:any)=>part.type==='STRUCTURED'&&part.data?.schemaCode==='STUDIO_PROMPT_CONDITIONS_V1')?.data;
   assert.equal(conditions?.featureCode,'image.portrait-adjust');
   assert.deepEqual(conditions.conditions.imageRecipes.map((recipe:any)=>recipe.id),[row.expectedPortraitRecipeId]);
  }
  if(row.sourceA&&row.sourceB){
   const direct=body.graph.edges.filter((e:any)=>e.target===body.targetId).map((e:any)=>body.graph.nodes.find((n:any)=>n.id===e.source));
   const expected=[...(target.data.params?.prompt?[{type:'TEXT',text:target.data.params.prompt}]:[]),...direct.flatMap((n:any)=>n.type==='rh-text'?[{type:'TEXT',text:n.data.text}]:n.data.applicationInput?[{type:'STRUCTURED',schemaVersion:'1',data:n.data.applicationInput}]:[])];
   const actual=wire.input.filter((p:any)=>p.type==='TEXT'||p.type==='STRUCTURED').map((part:any,i:number)=>{
    // Comfy / official visual adapters accept arbitrary user scripts as
    // lossless compact JSON user text; STUDIO prompt-control envelopes stay typed.
    if((target.type==='rh-image'||target.type==='rh-video')&&expected[i]?.type==='STRUCTURED'&&part.type==='TEXT'){
     let script;try{script=JSON.parse(part.text)}catch{return part;}
     return {type:'STRUCTURED',data:script,schemaVersion:'1'};
    }
    return part;
   });
   assert.deepEqual(actual,expected,'authored description, text and structured inputs must follow current wires');
  }
  if(mode==='timeline')assert.equal(result.state,'SUCCEEDED','synthetic writeback: '+JSON.stringify([p.errorCode,p.errorMessage]));
  outcomes.push({name,submitted:true,operationRef:plan.executionId,model:wire.capability.ref,assets,syntheticState:result.state});
 }catch(e){outcomes.push({name,error:String(e)});console.error(name,String(e));if(process.env.STUDIO_QA_STOP_FIRST==='1')break;}
}
const log=path.join(dir,path.basename(file)+'.'+mode+'.results.json');fs.writeFileSync(log,JSON.stringify(outcomes,null,2));console.log({file,checked:outcomes.length,delivered:outcomes.filter(x=>x.submitted).length,blocked:outcomes.filter(x=>x.submitted===false).length,errors:outcomes.filter(x=>x.error).length});
if(outcomes.some(row=>row.error))process.exitCode=1;
