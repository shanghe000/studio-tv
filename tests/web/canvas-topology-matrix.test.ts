import {readFileSync,writeFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import catalog from './fixtures/canvas-catalog-audit-20261104.json';
import {inspectCanvasConnection} from '../../apps/web/src/service/connection-readiness';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {applyCanvasOperations,type CanvasOperation} from '../../apps/web/src/service/canvas-operations';
import {encodeGraph,decodeGraph} from '../../apps/web/src/service/graph';
import {videoModes} from '../../apps/web/src/service/video-input';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=frozen.indexOf('const un={VIDEO:'),end=frozen.indexOf(',npn={',start);
const native=runInNewContext(frozen.slice(start,end)+';({types:Object.values(un),ports:JQ})');
const kinds=['TEXT','STRUCTURED','IMAGE','VIDEO','AUDIO'] as const;
const types={TEXT:'rh-text',STRUCTURED:'rh-script',IMAGE:'rh-image',VIDEO:'rh-video',AUDIO:'rh-audio'};
const publicRows=(catalog as any[]).filter(c=>!c.testMode&&c.available);
const keyedRows=(catalog as any[]).filter(c=>!c.testMode&&!c.available&&c.parameterSchema['x-model-source']?.credentialProviderRef).map(raw=>{
 const c=structuredClone(raw);c.available=true;c.reason=null;c.parameterSchema['x-model-source'].credentialConfigured=true;delete c.parameterSchema['x-model-source'].unavailableCode;return c;
});
const result=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
const pos={x:0,y:0};
function asset(id:string){
 const kind=id.split('-').at(-1)?.toUpperCase()??'';return{id,projectId:'p',kind,state:'READY',mimeType:{IMAGE:'image/png',VIDEO:'video/mp4',AUDIO:'audio/mpeg'}[kind]??'image/png',byteSize:4096,width:768,height:768,durationSeconds:6};
}
function source(id:string,kind:typeof kinds[number]):any {
 const ref='rhtv-asset:'+id+'-'+kind.toLowerCase();
 return{id,type:types[kind],position:pos,data:kind==='TEXT'?{text:'Direction '+id}:kind==='STRUCTURED'?{applicationInput:{subject:id}}:{isUpload:true,sourceObjects:[ref]}};
}
function target(id:string,cap:any):any{
 const type=cap.outputKinds.includes('VIDEO')?'rh-video':cap.outputKinds.includes('IMAGE')?'rh-image':'rh-text';
 const subType=type==='rh-video'?videoModes[cap.parameterSchema['x-video-mode']]:({'TEXT_TO_IMAGE':'text-image','IMAGE_TO_IMAGE':'image-image','IMAGE_ENHANCE':'image-hd','IMAGE_UNDERSTANDING':'image-text','LLM':'text-text'} as Record<string,string>)[cap.kind];
 return{id,type,position:pos,data:{modelCode:cap.capabilityRef,subType,params:{prompt:cap.parameterSchema['x-prompt-policy']==='ignored'?'':'A red kite'},capabilityVersion:cap.version}};
}
const edge=(source:string,target:string)=>({id:source+'-'+target,source,target,sourceHandle:'output',targetHandle:'input'});
const connect=(src:string,dst:string):CanvasOperation=>({type:'edge.create',edge:edge(src,dst)});
const disconnect=(src:string,dst:string):CanvasOperation=>({type:'edge.delete',edgeId:edge(src,dst).id});
const forget=(id:string):CanvasOperation=>({type:'node.delete',nodeId:id});
const create=(node:any):CanvasOperation=>({type:'node.create',node:encodeGraph({nodes:[node],edges:[]}).nodes[0]});
const stepNames=['connect A','disconnect A','reconnect A','replace A with B','delete B','create B2 and connect','delete target','create target and connect A','add B2 to A','disconnect and reconnect A last','rank A first'];
// Independent service contract oracle. It knows the desired source IDs of each
// edit, not the reducer/adapter result or the connection guard's decision.
const desired=['a','','a','b','','b2','','a','a b2','b2 a','a b2'];
function contract(cap:any,step:number,a:string,b:string){
 const names=desired[step].split(' ').filter(Boolean),kinds=names.map(n=>n==='a'?a:b);
 const count=(k:string)=>kinds.filter(t=>t===k).length,limits=cap.parameterSchema['x-input-constraints']??{},output=cap.outputKinds[0];
 if(step===6)return 'no target';
 if(cap.parameterSchema['x-model-source']?.credentialProviderRef){
  const schema=cap.parameterSchema,mode=schema['x-video-mode'],media=['IMAGE','VIDEO','AUDIO'],n=media.reduce((x,k)=>x+count(k),0);
  if(kinds.some(k=>!cap.inputKinds.includes(k))||media.some(k=>count(k)>(schema['x-media-limits'][k]??0))||n>schema['x-media-total-limit'])return 'forbidden';
  if(mode==='FIRST_LAST_FRAME'&&count('IMAGE')!==2||['FIRST_FRAME','LAST_FRAME'].includes(mode)&&!count('IMAGE')||mode==='OMNI_REFERENCE'&&(!n||schema['x-reference-requirement']!=='ANY_MEDIA'&&!count('IMAGE')&&!count('VIDEO')))return 'missing';
  return 'ready';
 }
 if((['TEXT','IMAGE'].includes(output)&&kinds.includes('AUDIO'))||(output==='IMAGE'&&kinds.includes('VIDEO'))||kinds.some(k=>!cap.inputKinds.includes(k))||['IMAGE','VIDEO','AUDIO'].some(k=>count(k)>(limits['max_'+k.toLowerCase()+'s']??100)))return 'forbidden';
 if((['IMAGE_UNDERSTANDING','IMAGE_TO_IMAGE'].includes(cap.kind)&&!count('IMAGE'))||['IMAGE','VIDEO','AUDIO'].some(k=>count(k)<(limits['min_'+k.toLowerCase()+'s']??0))||(limits.require_visual&&!count('IMAGE')&&!count('VIDEO')))return 'missing';
 return 'ready';
}
const categories=['ready','missing','forbidden','no target'] as const;
it('audits all native base type pairs, with distinct node IDs',()=>{
 expect(native.types.length).toBe(17);
 const allowed=native.types.flatMap((from:string)=>native.types.filter((to:string)=>native.ports[from]?.includes(to)));
 expect(allowed.length).toBe(51);
});
it.each(['public','credentialed'] as const)('classifies each editing sequence via the reducer, connection guard and execution (%s models)',async(access)=>{
 const rows=access==='public'?publicRows:keyedRows;
 const timeline:any[]=[],runRows:any[]=[],lines:string[]=['operation,sourceA,sourceB,model,version,status,reason,assetIds'],issues:string[]=[];
 const tally=Array.from({length:stepNames.length},()=>[0,0,0,0]);
 for(const cap of rows)for(const a of kinds)for(const b of kinds){
  const t=target('t',cap),u=target('u',cap),a1=source('a',a),b1=source('b',b),b2=source('b2',b);
  let state=encodeGraph({nodes:[b1,t,a1],edges:[]}),view=decodeGraph(state),captured:any,revision=0;
  const api=new ProductClient('/api/v1',async(path,init)=>{
   if(path.includes('model-capabilities'))return result({items:[cap],nextCursor:null});
   if(path.startsWith('/api/v1/assets/'))return result(asset(path.split('/').at(-1)!));
   if(path.endsWith('/snapshot'))return result({projectId:'p',revision:++revision,graph:JSON.parse(String(init.body)).graph,updatedAt:'2026-11-04T01:02:03Z'});
   if(path==='/api/v2/canvas-runs'){captured=JSON.parse(String(init.body));return result({id:'audit',projectId:'p',canvasManaged:true,state:'SUCCEEDED',plans:[{executionId:'audit',nodeId:captured.targetId,state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});}
   throw Error('Unexpected topology fixture URL: '+path);
  });api.setAccessToken('audit');
  const storage=new ServiceStorage(api,()=>{}),ex=new ExecutionAdapter(api,storage,async()=>{},()=>{}),manager={localOnly:true,getRemoteData:()=>view,patchNodeData:()=>{},flushOperationQueue:()=>{}};
  (ex as any).capabilities.set(cap.capabilityRef,cap);ex.attach('p',manager);
  const edits:CanvasOperation[][]=[[connect('a','t')],[disconnect('a','t')],[connect('a','t')],[disconnect('a','t'),connect('b','t')],[forget('b')],[create(b2),connect('b2','t')],[forget('t')],[create(u),connect('a','u')],[connect('b2','u')],[disconnect('a','u'),connect('a','u')],[{type:'node.patch',nodeId:'u',set:['image','video','audio'].map(k=>({path:['data',k+'Order'],value:['a','b2']})),unset:[]}]];
  try{for(let i=0;i<edits.length;i++){
   const beforeState=state;state=applyCanvasOperations(state,edits[i]);view=decodeGraph(state);captured=undefined;
   const dst=i<7?'t':'u',node=view.nodes.find(n=>n.id===dst),incoming=view.edges.filter(e=>e.target===dst),sources=incoming.map(e=>view.nodes.find(n=>n.id===e.source)!);
   expect(sources.every(Boolean)).toBe(true);
   const ordered=i===10&&a===b?[...sources].sort((a,b)=>Number(b.id==='a')-Number(a.id==='a')):sources;
   const ids=ordered.flatMap(n=>(n.data.sourceObjects??[]).map((ref:string)=>ref.slice(11)));
   const desiredIds=(i===10&&a!==b?'b2 a':desired[i]).split(' ').filter(Boolean).flatMap(n=>{const k=n==='a'?a:b;return ['IMAGE','VIDEO','AUDIO'].includes(k)?[n+'-'+k.toLowerCase()]:[];});if(JSON.stringify(ids)!==JSON.stringify(desiredIds))issues.push('operation changed the wrong inputs: '+stepNames[i]);
   let status:typeof categories[number]='ready',reason='';
   if(!node){status='no target';reason='target deleted';}
   else {
    let prev={...view,edges:[] as any[]};
    for(const e of incoming){
     if(!native.ports[view.nodes.find(n=>n.id===e.source)!.type]?.includes(node.type)){status='forbidden';reason='native ports';break;}
     const gate=inspectCanvasConnection(e,prev,[cap]);if(!gate.allowed){status='forbidden';reason=gate.code!;break;}
     prev.edges.push(e);
    }
    if(status==='ready')try{
     const prepared=await (ex as any).prepareGenerationNode('p',node,view,(ex as any).epoch,{nativeVideoComposer:true,preview:true});
     if(prepared.cap.capabilityRef!==cap.capabilityRef)throw Error('model mismatch');
     const facts=prepared.inputAssets.map((r:any)=>r.assetId).sort();if(JSON.stringify([...new Set(ids)].sort())!==JSON.stringify(facts)){throw Error('reference mismatch '+ids+' / '+facts);}
     if(node.type==='rh-video')for(const k of ['image','video','audio']){
      const expected=ids.filter((id:string)=>id.endsWith('-'+k)),actual=(prepared.node.data.params[k+'Urls']??[]).map((r:string)=>r.slice(11));if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('order mismatch '+expected+' / '+actual);
     }
     // Capture the outgoing client API body for all ready image/video cases when
     // exporting. The same code also runs on CI for representative multi-step cases.
     if(process.env.STUDIO_CANVAS_AUDIT_EXPORT||a==='IMAGE'&&b==='IMAGE'&&['h3-first-last-frame-v1','qwen-image-edit-2511-v1'].includes(cap.capabilityRef)){
      storage.acceptRemoteSnapshot('p',{projectId:'p',revision:++revision,graph:state,updatedAt:'2026-11-04T01:00:00Z'},'"'+revision+'"');storage.attachNativeView('p',view);
      captured=undefined;await ex.run({projectId:'p',targetType:'NODE',targetId:dst,graph:view});
      if(!captured)throw Error('canvas-runs not captured');
      runRows.push({model:cap.capabilityRef,version:cap.version,step:i+1,sourceA:a,sourceB:b,expectedAssetIds:ids,body:captured});
     }
    }catch(err:any){
     if(['MODEL_INPUT_UNSUPPORTED','VIDEO_REFERENCE_REQUIRED','MODEL_UNAVAILABLE'].includes(err.code)){
      const counts=ids.map((id:string)=>asset(id).kind);
      if(cap.kind==='LLM'&&counts.includes('IMAGE')&&!(cap.inputKinds??[]).includes('IMAGE'))status='forbidden';else status='missing';
      reason=err.code;
     }else {issues.push([cap.capabilityRef,a,b,stepNames[i],err.code,err.message].join(' / '));status='forbidden';reason='ERROR';}
    }
   }
   if(process.env.STUDIO_CANVAS_AUDIT_EXPORT&&a==='IMAGE'&&b==='IMAGE'&&['h3-reference-v1','h3-first-last-frame-v1','qwen-image-edit-2511-v1'].includes(cap.capabilityRef)){
    timeline.push({model:cap.capabilityRef,step:i+1,action:stepNames[i],sourceA:a,sourceB:b,expectedAssetIds:ids,expectedStatus:status,operations:edits[i],...(i===0?{initialGraph:beforeState}:{}),graph:view,targetId:dst,body:status==='ready'?captured:null});
   }
   if(status!==contract(cap,i,a,b))issues.push([cap.capabilityRef,a,b,stepNames[i],status,contract(cap,i,a,b),reason].join(' / '));
   tally[i][categories.indexOf(status)]++;lines.push([i+1,a,b,cap.capabilityRef,cap.version,status,reason,ids.join(';')].join(','));
  }}finally{ex.clear();}
 }
 if(process.env.STUDIO_CANVAS_AUDIT_EXPORT){const prefix=process.env.STUDIO_CANVAS_AUDIT_EXPORT+(access==='public'?'':'-credentialed');writeFileSync(prefix+'-timeline.jsonl',timeline.map(r=>JSON.stringify(r)).join('\n')+'\n');writeFileSync(prefix+'-matrix.csv',lines.join('\n')+'\n');writeFileSync(prefix+'-requests.jsonl',runRows.map(r=>JSON.stringify(r)).join('\n')+'\n');writeFileSync(prefix+'-counts.json',JSON.stringify({models:rows.length,cases:lines.length-1,steps:stepNames,categories,tally,issues:issues.slice(0,40)},null,2));}
 expect(issues.slice(0,30)).toEqual([]);
 const checksum=(raw:string)=>createHash('sha256').update(raw).digest('hex');
 const report=access==='public'?'canvas-topology-matrix.csv':'canvas-topology-credentialed.csv';
 expect(checksum(lines.join('\n')+'\n'),report+' is stale: regenerate from STUDIO_CANVAS_AUDIT_EXPORT').toBe(checksum(readFileSync(new URL('../../docs/acceptance/'+report,import.meta.url),'utf8')));
 expect(rows.length).toBe(access==='public'?28:36);expect(lines.length-1).toBe(rows.length*5*5*11);
},120000);
