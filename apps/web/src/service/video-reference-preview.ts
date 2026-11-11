const ownedAsset=/^rhtv-asset:[A-Za-z0-9_-]{1,200}$/;
const composer='.config-panel-wrap.rh-canvas-compact-input-panel.rh-canvas-video-params[data-testid="canvas-video-params"][data-target-node-id]';
const selector=composer+' .reference-media-groups__item--video .reference-media-groups__thumb';
const fallbackClass='studio-video-reference-preview-host';

/** Original item URL comes from the exact VIDEO chip's public native props,
 * never from its derived image-thumbnail URL. Stale host props fail closed. */
export function videoReferenceAsset(img:HTMLImageElement,propsOf:(element:Element)=>any[],encode:(url:string)=>string){
 const props=propsOf(img),host=props.find(p=>typeof p?.src==='string'&&String(p.className??'').split(/\s+/).includes('reference-media-groups__media'));
 if(!host||host.src!==img.getAttribute('src'))return;
 for(const row of props){
  if(row?.group?.key!=='video'||!Number.isSafeInteger(row.index)||row.index<0||row.item?.uploading===true||typeof row.item?.url!=='string')continue;
  if(Array.isArray(row.group.items)&&row.group.items[row.index]!==row.item)continue;
  try{const ref=encode(row.item.url);if(ownedAsset.test(ref))return{ref,index:row.index};}catch{}
 }
}

function mediaURL(value:unknown,doc:Document){
 if(typeof value!=='string'||!value)return;
 try{const url=new URL(value,doc.baseURI);if(url.username||url.password)return;if(url.protocol==='https:'||url.protocol==='http:'&&url.origin===new URL(doc.baseURI).origin)return url.href;}catch{}
}

/** Cosmetic owned seam only. No canvas patch, upload, catalog materialization
 * or generation call; original media, ordering, labels and parent actions stay
 * native. Resolve only an already-owned STUDIO video when its image poster failed. */
