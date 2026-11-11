// Explicit local-edition product decision, independent of model availability.
const selector='a[href],button,[role="button"],[role="menuitem"]';
const marker='data-studio-paused-entry';
const appReason='AI 应用暂未开放。';
const homeReasons:Record<string,string>={video:'首页视频生成尚未接通，请在画布视频节点使用 H3。','motion-transfer':'动作模仿尚未接通。'};
function nativeFiber(element:Element):any{return (element as any)[Object.keys(element).find(key=>key.startsWith('__reactFiber$'))||''];}
const agentReasons:Record<string,string>={'motion-transfer':'动作模仿尚未接通。'};
function agentContext(element:Element){
 const panel=element.closest('.agent-chat-panel');if(!panel)return null;
 let fiber=nativeFiber(panel.querySelector('.ap-send-btn')??element);
 for(let depth=0;fiber&&depth<40;depth++,fiber=fiber.return){const props=fiber.memoizedProps;if(typeof props?.onChatModeChange==='function'&&typeof props.chatMode==='string')return props;}
 return null;
}
export function pausedAgentSubmission(element:Element):string|null{
 const context=agentContext(element);
 // Do not intercept the stop button or Escape while an older run is active.
 if(context?.isLoading)return null;
 return context?.isTrendingHitMode?'爆款复刻尚未接通。':agentReasons[context?.chatMode]??null;
}
function homeContext(element:Element){
 const composer=element.closest('.home-agent-input-bar');if(!composer)return null;
 let fiber=nativeFiber(composer.querySelector('.home-mode-pill')??composer);
 for(let depth=0;fiber&&depth<40;depth++,fiber=fiber.return){const props=fiber.memoizedProps;if(typeof props?.onModeChange==='function'&&typeof props.mode==='string')return props;}
 return null;
}
export function pausedHomeSubmission(element:Element):string|null{
 const context=homeContext(element);return context?.isTrendingHit?'爆款复刻尚未接通。':homeReasons[context?.mode]??null;
}

