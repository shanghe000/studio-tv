import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter,capabilityModel} from '../../apps/web/src/service/execution';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import type {Capability} from '../../apps/web/src/service/model-catalog';

const profile=(version='2',kind='TEXT_TO_IMAGE',ref=kind==='IMAGE_TO_IMAGE'?'codex-image-edit-v1':'codex-image-generate-v1'):Capability=>({capabilityRef:ref,version,parameterSchemaVersion:version,available:true,testMode:false,kind,executionKind:'AGENT',parameterSchema:{type:'object',properties:{count:{type:'integer',enum:version==='1'?[1]:[1,2,4],default:1}},additionalProperties:false},inputKinds:['TEXT','STRUCTURED',...(kind==='IMAGE_TO_IMAGE'?['IMAGE']:[])],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'}});
const graph=(version?:string,count=1):NativeGraph=>({nodes:[{id:'target',type:'rh-image',position:{x:10,y:20},data:{modelCode:profile().capabilityRef,subType:'text-image',generateNum:count,params:{prompt:'Original USER description'},...(version?{capabilityRef:profile().capabilityRef,capabilityVersion:version,parameterSchemaVersion:version}:{})}}],edges:[]});
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{ETag:'"'+(data?.revision||1)+'"'}});
function fixture(initial=graph(),receipt?:any){
 let snapshot=encodeGraph(initial),revision=1;
 const caps=[profile(),profile('2','IMAGE_TO_IMAGE'),profile('2','TEXT_TO_IMAGE','other-public-image')],transport=vi.fn(async(path:string,options:any)=>{
  if(path.includes('/model-capabilities?'))return json({items:caps,nextCursor:null});
  if(path.startsWith('/api/v2/model-capability-version?')){const query=new URL(path,'https://fixture.invalid').searchParams;return json(profile(query.get('version')!,query.get('ref')==='codex-image-edit-v1'?'IMAGE_TO_IMAGE':'TEXT_TO_IMAGE',query.get('ref')!));}
  if(path==='/api/v1/projects/p')return json({id:'p',name:'Fixture',ownerId:'owner',revision});
  if(path==='/api/v1/projects/p/snapshot'){if(options.method==='PUT'){snapshot=JSON.parse(options.body).graph;revision++;}return json({projectId:'p',revision,graph:snapshot,updatedAt:'2026-10-07T00:00:00Z'});}
  if(path==='/api/v1/assets/owned')return json({byteSize:2048,mimeType:'image/png',id:'owned',kind:'IMAGE',state:'READY',downloadUrl:'https://fixture.invalid/owned.png',previewUrl:'https://fixture.invalid/owned.png'});
  if(path==='/api/v2/canvas-runs')return json(receipt??{id:'task',state:'SUCCEEDED',plans:[],testMode:false},202);
  throw new Error('Unexpected fixture request: '+path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,vi.fn().mockResolvedValue(undefined),vi.fn());
 return{adapter,storage,transport,snapshot:()=>snapshot,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes.find((node:any)=>node.id==='target').data};
}

it.each(['TEXT_TO_IMAGE','IMAGE_TO_IMAGE'])('uses one original 1x/2x/4x control for advertised %s @2, while @1 remains single-image',kind=>{
 const model=capabilityModel(profile('2',kind));expect(model.generateNum).toEqual([1,2,4]);expect(model.config.map(field=>field.paramName)).toEqual(kind==='TEXT_TO_IMAGE'?['prompt']:['prompt','imageUrls']);
 expect(capabilityModel(profile('1',kind)).generateNum).toEqual([1]);expect(model.config.some(field=>field.paramName==='count')).toBe(false);
});

it.each([1,2,4])('freezes a visible native %i-image choice into one version2 task without rewriting the user prompt',async count=>{
 const f=fixture(),command=graph(undefined,count),data=command.nodes[0].data;data.routerParameters={count:1};const before=structuredClone(command);
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command});
 expect(f.submitted()).toMatchObject({capabilityVersion:'2',parameterSchemaVersion:'2',generateNum:count,routerParameters:{count},params:{prompt:'Original USER description'}});expect(command).toEqual(before);expect(f.transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(1);
});

it.each([2,4])('keeps the original image edit reference and %i-image choice in a single version2 task',async count=>{
 const f=fixture(),command=graph(undefined,count);command.nodes[0].data={modelCode:profile('2','IMAGE_TO_IMAGE').capabilityRef,subType:'image-image',generateNum:count,params:{prompt:'Original edit',imageUrls:['rhtv-asset:owned']}};
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command});expect(f.submitted()).toMatchObject({capabilityRef:'codex-image-edit-v1',capabilityVersion:'2',parameterSchemaVersion:'2',routerParameters:{count},params:{prompt:'Original edit',imageUrls:['rhtv-asset:owned']}});expect(f.transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(1);
});

