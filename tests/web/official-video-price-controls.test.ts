// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import rawCatalog from './fixtures/router-official-video-capabilities.json';
import {ApiError} from '../../apps/web/src/api/client';
import {credentialsChangedEvent} from '../../apps/web/src/service/model-provider-credentials';
import {installOfficialVideoPriceControls,officialVideoPriceText,validOfficialVideoPrice,type OfficialVideoPrice,type OfficialVideoPriceRequest} from '../../apps/web/src/service/official-video-price-controls';

let dispose:(()=>void)|undefined;
afterEach(()=>{dispose?.();dispose=undefined;document.body.innerHTML='';document.head.innerHTML='';vi.useRealTimers();vi.restoreAllMocks();});
function capability(ref='h3-official-text-to-video-v1'){
 const cap=structuredClone((rawCatalog as any[]).find(cap=>cap.capabilityRef===ref)!);cap.testMode=false;cap.available=true;cap.parameterSchema['x-model-source']={kind:'API',credentialProviderRef:cap.model.providerRef};return cap;
}
function quote(body:OfficialVideoPriceRequest,amount='0.4'):OfficialVideoPrice{return{schemaVersion:'1',capabilityRef:body.capabilityRef,capabilityVersion:body.capabilityVersion,status:'ESTIMATE',currency:'USD',amount,minimumAmount:null,maximumAmount:null,providerRef:'minimax-official',region:'global',pricingRevision:'fixture-price-1',checkedAt:'2026-11-02',basis:['输出秒数 × 公开单价'],warnings:['实际以厂商账单为准'],sources:[{title:'MiniMax 官方价格',url:'https://platform.minimax.io/docs/pricing/overview'}]};}
function fixture(ref?:string){
 vi.useFakeTimers();
 const cap=capability(ref),target={id:'video',type:'rh-video',data:{modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:'1',params:{outputPreset:cap.parameterSchema['x-video-parameter-metadata'].presets[0].value}}},graph:any={nodes:[target],edges:[]};
 const action:any={currentModel:{capabilityRef:cap.capabilityRef,capabilityVersion:'1'},params:target.data.params};
 document.body.innerHTML='<div class="rh-canvas-video-params" data-target-node-id="video"><div class="config-panel-wrap__basic"><div class="video-input-wrap"></div><div class="config-row"><button class="generate-action-button">开始生成</button></div></div></div><span id="change"></span>';
 const api={requestV2:vi.fn(async(_path:string,{body}:any)=>({data:quote(body)}))},auth:any={user:{id:'owner'},onClear:vi.fn(()=>()=>{})},storage={encodeAsset:(url:string)=>url,resolveAsset:vi.fn(async()=>({kind:'VIDEO'}))},bindings={node:(node:any)=>node,record:vi.fn()};
 const runtime:any={auth,api,storage,inspect:()=>({id:'project'}),execution:{catalog:vi.fn(async()=>[cap])},modelBindingPort:()=>bindings},native={bt:()=>({getRemoteData:()=>graph})};
 dispose=installOfficialVideoPriceControls(runtime,native,()=>[action]);return{cap,target,graph,action,runtime,api,bindings};
}
const flush=async(ms=0)=>{await vi.advanceTimersByTimeAsync(ms);await Promise.resolve();await Promise.resolve();};
const change=()=>{document.querySelector('#change')!.textContent=String(Math.random());};
const text=()=>document.querySelector('.studio-official-video-price')?.textContent??'';

