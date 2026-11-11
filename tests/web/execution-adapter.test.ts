import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExecutionAdapter,appOutputKind,capabilityModel,nativeKinds} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {modelSelections} from '../../apps/web/src/service/model-catalog';
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{ETag:'"2"'}});
const cap={capabilityRef:'mock-text-to-image',kind:'TEXT_TO_IMAGE',version:'1',parameterSchemaVersion:'1',available:true,testMode:true,title:'Image',parameterSchema:{type:'object',properties:{scenario:{type:'string',enum:['success','failure'],default:'success'},count:{type:'integer',minimum:1,maximum:4,default:1}}}};
function setup(route:(path:string,init:any)=>Response|Promise<Response>){const transport=vi.fn().mockImplementation(route),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),save=vi.fn().mockResolvedValue(undefined),notice=vi.fn(),adapter=new ExecutionAdapter(api,storage,save,notice,{allowTestMode:true});return{api,storage,adapter,transport,save,notice};}
afterEach(()=>{vi.useRealTimers();modelSelections.clear();});
const realModel=(version:string,kind='LLM')=>({...cap,capabilityRef:'real-'+version+'-'+kind,executionKind:'AGENT',kind,testMode:false,inputKinds:kind==='LLM'?['TEXT','STRUCTURED']:['TEXT','STRUCTURED','IMAGE'],outputKinds:['TEXT'],model:{providerRef:'supplier',modelRef:'m-'+version,title:'Model '+version,version},parameterSchema:{type:'object',additionalProperties:false}});
it('projects real text and strict image-understanding menus without unconfigured models or legacy defaults',async()=>{
 const text=[realModel('5.6'),realModel('6'),realModel('6.1')],vision=[realModel('6','IMAGE_UNDERSTANDING'),realModel('6.1','IMAGE_UNDERSTANDING')],legacy={...realModel('6.1'),capabilityRef:'generic',model:undefined};
 const {adapter}=setup(()=>json({items:[legacy,...text,...vision,{...realModel('99'),available:false}],nextCursor:null}));
 const rows=await adapter.handle('/canvas/model/list',{types:['TEXT_SCRIPT','IMAGE_RECOGNITION','MULTIMODAL_TEXT']});expect(rows[0].modelList.map((row:any)=>row.model.version)).toEqual(['6.1','6','5.6']);expect(rows[1].modelList.map((row:any)=>row.model.version)).toEqual(['6.1','6']);expect(rows[1].modelList.every((row:any)=>row.kind==='IMAGE_UNDERSTANDING')).toBe(true);expect(rows[2].modelList).toHaveLength(5);expect(rows[0].modelList.every((row:any)=>row.testMode===false&&!row.modelName.includes('TEST MODE'))).toBe(true);
});
it('freezes the original immutable image-parse USER prompt before async native editor repair and routes only its exact alias to vision',async()=>{
 const source=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),prompt=source.match(/const yEr=`([\s\S]*?)`,sEt=/)![1];expect(prompt).toHaveLength(2628);expect(createHash('sha256').update(prompt).digest('hex')).toBe('87531563949237a209a49f179e2be378a459b326cf3e7c62b7409f13699860ab');
 const text=realModel('6.1'),vision=realModel('6.1','IMAGE_UNDERSTANDING'),{adapter,transport,save}=setup(path=>path==='/api/v1/assets/owned'?json({id:'owned',kind:'IMAGE',state:'READY'}):path.includes('model-capabilities')?json({items:[text,vision],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202));
 const data={modelCode:'llm-haimaflash-multimadal-text',modelType:'LLM',subType:'multimodal-text',textModelListType:'multimodal-text',hidePromptInput:true,params:{prompt,imageUrls:['rhtv-asset:owned']}},graph={nodes:[{id:'parse',type:'rh-text',data}],edges:[]};save.mockImplementation(async()=>{data.params.prompt='editor removed XML tags';data.modelCode=text.capabilityRef;});await adapter.run({projectId:'p',targetType:'NODE',targetId:'parse',graph});
 const frozen=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(frozen.capabilityRef).toBe(vision.capabilityRef);expect(frozen.capabilityVersion).toBe('1');expect(frozen.params.prompt).toBe(prompt);expect(frozen.params.imageUrls).toEqual(['rhtv-asset:owned']);expect(frozen.routerParameters).toEqual({});expect(frozen).not.toHaveProperty('promptSpec');expect(frozen.hidePromptInput).toBe(true);
 const native=capabilityModel(vision);expect(native.config.some(field=>field.paramName==='imageUrls'&&field.type==='imageUrls')).toBe(true);expect(capabilityModel(text).config.some(field=>field.paramName==='imageUrls')).toBe(false);
});
it('recovers only the exact native parser when nk has already replaced its alias and removed imageUrls before run',async()=>{
 const prompt=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8').match(/const yEr=`([\s\S]*?)`,sEt=/)![1],text=realModel('6.1'),vision=realModel('6.1','IMAGE_UNDERSTANDING'),{adapter,transport}=setup(path=>path==='/api/v1/assets/owned'?json({id:'owned',kind:'IMAGE',state:'READY'}):path.includes('model-capabilities')?json({items:[text,vision],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202));
 const source={id:'source',type:'rh-image',data:{sourceObjects:['rhtv-asset:owned']}},data={modelCode:text.capabilityRef,subType:'multimodal-text',textModelListType:'multimodal-text',hidePromptInput:true,params:{prompt}},graph={nodes:[source,{id:'parse',type:'rh-text',data}],edges:[{source:'source',target:'parse'}]};await adapter.run({projectId:'p',targetType:'NODE',targetId:'parse',graph});
 const frozen=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[1].data;expect(frozen.capabilityRef).toBe(vision.capabilityRef);expect(frozen.params).toEqual({prompt,imageUrls:['rhtv-asset:owned']});expect(frozen.routerParameters).toEqual({});expect(data.params).not.toHaveProperty('imageUrls');expect(data.modelCode).toBe(text.capabilityRef);
});
it('does not recover an explicit text capability, another text model, altered parser prompt or a non-parser node',async()=>{
 const prompt=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8').match(/const yEr=`([\s\S]*?)`,sEt=/)![1],text=realModel('6.1'),text56=realModel('5.6'),vision=realModel('6.1','IMAGE_UNDERSTANDING'),{adapter,transport}=setup(path=>path==='/api/v1/assets/owned'?json({id:'owned',kind:'IMAGE',state:'READY'}):json({items:[text56,text,vision],nextCursor:null})),base={modelCode:text.capabilityRef,subType:'multimodal-text',hidePromptInput:true,params:{prompt}},source={id:'source',type:'rh-image',data:{sourceObjects:['rhtv-asset:owned']}};
 for(const data of [{...base,capabilityRef:text.capabilityRef},{...base,params:{prompt,capabilityRef:text56.capabilityRef}},{...base,modelCode:text56.capabilityRef},{...base,params:{prompt:prompt+'edited'}},{...base,hidePromptInput:false}])await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[source,{id:'n',type:'rh-text',data}],edges:[{source:'source',target:'n'}]}})).rejects.toMatchObject({status:422});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});