it.each([0,-1,3,8,1.5,'2',null])('rejects invalid native batch count %j before submitting a task',async count=>{
 const f=fixture(),command=graph();command.nodes[0].data.generateNum=count;command.nodes[0].data.routerParameters={count:1};
 await expect(f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command})).rejects.toMatchObject({code:'MODEL_PARAMETER_INVALID'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('defaults advertised count to numeric1 and retains a canonical batch choice when no native edit is present',()=>{
 expect(routerParameters(profile(),{})).toEqual({count:1});expect(routerParameters(profile(),{routerParameters:{count:4}})).toEqual({count:4});expect(routerParameters(profile(),{params:{count:2}})).toEqual({count:2});
});

it.each(['z-image-turbo-generate-v1','flux2-klein4b-generate-v1'])('uses only the explicitly advertised %s quantities without a duplicate count control',ref=>{
 const cap={...profile('1','TEXT_TO_IMAGE',ref),executionKind:'MODEL',parameterSchema:{properties:{count:{type:'integer',enum:[1,2,4],default:1}}}};
 expect(capabilityModel(cap).generateNum).toEqual([1,2,4]);expect(capabilityModel(cap).config.some(field=>field.paramName==='count')).toBe(false);
 expect(routerParameters(cap,{generateNum:4,routerParameters:{count:1}})).toEqual({count:4});expect(()=>routerParameters(cap,{generateNum:8})).toThrow('请选择模型支持的生成数量');
 cap.parameterSchema.properties.count.enum.push(8);expect(capabilityModel(cap).generateNum).toEqual([1,2,4,8]);expect(routerParameters(cap,{generateNum:8})).toEqual({count:8});
});

it('preserves eight images in the frozen native model switch only when the destination advertises eight',()=>{
 const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=source.indexOf('function ONn('),end=source.indexOf('function ',start+9);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const switchParams=runInNewContext(source.slice(start,end)+';ONn',{VD:(config:any)=>config}),previous={config:[],modelCode:'old',generateNum:[1,2,4,8]},target={config:[],modelCode:'z-image-turbo-generate-v1',generateNum:[1,2,4,8]};
 expect(switchParams(previous,target,{generateNum:8}).params).toMatchObject({generateNum:8,rhModel:target.modelCode});target.generateNum=[1,2,4];expect(switchParams(previous,target,{generateNum:8}).params.generateNum).toBe(1);
});

it('keeps saved image @1 menus and same-model edits single-image, with only a deliberate different choice binding @2',async()=>{
 const f=fixture(),command=graph('1'),node=command.nodes[0],other=profile('2','TEXT_TO_IMAGE','other-public-image'),patch=vi.fn(),props={targetNode:node,nodes:command.nodes,edges:[],models:{'text-image':[capabilityModel(profile()),capabilityModel(other)]},onNodeDataPatch:patch},view=nativeModelProps(props);
 expect(view.models['text-image'][0]).toMatchObject({capabilityVersion:'1',parameterSchemaVersion:'1',generateNum:[1]});expect(view.models['text-image'][1].generateNum).toEqual([1,2,4]);
 const edit={modelCode:profile().capabilityRef,params:{prompt:'Original changed'}};view.onNodeDataPatch('target',edit);expect(patch).toHaveBeenLastCalledWith('target',edit);expect(node.data.capabilityVersion).toBe('1');
 view.onNodeDataPatch('target',{modelCode:other.capabilityRef,generateNum:4});expect(patch).toHaveBeenLastCalledWith('target',expect.objectContaining({capabilityRef:other.capabilityRef,capabilityVersion:'2',parameterSchemaVersion:'2',generateNum:4}));
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command});expect(f.submitted()).toMatchObject({capabilityVersion:'1',parameterSchemaVersion:'1',routerParameters:{count:1}});expect(f.transport.mock.calls.filter(call=>call[0].includes('/model-capability-version?'))).toHaveLength(1);
 const rejected=fixture();await expect(rejected.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:graph('1',4)})).rejects.toMatchObject({code:'MODEL_PARAMETER_INVALID'});expect(rejected.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('preserves the authoritative saved image @1 quantity through frozen hydration and model binding recovery',async()=>{
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('const u1n='),end=frozen.indexOf('function WXr(',start),normalize=new Function(frozen.slice(start,end)+';return oL;')() as (graph:NativeGraph)=>NativeGraph;
 const f=fixture(graph('1'));await f.storage.loadProject('p');const mounted=normalize(f.storage.fixture('p'));expect(mounted.nodes[0].data).not.toHaveProperty('capabilityVersion');
 const view=nativeModelProps({targetNode:mounted.nodes[0],nodes:mounted.nodes,edges:[],models:{'text-image':[capabilityModel(profile())]},onNodeDataPatch:vi.fn()},f.storage.modelBindingPort('p',()=>true));
 expect(view.targetNode.data.capabilityVersion).toBe('1');expect(view.models['text-image'][0].generateNum).toEqual([1]);mounted.nodes[0].data.params.prompt='Edited original';await f.storage.save('p',mounted);
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:mounted});expect(f.submitted()).toMatchObject({capabilityVersion:'1',routerParameters:{count:1},params:{prompt:'Edited original'}});expect(f.snapshot().nodes[0].data.capabilityVersion).toBe('1');expect(mounted.nodes[0].data).not.toHaveProperty('capabilityVersion');
});

