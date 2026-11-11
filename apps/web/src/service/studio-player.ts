import {randomUuid} from '../browser-compat';

/** Runs only in the trusted own wrapper, never in authored workspace HTML. */
export function installStudioPlayerBridge(context:any,frame:any,key:string,sourceFile:string){
 const target=frame.getAttribute('src');let active=true,validate:(()=>boolean)|undefined,ready:any=null,timeline:any=null,state:any=null,raf:number|null=null,loads=0;
 const pending=new Map<string,any>(),requests=new Map<string,{resolve:Function;reject:Function;timer:any}>();let requestSequence=0;
 const live=()=>{try{return active&&frame.getAttribute('src')===target&&!!validate?.();}catch{return false;}};
 const send=(action:string,data:any={})=>{if(live())frame.contentWindow?.postMessage({source:'hf-parent',type:'control',action,...data},'*');};
 const stop=()=>{if(raf!==null)context.cancelAnimationFrame(raf);raf=null;};
 const tick=()=>{raf=null;if(!live()||!ready)return;send('tick');raf=context.requestAnimationFrame(tick);};
 const play=()=>{if(!live()||!ready)return;send('play');stop();raf=context.requestAnimationFrame(tick);};
 const pause=()=>{stop();send('pause');};
 const seek=(seconds:number,options?:{keepPlaying?:boolean})=>{if(!live()||!ready||!Number.isFinite(seconds))return;stop();send('pause');send('seek',{frame:Math.round(Math.max(0,Math.min(ready.durationInFrames/30,seconds))*30)});if(options?.keepPlaying)play();};
 const positive=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&value>0;
 const accept=(data:any)=>{
  if(!live())return;
  if(data.type==='timeline'){
   if(!positive(data.durationInFrames)||data.durationInFrames>3600||!Array.isArray(data.clips)||data.clips.length>1000||data.clips.some((clip:any)=>!clip||typeof clip!=='object'||typeof clip.start!=='number'||!Number.isFinite(clip.start)||clip.start<0||typeof clip.duration!=='number'||!Number.isFinite(clip.duration)||clip.duration<0||typeof clip.track!=='number'||!Number.isFinite(clip.track)))return;
   timeline=data;context.__clipManifest=data.clips;if(ready&&ready.durationInFrames!==data.durationInFrames){ready=null;stop();}
  }else if(data.type==='ready'){
   if(!positive(data.durationInFrames)||data.durationInFrames>3600||!positive(data.width)||!positive(data.height)||data.sourceFile!==sourceFile||data.editProtocolVersion!=='1'||!timeline||timeline.durationInFrames!==data.durationInFrames)return;
   ready=data;
  }else if(data.type==='state'){
   if(typeof data.frame!=='number'||!Number.isFinite(data.frame)||data.frame<0||typeof data.isPlaying!=='boolean')return;
   state=data;if(!data.isPlaying)stop();else if(ready&&raf===null)raf=context.requestAnimationFrame(tick);
  }else if(data.type==='stage-size'){
   if(!positive(data.width)||!positive(data.height))return;
  }else if(data.type==='error'){
   if(typeof data.code!=='string'||typeof data.message!=='string')return;ready=null;stop();
  }else if(data.type==='selection'){
   if(!data.selection||data.selection.sourceFile!==sourceFile||typeof data.selection.selector!=='string')return;
  }else if(data.type==='edit-result'){
   if(typeof data.requestId!=='string'||data.requestId.length>128||(!data.data&&!data.error)||data.error&&(typeof data.error.code!=='string'||typeof data.error.message!=='string'))return;
   if(data.data?.elements&&(!Array.isArray(data.data.elements)||data.data.elements.length>1000||data.data.elements.some((element:any)=>element?.sourceFile!==sourceFile)))return;
   if(data.data?.selection&&data.data.selection.sourceFile!==sourceFile)return;
  }else if(data.type==='edit-key'){
   if(typeof data.key!=='string'||typeof data.code!=='string')return;
  }else if(!['media-autoplay-blocked','shader-transition-state'].includes(data.type))return;
  if(data.type==='edit-result'){const request=requests.get(data.requestId);if(request){requests.delete(data.requestId);context.clearTimeout(request.timer);if(data.error)request.reject(new Error(data.error.message));else request.resolve(data.data);}}
  context.parent.postMessage(data,'*');
 };
 const receive=(event:any)=>{
  const data=event.data;if(!active||!data||typeof data!=='object')return;
  if(event.source===frame.contentWindow&&data.source==='hf-preview'){
   if(!validate){if(['timeline','state','stage-size','ready','error'].includes(data.type))pending.set(data.type,data);return;}
   accept(data);return;
  }
  if(event.source===context.parent&&data.source==='hf-parent'&&live()){
   if(data.type==='control'&&typeof data.action==='string'){
    if(data.action==='play'){play();return;}if(data.action==='pause'){pause();return;}if(data.action==='seek'){if(Number.isFinite(data.frame))seek(data.frame/30);return;}
    if(!['tick','probe','set-muted','set-volume','set-playback-rate','set-media-output-muted','enable-editing'].includes(data.action))return;
    frame.contentWindow?.postMessage(data,'*');
   }else if(data.type==='edit'&&typeof data.requestId==='string'&&data.requestId.length<=128&&['inspect','select','apply','enable'].includes(data.action))frame.contentWindow?.postMessage(data,'*');
  }
 };
 const reset=()=>{ready=null;timeline=null;state=null;context.__clipManifest=[];pending.clear();stop();for(const request of requests.values()){context.clearTimeout(request.timer);request.reject(new Error('Studio preview changed.'));}requests.clear();};
 const loaded=()=>{reset();if(++loads>1){active=false;return;}send('probe');};
 const dispose=()=>{active=false;reset();context.removeEventListener('message',receive);frame.removeEventListener('load',loaded);context.removeEventListener('pagehide',dispose);};
 context.__studioStudioPreviewKey=key;
 context.__studioStudioPreviewBind=(validator:()=>boolean)=>{if(typeof validator!=='function'||!active)return;validate=validator;if(!live())return;for(const type of ['timeline','stage-size','state','ready','error']){const data=pending.get(type);if(data)accept(data);}pending.clear();};
 context.__studioStudioPreviewDispose=dispose;
 context.__studioStudioPreviewRequest=(action:string,data:any={})=>new Promise((resolve,reject)=>{if(!live()||!ready||!['inspect','select','apply','enable'].includes(action)){reject(new Error('Studio preview is not ready.'));return;}const requestId=key+':'+(++requestSequence),timer=context.setTimeout(()=>{requests.delete(requestId);reject(new Error('Studio edit reply timed out.'));},5000);requests.set(requestId,{resolve,reject,timer});frame.contentWindow?.postMessage({source:'hf-parent',type:'edit',requestId,action,...data},'*');});
 context.__player={play,pause,seek,getTime:()=>live()&&ready&&state?state.frame/30:0,getDuration:()=>live()&&ready?ready.durationInFrames/30:0,isPlaying:()=>!!(live()&&ready&&state?.isPlaying)};
 context.__clipManifest=[];context.addEventListener('message',receive);frame.addEventListener('load',loaded);context.addEventListener('pagehide',dispose);
 context.parent.postMessage({source:'studio-studio-preview',type:'bind',key},'*');
}

