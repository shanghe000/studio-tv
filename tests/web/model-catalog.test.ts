import {afterEach,describe,expect,it,vi} from 'vitest';
import {menuCapabilities,modelChoice,modelSelections,selectedModel,selectCapability,resolveCapability,readModelCatalog,type Capability} from '../../apps/web/src/service/model-catalog';
export const profile=(version:string,kind='LLM',provider='supplier'):Capability=>({capabilityRef:`${provider}-${version}-${kind}`,version:'1',kind,available:true,testMode:false,executionKind:'AGENT',inputKinds:kind==='LLM'?['TEXT','STRUCTURED']:['TEXT','STRUCTURED','IMAGE'],outputKinds:['TEXT'],model:{providerRef:provider,modelRef:`m-${version}`,title:`Model ${version}`,version},parameterSchemaVersion:'1',parameterSchema:{type:'object',additionalProperties:false}});
afterEach(()=>{modelSelections.clear();vi.unstubAllGlobals();});
describe('public model selection',()=>{
 it('sorts configured text versions newest first while leaving providers neutral',()=>{
  const caps=[profile('5.6'),profile('6'),profile('6.1')];expect(menuCapabilities(caps,'LLM').map(cap=>cap.model!.version)).toEqual(['6.1','6','5.6']);expect(selectCapability(caps,'LLM',['TEXT']).model!.version).toBe('6.1');
  expect(menuCapabilities([profile('6.1'),profile('99','LLM','future')],'LLM').map(cap=>cap.model!.providerRef)).toEqual(['supplier','future']);
 });
 it('requires image-understanding profiles, declared inputs and textual outputs',()=>{
  const bad=profile('5.6');bad.inputKinds!.push('IMAGE');const image=profile('6.1','IMAGE_UNDERSTANDING');
  const missing={...image,capabilityRef:'missing',inputKinds:undefined},mediaOnly={...image,capabilityRef:'media-only',outputKinds:['IMAGE']};
  expect(menuCapabilities([bad,image,missing,mediaOnly],'LLM',['IMAGE']).map(cap=>cap.capabilityRef)).toEqual([image.capabilityRef]);expect(selectCapability([bad,image],'LLM',['IMAGE']).capabilityRef).toBe(image.capabilityRef);
  expect(()=>selectCapability([bad,image],'LLM',['IMAGE'],{capabilityRef:bad.capabilityRef})).toThrowError(expect.objectContaining({code:'MODEL_INPUT_UNSUPPORTED'}));
  expect(()=>selectCapability([mediaOnly],'IMAGE_UNDERSTANDING',['IMAGE'],{capabilityRef:mediaOnly.capabilityRef})).toThrowError(expect.objectContaining({code:'MODEL_INPUT_UNSUPPORTED'}));
 });
 it('omits test placeholders across the production catalog even when their kind has no real model',()=>{
  const real=profile('6.1'),mock={...real,capabilityRef:'mock-llm',model:undefined,testMode:true};expect(menuCapabilities([mock,real],'LLM')).toEqual([real]);const media={...mock,kind:'TEXT_TO_IMAGE'};expect(menuCapabilities([media,real],'TEXT_TO_IMAGE')).toEqual([]);expect(menuCapabilities([media],'TEXT_TO_IMAGE')).toEqual([media]);
 });
 it('hides legacy generic profiles in menus while allowing an explicit old session',()=>{
  const legacy={...profile('6.1'),capabilityRef:'legacy',model:undefined},current=profile('6.1');expect(menuCapabilities([legacy,current],'LLM')).toEqual([current]);expect(selectCapability([legacy,current],'LLM',['TEXT'],{capabilityRef:'legacy'})).toBe(legacy);
 });
 it('never replaces unknown, unavailable or stale explicit selections with a default',()=>{
  const cap=profile('6.1');for(const choice of [{capabilityRef:'unknown'},{capabilityRef:cap.capabilityRef,capabilityVersion:'old'}])expect(()=>selectCapability([cap],'LLM',[],choice)).toThrow();
  modelSelections.set('assistant:LLM',{capabilityRef:cap.capabilityRef});expect(selectedModel({modelCode:'unknown'},'assistant')?.capabilityRef).toBe('unknown');
  modelSelections.set('assistant:LLM',{capabilityRef:cap.capabilityRef,explicit:true});expect(selectedModel({modelCode:'native-vendor-label'},'assistant')?.capabilityRef).toBe(cap.capabilityRef);expect(selectedModel({capabilityRef:'unknown'},'assistant')?.capabilityRef).toBe('unknown');expect(()=>modelChoice({modelCode:{path:'private'}})).toThrow();
 });
 it('keeps mock models explicitly marked and never claims an unconfigured profile',()=>{
  const real=profile('6.1'),mock={...real,capabilityRef:'mock',model:undefined,testMode:true},unavailable={...real,available:false};expect(()=>selectCapability([unavailable,mock],'LLM',['TEXT'])).toThrowError(expect.objectContaining({code:'MODEL_UNAVAILABLE'}));expect(selectCapability([mock],'LLM',['TEXT']).capabilityRef).toBe('mock');expect(()=>selectCapability([unavailable],'LLM')).toThrow();
 });
 it('rejects new production submissions for explicit historical test selections but preserves test-only fixtures',async()=>{
  const real=profile('6.1'),mock={...real,capabilityRef:'mock-video',kind:'TEXT_TO_VIDEO',testMode:true,model:undefined},choice={capabilityRef:mock.capabilityRef,capabilityVersion:'old'};
  expect(()=>selectCapability([real,mock],'TEXT_TO_VIDEO',[],{capabilityRef:mock.capabilityRef})).toThrowError(expect.objectContaining({code:'MODEL_UNAVAILABLE'}));
  const historical={...mock,version:'old'},request=vi.fn(async()=>({data:historical}));
  await expect(resolveCapability(request,[real,mock],'TEXT_TO_VIDEO',[],choice)).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});expect(request).toHaveBeenCalledOnce();
  expect(selectCapability([mock],'TEXT_TO_VIDEO',[],{capabilityRef:mock.capabilityRef})).toBe(mock);
  expect(menuCapabilities([mock],'TEXT_TO_VIDEO',[],{allowTestMode:false})).toEqual([]);
 });
 it('reads all catalog pages and rejects a repeated cursor',async()=>{
  const request=vi.fn().mockResolvedValueOnce({data:{items:[profile('5.6')],nextCursor:'next'}}).mockResolvedValueOnce({data:{items:[profile('6.1')],nextCursor:null}});expect(await readModelCatalog(request)).toHaveLength(2);expect(request.mock.calls[1][0]).toContain('cursor=next');
  await expect(readModelCatalog(vi.fn().mockResolvedValue({data:{items:[],nextCursor:'same'}}))).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 });
});
