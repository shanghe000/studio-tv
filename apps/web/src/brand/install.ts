import themeStyles from './theme.css?inline';
import {BRAND_NAME,FRAMES_NAME,brandTitle,brandPageTitle,brandStaticDescription,framesTitle,emptyFramesGreeting,translateBrandColor} from './palette';
import {decorateFramesMark,framesFavicon} from './frames-mark';
import {agentMarkSelector,decorateAgentMark} from './agent-mark';
import {toolbarMarkSelector,decorateToolbarMark} from './toolbar-mark';

export function installStudioBrand(options:{frames?:boolean;displayName?:()=>string|undefined}={}){
 document.documentElement.setAttribute('data-studio-brand','');
 // Embedded native documents only load frame-runtime.js. Inline our stylesheet
 // so their brand does not depend on a separate, unreferenced Vite CSS output.
 if(!document.getElementById('studio-theme')){
  const style=document.createElement('style');style.id='studio-theme';style.textContent=themeStyles;document.head.append(style);
 }
 const overrides=document.createElement('style');
 overrides.id='studio-native-accent';document.head.append(overrides);
 let queued=false;
 const translateRules=(rules:CSSRuleList):string=>{
  let result='';
  for(const rule of Array.from(rules)){
   if(rule instanceof CSSStyleRule){
    const declarations:string[]=[];
    for(const property of Array.from(rule.style)){
     const old=rule.style.getPropertyValue(property),value=translateBrandColor(old);
     if(value!==old)declarations.push(`${property}:${value}!important`);
    }
    if(declarations.length)result+=`${rule.selectorText}{${declarations.join(';')}}`;
   }else if('cssRules'in rule){
    const nested=translateRules((rule as CSSGroupingRule).cssRules);
    if(nested)result+=rule.cssText.slice(0,rule.cssText.indexOf('{')+1)+nested+'}';
   }
  }
  return result;
 };
 const refreshStyles=()=>{
  queued=false;let css='';
  for(const sheet of Array.from(document.styleSheets)){
   if(sheet.ownerNode===overrides)continue;
   try{css+=translateRules(sheet.cssRules);}catch{/* Cross-origin style sheets are not read. */}
  }
  if(overrides.textContent!==css)overrides.textContent=css;
 };
 const scheduleStyles=()=>{if(!queued){queued=true;queueMicrotask(refreshStyles);}};
 const updateHead=()=>{
  const title=brandPageTitle(document.title);if(title!==document.title)document.title=title;
  for(const meta of document.querySelectorAll<HTMLMetaElement>('meta[property="og:title"],meta[name="twitter:title"]')){
   const value=brandPageTitle(meta.content);if(value!==meta.content)meta.content=value;
  }
  for(const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="description"],meta[property="og:description"]')){
   const value=brandStaticDescription(meta.content);if(value!==meta.content)meta.content=value;
  }
  const favicon=options.frames?framesFavicon:'/brand/tv-glyph.svg';
  let icons=[...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]')];
  if(!icons.length){const icon=document.createElement('link');icon.rel='icon';document.head.append(icon);icons=[icon];}
  for(const icon of icons){
   if(icon.getAttribute('href')!==favicon)icon.setAttribute('href',favicon);
   if(icon.type!=='image/svg+xml')icon.type='image/svg+xml';
  }
 };
 const decorate=(root:Element)=>{
  const staticSelector=':is(.plugin-center,.dcc-plugin-page) .dcc-hero__eyebrow,:is(.plugin-center,.dcc-plugin-page) .dcc-hero__copy h1 > span,:is(.plugin-center,.dcc-plugin-page) .dcc-hero__visual-label.is-result > small,.dcc-plugin-page p,.dcc-plugin-landing p,.dcc-plugin-landing h1,.dcc-plugin-landing h2,.dcc-plugin-landing h3,.dcc-plugin-landing a,.watermark-setting-paragraph,.home-input-placeholder-text,.scene-notice-modal__minimax-h3-brand-name';
  for(const label of [...(root.matches(staticSelector)?[root]:[]),...root.querySelectorAll(staticSelector)]){
   if(label.closest('[contenteditable="true"],.rh-text-editor,.rh-text-display,.hf-chat__msg,.hf-preview'))continue;
   const walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);
   let text:Node|null;while((text=walker.nextNode())){
    const old=text.textContent||'',next=brandTitle(old);if(next!==old)text.textContent=next;
   }
  }
  const defaults=new Map<string,string>([['RHTV Canvas Agent','Studio TV Canvas Agent'],['RH Agent','Studio Agent'],['RH 智能体','Studio 智能体'],['RHTV 生成','Studio TV 生成'],['RHTV Generated','Studio TV Generated'],['RHTV 생성','Studio TV 생성'],['RHTV Creative Engine','Studio TV Creative Engine'],['RHTV Creative Suite','Studio TV Creative Suite'],['RHTV Creator Academy','Studio TV Creator Academy']]);
  const defaultSelector='.ap-header-title,.rh-media-preview__pill--gen,.project-home-section__header h2,.project-home-model-feature h2,.project-home-suite h2,.academy-eyebrow';
  for(const label of [...(root.matches(defaultSelector)?[root]:[]),...root.querySelectorAll(defaultSelector)]){
   const next=defaults.get(label.textContent?.trim()||'');
   if(next){const text=Array.from(label.childNodes).find(n=>n.nodeType===Node.TEXT_NODE);if(text)text.textContent=next;}
  }
  for(const logo of [...(root.matches('.plugin-center-brand-mark')?[root]:[]),...root.querySelectorAll('.plugin-center-brand-mark')]){
   if(logo.getAttribute('aria-label')!==BRAND_NAME)logo.setAttribute('aria-label',BRAND_NAME);
  }
  const mediaSelector=':is(.dcc-plugin-landing,.dcc-plugin-page) img[alt],:is(.dcc-plugin-landing,.dcc-plugin-page) video[aria-label]';
  for(const media of [...(root.matches(mediaSelector)?[root]:[]),...root.querySelectorAll(mediaSelector)]){
   for(const attr of ['alt','aria-label']){const old=media.getAttribute(attr);if(old){const next=brandTitle(old);if(next!==old)media.setAttribute(attr,next);}}
  }
  const imageSelector='.canvas-logo img,header .logo > img[alt="RunningHub"]';
  const images=[...(root.matches(imageSelector)?[root]:[]),...root.querySelectorAll(imageSelector)];
  for(const element of images){
   if(element.closest('.react-flow__node,.hf-chat__msg,.hf-preview,.asset-card__media'))continue;
   const img=element as HTMLImageElement;
   if(img.getAttribute('src')!=='/brand/studio-wordmark.svg')img.src='/brand/studio-wordmark.svg';
   if(img.alt!==BRAND_NAME)img.alt=BRAND_NAME;
   const link=img.closest('a');if(link&&link.getAttribute('aria-label')!==BRAND_NAME)link.setAttribute('aria-label',BRAND_NAME);
  }
  const frameMarkSelector='.hyperframes-icon,.hyperframes-topbar-logo,.hf-header__logo-svg';
  for(const logo of [...(root.matches(frameMarkSelector)?[root]:[]),...root.querySelectorAll(frameMarkSelector)]){
   decorateFramesMark(logo,logo.matches('.hyperframes-icon'));
   const control=logo.closest('.hyperframes-btn,.hf-header__logo');
   if(control)for(const attr of ['aria-label','title'])if(control.getAttribute(attr)!==FRAMES_NAME)control.setAttribute(attr,FRAMES_NAME);
  }
  for(const orb of [...(root.matches(agentMarkSelector)?[root]:[]),...root.querySelectorAll(agentMarkSelector)])decorateAgentMark(orb);
  for(const mark of [...(root.matches(toolbarMarkSelector)?[root]:[]),...root.querySelectorAll(toolbarMarkSelector)])decorateToolbarMark(mark);
  const framesStatic='.hf-chat__header-title,.hf-chat__input-ph-text,.hyperframes-modal__loading > span,.hyperframes-modal .canvas-nuxt-iframe-host__error-title';
  for(const label of [...(root.matches(framesStatic)?[root]:[]),...root.querySelectorAll(framesStatic)]){
   for(const text of Array.from(label.childNodes))if(text.nodeType===Node.TEXT_NODE){const old=text.textContent||'',next=framesTitle(old);if(next!==old)text.textContent=next;}
  }
  const framesInputs='.hf-chat__input[placeholder],.hyperframes-modal__frame[title]';
  for(const input of [...(root.matches(framesInputs)?[root]:[]),...root.querySelectorAll(framesInputs)])for(const attr of ['placeholder','title']){
   const old=input.getAttribute(attr);if(old){const next=framesTitle(old);if(next!==old)input.setAttribute(attr,next);}
  }
  for(const greeting of [...(root.matches('.hf-chat__empty-hi')?[root]:[]),...root.querySelectorAll('.hf-chat__empty-hi')]){
   const old=greeting.textContent||'',next=emptyFramesGreeting(old,options.displayName?.());if(next!==old)greeting.textContent=next;
  }
  // Brand-coloured UI SVGs are translated; uploaded SVGs and editor content
  // are excluded so user artwork keeps its original colours.
  const selector='svg [fill],svg [stroke],svg stop[stop-color]';
  const parts=[...(root.matches(selector)?[root]:[]),...root.querySelectorAll(selector)];
  for(const part of parts){
   if(part.closest('.react-flow__node,.rh-text-editor,.rh-text-display,.asset-card__media,.hf-chat__msg,.hf-preview,[data-studio-frame-art],[data-studio-agent-art]'))continue;
   for(const attr of ['fill','stroke','stop-color']){
    const old=part.getAttribute(attr);if(!old)continue;const next=translateBrandColor(old);if(next!==old)part.setAttribute(attr,next);
   }
  }
 };
 const bodyObserver=new MutationObserver(records=>{
  for(const record of records){
   if(record.type==='attributes')decorate(record.target as Element);
   else if(record.type==='characterData'){if(record.target.parentElement)decorate(record.target.parentElement);}
   else{
    const target=record.target instanceof Element?record.target:record.target.parentElement;
    const logo=target?.closest('.hyperframes-icon,.hyperframes-topbar-logo,.hf-header__logo-svg');if(logo)decorate(logo);
    const orb=target?.closest(agentMarkSelector);if(orb)decorate(orb);
    for(const node of record.addedNodes){if(node instanceof Element)decorate(node);else if(node.parentElement)decorate(node.parentElement);}
   }
  }
 });
 bodyObserver.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['src','fill','stroke','stop-color','placeholder','title','aria-label']});
 const headObserver=new MutationObserver(records=>{
  updateHead();
  if(records.some(r=>{
   if(r.target===overrides||overrides.contains(r.target))return false;
   const target=r.target instanceof Element?r.target:r.target.parentElement;
   return target instanceof HTMLStyleElement||[...r.addedNodes,...r.removedNodes].some(n=>n instanceof HTMLStyleElement||n instanceof HTMLLinkElement);
  }))scheduleStyles();
 });
 headObserver.observe(document.head,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['content','href','rel']});
 const loaded=(event:Event)=>{if(event.target instanceof HTMLLinkElement&&event.target.rel==='stylesheet')scheduleStyles();};
 document.addEventListener('load',loaded,true);
 refreshStyles();updateHead();decorate(document.body);
 return {disconnect(){bodyObserver.disconnect();headObserver.disconnect();document.removeEventListener('load',loaded,true);}};
}