const attr=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const literal=(value:string)=>JSON.stringify(value).replace(/</g,'\\u003c');
export function studioPlayerDocument(target:string,key:string,sourceFile:string){
 return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe data-studio-studio-child sandbox="allow-scripts" referrerpolicy="no-referrer" src="'+attr(target)+'"></iframe><script>('+installStudioPlayerBridge.toString()+')(window,document.querySelector("[data-studio-studio-child]"),'+literal(key)+','+literal(sourceFile)+');<\/script></body></html>';
}

/** The outer document is own code; only its inner frame contains author HTML. */
export function mountStudioPlayer(host:HTMLElement,target:string,isCurrent:()=>boolean,editor?:StudioEditorOptions):()=>void{
 const element=host as HTMLElement&{iframeElement?:HTMLIFrameElement},frame=element.iframeElement||host.shadowRoot?.querySelector('iframe'),surface=host.ownerDocument?.defaultView;
 if(!frame||!surface)throw new Error('原生HyperFrames播放器尚未初始化。');
 const parsed=new URL(target),match=parsed.pathname.match(/^\/api\/v2\/studio\/preview\/[^/]+\/[^/]+\/(.+)$/);if(!match)throw new Error('预览地址不是已验证的PF工作区地址。');
 const sourceFile=match[1].split('/').map(decodeURIComponent).join('/'),key=randomUuid(),doc=studioPlayerDocument(target,key,sourceFile);let active=true,disposeEditor:(()=>void)|undefined;
 const current=()=>active&&host.isConnected!==false&&isCurrent()&&host.getAttribute('src')===target&&host.getAttribute('srcdoc')===doc;
 const bind=()=>{try{const context=frame.contentWindow as any;if(current()&&context?.__studioStudioPreviewKey===key&&typeof context.__studioStudioPreviewBind==='function')context.__studioStudioPreviewBind(()=>current()&&(frame.contentWindow as any)?.__studioStudioPreviewKey===key);}catch{}};
 const request=(action:string,data?:any)=>{if(!current())return Promise.reject(new Error('Studio preview changed.'));const context=frame.contentWindow as any;if(context?.__studioStudioPreviewKey!==key||typeof context.__studioStudioPreviewRequest!=='function')return Promise.reject(new Error('Studio preview is not ready.'));return context.__studioStudioPreviewRequest(action,data);};
 const message=(event:MessageEvent)=>{if(event.source!==frame.contentWindow)return;if(event.data?.source==='studio-studio-preview'&&event.data.type==='bind'&&event.data.key===key)bind();if(editor&&!disposeEditor&&current()&&event.data?.source==='hf-preview'&&event.data.type==='ready'&&event.data.sourceFile===sourceFile&&event.data.editProtocolVersion==='1'&&Number.isFinite(event.data.width)&&event.data.width>0&&Number.isFinite(event.data.height)&&event.data.height>0){try{disposeEditor=installStudioNativeEditor(host,frame as HTMLIFrameElement,current,request,event.data,editor);}catch(error){const ports=studioNativePorts(host);ports?.composition?.showToast?.(error instanceof Error?error.message:'Studio编辑不可用。','error');}}};
 surface.addEventListener('message',message);frame.addEventListener('load',bind);host.setAttribute('srcdoc',doc);
 return()=>{active=false;disposeEditor?.();surface.removeEventListener('message',message);frame.removeEventListener('load',bind);try{const context=frame.contentWindow as any;if(context?.__studioStudioPreviewKey===key)context.__studioStudioPreviewDispose?.();}catch{}if(host.getAttribute('srcdoc')===doc)host.removeAttribute('srcdoc');};
}

