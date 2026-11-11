import {readFileSync,writeFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {videoModes} from '../../apps/web/src/service/video-input';
const catalog=JSON.parse(readFileSync(new URL('./fixtures/canvas-catalog-audit-20261104.json',import.meta.url),'utf8'));
it('produces a real canvas-runs request for each advertised model/mode, including official profiles with a fixture credential',async()=>{
 const samples=[];
 for(const raw of catalog.filter((c:any)=>c.model&&!c.testMode)){
  const cap=structuredClone(raw),schema=cap.parameterSchema,mode=schema['x-video-mode'];
  // Credential gating itself is tested against the original unkeyed catalog.
  cap.available=true;cap.reason=null;if(schema['x-model-source']?.credentialProviderRef){schema['x-model-source'].credentialConfigured=true;delete schema['x-model-source'].unavailableCode;}
  const video=cap.outputKinds.includes('VIDEO'),image=!video&&cap.outputKinds.includes('IMAGE'),id='target',type=video?'rh-video':image?'rh-image':'rh-text';
  const subType=video?videoModes[mode]:({LLM:'text-text',IMAGE_UNDERSTANDING:'image-text',IMAGE_TO_IMAGE:'image-image',IMAGE_ENHANCE:'image-hd',TEXT_TO_IMAGE:'text-image'} as Record<string,string>)[cap.kind];
  const expectedAssetIds=mode==='FIRST_LAST_FRAME'?['a-image','b-image']:mode==='MOTION_TRANSFER'?['a-image','a-video']:mode==='OMNI_REFERENCE'?['a-image',...(schema['x-media-limits']?.VIDEO?['a-video']:[]),...(schema['x-media-limits']?.AUDIO?['a-audio']:[])]:['FIRST_FRAME','LAST_FRAME'].includes(mode)||['IMAGE_UNDERSTANDING','IMAGE_TO_IMAGE','IMAGE_ENHANCE'].includes(cap.kind)?['a-image']:[];
  const mediaKind=(assetId:string)=>assetId.split('-').at(-1)!,ref=(assetId:string)=>'rhtv-asset:'+assetId;
  const parameters:any={prompt:schema['x-prompt-policy']==='ignored'?'':'A red kite over a green park'};
  for(const [key,f]of Object.entries(schema.properties) as [string,any][]){if(key==='count')continue;parameters[key==='reasoningEffort'?'reasoning_effort':key]=key==='subjectMapping'?[{referenceSubjectIndex:1,sourceSubjectIndex:0},{referenceSubjectIndex:0,sourceSubjectIndex:2}]:f.enum?f.enum.at(-1):f.type==='boolean'?!f.default:f.default;}
  const node={id,type,position:{x:400,y:0},data:{modelCode:cap.capabilityRef,capabilityVersion:cap.version,subType,params:parameters,...(schema.properties?.count?{generateNum:schema.properties.count.enum.at(-1)}:{})}};
  const graph={nodes:[...expectedAssetIds.map((source:string,i:number)=>({id:source,type:'rh-'+mediaKind(source),position:{x:0,y:100*i},data:{isUpload:true,sourceObjects:[ref(source)]}})),node],edges:expectedAssetIds.map((source:string)=>({id:'edge-'+source,source,target:id,sourceHandle:'output',targetHandle:'input'}))};
  let captured:any,revision=1;const ok=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+revision+'"'}});
  const api=new ProductClient('/api/v1',async(path,init)=>{
   if(path.includes('/model-capabilities'))return ok({items:[cap],nextCursor:null});
   if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1)!,kind=mediaKind(id);return ok({id,projectId:'p',fileName:id,kind:kind.toUpperCase(),mimeType:({audio:'audio/wav',image:'image/png',video:'video/mp4'} as any)[kind],byteSize:30000,width:640,height:360,durationSeconds:6,state:'READY'});}
   if(path.endsWith('/snapshot'))return ok({projectId:'p',revision:++revision,graph:JSON.parse(String(init.body)).graph,updatedAt:'2026-11-04T01:00:00Z'});
   if(path==='/api/v2/canvas-runs'){captured=JSON.parse(String(init.body));return ok({id:'audit',projectId:'p',canvasManaged:true,state:'SUCCEEDED',plans:[{executionId:'audit',nodeId:id,state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});}
   throw Error('Unexpected fixture request '+path);
  });
  api.setAccessToken('isolated-canvas');const storage=new ServiceStorage(api,()=>{}),exec=new ExecutionAdapter(api,storage,async()=>{},()=>{});
  storage.acceptRemoteSnapshot('p',{projectId:'p',revision,graph:encodeGraph(graph),updatedAt:'2026-11-04T01:00:00Z'},'"1"');storage.attachNativeView('p',graph);exec.attach('p',{localOnly:true,getRemoteData:()=>graph,patchNodeData:()=>{},flushOperationQueue:()=>{}});
  try{await exec.run({projectId:'p',targetType:'NODE',targetId:id,graph});expect(captured?.graph.nodes.find((n:any)=>n.id===id).data.capabilityRef).toBe(cap.capabilityRef);samples.push({name:cap.capabilityRef,expectedAssetIds,body:captured});}catch(error){throw Error(cap.capabilityRef+': '+String(error),{cause:error});}finally{exec.clear();}
 }
 expect(samples).toHaveLength(62);
 if(process.env.STUDIO_CANVAS_MODEL_EXPORT)writeFileSync(process.env.STUDIO_CANVAS_MODEL_EXPORT,samples.map(s=>JSON.stringify(s)).join('\n')+'\n');
});