export function installVideoReferencePreviews(runtime:any,propsOf:(element:Element)=>any[],doc:Document=document){
 type Row={thumb:HTMLElement;img:HTMLImageElement;src:string;failed:boolean;signature:string;turn:number;box?:HTMLElement;stopVideo?:()=>void;unwatch:()=>void};
 const rows=new Map<HTMLElement,Row>();let disposed=false,queued=false,identity='',epoch=0;
 const style=doc.createElement('style');style.id='studio-video-reference-previews';style.textContent=videoReferencePreviewStyles;doc.head.append(style);
 const scope=()=>runtime.auth?.user?String(runtime.auth.user.id)+':'+String(runtime.inspect?.().id??''):'';
 const owner=(thumb:HTMLElement)=>{const panel=thumb.closest<HTMLElement>(composer),node=panel?.closest('.react-flow__node[data-id]');if(!panel||!node||node.getAttribute('data-id')!==panel.getAttribute('data-target-node-id'))return;const css=doc.defaultView?.getComputedStyle(panel);if(css?.display==='none'||css?.visibility==='hidden'||panel.closest('[hidden]'))return;return panel.getAttribute('data-target-node-id')??undefined;};
 const clearPreview=(row:Row)=>{row.turn++;row.stopVideo?.();row.stopVideo=undefined;row.box?.remove();row.box=undefined;row.thumb.classList.remove(fallbackClass);row.signature='';};
 const remove=(row:Row)=>{clearPreview(row);row.unwatch();rows.delete(row.thumb);};
 const clear=()=>{for(const row of [...rows.values()])remove(row);};
 const binding=(row:Row)=>videoReferenceAsset(row.img,propsOf,(url:string)=>runtime.storage?.encodeAsset?.(url)??url);
 const placeholder=(row:Row)=>{
  const box=doc.createElement('span');box.className='studio-video-reference-preview';box.setAttribute('data-studio-video-reference-preview','');box.setAttribute('aria-hidden','true');box.dataset.previewState='placeholder';
  const play=doc.createElementNS('http://www.w3.org/2000/svg','svg');play.setAttribute('viewBox','0 0 24 24');play.setAttribute('class','studio-video-reference-preview__play');play.setAttribute('aria-hidden','true');const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M9 6.5 17 12l-8 5.5Z');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.5');path.setAttribute('stroke-linejoin','round');play.append(path);box.append(play);
  row.thumb.classList.add(fallbackClass);row.thumb.insertBefore(box,row.img);row.box=box;return box;
 };
 const start=(row:Row,ref:string|undefined,signature:string)=>{
  clearPreview(row);row.signature=signature;const box=placeholder(row),turn=row.turn,generation=epoch,expectedScope=scope(),expectedOwner=owner(row.thumb),src=row.src;
  const current=()=>!disposed&&epoch===generation&&scope()===expectedScope&&owner(row.thumb)===expectedOwner&&rows.get(row.thumb)===row&&row.turn===turn&&row.box===box&&row.thumb.isConnected&&row.img.isConnected&&row.img.parentElement===row.thumb&&row.img.getAttribute('src')===src&&(!row.img.complete||row.img.naturalWidth===0)&&binding(row)?.ref===ref;
  if(!ref||typeof runtime.storage?.resolveAsset!=='function')return;
  void runtime.storage.resolveAsset(ref).then((asset:any)=>{
   if(!current()||asset?.id!==ref.slice(11)||asset.kind!=='VIDEO'||asset.state!=='READY')return;
   const url=mediaURL(asset.downloadUrl??asset.previewUrl,doc);if(!url)return;
   const video=doc.createElement('video');video.className='reference-media-groups__media studio-video-reference-preview__video';video.muted=true;video.defaultMuted=true;video.preload='metadata';video.playsInline=true;video.controls=false;video.autoplay=false;video.tabIndex=-1;video.setAttribute('aria-hidden','true');video.setAttribute('playsinline','');video.setAttribute('muted','');video.disablePictureInPicture=true;
   let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;
   const stop=()=>{if(stopped)return;stopped=true;clearTimeout(timer);video.removeEventListener('loadedmetadata',metadata);video.removeEventListener('loadeddata',ready);video.removeEventListener('seeked',ready);video.removeEventListener('error',failed);video.removeAttribute('src');try{video.load();}catch{}video.remove();};
   const failed=()=>{if(current())box.dataset.previewState='placeholder';stop();};
   const ready=()=>{if(!current()){stop();return;}if(video.readyState>=2){box.dataset.previewState='ready';clearTimeout(timer);}};
   const metadata=()=>{if(!current()){stop();return;}try{if(Number.isFinite(video.duration)&&video.duration>0)video.currentTime=Math.min(0.001,video.duration/2);}catch{}ready();};
   video.addEventListener('loadedmetadata',metadata);video.addEventListener('loadeddata',ready);video.addEventListener('seeked',ready);video.addEventListener('error',failed);row.stopVideo=stop;box.dataset.previewState='loading';box.insertBefore(video,box.firstChild);timer=setTimeout(failed,8000);video.src=url;
  }).catch(()=>{}); // A failed preview leaves a controlled VIDEO placeholder.
 };
 const refresh=()=>{
  if(disposed||queued)return;queued=true;queueMicrotask(()=>{
   queued=false;if(disposed)return;
   const next=scope();if(next!==identity){identity=next;epoch++;clear();}
   if(!next){clear();return;}
   const live=new Set<HTMLElement>();
   for(const thumb of doc.querySelectorAll<HTMLElement>(selector)){
    const target=owner(thumb);if(!target)continue;
    const img=thumb.querySelector<HTMLImageElement>(':scope > img.reference-media-groups__media');if(!img)continue;live.add(thumb);
    let row=rows.get(thumb);
    if(row&&row.img!==img){remove(row);row=undefined;}
    if(!row){
     const state:Row={thumb,img,src:img.getAttribute('src')??'',failed:img.complete&&img.naturalWidth===0,signature:'',turn:0,unwatch:()=>{}};
     const error=()=>{state.failed=true;refresh();},loaded=()=>{state.failed=img.naturalWidth===0;refresh();};img.addEventListener('error',error);img.addEventListener('load',loaded);state.unwatch=()=>{img.removeEventListener('error',error);img.removeEventListener('load',loaded);};rows.set(thumb,state);row=state;
    }
    const src=img.getAttribute('src')??'';if(src!==row.src){clearPreview(row);row.src=src;row.failed=img.complete&&img.naturalWidth===0;}
    if(img.complete&&img.naturalWidth>0){if(row.box)clearPreview(row);row.failed=false;continue;}
    if(!row.failed&&!(img.complete&&img.naturalWidth===0))continue;
    const asset=binding(row),signature=JSON.stringify([next,target,src,asset?.ref??null,asset?.index??null]);
    if(!row.box||row.signature!==signature)start(row,asset?.ref,signature);
   }
   for(const [thumb,row]of rows)if(!live.has(thumb)||!thumb.isConnected)remove(row);
  });
 };
 const observer=new MutationObserver(records=>{if(records.every(record=>record.target instanceof Element&&record.target.closest('[data-studio-video-reference-preview]')))return;refresh();});observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['src','class','style','data-id','data-testid','data-target-node-id']});
 const release=runtime.auth?.onClear?.(()=>{epoch++;identity='';clear();});refresh();
 return()=>{disposed=true;epoch++;observer.disconnect();release?.();clear();style.remove();};
}

export const videoReferencePreviewStyles=`
 .reference-media-groups__thumb.studio-video-reference-preview-host>img.reference-media-groups__media{opacity:0}
 .studio-video-reference-preview{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:inherit;background:var(--canvas-bg-tertiary,#29292c);color:var(--canvas-text-secondary,#b8b8bd);pointer-events:none;user-select:none}
 .studio-video-reference-preview__video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none}
 .studio-video-reference-preview[data-preview-state=loading] .studio-video-reference-preview__video{opacity:0}
 .studio-video-reference-preview__play{width:20px;height:20px;pointer-events:none}
 .studio-video-reference-preview[data-preview-state=ready] .studio-video-reference-preview__play,.studio-video-reference-preview-host:has(>.reference-media-groups__type-badge) .studio-video-reference-preview__play{display:none}
`;
