import {afterEach,beforeEach,expect,it,vi} from 'vitest';

const {compatibility,featureUi,brand,modelSelectors,navigation,disconnectPolicy,disconnectBrand,disconnectSelectors,disconnectNavigation}=vi.hoisted(()=>({compatibility:vi.fn(),featureUi:vi.fn(),brand:vi.fn(),modelSelectors:vi.fn(),navigation:vi.fn(),disconnectPolicy:vi.fn(),disconnectBrand:vi.fn(),disconnectSelectors:vi.fn(),disconnectNavigation:vi.fn()}));
vi.mock('../../apps/web/src/browser-compat',()=>({installBrowserCompatibility:compatibility}));
vi.mock('../../apps/web/src/features/internal-ui',()=>({installFeatureUi:featureUi}));
vi.mock('../../apps/web/src/brand/install',()=>({installStudioBrand:brand}));
vi.mock('../../apps/web/src/service/model-selectors',()=>({installModelSelectors:modelSelectors}));
vi.mock('../../apps/web/src/service/navigation',()=>({installStudioNavigation:navigation,embeddedEditorURL:(source:string,origin:string)=>source===origin+'/labs/rhhyperframes'?source+'/':undefined}));

beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();navigation.mockReturnValue(disconnectNavigation);brand.mockReturnValue({disconnect:disconnectBrand});modelSelectors.mockReturnValue(disconnectSelectors);
 featureUi.mockImplementation(()=>{if(!document.body)throw new Error('feature UI requires body');document.body.setAttribute('data-rhtv-billing','false');document.head.append({id:'rhtv-feature-styles'});return{disconnect:disconnectPolicy};});
});
afterEach(()=>vi.unstubAllGlobals());

function environment(ready=false){
 class MemoryStorage {values=new Map<string,string>();getItem(key:string){return this.values.get(key)??null;}setItem(key:string,value:string){this.values.set(key,String(value));}removeItem(key:string){this.values.delete(key);}}
 class FrameDocument extends EventTarget {body:any=null;head={append:vi.fn()};readyState='loading';baseURI='https://studio.invalid/labs/rhhyperframes/';cookies='';get cookie(){return this.cookies;}set cookie(value:string){this.cookies=value;}}
 const body={setAttribute:vi.fn(),querySelectorAll:vi.fn(()=>[])},doc=new FrameDocument();if(ready)doc.body=body;
 const stored=new MemoryStorage(),hostStorage=new MemoryStorage();hostStorage.setItem('Rh-Accesstoken','memory-session');
 const runtime={mode:'service',api:{features:{billing:false,community:false,publicSharing:false,marketing:false,externalLinks:false}},auth:{user:{displayName:'维护者'}},notice:vi.fn(),studio:{hydratePreview:vi.fn().mockResolvedValue(undefined)}};
 const host:any={__RHTV_PREVIEW__:runtime,localStorage:hostStorage,document:{cookie:'userId=current'},fetch:vi.fn().mockResolvedValue(new Response(JSON.stringify({code:0,data:{projects:[{id:'persisted-hf-project'}]}}))),XMLHttpRequest:class HostXHR{},WebSocket:class HostSocket{},EventSource:class HostEvents{}};host.parent=host;
 const surface:any=new EventTarget(),nativeFetch=vi.fn().mockResolvedValue(new Response('native asset'));Object.assign(surface,{parent:host,fetch:nativeFetch});
 const observations:any[]=[];
 class Observer {callback:any;observe=vi.fn((target:any)=>{if(!target)throw new Error('observer requires body');});disconnect=vi.fn();constructor(callback:any){this.callback=callback;observations.push(this);}}
 vi.stubGlobal('window',surface);vi.stubGlobal('document',doc);vi.stubGlobal('Document',FrameDocument);vi.stubGlobal('Storage',MemoryStorage);vi.stubGlobal('localStorage',stored);vi.stubGlobal('navigator',{});vi.stubGlobal('MutationObserver',Observer);vi.stubGlobal('location',{origin:'https://studio.invalid',href:doc.baseURI});
 return{body,doc,stored,hostStorage,runtime,host,surface,nativeFetch,observations};
}