export type StudioEditOperation={type:'style'|'attribute';property:string;value:string|null}|{type:'text';value:string}|{type:'remove'};
export type StudioEditDescriptor={sourceFile:string;selector:string;selectorIndex?:number;domId?:string;tagName:string;label?:string;text?:string;attributes:Record<string,string>;styles:Record<string,string>;box:{x:number;y:number;width:number;height:number};childCount?:number};
export const studioEditTarget=(element:StudioEditDescriptor)=>element.domId?{id:element.domId}:{selector:element.selector,selectorIndex:element.selectorIndex??0};
export function validStudioEditDescriptor(value:any,file:string):value is StudioEditDescriptor{
 const strings=(map:any)=>map&&typeof map==='object'&&!Array.isArray(map)&&Object.keys(map).length<=100&&Object.entries(map).every(([key,text])=>key.length<=200&&typeof text==='string'&&text.length<=65536);
 return !!value&&value.sourceFile===file&&typeof value.selector==='string'&&value.selector.length>0&&value.selector.length<=1000&&(value.domId===undefined||typeof value.domId==='string'&&value.domId.length>0&&value.domId.length<=200)&&Number.isInteger(value.selectorIndex??0)&&(value.selectorIndex??0)>=0&&(value.selectorIndex??0)<=10000&&/^[a-z][a-z0-9-]{0,30}$/.test(value.tagName)&&!['html','head','body','script','style','link','meta','iframe','object','embed','base'].includes(value.tagName)&&strings(value.attributes)&&strings(value.styles)&&(value.text===undefined||typeof value.text==='string'&&value.text.length<=65536)&&(value.label===undefined||typeof value.label==='string'&&value.label.length<=1000)&&(value.childCount===undefined||Number.isInteger(value.childCount)&&value.childCount>=0&&value.childCount<=100000)&&value.box&&['x','y','width','height'].every(key=>typeof value.box[key]==='number'&&Number.isFinite(value.box[key]))&&value.box.width>=0&&value.box.height>=0;
}