it('waits for server canvas sync on a four-image managed receipt without patching or splitting its outputs locally',async()=>{
 const command=graph(undefined,4),receipt={id:'task',projectId:'p',state:'SUCCEEDED',canvasManaged:true,plans:[{nodeId:'target',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[1,2,3,4].map(index=>({id:'output-'+index,type:'ASSET',assetId:'generated-'+index,mimeType:'image/png'}))}]},f=fixture(command,receipt),patchNodeData=vi.fn(),addNode=vi.fn(),terminal=vi.fn();f.adapter.attach('p',{getRemoteData:()=>command,patchNodeData,addNode});f.adapter.onTerminal(terminal);
 try{await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command});expect(f.submitted().routerParameters).toEqual({count:4});expect(patchNodeData).not.toHaveBeenCalled();expect(addNode).not.toHaveBeenCalled();expect(terminal).not.toHaveBeenCalled();expect(command.nodes).toHaveLength(1);expect(command.nodes[0].data).not.toHaveProperty('output');}finally{f.adapter.clear();}
});

it('previews a standalone generated asset with the frozen native media resolver and accepts it as the next edit reference',async()=>{
 const f=fixture(),asset=await f.storage.resolveAsset('rhtv-asset:owned'),url=asset.downloadUrl!,source={id:'generated',type:'rh-image',position:{x:100,y:200},data:{isUpload:true,status:'finished',sourceObjects:[url],imageUrl:url,assetIds:['owned'],output:[{assetId:'owned',url,outputType:'image/png'}],batchOrigin:{nodeId:'origin',executionId:'old-execution',outputId:'output-2',index:1}}},frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),slice=(start:string,end:string)=>{const offset=frozen.indexOf(start),finish=frozen.indexOf(end,offset+start.length);if(offset<0||finish<0)throw new Error('Frozen media seam changed');return frozen.slice(offset,finish);};
 const preview=runInNewContext([slice('function Pp(','const ydn='),slice('function ms(','function yG('),slice('function Wc(','function W5e('),slice('function ss(','function epn(')].join('\n')+';ss',{Xs:(value:any)=>structuredClone(value),_c:JSON.stringify,$d:()=>false,ed:()=>false,Hd:(type:string)=>type,no:()=>false,Ga:()=>false});
 expect(preview('rh-image',source.data)).toBe(url);
 const command=graph(undefined,2);command.nodes[0].data={modelCode:profile('2','IMAGE_TO_IMAGE').capabilityRef,subType:'image-image',generateNum:2,params:{prompt:'Continue editing this result'}};command.nodes.unshift(source);command.edges.push({id:'continued',source:source.id,target:'target'});
 await f.adapter.run({projectId:'p',targetType:'NODE',targetId:'target',graph:command});expect(f.submitted()).toMatchObject({capabilityRef:'codex-image-edit-v1',capabilityVersion:'2',routerParameters:{count:2},params:{prompt:'Continue editing this result'}});const submitted=JSON.parse(f.transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes.find((node:any)=>node.id==='generated');expect(submitted.data).toMatchObject({sourceObjects:['rhtv-asset:owned'],imageUrl:'rhtv-asset:owned',output:[{assetId:'owned',url:'rhtv-asset:owned'}]});
});