it('does not reinterpret arbitrary aliases, missing images, wrong parser context or an explicit text capability as the native image parser',async()=>{
 const text=realModel('5.6'),vision=realModel('6.1','IMAGE_UNDERSTANDING'),{adapter,transport}=setup(path=>path==='/api/v1/assets/owned'?json({id:'owned',kind:'IMAGE',state:'READY'}):json({items:[text,vision],nextCursor:null})),base={modelCode:'llm-haimaflash-multimadal-text',subType:'multimodal-text',params:{prompt:'original',imageUrls:['rhtv-asset:owned']}};
 for(const data of [{...base,modelCode:'unconfigured-provider'},{...base,capabilityRef:text.capabilityRef},{...base,subType:'text-text'},{...base,params:{prompt:'original'}}])await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-text',data}],edges:[]}})).rejects.toMatchObject({status:422});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});
it('freezes the explicit real text model while preserving native scene, style and unrelated parameters',async()=>{
 const real=[realModel('5.6'),realModel('6.1')],{adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:real,nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202));
 const data={modelCode:real[0].capabilityRef,subType:'SCRIPT_STORYBOARD',sceneCode:'storyboard-prompt-film',styleName:'film::电影写实',params:{prompt:'original task',scene:'film',duration:7,style:'original',negativePrompt:'keep me'},promptSelection:{schemaVersion:'1',conditions:{arbitraryUserCondition:'unchanged'}}};
 await adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-script',data}],edges:[]}});const frozen=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;
 expect(frozen.capabilityRef).toBe(real[0].capabilityRef);expect(frozen.capabilityVersion).toBe('1');expect(frozen.params).toEqual(data.params);expect(frozen.sceneCode).toBe(data.sceneCode);expect(frozen.styleName).toBe(data.styleName);expect(frozen.promptSelection).toEqual(data.promptSelection);expect(frozen.routerParameters).toEqual({});expect(frozen.testMode).toBe(false);
});
it('rejects an unknown saved choice and a text profile on image input instead of changing the selected model',async()=>{
 const real=realModel('5.6'),vision=realModel('6.1','IMAGE_UNDERSTANDING'),{adapter,transport}=setup(path=>path==='/api/v1/assets/owned'?json({id:'owned',kind:'IMAGE',state:'READY'}):json({items:[real,vision],nextCursor:null}));
 for(const data of [{modelCode:'not-configured',params:{prompt:'x'}},{modelCode:real.capabilityRef,params:{prompt:'x',imageUrls:['rhtv-asset:owned']}}])await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-text',data}],edges:[]}})).rejects.toMatchObject({status:422});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});
it('uses the explicit optimization model and actual owned image kind without changing USER conditions',async()=>{
 const text=realModel('5.6'),vision=realModel('6','IMAGE_UNDERSTANDING'),{adapter,transport}=setup(path=>path==='/api/v1/assets/owned'?json({id:'owned',kind:'IMAGE',state:'READY'}):path.includes('model-capabilities')?json({items:[text,vision],nextCursor:null}):path==='/api/v2/canvas-runs'?json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202):json({id:'t',state:'SUCCEEDED',testMode:false,plans:[{outputs:[{type:'TEXT',text:'synthetic adapter fixture'}]}]}));
 adapter.setModelSelection('tools','IMAGE_UNDERSTANDING',{capabilityRef:vision.capabilityRef,capabilityVersion:'1',explicit:true});
 await adapter.handle('/canvas/invoke/api/llm',{canvasId:'p',params:{model:'old native label',messages:[{role:'system',content:'browser condition'},{role:'user',content:[{type:'text',text:'describe'},{type:'image_url',image_url:{url:'rhtv-asset:owned'}}]}]}});
 const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(data.capabilityRef).toBe(vision.capabilityRef);expect(data.promptSelection.messages[0]).toEqual({role:'USER',text:'browser condition'});expect(data.promptSelection.conditions.requestedModelCode).toBe('old native label');expect(data).not.toHaveProperty('promptSpec');
});
it('projects only advertised capabilities and explicit test mode in model names',()=>{
 const model=capabilityModel(cap);expect(model.modelName).toContain('[TEST MODE]');expect(model.capabilityVersion).toBe('1');expect(model.config.find(p=>p.paramName==='scenario')?.optionValue).toHaveLength(2);expect(model.config.find(p=>p.paramName==='count')?.type).toBe('int');expect(model).not.toHaveProperty('skuId');expect(new Set(Object.values(nativeKinds)).size).toBe(18);
});
it('maps actual native camera, lighting, redraw, storyboard and enhancement catalog type aliases',async()=>{
 const aliases={IMAGE_MULTIANGLE:'IMAGE_TO_IMAGE',IMAGE_LIGHT:'IMAGE_TO_IMAGE',IMAGE_REDRAW:'IMAGE_TO_IMAGE',IMAGE_ERASE:'IMAGE_TO_IMAGE',IMAGE_EXPAND:'IMAGE_TO_IMAGE',IMAGE_CUTOUT:'IMAGE_TO_IMAGE',MULTIMODAL_STORYBOARD:'LLM',VIDEO_EXPAND:'VIDEO_ENHANCE',VIDEO_ENHANCE:'VIDEO_ENHANCE',VIDEO_FRAME_INTERPOLATION:'VIDEO_ENHANCE'},caps=[...new Set(Object.values(aliases))].map(kind=>kind==='IMAGE_TO_IMAGE'?{...cap,kind,capabilityRef:'codex-image-edit-v1',version:'3',parameterSchemaVersion:'3',testMode:false,executionKind:'AGENT',inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'codex',modelRef:'codex-image',title:'Codex Image',version:'1'}}:{...cap,kind,capabilityRef:'mock-'+kind.toLowerCase()});
 const {adapter}=setup(()=>json({items:caps,nextCursor:null}));const models=await adapter.handle('/canvas/model/list',{types:Object.keys(aliases)});for(const row of models){expect(row.modelList).toHaveLength(1);const kind=aliases[row.type as keyof typeof aliases];expect(row.modelList[0].kind).toBe(kind);if(kind==='IMAGE_TO_IMAGE'){expect(row.modelList[0].capabilityRef).toBe('codex-image-edit-v1');expect(row.modelList[0].capabilityVersion).toBe('3');expect(row.modelList[0].modelName).not.toContain('[TEST MODE]');}else{expect(row.modelList[0].capabilityRef).toBe('mock-'+kind.toLowerCase());expect(row.modelList[0].modelName).toContain('[TEST MODE]');}}
});
it('submits full canonical graph with UUID idempotency and applies persisted outputs',async()=>{
 vi.useFakeTimers();const asset={id:'a',state:'READY',mimeType:'image/png',downloadUrl:'https://studio.invalid/storage/assets/a?token=session',previewUrl:'https://studio.invalid/storage/assets/a?token=session'};const graph:any={nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{sourceObjects:['rhtv-asset:a'],status:'finished'}},{id:'target',type:'rh-image',position:{x:1,y:1},data:{modelCode:cap.capabilityRef,params:{prompt:'A fox',imageUrls:['rhtv-asset:a'],scenario:'success'},generateNum:1}}],edges:[{id:'e',source:'source',target:'target'}]};
 const task={id:'run',state:'SUCCEEDED',projectId:'p',testMode:true,revision:3,plans:[{nodeId:'target',executionId:'ex',state:'SUCCEEDED',outputs:[{id:'out',type:'ASSET',assetId:'a',mimeType:'image/png'}]}]};
 const {adapter,transport,save}=setup((path)=>path.includes('/model-capabilities')?json({items:[cap],nextCursor:null}):path==='/api/v1/assets/a'?json(asset):json(task,202));const patch=vi.fn((id,data)=>Object.assign(graph.nodes.find((n:any)=>n.id===id).data,data));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});
 expect(await adapter.handle('/canvas/task/run',{canvasId:'p',targetType:'NODE',targetId:'target',canvas:graph})).toEqual({taskId:'run',testMode:true});expect(save).toHaveBeenCalled();const call=transport.mock.calls.find(([url])=>url==='/api/v2/canvas-runs')!;const submitted=JSON.parse(call[1].body);expect(submitted.graph.edges).toHaveLength(1);expect(submitted.graph.nodes[0].data).not.toHaveProperty('capabilityRef');expect(submitted.graph.nodes[1].data.params.imageUrls).toEqual(['rhtv-asset:a']);expect(call[1].headers.get('Idempotency-Key')).toMatch(/^[\da-f-]{36}$/);expect(patch).toHaveBeenCalledWith('target',expect.objectContaining({status:'finished',customBadgeText:'TEST MODE',historyStorage:expect.objectContaining({source:'remote',schemaVersion:1})}),{allowFields:['output','status']});adapter.clear();
});
it('persists verified image completion through the immutable native manager result/status filter',async()=>{
 let finish!:(response:Response)=>void;
 const node:any={id:'n',type:'rh-image',data:{status:'idle',params:{prompt:'actual image'},output:[{url:'previous image'}]}},graph={nodes:[node],edges:[]},asset={id:'owned',state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:'https://studio.invalid/owned'},queued={id:'native-task',projectId:'p',state:'QUEUED',revision:1,testMode:true,plans:[{nodeId:'n',executionId:'ex',state:'QUEUED',outputs:[]}]};
 const {adapter}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path==='/api/v2/canvas-runs'?json(queued,202):path==='/api/v1/assets/owned'?json(asset):new Promise<Response>(resolve=>finish=resolve));
 // Exact SSe semantics: running is always local-only; output/finished require explicit allowFields.
 const patch=vi.fn((id:string,data:any,options?:{allowFields?:string[]})=>{for(const [key,value]of Object.entries(data))if(!(key==='status'&&value==='running')&&(options?.allowFields?.includes(key)||!(key==='output'||key==='status'&&value==='finished')))node.data[key]=value;});
 const flush=vi.fn(),manager={getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:flush},terminalUpdate=vi.fn(()=>{expect(flush).toHaveBeenLastCalledWith(true);expect(node.data.status).toBe('finished');});adapter.onTerminal(terminalUpdate);adapter.attach('p',manager);
 try{
  await adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph});expect(node.data).toMatchObject({status:'processing',taskId:'native-task',output:[{url:'previous image'}]});expect(terminalUpdate).not.toHaveBeenCalled();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  finish(json({...queued,state:'SUCCEEDED',revision:3,plans:[{nodeId:'n',executionId:'ex',state:'SUCCEEDED',outputs:[{id:'result',type:'ASSET',assetId:'owned',mimeType:'image/png'}]}]}));
  await vi.waitFor(()=>expect(node.data).toMatchObject({status:'finished',taskId:'native-task',output:[{outputId:'result',assetId:'owned',url:'https://studio.invalid/owned'}],historyStorage:{source:'remote',revision:'3'}}));
  expect(patch).toHaveBeenCalledWith('n',expect.objectContaining({status:'finished',output:[expect.objectContaining({assetId:'owned'})]}),{allowFields:['output','status']});
  expect(terminalUpdate).toHaveBeenCalledExactlyOnceWith({nodeId:'n',taskId:'native-task',projectId:'p',manager,status:'SUCCESS'});
 }finally{adapter.clear();}
});
it('rejects external or unready model inputs without submitting a task',async()=>{
 const {adapter,transport}=setup(()=>json({items:[cap],nextCursor:null}));await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-image',data:{params:{imageUrls:['https://vendor.invalid/temporary.png']}}}],edges:[]}})).rejects.toMatchObject({code:'ASSET_REFERENCE_REQUIRED'});expect(transport.mock.calls.some(([url])=>url==='/api/v2/canvas-runs')).toBe(false);
});
it('rejects external first/last frame and directional model input URLs before task submission',async()=>{
 for(const key of ['firstFrameUrl','lastFrameUrl','leftImageUrl','fileUrl']){const {adapter,transport}=setup(()=>json({items:[cap],nextCursor:null}));await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-image',data:{params:{prompt:'https://reference.invalid describes a mood',[key]:'https://vendor.invalid/frame.png'}}}],edges:[]}})).rejects.toMatchObject({code:'ASSET_REFERENCE_REQUIRED'});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);}
});
it('reads history from persisted STUDIO batches and preserves structured/text markers',async()=>{
 const {adapter,transport}=setup(()=>json({records:[{id:'ex',taskId:'t',nodeId:'n',createdAt:'2026-10-05T00:00:00Z',testMode:true,outputs:[{id:'o',type:'TEXT',text:'result'},{id:'s',type:'STRUCTURED',schemaVersion:'storyboard.v1',data:{shots:[{shot:1}]}}]}],page:1,size:10,total:1,revision:3,hasNext:false}));const history=await adapter.handle('/canvas/node-history/page',{canvasId:'p',nodeId:'n',pageNum:1,pageSize:10});expect(transport.mock.calls[0][0]).toBe('/api/v2/history?projectId=p&nodeId=n&page=1&size=10');expect(history.batches[0].outputs[0].text).toBe('[TEST MODE] result');expect(history.batches[0].outputs[1].data.shots[0].shot).toBe(1);expect(history.revision).toBe('3');expect(history.resultCount).toBe(2);
});

it('projects only persisted image outputs into native sketch history and counts them after filtering',async()=>{
 const {adapter,transport}=setup(path=>path==='/api/v1/assets/a'?json({id:'a',state:'READY',mimeType:'image/png',fileName:'actual.png',downloadUrl:'https://studio.invalid/a'}):json({records:[{id:'ex',taskId:'t',projectId:'p',createdAt:'2026-10-05T00:00:00Z',outputs:[{id:'o-text',type:'TEXT',text:'not an image'},{id:'o-video',type:'ASSET',assetId:'v',mimeType:'video/mp4'},{id:'o-image',type:'ASSET',assetId:'a',mimeType:'image/png'}]}],page:1,size:100,total:1,revision:3,hasNext:false}));
 const page=await adapter.handle('/canvas/sketchboard/his/list',{canvasId:'p',page:1,size:10});expect(page.total).toBe(1);expect(page.records).toHaveLength(1);expect(page.records[0]).toMatchObject({id:'o-image',resultUrl:'https://studio.invalid/a',resultType:'IMAGE',fileName:'actual.png'});expect(transport.mock.calls.some(call=>call[0]==='/api/v1/assets/v')).toBe(false);
});
it('does not apply or emit terminal completion for a late generation response after logout',async()=>{
 let done!:(r:Response)=>void;const {adapter}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):new Promise(resolve=>done=resolve));const graph={nodes:[{id:'n',type:'rh-image',data:{modelCode:cap.capabilityRef,params:{prompt:'fox'}}}],edges:[]},patch=vi.fn(),terminalUpdate=vi.fn();adapter.onTerminal(terminalUpdate);adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch});const pending=adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph});const rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});await vi.waitFor(()=>expect(done).toBeTypeOf('function'));adapter.clear();done(json({id:'r',state:'SUCCEEDED',plans:[{nodeId:'n',state:'SUCCEEDED',outputs:[{type:'TEXT',text:'late result'}]}]}));await rejected;expect(patch).not.toHaveBeenCalled();expect(terminalUpdate).not.toHaveBeenCalled();
});