/** A detached inspector value, populated only from an admitted actual child reply.
 * No author markup, URL, event attribute or script is mounted in the parent. */
export function studioNativeSelection(document:Document,descriptor:StudioEditDescriptor){
 const element=document.createElement(descriptor.tagName);for(const [key,value] of Object.entries(descriptor.attributes)){if(key==='style')continue;if(/^(id|class|title|role|data-[a-z0-9_-]+)$/i.test(key))element.setAttribute(key,value);}
 // Detached style declarations support the frozen inspector's geometry helpers.
 element.style.cssText=descriptor.attributes.style||'';element.textContent=descriptor.text||'';
 element.getBoundingClientRect=()=>({x:descriptor.box.x,y:descriptor.box.y,left:descriptor.box.x,top:descriptor.box.y,right:descriptor.box.x+descriptor.box.width,bottom:descriptor.box.y+descriptor.box.height,width:descriptor.box.width,height:descriptor.box.height,toJSON:()=>descriptor.box});
 const inlineStyles:Record<string,string>={};for(let i=0;i<element.style.length;i++){const key=element.style.item(i);inlineStyles[key]=element.style.getPropertyValue(key);}
 const dataAttributes=Object.fromEntries(Object.entries(descriptor.attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5),value]));
 const locked='data-timeline-locked'in descriptor.attributes,host=!!(descriptor.attributes['data-composition-src']||descriptor.attributes['data-composition-file']);
 const textField={key:descriptor.sourceFile+':'+descriptor.selector+':self',label:'Content',value:descriptor.text||'',tagName:descriptor.tagName,attributes:Object.entries(descriptor.attributes).filter(([name])=>name!=='style').map(([name,value])=>({name,value})),inlineStyles,computedStyles:descriptor.styles,source:'self'};
 return{element,id:descriptor.domId,selector:descriptor.selector,selectorIndex:descriptor.selectorIndex??0,sourceFile:descriptor.sourceFile,compositionPath:descriptor.sourceFile,label:descriptor.label||descriptor.domId||descriptor.tagName,tagName:descriptor.tagName,boundingBox:descriptor.box,textContent:descriptor.text||null,dataAttributes,inlineStyles,computedStyles:descriptor.styles,textFields:!host&&!locked&&descriptor.childCount===0&&!['img','video','audio','canvas','svg','input'].includes(descriptor.tagName)?[textField]:[],isCompositionHost:host,isInsideLockedComposition:locked,capabilities:{canSelect:!locked,canEditStyles:!locked&&!host,canMove:!locked&&!host,canResize:!locked&&!host,canApplyManualOffset:!locked&&!host,canApplyManualSize:!locked&&!host,canApplyManualRotation:!locked&&!host,...(locked?{reasonIfDisabled:'This element belongs to a locked composition.'}:{})},__studioDescriptor:descriptor};
}

type NativePorts={edit:any;context:any;history?:any;composition?:any};
/** The immutable React editor exposes these exact provider values. */
export function studioNativePorts(host:HTMLElement):NativePorts|undefined{
 if(host.isConnected===false)return undefined;
 const document=host.ownerDocument;let element:Element|null=host,fiber:any;
 // The custom player can be created by native code beneath a React wrapper.
 // Follow only its own composed DOM ancestry, then use the nearest fiber.
 for(let depth=0;element&&depth<32;depth++){
  if(element.ownerDocument!==document)return undefined;
  const key=Object.keys(element).find(name=>name.startsWith('__reactFiber$'));
  if(key){fiber=(element as unknown as Record<string,unknown>)[key];break;}
  if(element.parentElement){element=element.parentElement;continue;}
  const root=element.getRootNode?.();element=root?.nodeType===11?(root as ShadowRoot).host:null;
 }
 let edit:any,context:any,history:any,composition:any;
 for(let depth=0;fiber&&depth<80;depth++,fiber=fiber.return){
  for(const node of [fiber,fiber.alternate]){const value=node?.memoizedProps?.value;if(value&&typeof value.applyDomSelection==='function'&&value.domEditSelectionRef){edit=value;if(node.type&&'_currentValue'in node.type)context=node.type;}if(value?.previewIframeRef&&typeof value.projectId==='string')composition=value;
   let hook=node?.memoizedState;for(let i=0;hook&&i<150;i++,hook=hook.next){const candidate=hook.memoizedState?.current;if(candidate&&typeof candidate.recordEdit==='function'&&typeof candidate.undo==='function'&&typeof candidate.redo==='function'&&typeof candidate.snapshot==='function')history=candidate;}
  }
 }
 return edit&&context?{edit,context,history,composition}:undefined;
}

