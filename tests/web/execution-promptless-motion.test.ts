import {expect,it,vi} from 'vitest';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';
import captured from './fixtures/native-h3-motion-empty-command.json';
import catalog from './fixtures/router-motion-capabilities.json';
import sourceCatalog from './fixtures/router-motion-source-capabilities.json';

function motionFixture(version:'1'|'2'){
 const fixture:any=structuredClone(captured);
 if(version==='2'){
  const replace=(value:any):any=>typeof value==='string'?value.replaceAll('landscape-480p-5s','landscape-480p-source'):Array.isArray(value)?value.map(replace):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replace(item)])):value;
  return{fixture:replace(fixture),selected:{...structuredClone(sourceCatalog[0]),testMode:false}};
 }
 return{fixture,selected:{...structuredClone(catalog[0]),testMode:false}};
}

it('labels source-duration controls with the same nominal ratio and source policy as the button group',()=>{
 const {selected}=motionFixture('2'),model=capabilityModel(selected),field=model.config.find(field=>field.paramName==='outputPreset')!;
 expect(field.optionValue!.find(option=>option.value==='landscape-480p-source')).toMatchObject({labelCn:'480P · 16:9 · 跟随动作视频',labelEn:'480P · 16:9 · 跟随动作视频'});
 for(const option of field.optionValue!)expect(option.labelCn).not.toMatch(/0秒|9:5/);
 const old=capabilityModel({...structuredClone(catalog[0]),testMode:false}),oldField=old.config.find(field=>field.paramName==='outputPreset')!;
 expect(oldField.optionValue![0].labelCn).toBe(catalog[0].parameterSchema.properties.outputPreset['x-enum-labels']['landscape-480p-5s']);
});