it('uses an advertised mock for unselected models and never defaults isolated tools to paid capabilities',async()=>{
 const paid={...cap,capabilityRef:'paid-image',testMode:false},mockLLM={...cap,kind:'LLM',capabilityRef:'mock-llm'};
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[paid,cap,mockLLM],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202));
 await adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-image',data:{params:{prompt:'fox'}}}],edges:[]}});
 const submitted=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body);expect(submitted.graph.nodes[0].data.capabilityRef).toBe('mock-text-to-image');
 await adapter.isolated('LLM','test',[],'p');const calls=transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs');expect(JSON.parse(calls[1][1].body).graph.nodes[0].data.capabilityRef).toBe('mock-llm');
});

it('assigns advertised capabilities to nested group descendants and omits unrelated nodes',async()=>{
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202));
 await adapter.run({projectId:'p',targetType:'GROUP',targetId:'g',graph:{nodes:[{id:'g',type:'rh-group',data:{}},{id:'child',type:'rh-group',parentId:'g',data:{}},{id:'inside',type:'rh-image',parentNode:'child',data:{modelCode:cap.capabilityRef,params:{prompt:'fox'}}},{id:'outside',type:'rh-image',data:{modelCode:'legacy-source'}}],edges:[]}});
 const graph=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph;expect(graph.nodes.find((node:any)=>node.id==='inside').data.capabilityRef).toBe(cap.capabilityRef);expect(graph.nodes.find((node:any)=>node.id==='outside')).toBeUndefined();
});

it('returns authoritative file sizes and marked persisted prompt enhancement',async()=>{
 const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter,transport}=setup(path=>path==='/api/v1/assets/a'?json({id:'a',state:'READY',byteSize:123}):path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):path==='/api/v2/canvas-runs'?json({id:'t',state:'QUEUED',plans:[],testMode:true},202):json({id:'t',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'n',outputs:[{id:'o',type:'TEXT',text:'enhanced fox'}]}]}));
 expect(await adapter.handle('/canvas/cos/fileSizes',{urls:['rhtv-asset:a']})).toEqual({files:[{url:'rhtv-asset:a',size:123,assetId:'a'}],totalSize:123});
 const result=await adapter.handle('/canvas/prompt/enhance',{canvasId:'p',prompt:'fox',nodeCategory:'IMAGE'});expect(result).toEqual({enhancedPrompt:'[TEST MODE] enhanced fox',testMode:true,taskId:'t'});expect(transport.mock.calls.some(call=>String(call[0]).startsWith('https://'))).toBe(false);
 const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(data.params.prompt).toBe('fox');expect(data.promptSelection).toEqual({schemaVersion:'1',featureCode:'prompt.enhance',conditions:{nodeCategory:'IMAGE'}});
});

it('preserves conversation roles, media ownership and feature intent without elevating native instructions',async()=>{
 const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter,transport}=setup(path=>path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'IMAGE'}):path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):path==='/api/v2/canvas-runs'?json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202):json({id:'t',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'n',outputs:[{type:'TEXT',text:'answer'}]}]}));
 await adapter.handle('/canvas/invoke/api/llm',{canvasId:'p',params:{messages:[{role:'system',content:'browser instruction'},{role:'user',content:'first question'},{role:'assistant',content:'first answer'},{role:'user',content:[{type:'text',text:'describe image'},{type:'image_url',image_url:{url:'rhtv-asset:a'}}]}]}});
 const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;
 expect(data.promptSelection.messages).toEqual([{role:'USER',text:'browser instruction'},{role:'USER',text:'first question'},{role:'ASSISTANT',text:'first answer'},{role:'USER',text:'describe image',assetIds:['a']}]);expect(data.promptSelection.featureCode).toBe('llm.invoke');expect(data.params.imageUrls).toEqual(['rhtv-asset:a']);expect(data.params.prompt).toBe('describe image');expect(data).not.toHaveProperty('systemInstructions');
});

it('keeps sketch style, live mode and typed sketch conditioning through the product request',async()=>{
 const mock={...cap,kind:'IMAGE_TO_IMAGE',capabilityRef:'mock-image-to-image'};const {adapter,storage,transport}=setup(path=>path==='/api/v1/assets/sketch'?json({id:'sketch',state:'READY',kind:'IMAGE'}):path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202));vi.spyOn(storage,'upload').mockResolvedValue('rhtv-asset:sketch');
 await adapter.handle('/canvas/sketchboard/realtime/generate',{canvasId:'p',image:'data:image/png;base64,AA==',prompt:'fox',styleCode:'line-art',generationMode:'live'});
 const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(data.promptSelection).toEqual({schemaVersion:'1',featureCode:'sketchboard.generate',conditions:{styleCode:'line-art',stylePrompt:'Clean line art, deliberate contours, restrained flat colors.',generationMode:'live'},referenceBindings:[{assetId:'sketch',role:'SKETCH'}]});
});

it('preserves video and audio reference kinds instead of sending every reference as image',async()=>{
 const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter,transport}=setup(path=>path==='/api/v1/assets/v'?json({id:'v',state:'READY',kind:'VIDEO'}):path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'AUDIO'}):path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202));
 await adapter.isolated('LLM','analyze',['rhtv-asset:v','rhtv-asset:a'],'p');const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(data.params.videoUrls).toEqual(['rhtv-asset:v']);expect(data.params.audioUrls).toEqual(['rhtv-asset:a']);expect(data.params).not.toHaveProperty('imageUrls');
});