/** Intercepts the editor's own context reads; the frozen UI remains its consumer. */
export function adaptStudioNativeContext(context:any,handlers:Record<string,Function>,live:()=>boolean){
 const callbacks=Object.fromEntries(Object.entries(handlers).map(([key,handler])=>[key,(...args:any[])=>{if(!live())throw new Error('Studio preview is no longer current.');return handler(...args);}]));
 const restores:(()=>void)[]=[];for(const slot of ['_currentValue','_currentValue2']){const original=Object.getOwnPropertyDescriptor(context,slot);if(!original||!original.configurable||!('value'in original))continue;let value=original.value;const cache=new WeakMap<object,any>();
  const adapt=(next:any)=>{if(!next||typeof next!=='object'||typeof next.applyDomSelection!=='function'||!next.domEditSelectionRef)return next;let proxy=cache.get(next);if(!proxy){proxy=new Proxy(next,{get:(target,key,receiver)=>typeof key==='string'&&callbacks[key]?callbacks[key]:Reflect.get(target,key,receiver)});cache.set(next,proxy);}return proxy;};
  Object.defineProperty(context,slot,{configurable:true,enumerable:original.enumerable,get:()=>adapt(value),set:next=>{value=next;}});restores.push(()=>Object.defineProperty(context,slot,{...original,value}));
 }
 return()=>{for(const restore of restores)restore();};
}