it('shows a debounced authenticated read-only quote with rules and source links, without patching selection',async()=>{
 const f=fixture(),before=structuredClone(f.graph);await flush();
 expect(text()).toContain('估算中');expect(f.api.requestV2).not.toHaveBeenCalled();
 await flush(310);
 expect(f.api.requestV2).toHaveBeenCalledExactlyOnceWith('/model-price-estimates',expect.objectContaining({method:'POST',cache:'no-store',body:{capabilityRef:f.cap.capabilityRef,capabilityVersion:'1',parameters:{outputPreset:'768p-16x9-5s'},media:{imageCount:0,videoDurationsMs:[]}}}));
 expect(text()).toContain('US$0.40 USD');expect(text()).toContain('计费规则与来源');expect(text()).toContain('实际以厂商账单为准');
 expect(text()).toContain('公开价格核对日期：2026-11-02');
 expect(document.querySelector('.config-row')!.previousElementSibling).toBe(document.querySelector('.studio-official-video-price'));
 const link=document.querySelector<HTMLAnchorElement>('.studio-official-video-price a')!;expect(link.href).toBe('https://platform.minimax.io/docs/pricing/overview');expect(link.rel).toContain('noopener');
 expect(f.graph).toEqual(before);expect(f.bindings.record).not.toHaveBeenCalled();expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
});
it('drops stale results when a later parameter choice supersedes an in-flight request',async()=>{
 const f=fixture(),pending:{body:OfficialVideoPriceRequest;resolve:(value:any)=>void}[]=[];
 f.api.requestV2.mockImplementation((_path:string,{body}:any)=>new Promise(resolve=>pending.push({body,resolve})));
 await flush(310);expect(pending).toHaveLength(1);
 f.action.params.outputPreset='768p-16x9-10s';change();await flush(310);expect(pending).toHaveLength(2);
 pending[1].resolve({data:quote(pending[1].body,'0.8')});await flush();expect(text()).toContain('US$0.80 USD');
 pending[0].resolve({data:quote(pending[0].body,'99')});await flush();expect(text()).not.toContain('99');expect(text()).toContain('US$0.80 USD');
});
it('counts actual input images and reads only the uploaded source video duration, never the target duration',async()=>{
 const f=fixture('h3-official-omni-reference-v1');
 f.graph.nodes.push({id:'images',type:'rh-image',data:{sourceObjects:['rhtv-asset:one','rhtv-asset:two']}},{id:'source',type:'rh-video',data:{isUpload:true,sourceObjects:['rhtv-asset:video'],duration:25.0625}});
 f.graph.edges.push({source:'images',target:'video'},{source:'source',target:'video'});(f.target.data as any).duration=8;
 f.api.requestV2.mockRejectedValue(new ApiError(422,'PRICE_ESTIMATE_INVALID','private detail'));
 await flush(310);
 expect(f.api.requestV2.mock.calls[0][1].body.media).toEqual({imageCount:2,videoDurationsMs:[25063]});expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
 expect(text()).toContain('费用未知');expect(text()).toContain('素材不符合模型要求');expect(text()).not.toContain('private detail');
});
it('uses metadata on an unflagged native upload, but never reuses that duration for generated/history/multiple results',async()=>{
 const f=fixture('h3-official-omni-reference-v1'),source:any={id:'source',type:'rh-video',data:{sourceObjects:['rhtv-asset:upload'],duration:7.5}};
 f.graph.nodes.push(source);f.graph.edges.push({source:'source',target:'video'});
 await flush(310);
 expect(f.api.requestV2.mock.calls[0][1].body.media.videoDurationsMs).toEqual([7500]);expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
 for(const patch of [{modelCode:'generated-model'},{taskId:'task-generated'},{historyStorage:{historyId:'selected'}},{output:[{url:'rhtv-asset:upload'}]},{sourceObjects:['rhtv-asset:upload','rhtv-asset:another']}]){
  source.data={sourceObjects:['rhtv-asset:upload'],duration:7.5,...patch};change();await flush(310);
  const body=f.api.requestV2.mock.calls.at(-1)![1].body;expect(body.media.videoDurationsMs.every(value=>value===null)).toBe(true);
 }
 expect(f.runtime.storage.resolveAsset).toHaveBeenCalledWith('rhtv-asset:upload');
});
it('uses null for unknown reference duration and never materializes arbitrary external URLs',async()=>{
 const f=fixture('h3-official-omni-reference-v1');
 f.graph.nodes.push({id:'source',type:'rh-video',data:{sourceObjects:['rhtv-asset:unknown']}});f.graph.edges.push({source:'source',target:'video'});
 f.api.requestV2.mockImplementation(async(_path:string,{body}:any)=>({data:{...quote(body),status:'LOWER_BOUND',amount:null,minimumAmount:'0.4'}}));
 await flush(310);expect(f.api.requestV2.mock.calls[0][1].body.media.videoDurationsMs).toEqual([null]);expect(text()).toContain('USD 起');expect(text()).toContain('实际可能更高');
 f.graph.nodes[1].data.sourceObjects=['https://catalog.invalid/not-owned.mp4'];change();await flush(310);
 expect(text()).toContain('参考素材尚未就绪');expect(f.runtime.storage.resolveAsset).toHaveBeenCalledTimes(1);expect(f.api.requestV2).toHaveBeenCalledTimes(1);
});
it('refreshes after a credential region change and removes quotes on self-host selection or logout',async()=>{
 const f=fixture();await flush(310);expect(f.api.requestV2).toHaveBeenCalledTimes(1);
 window.dispatchEvent(new CustomEvent(credentialsChangedEvent));await flush(310);expect(f.api.requestV2).toHaveBeenCalledTimes(2);
 f.cap.parameterSchema['x-model-source'].kind='SELF_HOSTED';change();await flush();expect(document.querySelector('.studio-official-video-price')).toBeNull();
 f.cap.parameterSchema['x-model-source'].kind='API';change();await flush(310);f.runtime.auth.user=null;change();await flush();expect(document.querySelector('.studio-official-video-price')).toBeNull();
});
it('keeps unknown/range/lower-bound money honest and rejects unrelated capability responses',()=>{
 const req:OfficialVideoPriceRequest={capabilityRef:'h3-official-text-to-video-v1',capabilityVersion:'1',parameters:{},media:{imageCount:0,videoDurationsMs:[]}},q=quote(req);
 expect(validOfficialVideoPrice(q,req)).toBe(true);expect(validOfficialVideoPrice({...q,capabilityVersion:'2'},req)).toBe(false);
 for(const checkedAt of ['',null,'2026-1-2','2026-02-30','2026-11-02T00:00:00Z'])expect(validOfficialVideoPrice({...q,checkedAt},req)).toBe(false);
 for(const pricingRevision of ['',null,'   '])expect(validOfficialVideoPrice({...q,pricingRevision},req)).toBe(false);
 expect(validOfficialVideoPrice({...q,status:'UNKNOWN'},req)).toBe(false);
 expect(officialVideoPriceText({...q,status:'UNKNOWN',amount:null,currency:null})).toBe('费用未知');
 const range={...q,status:'RANGE' as const,amount:null,minimumAmount:'1.2',maximumAmount:'4.8',currency:'CNY' as const};expect(validOfficialVideoPrice(range,req)).toBe(true);expect(officialVideoPriceText(range)).toBe('¥1.20–4.80 CNY');
 expect(validOfficialVideoPrice({...range,maximumAmount:'1'},req)).toBe(false);
});