it('rejects an unsupported asset kind without silently converting it to an image',async()=>{
 const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter,transport}=setup(path=>path==='/api/v1/assets/f'?json({id:'f',state:'READY',kind:'FILE'}):json({items:[mock],nextCursor:null}));
 await expect(adapter.isolated('LLM','read',['rhtv-asset:f'],'p')).rejects.toMatchObject({code:'MESSAGE_PART_UNSUPPORTED'});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('keeps validated skill JSON wrapped for the native response and rejects invalid shape',async()=>{
 for(const output of [{type:'STRUCTURED',schemaVersion:'1',data:{optimized_content:'# revised skill'}},{type:'TEXT',text:'{"optimized_content":"# revised skill"}'}]){
  const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter}=setup(path=>path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):path==='/api/v2/canvas-runs'?json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202):json({id:'t',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'n',outputs:[output]}]}));
  expect(await adapter.handle('/canvas/agent/skill/file/content/optimize',{canvasId:'p',message:'# original'})).toEqual({output:'{"optimized_content":"# revised skill"}',testMode:true});
 }
 const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter}=setup(path=>path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):path==='/api/v2/canvas-runs'?json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202):json({id:'t',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'n',outputs:[{type:'STRUCTURED',schemaVersion:'1',data:{wrong:'value'}}]}]}));
 await expect(adapter.handle('/canvas/agent/skill/file/content/optimize',{canvasId:'p',message:'# original'})).rejects.toMatchObject({code:'INVALID_OUTPUT'});
});

it('keeps owned video/audio message parts and rejects unsupported parts before running',async()=>{
 const mock={...cap,kind:'LLM',capabilityRef:'mock-llm'};const {adapter,transport}=setup(path=>path==='/api/v1/assets/v'?json({id:'v',state:'READY',kind:'VIDEO'}):path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'AUDIO'}):path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):path==='/api/v2/canvas-runs'?json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202):json({id:'t',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'n',outputs:[{type:'TEXT',text:'answer'}]}]}));
 await adapter.handle('/canvas/invoke/api/llm',{canvasId:'p',params:{messages:[{role:'user',content:[{type:'text',text:'analyze'},{type:'video_url',video_url:{url:'rhtv-asset:v'}},{type:'audio_url',audio_url:{url:'rhtv-asset:a'}}]}]}});
 const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(data.params.videoUrls).toEqual(['rhtv-asset:v']);expect(data.params.audioUrls).toEqual(['rhtv-asset:a']);expect(data.promptSelection.messages[0].assetIds).toEqual(['v','a']);
 const count=transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs').length;
 await expect(adapter.handle('/canvas/invoke/api/llm',{canvasId:'p',params:{messages:[{role:'user',content:[{type:'text',text:'keep'},{type:'input_audio',input_audio:{data:'AAAA',format:'wav'}}]}]}})).rejects.toMatchObject({code:'MESSAGE_PART_UNSUPPORTED'});
 expect(transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(count);
});

it('maps supported native media commands to verified source metadata before submission',async()=>{
 const {adapter,transport,storage}=setup(path=>path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'VIDEO',durationSeconds:2,width:640,height:480,downloadUrl:'https://studio.invalid/a'}):json({id:'t',taskId:'t',jobId:'t',status:'SUCCESS',outputs:[{assetId:'a',url:'https://discard.invalid/vendor'}],testMode:false},202));
 const result=await adapter.handle('/canvas/media/task/run',{bizId:'p',nodeId:'n',operateType:'ROTATE',bizType:'CANVAS',executor:'FFMPEG',dryRun:false,waitMs:0,priority:'normal',spec:{version:1,inputs:[{id:'a',url:'rhtv-asset:a'}],tracks:[{type:'video',clips:[{input:'a',rotate:90}]}],output:{container:'mp4'}}});
 const submitted=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/media-jobs')![1].body);expect(submitted).toMatchObject({projectId:'p',operation:'ROTATE',nodeId:'n',spec:{inputs:[{id:'a',assetId:'a'}],tracks:[{clips:[{rotate:'90'}]}]}});expect(submitted).not.toHaveProperty('dryRun');expect(result.outputs[0].url).toBe('https://studio.invalid/a');expect(storage.encodeAsset(result.outputs[0].url)).toBe('rhtv-asset:a');
 const generic=await adapter.handle('/media/jobs/submit',{projectId:'p',spec:{inputs:[{id:'a',assetId:'a'}],tracks:[{type:'compress',clips:[{input:'a'}]}],output:{container:'mp4',maxBytes:1000,preset:'veryfast'}}});const compression=JSON.parse(transport.mock.calls.filter(call=>call[0]==='/api/v2/media-jobs')[1][1].body);expect(compression.operation).toBe('COMPRESS');expect(compression.spec.output.maxBytes).toBe(1000);expect(generic.status).toBe('DONE');
 await adapter.handle('/media/jobs/submit',{projectId:'p',spec:{version:1,inputs:[{id:'a',assetId:'a'}],tracks:[{type:'video',clips:[{input:'a',trim:{startMs:0,endMs:1000}},{input:'a',trim:{startMs:1000,endMs:2000}}]}],output:{container:'mp4'}}});const composition=JSON.parse(transport.mock.calls.filter(call=>call[0]==='/api/v2/media-jobs')[2][1].body);expect(composition.operation).toBe('COMPOSE');expect(composition.spec.tracks[0].clips).toHaveLength(2);
 await expect(adapter.handle('/media/jobs/submit',{dryRun:true})).rejects.toMatchObject({status:501});
});

it('does not write a delayed owned output into a newly attached project with copied node IDs',async()=>{
 let assetDone!:(response:Response)=>void,creates=0,reads=0;const asset={id:'a',state:'READY',mimeType:'image/png',downloadUrl:'https://studio.invalid/a'};
 const {adapter}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path==='/api/v1/assets/a'?(++reads===1?new Promise<Response>(resolve=>assetDone=resolve):json(asset)):json({id:'t'+(++creates),projectId:creates===1?'p':'q',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'n',state:'SUCCEEDED',outputs:[{id:'o',type:'ASSET',assetId:'a'}]}]},202));
 const graph={nodes:[{id:'n',type:'rh-image',data:{params:{prompt:'fox'}}}],edges:[]},oldPatch=vi.fn(),newPatch=vi.fn();adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:oldPatch});
 const pending=adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph});await vi.waitFor(()=>expect(assetDone).toBeTypeOf('function'));adapter.attach('q',{getRemoteData:()=>graph,patchNodeData:newPatch});assetDone(json(asset));await pending;expect(oldPatch).toHaveBeenCalledExactlyOnceWith('n',{taskId:'t1'});expect(newPatch).not.toHaveBeenCalled();
 await adapter.run({projectId:'q',targetType:'NODE',targetId:'n',graph});expect(newPatch).toHaveBeenCalledWith('n',expect.objectContaining({status:'finished',taskId:'t2'}),{allowFields:['output','status']});adapter.clear();
});

it('does not mark a replacement manager failed when the previous authenticated generation completes late',async()=>{
 let done!:(response:Response)=>void;const {adapter,notice}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):new Promise<Response>(resolve=>done=resolve));
 const graph={nodes:[{id:'n',type:'rh-image',data:{params:{prompt:'fox'}}}],edges:[]},oldPatch=vi.fn(),newPatch=vi.fn();adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:oldPatch});const pending=adapter.generate('n');await vi.waitFor(()=>expect(done).toBeTypeOf('function'));
 adapter.clear();adapter.attach('q',{getRemoteData:()=>graph,patchNodeData:newPatch});done(json({id:'t',projectId:'p',state:'SUCCEEDED',plans:[]}));expect(await pending).toBe(false);expect(oldPatch).not.toHaveBeenCalled();expect(newPatch).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();adapter.clear();
});

it('bridges collection history revision to the current task version without deleting sibling outputs',async()=>{
 let deleted=false;const row={id:'ex',executionId:'ex',taskId:'t',nodeId:'n',revision:4,createdAt:'2026-10-05T00:00:00Z',outputs:[{id:'o1',type:'TEXT',text:'one'},{id:'o2',type:'TEXT',text:'two'}]};
 const {adapter,transport}=setup((path,init)=>path.includes('/outputs/')?(deleted=true,json({id:'t',revision:5,plans:[]})):path==='/api/v2/history/ex'?json(row):json({records:[{...row,outputs:deleted?row.outputs.slice(1):row.outputs}],page:1,size:1,total:1,hasNext:false,revision:deleted?10:9}));
 const result=await adapter.handle('/canvas/node-history/delete-output',{canvasId:'p',nodeId:'n',historyId:'ex',outputId:'o1',expectedRevision:'9'});const mutation=transport.mock.calls.find(call=>call[0]==='/api/v2/history/ex/outputs/o1')!;expect(mutation[1].headers.get('If-Match')).toBe('"4"');expect(result).toMatchObject({revision:'10',resultCount:1,fallback:{outputId:'o2'}});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/history/delete')).toBe(false);
 await expect(adapter.handle('/canvas/node-history/delete-output',{canvasId:'p',nodeId:'n',historyId:'ex',outputId:'o2',expectedRevision:'9'})).rejects.toMatchObject({status:412});
});

