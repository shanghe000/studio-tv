import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import captured from './fixtures/native-image-composer-command.json';
const profile:any={capabilityRef:'codex-image-edit-v1',kind:'IMAGE_TO_IMAGE',version:'3',parameterSchemaVersion:'3',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(options:{catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>;cap?:any}={}){
 const fixture=structuredClone(captured),graph:any={nodes:[fixture.baseline],edges:[]},command:any={nodes:[fixture.command],edges:[]},target=fixture.targetId,requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{requests.push({path,body:init?.body?JSON.parse(init.body):undefined});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[options.cap??profile,{...profile,capabilityRef:'other-real-v1'}],nextCursor:null});
  if(path==='/api/v2/catalog/media/materialize')return json({asset:{byteSize:2048,mimeType:'image/png',id:'style-reference',kind:'IMAGE',state:'READY',downloadUrl:fixture.command.data.params.imageUrls[0]}});
  if(path.startsWith('/api/v1/assets/'))return json({byteSize:2048,mimeType:'image/png',id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(JSON.parse(init.body))??json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-22T04:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'t',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:target,executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-22T03:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 return{fixture,graph,command,target,adapter,storage,requests,submit:()=>adapter.run({projectId:'p',targetType:'NODE',targetId:target,graph:command}),submitted:()=>requests.filter(value=>value.path==='/api/v2/canvas-runs')};
}
it('submits the actual native style-driven model switch, omitting only the unused Comfy preset',async()=>{
 const c=setup();try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,data=body.graph.nodes[0].data;expect(body.expectedRevision).toBe(2);expect(data.params).not.toHaveProperty('outputPreset');expect(data.params.prompt).toBe(c.fixture.baseline.data.params.prompt);expect(data.params.imageUrls).toEqual(['rhtv-asset:style-reference']);expect(c.requests.filter(value=>value.path==='/api/v2/catalog/media/materialize')).toHaveLength(1);expect(data.presetSelections).toEqual(c.fixture.baseline.data.presetSelections);expect(data.cameraControl).toEqual(c.fixture.baseline.data.cameraControl);expect(c.storage.isBlocked('p')).toBe(false);}finally{c.adapter.clear();}
});
it.each(['unknown-preset','declared-preset','test-model','changed-style','changed-camera','changed-prompt','changed-reference'])('keeps unsupported or changed composer input guarded: %s',async change=>{
 const cap=structuredClone(profile);if(change==='declared-preset')cap.parameterSchema.properties.outputPreset={type:'string'};if(change==='test-model')cap.testMode=true;const c=setup({cap}),before:any=c.graph.nodes[0].data,after:any=c.command.nodes[0].data;
 if(change==='unknown-preset')before.params.outputPreset='other';if(change==='changed-style')after.presetSelections[1].id='anime_illustration';if(change==='changed-camera')after.cameraControl.selection.aperture=2;if(change==='changed-prompt')after.params.prompt='forged';if(change==='changed-reference')after.params.imageUrls=['rhtv-asset:other'];
 try{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['native-omission','preset','style','camera','prompt','reference'])('guards current composer edits while resolving the model: %s',async change=>{
 let finish!:(value:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(),rejected=change==='native-omission'?undefined:expect(pending).rejects.toBeDefined();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data:any=c.graph.nodes[0].data;
  if(change==='native-omission')delete data.params.outputPreset;if(change==='preset')data.params.outputPreset='other';if(change==='style')data.presetSelections[1].id='anime_illustration';if(change==='camera')data.cameraControl.selection.aperture=2;if(change==='prompt')data.params.prompt='later';if(change==='reference')data.params.imageUrls=['rhtv-asset:other'];
  finish(json({items:[profile],nextCursor:null}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);}
 }finally{c.adapter.clear();}
});
it.each(['native-omission','later-style'])('keeps style input guarded while saving: %s',async change=>{
 let finish!:(value:Response)=>void,saved:any;const c=setup({save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.submit(),rejected=change==='later-style'?expect(pending).rejects.toBeDefined():undefined;await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));delete c.graph.nodes[0].data.params.outputPreset;if(change==='later-style')c.graph.nodes[0].data.presetSelections[1].id='anime_illustration';finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-10-22T04:00:00Z'}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.storage.isBlocked('p')).toBe(false);}
 }finally{c.adapter.clear();}
});