const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(fixture:any,selected:any,assetFacts:Record<string,any>={}){
 const graph=fixture.before,notice=vi.fn(),manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const transport=vi.fn((path:string,init:any)=>{
  if(path.includes('model-capabilities'))return Promise.resolve(json({items:[selected],nextCursor:null}));
  if(path.startsWith('/api/v1/assets/')){const id=path.split('/').at(-1)!;return Promise.resolve(json({id,kind:id==='video'?'VIDEO':'IMAGE',state:'READY',...assetFacts[id]}));}
  if(path==='/api/v1/projects/p/snapshot')return Promise.resolve(json({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-11-01T12:20:00Z'}));
  if(path==='/api/v2/canvas-runs')return Promise.resolve(json({id:'t',projectId:'p',canvasManaged:true,state:'FAILED',revision:1,testMode:false,plans:[{nodeId:'n',executionId:'ex',state:'FAILED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]}));
  if(path==='/api/v2/generation-diagnostics')return Promise.resolve(json({logId:'fixture-log'}));
  throw new Error('unexpected route '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');const storage=new ServiceStorage(api,notice),saved=vi.fn(async()=>{}),adapter=new ExecutionAdapter(api,storage,saved,notice);
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-01T12:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 return{adapter,transport,saved};
}

it.each((['1','2'] as const).flatMap(version=>['valid','prompt','text','snapshot','preset','history','reference','source','model','policy','existing-prompt','existing-preset','existing-history'].map(change=>({version,change}))))('checks the real empty H3 motion v$version native projection: $change',async({version,change})=>{
 const {fixture,selected}=motionFixture(version),target=fixture.command.canvas.nodes.find((n:any)=>n.id==='n').data,before=fixture.before.nodes.find((n:any)=>n.id==='n').data;
 if(change==='prompt')target.params.prompt='new authored input';
 if(change==='text')target.params.text='new authored input';
 if(change==='snapshot')target.userPromptSnapshot.value='new authored input';
 if(change==='preset')target.presetSelections=[{id:'new-preset'}];
 if(change==='history')target.nodeOutputHistory=[{id:'new-history'}];
 if(change==='reference')target.params.imageUrls=['rhtv-asset:foreign'];
 if(change==='source')fixture.command.canvas.nodes.find((n:any)=>n.id==='source-image').data.sourceObjects=['rhtv-asset:foreign'];
 if(change==='model')target.modelCode='another-model';
 if(change==='policy')selected.parameterSchema['x-prompt-policy']='required';
 if(change==='existing-prompt')before.params.prompt='prior authored input';
 if(change==='existing-preset')before.presetSelections=[{id:'prior-preset'}];
 if(change==='existing-history')before.nodeOutputHistory=[{id:'prior-history'}];
 const c=setup(fixture,selected);
 try{
  if(change!=='valid'){await expect(c.adapter.run(fixture.command)).rejects.toMatchObject({code:change==='model'?'MODEL_UNAVAILABLE':change==='policy'?'MODEL_INPUT_UNSUPPORTED':'STALE_EXECUTION_INPUT'});expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);return;}
  await c.adapter.run(fixture.command);const requests=c.transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs');expect(requests).toHaveLength(1);
  const sent=JSON.parse(requests[0][1].body),data=sent.graph.nodes.find((n:any)=>n.id==='n').data;
  const outputPreset=version==='2'?'landscape-480p-source':'landscape-480p-5s';
  expect(sent.expectedRevision).toBe(2);expect(sent.graph.edges).toEqual(fixture.before.edges);expect(data.routerParameters).toEqual({outputPreset});
  expect(data.params).toEqual({outputPreset,imageUrls:['rhtv-asset:image'],videoUrls:['rhtv-asset:video'],prompt:'',text:''});
  expect(data.promptSelection.referenceBindings).toEqual([{assetId:'image',role:'REFERENCE_IMAGE'},{assetId:'video',role:'SOURCE_VIDEO'}]);
 }finally{c.adapter.clear();}
});

const sourceLimits={schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576},VIDEO:{maxBytes:64*1048576,minDurationMs:2000,maxDurationMs:30000}}};
it.each([
 {name:'reported oversized inputs',seconds:55.519,bytes:12474445,accepted:false,messages:['55.519 秒','30 秒','11.897 MiB','10 MiB']},
 {name:'exact limits',seconds:30,bytes:10*1048576,accepted:true,messages:[]},
 {name:'one millisecond over',seconds:30.001,bytes:10*1048576,accepted:false,messages:['30.001 秒','裁剪']},
 {name:'one byte over',seconds:30,bytes:10*1048576+1,accepted:false,messages:['10 MiB','更小的参考图片']},
])('checks resolved STUDIO metadata before saving or queueing: $name',async({seconds,bytes,accepted,messages})=>{
 const {fixture,selected}=motionFixture('2');selected.parameterSchema['x-input-media-constraints']=sourceLimits;
 const c=setup(fixture,selected,{video:{durationSeconds:seconds,byteSize:2924634},image:{byteSize:bytes}});
 try{
  if(accepted)await c.adapter.run(fixture.command);
  else{
   let error:any;try{await c.adapter.run(fixture.command);}catch(value){error=value;}
   expect(error).toMatchObject({status:422,code:'MEDIA_INPUT_INVALID'});for(const text of messages)expect(error.message).toContain(text);
   expect(c.transport.mock.calls.some(([path])=>path==='/api/v1/projects/p/snapshot')).toBe(false);
  }
  expect(c.transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs')).toHaveLength(accepted?1:0);
 }finally{c.adapter.clear();}
});

it.each((['1','2'] as const).flatMap(version=>['prompt','preset','source','edge','model'].map(change=>({version,change}))))('rejects later real edits while the promptless v$version command waits to save: $change',async({version,change})=>{
 const {fixture,selected}=motionFixture(version),c=setup(fixture,selected);let finish!:()=>void;
 c.saved.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 try{
  const pending=c.adapter.run(fixture.command),rejected=expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const data=fixture.before.nodes.find((n:any)=>n.id==='n').data;
  if(change==='prompt')data.params.prompt='later real input';
  if(change==='preset')data.presetSelections=[{id:'later-preset'}];
  if(change==='source')fixture.before.nodes.find((n:any)=>n.id==='source-image').data.sourceObjects=['rhtv-asset:foreign'];
  if(change==='edge')fixture.before.edges[0].target='another-target';
  if(change==='model')data.modelCode='later-model';
  finish();await rejected;expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);
 }finally{finish?.();c.adapter.clear();}
});


it.each((['1','2'] as const).flatMap(version=>['valid','prompt','text','reference'].map(change=>({version,change}))))('checks the captured native v$version late materialization while saving: $change',async({version,change})=>{
 const {fixture,selected}=motionFixture(version),c=setup(fixture,selected);let finish!:()=>void;
 c.saved.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 try{
  const pending=c.adapter.run(fixture.command),settled=change==='valid'?pending:expect(pending).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const data=fixture.before.nodes.find((n:any)=>n.id==='n').data;
  Object.assign(data,structuredClone(fixture.lateNativeData));
  if(change==='prompt')data.params.prompt='later authored input';
  if(change==='text')data.params.text='later authored input';
  if(change==='reference')data.params.imageUrls=['rhtv-asset:foreign'];
  finish();await settled;
  expect(c.transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs')).toHaveLength(change==='valid'?1:0);
 }finally{finish?.();c.adapter.clear();}
});

it.each(['policy','minimum','maximum','version','parameter-version'])('rejects unreviewed promptless source-duration metadata: %s',async change=>{
 const {fixture,selected}=motionFixture('2'),metadata:any=selected.parameterSchema['x-video-parameter-metadata'];
 if(change==='policy')metadata.durationPolicy='FIXED';
 if(change==='minimum')metadata.sourceSecondsMin=1;
 if(change==='maximum')metadata.sourceSecondsMax=60;
 if(change==='version')selected.version='3';
 if(change==='parameter-version')selected.parameterSchemaVersion='3';
 const c=setup(fixture,selected);
 try{await expect(c.adapter.run(fixture.command)).rejects.toBeDefined();expect(c.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);}finally{c.adapter.clear();}
});
