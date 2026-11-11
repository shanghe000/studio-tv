import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import captured from './fixtures/native-selected-text-image-command.json';
import savedSource from './fixtures/native-selected-text-image-saved-source.json';
const profile:any={capabilityRef:'z-image-turbo-generate-v1',kind:'TEXT_TO_IMAGE',version:'1',parameterSchemaVersion:'1',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],model:{providerRef:'comfy',modelRef:'z-image-turbo',title:'Z-Image-Turbo',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1,2,4],default:1},outputPreset:{type:'string',enum:['1024-square'],default:'1024-square'}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(options:{catalog?:()=>Promise<Response>;save?:(body:any)=>Promise<Response>;cap?:any;fixture?:any}={}){
 const fixture=structuredClone(options.fixture??captured),graph:any=fixture.baseline,command:any=fixture.command,target=fixture.targetId,requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{requests.push({path,body:init?.body?JSON.parse(init.body):undefined});
  if(path.includes('model-capabilities'))return options.catalog?.()??json({items:[options.cap??profile,{...profile,capabilityRef:'other-real-v1'}],nextCursor:null});
  if(path==='/api/v1/projects/p/snapshot')return options.save?.(JSON.parse(init.body))??json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-22T04:00:00Z'});
  if(path==='/api/v2/canvas-runs')return json({id:'t',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:3,testMode:false,plans:[{nodeId:target,executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});
  throw new Error('Unexpected route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:fixture.capturedServerGraph??encodeGraph(graph),updatedAt:'2026-10-22T03:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 return{fixture,graph,command,target,adapter,storage,requests,submit:()=>adapter.run({projectId:'p',targetType:'NODE',targetId:target,graph:command}),submitted:()=>requests.filter(value=>value.path==='/api/v2/canvas-runs')};
}
it('submits the captured selected-text native image chain without baking its connected text into the raw prompt',async()=>{
 const c=setup();try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,target=body.graph.nodes.find((node:any)=>node.id===c.target);expect(body.expectedRevision).toBe(2);expect(body.graph.nodes).toHaveLength(3);expect(body.graph.edges).toHaveLength(2);expect(target.data.params.prompt).toBe('');expect(target.data.prompt).toBe('');expect(target.data.params.text).toBe('');expect(target.data.capabilityRef).toBe(profile.capabilityRef);expect(c.storage.isBlocked('p')).toBe(false);}finally{c.adapter.clear();}
});
it('preserves exact historical source metadata omitted by the real reloaded native text view',async()=>{
 const c=setup({fixture:savedSource});
 try{await c.submit();expect(c.submitted()).toHaveLength(1);const body=c.submitted()[0].body,original=body.graph.nodes.find((n:any)=>n.id===savedSource.baseline.nodes[0].id),target=body.graph.nodes.find((n:any)=>n.id===c.target);
  expect(original.data).toMatchObject({text:'STUDIOTV生成入口验收通过',textUiCategory:'text-text',routerParameters:{reasoningEffort:'low'},userPromptSnapshot:{paramName:'prompt',value:'请只输出「STUDIOTV生成入口验收通过」，不要额外说明。'}});
  expect(target.data.params.prompt).toBe('');expect(body.graph.nodes).toHaveLength(3);expect(body.graph.edges).toHaveLength(2);
 }finally{c.adapter.clear();}
});
it.each(['text','content','params','history','model','category'])('rejects source changes against the actual saved source receipt: %s',async change=>{
 const c=setup({fixture:savedSource}),original=c.graph.nodes.find((n:any)=>n.id===savedSource.baseline.nodes[0].id);
 if(change==='text')original.data.text='new user source text';if(change==='content')original.data.content='new content';if(change==='params')original.data.params.prompt='new generation request';if(change==='history')original.data.historyStorage.historyId='exe_other';if(change==='model')original.data.modelCode='other-real-v1';if(change==='category')original.data.textUiCategory='text-lyrics';
 try{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['text','category','history'])('rejects server save receipt changes without borrowing the new %s field',async change=>{
 const c=setup({fixture:savedSource,save:async body=>{const graph=structuredClone(body.graph),original=graph.nodes.find((n:any)=>n.id===savedSource.baseline.nodes[0].id);if(change==='text')original.data.text='new server source';if(change==='category')original.data.textUiCategory='text-lyrics';if(change==='history')original.data.historyStorage.historyId='exe_new_server';return json({projectId:'p',revision:2,graph,updatedAt:'2026-10-22T04:00:00Z'});}});
 try{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['raw-prompt','command-prompt','direct-text','ancestor-text','source-model','edge'])('rejects a changed selected-text image command: %s',async change=>{
 const c=setup(),target=c.command.nodes.find((node:any)=>node.id===c.target),source=c.command.nodes.find((node:any)=>node.type==='rh-text');
 if(change==='raw-prompt')target.data.userPromptSnapshot.value='forged';if(change==='command-prompt')target.data.params.prompt='forged';if(change==='direct-text')source.data.text='forged';if(change==='ancestor-text'||change==='source-model'){const ancestor=structuredClone(c.graph.nodes[0]);if(change==='ancestor-text')ancestor.data.content='forged';else ancestor.data.modelCode='other-real-v1';c.command.nodes.push(ancestor);}if(change==='edge')c.command.edges[0].conditioningRole='FIRST_FRAME';
 try{await expect(c.submit()).rejects.toBeDefined();expect(c.submitted()).toHaveLength(0);}finally{c.adapter.clear();}
});
it.each(['text','ancestor','edge','prompt','deleted'])('guards live selected-text edits while resolving the image model: %s',async change=>{
 let finish!:(value:Response)=>void;const c=setup({catalog:()=>new Promise(resolve=>finish=resolve)});
 try{const pending=c.submit(),rejected=expect(pending).rejects.toBeDefined();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='text')c.graph.nodes.find((node:any)=>node.id===c.command.edges[0].source).data.text='later';if(change==='ancestor')c.graph.nodes[0].data.content='later';if(change==='edge')c.graph.edges.pop();if(change==='prompt')c.graph.nodes.find((node:any)=>node.id===c.target).data.params.prompt='later';if(change==='deleted')c.graph.nodes=c.graph.nodes.filter((node:any)=>node.id!==c.target);
  finish(json({items:[profile],nextCursor:null}));await rejected;expect(c.submitted()).toHaveLength(0);
 }finally{c.adapter.clear();}
});