type StudioEditorOptions={persist:(selection:StudioEditDescriptor,operations:StudioEditOperation[],label:string)=>Promise<{before:string;after:string}>;refresh:(target:ReturnType<typeof studioEditTarget>)=>Promise<void>;reselect?:ReturnType<typeof studioEditTarget>};
const nativeStudioEditors=new WeakMap<object,()=>void>();
export function installStudioNativeEditor(host:HTMLElement,frame:HTMLIFrameElement,current:()=>boolean,request:(action:string,data?:any)=>Promise<any>,metadata:{width:number;height:number;sourceFile:string},options:StudioEditorOptions){
 const document=host.ownerDocument,surface=document.defaultView!,ports=studioNativePorts(host);if(!ports)throw new Error('原生Studio编辑上下文尚未初始化。');
 nativeStudioEditors.get(ports.context)?.();
 let active=true,descriptor:StudioEditDescriptor|undefined,restoreContext:(()=>void)|undefined,sequence=0,queue=Promise.resolve();const live=()=>active&&current();
 const report=(error:unknown)=>{ports.composition?.showToast?.(error instanceof Error?error.message:'Studio编辑失败。','error');};
 const select=(value:any)=>{if(!live()||!validStudioEditDescriptor(value,metadata.sourceFile))throw new Error('Studio未返回真实有效的选取元素。');descriptor=value;ports.edit.applyDomSelection(studioNativeSelection(document,value),{revealPanel:true});};
 const commit=(operations:StudioEditOperation[],label:string,selected?:any)=>{
  const picked=selected?.__studioDescriptor||descriptor;if(!live()||!picked||!validStudioEditDescriptor(picked,metadata.sourceFile))return Promise.reject(new Error('请先选取当前预览中的真实元素。'));
  const history=studioNativePorts(host)?.history||ports.history;
  const work=queue.then(async()=>{if(!live())throw new Error('Studio预览已变更，请重新选取。');const saved=await options.persist(picked,operations,label);if(history)await history.recordEdit({label,kind:'manual',files:{[picked.sourceFile]:{before:saved.before,after:saved.after}}});if(live()){try{const result=await request('apply',{target:studioEditTarget(picked),operations});if(result.selection)select(result.selection);}catch{/* Saved file remains authoritative; refresh verifies the new actual DOM. */}}});
  const batch=work.catch(report);queue=batch;void batch.then(()=>{if(queue===batch&&live())return options.refresh(studioEditTarget(picked));}).catch(report);return work;
 };
 const styles=(entries:Record<string,string|null>):StudioEditOperation[]=>Object.entries(entries).map(([property,value])=>({type:'style',property,value}));
 const styleValue=(property:string,value:string)=>{const text=value.trim();return ['border-radius','border-width','font-size','letter-spacing'].includes(property)&&/^-?\d+(\.\d+)?$/.test(text)?text+'px':text;};
 const styleCommit=(property:string,value:string,label:string)=>{const operations:StudioEditOperation[]=[{type:'style',property,value:styleValue(property,value)}];if(property==='background-image'&&/^url\(/i.test(value.trim()))operations.push(...styles({'background-position':'center','background-repeat':'no-repeat','background-size':'contain'}));return commit(operations,label);};
 const number=(value:any)=>{if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>100000)throw new Error('Studio位置或尺寸无效。');return Math.round(value);};
 const original=(selected:any,property:string)=>selected?.__studioDescriptor?.attributes?.[property]??descriptor?.attributes?.[property];
 const geometry=(selected:any,next:any,kind:string)=>{
  const d:StudioEditDescriptor=selected?.__studioDescriptor||descriptor!;if(!d)throw new Error('请先选取元素。');let ops:StudioEditOperation[];
  if(kind==='offset'){const x=number(next.x),y=number(next.y),base=original(selected,'data-hf-studio-original-translate')??((d.styles.translate==='none'?'':d.styles.translate)||''),inline=selected?.inlineStyles?.translate||'';const parts=base.trim().split(/\s+/);const translate=base?`calc(${parts[0]} + var(--hf-studio-offset-x, 0px)) calc(${parts[1]||'0px'} + var(--hf-studio-offset-y, 0px))`:'var(--hf-studio-offset-x, 0px) var(--hf-studio-offset-y, 0px)';ops=[...styles({'--hf-studio-offset-x':x+'px','--hf-studio-offset-y':y+'px',translate}),{type:'attribute',property:'data-hf-studio-path-offset',value:'true'},{type:'attribute',property:'data-hf-studio-original-translate',value:base},{type:'attribute',property:'data-hf-studio-original-inline-translate',value:original(selected,'data-hf-studio-original-inline-translate')??inline}];
  }else if(kind==='size'){const width=number(next.width),height=number(next.height);if(width<=0||height<=0)throw new Error('Studio尺寸必须大于零。');ops=[...styles({'--hf-studio-width':width+'px','--hf-studio-height':height+'px',width:width+'px',height:height+'px','box-sizing':'border-box','min-width':'0px','min-height':'0px','max-width':'none','max-height':'none'}),{type:'attribute',property:'data-hf-studio-box-size',value:'true'}];for(const property of ['width','height','min-width','min-height','max-width','max-height','box-sizing'])ops.push({type:'attribute',property:'data-hf-studio-original-'+property,value:original(selected,'data-hf-studio-original-'+property)??selected?.inlineStyles?.[property]??''});
  }else{const angle=number(next.angle),base=original(selected,'data-hf-studio-original-rotate')??((d.styles.rotate==='none'?'':d.styles.rotate)||'');ops=[...styles({'--hf-studio-rotation':angle+'deg',rotate:base?`calc(${base} + var(--hf-studio-rotation, 0deg))`:'var(--hf-studio-rotation, 0deg)','transform-origin':'center center'}),{type:'attribute',property:'data-hf-studio-rotation',value:'true'},{type:'attribute',property:'data-hf-studio-original-rotate',value:base}];}
  if(d.styles.display==='inline')ops.push({type:'style',property:'display',value:'inline-block'});return commit(ops,'Edit layer '+kind,selected);
 };
 const handlers:Record<string,Function>={
  handleDomStyleCommit:(property:string,value:string)=>styleCommit(property,value,'Edit layer style'),
  handleDomAttributeCommit:(property:string,value:string)=>commit([{type:'attribute',property:property.startsWith('data-')?property:'data-'+property,value}],'Edit layer attribute'),
  handleDomHtmlAttributeCommit:(property:string,value:string|null)=>commit([{type:'attribute',property,value:value===null||value===''||value==='false'?null:value}],'Edit layer attribute'),
  handleDomTextCommit:(value:string)=>commit([{type:'text',value}],'Edit text'),
  handleDomTextFieldStyleCommit:(_key:string,property:string,value:string)=>styleCommit(property,value,'Edit text style'),
  handleDomPathOffsetCommit:(selected:any,next:any)=>geometry(selected,next,'offset'),
  handleDomBoxSizeCommit:(selected:any,next:any)=>geometry(selected,next,'size'),
  handleDomRotationCommit:(selected:any,next:any)=>geometry(selected,next,'rotation'),
  handleDomGroupPathOffsetCommit:(values:any[])=>Promise.all(values.map(value=>geometry(value.selection,value.next,'offset'))),
  handleDomEditElementDelete:(selected:any)=>commit([{type:'remove'}],'Delete element',selected),
  handleDomManualEditsReset:(selected:any)=>{const d:StudioEditDescriptor=selected?.__studioDescriptor||descriptor!;const ops:StudioEditOperation[]=[];for(const property of ['translate','width','height','min-width','min-height','max-width','max-height','box-sizing','rotate','transform-origin']){const original=d.attributes['data-hf-studio-original-'+property];if(original!==undefined)ops.push({type:'style',property,value:original||null});}for(const property of ['--hf-studio-offset-x','--hf-studio-offset-y','--hf-studio-width','--hf-studio-height','--hf-studio-rotation'])ops.push({type:'style',property,value:null});for(const property of Object.keys(d.attributes))if(/^data-hf-studio-(?:path-offset|box-size|rotation|original-)/.test(property))ops.push({type:'attribute',property,value:null});return commit(ops,'Reset layer edits',selected);},
  handleTimelineElementSelect:async(clip:any)=>{const target=clip?.domId?{id:clip.domId}:clip?.selector?{selector:clip.selector,selectorIndex:clip.selectorIndex??0}:null;if(!target)throw new Error('Timeline元素没有真实选取目标。');const result=await request('select',{target});select(result.selection);},
 };
 restoreContext=adaptStudioNativeContext(ports.context,handlers,live);
 const message=(event:MessageEvent)=>{if(!live()||event.source!==frame.contentWindow||event.data?.source!=='hf-preview')return;try{if(event.data.type==='selection')select(event.data.selection);if(event.data.type==='edit-key'){const key=event.data;surface.dispatchEvent(new KeyboardEvent('keydown',{key:key.key,code:key.code,ctrlKey:!!key.ctrlKey,metaKey:!!key.metaKey,shiftKey:!!key.shiftKey,bubbles:true,cancelable:true}));}}catch(error){report(error);}};
 const pick=async(event:PointerEvent)=>{if(!live()||event.button!==0)return;const target=event.target as HTMLElement,canvas=target?.closest?.('[aria-label="Composition canvas"]');if(!canvas||target!==canvas)return;const rect=frame.getBoundingClientRect();if(!rect.width||!rect.height||event.clientX<rect.left||event.clientY<rect.top||event.clientX>rect.right||event.clientY>rect.bottom)return;event.preventDefault();event.stopImmediatePropagation();(canvas as HTMLElement).focus();const ticket=++sequence;try{const data=await request('inspect'),x=(event.clientX-rect.left)*metadata.width/rect.width,y=(event.clientY-rect.top)*metadata.height/rect.height;const choices=data.elements.filter((d:any)=>validStudioEditDescriptor(d,metadata.sourceFile)&&d.box.width>0&&d.box.height>0&&x>=d.box.x&&x<=d.box.x+d.box.width&&y>=d.box.y&&y<=d.box.y+d.box.height);choices.sort((a:any,b:any)=>a.box.width*a.box.height-b.box.width*b.box.height);if(!live()||ticket!==sequence)return;if(!choices.length){descriptor=undefined;ports.edit.clearDomSelection();return;}const result=await request('select',{target:studioEditTarget(choices[0])});if(ticket===sequence)select(result.selection);}catch(error){report(error);}};
 surface.addEventListener('message',message);document.addEventListener('pointerdown',pick,true);
 void request('enable',{enabled:true}).then(async()=>{if(options.reselect){const value=await request('select',{target:options.reselect});select(value.selection);}}).catch(report);
 const dispose=()=>{if(!active)return;active=false;sequence++;restoreContext?.();surface.removeEventListener('message',message);document.removeEventListener('pointerdown',pick,true);if(nativeStudioEditors.get(ports.context)===dispose)nativeStudioEditors.delete(ports.context);};nativeStudioEditors.set(ports.context,dispose);return dispose;
}