it('restores the persisted task graph and deletes only selected global output IDs',async()=>{
 const graph={nodes:[{id:'n',type:'rh-text',data:{params:{prompt:'real'}}}],edges:[]},row={id:'ex',executionId:'ex',taskId:'t',nodeId:'n',revision:4,createdAt:'2026-10-05T00:00:00Z',outputs:[{id:'o1',type:'TEXT',text:'one'},{id:'o2',type:'TEXT',text:'two'}]};
 const {adapter,transport}=setup(path=>path==='/api/v2/tasks/t'?json({id:'t',snapshot:graph}):path==='/api/v2/history/ex'?json(row):path.includes('/outputs/')?json({id:'t',revision:5,plans:[]}):json({records:[row],page:1,size:100,total:1,hasNext:false,revision:9}));
 const page=await adapter.handle('/canvas/his/list',{page:1,size:20});expect(page.records[0]).toMatchObject({id:'o1',taskPlanId:'ex'});expect(await adapter.handle('/canvas/his/generate/param/detail',{taskPlanId:'ex'})).toMatchObject({nodeId:'n',snapshot:graph});
 expect(await adapter.handle('/canvas/his/deleteBatch',{ids:['o1']})).toEqual({successList:['o1'],failList:[]});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/history/ex/outputs/o1')).toBe(true);expect(transport.mock.calls.some(call=>call[0]==='/api/v2/history/ex/outputs/o2')).toBe(false);expect(transport.mock.calls.some(call=>call[0]==='/api/v2/history/delete')).toBe(false);
});

it('coalesces double submission of one target into one actual create request',async()=>{
 let finish!:(response:Response)=>void;const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):new Promise<Response>(resolve=>finish=resolve));const command={projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-image',data:{params:{prompt:'fox'}}}],edges:[]}};
 const first=adapter.run(command),second=adapter.run(command);expect(first).toBe(second);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));finish(json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202));expect(await first).toEqual({taskId:'t',testMode:true});await second;expect(transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(1);
});

it('restores a saved running node by reading its persisted task rather than creating another run',async()=>{
 const graph={nodes:[{id:'n',type:'rh-text',data:{taskId:'t',status:'running'}}],edges:[]},patch=vi.fn((id,data)=>Object.assign(graph.nodes[0].data,data));const {adapter,transport}=setup(()=>json({id:'t',projectId:'p',state:'SUCCEEDED',revision:5,testMode:true,plans:[{nodeId:'n',executionId:'ex',state:'SUCCEEDED',outputs:[{id:'o',type:'TEXT',text:'saved reply'}]}]}));
 adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch});await vi.waitFor(()=>expect(patch).toHaveBeenCalledWith('n',expect.objectContaining({status:'finished',text:'[TEST MODE] saved reply'}),{allowFields:['output','status']}));expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v2/tasks/t']);adapter.clear();
});

it('claims overlapping GROUP/NODE tasks even with identical queued states and cancels the current task while fencing late results',async()=>{
 let oldPoll!:(response:Response)=>void,currentPoll!:(response:Response)=>void;
 const graph:any={nodes:[{id:'g',type:'group',data:{nodeIds:['n','sibling']}},{id:'n',type:'rh-text',data:{params:{prompt:'current'},output:[{text:'previous'}]}},{id:'sibling',type:'rh-text',data:{params:{prompt:'sibling'}}}],edges:[]};
 const task=(id:string,state:string,revision:number,plans:any[])=>({id,projectId:'p',state,revision,testMode:true,plans}),plan=(nodeId:string,state:string,text?:string)=>({nodeId,executionId:'ex-'+nodeId,state,outputs:text===undefined?[]:[{id:'out-'+nodeId,type:'TEXT',text}]}),llm={...cap,kind:'LLM',capabilityRef:'mock-llm'};
 const {adapter,transport}=setup((path,init)=>{
  if(path.includes('model-capabilities'))return json({items:[llm],nextCursor:null});
  if(path==='/api/v2/canvas-runs'){const command=JSON.parse(init.body);return command.targetType==='GROUP'?json(task('group-task','QUEUED',1,[plan('n','QUEUED'),plan('sibling','QUEUED')]),202):json(task('node-task','QUEUED',1,[plan('n','QUEUED')]),202);}
  if(path==='/api/v2/tasks/group-task')return new Promise<Response>(resolve=>oldPoll=resolve);
  if(path==='/api/v2/tasks/node-task')return new Promise<Response>(resolve=>currentPoll=resolve);
  if(path==='/api/v2/tasks/node-task/cancel')return json(task('node-task','CANCELED',3,[plan('n','CANCELED')]),202);
  throw new Error('unexpected path '+path);
 });
 const patch=vi.fn((id,data)=>Object.assign(graph.nodes.find((node:any)=>node.id===id).data,data)),terminalUpdate=vi.fn();adapter.onTerminal(terminalUpdate);adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});
 try{
  await adapter.run({projectId:'p',targetType:'GROUP',targetId:'g',graph});await vi.waitFor(()=>expect(oldPoll).toBeTypeOf('function'));
  await adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph});await vi.waitFor(()=>expect(currentPoll).toBeTypeOf('function'));
  expect(graph.nodes[1].data).toMatchObject({taskId:'node-task',status:'processing',output:[{text:'previous'}]});
  await adapter.cancelNode('n');expect(transport.mock.calls.some(([path])=>path==='/api/v2/tasks/node-task/cancel')).toBe(true);expect(transport.mock.calls.some(([path])=>path==='/api/v2/tasks/group-task/cancel')).toBe(false);
  oldPoll(json(task('group-task','SUCCEEDED',4,[plan('n','SUCCEEDED','obsolete result'),plan('sibling','SUCCEEDED','owned sibling result')])));
  await vi.waitFor(()=>expect(graph.nodes[2].data.text).toBe('[TEST MODE] owned sibling result'));
  currentPoll(json(task('node-task','RUNNING',2,[plan('n','RUNNING')])));await new Promise(resolve=>setTimeout(resolve,0));
  expect(graph.nodes[1].data).toMatchObject({taskId:'node-task',status:'idle',output:[{text:'previous'}]});expect(graph.nodes[1].data).not.toHaveProperty('text');expect(patch.mock.calls.some(([id,data])=>id==='n'&&data.text==='[TEST MODE] obsolete result')).toBe(false);
  expect(terminalUpdate.mock.calls.map(([update])=>[update.nodeId,update.taskId,update.status])).toEqual([['n','node-task','CANCELLED'],['sibling','group-task','SUCCESS']]);
 }finally{adapter.clear();}
});

it('does not let a delayed older GROUP acceptance replace a newer NODE result while retaining independent group results',async()=>{
 let acceptOlder!:(response:Response)=>void;
 const graph:any={nodes:[{id:'g',type:'group',data:{nodeIds:['n','sibling']}},{id:'n',type:'rh-text',data:{params:{prompt:'current'}}},{id:'sibling',type:'rh-text',data:{params:{prompt:'sibling'}}}],edges:[]},llm={...cap,kind:'LLM',capabilityRef:'mock-llm'};
 const task=(id:string,nodes:string[],text:string)=>({id,projectId:'p',state:'SUCCEEDED',revision:2,testMode:true,plans:nodes.map(nodeId=>({nodeId,executionId:id+'-'+nodeId,state:'SUCCEEDED',outputs:[{id:id+'-out-'+nodeId,type:'TEXT',text}]}))});
 const {adapter,transport}=setup((path,init)=>path.includes('model-capabilities')?json({items:[llm],nextCursor:null}):JSON.parse(init.body).targetType==='GROUP'?new Promise<Response>(resolve=>acceptOlder=resolve):json(task('new-node',['n'],'new result'),202));
 const patch=vi.fn((id,data)=>Object.assign(graph.nodes.find((node:any)=>node.id===id).data,data));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()});
 try{
  const older=adapter.run({projectId:'p',targetType:'GROUP',targetId:'g',graph});await vi.waitFor(()=>expect(acceptOlder).toBeTypeOf('function'));
  await adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph});acceptOlder(json(task('old-group',['n','sibling'],'old group result'),202));await older;
  expect(graph.nodes[1].data).toMatchObject({taskId:'new-node',status:'finished',text:'[TEST MODE] new result'});expect(graph.nodes[2].data).toMatchObject({taskId:'old-group',status:'finished',text:'[TEST MODE] old group result'});expect(transport.mock.calls.filter(([path])=>path==='/api/v2/canvas-runs')).toHaveLength(2);
 }finally{adapter.clear();}
});

