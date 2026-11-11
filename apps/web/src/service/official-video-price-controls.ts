import {ApiError} from '../api/client';
import type {Capability} from './model-catalog';
import {videoParameters} from './video-input';
import {nativeVideoReferences} from './video-command';
import {credentialsChangedEvent} from './model-provider-credentials';

export interface OfficialVideoPrice {
 schemaVersion:'1';capabilityRef:string;capabilityVersion:string;status:'ESTIMATE'|'RANGE'|'LOWER_BOUND'|'UNKNOWN';
 currency:'CNY'|'USD'|null;amount:string|null;minimumAmount:string|null;maximumAmount:string|null;
 providerRef:string;region:string;pricingRevision:string;checkedAt:string;basis:string[];warnings:string[];sources:{title:string;url:string}[];
}
export interface OfficialVideoPriceRequest {capabilityRef:string;capabilityVersion:string;parameters:Record<string,unknown>;media:{imageCount:number;videoDurationsMs:(number|null)[]}}
const providers=new Set(['minimax-official','volcengine-official']);
export function isOfficialVideoPriceCapability(cap:Capability|undefined){return cap?.testMode===false&&providers.has(cap.model?.providerRef??'')&&cap.outputKinds?.includes('VIDEO')&&cap.parameterSchema?.['x-model-source']?.kind==='API';}
const validMoney=(n:unknown):n is string=>typeof n==='string'&&/^(0|[1-9]\d{0,15})(\.\d{1,6})?$/.test(n);
function validPriceDate(value:unknown):value is string {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T00:00:00.000Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
export function validOfficialVideoPrice(q:any,request:OfficialVideoPriceRequest):q is OfficialVideoPrice {
 if(q?.schemaVersion!=='1'||q.capabilityRef!==request.capabilityRef||q.capabilityVersion!==request.capabilityVersion||!Array.isArray(q.basis)||!Array.isArray(q.warnings)||!Array.isArray(q.sources))return false;
 if(!validPriceDate(q.checkedAt)||typeof q.pricingRevision!=='string'||!q.pricingRevision.trim()||q.pricingRevision.length>200)return false;
 if(![...q.basis,...q.warnings].every(value=>typeof value==='string'&&value.length<=2000)||!q.sources.every((source:any)=>typeof source?.title==='string'&&source.title.length<=200&&typeof source.url==='string'&&/^https:\/\//.test(source.url)))return false;
 if(q.status==='UNKNOWN')return q.amount===null&&q.minimumAmount===null&&q.maximumAmount===null&&q.currency===null;
 if(!['CNY','USD'].includes(q.currency)||!providers.has(q.providerRef))return false;
 if(q.status==='ESTIMATE')return validMoney(q.amount)&&q.minimumAmount===null&&q.maximumAmount===null;
 if(q.status==='LOWER_BOUND')return q.amount===null&&validMoney(q.minimumAmount)&&q.maximumAmount===null;
 return q.status==='RANGE'&&q.amount===null&&validMoney(q.minimumAmount)&&validMoney(q.maximumAmount)&&Number(q.minimumAmount)<=Number(q.maximumAmount);
}
export function officialVideoPriceText(q:OfficialVideoPrice){
 if(q.status==='UNKNOWN')return '费用未知';
 const value=(amount:string)=>new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(amount));
 const unit=q.currency==='CNY'?'¥':'US$';
 if(q.status==='ESTIMATE')return unit+value(q.amount!)+' '+q.currency;
 if(q.status==='RANGE')return unit+value(q.minimumAmount!)+'–'+value(q.maximumAmount!)+' '+q.currency;
 return unit+value(q.minimumAmount!)+' '+q.currency+' 起';
}

function encodedGraph(graph:any,encode:(value:string)=>string){
 const map=(value:any):any=>typeof value==='string'?encode(value):Array.isArray(value)?value.map(map):value;
 return{...graph,nodes:graph.nodes.map((node:any)=>{
  const data=node.data??{},params=data.params??{},next={...data,params:{...params}};
  for(const kind of ['image','video','audio']){const key=kind+'Url';if(Object.hasOwn(data,key))next[key]=map(data[key]);if(Object.hasOwn(params,key+'s'))next.params[key+'s']=map(params[key+'s']);}
  if(Object.hasOwn(data,'sourceObjects'))next.sourceObjects=map(data.sourceObjects);
  if(data.output)next.output=Array.isArray(data.output)?data.output.map((out:any)=>typeof out==='string'?map(out):out&&typeof out==='object'?{...out,url:map(out.url)}:out):typeof data.output==='string'?map(data.output):{...data.output,url:map(data.output.url)};
  return{...node,data:next};
 })};
}

/** Decorate the existing composer, without mutating nodes, selecting models,
 * validating Keys, materializing catalog media or creating tasks. */
export function installOfficialVideoPriceControls(runtime:any,native:any,propsOf:(element:Element)=>any[],doc:Document=document){
 const view=doc.defaultView;if(!view)return()=>{};
 const style=doc.createElement('style');style.id='studio-official-video-prices';style.textContent=officialVideoPriceStyles;doc.head.append(style);
 type Row={box:HTMLElement;signature:string;timer?:ReturnType<typeof setTimeout>;controller?:AbortController;version:number};
 const rows=new Map<HTMLElement,Row>(),durations=new Map<string,{value:number|null}>();
 const loaders=new Set<()=>void>();let disposed=false,queued=false,identity='',epoch=0,catalog:Capability[]=[],credentialRevision=0;
 const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
 const mount=(panel:HTMLElement,box:HTMLElement)=>{const host=panel.querySelector('.config-panel-wrap__basic')??panel,actions=[...host.children].find(child=>child.classList.contains('config-row'));host.insertBefore(box,actions??null);};
 const cancel=(row:Row)=>{clearTimeout(row.timer);row.controller?.abort();row.controller=undefined;row.version++;};
 const clear=()=>{for(const row of rows.values()){cancel(row);row.box.remove();}rows.clear();for(const release of [...loaders])release();loaders.clear();durations.clear();};
 const duration=(ref:string,graph:any)=>{
  const uploaded=graph.nodes.find((source:any)=>{
   if(source.type!=='rh-video')return false;const data=source.data??{};
   const references=Array.isArray(data.sourceObjects)?data.sourceObjects:typeof data.sourceObjects==='string'?[data.sourceObjects]:[];
   const output=data.output,hasOutput=Array.isArray(output)?output.length>0:!!output;
   // Native uploads do not always carry isUpload. Source metadata belongs only
   // to a single matching uploaded asset, never to a generated/history result
   // or to a node carrying an old duration alongside a newer output.
   const hasGeneration=['modelCode','capabilityRef','capabilityVersion','taskId','estimateTaskId','executionId','historyStorage','selectedOutputHistoryId','selectedHistoryOutputId','generationStartedAt','routerParameters'].some(key=>!!data[key]);
   if(hasGeneration||hasOutput||Array.isArray(data.nodeOutputHistory)&&data.nodeOutputHistory.length>0)return false;
   return references.length===1&&references[0]===ref&&(data.isUpload===true||data.isUpload===undefined);
  });
  const seconds=uploaded?.data?.duration,knownMS=typeof seconds==='number'?Math.round(seconds*1000):NaN;
  if(Number.isSafeInteger(knownMS)&&knownMS>0)return knownMS;
  const known=durations.get(ref);if(known)return known.value;
  const record={value:null as number|null};durations.set(ref,record);const generation=epoch;
  // Only already owned STUDIO assets may be read. Resolving arbitrary catalog
  // URLs can materialize assets, a mutation inappropriate for a price preview.
  if(!ref.startsWith('rhtv-asset:')||typeof runtime.storage?.resolveAsset!=='function')return null;
  void runtime.storage.resolveAsset(ref).then((asset:any)=>{
   if(disposed||generation!==epoch||asset?.kind!=='VIDEO')return;
   const direct=asset.durationMs??asset.metadata?.durationMs;
   if(Number.isSafeInteger(direct)&&direct>0){record.value=direct;refresh();return;}
   const url=asset.downloadUrl??asset.previewUrl;if(typeof url!=='string'||!url)return;
   const media=doc.createElement('video');media.preload='metadata';media.muted=true;let done=false;
   const release=()=>{if(done)return;done=true;clearTimeout(timeout);media.removeEventListener('loadedmetadata',loaded);media.removeEventListener('error',release);media.removeAttribute('src');try{media.load();}catch{}loaders.delete(release);};
   const loaded=()=>{const ms=Math.round(media.duration*1000);if(!disposed&&generation===epoch&&Number.isSafeInteger(ms)&&ms>0){record.value=ms;refresh();}release();};
   const timeout=setTimeout(release,8000);loaders.add(release);media.addEventListener('loadedmetadata',loaded,{once:true});media.addEventListener('error',release,{once:true});media.src=url;
  }).catch(()=>{});return null;
 };
 const paint=(row:Row,state:'loading'|'unknown'|'error'|OfficialVideoPrice,message?:string)=>{
  const open=row.box.querySelector('details')?.open??false;
  row.box.replaceChildren();const heading=node('div',undefined,'studio-video-price-heading'),label=node('span','预估厂商费用'),amount=node('span',typeof state==='string'?(state==='loading'?'估算中…':'费用未知'):officialVideoPriceText(state),'studio-video-price-amount');
  amount.setAttribute('role','status');amount.setAttribute('aria-live','polite');heading.append(label,amount);row.box.append(heading);
  row.box.dataset.priceStatus=typeof state==='string'?state.toUpperCase():state.status;
  const hint=typeof state==='string'?message??'请等待当前型号和素材就绪后查看费用。':state.status==='LOWER_BOUND'?'仅含已知计费部分，实际可能更高。':state.status==='RANGE'?'自动比例或智能时长尚未确定，当前为估算范围。':state.status==='UNKNOWN'?'当前费用未知，不能视为免费。':'按公开单价估算，以厂商实际账单为准。';
  row.box.append(node('p',hint,'studio-video-price-hint'));
  if(typeof state!=='string'){
   const regionWarning=state.warnings.find(text=>text.includes('地区未确认'));if(regionWarning)row.box.append(node('p',regionWarning,'studio-video-price-hint'));
   const details=node('details'),summary=node('summary','计费规则与来源');details.open=open;
   const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');svg.innerHTML='<path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';summary.append(svg);details.append(summary);
   details.append(node('p','公开价格核对日期：'+state.checkedAt));
   for(const text of [...state.basis,...state.warnings])details.append(node('p',text));
   for(const source of state.sources){const link=node('a',source.title);link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';details.append(link);}
   row.box.append(details);
  }
 };
 const refresh=()=>{
  if(queued||disposed)return;queued=true;queueMicrotask(()=>{
   queued=false;if(disposed)return;
   const key=runtime.auth?.user?String(runtime.auth.user.id)+':'+String(runtime.inspect?.().id??''):'';
   if(key!==identity){identity=key;epoch++;catalog=[];clear();const generation=epoch;if(key&&typeof runtime.execution?.catalog==='function')void runtime.execution.catalog().then((caps:Capability[])=>{if(!disposed&&generation===epoch){catalog=caps;refresh();}}).catch(()=>{});}
   if(!key){clear();return;}
   const graph=native.bt?.()?.getRemoteData?.();if(!Array.isArray(graph?.nodes)||!Array.isArray(graph?.edges)){clear();return;}
   const safe=encodedGraph(graph,(value:string)=>runtime.storage?.encodeAsset?.(value)??value),live=new Set<HTMLElement>();
   for(const panel of doc.querySelectorAll<HTMLElement>('.rh-canvas-video-params[data-target-node-id]')){
    const target=panel.getAttribute('data-target-node-id'),raw=safe.nodes.find((n:any)=>n.id===target),bound=raw&&runtime.modelBindingPort?.()?.node(raw)||raw;if(bound?.type!=='rh-video'||bound.data?.isUpload===true)continue;
    const button=panel.querySelector('.generate-action-button'),action=button?propsOf(button).find(p=>p.currentModel&&p.params):undefined,selected=action?.currentModel;
    const ref=bound.data?.capabilityRef??bound.data?.modelCode,version=bound.data?.capabilityVersion??(selected?.capabilityRef===ref?selected.capabilityVersion:undefined),cap=catalog.find(cap=>cap.capabilityRef===ref&&cap.version===version);
    if(!isOfficialVideoPriceCapability(cap))continue;
    live.add(panel);let row=rows.get(panel);
    if(!row){const box=node('section',undefined,'studio-official-video-price nodrag nopan nowheel');box.setAttribute('aria-label','本次官方 API 视频费用估算');for(const event of ['pointerdown','mousedown','click','keydown','keyup'])box.addEventListener(event,e=>{if(!(e instanceof KeyboardEvent)||e.key!=='Escape')e.stopPropagation();});mount(panel,box);row={box,signature:'',version:0};rows.set(panel,row);}
    if(!row.box.isConnected)mount(panel,row.box);
    let request:OfficialVideoPriceRequest|undefined,reason='';
    const images=nativeVideoReferences(bound,safe,'image'),videos=nativeVideoReferences(bound,safe,'video');
    if(images===undefined||videos===undefined)reason='参考素材尚未就绪，费用未知；请完成上传或确认历史素材版本。';
    else if(selected&&selected.capabilityRef!==ref)reason='模型选择正在更新，请稍候。';
    else try{request={capabilityRef:cap!.capabilityRef,capabilityVersion:cap!.version,parameters:videoParameters(cap!,action?.params??bound.data.params??{}),media:{imageCount:images.length,videoDurationsMs:videos.map(ref=>duration(ref,safe))}};}catch{reason='当前参数不属于所选模型，请重新选择支持的规格。';}
    const signature=JSON.stringify([key,target,credentialRevision,request??reason]);if(signature===row.signature)continue;row.signature=signature;cancel(row);
    if(!request){paint(row,'unknown',reason);continue;}
    paint(row,'loading','费用按当前规格和实际参考素材估算。');const requestRow=row,revision=row.version,generation=epoch,body=request;
    row.timer=setTimeout(async()=>{
     const controller=new AbortController();requestRow.controller=controller;
     try{
      const result=await runtime.api.requestV2('/model-price-estimates',{method:'POST',body,cache:'no-store',signal:controller.signal});
      if(disposed||generation!==epoch||revision!==requestRow.version||controller.signal.aborted||!requestRow.box.isConnected)return;
      if(!validOfficialVideoPrice(result.data,body))throw new Error('Invalid price estimate');
      paint(requestRow,result.data);
     }catch(error){
      if(disposed||generation!==epoch||revision!==requestRow.version||controller.signal.aborted||!requestRow.box.isConnected)return;
      paint(requestRow,'error',error instanceof ApiError&&error.code==='PRICE_ESTIMATE_INVALID'?'当前规格或素材不符合模型要求，请调整后查看费用。':'暂时无法估算费用，请调整参数后重试；当前费用未知。');
     }
    },300);
   }
   for(const [panel,row]of rows)if(!live.has(panel)||!panel.isConnected){cancel(row);row.box.remove();rows.delete(panel);}
  });
 };
 const observer=new MutationObserver(records=>{if(records.every(record=>record.target instanceof Element&&record.target.closest('.studio-official-video-price')))return;refresh();});observer.observe(doc.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','src','data-target-node-id','aria-pressed','value']});
 const credentialsChanged=()=>{credentialRevision++;identity='';refresh();};view.addEventListener(credentialsChangedEvent,credentialsChanged);const release=runtime.auth.onClear?.(()=>{identity='';epoch++;clear();refresh();});refresh();
 return()=>{disposed=true;epoch++;observer.disconnect();view.removeEventListener(credentialsChangedEvent,credentialsChanged);release?.();clear();style.remove();};
}

export const officialVideoPriceStyles=`
 .studio-official-video-price{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;margin:10px 0 0;padding:12px 20px 2px;border-top:1px solid var(--canvas-border-default,#3a3a3a);color:var(--canvas-text-secondary,#b8b8bd);font:inherit;font-size:11px;line-height:1.55;text-align:left}
 .studio-video-price-heading{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;font-size:12px}
 .studio-video-price-amount{color:var(--canvas-text-primary,#e5e5e5);font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
 .studio-official-video-price p{margin:6px 0 0;font-size:11px;line-height:1.55;overflow-wrap:anywhere}
 .studio-official-video-price details{margin-top:8px}
 .studio-official-video-price summary{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px;padding:2px 0;cursor:pointer;list-style:none;color:var(--canvas-text-primary,#e5e5e5)}
 .studio-official-video-price summary::-webkit-details-marker{display:none}
 .studio-official-video-price summary svg{width:14px;height:14px;flex:0 0 auto;transition:transform .15s ease}
 .studio-official-video-price details[open] summary svg{transform:rotate(90deg)}
 .studio-official-video-price a{display:block;width:fit-content;max-width:100%;margin-top:7px;color:#c4cded;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
 .studio-official-video-price a:hover{color:#e5e9fa}
 .studio-official-video-price summary:hover{color:#fff}
 .studio-official-video-price :is(summary,a):focus-visible{outline:2px solid #b7c8ff;outline-offset:2px;border-radius:2px}
 .studio-official-video-price[data-price-status=LOADING] .studio-video-price-amount{color:var(--canvas-text-secondary,#b8b8bd);font-weight:400}
 @media(prefers-reduced-motion:reduce){.studio-official-video-price summary svg{transition:none}}
`;