it('runs the frozen native image generator and request boundary once for 4x, without creating result nodes in its success callback',async()=>{
 const f=fixture(),command=graph(undefined,4),model=capabilityModel(profile()),index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),slice=(source:string,start:string,end:string)=>{const offset=source.indexOf(start),finish=source.indexOf(end,offset+start.length);if(offset<0||finish<0)throw new Error('Frozen native seam changed');return source.slice(offset,finish);},post=vi.fn(async(path:string,body:any)=>({data:{code:0,data:await f.adapter.handle(path,body)}})),addNode=vi.fn(),persist=vi.fn(),markLocalRunning=vi.fn();
 const request=runInNewContext(slice(index,'async function $m(','async function bMn(')+';$m',{Yy:()=>null,Xd:(body:any)=>body,uhe:undefined,dhe:undefined,yMn:()=>undefined,jCe:(canvas:any)=>canvas,Uxn:vi.fn(),Sb:(body:any)=>({body,config:{}}),Sn:{post},iv:(body:any)=>body.data,UNn:vi.fn(),VZ:vi.fn(),U8:vi.fn(),T2:vi.fn(),vMn:()=>false,Gy:vi.fn()});
 const run=runInNewContext(slice(shell,'async function tP(','function ')+';tP',{cT:()=>false,uT:(id:string,nodes:any[],ctx:any)=>nodes.map(node=>node.id===id?{...node,data:{...node.data,...ctx}}:node),vk:()=>false,fT:()=>false,pT:()=>false,hT:()=>false,er:()=>true,Os:()=>false,Gy:()=>[],mT:()=>null,gT:()=>false,yT:()=>model,K8:(value:any)=>value,fg:()=>false,Yy:()=>false,CT:()=>null,Bt:{PROMPT:'prompt'},_T:(value:any)=>value,wu:()=>false,NT:(_id:string,nodes:any[],edges:any[])=>structuredClone({nodes,edges}),pg:()=> 'text-image',AT:vi.fn(),Lh:(params:any)=>params,jT:()=>null,OT:()=>null,PT:()=>null,D8:async()=>null,ft:{getState:()=>({markLocalRunning,unmarkLocalRunning:vi.fn()})},Xy:{getState:()=>({save:persist})},LT:(_model:any,params:any)=>params,mg:request,AS:()=>false,J8:()=>false,ku:vi.fn(),RS:vi.fn(),Q8:()=>false,Ie:{error:vi.fn()},Ln:()=>({addNode})});
 expect(await run({canvasId:'p',canvasName:'Fixture',nodeId:'target',nodes:command.nodes,edges:[],models:{'text-image':[model]},onNodeDataPatch:vi.fn(),extractTaskId:(body:any)=>body.taskId,t:(key:string)=>key,prompt:'Original USER description',subType:'text-image',ctx:{modelCode:model.modelCode,params:{prompt:'Original USER description'},generateNum:4}})).toBe(true);
 expect(post).toHaveBeenCalledTimes(1);expect(post.mock.calls[0][0]).toBe('/canvas/task/run');expect(f.submitted()).toMatchObject({generateNum:4,routerParameters:{count:4},capabilityVersion:'2'});expect(f.transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(1);expect(markLocalRunning).toHaveBeenCalledTimes(1);expect(addNode).not.toHaveBeenCalled();
});
