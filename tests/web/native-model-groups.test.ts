import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

// Execute the immutable native group's actual modality filter and lookup. A
// nonempty service response alone did not reveal the missing child metadata.
const compiled=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=compiled.indexOf('const Umt=new Set('),end=compiled.indexOf('function E6n(',start);
const native=new Function(compiled.slice(start,end)+';return {videoGroups:$mt,terminal:pu,entries:Vmt};')() as {videoGroups:(groups:any[])=>any[];terminal:(groups:any[],ref:string)=>any;entries:(groups:any[])=>any[]};
const json=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
const media=(kind:string)=>({capabilityRef:'mock-'+kind.toLowerCase(),kind,version:'1',parameterSchemaVersion:'1',available:true,testMode:true,title:'MOCK · '+kind,parameterSchema:{type:'object',properties:{scenario:{type:'string',enum:['success','failure'],default:'success'},count:{type:'integer',default:1}}}});
const codex={...media('LLM'),capabilityRef:'codex-6-1-text-v1',executionKind:'AGENT',testMode:false,title:'Codex 6.1 · 文本',model:{providerRef:'codex',modelRef:'codex-6-1',title:'Codex 6.1',version:'6.1'},inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],parameterSchema:{type:'object',additionalProperties:false}};
function setup(caps:any[],allowTestMode=true){
 const transport=vi.fn((path:string)=>Promise.resolve(path.includes('/model-capabilities')?json({items:caps,nextCursor:null}):json({id:'fixture-task',state:'SUCCEEDED',testMode:true,plans:[]},202))),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-owner');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn(),{allowTestMode});return{adapter,transport};
}
it('keeps each available image/video/motion leaf and ancestor modality list consistent with its actual models',async()=>{
 const caps=['TEXT_TO_IMAGE','TEXT_TO_VIDEO','IMAGE_TO_VIDEO','VIDEO_TO_VIDEO','OMNI_REFERENCE'].map(media),{adapter}=setup([...caps,codex,{...media('VIDEO_ENHANCE'),available:false}]),groups=await adapter.handle('/canvas/model/group/list',{});
 for(const group of groups){expect(group.nodeTypeList.sort()).toEqual([...new Set(group.modelGroupList.flatMap((leaf:any)=>leaf.nodeTypeList))].sort());for(const leaf of group.modelGroupList){expect(leaf.nodeTypeList).toEqual(leaf.nodeModelList.map((row:any)=>row.nodeType));expect(leaf.nodeModelList.every((row:any)=>row.modelList.length===1&&row.modelList[0].available)).toBe(true);}}
 const videos=native.videoGroups(groups),entries=native.entries(videos);expect(new Set(entries.map(row=>row.model.capabilityRef))).toEqual(new Set(caps.filter(cap=>cap.kind!=='TEXT_TO_IMAGE').map(cap=>cap.capabilityRef)));expect(entries.every(row=>row.model.testMode===true&&row.model.modelName.startsWith('[TEST MODE]'))).toBe(true);expect(entries.some(row=>row.model.capabilityRef===codex.capabilityRef)).toBe(false);
 expect(native.terminal(videos,'mock-text_to_video').nodeTypeList).toContain('TEXT_VIDEO');expect(native.terminal(videos,'mock-image_to_video').nodeTypeList).toEqual(expect.arrayContaining(['IMAGE_VIDEO','START_VIDEO','START_END_VIDEO']));expect(native.terminal(groups,'mock-video_to_video').nodeTypeList).toContain('VIDEO_MOTION_TRANSFER');expect(groups.find((group:any)=>group.modelGroupId==='TEXT_TO_IMAGE').modelGroupList[0].modelGroupName).toBe('[TEST MODE] MOCK · TEXT_TO_IMAGE');
});
it('lets the native cascade select the advertised video model and its actual parameters for the frozen request',async()=>{
 const cap=media('TEXT_TO_VIDEO'),{adapter,transport}=setup([codex,cap]),groups=native.videoGroups(await adapter.handle('/canvas/model/group/list',{})),model=native.entries(groups)[0].model;
 expect(model.config.find((field:any)=>field.paramName==='scenario').paramValue).toBe('success');expect(model.modelCode).toBe(cap.capabilityRef);
 await adapter.run({projectId:'fixture-project',targetType:'NODE',targetId:'video',graph:{nodes:[{id:'video',type:'rh-video',data:{subType:'text-video',modelCode:model.modelCode,params:{prompt:'fixture video',scenario:'failure',count:1}}}],edges:[]}});
 const frozen=JSON.parse(transport.mock.calls.find(call=>call[0]==='/api/v2/canvas-runs')![1].body).graph.nodes[0].data;expect(frozen.capabilityRef).toBe(cap.capabilityRef);expect(frozen.testMode).toBe(true);expect(frozen.routerParameters).toEqual({scenario:'failure',count:1});expect(frozen.params.prompt).toBe('fixture video');
});
it('omits unconfigured video groups and keeps distinct configured models separately selectable',async()=>{
 const first=media('TEXT_TO_VIDEO'),second={...first,capabilityRef:'mock-video-second',title:'Second video'},unavailable={...media('IMAGE_TO_VIDEO'),available:false},{adapter}=setup([codex,first,second,unavailable]),groups=native.videoGroups(await adapter.handle('/canvas/model/group/list',{}));
 expect(groups).toHaveLength(1);expect(groups[0].modelGroupList).toHaveLength(2);expect(native.terminal(groups,first.capabilityRef).modelGroupId).not.toBe(native.terminal(groups,second.capabilityRef).modelGroupId);expect(native.terminal(groups,unavailable.capabilityRef)).toBeNull();
});

it('keeps unsupported production video modes empty and rejects an old mock retry before submission',async()=>{
 const placeholder=media('TEXT_TO_VIDEO'),{adapter,transport}=setup([codex,placeholder],false);
 const rows=await adapter.handle('/canvas/model/list',{types:['TEXT_VIDEO']});expect(rows[0].modelList).toEqual([]);
 expect(native.videoGroups(await adapter.handle('/canvas/model/group/list',{}))).toEqual([]);
 await expect(adapter.run({projectId:'fixture-project',targetType:'NODE',targetId:'video',graph:{nodes:[{id:'video',type:'rh-video',data:{subType:'text-video',modelCode:placeholder.capabilityRef,capabilityVersion:'1',params:{prompt:'must not generate a fixture'}}}],edges:[]}})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});
 expect(transport.mock.calls.some(call=>call[0]==='/api/v2/canvas-runs')).toBe(false);
});

it('hides mock-only catalogs in explicit service mode while retaining test-only fixture menus',async()=>{
 const placeholder=media('TEXT_TO_VIDEO'),service=setup([placeholder],false),fixture=setup([placeholder],true);
 expect((await service.adapter.handle('/canvas/model/list',{types:['TEXT_VIDEO']}))[0].modelList).toEqual([]);
 expect((await fixture.adapter.handle('/canvas/model/list',{types:['TEXT_VIDEO']}))[0].modelList[0].modelCode).toBe(placeholder.capabilityRef);
});