const appField=(nodeId:string,fieldName:string,fieldType='STRING',fieldValue:any='',fieldData='["STRING",{}]')=>({nodeId,fieldName,fieldType,fieldValue,fieldData});
const appNode=(id:string,fields:any[],appId='app')=>({id,type:'rh-ai',position:{x:0,y:0},data:{aiApp:{id:appId,workflowId:'unavailable-vendor-workflow',inputNodes:fields},aiNodeOutputType:'image'}});
const appDefinition=(fields:any[],outputType='IMAGE',id='app',revision=7)=>({resource:{id,revision,scope:'SYSTEM'},content:{inputNodes:fields,outputType}});
it('submits the exact current APP form, restores native advanced types and applies a real task without reading a vendor workflow',async()=>{
 const fields=[appField('9','image','IMAGE',''),appField('55','prompt','STRING','default'),appField('8','steps','INT',12,'["INT",{"min":1,"max":20}]'),appField('8','enabled','BOOLEAN',false),appField('8','style','LIST','photo','[["photo","anime"],{}]')];
 const node=appNode('n',fields.map(field=>({...field,fieldValue:field.fieldName==='image'?'rhtv-asset:a':field.fieldName==='prompt'?'edited':String(field.fieldValue)}))),graph={nodes:[node],edges:[]};
 const task={id:'app-task',projectId:'p',state:'SUCCEEDED',testMode:true,revision:2,plans:[{nodeId:'n',executionId:'actual-plan',state:'SUCCEEDED',outputs:[{id:'actual-output',type:'ASSET',assetId:'a'}]}]};
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[{...cap,testMode:false,capabilityRef:'paid'},cap],nextCursor:null}):path==='/api/v2/apps/app'?json(appDefinition(fields)):path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:'https://studio.invalid/a'}):json(task,202));const patch=vi.fn((id,data)=>Object.assign(node.data,data));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch});
 expect(await adapter.generate('n')).toBe(true);const call=transport.mock.calls.find(([url])=>url==='/api/v2/app-runs')!;
 expect(JSON.parse(call[1].body)).toEqual({projectId:'p',nodeId:'n',appId:'app',appRevision:7,inputNodes:[{nodeId:'9',fieldName:'image',fieldValue:'rhtv-asset:a'},{nodeId:'55',fieldName:'prompt',fieldValue:'edited'},{nodeId:'8',fieldName:'steps',fieldValue:12},{nodeId:'8',fieldName:'enabled',fieldValue:false},{nodeId:'8',fieldName:'style',fieldValue:'photo'}],capabilityRef:cap.capabilityRef,capabilityVersion:'1',parameters:{scenario:'success',count:1}});
 expect(call[1].headers.get('Idempotency-Key')).toMatch(/^[\da-f-]{36}$/);expect(patch).toHaveBeenCalledWith('n',expect.objectContaining({taskId:'app-task',status:'finished',output:[expect.objectContaining({assetId:'a',url:'https://studio.invalid/a'})]}),{allowFields:['output','status']});expect(transport.mock.calls.some(([url])=>String(url).includes('workflow')||url==='/api/v2/canvas-runs')).toBe(false);adapter.clear();
});
it('uses authoritative defaults and resolves native singleGenerate bindings from the attached full graph',async()=>{
 const fields=[appField('1','prompt','STRING','server default'),appField('2','image','IMAGE','')],node=appNode('app-node',fields.map(field=>({...field,fieldValue:undefined,binding:{sourceNodeId:field.fieldName==='prompt'?'text':'image'}}))),graph={nodes:[{id:'text',type:'rh-text',data:{text:'bound text'}},{id:'image',type:'rh-image',data:{sourceObjects:['rhtv-asset:a']}},node],edges:[{source:'text',target:node.id},{source:'image',target:node.id}]};
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path==='/api/v2/apps/app'?json(appDefinition(fields)):path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'IMAGE'}):json({id:'t',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[]}));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:vi.fn()});
 await adapter.handle('/canvas/task/run',{canvasId:'p',targetType:'NODE',targetId:node.id,canvas:{nodes:[node],edges:[]}});const body=JSON.parse(transport.mock.calls.find(([url])=>url==='/api/v2/app-runs')![1].body);expect(body.inputNodes.map((field:any)=>field.fieldValue)).toEqual(['bound text','rhtv-asset:a']);adapter.clear();
 const noBinding=appNode('n',[{...fields[0],fieldValue:undefined}]);const second=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path.includes('/apps/')?json(appDefinition([fields[0]])):json({id:'t',state:'SUCCEEDED',plans:[],testMode:true}));await second.adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[noBinding],edges:[]}});expect(JSON.parse(second.transport.mock.calls.find(([url])=>url==='/api/v2/app-runs')![1].body).inputNodes[0].fieldValue).toBe('server default');
});
it.each(['changed-field','external-media','invalid-number','invalid-bool','invalid-choice'])('rejects invalid current application inputs before a task: %s',async problem=>{
 const type=problem==='external-media'?'IMAGE':problem==='invalid-number'?'INT':problem==='invalid-bool'?'BOOLEAN':problem==='invalid-choice'?'LIST':'STRING',field=appField('1','value',type,'','[["valid"],{"min":1,"max":4}]'),input={...field,fieldName:problem==='changed-field'?'wrong':'value',fieldValue:problem==='external-media'?'https://vendor.invalid/file':problem==='invalid-number'?'9':problem==='invalid-bool'?'yes':'wrong'};
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):json(appDefinition([field])));await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[appNode('n',[input])],edges:[]}})).rejects.toBeInstanceOf(Error);expect(transport.mock.calls.some(([url])=>url==='/api/v2/app-runs'||url==='/api/v2/canvas-runs')).toBe(false);
});
it('runs multiple application nodes in dependency order using actual upstream outputs and distinct persisted task IDs',async()=>{
 const llm={...cap,kind:'LLM',capabilityRef:'mock-llm'},field=appField('1','prompt'),first=appNode('first',[{...field,fieldValue:'first input'}],'text-app'),second=appNode('second',[{...field,binding:{sourceNodeId:'first'}}],'image-app'),graph={nodes:[{id:'g',type:'group',data:{nodeIds:['first','second']}},second,first],edges:[{source:'first',target:'second'}]};
 const {adapter,transport}=setup((path,init)=>path.includes('model-capabilities')?json({items:[cap,llm],nextCursor:null}):path.includes('/apps/')?json(appDefinition([field],path.endsWith('text-app')?'TEXT':'IMAGE',path.endsWith('text-app')?'text-app':'image-app')):json({id:JSON.parse(init.body).nodeId+'-task',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[{nodeId:JSON.parse(init.body).nodeId,state:'SUCCEEDED',outputs:[{id:'o',type:'TEXT',text:'actual upstream'}]}]},202));
 const result=await adapter.run({projectId:'p',targetType:'GROUP',targetId:'g',graph});const creates=transport.mock.calls.filter(([url])=>url==='/api/v2/app-runs').map(([,init])=>JSON.parse(init.body));expect(creates.map(body=>body.nodeId)).toEqual(['first','second']);expect(creates.map(body=>body.capabilityRef)).toEqual(['mock-llm',cap.capabilityRef]);expect(creates[1].inputNodes[0].fieldValue).toBe('[TEST MODE] actual upstream');expect(result).toEqual({taskId:'first-task',taskIds:['first-task','second-task'],testMode:true});expect(transport.mock.calls.some(([url])=>url==='/api/v2/canvas-runs')).toBe(false);
});
it('feeds an actual completed app asset into another form and polls the persisted upstream task without double-projecting outputs',async()=>{
 const text=appField('1','prompt'),image=appField('2','image','IMAGE'),first=appNode('first',[text],'first-app'),second=appNode('second',[{...image,binding:{sourceNodeId:'first'}}],'second-app'),graph={nodes:[first,second],edges:[{source:'first',target:'second'}]},asset={id:'a',state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:'https://studio.invalid/a'},completed={id:'first-task',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[{nodeId:'first',state:'SUCCEEDED',outputs:[{id:'o',type:'ASSET',assetId:'a'}]}]};
 const {adapter,transport}=setup((path,init)=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path==='/api/v1/assets/a'?json(asset):path==='/api/v2/apps/first-app'?json(appDefinition([text],'IMAGE','first-app')):path==='/api/v2/apps/second-app'?json(appDefinition([image],'IMAGE','second-app')):path==='/api/v2/tasks/first-task'?json(completed):JSON.parse(init.body).nodeId==='first'?json({...completed,state:'QUEUED',plans:completed.plans.map(plan=>({...plan,state:'QUEUED',outputs:[]}))},202):json({id:'second-task',projectId:'p',state:'SUCCEEDED',plans:[],testMode:true},202));const patch=vi.fn((id,data)=>Object.assign(graph.nodes.find(node=>node.id===id)!.data,data));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch});
 await adapter.run({projectId:'p',targetType:'CANVAS',graph});expect(JSON.parse(transport.mock.calls.filter(([url])=>url==='/api/v2/app-runs')[1][1].body).inputNodes[0].fieldValue).toBe('rhtv-asset:a');expect(patch).toHaveBeenCalledWith('first',expect.objectContaining({status:'finished',output:[expect.objectContaining({assetId:'a',url:'https://studio.invalid/a'})]}),{allowFields:['output','status']});expect(transport.mock.calls.filter(([url])=>url==='/api/v2/tasks/first-task')).toHaveLength(1);adapter.clear();
});
it('stops downstream application submissions after the user changes project while the upstream request is pending',async()=>{
 let finish!:(response:Response)=>void;const field=appField('1','prompt'),first=appNode('first',[field]),second=appNode('second',[{...field,binding:{sourceNodeId:'first'}}]),graph={nodes:[first,second],edges:[{source:'first',target:'second'}]},patch=vi.fn(),{adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap,{...cap,kind:'LLM',capabilityRef:'mock-llm'}],nextCursor:null}):path.includes('/apps/')?json(appDefinition([field],'TEXT')):new Promise(resolve=>finish=resolve));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:patch});
 const pending=adapter.run({projectId:'p',targetType:'CANVAS',graph}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));adapter.attach('q',{getRemoteData:()=>graph,patchNodeData:patch});finish(json({id:'t',projectId:'p',state:'SUCCEEDED',testMode:true,plans:[]}));await rejected;expect(transport.mock.calls.filter(([url])=>url==='/api/v2/app-runs')).toHaveLength(1);expect(patch).not.toHaveBeenCalled();adapter.clear();
});
it('executes a mixed APP/model graph with only actual completed upstream assets in the downstream source snapshot',async()=>{
 const field=appField('1','image','IMAGE','rhtv-asset:input'),first=appNode('first',[field]),second={id:'second',type:'rh-image',data:{modelCode:cap.capabilityRef,params:{prompt:'downstream'}}},graph={nodes:[first,second],edges:[{source:'first',target:'second'}]},task=(id:string,nodeId:string)=>({id,projectId:'p',state:'SUCCEEDED',testMode:true,plans:[{nodeId,state:'SUCCEEDED',outputs:[{id:'o',type:'ASSET',assetId:'result'}]}]});
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path.includes('/apps/')?json(appDefinition([field])):path.startsWith('/api/v1/assets/')?json({id:path.split('/').at(-1),state:'READY',kind:'IMAGE',mimeType:'image/png',downloadUrl:'https://studio.invalid/'+path.split('/').at(-1)}):path==='/api/v2/app-runs'?json(task('app-task','first'),202):json(task('model-task','second'),202));
 expect(await adapter.run({projectId:'p',targetType:'CANVAS',graph})).toMatchObject({taskIds:['app-task','model-task']});const downstream=JSON.parse(transport.mock.calls.find(([url])=>url==='/api/v2/canvas-runs')![1].body),source=downstream.graph.nodes.find((node:any)=>node.id==='first');expect(source.data.assetIds).toEqual(['result']);expect(source.data.output[0].assetId).toBe('result');expect(source.data).not.toHaveProperty('aiApp');expect(source.data).not.toHaveProperty('capabilityRef');expect(JSON.stringify(source)).not.toContain('rhtv-asset:input');expect(downstream.targetId).toBe('second');
});
it('propagates stale app revisions and does not retry or infer an undeclared output type',async()=>{
 const field=appField('1','prompt'),node=appNode('n',[field]),{adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap],nextCursor:null}):path.includes('/apps/')?json(appDefinition([field])):new Response(JSON.stringify({code:'VERSION_CONFLICT',message:'stale app'}),{status:412}));
 await expect(adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[node],edges:[]}})).rejects.toMatchObject({status:412});expect(transport.mock.calls.filter(([url])=>url==='/api/v2/app-runs')).toHaveLength(1);
 expect(appOutputKind({tags:[{name:'图生视频'}]})).toBe('TEXT_TO_VIDEO');expect(appOutputKind({tags:[{name:'音频生成'}]})).toBe('TEXT_TO_AUDIO');expect(appOutputKind({name:'unknown',covers:[{url:'image.png'}]})).toBeNull();
});
it('submits only the selected real entity plans with their parameters and owned reference, using advertised input-compatible mocks',async()=>{
 const imageCap={...cap,kind:'IMAGE_TO_IMAGE',capabilityRef:'mock-image-to-image'},graph={nodes:[{id:'entity',type:'rh-entity',data:{storyboardScriptNodeId:'script',storyboardEntityNode:true}},{id:'other',type:'rh-entity',data:{storyboardScriptNodeId:'script',storyboardEntityNode:true}}],edges:[]};
 const {adapter,transport}=setup(path=>path.includes('model-capabilities')?json({items:[cap,imageCap],nextCursor:null}):path==='/api/v1/assets/a'?json({id:'a',state:'READY',kind:'IMAGE'}):json({id:'t',state:'SUCCEEDED',testMode:true,plans:[]}));adapter.attach('p',{getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()});
 await adapter.generateEntityPlans('p',[{...graph.nodes[0],type:'rh-image',data:{...graph.nodes[0].data,name:'role',desc:'real description',subType:'IMAGE_IMAGE',sceneCode:'storyboard-prompt-character-four-creator',params:{prompt:'actual prompt and style',imageUrls:['rhtv-asset:a'],count:3},generateNum:3}}],capabilityModel(cap));
 const body=JSON.parse(transport.mock.calls.find(([url])=>url==='/api/v2/canvas-runs')![1].body);expect(body.graph.nodes).toHaveLength(1);expect(body.targetId).toBe('entity');expect(body.graph.nodes[0].data).toMatchObject({capabilityRef:imageCap.capabilityRef,generateNum:3,routerParameters:{count:3},params:{prompt:'actual prompt and style',imageUrls:['rhtv-asset:a']}});expect(transport.mock.calls.some(([url])=>String(url).includes('apiKey'))).toBe(false);adapter.clear();
});