it('installs service interception from the head before body exists, then installs feature UI and preview hooks after body readiness',async()=>{
 const frame=environment();await import('../../apps/web/src/runtime/frame-runtime.js');
 expect(featureUi).not.toHaveBeenCalled();expect(brand).not.toHaveBeenCalled();expect(navigation).not.toHaveBeenCalled();expect(frame.observations).toHaveLength(0);
 expect(frame.surface.XMLHttpRequest).toBe(frame.host.XMLHttpRequest);expect(frame.surface.WebSocket).toBe(frame.host.WebSocket);expect(frame.surface.EventSource).toBe(frame.host.EventSource);
 expect(await(await frame.surface.fetch('/canvas/hf/projects')).json()).toMatchObject({data:{projects:[{id:'persisted-hf-project'}]}});expect(frame.host.fetch).toHaveBeenCalledWith('/canvas/hf/projects',{});
 await frame.surface.fetch('/studio-api/projects/p/files/index.html',{method:'PUT',body:'actual source'});expect(frame.host.fetch).toHaveBeenCalledWith('/studio-api/projects/p/files/index.html',{method:'PUT',body:'actual source'});
 expect(localStorage.getItem('Rh-Accesstoken')).toBe('memory-session');localStorage.setItem('Rh-Accesstoken','must-not-persist');expect(frame.stored.values.has('Rh-Accesstoken')).toBe(false);document.cookie='Rh-Accesstoken=must-not-persist';expect(frame.doc.cookies).toBe('');
 frame.doc.body=frame.body;frame.doc.dispatchEvent(new Event('DOMContentLoaded'));
 expect(featureUi).toHaveBeenCalledOnce();expect(featureUi).toHaveBeenCalledWith(frame.runtime.api.features,expect.any(Function));expect(frame.body.setAttribute).toHaveBeenCalledWith('data-rhtv-billing','false');expect(frame.doc.head.append).toHaveBeenCalledWith({id:'rhtv-feature-styles'});expect(frame.observations[0].observe).toHaveBeenCalledWith(frame.body,expect.objectContaining({subtree:true}));
 expect(brand).toHaveBeenCalledWith({frames:true,displayName:expect.any(Function)});expect(brand.mock.calls[0][0].displayName()).toBe('维护者');
 expect(modelSelectors).not.toHaveBeenCalled();
 frame.doc.dispatchEvent(new Event('DOMContentLoaded'));expect(featureUi).toHaveBeenCalledOnce();expect(modelSelectors).not.toHaveBeenCalled();frame.surface.dispatchEvent(new Event('pagehide'));expect(frame.observations[0].disconnect).toHaveBeenCalledOnce();expect(disconnectPolicy).toHaveBeenCalledOnce();expect(disconnectBrand).toHaveBeenCalledOnce();expect(disconnectSelectors).not.toHaveBeenCalled();expect(disconnectNavigation).toHaveBeenCalledOnce();
});

it('hydrates already parsed preview nodes when body is available and finds the real runtime through intermediate frames',async()=>{
 const frame=environment(true),element={tagName:'IFRAME',src:'https://studio.invalid/labs/rhhyperframes'};frame.body.querySelectorAll.mockReturnValue([element] as any);frame.surface.parent={parent:frame.host};await import('../../apps/web/src/runtime/frame-runtime.js');
 expect(featureUi).toHaveBeenCalledOnce();expect(element.src).toBe('https://studio.invalid/labs/rhhyperframes/');expect(frame.runtime.studio.hydratePreview).toHaveBeenCalledWith(element);await frame.surface.fetch('/canvas/hf/projects');expect(frame.host.fetch).toHaveBeenCalledOnce();
});

