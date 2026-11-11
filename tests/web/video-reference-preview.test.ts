// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installVideoReferencePreviews,videoReferenceAsset} from '../../apps/web/src/service/video-reference-preview';

let dispose:(()=>void)|undefined;
afterEach(()=>{dispose?.();dispose=undefined;document.body.innerHTML='';document.head.innerHTML='';vi.restoreAllMocks();vi.useRealTimers();});
const flush=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await Promise.resolve();};
function fixture(options:{complete?:boolean;width?:number;kind?:string;modal?:boolean;target?:string}={}){
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
 const kind=options.kind??'video';
 document.body.innerHTML='<div class="react-flow__node" data-id="video"><div class="'+(options.modal?'config-panel-modal-content rh-canvas-video-params':'config-panel-wrap rh-canvas-compact-input-panel rh-canvas-video-params')+'" data-testid="canvas-video-params" data-target-node-id="'+(options.target??'video')+'"><div class="reference-media-groups__item reference-media-groups__item--'+kind+'"><div class="reference-media-groups__thumb"><img class="reference-media-groups__media" src="https://studio.invalid/derived-thumbnail"><span class="reference-media-groups__label-tag">视频1</span><span class="reference-media-groups__type-badge">▶</span></div><button class="remove">移除</button></div></div></div><span id="change"></span>';
 const thumb=document.querySelector<HTMLElement>('.reference-media-groups__thumb')!,img=thumb.querySelector('img')!,state={complete:options.complete??true,width:options.width??0};
 Object.defineProperty(img,'complete',{configurable:true,get:()=>state.complete});Object.defineProperty(img,'naturalWidth',{configurable:true,get:()=>state.width});
 const item:any={url:'https://studio.invalid/original-video',nodeId:'source'},group:any={key:kind,items:[item]},binding:any={group,item,index:0},host:any={src:img.getAttribute('src'),className:'reference-media-groups__media'};
 let clearAuth=()=>{};
 const runtime:any={auth:{user:{id:'owner'},onClear:vi.fn((callback:()=>void)=>{clearAuth=callback;return()=>{};})},inspect:vi.fn(()=>({id:'project'})),storage:{encodeAsset:vi.fn((url:string)=>url==='https://studio.invalid/original-video'?'rhtv-asset:video_1':url),resolveAsset:vi.fn(async(ref:string)=>({id:ref.slice(11),kind:'VIDEO',state:'READY',downloadUrl:'https://studio.invalid/owned-video'}))},patchNode:vi.fn(),api:{requestV2:vi.fn()}};
 const props=()=>[host,binding];
 const install=()=>{dispose=installVideoReferencePreviews(runtime,props);};
 return{runtime,thumb,img,state,item,group,binding,host,props,play,install,clearAuth:()=>clearAuth()};
}
const mutate=()=>{document.querySelector('#change')!.className=String(Math.random());};
it('replaces only the failed poster with a paused owned-video preview and preserves native actions and order',async()=>{
 const f=fixture(),before=structuredClone(f.binding),clicked=vi.fn();f.thumb.parentElement!.addEventListener('click',clicked);f.install();await flush();
 const video=f.thumb.querySelector('video')!;expect(video).not.toBeNull();expect(video).toMatchObject({muted:true,defaultMuted:true,preload:'metadata',playsInline:true,controls:false,autoplay:false,tabIndex:-1});
 expect(f.runtime.storage.resolveAsset).toHaveBeenCalledExactlyOnceWith('rhtv-asset:video_1');expect(f.runtime.patchNode).not.toHaveBeenCalled();expect(f.runtime.api.requestV2).not.toHaveBeenCalled();expect(f.play).not.toHaveBeenCalled();
 expect(f.img.parentElement).toBe(f.thumb);expect(f.thumb.querySelector('.reference-media-groups__label-tag')!.textContent).toBe('视频1');expect(f.binding).toEqual(before);
 f.thumb.click();expect(clicked).toHaveBeenCalledOnce();
 Object.defineProperty(video,'readyState',{configurable:true,value:2});video.dispatchEvent(new Event('loadeddata'));expect(f.thumb.querySelector<HTMLElement>('[data-studio-video-reference-preview]')!.dataset.previewState).toBe('ready');
 mutate();await flush();expect(f.thumb.querySelectorAll('video')).toHaveLength(1);expect(f.runtime.storage.resolveAsset).toHaveBeenCalledTimes(1);
});
it.each([{complete:true,width:80},{complete:false,width:0}])('leaves healthy or still loading native images untouched: %j',async options=>{
 const f=fixture(options);f.install();await flush();expect(f.thumb.querySelector('video')).toBeNull();expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
});
it.each([{kind:'image'},{kind:'audio'},{kind:'videoFrame'},{modal:true},{target:'another-node'}])('excludes unrelated media and non-canvas surfaces: %j',async options=>{
 const f=fixture(options);f.install();await flush();expect(f.thumb.querySelector('[data-studio-video-reference-preview]')).toBeNull();expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
});
it.each(['https://catalog.invalid/unowned.mp4','plain-asset-id','rhtv-asset:../escape'])('never resolves an unowned reference %s',async ref=>{
 const f=fixture();f.item.url=ref;f.install();await flush();expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();expect(f.thumb.querySelector<HTMLElement>('[data-studio-video-reference-preview]')!.dataset.previewState).toBe('placeholder');expect(f.thumb.querySelector('video')).toBeNull();
});
it('does not trust uploading or stale host props and does not use the derived img src as a video URL',async()=>{
 const f=fixture();f.host.src='https://studio.invalid/stale-derived';f.install();await flush();expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
 expect(videoReferenceAsset(f.img,f.props,f.runtime.storage.encodeAsset)).toBeUndefined();
 f.host.src=f.img.getAttribute('src');f.item.uploading=true;mutate();await flush();expect(f.runtime.storage.resolveAsset).not.toHaveBeenCalled();
});
it.each(['image-src','item-ref','removed','project','identity','dispose'])('drops a late asset resolver after %s changes',async change=>{
 const f=fixture();let resolve!:(asset:any)=>void;f.runtime.storage.resolveAsset.mockImplementation(()=>new Promise(done=>resolve=done));f.install();await flush();expect(resolve).toBeTypeOf('function');
 if(change==='image-src')f.img.setAttribute('src','https://studio.invalid/new-thumbnail');
 if(change==='item-ref')f.item.url='https://catalog.invalid/new-item';
 if(change==='removed')f.thumb.remove();
 if(change==='project')f.runtime.inspect.mockReturnValue({id:'another-project'});
 if(change==='identity'){f.runtime.auth.user=null;f.clearAuth();}
 if(change==='dispose'){dispose!();dispose=undefined;}
 resolve({id:'video_1',kind:'VIDEO',state:'READY',downloadUrl:'https://studio.invalid/owned-video'});await flush();expect(f.thumb.querySelector('video')).toBeNull();
});
it('restores a repaired native img and clears video source/listeners on cleanup',async()=>{
 const f=fixture();f.install();await flush();const video=f.thumb.querySelector('video')!;expect(video.getAttribute('src')).toContain('owned-video');
 f.state.width=80;f.img.dispatchEvent(new Event('load'));await flush();expect(f.thumb.querySelector('[data-studio-video-reference-preview]')).toBeNull();expect(f.thumb.classList.contains('studio-video-reference-preview-host')).toBe(false);expect(video.getAttribute('src')).toBeNull();
 video.dispatchEvent(new Event('loadeddata'));expect(f.thumb.querySelector('[data-studio-video-reference-preview]')).toBeNull();
 f.state.width=0;f.img.dispatchEvent(new Event('error'));await flush();const again=f.thumb.querySelector('video')!;dispose!();dispose=undefined;expect(again.getAttribute('src')).toBeNull();expect(document.querySelector('#studio-video-reference-previews')).toBeNull();
});
it('keeps a controlled play placeholder when verified media fails to load or is not VIDEO',async()=>{
 const f=fixture();f.install();await flush();const video=f.thumb.querySelector('video')!;video.dispatchEvent(new Event('error'));expect(video.getAttribute('src')).toBeNull();expect(f.thumb.querySelector('video')).toBeNull();expect(f.thumb.querySelector<HTMLElement>('[data-studio-video-reference-preview]')!.dataset.previewState).toBe('placeholder');
 mutate();await flush();expect(f.runtime.storage.resolveAsset).toHaveBeenCalledTimes(1);
});
it.each([
 {id:'video_1',kind:'IMAGE',state:'READY',downloadUrl:'https://studio.invalid/owned-image'},
 {id:'different_asset',kind:'VIDEO',state:'READY',downloadUrl:'https://studio.invalid/other-video'},
 {id:'video_1',kind:'VIDEO',state:'PROCESSING',downloadUrl:'https://studio.invalid/pending-video'},
 {id:'video_1',kind:'VIDEO',state:'READY',downloadUrl:'javascript:alert(1)'},
])('never inserts unverified media metadata: %j',async asset=>{
 const f=fixture();f.runtime.storage.resolveAsset.mockResolvedValue(asset);f.install();await flush();expect(f.thumb.querySelector('video')).toBeNull();expect(f.thumb.querySelector<HTMLElement>('[data-studio-video-reference-preview]')!.dataset.previewState).toBe('placeholder');
});