it('selects the real advertised LLM while preserving feature conditions and stripping fixture parameters',async()=>{
 const real={...cap,capabilityRef:'codex-text-v1',kind:'LLM',executionKind:'AGENT',testMode:false,parameterSchema:{type:'object',additionalProperties:false,properties:{}}};
 const mock={...real,capabilityRef:'mock-llm',testMode:true};
 const {adapter,transport}=setup((path,init)=>path.includes('/model-capabilities')?json({items:[mock,real],nextCursor:null}):json({id:'task-real',state:'QUEUED',testMode:false,plans:[]}));
 const selection={schemaVersion:'1',featureCode:'prompt.enhance',conditions:{scene:'cinematic'}};
 try{await adapter.run({projectId:'p',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-text',data:{params:{prompt:' 保留原文 ',scenario:'success'},promptSelection:selection}}],edges:[]}});
 const submitted=JSON.parse(String(transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1].body));expect(submitted.graph.nodes[0].data).toMatchObject({capabilityRef:'codex-text-v1',testMode:false,routerParameters:{},params:{prompt:' 保留原文 ',scenario:'success'},promptSelection:selection});
 }finally{adapter.clear();}
});
it('offers H3 only for verified first-frame modes and omni reference, with bounded media controls',async()=>{
 const h3=(ref:string,mode:string,kind:string,limits:any)=>({capabilityRef:ref,version:'1',kind,available:true,testMode:false,model:{providerRef:'minimax',modelRef:'h3',title:'H3',version:'1'},inputKinds:['TEXT','IMAGE','AUDIO','VIDEO'],outputKinds:['VIDEO'],parameterSchema:{properties:{outputPreset:{type:'string',enum:['480p-landscape-5s'],default:'480p-landscape-5s'}},'x-video-mode':mode,'x-media-limits':limits}});
 const caps=[h3('first','FIRST_FRAME','IMAGE_TO_VIDEO',{IMAGE:1}),h3('both','FIRST_LAST_FRAME','IMAGE_TO_VIDEO',{IMAGE:2}),h3('omni','OMNI_REFERENCE','OMNI_REFERENCE',{IMAGE:9,AUDIO:3,VIDEO:1})];const {adapter}=setup(()=>json({items:caps,nextCursor:null}));
 const rows=await adapter.handle('/canvas/model/list',{types:['START_VIDEO','START_END_VIDEO','MULTIMODAL_VIDEO','VIDEO_EDIT','VIDEO_HD','TEXT_VIDEO','VIDEO_AUDIO']});expect(rows.map((r:any)=>r.modelList.map((m:any)=>m.modelCode))).toEqual([['first'],['both'],['omni'],[],[],[],['local-video-audio-v1']]);
 const controls=rows[2].modelList[0].config;expect(controls.find((c:any)=>c.type==='imageUrls').maxNum).toBe(9);expect(controls.find((c:any)=>c.type==='videoUrls').maxNum).toBe(1);expect(controls.find((c:any)=>c.type==='audioUrls').maxNum).toBe(3);expect(rows[0].modelList[0].generateNum).toEqual([1]);adapter.clear();
});
it('routes full audio extraction to owned media jobs and refuses vocal or ambient model guesses',async()=>{
 const {adapter,transport}=setup(path=>path==='/api/v1/assets/v'?json({id:'v',kind:'VIDEO',state:'READY',durationSeconds:3,width:640,height:480}):json({taskId:'media-task',outputs:[],status:'QUEUED',testMode:false},202));
 const node={id:'audio',type:'rh-audio',data:{toolsType:'VIDEO_AUDIO',modelCode:'local-video-audio-v1',params:{audioSeparationMode:'all',videoUrl:'rhtv-asset:v'}}};await expect(adapter.run({projectId:'p',targetId:'audio',graph:{nodes:[node],edges:[]}})).resolves.toEqual({taskId:'media-task',testMode:false});expect(JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/media-jobs')![1].body)).toMatchObject({operation:'EXTRACT_AUDIO',spec:{output:{container:'wav'}}});
 node.data.params.audioSeparationMode='vocal';await expect(adapter.run({projectId:'p',targetId:'audio',graph:{nodes:[node],edges:[]}})).rejects.toMatchObject({code:'AUDIO_SEPARATION_UNAVAILABLE'});expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);adapter.clear();
});
it('does not send a failed deterministic video edit through native model retry',async()=>{
 const {adapter,transport}=setup(()=>json({}));
 await expect(adapter.run({projectId:'p',targetId:'edit',graph:{nodes:[{id:'edit',type:'rh-video',data:{localVideoEdit:true,modelCode:'mock-text-to-video'}}],edges:[]}})).rejects.toMatchObject({code:'LOCAL_MEDIA_RETRY_UNAVAILABLE'});
 expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);adapter.clear();
});