export function pausedEntryReason(element:Element):string|null{
 // Native mode keys avoid translating or matching arbitrary user-authored labels.
 if(element.matches('.home-mode-dropdown-item')){
  const key=nativeFiber(element)?.key;
  if(key&&homeReasons[key])return homeReasons[key];
 }
 if(element.matches('.ap-mode-dropdown-item')){
  const key=nativeFiber(element)?.key;if(key&&agentReasons[key])return agentReasons[key];
  if(element.closest('.ap-video-submode-menu')&&key==='text-video')return '当前 H3 需要视觉参考，纯文字视频尚未接通。';
 }
 if(element.matches('.ap-one-click-remake-trigger,.ap-trending-hit-btn'))return '一键复刻尚未接通。';
 if(element.matches('.agent-chat-panel button[aria-label="SkillHub"]'))return 'SkillHub 暂未开放，等待接入公司内部 SkillHub。';
 if(element.matches('.agent-chat-panel .ap-send-btn')&&!element.classList.contains('stopping'))return pausedAgentSubmission(element);
 if(element.matches('.home-trending-hit-pill'))return '爆款复刻尚未接通。';
 if(element.matches('.home-agent-input-bar .home-send-btn,.home-agent-input-bar .generate-action-button'))return pausedHomeSubmission(element);
 if(element.matches('[data-panel-key="rh-ai"],.ai-app-params__model-btn,.ai-model-selector__card,.canvas-ai-app-params .run-price-btn,.canvas-ai-app-params .generate-action-button,.react-flow__node-rh-ai .run-price-btn,.react-flow__node-rh-ai .generate-action-button'))return appReason;
 const href=element.getAttribute('href');
 if(element.tagName==='A'&&href){
  try{const url=new URL(href,element.ownerDocument.baseURI);
   if(url.origin===new URL(element.ownerDocument.baseURI).origin){
    if(/^\/projects\/skill\/?$/.test(url.pathname))return '技能暂未开放。';
    if(/^\/projects\/plugin\/?$/.test(url.pathname))return '插件暂未开放。';
   }
  }catch{}
 }
 if(element.matches('.canvas-toolbar-btn[data-toolbar-icon="workflow"]'))return '画布工作流暂未开放。';
 if(element.matches('.ap-skillbook-trigger,.ap-skillbook-row'))return '技能暂未开放。';
 return null;
}
export function installPausedEntries(notice:(text:string)=>void,root:Document=document){
 const style=root.createElement('style');style.textContent=`[${marker}]{opacity:.42!important;filter:grayscale(1)!important;cursor:not-allowed!important}[${marker}]:focus-visible{outline:1px solid #aaa;outline-offset:3px}.react-flow__node-rh-ai .rh-ai-node{filter:grayscale(1);opacity:.55}.react-flow__node-rh-ai::after{content:'AI 应用 · 暂未开放';position:absolute;top:4px;right:8px;padding:3px 6px;border-radius:4px;background:#252525;color:#aaa;font-size:11px;pointer-events:none}`;root.head.append(style);
 const owned=new Map<Element,Map<string,{before:string|null;value:string}>>();let disposed=false,queued=false;
 const restore=(element:Element)=>{for(const [key,state]of owned.get(element)??[])if(element.getAttribute(key)===state.value){if(state.before===null)element.removeAttribute(key);else element.setAttribute(key,state.before);}owned.delete(element);};
 const mark=(element:Element)=>{
  const reason=pausedEntryReason(element);if(!reason){restore(element);return null;}
  let state=owned.get(element);if(!state){state=new Map();owned.set(element,state);}
  for(const [key,value]of Object.entries({[marker]:reason,title:reason,'aria-description':reason,'aria-disabled':'true'})){
   const current=element.getAttribute(key),old=state.get(key);
   if(!old||current!==old.value)state.set(key,{before:current,value});else old.value=value;
   if(current!==value)element.setAttribute(key,value);
  }return reason;
 };
 const refresh=()=>{queued=false;if(disposed)return;for(const element of owned.keys())if(!element.isConnected)restore(element);root.querySelectorAll(selector).forEach(mark);};
 const observer=new MutationObserver(()=>{if(!queued&&!disposed){queued=true;queueMicrotask(refresh);}});
 observer.observe(root.body,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['href','class','data-toolbar-icon','data-panel-key','title','aria-disabled']});
 const guard=(event:Event)=>{
  if(event.type==='keydown'&&!['Enter',' '].includes((event as KeyboardEvent).key))return;
  const target=event.target as Element|null;
  // A stale/restored unsupported mode must not submit via the editable field.
  if(event.type==='keydown'&&(event as KeyboardEvent).key==='Enter'&&!(event as KeyboardEvent).isComposing&&!(event as KeyboardEvent).shiftKey&&target?.closest('.home-agent-input-bar [contenteditable="true"],.home-agent-input-bar textarea,.home-agent-input-bar input')){
   const reason=pausedHomeSubmission(target);if(reason){event.preventDefault();event.stopImmediatePropagation();notice(reason);return;}
  }
  if(event.type==='keydown'&&(event as KeyboardEvent).key==='Enter'&&!(event as KeyboardEvent).isComposing&&!(event as KeyboardEvent).shiftKey&&target?.closest('.agent-chat-panel [contenteditable="true"],.agent-chat-panel textarea')){
   const reason=pausedAgentSubmission(target);if(reason){event.preventDefault();event.stopImmediatePropagation();notice(reason);return;}
  }
  if(event.type==='keydown'&&(event as KeyboardEvent).key==='Enter'&&!(event as KeyboardEvent).isComposing&&!(event as KeyboardEvent).shiftKey&&target?.closest('.canvas-ai-app-params input,.canvas-ai-app-params textarea,.canvas-ai-app-params [contenteditable="true"]')){event.preventDefault();event.stopImmediatePropagation();notice(appReason);return;}
  const element=target?.closest?.(selector);if(!element)return;const reason=mark(element);if(!reason)return;
  event.preventDefault();event.stopImmediatePropagation();if(['click','auxclick','keydown'].includes(event.type))notice(reason);
 };
 const events=['click','auxclick','pointerdown','mousedown','keydown'];events.forEach(name=>root.addEventListener(name,guard,true));refresh();
 return()=>{disposed=true;observer.disconnect();events.forEach(name=>root.removeEventListener(name,guard,true));for(const element of owned.keys())restore(element);style.remove();};
}