it('does not install deferred DOM hooks when the frame unloads before its body is ready',async()=>{
 const frame=environment();await import('../../apps/web/src/runtime/frame-runtime.js');frame.surface.dispatchEvent(new Event('pagehide'));frame.doc.body=frame.body;frame.doc.dispatchEvent(new Event('DOMContentLoaded'));
 expect(featureUi).not.toHaveBeenCalled();expect(brand).not.toHaveBeenCalled();expect(navigation).not.toHaveBeenCalled();expect(frame.observations).toHaveLength(0);
});

it('applies branding and internal billing presentation in preview frames without installing service data hooks',async()=>{
 const frame=environment(true);frame.runtime.mode='preview';await import('../../apps/web/src/runtime/frame-runtime.js');
 expect(brand).toHaveBeenCalledOnce();expect(featureUi).toHaveBeenCalledOnce();expect(modelSelectors).not.toHaveBeenCalled();expect(navigation).not.toHaveBeenCalled();expect(frame.runtime.studio.hydratePreview).not.toHaveBeenCalled();expect(frame.observations).toHaveLength(0);
 frame.surface.dispatchEvent(new Event('pagehide'));expect(disconnectBrand).toHaveBeenCalledOnce();expect(disconnectPolicy).toHaveBeenCalledOnce();
});

it.each([['standalone',true],['embedded',false]])('keeps a generated work outside the exact native app routes untouched (%s)',async(_label,direct)=>{
 const frame=environment(true);frame.doc.baseURI='https://studio.invalid/labs/rhhyperframes/';vi.stubGlobal('location',{origin:'https://studio.invalid',href:'https://studio.invalid/api/v2/studio/preview/signed/project/index.html'});if(direct)frame.surface.parent=frame.surface;
 await import('../../apps/web/src/runtime/frame-runtime.js');expect(compatibility).not.toHaveBeenCalled();expect(brand).not.toHaveBeenCalled();expect(featureUi).not.toHaveBeenCalled();expect(modelSelectors).not.toHaveBeenCalled();expect(navigation).not.toHaveBeenCalled();expect(frame.surface.fetch).toBe(frame.nativeFetch);expect(frame.observations).toHaveLength(0);expect(frame.stored.values.size).toBe(0);
});

it('brands a directly opened native editor without inventing a host session or changing its native transport',async()=>{
 const frame=environment();frame.surface.parent=frame.surface;await import('../../apps/web/src/runtime/frame-runtime.js');
 expect(brand).not.toHaveBeenCalled();expect(frame.surface.fetch).toBe(frame.nativeFetch);expect(frame.surface.XMLHttpRequest).toBeUndefined();
 frame.doc.body=frame.body;frame.doc.dispatchEvent(new Event('DOMContentLoaded'));expect(brand).toHaveBeenCalledWith({frames:true});expect(featureUi).toHaveBeenCalledWith({billing:false,community:false,publicSharing:false,marketing:false,externalLinks:false},expect.any(Function));expect(navigation).not.toHaveBeenCalled();
 frame.surface.dispatchEvent(new Event('pagehide'));expect(disconnectBrand).toHaveBeenCalledOnce();expect(disconnectPolicy).toHaveBeenCalledOnce();
});

it('reports DOM policy failure without losing the already installed request bridge',async()=>{
 const frame=environment(true);featureUi.mockImplementation(()=>{throw new Error('explicit policy failure');});await expect(import('../../apps/web/src/runtime/frame-runtime.js')).rejects.toThrow('explicit policy failure');expect(frame.runtime.notice).toHaveBeenCalledWith('explicit policy failure');await frame.surface.fetch('/canvas/hf/projects');expect(frame.host.fetch).toHaveBeenCalledOnce();expect(frame.surface.XMLHttpRequest).toBe(frame.host.XMLHttpRequest);
});

it('fails explicitly when an embedded document has no real host runtime',async()=>{
 const frame=environment();delete frame.host.__RHTV_PREVIEW__;await expect(import('../../apps/web/src/runtime/frame-runtime.js')).rejects.toThrow('未找到 STUDIO 主页面运行环境');expect(featureUi).not.toHaveBeenCalled();expect(frame.surface.fetch).toBe(frame.nativeFetch);
});