it('keeps sketch polling alive through slow tasks and ends on cancellation',async()=>{
 vi.useFakeTimers();let queries=0;
 const {adapter}=setup(()=>json({id:'slow',state:++queries<4?'RUNNING':'CANCELLED',plans:[]}));
 const token=adapter.sketchProgress.start('p','live');adapter.sketchProgress.update(token,{phase:'running',taskId:'slow'});
 const pending=adapter.handle('/canvas/sketchboard/realtime/status',{taskId:'slow'});
 await vi.advanceTimersByTimeAsync(6000);
 expect(await pending).toMatchObject({status:'FAILED',errorMessage:'画板生成已取消。'});expect(queries).toBe(4);expect(adapter.sketchProgress.value?.phase).toBe('failed');
});
it('clears a pending sketch poll on session change',async()=>{
 vi.useFakeTimers();const {adapter}=setup(()=>json({id:'slow',state:'RUNNING',plans:[]}));
 const pending=adapter.handle('/canvas/sketchboard/realtime/status',{taskId:'slow'});const rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
 await vi.advanceTimersByTimeAsync(1);adapter.clear();await rejected;expect(adapter.sketchProgress.value).toBeNull();
});
it('reports sketch preflight failures without uploading unsupported inputs',async()=>{
 const {adapter,storage,transport}=setup(()=>json({logId:'trace-sketch'}));const upload=vi.spyOn(storage,'upload');
 await expect(adapter.handle('/canvas/sketchboard/realtime/generate',{canvasId:'p',image:'data:image/png;base64,AA==',styleCode:'missing'})).rejects.toMatchObject({code:'INVALID_SKETCH_STYLE',requestId:'trace-sketch'});
 expect(upload).not.toHaveBeenCalled();expect(transport.mock.calls[0][0]).toBe('/api/v2/generation-diagnostics');expect(adapter.sketchProgress.value?.phase).toBe('failed');
});
it('submits a sketch without an optional text description using actual sketch conditioning',async()=>{
 const mock={...cap,kind:'IMAGE_TO_IMAGE',capabilityRef:'mock-image-to-image'};const {adapter,storage,transport}=setup(path=>path==='/api/v1/assets/sketch'?json({id:'sketch',state:'READY',kind:'IMAGE'}):path.includes('model-capabilities')?json({items:[mock],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:true},202));vi.spyOn(storage,'upload').mockResolvedValue('rhtv-asset:sketch');
 await adapter.handle('/canvas/sketchboard/realtime/generate',{canvasId:'p',image:'data:image/png;base64,AA==',generationMode:'live'});
 const data=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;
 expect(data.params.prompt).toContain('草图');expect(data.promptSelection.conditions.stylePrompt).toContain('anime');expect(data.params.imageUrls).toEqual(['rhtv-asset:sketch']);
});

it.each(['1','2'])('regenerates H3 v%s from original image inputs without classifying the previous video as a reference',async version=>{
 const h3={...realModel('h3','IMAGE_TO_VIDEO'),capabilityRef:'h3-first-frame-v1',version,parameterSchemaVersion:version,model:{providerRef:'minimax',modelRef:'h3',title:'H3',version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['VIDEO']};
 const {adapter,transport}=setup(path=>path.startsWith('/api/v1/assets/')?json({id:path.split('/').at(-1),kind:path.endsWith('/image')?'IMAGE':'VIDEO',state:'READY'}):path.includes('model-capabilities')?json({items:[h3],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202));
 const graph:any={nodes:[{id:'ancestor',type:'rh-video',data:{videoUrl:'rhtv-asset:ancestor'}},{id:'source',type:'rh-image',data:{imageUrl:'rhtv-asset:image',params:{videoUrls:['rhtv-asset:ancestor']}}},{id:'target',type:'rh-video',data:{capabilityRef:h3.capabilityRef,capabilityVersion:version,modelCode:h3.capabilityRef,subType:'image-video',params:{prompt:'original motion',imageUrls:['rhtv-asset:image']},videoUrl:'rhtv-asset:old',sourceObjects:['rhtv-asset:old'],historyStorage:{historyId:'old-execution'},output:[{assetId:'old'}]}}],edges:[{source:'ancestor',target:'source'},{source:'source',target:'target'}]};
 await adapter.run({projectId:'p',targetId:'target',targetType:'NODE',graph});
 const request=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body),data=request.graph.nodes.find((n:any)=>n.id==='target').data;
 expect(data.params).toEqual(graph.nodes[2].data.params);expect(data.videoUrl).toBe('rhtv-asset:old');expect(data.historyStorage.historyId).toBe('old-execution');expect(request.graph.edges).toEqual(graph.edges);
 // An intentionally added video input must still fail for first-frame mode.
 graph.nodes[2].data.params.videoUrls=['rhtv-asset:explicit'];
 await expect(adapter.run({projectId:'p',targetId:'target',targetType:'NODE',graph})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
 expect(transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(1);
});

it.each(['1','2','3'])('regenerates Codex image v%s without classifying its old result as a reference',async version=>{
 const image={...realModel('image','TEXT_TO_IMAGE'),capabilityRef:'codex-image-generate-v1',version,parameterSchemaVersion:version,inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE']};
 const {adapter,transport}=setup(path=>path.startsWith('/api/v1/assets/')?json({id:path.split('/').at(-1),kind:'IMAGE',state:'READY'}):path.includes('model-capabilities')?json({items:[image],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202));
 const graph:any={nodes:[{id:'target',type:'rh-image',data:{capabilityRef:image.capabilityRef,capabilityVersion:version,modelCode:image.capabilityRef,subType:'text-image',params:{prompt:'original composition'},imageUrl:'rhtv-asset:old',sourceObjects:['rhtv-asset:old'],historyStorage:{historyId:'old-execution'},output:[{assetId:'old'}]}}],edges:[]};
 await adapter.run({projectId:'p',targetId:'target',targetType:'NODE',graph});
 const request=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body);
 expect(request.graph.nodes[0].data.imageUrl).toBe('rhtv-asset:old');expect(request.graph.nodes[0].data.params).toEqual(graph.nodes[0].data.params);
 graph.nodes[0].data.params.imageUrls=['rhtv-asset:explicit'];
 await expect(adapter.run({projectId:'p',targetId:'target',targetType:'NODE',graph})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
});

it.each([false,true])('classifies new/selected-model image editing from direct sources (default=%s)',async useDefault=>{
 const image={...realModel('image','IMAGE_TO_IMAGE'),capabilityRef:'codex-image-edit-v1',version:'3',parameterSchemaVersion:'3',inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE']};
 const {adapter,transport}=setup(path=>path.startsWith('/api/v1/assets/')?json({byteSize:2048,mimeType:path.endsWith('/video')?'video/mp4':'image/png',id:path.split('/').at(-1),kind:path.endsWith('/video')?'VIDEO':'IMAGE',state:'READY'}):path.includes('model-capabilities')?json({items:[image],nextCursor:null}):json({id:'t',state:'SUCCEEDED',plans:[],testMode:false},202));
 const graph:any={nodes:[{id:'ancestor',type:'rh-video',data:{videoUrl:'rhtv-asset:video'}},{id:'source',type:'rh-image',data:{imageUrl:'rhtv-asset:image',params:{videoUrls:['rhtv-asset:video']}}},{id:'target',type:'rh-image',data:{capabilityRef:image.capabilityRef,modelCode:image.capabilityRef,subType:'image-image',params:{prompt:'edit image',imageUrls:['rhtv-asset:image']},imageUrl:'rhtv-asset:old',output:[{assetId:'old'}]}}],edges:[{source:'ancestor',target:'source'},{source:'source',target:'target'}]};
 if(useDefault){delete graph.nodes[2].data.capabilityRef;delete graph.nodes[2].data.modelCode;delete graph.nodes[2].data.imageUrl;delete graph.nodes[2].data.output;}
 await adapter.run({projectId:'p',targetId:'target',targetType:'NODE',graph});
 graph.edges.push({source:'ancestor',target:'target'});
 await expect(adapter.run({projectId:'p',targetId:'target',targetType:'NODE',graph})).rejects.toMatchObject({code:useDefault?'MODEL_UNAVAILABLE':'MODEL_INPUT_UNSUPPORTED'});
 expect(transport.mock.calls.filter(call=>call[0]==='/api/v2/canvas-runs')).toHaveLength(1);
});

it('hides nonfunctional prompts for measured image upscalers without renaming their actual model',()=>{
 const cap:any={capabilityRef:'seedvr2-image-enhance-v1',version:'1',kind:'IMAGE_ENHANCE',available:true,testMode:false,title:'SeedVR2 3B FP8 · 2×',inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],model:{providerRef:'comfyui',modelRef:'seedvr2-3b-fp8',title:'SeedVR2 3B FP8'},parameterSchema:{'x-prompt-policy':'ignored',description:'保持源图比例放大 2×；提示词不参与增强。',properties:{outputPreset:{type:'string',enum:['2x'],default:'2x'}}}};
 const model=capabilityModel(cap);expect(model.modelName).toBe(cap.title);expect(model.description).toContain('提示词不参与');expect(model.config.some(field=>field.paramName==='prompt')).toBe(false);expect(model.config.some(field=>field.type==='imageUrls')).toBe(true);
});
