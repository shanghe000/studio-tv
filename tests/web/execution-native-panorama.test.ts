import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import captured from './fixtures/native-text-panorama-command.json';
const profile:any={capabilityRef:'codex-image-generate-v1',kind:'TEXT_TO_IMAGE',version:'3',parameterSchemaVersion:'3',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1,2,4],default:1},transparentBackground:{type:'boolean',default:false}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(options:{catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>;cap?:any}={}){
 const fixture=structuredClone(captured),graph:any={nodes:[fixture.baseline],edges:[]},command:any={nodes:[fixture.command],edges:[]},target=fixture.targetId,requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{requests.push({path,body:init?.body?JSON.parse(init.body):undefined});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[options.cap??profile,{...profile,capabilityRef:'other-real-v1'}],nextCursor:null});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(JSON.parse(init.body))??json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-22T04:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'t',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:target,executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-22T03:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 return{fixture,graph,command,target,adapter,storage,requests,submit:()=>adapter.run({projectId:'p',targetType:'NODE',targetId:target,graph:command}),submitted:()=>requests.filter(value=>value.path==='/api/v2/canvas-runs')};
}
it('submits the actual native text panorama command with its real model and recipe scene',async()=>{
 const c=setup();try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body;expect(body.expectedRevision).toBe(2);expect(body.graph.nodes[0].data).toMatchObject({modelCode:profile.capabilityRef,capabilityRef:profile.capabilityRef,capabilityVersion:'3',sceneCode:'canvas-image-panorama-text',params:{prompt:c.fixture.baseline.data.params.prompt,transparentBackground:false}});expect(c.graph.nodes[0].data.modelCode).toBe(c.fixture.baseline.data.modelCode);expect(c.graph.nodes[0].data).not.toHaveProperty('sceneCode');expect(c.storage.isBlocked('p')).toBe(false);}finally{c.adapter.clear();}
});
it.each(['model','paused-model','scene','existing-scene','unlocked','not-panorama','preset','prompt','edge','test-mode','unreviewed-version'])('rejects a changed panorama input or an unreviewed projection: %s',async change=>{
 const cap=structuredClone(profile);if(change==='test-mode')cap.testMode=true;if(change==='unreviewed-version')cap.version='4';const c=setup({cap}),before=c.graph.nodes[0].data,after=c.command.nodes[0].data;
 if(change==='model')after.modelCode='other-real-v1';if(change==='paused-model')before.panorama.pausedModel='other-real-v1';if(change==='scene')after.sceneCode='canvas-image-panorama-image';if(change==='existing-scene')before.sceneCode='another-scene';if(change==='unlocked')before.panorama.locked=false;if(change==='not-panorama')before.panorama.isPanoramaNode=false;if(change==='preset')after.presetSelections=[];if(change==='prompt')after.params.prompt='changed';if(change==='edge')c.graph.edges.push({source:'unknown',target:c.target});
 try{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['native-transition','model','scene','prompt','preset','reference','deleted'])('guards edits while panorama model resolution is pending: %s',async change=>{
 let finish!:(value:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(),rejected=change==='native-transition'?undefined:expect(pending).rejects.toBeDefined();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=c.graph.nodes[0].data;
  if(change==='native-transition'){data.modelCode=profile.capabilityRef;data.sceneCode='canvas-image-panorama-text';}if(change==='model')data.modelCode='other-real-v1';if(change==='scene')data.sceneCode='other-scene';if(change==='prompt')data.params.prompt='later';if(change==='preset')data.presetSelections=[];if(change==='reference')c.graph.edges.push({source:'later',target:c.target});if(change==='deleted')c.graph.nodes=[];
  finish(json({items:[profile],nextCursor:null}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);}
 }finally{c.adapter.clear();}
});
it.each(['native-transition','later-prompt'])('keeps panorama guards during the snapshot save: %s',async change=>{
 let finish!:(value:Response)=>void,saved:any;const c=setup({save:body=>{saved=body;return new Promise(resolve=>finish=resolve);}});
 try{const pending=c.submit(),rejected=change==='later-prompt'?expect(pending).rejects.toBeDefined():undefined;await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=c.graph.nodes[0].data;data.modelCode=profile.capabilityRef;data.sceneCode='canvas-image-panorama-text';if(change==='later-prompt')data.params.prompt='later';finish(json({projectId:'p',revision:2,graph:saved.graph,updatedAt:'2026-10-22T04:00:00Z'}));if(rejected){await rejected;expect(c.submitted()).toHaveLength(0);}else{await pending;expect(c.submitted()).toHaveLength(1);expect(c.storage.isBlocked('p')).toBe(false);}
 }finally{c.adapter.clear();}
});
