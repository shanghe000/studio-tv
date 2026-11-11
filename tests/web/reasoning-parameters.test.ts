import {afterEach,expect,it,vi} from 'vitest';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {nativeModelProps} from '../../apps/web/src/service/model-selectors';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {resolveCapability,modelSelections,type Capability} from '../../apps/web/src/service/model-catalog';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const profile=(model='6.1',kind='LLM',version='2'):Capability=>({capabilityRef:'codex-'+model.replaceAll('.','-')+(kind==='LLM'?'-text-v1':'-vision-text-v1'),version,kind,available:true,testMode:false,executionKind:'AGENT',parameterSchemaVersion:version,parameterSchema:{type:'object',properties:version==='2'?{reasoningEffort:{type:'string',enum:['low','high'],default:'low'}}:{},additionalProperties:false},inputKinds:kind==='LLM'?['TEXT','STRUCTURED']:['TEXT','STRUCTURED','IMAGE'],outputKinds:['TEXT'],model:{providerRef:'codex',modelRef:'model-'+model,title:'Codex '+model,version:model}});
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
function fixture(caps:Capability[],exact?:Capability){
 const transport=vi.fn(async(path:string,options:any)=>{
  if(path.includes('/model-capabilities?'))return json({items:caps,nextCursor:null});
  if(path.startsWith('/api/v2/model-capability-version?'))return json(exact);
  if(path==='/api/v1/assets/image')return json({byteSize:2048,mimeType:'image/png',id:'image',kind:'IMAGE',state:'READY'});
  if(path==='/api/v2/canvas-runs')return json({id:'task',state:'SUCCEEDED',plans:[],testMode:false},202);
  throw new Error('Unexpected fixture request: '+path);
 });const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 return{adapter:new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn().mockResolvedValue(undefined),vi.fn()),transport,submitted:()=>JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data};
}
afterEach(()=>modelSelections.clear());
it.each(['LLM','IMAGE_UNDERSTANDING'])('projects advertised schema2 into the original %s parameter panel with native Low/High labels',kind=>{
 const model=capabilityModel(profile('6.1',kind)),field=model.config.find(field=>field.paramName==='reasoning_effort');
 expect(field).toMatchObject({paramDataType:'string',type:'list',title:'推理强度',titleEn:'ReasoningEffort',display:true,paramValue:'low',optionValue:[{value:'low',labelCn:'Low',labelEn:'Low'},{value:'high',labelCn:'High',labelEn:'High'}]});expect(model.config.some(field=>field.paramName==='reasoningEffort')).toBe(false);
 expect(capabilityModel(profile('6.1',kind,'1')).config.some(field=>field.paramName==='reasoning_effort')).toBe(false);
});
it.each(['TEXT_TEXT','TEXT_SCRIPT','MULTIMODAL_TEXT'])('freezes actual native %s High ahead of the previous run Low without editing user presets',async subType=>{
 const cap=profile('6.1',subType==='MULTIMODAL_TEXT'?'IMAGE_UNDERSTANDING':'LLM'),f=fixture([cap]),data={subType,modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:'2',params:{prompt:'<role>user template</role>',reasoning_effort:'high',temperature:0.7,...(cap.kind==='IMAGE_UNDERSTANDING'?{imageUrls:['rhtv-asset:image']}:{})},routerParameters:{reasoningEffort:'low'},presetSelections:undefined},before=structuredClone(data);
 await f.adapter.run({projectId:'project',targetType:'NODE',targetId:'node',graph:{nodes:[{id:'node',type:subType==='TEXT_SCRIPT'?'rh-script':'rh-text',data}],edges:[]}});
 expect(f.submitted()).toMatchObject({capabilityRef:cap.capabilityRef,capabilityVersion:'2',parameterSchemaVersion:'2',routerParameters:{reasoningEffort:'high'}});expect(f.submitted().params).toEqual(before.params);expect(data).toEqual(before);
});
it('keeps schema1 requests and saved-node parameter edits at version1, while only a deliberate different model choice binds latest2',async()=>{
 const latest=profile(),old=profile('6.1','LLM','1'),other=profile('6'),f=fixture([latest,other],old),data={modelCode:old.capabilityRef,capabilityRef:old.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'old original',reasoning_effort:'high'},routerParameters:{}},node={id:'n',type:'rh-text',data},callback=vi.fn(),props={targetNode:node,nodes:[node],edges:[],models:{'text-text':[capabilityModel(latest),capabilityModel(other)]},onNodeDataPatch:callback},view=nativeModelProps(props);
 expect(view.models['text-text'][0].config.some((field:any)=>field.paramName==='reasoning_effort')).toBe(false);expect(view.models['text-text'][1].config.some((field:any)=>field.paramName==='reasoning_effort')).toBe(true);
 const edit={modelCode:old.capabilityRef,params:{prompt:'edited original'}};view.onNodeDataPatch('n',edit);expect(callback).toHaveBeenLastCalledWith('n',edit);expect(data.capabilityVersion).toBe('1');
 view.onNodeDataPatch('n',{modelCode:other.capabilityRef,params:{prompt:'original',reasoning_effort:'high'}});expect(callback).toHaveBeenLastCalledWith('n',expect.objectContaining({capabilityVersion:'2',parameterSchemaVersion:'2',capabilityRef:other.capabilityRef}));
 await f.adapter.run({projectId:'project',targetType:'NODE',targetId:'n',graph:{nodes:[node],edges:[]}});expect(f.submitted()).toMatchObject({capabilityVersion:'1',parameterSchemaVersion:'1',routerParameters:{}});expect(f.transport.mock.calls.filter(call=>call[0].includes('/model-capability-version?'))).toHaveLength(1);expect(data.capabilityVersion).toBe('1');
});
it.each([null,5,'Low','medium',{},[]])('rejects invalid advertised native effort %j rather than resetting the user choice to low',value=>{
 expect(()=>routerParameters(profile(),{params:{reasoning_effort:value},routerParameters:{reasoningEffort:'low'}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
});
it('emits default low only for advertised schema2 and retains canonical high when no native edit is present',()=>{
 expect(routerParameters(profile(),{})).toEqual({reasoningEffort:'low'});expect(routerParameters(profile(),{routerParameters:{reasoningEffort:'high'}})).toEqual({reasoningEffort:'high'});expect(routerParameters(profile('6.1','LLM','1'),{params:{reasoning_effort:'high'}})).toEqual({});
});
it.each([
 ['wrong version',{...profile('6.1','LLM','1'),version:'2'}],
 ['wrong ref',{...profile('6.1','LLM','1'),capabilityRef:'another-ref'}],
 ['missing schema',{...profile('6.1','LLM','1'),parameterSchema:undefined}],
] as [string,Capability][])('rejects exact lookup %s with no latest fallback',async(_label,exact)=>{
 const f=fixture([profile()],exact);await expect(f.adapter.run({projectId:'project',targetType:'NODE',targetId:'n',graph:{nodes:[{id:'n',type:'rh-text',data:{modelCode:profile().capabilityRef,capabilityVersion:'1',params:{prompt:'original'}}}],edges:[]}})).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(f.transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});
it('uses exact historical metadata for a slash-containing ref and does not query exact for unversioned/default or current selections',async()=>{
 const cap={...profile('6.1','LLM','1'),capabilityRef:'public/model'},request=vi.fn().mockResolvedValue({data:cap});expect(await resolveCapability(request,[{...cap,version:'2'}],'LLM',[],{capabilityRef:cap.capabilityRef,capabilityVersion:'1'})).toBe(cap);expect(request).toHaveBeenCalledWith('/model-capability-version?ref=public%2Fmodel&version=1');
 request.mockClear();expect(await resolveCapability(request,[profile()],'LLM')).toMatchObject({version:'2'});expect(await resolveCapability(request,[profile()],'LLM',[],{capabilityRef:profile().capabilityRef,capabilityVersion:'2'})).toMatchObject({version:'2'});expect(request).not.toHaveBeenCalled();
});
it('rejects an exact-version response arriving after identity clear without submitting or replacing latest metadata',async()=>{
 let resolve!:(response:Response)=>void;const cap=profile(),old=profile('6.1','LLM','1'),transport=vi.fn(async(path:string)=>{
  if(path.includes('/model-capabilities?'))return json({items:[cap],nextCursor:null});
  if(path.includes('/model-capability-version?'))return new Promise<Response>(done=>resolve=done);
  throw new Error('Unexpected fixture request: '+path);
 }),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn().mockResolvedValue(undefined),vi.fn()),graph={nodes:[{id:'n',type:'rh-text',data:{modelCode:cap.capabilityRef,capabilityVersion:'1',params:{prompt:'old'}}}],edges:[]};
 const pending=adapter.run({projectId:'project',targetType:'NODE',targetId:'n',graph}),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));adapter.clear();resolve(json(old));await rejected;expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);expect(graph.nodes[0].data.capabilityVersion).toBe('1');
});
